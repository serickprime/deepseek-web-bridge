# Production Readiness

> **Статус:** `HARDENING IN PROGRESS`
>
> **Baseline:** `fix/d15-anthropic-usage-fidelity` — D15b closure branch
>
> **Offline baseline:** 35 test files, 904 tests (D15b closure branch)
>
> **Открыто:** P0 — 0, P1 — 0, P2 — 2; deferred P3 — 1
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
| Каждый разрешённый Bridge tool описан DeepSeek в prompt после explicit unavailable filtering. | Да | D7 CLOSED подтверждает membership; D11 CLOSED после deterministic full-schema/preflight coverage, independent review и Windows Claude Code WebFetch live verification. |
| Fabricated text никогда не считается `tool_result`. | Да для поддержанного scope | D9 CLOSED: natural listing classifier gap закрыт deterministic PB02/PB05 coverage и live RU typo / EN listing / informational controls. |
| Historical `tool_result` не подтверждает новое действие. | Да | L2 current-cycle guard и D5 L3 correlated selection защищены deterministic tests; D5 CLOSED. |
| Mutation нельзя считать успешной без подходящего evidence. | Да для D13 scope | D13 CLOSED: 1–5 target/same-kind deterministic coverage, independent review и Windows 3 Write + 3 Read live PASS. D17 — отдельный false-positive command classifier, не mutation-evidence gap. |
| Rejected generation не изменяет accepted session/parent state. | Да | D2 CLOSED: candidate parent живёт только внутри `complete()`; PB29/PB30 deterministic PASS, Windows Claude Code normal turn и real Bash/tool-result continuity PASS. Exact parent IDs в live logs не наблюдались. |
| Transport error не превращается в fake successful completion. | Да | D3 CLOSED: body/transport failures нормализованы, empty/INCOMPLETE/non-terminal stream отклоняются; deterministic offline и Windows live verification PASS. |
| HTTP 200 сам по себе не означает successful DeepSeek completion. | Да | D3 CLOSED: требуется authoritative FINISHED/old done terminal; PB22–PB27 deterministic и релевантная live verification green. |
| Explicit DeepSeek rate limit не вызывает completion-guard retry storm. | Да | `bedcab2`, `tests/unit/deepseekRateLimit.test.ts`: один completion attempt, 429. |
| После `message_start` downstream всегда получает корректный terminal/error contract. | Да | D4 CLOSED: one `event:error`, terminal exclusivity и bounded close покрыты T1–T26/PB28 и Windows live verification. |
| Session и lineage persistence атомарны как единое логическое состояние. | Да | D6 закрыт: schema-v2 owner, FIFO mutations и startup init защищены offline tests; Windows Claude Code live подтвердил сохранность и restart/resume lineage. |
| Secrets, tokens, cookies и raw prompts не логируются по умолчанию. | Да | Redactor + D8 focused regressions; raw identities/payloads и arbitrary exception messages исключены из correlation telemetry. |

## 5. Production Audit Backlog

### 5.1 Core backlog

