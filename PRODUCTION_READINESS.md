# Production Readiness

> **Статус:** `HARDENING IN PROGRESS`
>
> **Baseline:** `bedcab29abc7557f1af22bfd6851f1695d308afd` — Handle DeepSeek SSE rate limit hints
>
> **Offline baseline:** 28 test files, 574 tests
>
> **Открыто:** P0 — 4, P1 — 4, P2 — 6; deferred P3 — 1
> **Production scope:** Claude Code → Anthropic-compatible Bridge → DeepSeek Web → Bridge → Claude Code

Этот файл — главный источник production-hardening backlog, frozen benchmark и
release gates. `PROJECT_STATE.md` остаётся общим состоянием проекта. Перед
работой над defect разработчик обязан прочитать `AGENTS.md` и этот документ.

## 1. Scope freeze

До прохождения всех production gates разрешён только следующий scope:

- клиент/executor: Claude Code;
- downstream protocol: Anthropic Messages API compatibility;
- backend: внутренний Web API `chat.deepseek.com`;
- correctness, persistence, transport, correlation и observability этой цепочки.

OpenCode deferred. Kimi, GLM, Qwen, ChatGPT, Gemini и другие providers, а также
новые UI-функции не входят в production-hardening. Расширение scope возможно
только после статуса `PRODUCTION READY` либо формального изменения release plan.

## 2. Evidence policy

| Маркер | Значение |
| --- | --- |
| `REPO` | Подтверждено текущим production-кодом baseline. |
| `TEST` | Защищено существующим deterministic offline test. |
| `LIVE` | Проверено на реальном Claude Code/DeepSeek/desktop scenario. |
| `HANDOFF` | Получено из сохранённого diagnostic handoff, но не воспроизводится самим repo. |
| `UNKNOWN` | Текущий repo не даёт достаточного доказательства. Нельзя заявлять как факт. |

Документация и прошлый live-отчёт не заменяют текущий code/test evidence. Любой
неповторённый внешний эксперимент сохраняет маркер `HANDOFF` или `UNKNOWN`.

## 3. Architectural layers

| Layer | Владелец | Граница ответственности |
| --- | --- | --- |
| **L1** | Claude Code protocol / Anthropic compatibility | Нормализация входа, Anthropic JSON/SSE, tool_use/tool_result wire contract, downstream error lifecycle. |
| **L2** | Policy / obligations / evidence / completion guard | Разрешение tool calls, current-cycle evidence, anti-fabrication, obligations, bounded repair. |
| **L3** | Session / lineage / persistence / correlation | Upstream key, chat session, parent, call-id lineage, TTL, concurrent durable state. |
| **L4** | DeepSeek transport / SSE / upstream lifecycle | PoW, HTTP, body timeout/cancel, SSE terminal semantics, upstream errors and rate limit. |

Каждый fix имеет один primary layer. Affected layers указываются отдельно;
transport, policy и persistence defects не объединяются в один implementation commit.

## 4. Architecture invariants

