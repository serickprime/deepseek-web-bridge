# Production Readiness

> **Статус:** `RC.2 LIVE/REVIEW PASS; AWAITING EXACT-SHA CI; R10 NOT STARTED`
>
> **Published RC.1:** tag `v1.0.0-rc.1` → `f3dd11733582effb02486a954b0e4022cc350d65` (immutable; GUI-launch tool discovery blocker confirmed)
>
> **Offline baseline:** 38 test files, 1229 tests
>
> **Открыто:** P0 — 0, release-blocking P1 — 0 after RC.2 independent review and Windows GUI acceptance; tracked P2 — 2; deferred P3 — 1
> **Production scope:** Claude Code → Anthropic-compatible Bridge → DeepSeek Web → Bridge → Claude Code

Этот файл — главный источник production-hardening backlog, frozen benchmark и
release gates. `PROJECT_STATE.md` остаётся общим состоянием проекта. Перед
работой над defect разработчик обязан прочитать `AGENTS.md` и этот документ.

## v1.0 Release Policy / Exit Criteria

Проект находится в режиме `RELEASE HARDENING / SCOPE FREEZE FOR v1.0`.
Приоритет — стабилизация существующего Claude Code → Anthropic-compatible
Bridge → DeepSeek Web contract. Новые функции, providers, UI-возможности,
архитектурные рефакторинги и unrelated fixes не входят в release scope без
отдельного решения.

### Release-blocker classification

Finding блокирует v1.0 только при доказанном outcome: неверный или лишний tool
execution; потеря/повреждение пользовательских данных; security/privacy defect;
fabrication/replay/duplicate action; неверная `tool_use`/`tool_result`/session/
lineage correlation; reproducible unexpected 5xx/502; hang/deadlock/unbounded
retry; crash; потеря заявленного session/persistence state; regression закрытого
P0/P1 contract; либо невозможность нормально использовать основной supported
Claude Code workflow.

Linguistic edge cases, cosmetic/observability issues, unsupported wording,
deferred provider/UI work и архитектурные улучшения по умолчанию относятся к
backlog v1.1. Они становятся blockers только при доказанном outcome выше.

До production change обязательны deterministic reproduction, по возможности
A/B с known-good revision и разделение introduced regression / pre-existing
collateral. Existing tests не ослабляются ради green. Для P0/P1 сохраняется
цепочка implementation → full regression → independent read-only review →
runtime live acceptance при необходимости → closure. Один defect остаётся в
одном primary layer с минимальным production diff.

### Supported v1.0 contract

Primary client — Claude Code; primary protocol — Anthropic Messages API
compatible flow; upstream — DeepSeek Web. Обязательный runtime scope: normal
text, `Write`, `Read`, `Edit`, `Bash`, sequential/multi-step tool cycles,
корректная `tool_use`/`tool_result` correlation, bounded malformed-tool repair,
persistence/restart/resume, graceful shutdown, `/compact` и normal long-session
use. OpenCode, дополнительные providers и новые UI-возможности не являются
release blockers вне явно заявленного scope.

### Release path after D18

R1 D18 independent review → R2 D18 Windows live → R3 pre-merge core acceptance
(text/Write/Read/Edit/Bash/multi-step/shutdown) → R4 PB-v1 deterministic
acceptance → R5 30–50 tool stress runs → R6 `/compact` → R7 restart/resume/
persistence → R8 final full regression + release documentation → R9 v1.0 RC →
R10 v1.0. Пройденный этап не повторяется без regression evidence.

R1 — `PASS`. R2 — `PASS`. D18, D19 и D20 — `CLOSED`. D10 — `PASS`, PB39 —
`PASS 3/3`. Narrow pronominal content-verification fix и R5 heading-target fix
integrated в master; Anthropic required-usage compatibility follow-up integrated
как `67ce7ab` и текущим finding не переоткрывается. Новый подтверждённый R5 P1
находится в L2 inference: frozen single-file `Create → Verify → Edit → Verify`
ранее давал три mutations и zero verification, из-за чего safe D19 admission
отклонял intermediate Read. Узкий implementation формирует ровно четыре ordered
target-specific obligations и distinct initial/final evidence. Focused R5 13/13,
D19 17/17, D13 47/47, D18 140/140, f676 9/9; full 1141/1141; independent
read-only review — `PASS`.
R5 и R6 впоследствии прошли release acceptance и имеют статус `PASS / CLOSED`.
D22/D23/D24 abandoned changes не входят в baseline. Targeted D21 capture не
подтвердил production defect и остаётся monitoring item.