| ID | Priority | Primary / affected | Status | Problem | Evidence | Dependencies | Fix commit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **D1** | P3 | L3 / L2,L4 | `UNCONFIRMED / DEFERRED` | Full Claude transcript вместе с continuing DeepSeek parent chain может дублировать context и ухудшать long-depth flow. | `HANDOFF`: A и B имели clean full runs; поздние failures коррелировали с quota/rate limit. Controlled A/B/C не дал устойчивого подтверждения. | Все P0/P1, long-run benchmark | — |
| **D2** | P0 | L3 / L2,L4 | `CLOSED` | Shared `state.parentMessageId` означает только accepted parent; rejected repair candidates образуют локальную цепочку и публикуются ровно один раз после полного acceptance boundary. | `TEST`: PB29/PB30 deterministic PASS, 19 focused cases; 31 files / 646 tests, typecheck/build/Windows test:platform/diff-check PASS. `LIVE`: independent review PASS; Windows, Claude Code 2.1.241, `deepseek-v4-flash`: `D2-TURN-1` normal turn PASS, real Bash `pwd` → `/d/Проекты/test`, linked tool-result continuation сохранил upstream key и показал `upstream_linked:true`; без conflict/incomplete/unexpected 502/hang. Live logs не доказывают exact parent ID. | D3 terminal semantics | `bc6d0aec8da2579c463d84c3e44cdcc61e175407` |
| **D3** | P0 | L4 | `CLOSED` | Completion имеет единый headers+body deadline и explicit terminal contract; empty/partial/INCOMPLETE не являются success, terminal завершает reader без EOF, completion POST не auto-retry. | `REPO`/`TEST`: T1–T21, T16b, PB22–PB27 и rate-limit invariant green. `LIVE` Windows, Claude Code 2.1.241, `deepseek-v4-flash`, `DS_TIMEOUT_MS=120000`: short direct completion PASS; long direct completion 6600 chars / 21853 ms; real Bash tool-cycle PASS; `completion_done` observed, без unexpected timeout/incomplete/parse/transport failures. PB22–PB27 relevant live verification PASS. | D6 закрыт; формирует error contract для D4 | `3a5aacc`, `4843cfb` |
| **D4** | P0 | L1 / L4 | `CLOSED` | Anthropic HTTP 200 commit отложен до первого SSE byte; pre-start errors возвращают real HTTP JSON, late failures — one safe `event:error`; success/error mutually exclusive. Tool lineage persist-ится до exposure. | `TEST`: T1–T26/PB28 route-level timeout/rate-limit/incomplete/partial/persistence/unknown/pre-start cases и protocol regressions green. `LIVE` Windows, Claude Code 2.1.241, `deepseek-v4-flash`: real Bash cycle PASS; controlled stalled challenge дал visible typed 504 без fake success; raw midstream PB28 дал `message_start` + one `event:error` и no success terminal. | D3 failure taxonomy | `b16307b0c59586709475aaeac312172e53771573` |
| **D5** | P1 | L3 | `CLOSED` | Единый `SESSION_LINK_TTL_MS` применяется при lookup/init/mutations; persisted expiry durably prune-ится без нарушения D6 ownership. Handler выбирает newest current-cycle result только при matching current-cycle `tool_use` и отклоняет конфликтующие header/correlated-result mappings. | `TEST`: PB31/PB32 authoritative, 26 regressions, 32 files / 672 tests; typecheck/build/Windows test:platform/diff-check PASS. `LIVE`: independent review PASS; Windows, Claude Code 2.1.241, `deepseek-v4-flash`: clean Bridge restart, первая post-restart continuation восстановила тот же persisted upstream key, `upstream_linked:true`, `completion_done`. Исходный Bash result уже имел linked request до restart; first-arrival-after-restart не заявляется. | D6 | `3614d4b`, `051e3ec` |
| **D6** | P0 | L3 | `CLOSED` | Один `PersistentSessionDocument` владеет `sessions.json`; оба store делегируют ему sessions/links mutations. Schema v2, v1 migration, unknown sibling preservation, FIFO queue и init-before-listen устраняют подтверждённую collision в одном процессе. | `REPO`/`TEST`: PB31/PB33 и migration/failure/startup cases, 574/574. `LIVE` Windows, Claude Code 2.1.241, `deepseek-v4-flash`: после real Bash cycle schema v2 содержала sessions=1 и links=2; restart восстановил session и продолжил real tool-cycle с `upstream_linked:true`. | — | `7573fcd20f22890983acda3c153f1217b630ecce` |
| **D7** | P1 | L2 | `CLOSED` | После explicit unavailable filtering prompt описывает весь authoritative available catalog; отдельного 32-tool cap больше нет. | `TEST`: independent review PASS; 17 focused cases для 0/1/32/33/35/39, Artifact positions, ordering/duplicates, 33+ handler tool-use/continuation, unknown rejection и D11 boundary; 33 files / 689 tests; typecheck/build/Windows test:platform/diff-check PASS. PB14 catalog identity, PB18 34th+/unknown и PB20 catalog stability — PASS. `LIVE` Windows, Claude Code 2.1.241, `deepseek-v4-flash`: 39 received; `Artifact` received #2 unavailable → 38 available; `WebFetch` received #34 / available #33 реально выполнил Fetch example.com, получил 559 bytes/200, final `Example Domain`; tool-result continuation показал `upstream_linked:true` и `completion_done`. | D8 CLOSED; D11 schema fidelity отдельно | `b09067eda568624f5dcd8373dee87b53a1f3c05f` |
| **D8** | P1 | L4 / L1,L2,L3 | `CLOSED`; D16 merged | Request-scoped logger явно проходит route → handler → DeepSeek → PoW; opaque process-local HMAC refs и safe lifecycle fields связывают L1–L4 без raw IDs/content. | `TEST`: independent review PASS; 12 focused cases / 34 files / 701 tests, typecheck/build/Windows test:platform/diff-check PASS. `LIVE`: Windows, Claude Code 2.1.241, `deepseek-v4-flash`: real Bash `pwd` → `/d/Проекты/test`; request_ref L1–L4, matching process-local call/upstream/chat refs through linked continuation, safe tool events, visible attempt/stage/latency fields and no raw marker/identity/payloads. PB20/PB24/PB28/PB34 telemetry scope PASS; cross-restart ref stability не заявляется. | D3/D4 event taxonomy | `6987ae5cc1983e7cbbe3a5d497a72eeebf8047f3` |
| **D9** | P1 | L2 | `CLOSED` | Existing classifier использует narrow concrete-directory-listing matcher для natural RU/EN variants и explicit `дериктор...`; concrete listing переопределяет generic informational `what is` без broad/fuzzy matching. | `TEST`: 75 focused regressions; direct A–L, PB05 negatives, fabricated final rejection, Bash/Glob/ListDirectory acceptance, fresh/historical evidence и no-listing-tool fallback; 34 files / 776 tests, typecheck/build/Windows test:platform/diff-check PASS. `LIVE`: Claude Code прислал 39 tools; exact RU typo request вызвал real Bash `tool_use`, correlated lineage сохранила тот же upstream, fresh `tool_result` разрешил final; EN `what is inside the current folder?` вызвал real tools, informational directory control остался text-only. | После P0 и D7 | `5a5b755e96b6dc965d6013c53a163259473c510d`; base mechanism `bbd13b2` |
| **D10** | P2 | L1 / platform | `NEEDS REPRODUCTION` | Graceful shutdown/PID timing может видеть tracked child живым спустя ~1s. | `HANDOFF`: test иногда падал, orphan позже не оставался. Current sandbox также блокировал `taskkill`, вне sandbox test прошёл; platform cause не изолирован. | D8 telemetry | — |
| **D11** | P2 | L2 | `CLOSED` | Каждый available occurrence описан полным compact lossless `JSON.stringify(inputSchema)`; initial/no-parent repair используют один catalog. 128 KiB UTF-8 preflight fail-closed выполняется до session/upstream/stream exposure, без truncation или content logging. | `TEST`: independent review PASS; 23 focused cases; PB14/PB17/PB18 root/nested/array/enum/`oneOf`/`$defs`, Unicode, round-trip, exact 131072/+1, dynamic 25/30/34/38/40, Artifact/Tool33+, D7 compatibility и D12 boundary control; 35 files / 799 tests. Measurements: max observed catalog 51183, entry 4073; projected 71548 leaves 59524 bytes. `LIVE`: Windows, Claude Code 2.1.241, `deepseek-v4-flash`; real `WebFetch(https://example.com)` получил 559 bytes/200 и final `Example Domain`, без parse/schema/unexpected-502/hang failures. Malformed/no-parent repair live не заявляется. | D7 single catalog; D12 отдельно | `cd0b3357eff07dc6cb171228853fac622fac8f51` |
| **D12** | P2 | L2 | `CLOSED` | Nested arrays проходят existing recursive safety inspection до plain-object rejection; root arguments остаётся plain object, а dangerous keys/depth/size/allowlist/malformed controls сохранены. | `TEST`: independent review PASS; 18 focused D12 regressions в `tools.test.ts` для primitive/empty/object/nested arrays, exact CanonicalToolCall, no-retry client, Anthropic handler exposure, root-array/depth/pollution/unknown/malformed controls; D11 array-schema transport green; 35 files / 817 tests. `LIVE`: Windows, Claude Code 2.1.241, `deepseek-v4-flash`; real `AskUserQuestion` с one-object `questions` array и nested `Alpha`/`Beta` options, user selected `Alpha`, real `tool_result` continuation и final `Alpha`, без unsafe/guard-exhaustion/unexpected-502/hang failures. Exact raw arguments live не заявляются. | D11 schema contract | `e237562bfb43d782b64eeb9673e0d5eba6abdbe8` |
| **D13** | P2 | L2 | `CLOSED` | Independent create/edit/read action-target groups получают stable per-kind instances для 1–5 targets; explicit grouped operation остаётся одной obligation, ambiguous fallback сохраняет все targets. | `TEST`: 34 D13 cases; create/edit/read 1–5, partial/failure, mixed, grouped, same-file three-step/twice, Unicode/NFC, historical/stale/informational и root client guard; 35 files / 851 tests. `LIVE`: independent review PASS; Windows получил 3 separate Write + 3 separate Read results, PowerShell подтвердил exact A/B/C markers. Verdict: PASS WITH COLLATERAL FINDING — D17 вмешался только в final path. | Existing one-to-one matcher; D9/D12 controls | `0293f4a5a128766a535d3bf285252abe65e56fd8` |
| **D14** | P2 | L1 | `CLOSED` | Anthropic top-level `system` сохраняет string точно либо соединяет ordered text-block array одним `\n`; malformed/unsupported supplied shape fail closed как `INVALID_REQUEST`/400. | `TEST`: 17 regressions для exact string/1/3 blocks/order/whitespace/Unicode/empty/absent/metadata/malformed shapes, OpenAI control, HTTP Anthropic error envelope и captured DeepSeek prompt без raw system JSON; 35 files / 891 tests; independent review PASS. Live не требуется: deterministic normalization/serialization и exact downstream prompt boundary доказаны напрямую, а Claude Code 2.1.241 не подтверждён как sender array shape. | Нет; D15 отдельно | `1f2f17267272e97d5941741d5767cc2e6e3de760` |
| **D15a** | P2 | L1 / L4 | `OPEN / CAPABILITY UNRESOLVED` | Anthropic `max_tokens` нормализуется, но для внутреннего DeepSeek Web completion protocol не подтверждено enforceable output-limit field; guessed field запрещён. | `LIVE DIAGNOSTIC`: Claude Code 2.1.241 отправляет `max_tokens=32000`; актуальный Web payload/frontend не показал `max_tokens`, `max_new_tokens`, `max_output_tokens` или иной доказанный limit field. Downstream truncation не доказана безопасной для SSE/tool/terminal contract. | Отдельная capability verification | — |
| **D15b** | P2 | L1 / L4 | `CLOSED` | Anthropic usage имеет exact-or-unavailable semantics: exact legacy split передаётся, unknown usage omitted; V4 cumulative counter хранится отдельно и не masquerade-ит как per-request usage. | `TEST`: implementation `a4c43a222be14e4513923b3d9525398cb616980a`, independent review PASS; 13 focused regressions; V4 initial/BATCH/latest/FINISHED/INCOMPLETE, legacy split, non-stream exact/zero/unknown/partial, streaming text/tool и handler propagation; focused 85/85, full 35 files / 904 tests. `LIVE` Windows, Claude Code 2.1.246, `deepseek-v4-flash`: unknown-usage Anthropic stream принят real client; Bash + linked `tool_result` завершились `D15B-TOOL-PASS`, main continuation `completion_attempt=1` / `guard_attempt=0` / `completion_done`, без usage/SSE failure, hang или D15b 502. Verdict `PASS WITH COLLATERAL FINDING`: один initial `missing_tool_evidence` retry и отдельная post-final new-lineage guard/tool chain относятся к guard/client collateral, не D15b. | D3 terminal semantics; D4 downstream lifecycle | `a4c43a222be14e4513923b3d9525398cb616980a` |
| **D17** | P1 | L2 | `CLOSED` | Один shared narrow predicate требует explicit command wording, conservative recognizable CLI literal либо явный Bash/shell/PowerShell/terminal context; generic `Выполни ...` action/file wording не создаёт `command_execution`. | `TEST`: 23 D17 regressions; focused 436/436, full 35 files / 874 tests; independent review PASS. `LIVE`: Windows, Claude Code 2.1.241, `deepseek-v4-flash`, real 39-tool catalog; 3 Write + 3 Read results, каждый requested cycle `completion_attempt=1` / `guard_attempt=0`, immediate `D17-LIVE-PASS`, no Bash/missing command/502, external marker verification PASS. Отдельный new-lineage/empty-history/different-upstream post-final Bash не относится к D17 chain. | D13 CLOSED | `d3d57de901ba3b07afeb27aa634054b8c1092f2f` |