| Invariant | Baseline enforcement | Evidence / gap |
| --- | --- | --- |
| Claude Code — реальный executor tools; Bridge tools самостоятельно не выполняет. | Да | `REPO`: `CompletionHandler` отдаёт Anthropic `tool_use`; execution находится у клиента. |
| DeepSeek только выбирает tool; Bridge переводит запрос, Claude Code выполняет и возвращает `tool_result`. | Да | `REPO`, normal flow tests в `tests/unit/sse.test.ts` и `tests/unit/tools.test.ts`. |
| Fabricated text никогда не считается `tool_result`. | Частично | Механизм `bbd13b2` закрыт, но D9 показывает classifier false-negative. |
| Historical `tool_result` не подтверждает новое действие. | Да в L2; L3 требует hardening | Current-cycle guard защищён tests; stale lineage остаётся D5. |
| Mutation нельзя считать успешной без подходящего evidence. | Частично | Multi-step/fresh-state guards закрыты для поддержанного scope; D13 остаётся. |
| Rejected generation не изменяет accepted session/parent state. | **Нет** | D2: `runCompletion()` мутирует `state.parentMessageId` до решения guard. |
| Transport error не превращается в fake successful completion. | **Нет, не полностью** | Rate-limit исправлен; empty/INCOMPLETE/non-terminal stream остаются D3. |
| HTTP 200 сам по себе не означает successful DeepSeek completion. | **Нет, не полностью** | Exact rate-limit распознан; D3 требует terminal/empty semantics. |
| Explicit DeepSeek rate limit не вызывает completion-guard retry storm. | Да | `bedcab2`, `tests/unit/deepseekRateLimit.test.ts`: один completion attempt, 429. |
| После `message_start` downstream всегда получает корректный terminal/error contract. | **Нет** | D4: `routeError()` при `headersSent` только завершает socket. |
| Session и lineage persistence атомарны как единое логическое состояние. | Да, `VERIFYING` | D6 PASS B: один `PersistentSessionDocument` schema v2, FIFO mutations и startup init; PB31/PB33 regressions green. Независимый review/merge ещё требуется. |
| Secrets, tokens, cookies и raw prompts не логируются по умолчанию. | Да для известных полей | Redactor + secret regressions; D8 должен сохранить это при добавлении telemetry. |

## 5. Production Audit Backlog

### 5.1 Core backlog