Current release state supersedes the historical paragraphs above. R5, R6 and R7
are `PASS / CLOSED`. R7 persistence/lineage restart acceptance completed after
the narrow L2 launch-literal fix masked quoted filename/value data only for
launch inference while preserving genuine complete-token launch/restart actions.
The fix passed 18 new regressions, focused 117/117, full 1159/1159, independent
narrow review and required Windows live acceptance, then was fast-forwarded as
`551325ac21620835af399b6cf1edd25cfd17915c`.

R8 and G8 evidence is now current-baseline and executable. PB01–PB33 + PB39 map
to deterministic tests, 34/34 PASS; the authoritative suite and
`npm run test:pbv1` pass 38 files / 1228 tests. PB06 target-aware absence
verification accepts only a fresh successful correlated exact-target
`test ! -e`, while failed/stale/historical/wrong-target/arbitrary Bash evidence
remains rejected. Independent review and exact Windows Claude Code 2.1.241 live
both PASS. The bounded post-change R8 live also passed text,
Write→Read→Edit→fresh Read, Bash bounded recovery and same-session continuation
without guard exhaustion, unexpected 502/429, schema error, replay/duplicate or
hang/crash. D22/D23/D24 were not restored. G5 candidate CI run `33394395478`
passed Windows, Ubuntu and macOS on exact integrated SHA
`36ae0810acbb55dfa447621a7ebd39aca4054de0`. R8 is closed. R9 is also
`PASS / CLOSED`: clean source install, clean AUTH, Claude Code acceptance,
restart sanity, independent review and exact-SHA cross-platform CI all passed.
Annotated tag `v1.0.0-rc.1` remains fixed at
`f3dd11733582effb02486a954b0e4022cc350d65`, and its GitHub pre-release is
published. Final stable v1.0.0/R10 is not started or authorized.

### v1.0 RC exit criteria

- open P0 = 0 и open release-blocking P1 = 0;
- full tests и platform tests green;
- core live, stress, `/compact`, restart/resume и shutdown acceptance green;
- в supported flow нет reproducible unexpected 502/hang;
- известные P2/P3 перечислены в backlog/known limitations.