### 5.2 Acceptance and required evidence

| ID | Acceptance criteria | Required tests | Frozen benchmark |
| --- | --- | --- | --- |
| D1 | Только повторяемый controlled A/B/C при одинаковых model/thinking/tools, ≥3 runs × 15–20 turns; вывод только при статистически различимом failure depth. | Diagnostic harness; prompt bytes, parent depth, malformed/repair/502/latency; no production change in PASS A. | PB34–PB35 |
| D2 | Rejected attempts используют isolated candidate parent; accepted state меняется ровно один раз после accepted generation. | Initial/retry/exhaustion parent tests; transport failure rollback; accepted progression. | PB29–PB30 |
| D3 | Один deadline покрывает headers+body; abort cancels reader/fetch; zero-byte/non-terminal/INCOMPLETE reject; only FINISHED succeeds; retry policy соответствует docs. | Fake/stalled ReadableStream, empty 200, partial, INCOMPLETE, FINISHED, abort cleanup, 429/5xx policy. | PB22–PB27 |
| D4 | После `message_start` любой failure завершается валидным documented Anthropic SSE error/terminal sequence; socket не висит. | T1–T26: route-level failure before/after start, safe mapping, persistence-before-exposure, client disconnect defense, no double terminal. | PB28 |
| D5 | Единый TTL; age checked on lookup; latest current-cycle result wins; expired links pruned durably. | Fake clock, 48h stale, multiple results latest, restart/prune/current-cycle cases. | PB31–PB32 |
| D6 | Один owner/schema/transaction path для sessions+links; concurrent writes не теряют siblings; crash leaves valid previous/new file. | Concurrent/interleaved writers, restart, atomic failure injection, migration/backward compatibility. | PB31, PB33 |
| D7 | `received == allowed == described` после explicit unavailable filtering, либо request rejected before upstream with documented limit. | 0/1/32/33/35/39 tools; Artifact; exact catalog identity. | PB14, PB18, PB20 |
| D8 | Каждый request имеет redacted correlation across L1–L4: request_ref, opaque client/upstream/chat/call refs, history_entries, parent_state, отдельные completion+guard attempts, transport attempt, stage, latency и failure class. | Logger sink assertions, concurrency isolation, redaction/no raw prompt/secrets, rate-limit and stream failures. | PB20, PB24, PB28, PB34 |
| D9 | Existing detector требует fresh current-cycle result для всех benchmark phrases; informational controls remain tool-free. | Exact typo + RU/EN variants, negatives, root `DeepSeekClient.complete()` rejection/real result acceptance. | PB02, PB05 |
| D10 | Tracked child/server terminate within documented deadline; no orphan; untracked process survives; platform/sandbox distinctions explicit. | Windows/macOS/Linux process-owner tests plus desktop live shutdown. | PB39 |
| D11 | Prompt-facing representation сохраняет required/type/nested schema within 128 KiB UTF-8 catalog limit; no silent schema truncation; overflow fails before upstream/downstream exposure. | Dynamic Claude catalog measurements; nested object/array/enum/required/`oneOf`/`$defs`, semantic round-trip, exact boundary/+1, initial/no-parent repair. | PB14, PB17–PB18 |
| D12 | Valid nested arrays accepted up to depth limit; unsafe keys/depth rejected; contract documented. | Exact nested array reproduction, nested object+array, depth boundary, pollution keys. | PB14–PB15 |
| D13 | `CLOSED`: 3+ distinct actions получают separate evidence; grouped action не over-split; one result не закрывает unrelated instances. | 1–5 files, same-kind/same-file steps, partial/failure/grouped/root-guard deterministic PASS; independent review и Windows 3 Write + 3 Read live PASS WITH COLLATERAL FINDING D17. | PB06–PB07, PB09–PB10 |
| D14 | Anthropic string and block-array system content preserve ordered text exactly or unsupported shape returns INVALID_REQUEST. | Text blocks, multiple blocks, mixed/unknown blocks, Unicode, root prompt capture. | PB14 |
| D15a | Подтверждённый output limit достигает upstream либо compatibility limitation формально документирована; guessed Web field запрещён. | Shape-only protocol capture и controlled A/B только после обнаружения реального field. | — |
| D15b | Usage real/absent, never fabricated zero; V4 cumulative chain counter не выдаётся за per-request Anthropic usage. | Legacy/V4 parser fixtures; streaming/non-streaming exact, zero и unavailable; text/tool lifecycle. | PB22, PB28 |
| D17 | `CLOSED`: только explicit command/shell/terminal intent или консервативно распознаваемый command literal создаёт `command_execution`; generic action wording сохраняет реальные file obligations без shell requirement. | Direct classifier positives/negatives; exact D13 phrase; completed Write/Read cycle accepts final without Bash/retry; explicit command still requires fresh Bash evidence; independent review и Windows 39-tool live PASS. | PB06–PB07 |