| ID | Priority | Primary / affected | Status | Problem | Evidence | Dependencies | Fix commit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **D1** | P3 | L3 / L2,L4 | `UNCONFIRMED / DEFERRED` | Full Claude transcript вместе с continuing DeepSeek parent chain может дублировать context и ухудшать long-depth flow. | `HANDOFF`: A и B имели clean full runs; поздние failures коррелировали с quota/rate limit. Controlled A/B/C не дал устойчивого подтверждения. | Все P0/P1, long-run benchmark | — |
| **D2** | P0 | L3 / L2,L4 | `CONFIRMED` | Guard repair generations продвигают production parent; rejected generation может стать parent следующей попытки. | `HANDOFF`: 77→1001→1002→1003. `REPO`: `runCompletion()` пишет `state.parentMessageId` при каждом `chunk.messageId`, а `complete()` повторно вызывает его с тем же state. | D3 terminal semantics | — |
| **D3** | P0 | L4 | `CONFIRMED` | Timeout заканчивается после headers; body stall не отменяется. Empty HTTP 200, partial/non-terminal и `INCOMPLETE` могут вернуться как completion. | `REPO`: fetch timer очищается сразу после `fetch()`; zero-byte body stream возвращает empty strings; parser считает `INCOMPLETE` done; `runCompletion()` не требует `FINISHED`. Документация обещает HTTP 429/5xx retries, но fetch-loop повторяет только thrown network errors. | D6 сначала; error contract для D4 | — |
| **D4** | P0 | L1 / L4 | `CONFIRMED` | После Anthropic HTTP 200 + `message_start` поздний `BridgeError` обрывает SSE без protocol terminal/error contract. | `REPO`: `stream.start()` вызывается до upstream completion; `routeError()` при `headersSent` делает только `res.end()`. | D3 failure taxonomy | — |
| **D5** | P1 | L3 | `CONFIRMED` | Stale lineage может жить дольше policy; выбирается не обязательно latest relevant result. | `HANDOFF`: ~48h link использовался. `REPO`: 10m `SESSION_LINK_TTL_MS` не применяется; store hardcodes 24h only at init/size>10000; `extractToolUseIdFromMessages()` возвращает первый result. | D6 | — |
| **D6** | P0 | L3 | `IMPLEMENTED / VERIFYING` | Один `PersistentSessionDocument` теперь владеет `sessions.json`; оба store делегируют ему sessions/links mutations. Schema v2, v1 migration, unknown sibling preservation, FIFO queue и init-before-listen устраняют подтверждённую collision в одном процессе. | `REPO`: `persistentSessionDocument.ts`, owner wiring в `buildApp()`, recoverable atomic write. `TEST`: PB31/PB33, migration/failure/startup cases; 574/574 green. | Independent diff review, merge, release-commit verification | `7573fcd20f22890983acda3c153f1217b630ecce` |
| **D7** | P1 | L2 | `CONFIRMED` | Received/allowed/described tool catalogs расходятся: полный allowlist доступен parser-у, prompt описывает только первые 32. | `HANDOFF`: Claude Code 35 tools. `REPO`: `selectBridgeTools()` сохраняет все, `buildToolNames()` — все, `buildToolPrompt()` использует `available.slice(0,32)`. | D8 catalog telemetry | — |
| **D8** | P1 | L4 / L1,L2,L3 | `CONFIRMED`; D16 merged | Недостаточно безопасной request/session/attempt/stage/call-id correlation. | `REPO`: request_ref создаётся сервером, но handler хранит base logger; guard/upstream logs не имеют полного attempt/parent/stage lifecycle. `completion_done` логирует raw upstream key. | D3/D4 event taxonomy | — |
| **D9** | P1 | L2 | `CONFIRMED CURRENT GAP` | Existing environment classifier не распознаёт natural listing variants и typo, поэтому plain final может пройти без fresh result. | `LIVE`: `что находится в данной дериктории?`. `REPO`: listing regex не покрывает `находится/лежит` и typo. Фраза 34 chars; `INTENT_MAX_LENGTH=300` не является фактором. Existing mechanism — `bbd13b2`, новый subsystem запрещён. | После P0 и D7 | —; base mechanism `bbd13b2` |
| **D10** | P2 | L1 / platform | `NEEDS REPRODUCTION` | Graceful shutdown/PID timing может видеть tracked child живым спустя ~1s. | `HANDOFF`: test иногда падал, orphan позже не оставался. Current sandbox также блокировал `taskkill`, вне sandbox test прошёл; platform cause не изолирован. | D8 telemetry | — |
| **D11** | P2 | L2 | `CONFIRMED STATIC GAP` | Prompt-facing tool schema перечисляет только имена arguments, не полную JSON schema semantics. | `REPO`: `toolPrompt.ts` извлекает `Object.keys(properties)`; types/required/nested constraints модели не показываются. Production impact требует PASS A. | D7 single catalog | — |
| **D12** | P2 | L2 | `NEEDS REPRODUCTION` | Подозреваемая неверная validation ordering для nested arrays. | `REPO`: `inspectNestedValues()` проверяет `!isPlainObject(value)` до `Array.isArray(value)`, делая array traversal недостижимым. Нужен exact parser reproduction и desired contract. | D11 schema contract | — |
| **D13** | P2 | L2 | `KNOWN LIMITATION` | 3+ distinct file targets и часть same-kind steps схлопываются в generic obligation. | `REPO`/history: two-file split intentionally gated to exactly two; 3+ остаётся fallback. | D7, frozen mutation cases | — |
| **D14** | P2 | L1 | `NEEDS VERIFICATION` | Anthropic `system` content-block arrays могут теряться при normalization. | `REPO`: `normalizeAnthropic()` читает system через string-only `stringField`; tests покрывают только string. Нужен diagnostic protocol case до объявления runtime defect. | Нет | — |
| **D15** | P2 | L1 / L4 | `CONFIRMED STATIC GAP` | `max_tokens` нормализуется, но не передаётся DeepSeek; Anthropic streaming usage всегда 0, new-format usage coverage отсутствует. | `REPO`: `CanonicalRequest.maxTokens` не используется в payload; Anthropic SSE start/done hardcode zero; usage parser есть только в legacy data path. | D3 terminal/usage semantics | — |

### 5.2 Acceptance and required evidence