`Production Ready` означает отсутствие известных release blockers в supported
v1.0 contract, а не отсутствие вообще любых bugs. После closure D18 действует
stop rule: не продолжать бесконечный поиск искусственных linguistic forms, а
перейти к release acceptance и классифицировать новые findings по этой policy.
Structured obligation planner/shadow mode остаются backlog v1.1.

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
| Fabricated text никогда не считается `tool_result`. | Да для поддержанного scope | D9 CLOSED для environment listing; D18 CLOSED и блокирует allowed `[调用 Tool] {...}` как malformed intent. |
| Historical `tool_result` не подтверждает новое действие. | Да | L2 current-cycle guard и D5 L3 correlated selection защищены deterministic tests; D5 CLOSED. |
| Mutation нельзя считать успешной без подходящего evidence. | Да для D13 scope | D13 CLOSED: 1–5 target/same-kind deterministic coverage. D18 CLOSED и сохраняет отдельную fresh verification после unambiguous pronominal Write→Read. |
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
| **D10** | P2 | L1 / platform | `PASS / INTEGRATED` | `app.stop()` — единый idempotent coordinator: server close, owned CLI/native process и auth Chrome cleanup выполняются конкурентно в пределах 10 s; success требует confirmed target termination. Windows exact-PID tree kill, Unix runner/launcher confirmation и macOS exact window helper bounded 5 s / 2 s; unconfirmed ownership сохраняется и даёт typed `SHUTDOWN_INCOMPLETE`. | `TEST`: 40 net-new regressions; focused lifecycle 76/76. Final independent re-review PASS. `LIVE`: Windows desktop PB39 PASS 3/3; D18 collateral L2 failure не относится к shutdown ownership и не инвалидирует PB39. D10 + D18 chain fast-forward integrated into master before R3. | D8 telemetry | `2c2e082e742b5cfdd7fe19098fd517d3702f0dce` |
| **D11** | P2 | L2 | `CLOSED` | Каждый available occurrence описан полным compact lossless `JSON.stringify(inputSchema)`; initial/no-parent repair используют один catalog. 128 KiB UTF-8 preflight fail-closed выполняется до session/upstream/stream exposure, без truncation или content logging. | `TEST`: independent review PASS; 23 focused cases; PB14/PB17/PB18 root/nested/array/enum/`oneOf`/`$defs`, Unicode, round-trip, exact 131072/+1, dynamic 25/30/34/38/40, Artifact/Tool33+, D7 compatibility и D12 boundary control; 35 files / 799 tests. Measurements: max observed catalog 51183, entry 4073; projected 71548 leaves 59524 bytes. `LIVE`: Windows, Claude Code 2.1.241, `deepseek-v4-flash`; real `WebFetch(https://example.com)` получил 559 bytes/200 и final `Example Domain`, без parse/schema/unexpected-502/hang failures. Malformed/no-parent repair live не заявляется. | D7 single catalog; D12 отдельно | `cd0b3357eff07dc6cb171228853fac622fac8f51` |
| **D12** | P2 | L2 | `CLOSED` | Nested arrays проходят existing recursive safety inspection до plain-object rejection; root arguments остаётся plain object, а dangerous keys/depth/size/allowlist/malformed controls сохранены. | `TEST`: independent review PASS; 18 focused D12 regressions в `tools.test.ts` для primitive/empty/object/nested arrays, exact CanonicalToolCall, no-retry client, Anthropic handler exposure, root-array/depth/pollution/unknown/malformed controls; D11 array-schema transport green; 35 files / 817 tests. `LIVE`: Windows, Claude Code 2.1.241, `deepseek-v4-flash`; real `AskUserQuestion` с one-object `questions` array и nested `Alpha`/`Beta` options, user selected `Alpha`, real `tool_result` continuation и final `Alpha`, без unsafe/guard-exhaustion/unexpected-502/hang failures. Exact raw arguments live не заявляются. | D11 schema contract | `e237562bfb43d782b64eeb9673e0d5eba6abdbe8` |
| **D13** | P2 | L2 | `CLOSED` | Independent create/edit/read action-target groups получают stable per-kind instances для 1–5 targets; explicit grouped operation остаётся одной obligation, ambiguous fallback сохраняет все targets. | `TEST`: 34 D13 cases; create/edit/read 1–5, partial/failure, mixed, grouped, same-file three-step/twice, Unicode/NFC, historical/stale/informational и root client guard; 35 files / 851 tests. `LIVE`: independent review PASS; Windows получил 3 separate Write + 3 separate Read results, PowerShell подтвердил exact A/B/C markers. Verdict: PASS WITH COLLATERAL FINDING — D17 вмешался только в final path. | Existing one-to-one matcher; D9/D12 controls | `0293f4a5a128766a535d3bf285252abe65e56fd8` |
| **D14** | P2 | L1 | `CLOSED` | Anthropic top-level `system` сохраняет string точно либо соединяет ordered text-block array одним `\n`; malformed/unsupported supplied shape fail closed как `INVALID_REQUEST`/400. | `TEST`: 17 regressions для exact string/1/3 blocks/order/whitespace/Unicode/empty/absent/metadata/malformed shapes, OpenAI control, HTTP Anthropic error envelope и captured DeepSeek prompt без raw system JSON; 35 files / 891 tests; independent review PASS. Live не требуется: deterministic normalization/serialization и exact downstream prompt boundary доказаны напрямую, а Claude Code 2.1.241 не подтверждён как sender array shape. | Нет; D15 отдельно | `1f2f17267272e97d5941741d5767cc2e6e3de760` |
| **D15a** | P2 | L1 / L4 | `OPEN / CAPABILITY UNRESOLVED` | Anthropic `max_tokens` нормализуется, но для внутреннего DeepSeek Web completion protocol не подтверждено enforceable output-limit field; guessed field запрещён. | `LIVE DIAGNOSTIC`: Claude Code 2.1.241 отправляет `max_tokens=32000`; актуальный Web payload/frontend не показал `max_tokens`, `max_new_tokens`, `max_output_tokens` или иной доказанный limit field. Downstream truncation не доказана безопасной для SSE/tool/terminal contract. | Отдельная capability verification | — |
| **D15b** | P2 | L1 / L4 | `CLOSED; NON-STREAM COMPAT FOLLOW-UP CLOSED` | `CanonicalResult.usage` сохраняет exact-only provenance; V4 cumulative counter остаётся отдельно. Streaming сохраняет exact-or-unavailable semantics. Successful non-stream Anthropic Message всегда имеет usage: exact split unchanged либо deterministic Bridge estimate обеих сторон при absent/partial split. | `TEST`: historical implementation `a4c43a222be14e4513923b3d9525398cb616980a`; required-usage follow-up focused D15b/bd620/D3/D4/f676 733/733, full 36 files / 1128 tests, independent review PASS. Exact capture/replay A/B с Claude Code 2.1.241 подтвердил omission как blocker; follow-up integrated как `67ce7ab` и текущим L2 finding не переоткрывается. Genuine exact zero сохраняется; unknown не кодируется hardcoded `0/0`; custom provenance наружу не выходит. | D3 terminal semantics; D4 downstream lifecycle; L2 unchanged | `a4c43a2`, `67ce7ab` |
| **D17** | P1 | L2 | `CLOSED` | Один shared narrow predicate требует explicit command wording, conservative recognizable CLI literal либо явный Bash/shell/PowerShell/terminal context; generic `Выполни ...` action/file wording не создаёт `command_execution`. | `TEST`: 23 D17 regressions; focused 436/436, full 35 files / 874 tests; independent review PASS. `LIVE`: Windows, Claude Code 2.1.241, `deepseek-v4-flash`, real 39-tool catalog; 3 Write + 3 Read results, каждый requested cycle `completion_attempt=1` / `guard_attempt=0`, immediate `D17-LIVE-PASS`, no Bash/missing command/502, external marker verification PASS. Отдельный new-lineage/empty-history/different-upstream post-final Bash не относится к D17 chain. | D13 CLOSED | `d3d57de901ba3b07afeb27aa634054b8c1092f2f` |
| **D18** | P1 | L2 / L1 | `CLOSED` | Single unambiguous mutation target переносится в последующую affirmative executable pronominal file verification (`этот файл`, `этот же файл`, `that file`, `the same file`, `it`). Один D18-local classifier отклоняет negated/explanatory/conditional/optional/alternative/meta verification и mutation candidates. Conditional creation нового distinct target непосредственно перед Read даёт fail-safe ambiguity; более поздняя mandatory mutation может восстановить однозначный referent. Raw allowed `[调用 Tool] {...}` не может стать final и требует canonical repair. | `REVIEW`: fourth independent review PASS. `TEST`: D18 focused 126/126, historical guard selection 347/347, tools 563/563, full 36 files / 1070 tests; typecheck/test/build/test:platform/diff-check PASS. `LIVE`: isolated Windows Claude Code 2.1.241 выполнил real Write result → Read → Read result → `PREMERGE-WRITE-READ-OK`; filesystem `premerge-a.txt = PREMERGE-A-731`; correlation/auth/shutdown PASS, no unexpected 5xx/502, hang/crash или raw marker leak. Minor/pre-existing collateral остаётся backlog v1.1. | D13/D17 guards; closed, do not fuzz without release-blocking evidence | `2fe10373f093e319e5c0fa67a8009c46cd134d08` |
| **D19** | P1 | L2 | `CLOSED` | Exact R3-C create→Edit→Read inference сохраняет две distinct mutations и final verification. Tool names в filename/meta wording не создают actions; semantic admission разрешает только genuinely missing/stale obligations, поэтому новый call ID не replay-ит fulfilled Write/Edit/Read; later mutation делает verification stale и требует fresh Read. | `TEST`: 17 D19 regressions; exact inference, root client flow, redundant Write/Edit/Read rejection, stale/fresh verification, explicit repeated actions и historical guard protections; focused tools 580/580, full 36 files / 1087 tests. `REVIEW`: independent review PASS. `LIVE`: isolated Windows Claude Code 2.1.241 выполнил ровно `Write` → `Edit` → `Read` → `R3-EDIT-OK` (counts 1/1/1); filesystem exact `BETA-731`, correlation/auth/shutdown PASS, без duplicate execution, unexpected 5xx/502, hang/crash или raw marker leak. | Closed; reopen only with regression evidence | `07103f58140c6d4a2f6e9a5d49d3eab846b2b33a` |
| **D20** | P1 | L2 | `CLOSED` | Length-preserving masking одного recognized Bash/command payload применяется ко всем стадиям natural-language file verification: broad regex, verification action groups и file-path extraction. Исходный текст остаётся для `command_execution`, а prose/targets вне payload сохраняются. Exact R3-D и command-local `stdout.write`/`fs.readFileSync`/read-like tokens не создают false file obligations. | `TEST`: 17 D20 regressions; focused 17/17, tools 597/597, full 36 files / 1104 tests; typecheck/build/Windows test:platform/diff-check PASS. `REVIEW`: independent re-review PASS. `LIVE`: exact Windows R3-D на isolated Claude Code 2.1.241 вывел только `command_execution`; один Bash, `is_error=false`, exit zero, exact stdout `R3-BASH-731`, затем exact final `R3-BASH-OK`; без guard retry, 5xx/502 или hang/crash; shutdown/auth integrity PASS. D21 targeted capture не воспроизвёл более ранний второй Bash и не установил production defect. | Closed; D19/D17 regression-protected; monitor D21 observation in R5 | `a8800ba`, `005eebb` |

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
| D18 | `CLOSED`: unambiguous pronominal Write→Read сохраняет separate verification evidence; allowed `[调用 Tool]` никогда не попадает final и только boundedly repair-ится в canonical call. Ambiguous referent остаётся unresolved без guessed target. | Exact RU/EN, mutation-only/Read-result progression, historical/failed/stale, multi-target ambiguity, direct marker variants/negatives, root exhaustion и Anthropic no-leak/repaired exposure; R1/R2 PASS. | PB08, PB13–PB15, PB20 |
| D19 | Exact R3-C даёт create + required Edit + final Read; fulfilled action не исполняется повторно из-за guard retry, а later mutation требует fresh Read. | Deterministic semantic-admission matrix, independent review и exact Windows R3-C live chain без duplicate execution. | PB08, PB13, PB20 |
| D20 | Explicit Bash/command payload не создаёт unrelated natural-language file obligations; prose вне payload сохраняется. | Exact R3-D, stdout/console/read-write-edit/echo/redirection controls, explicit file+Bash, root successful Bash result; затем independent review и exact Windows R3-D live. | R3 |

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
| PB08 | Mutation | Two additive clauses on same file, then verify. | Mutation(s) + fresh Read containing both markers. | Destructive false-positive; stale Read. | Offline + live | closed guard, D18 |
| PB09 | Mutation | Two obligations of same kind with distinct targets/values. | One-to-one evidence binding. | Evidence reuse across instances. | Offline | D13 |
| PB10 | Mutation | First mutation fails; model retries identical then corrected action. | Identical failure executes once; changed action may succeed. | Duplicate mutation, empty final, fake success. | Offline + live | D2,D13 |
| PB11 | Verification | Run deterministic test fixture with pass/fail variants. | Real test command; correct pass/fail report. | `--version` as evidence; masked failed summary accepted. | Offline + live | closed guard |
| PB12 | Verification | Start temp HTTP server and GET health. | Launch result followed by fresh HTTP 200 evidence. | Launch alone proves health; broad kill. | Offline + live | D10 |
| PB13 | Verification | Verify state, mutate, then final; include historical prior result. | New verification after mutation; old result ignored. | Stale/historical evidence accepted. | Offline + live | D2,D5,D18 |
| PB14 | Tool protocol | Normal tool with full nested schema and Anthropic system blocks. | Exact described/allowed schema; real tool_use/result. | Dropped system/schema; raw JSON final. | Offline | D7,D11,D12,D14,D18 |
| PB15 | Tool protocol | Malformed JSON call with bad escape, then valid repair. | Bounded retry → real tool_use or explicit failure. | Raw malformed syntax, guessed backslash repair. | Offline + live | D12, closed parser, D18 |
| PB16 | Tool protocol | Executable pseudo-XML invoke+parameter. | Bounded canonical retry. | Pseudo-XML final/execution. | Offline | closed parser |
| PB17 | Tool protocol | Valid tool call appears in reasoning only. | Same allowlist/schema checks and tool_use output. | Reasoning leak or unvalidated execution. | Offline | D7,D11 |
| PB18 | Tool protocol | Model requests unknown/34th+ tool. | Unknown rejected; every advertised supported tool is described. | Execution outside allowlist; silent catalog mismatch. | Offline | D7,D11 |
| PB19 | Tool protocol | tool_result has wrong/unknown call ID. | Explicit correlation failure/new safe session policy. | Result attached to unrelated action/session. | Offline | D5,D8 |
| PB20 | Tool protocol | 5+ sequential mixed tools. | Ordered unique IDs/results; correlated telemetry. | Missing/reordered/replayed action. | Offline + live | D7,D8,D18 |
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
| G1 | `npm run typecheck` green | PASS: current verified candidate |
| G2 | `npm test` 100% green | PASS: 38 files / 1228 tests, failures 0 |
| G3 | `npm run build` green | PASS: current verified candidate |
| G4 | `npm run test:platform` green | PASS: current Windows candidate |
| G5 | CI Windows/Linux/macOS green for release commit | PASS: run `33394395478` passed `windows-latest`, `ubuntu-latest` and `macos-latest` on exact candidate `36ae0810acbb55dfa447621a7ebd39aca4054de0` |
| G6 | Все P0 закрыты | PASS: D2/D3/D4/D6 CLOSED; open P0 = 0 |
| G7 | Все P1 закрыты либо formally waived с owner/reason/expiry | PASS: R7 launch-literal blocker integrated/live-accepted; open release-blocking P1 = 0 |
| G8 | 100% deterministic offline PB cases automated and green | PASS: executable PB01–PB33 + PB39 mapping 34/34; `npm run test:pbv1` 1228/1228 |
| G9 | 3 последовательных clean live benchmark runs | PASS: R5 qualifying runs 3/3 |
| G10 | 3 × 30–50 tool autonomous runs без fabrication/replay/duplicate/malformed leak/unexpected 502/hang | PASS: R5 CLOSED, qualifying runs 3/3 |
| G11 | Rate limit → retryable `DEEPSEEK_RATE_LIMIT`/429 без guard storm | PASS: bedcab29 deterministic/live evidence retained; R8 critical regression green |
| G12 | Любой upstream failure bounded; нет hang/fake success | PASS: D3/D4 CLOSED; bounded upstream failure и downstream SSE error contract подтверждены deterministic tests и Windows live verification |
| G13 | Restart сохраняет консистентные persistent session/lineage | PASS: deterministic PB31/PB33 green; R7 Windows restart/resume/persistence acceptance CLOSED |
| G14 | `/compact` после long chain проходит PB35 | PASS: R6 real Claude Code `/compact` acceptance CLOSED |
| G15 | Shutdown не оставляет orphan/stale PID и не убивает чужие процессы | PASS: D10 final independent re-review и Windows desktop PB39 PASS 3/3; D18 не относится к lifecycle |
| G16 | Нет известных открытых P0/P1 production defects | PASS: open P0 = 0, open release-blocking P1 = 0 within supported v1.0 scope |

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
11. **D18** — CLOSED: R1 fourth independent review PASS; R2 isolated Windows
    Claude Code 2.1.241 Write→Read live PASS.