## 6. Closed / Regression-Protected

Closed означает «не переисследовать без новой evidence», а не «вся смежная
область идеальна».

| Mechanism | Commit(s) | Protecting tests | Reopen only when |
| --- | --- | --- | --- |
| Fabricated environment result guard / natural directory listing | `bbd13b2`, `5a5b755` | `fabricated environment execution guard`, `DeepSeekClient environment completion guard`, D9 PB02/PB05 regressions и live RU/EN controls | Repro относится к current-cycle environment evidence за пределами закрытого natural listing scope. |
| Stale executable action replay | `7bb70ca`, `4eb65b7` | `sanitizedToolInvocationText`, `buildUpstreamPrompt — stale action replay prevention`, root prompt capture | Historical executable arguments снова присутствуют в production upstream prompt или old action реально replayed. |
| Malformed tool JSON leakage | `6c8bff2` | malformed envelope/escape/root bounded repair cases in `tools.test.ts` | Raw recognizable tool syntax уходит final либо valid repair не становится tool_use. |
| Pseudo-XML tool leakage | `baf72a6`, `aa6e6e2` | `pseudo-xml tool intent leakage` | Executable invoke+parameter shape проходит final или informational XML ложно блокируется. |
| Repeated failed tool call | `030cbd9` | `repeated failed tool call evidence` and root callback/exhaustion cases | Identical failed fingerprint выполняется дважды в одном action cycle. |
| Multi-step completion integrity | `7c3cb39`, `67c6f68` | `external action completion integrity`, `DeepSeekClient action completion guard` | Success final появляется при missing supported obligation evidence. |
| Fresh final-state evidence | `06b1e4e`, `c8693ac` | `final-state tool flow regression`, stale/cardinality cases | Evidence до последующей invalidating mutation принимается как final state. |
| Multiple obligation instances | `8dfd84f` | `multiple obligation instances per kind` | Один evidence закрывает две поддержанные instances одного kind. |
| Distinct file mutations | `7017c04`, `93bfde8`, `0293f4a` | `distinct file mutation obligations`, `D13 multi-target obligation fidelity`; Windows 3 Write + 3 Read live | Один mutation result закрывает unrelated target; 1–5 targets, grouped action и partial completion покрыты offline. D17 false command classifier не переоткрывает D13. |
| Same-file additive final verification | `bab6a9c`, `358df9c` | `same-file additive final-state verification` | Поддержанный two-clause additive scenario не требует fresh final Read или destructive wording даёт false positive. |
| HTTP 200 SSE `rate_limit_reached` | `bedcab2` | `tests/unit/deepseekRateLimit.test.ts` | Exact hint не даёт retryable 429, вызывает >1 completion attempt или ordinary hint становится false positive. |
| D6 unified session/lineage persistence | `7573fcd` | `persistentSessionDocument.test.ts`, `persistenceStartup.test.ts`, `atomicFile.test.ts`; Windows Claude Code restart/resume live | Session/lineage writer снова удаляет sibling state, restart не восстанавливает оба типа либо durable/atomic failure возвращается как success/corrupt target. |
| D3 upstream stream lifecycle | `3a5aacc`, `4843cfb` | `deepseekStreamLifecycle.test.ts`; Windows direct short/long completion and Claude Code Bash live | Authoritative terminal снова заменяется cleanup error, empty/partial stream проходит success, completion POST auto-retry-ится или valid generation неожиданно timeout/incomplete/parse/transport fails. |
| D4 downstream Anthropic SSE lifecycle | `b16307b` | T1–T26/PB28 route/protocol regressions; Windows Claude Code Bash and controlled pre-/midstream failure live | Lazy commit, safe single error terminal, persistence-before-exposure либо lineage ordering снова нарушаются; downstream видит hang, truncated stream, double terminal или fake success. |
| D2 accepted parent isolation | `bc6d0ae` | `deepseekParentIsolation.test.ts`, PB29/PB30; Windows Claude Code normal turn and Bash/tool-result continuity live | Rejected/failed candidate снова меняет shared accepted parent, exhaustion загрязняет следующий request или accepted progression ломается. |
| D7 tool catalog consistency | `b09067e` | `toolCatalogConsistency.test.ts`, PB14/PB18/PB20 catalog scope; Windows 39-tool WebFetch #33 live | Разрешённый available tool снова отсутствует в prompt, 33+ supported tool не становится настоящим `tool_use` либо unknown tool проходит allowlist. D8 telemetry и D11 schema fidelity не являются reopen D7. |
| D8 safe request correlation | `6987ae5` | `observabilityCorrelation.test.ts`, PB20/PB24/PB28/PB34 telemetry scope; Windows Claude Code Bash tool-cycle live | `request_ref` снова теряется между L1–L4, raw identity/content попадает в logs, attempts смешиваются либо tool/result refs не коррелируют linked continuation. Cross-restart equality opaque refs не является контрактом. |
| D11 full tool-schema transport | `cd0b335` | `toolSchemaTransport.test.ts`, PB14/PB17/PB18; Windows Claude Code WebFetch live | Полная schema снова редуцируется/обрезается, allowed catalog превосходит described catalog, overflow достигает upstream/stream либо initial/no-parent repair теряют authoritative catalog. D12 parser ordering остаётся отдельным defect. |
| D12 nested-array argument safety | `e237562` | 18 focused cases in `tools.test.ts`, D11 array-schema control; Windows Claude Code AskUserQuestion live | Array traversal снова становится недостижимым, nested arrays отклоняются как unsafe, recursive dangerous-key/depth checks обходятся либо root array ошибочно принимается. Exact raw-args live equality не является closure claim. |
| Normal Anthropic tool streaming | `bd6208e`, `61c44c8` | normal lifecycle sections in `tests/unit/sse.test.ts` | Normal message/tool block ordering ломается. |

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
| PB07 | Mutation | Mutate 2–5 distinct files with exact markers. | Separate evidence per target. | One result closes several; cross-file write. | Offline + live | D13 |
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
| PB22 | Transport | Normal multi-chunk DeepSeek SSE ending FINISHED with usage. | Exact assembled content; terminal observed; real/absent usage. | Truncation, FINISHED text leak, fake zero usage. | Offline | D3,D15b |
| PB23 | Transport | Upstream HTTP 502 fixture. | Classified retry/failure per policy; no successful completion. | Empty/fake success or guard retry. | Offline | D3,D8 |
| PB24 | Transport | HTTP 200 + `event: hint`, `rate_limit_reached`. | `DEEPSEEK_RATE_LIMIT` HTTP 429; one generation attempt. | TOOL_CALL_REQUIRED, empty completion, retry storm. | Offline | closed rate limit |
| PB25 | Transport | HTTP 200 with zero-byte body stream. | `STREAM_INCOMPLETE`/502 with `causeCode=empty_stream`. | Empty successful final. | Offline | D3 |
| PB26 | Transport | Partial content then `INCOMPLETE` or EOF without FINISHED. | Explicit incomplete error; parent not accepted. | Partial final or parent advancement. | Offline | D2,D3 |
| PB27 | Transport | Headers arrive; body stalls beyond deadline. | Abort reader/fetch within deadline; cleanup complete. | Hang or background body continuation. | Offline | D3 |
| PB28 | Transport | Anthropic stream starts, then upstream/guard fails. | Valid downstream error/terminal contract and closed response. | Bare socket truncation/hang/double terminal. | Offline integration | D4,D8,D15b |
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
| G2 | `npm test` 100% green | PASS: 904/904 on D15b closure branch; full-control Windows run (recheck release commit) |
| G3 | `npm run build` green | PASS (recheck each branch) |
| G4 | `npm run test:platform` green | PASS on current Windows baseline |
| G5 | CI Windows/Linux/macOS green for release commit | NEEDS RELEASE-COMMIT VERIFICATION |
| G6 | Все P0 закрыты | PASS: D2/D3/D4/D6 CLOSED; open P0 = 0 |
| G7 | Все P1 закрыты либо formally waived с owner/reason/expiry | PASS: D5/D7/D8/D9/D17 CLOSED; open P1 = 0 |
| G8 | 100% deterministic offline PB cases automated and green | FAIL: PB-v1 пока specification |
| G9 | 3 последовательных clean live benchmark runs | FAIL |
| G10 | 3 × 30–50 tool autonomous runs без fabrication/replay/duplicate/malformed leak/unexpected 502/hang | FAIL |
| G11 | Rate limit → retryable `DEEPSEEK_RATE_LIMIT`/429 без guard storm | PASS offline; preserve in live |
| G12 | Любой upstream failure bounded; нет hang/fake success | PASS: D3/D4 CLOSED; bounded upstream failure и downstream SSE error contract подтверждены deterministic tests и Windows live verification |
| G13 | Restart сохраняет консистентные persistent session/lineage | PASS: deterministic PB31/PB33 green; Windows Claude Code restart сохранил session и использовал persisted lineage |
| G14 | `/compact` после long chain проходит PB35 | NEEDS FROZEN LIVE RUNS |
| G15 | Shutdown не оставляет orphan/stale PID и не убивает чужие процессы | NEEDS VERIFICATION: D10 |
| G16 | Нет известных открытых P0/P1 production defects | PASS: open P0 = 0, open P1 = 0 |

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