| ID | Acceptance criteria | Required tests | Frozen benchmark |
| --- | --- | --- | --- |
| D1 | Только повторяемый controlled A/B/C при одинаковых model/thinking/tools, ≥3 runs × 15–20 turns; вывод только при статистически различимом failure depth. | Diagnostic harness; prompt bytes, parent depth, malformed/repair/502/latency; no production change in PASS A. | PB34–PB35 |
| D2 | Rejected attempts используют isolated candidate parent; accepted state меняется ровно один раз после accepted generation. | Initial/retry/exhaustion parent tests; transport failure rollback; accepted progression. | PB29–PB30 |
| D3 | Один deadline покрывает headers+body; abort cancels reader/fetch; zero-byte/non-terminal/INCOMPLETE reject; only FINISHED succeeds; retry policy соответствует docs. | Fake/stalled ReadableStream, empty 200, partial, INCOMPLETE, FINISHED, abort cleanup, 429/5xx policy. | PB22–PB27 |
| D4 | После `message_start` любой failure завершается валидным documented Anthropic SSE error/terminal sequence; socket не висит. | Route-level stream failure before/after start, client disconnect, no double terminal. | PB28 |
| D5 | Единый TTL; age checked on lookup; latest current-cycle result wins; expired links pruned durably. | Fake clock, 48h stale, multiple results latest, restart/prune/current-cycle cases. | PB31–PB32 |
| D6 | Один owner/schema/transaction path для sessions+links; concurrent writes не теряют siblings; crash leaves valid previous/new file. | Concurrent/interleaved writers, restart, atomic failure injection, migration/backward compatibility. | PB31, PB33 |
| D7 | `received == allowed == described` после explicit unavailable filtering, либо request rejected before upstream with documented limit. | 0/1/32/33/35 tools; Artifact; exact catalog identity. | PB14, PB20 |
| D8 | Каждый request имеет redacted correlation across L1–L4: request_ref, opaque Claude/upstream refs, parent depth, completion+guard attempts, stage, latency, failure class, tool/call-id. | Logger sink assertions, concurrency isolation, redaction/no raw prompt/secrets, rate-limit and stream failures. | PB20, PB24, PB28, PB34 |
| D9 | Existing detector требует fresh current-cycle result для всех benchmark phrases; informational controls remain tool-free. | Exact typo + RU/EN variants, negatives, root `DeepSeekClient.complete()` rejection/real result acceptance. | PB02, PB05 |
| D10 | Tracked child/server terminate within documented deadline; no orphan; untracked process survives; platform/sandbox distinctions explicit. | Windows/macOS/Linux process-owner tests plus desktop live shutdown. | PB39 |
| D11 | Prompt-facing representation сохраняет required/type/nested schema within documented size limit; no silent schema truncation. | Real Claude schema fixture comparison, nested object/array/enum/required cases, size cap. | PB14, PB17–PB18 |
| D12 | Valid nested arrays accepted up to depth limit; unsafe keys/depth rejected; contract documented. | Exact nested array reproduction, nested object+array, depth boundary, pollution keys. | PB14–PB15 |
| D13 | 3+ distinct mutations получают separate evidence or request is conservatively rejected; one result cannot close several targets. | 3/4 files, same-kind steps, partial/failure/duplicate prevention. | PB07, PB09–PB10 |
| D14 | Anthropic string and block-array system content preserve ordered text exactly or unsupported shape returns INVALID_REQUEST. | Text blocks, multiple blocks, mixed/unknown blocks, Unicode, root prompt capture. | PB14 |
| D15 | Supported output limit reaches upstream or is explicitly rejected; usage is real/absent, never fabricated zero presented as measured. | Payload capture, streaming/non-streaming usage, missing/new/legacy usage. | PB22, PB28 |

## 6. Closed / Regression-Protected

Closed означает «не переисследовать без новой evidence», а не «вся смежная
область идеальна».