12. **D10 + D18 integration** — завершена fast-forward; D10 review и PB39 3/3
    остаются PASS. R3 выявил D19 и отдельный D20.
13. **D19** — CLOSED после independent review и exact R3-C Windows live с
    единственной цепочкой Write→Edit→Read. **D20** — CLOSED после independent
    re-review и exact R3-D Windows live с одним успешным Bash. R3 A/B/C/D —
    PASS; R4 готов к запуску. D21 duplicate-Bash observation не воспроизведён и
    переносится только в monitoring R5.
14. **D1** — повторный controlled A/B/C только после стабилизации остальных причин.

## 11. Repository consistency findings

| Finding | Resolution in this plan |
| --- | --- |
| `PROJECT_STATE.md` фиксирует green feature phases, но не содержит единого списка подтверждённых P0/P1 release blockers. | Этот файл становится hardening source of truth; общий feature status не равен production readiness. |
| `docs/architecture.md` заявлял retries для HTTP 429/temporary 5xx, но completion retry мог дублировать generation. | D3 PASS B: completion POST выполняется один раз; typed retryable error передаёт решение caller-у, challenge сохраняет bounded retry. |
| `SESSION_LINK_TTL_MS=10m`, а `LineageStore` hardcodes 24h и не проверяет age при lookup. | D5 CLOSED: единый TTL применяется при lookup/init/mutations; PB31/PB32 и Windows persisted-lineage restart verification PASS. |
| Документация отмечала sibling-safe только `lineage.clear()`, тогда как normal writers перезаписывали разные shapes. | D6 CLOSED: единый schema-v2 owner, deterministic tests и Windows Claude Code live restart/resume green. |
| Tool allowlist мог содержать 39, а prompt silently описывал 32. | D7 CLOSED: count truncation удалён; deterministic catalog identity и Windows live с реальным available #33 `WebFetch` — PASS. D11 также CLOSED: полный schema transport, bounded catalog preflight, independent review и Windows WebFetch live — PASS. |
| Anthropic system array, output limit и usage не покрыты текущими normalize/lifecycle tests. | D14 CLOSED. D15a output-limit capability остаётся unresolved без guessed Web field. D15b streaming exact-or-unavailable и non-stream required-usage compatibility follow-up CLOSED после deterministic/review/live evidence. |
| D1 A/B/C evidence отсутствует в repo и доступен только как diagnostic handoff. | D1 остаётся unconfirmed/deferred. |