1. **D6 — persistence collision.** CLOSED после independent review и Windows
   Claude Code live restart/resume verification; сохранять regressions.
2. **D3 — upstream stream lifecycle.** CLOSED после independent review и
   Windows direct/Claude Code live verification; сохранять regressions.
3. **D4 — downstream Anthropic SSE lifecycle.** CLOSED после independent review,
   deterministic PB28 и Windows Claude Code/controlled failure live verification;
   сохранять regressions.
4. **D2 — rejected parent isolation.** CLOSED после PB29/PB30, independent
   review и Windows Claude Code normal/tool-cycle live verification.
5. **D5 — lineage freshness/TTL.** CLOSED после PB31/PB32, independent review
   и Windows persisted-lineage restart verification; сохранять regressions.
6. **D7 — tool catalog consistency.** CLOSED после deterministic coverage,
   independent review и Windows 39-tool / available #33 `WebFetch` live.
7. **D8/D16 — observability/correlation.** CLOSED после deterministic coverage,
   independent review и Windows Claude Code Bash live verification.
8. **D9** — CLOSED после deterministic PB02/PB05 coverage и live verification
   RU typo / EN concrete listing / informational control. **D11** — CLOSED после
   full-schema deterministic coverage, independent review и Windows WebFetch
   live. **D12** — CLOSED после deterministic coverage, independent review и
   Windows `AskUserQuestion` live. **D13** — CLOSED после deterministic coverage,
   independent review и Windows 3 Write + 3 Read live; collateral D17 не
   переоткрывает D13.