| Mechanism | Commit(s) | Protecting tests | Reopen only when |
| --- | --- | --- | --- |
| Fabricated environment result guard | `bbd13b2` | `fabricated environment execution guard`, `DeepSeekClient environment completion guard` | Repro относится к current-cycle environment evidence. D9 удовлетворяет этому условию как classifier gap, не новый subsystem. |
| Stale executable action replay | `7bb70ca`, `4eb65b7` | `sanitizedToolInvocationText`, `buildUpstreamPrompt — stale action replay prevention`, root prompt capture | Historical executable arguments снова присутствуют в production upstream prompt или old action реально replayed. |
| Malformed tool JSON leakage | `6c8bff2` | malformed envelope/escape/root bounded repair cases in `tools.test.ts` | Raw recognizable tool syntax уходит final либо valid repair не становится tool_use. |
| Pseudo-XML tool leakage | `baf72a6`, `aa6e6e2` | `pseudo-xml tool intent leakage` | Executable invoke+parameter shape проходит final или informational XML ложно блокируется. |
| Repeated failed tool call | `030cbd9` | `repeated failed tool call evidence` and root callback/exhaustion cases | Identical failed fingerprint выполняется дважды в одном action cycle. |
| Multi-step completion integrity | `7c3cb39`, `67c6f68` | `external action completion integrity`, `DeepSeekClient action completion guard` | Success final появляется при missing supported obligation evidence. |
| Fresh final-state evidence | `06b1e4e`, `c8693ac` | `final-state tool flow regression`, stale/cardinality cases | Evidence до последующей invalidating mutation принимается как final state. |
| Multiple obligation instances | `8dfd84f` | `multiple obligation instances per kind` | Один evidence закрывает две поддержанные instances одного kind. |
| Two distinct file mutations | `7017c04`, `93bfde8` | `distinct file mutation obligations` | Два explicit targets закрываются одним mutation result. 3+ targets — D13, не reopen. |
| Same-file additive final verification | `bab6a9c`, `358df9c` | `same-file additive final-state verification` | Поддержанный two-clause additive scenario не требует fresh final Read или destructive wording даёт false positive. |
| HTTP 200 SSE `rate_limit_reached` | `bedcab2` | `tests/unit/deepseekRateLimit.test.ts` | Exact hint не даёт retryable 429, вызывает >1 completion attempt или ordinary hint становится false positive. |
| Normal Anthropic tool streaming | `bd6208e`, `61c44c8` | normal lifecycle sections in `tests/unit/sse.test.ts` | Normal message/tool block ordering ломается. Late-error lifecycle отдельно открыт как D4. |

**Reopening rule:** нужен reproducible regression, failing existing regression
test или доказательство принадлежности нового case тому же mechanism. Новая
natural-language phrase сама по себе не создаёт новый architecture subsystem.

## 7. Frozen Production Benchmark PB-v1

После merge этой спецификации существующие PB cases нельзя ослаблять, удалять
или переписывать ради новой реализации. Исправление неоднозначности оформляется
versioned addendum; новые regressions добавляются новыми IDs.