## 12. Current decision

Integrated candidate `36ae0810acbb55dfa447621a7ebd39aca4054de0`
прошёл все R8 gates: G8 current-baseline evidence, executable PB-v1 mapping
34/34, PB06 deterministic/review/live evidence и G5 Windows/Linux/macOS CI run
`33394395478` — PASS. R8 закрыт. R9 `v1.0.0-rc.1` также `PASS / CLOSED`:
tested RC commit `f3dd11733582effb02486a954b0e4022cc350d65` прошёл clean install,
AUTH/Claude/restart acceptance, independent review и exact-SHA CI run
`33398844646`, после чего был опубликован как annotated tag и GitHub
pre-release. R10 final stable v1.0.0 is not started or authorized.
D22/D23/D24 не переносились.
D6, D3, D4, D2, D5, D7, D8, D9,
D11, D12, D13, D14, D15b, D17, D18, D19 и D20 закрыты после требуемой
deterministic coverage, independent review и, где требовалось, Windows live.
R5/R6/R7 — `PASS / CLOSED`; D10 final independent re-review и Windows desktop
PB39 PASS 3/3 сохранены. Launch-literal blocker интегрирован в master
`551325ac21620835af399b6cf1edd25cfd17915c` и live-accepted в R7.

Open P0 = 0 и open release-blocking P1 = 0; G1–G16 — PASS.
Tracked P2 = 2:
D10 остаётся `PASS / INTEGRATED` для v1.0 с residual real macOS/Linux GUI
shutdown coverage, а D15a — `OPEN / CAPABILITY UNRESOLVED` без invented DeepSeek
Web output-limit field. D1 — unconfirmed/deferred P3. D21 не подтверждён как
production defect и после successful R5 не является v1.0 blocker. D15b live
verdict `PASS WITH COLLATERAL FINDING` не переоткрывает usage contract.