9. **D17 — false command_execution obligation.** CLOSED после deterministic
   coverage, independent review и Windows 39-tool 3 Write + 3 Read live.
10. **D14** — CLOSED после deterministic normalization/prompt-boundary coverage
    и independent review; live не требуется для доказанного boundary. **D15b**
    CLOSED после deterministic coverage, independent review и Windows real
    Claude Bash/tool-result live. **D15a** остаётся capability-unresolved P2.
11. **D10**, затем полный PB-v1, 30–50-tool stress, `/compact`, restart/resume.
12. **D1** — повторный controlled A/B/C только после стабилизации остальных причин.

## 11. Repository consistency findings

| Finding | Resolution in this plan |
| --- | --- |
| `PROJECT_STATE.md` фиксирует green feature phases, но не содержит единого списка подтверждённых P0/P1 release blockers. | Этот файл становится hardening source of truth; общий feature status не равен production readiness. |
| `docs/architecture.md` заявлял retries для HTTP 429/temporary 5xx, но completion retry мог дублировать generation. | D3 PASS B: completion POST выполняется один раз; typed retryable error передаёт решение caller-у, challenge сохраняет bounded retry. |
| `SESSION_LINK_TTL_MS=10m`, а `LineageStore` hardcodes 24h и не проверяет age при lookup. | D5 CLOSED: единый TTL применяется при lookup/init/mutations; PB31/PB32 и Windows persisted-lineage restart verification PASS. |
| Документация отмечала sibling-safe только `lineage.clear()`, тогда как normal writers перезаписывали разные shapes. | D6 CLOSED: единый schema-v2 owner, deterministic tests и Windows Claude Code live restart/resume green. |
| Tool allowlist мог содержать 39, а prompt silently описывал 32. | D7 CLOSED: count truncation удалён; deterministic catalog identity и Windows live с реальным available #33 `WebFetch` — PASS. D11 также CLOSED: полный schema transport, bounded catalog preflight, independent review и Windows WebFetch live — PASS. |
| Anthropic system array, output limit и streaming usage не покрыты текущими normalize/lifecycle tests. | D14 CLOSED. D15 разделён: D15b exact-or-unavailable usage CLOSED после review/live; D15a output-limit capability остаётся unresolved без guessed Web field. |
| D1 A/B/C evidence отсутствует в repo и доступен только как diagnostic handoff. | D1 остаётся unconfirmed/deferred. |