| ID | Category | Setup / request | Expected tools and result | Forbidden behaviour | Mode | Defects |
| --- | --- | --- | --- | --- | --- | --- |
| PB01 | Read/env | Known cwd; ask current cwd. | Fresh Bash `pwd` result, then exact cwd final. | Text-invented cwd; historical result. | Offline + live | D9 |
| PB02 | Read/env | Non-empty dir; ask listing, including exact `что находится в данной дериктории?`. | Fresh Glob/Bash listing contains independently known entries. | Plain guess, wrong cwd, typo bypass. | Offline + live | D9 |
| PB03 | Read/env | Nested fixture; ask Glob/project structure. | Glob/list tool and exact fixture structure. | Generic prose structure. | Offline + live | D7,D9 |
| PB04 | Read/env | Known file + missing file; ask content/existence. | Read/Glob evidence; exact content and true/false. | Fabricated content/existence. | Offline + live | D9 |
| PB05 | Read/env | Ask `что такое директория?`, `what does current directory mean?`, `как работает cd?`. | No tool; accurate text. | Unnecessary tool/TOOL_CALL_REQUIRED. | Offline | D9 |
| PB06 | Mutation | Create, edit, then delete one temp file. | Three correlated mutations; final absence verified. | Skipped step or success after failure. | Offline + live | D2,D13 |
| PB07 | Mutation | Mutate two distinct files with exact markers. | Separate evidence per target. | One result closes both; cross-file write. | Offline + live | D13 |
| PB08 | Mutation | Two additive clauses on same file, then verify. | Mutation(s) + fresh Read containing both markers. | Destructive false-positive; stale Read. | Offline + live | closed guard |
| PB09 | Mutation | Two obligations of same kind with distinct targets/values. | One-to-one evidence binding. | Evidence reuse across instances. | Offline | D13 |
| PB10 | Mutation | First mutation fails; model retries identical then corrected action. | Identical failure executes once; changed action may succeed. | Duplicate mutation, empty final, fake success. | Offline + live | D2,D13 |
| PB11 | Verification | Run deterministic test fixture with pass/fail variants. | Real test command; correct pass/fail report. | `--version` as evidence; masked failed summary accepted. | Offline + live | closed guard |
| PB12 | Verification | Start temp HTTP server and GET health. | Launch result followed by fresh HTTP 200 evidence. | Launch alone proves health; broad kill. | Offline + live | D10 |
| PB13 | Verification | Verify state, mutate, then final; include historical prior result. | New verification after mutation; old result ignored. | Stale/historical evidence accepted. | Offline + live | D2,D5 |
| PB14 | Tool protocol | Normal tool with full nested schema and Anthropic system blocks. | Exact described/allowed schema; real tool_use/result. | Dropped system/schema; raw JSON final. | Offline | D7,D11,D12,D14 |
| PB15 | Tool protocol | Malformed JSON call with bad escape, then valid repair. | Bounded retry → real tool_use or explicit failure. | Raw malformed syntax, guessed backslash repair. | Offline + live | D12, closed parser |
| PB16 | Tool protocol | Executable pseudo-XML invoke+parameter. | Bounded canonical retry. | Pseudo-XML final/execution. | Offline | closed parser |
| PB17 | Tool protocol | Valid tool call appears in reasoning only. | Same allowlist/schema checks and tool_use output. | Reasoning leak or unvalidated execution. | Offline | D7,D11 |
| PB18 | Tool protocol | Model requests unknown/34th+ tool. | Unknown rejected; every advertised supported tool is described. | Execution outside allowlist; silent catalog mismatch. | Offline | D7,D11 |
| PB19 | Tool protocol | tool_result has wrong/unknown call ID. | Explicit correlation failure/new safe session policy. | Result attached to unrelated action/session. | Offline | D5,D8 |
| PB20 | Tool protocol | 5+ sequential mixed tools. | Ordered unique IDs/results; correlated telemetry. | Missing/reordered/replayed action. | Offline + live | D7,D8 |
| PB21 | Tool protocol | Tool returns `is_error:true`, then alternate succeeds or honest failure. | Failure preserved; bounded recovery. | Failed result counted as success; repeated identical call. | Offline + live | D2 |
| PB22 | Transport | Normal multi-chunk DeepSeek SSE ending FINISHED with usage. | Exact assembled content; terminal observed; real/absent usage. | Truncation, FINISHED text leak, fake zero usage. | Offline | D3,D15 |
| PB23 | Transport | Upstream HTTP 502 fixture. | Classified retry/failure per policy; no successful completion. | Empty/fake success or guard retry. | Offline | D3,D8 |
| PB24 | Transport | HTTP 200 + `event: hint`, `rate_limit_reached`. | `DEEPSEEK_RATE_LIMIT` HTTP 429; one generation attempt. | TOOL_CALL_REQUIRED, empty completion, retry storm. | Offline | closed rate limit |
| PB25 | Transport | HTTP 200 with zero-byte body stream. | `STREAM_PARSE_FAILED`/documented upstream error. | Empty successful final. | Offline | D3 |
| PB26 | Transport | Partial content then `INCOMPLETE` or EOF without FINISHED. | Explicit incomplete error; parent not accepted. | Partial final or parent advancement. | Offline | D2,D3 |
| PB27 | Transport | Headers arrive; body stalls beyond deadline. | Abort reader/fetch within deadline; cleanup complete. | Hang or background body continuation. | Offline | D3 |
| PB28 | Transport | Anthropic stream starts, then upstream/guard fails. | Valid downstream error/terminal contract and closed response. | Bare socket truncation/hang/double terminal. | Offline integration | D4,D8,D15 |
| PB29 | Session | Two accepted completions in one upstream session. | Parent advances exactly accepted1→accepted2. | Fresh session or skipped accepted parent. | Offline + live | D2,D5 |
| PB30 | Session | Initial output rejected; repair(s) then accepted/exhausted. | Candidate parents isolated; only accepted parent committed. | Rejected parent reused/ persisted. | Offline | D2 |
| PB31 | Session | Persist session+lineage, restart Bridge, continue tool result. | Both shapes survive and correct upstream resumes. | Lost siblings/cross-session continuation. | Offline integration + live | D5,D6 |
| PB32 | Session | Expired link plus newer matching current result. | Expired ignored/pruned; latest current result selected. | 48h link or first stale result wins. | Offline | D5 |
| PB33 | Session | Concurrent auth-session and lineage writes with injected interleaving. | Valid combined durable state after restart. | Lost `sessions` or `links`; invalid JSON. | Offline integration | D6 |
| PB34 | Long run | 3 runs × 30–50 read-only/sequenced tools with controlled failures. | Full depth, bounded recovery, telemetry per attempt. | Fabrication, replay, duplicate mutation, unexpected 502/hang. | Live | D1,D2,D3,D8 |
| PB35 | Long run | `/compact` after long chain, then new read and multi-step continuation. | New request authoritative; correct cwd/context; no stale action. | Replay, old result evidence, premature final. | Live | D1,D5 |
| PB36 | Platform | Windows Unicode cwd and safe child/Claude launch. | Exact cwd/env; tracked process only. | Mojibake, wrong cwd, broad kill. | CI + desktop live | D10 |
| PB37 | Platform | Ubuntu CI without assumed GUI terminal. | typecheck/tests/build/platform smoke; honest capabilities. | Fake GUI claim or leaked env. | CI | D10 |
| PB38 | Platform | macOS CI with osascript/Terminal detection, no GUI claim. | Unicode runner/quoting/capabilities verified. | Fake desktop-live claim. | CI | D10 |
| PB39 | Platform | Shutdown with one tracked and one untracked child. | Server/tracked PID exit in deadline; credentials/untracked child remain. | Orphan tracked PID or broad process kill. | Offline + desktop live | D10 |