R8 evidence: authoritative full and PB-v1 suites 38 files / 1228 tests, all
mandatory local gates, exact-candidate cross-platform CI run `33394395478`,
executable 34/34 PB mapping,
PB06 independent review and exact targeted live PASS. Post-change bounded
Windows live on isolated Claude Code 2.1.241 passed text,
Write→Read→Edit→fresh Read, Bash bounded recovery and same-session continuation
with exact final file `R8-FINAL-731`; correlation remained correct and guard
exhaustion, unexpected 502/429, schema rejection, replay/duplicate and hang/crash
were absent. R8 and R9 are `PASS / CLOSED`; release candidate
`v1.0.0-rc.1` is available for testing. The tag remains on the tested RC tree
even though this later docs-only closure commit follows it on the release
branch. R10 final stable v1.0.0 remains `NOT STARTED`.

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

D18 / P1 — `CLOSED`: production implementation
`2fe10373f093e319e5c0fa67a8009c46cd134d08` прошла fourth independent review
`PASS`. Focused D18 126/126, historical guard selection 347/347 и full
1070/1070 — PASS. R2 Windows live на isolated Claude Code 2.1.241 подтвердил
real `Write tool_use` → `Write tool_result` → `Read tool_use` →
`Read tool_result` → final `PREMERGE-WRITE-READ-OK`; filesystem содержал
`premerge-a.txt = PREMERGE-A-731`. Correlation, auth integrity и shutdown sanity
прошли; unexpected 5xx/502, hang/crash и raw marker leak отсутствовали. D18
больше не является v1.0 release blocker; новые linguistic probes не запускаются
без нового доказанного blocker outcome. Structured obligation planner и
minor/pre-existing collateral остаются backlog v1.1.