## 12. Current decision

Проект **не является Production Ready**. D6, D3, D4, D2, D5, D7, D8, D9, D11,
D12, D13, D14, D15b и D17 закрыты после требуемой deterministic coverage, independent
review и, где это требовалось, релевантной Windows live verification. Открытых
P0 — 0, P1 — 0, P2 — 2;
deferred P3 — 1. G6, G7 и G16 пройдены; остальные defects и release gates
остаются открытыми. D15b имеет статус `CLOSED`, D15a — `OPEN / CAPABILITY
UNRESOLVED`. D15b live verdict — `PASS WITH COLLATERAL FINDING`: отдельная
guard/client activity не переоткрывает usage work.

D11 имеет статус `CLOSED`: implementation `cd0b335` прошла independent review,
а Windows Claude Code 2.1.241 / `deepseek-v4-flash` live выполнил настоящий
`WebFetch(https://example.com)`, получил 559 bytes/200 и завершился `Example
Domain` без parse/schema/unexpected-502/hang failures. Malformed/no-parent repair
остаётся только deterministic offline evidence и не заявляется live-tested.
D12 имеет статус `CLOSED`: implementation `e237562` прошла independent review,
а Windows Claude Code 2.1.241 / `deepseek-v4-flash` live выполнил настоящий
`AskUserQuestion` с one-object `questions` array и nested `Alpha`/`Beta` options;
выбор `Alpha` вернулся реальным `tool_result` и завершился final `Alpha` без
unsafe/guard-exhaustion/unexpected-502/hang failures. Exact raw argument
preservation остаётся deterministic offline evidence и не заявляется live-tested.
D13 — `CLOSED`: implementation `0293f4a` прошла independent review. Windows
live реально выполнил три отдельных `Write`, затем три отдельных `Read`; все
шесть requested tool results были получены. PowerShell независимо подтвердил
`d13-a.txt = D13-MARKER-A`, `d13-b.txt = D13-MARKER-B` и
`d13-c.txt = D13-MARKER-C`. Verdict — `PASS WITH COLLATERAL FINDING`: target
behavior D13 прошёл, но весь request не был clean.