## 8. Definition of Production Ready

Все gates бинарны. `PRODUCTION READY` запрещён при любом незакрытом gate.

| Gate | Pass condition | Baseline status |
| --- | --- | --- |
| G1 | `npm run typecheck` green | PASS (recheck each branch) |
| G2 | `npm test` 100% green | PASS: 574/574 on D6 feature branch (recheck release commit) |
| G3 | `npm run build` green | PASS (recheck each branch) |
| G4 | `npm run test:platform` green | PASS on current Windows baseline |
| G5 | CI Windows/Linux/macOS green for release commit | NEEDS RELEASE-COMMIT VERIFICATION |
| G6 | Все P0 закрыты | FAIL: 4 open |
| G7 | Все P1 закрыты либо formally waived с owner/reason/expiry | FAIL: 4 open |
| G8 | 100% deterministic offline PB cases automated and green | FAIL: PB-v1 пока specification |
| G9 | 3 последовательных clean live benchmark runs | FAIL |
| G10 | 3 × 30–50 tool autonomous runs без fabrication/replay/duplicate/malformed leak/unexpected 502/hang | FAIL |
| G11 | Rate limit → retryable `DEEPSEEK_RATE_LIMIT`/429 без guard storm | PASS offline; preserve in live |
| G12 | Любой upstream failure bounded; нет hang/fake success | FAIL: D3/D4 |
| G13 | Restart сохраняет консистентные persistent session/lineage | VERIFYING: deterministic PB31/PB33 restart/interleaving tests green; review/merge required |
| G14 | `/compact` после long chain проходит PB35 | NEEDS FROZEN LIVE RUNS |
| G15 | Shutdown не оставляет orphan/stale PID и не убивает чужие процессы | NEEDS VERIFICATION: D10 |
| G16 | Нет известных открытых P0/P1 production defects | FAIL |