D19 / P1 — `CLOSED`: PASS A подтвердил pre-existing combined semantic-admission
defect; implementation `07103f58140c6d4a2f6e9a5d49d3eab846b2b33a` и
independent review — PASS. Full baseline — 1087/1087. Exact R3-C Windows live
на isolated Claude Code 2.1.241 выполнил ровно `Write tool_use/result` →
`Edit tool_use/result` → `Read tool_use/result` → final `R3-EDIT-OK`; counts
Write/Edit/Read = 1/1/1, filesystem exact `BETA-731`. Duplicate execution,
unexpected 5xx/502, hang/crash и raw marker leak отсутствовали; correlation,
auth integrity и shutdown — PASS. D19 больше не блокирует v1.0; D20 также
закрыт после отдельной independent re-review и exact R3-D live цепочки.

D20 / P1 — `CLOSED`:
PASS A подтвердил pre-existing L2 defect, где `process.stdout.write` внутри
explicit Bash payload ошибочно создавал `file_mutation`. Узкий fix маскирует
только распознанный command payload для file-intent inference, не скрывая prose
вне него и не меняя command detection. Exact R3-D теперь выводит одну
`command_execution`; successful Bash-result root control принимает final без
guard retry/502. Первый independent review выявил, что verification regex/action
groups/path extraction ещё видели raw payload; follow-up применяет тот же masked
boundary и к ним. 17 D20 regressions; full baseline 1104/1104; independent
re-review — PASS. Exact R3-D Windows live на isolated Claude Code 2.1.241 дал
только `command_execution`: один correlated Bash result с `is_error=false`,
exit zero и exact stdout `R3-BASH-731`, после чего exact final `R3-BASH-OK` был
принят без guard retry, unexpected 5xx/502 или hang/crash; shutdown и auth
integrity — PASS. D17/D19 contracts остаются regression-protected.

D21 — `NOT CONFIRMED / NO PRODUCTION DEFECT ESTABLISHED`: один более ранний
R3-D run показал два Bash, но targeted evidence capture exact supported flow
это не воспроизвёл. Первый matching Bash успешно закрыл `command_execution`,
второй Bash не был admitted, final принят сразу. Root прежнего наблюдения не
установлен; без reproducible Bridge defect оно не блокирует v1.0 и мониторится
только в последующих R5 stress runs.

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