D17 / P1 — `CLOSED`: implementation `d3d57de` прошла independent review.
Windows Claude Code 2.1.241 / `deepseek-v4-flash` live с real 39-tool catalog
получила все 3 Write + 3 Read results; каждый requested cycle завершился при
`completion_attempt=1` / `guard_attempt=0`, а final `D17-LIVE-PASS` был принят
сразу после последнего Read без Bash, missing `command_execution` или 502.
External PowerShell подтвердил exact A/B/C markers. Отдельный post-final Bash
имел `lineage_source=new`, `history_entries=0` и другой `upstream_ref`, поэтому
не относится к D17 request chain. D17 независим от D13 action-group inference и
не переоткрывает D13.

D9 live verification выполнялась с реальным 39-tool Claude catalog и подтвердила
PB02/PB05 scope. Во второй части наблюдались upstream `DEEPSEEK_RATE_LIMIT`, один
`STREAM_INCOMPLETE` и дополнительные guard retries. Это collateral/upstream noise,
не D9 regression; classifier, guard и transport в closure commit не менялись.

Отдельный D7 live collateral finding не относится к catalog consistency:
первая streaming-попытка дала `completion_guard_rejected` с
`malformed_tool_intent=true` и `TOOL_CALL_REQUIRED`/502; retry Claude Code
успешно выполнил `WebFetch`. Guard/repair не менялся, D7 не переоткрывался.

Отдельный collateral observation, не относящийся к D5/lineage: live prompt
`Write-Output D5-LIVE` получил `completion_guard_rejected` с
`missing_obligation_kinds=["file_mutation"]` и `TOOL_CALL_REQUIRED`/502. Это
classifier/obligation false-positive; он не исправлялся в D5 и не переоткрывает
lineage work.