## 9. Mandatory development workflow

### PASS A — DIAGNOSIS ONLY

Production code не меняется. Для одного defect:

1. воспроизвести case;
2. назначить primary/affected layers;
3. доказать root cause по всем call sites;
4. описать minimal proposed fix;
5. определить regression tests;
6. перечислить затронутые PB cases;
7. оценить regression/security risk.

Результат — отдельный diagnostic report и статус `DIAGNOSED`. Только после
одобрения scope разрешён PASS B.

### PASS B — IMPLEMENTATION

1. отдельная feature branch;
2. только approved defect scope;
3. regression test сначала или одновременно;
4. minimal implementation;
5. typecheck;
6. полный offline suite;
7. build;
8. platform test;
9. релевантные frozen PB cases;
10. `CHANGELOG.md`;
11. `PROJECT_STATE.md` и этот backlog status;
12. commit;
13. push;
14. независимый diff review;
15. merge `master` только после review.

Запрещено исправлять «заодно», смешивать defects, ослаблять failing tests ради
green, создавать новый mechanism при подходящем существующем, менять D1 без
повторяемого reproduction и расширять provider/UI scope до release readiness.

## 10. Dependency-aware work order

1. **D6 — persistence collision.** PASS B implementation готова; сначала
   независимый diff review, merge и release-commit verification. D6 не закрывать
   до прохождения этого gate.
2. **D3 — upstream stream lifecycle.** Формирует единый terminal/failure contract.
3. **D4 — downstream Anthropic SSE lifecycle.** Строится на taxonomy D3.
4. **D2 — rejected parent isolation.** После D3 можно атомарно commit-ить только
   terminal accepted generation.
5. **D5 — lineage freshness/TTL.** После единого durable schema D6.
6. **D7 — tool catalog consistency.** Убирает silent 33+ tool mismatch.
7. **D8/D16 — observability/correlation.** Инструментирует уже стабилизированные
   lifecycle states без утечки secrets/prompts.
8. **D9, D11, D12, D13, D14, D15** — по одному correctness P1/P2 defect за branch.
9. **D10**, затем полный PB-v1, 30–50-tool stress, `/compact`, restart/resume.
10. **D1** — повторный controlled A/B/C только после стабилизации остальных причин.

## 11. Repository consistency findings

| Finding | Resolution in this plan |
| --- | --- |
| `PROJECT_STATE.md` фиксирует green feature phases, но не содержит единого списка подтверждённых P0/P1 release blockers. | Этот файл становится hardening source of truth; общий feature status не равен production readiness. |
| `docs/architecture.md` заявляет retries для HTTP 429/temporary 5xx, но текущий `fetch()` retry-loop повторяет только thrown fetch errors. | Включено в D3; desired retry policy должен быть явно утверждён в PASS A. |
| `SESSION_LINK_TTL_MS=10m`, а `LineageStore` hardcodes 24h и не проверяет age при lookup. | D5. |
| Документация отмечала sibling-safe только `lineage.clear()`, тогда как normal writers перезаписывали разные shapes. | D6 PASS B заменяет writers единым schema-v2 owner; deterministic concurrent/restart/failure cases green, independent review pending. |
| Tool allowlist может содержать 35, prompt silently описывает 32. | D7. |
| Anthropic system array, output limit и streaming usage не покрыты текущими normalize/lifecycle tests. | D14/D15, без преждевременного заявления полного runtime impact. |
| D1 A/B/C evidence отсутствует в repo и доступен только как diagnostic handoff. | D1 остаётся unconfirmed/deferred. |

## 12. Current decision

Проект **не является Production Ready**. D6 PASS B находится в статусе
`IMPLEMENTED / VERIFYING`; следующий шаг — независимый diff review, merge и
проверка release commit. До этого D6 не считается закрытым и работа над следующим
production defect не начинается.
