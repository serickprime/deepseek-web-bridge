# Состояние проекта

> **Актуально на:** 2026-08-24.
> Этот файл — главный источник правды о стадии проекта. Любой агент обязан
> прочитать его перед началом работы и обновить после внесения изменений.
> Обязательный порядок чтения перед задачей: `AGENTS.md` → `PROJECT_STATE.md`
> → `docs/architecture.md` → `docs/threat-model.md`.

## Кратко

**DeepSeek Web Bridge** — локальный HTTP-мост, который превращает вашу
авторизованную веб-сессию `chat.deepseek.com` в локальный API, совместимый с
OpenAI Chat Completions, OpenAI Responses и Anthropic Messages. Основные клиенты:
Claude Code, OpenCode, любой OpenAI-совместимый SDK.

**Текущий активный фокус:** production-hardening цепочки Claude Code →
Anthropic-compatible Bridge → DeepSeek Web. Единый audit backlog, frozen
benchmark и release gates находятся в [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md).
OpenCode, новые providers и новые UI-функции deferred до прохождения gates.

**Текущий production status:** `HARDENING IN PROGRESS`, не `PRODUCTION READY`.
D6 persistence collision закрыт после independent review, deterministic offline
coverage и реальной Windows Claude Code restart/resume проверки. D3 upstream
stream lifecycle закрыт после independent review и Windows live verification;
D4 downstream Anthropic lifecycle также закрыт после independent review,
deterministic PB28 coverage и Windows live verification. D2 rejected-parent
isolation закрыт после PB29/PB30, independent review и Windows Claude Code
live verification. D5 lineage freshness/current-cycle selection закрыт после
independent review, deterministic PB31/PB32 и ограниченной Windows restart/live
verification. Открытых P0 больше нет; G6 — PASS. D7 tool catalog consistency
закрыт после independent review, deterministic coverage и Windows live
verification 33+ production path. D8 safe request correlation закрыт после
independent review, deterministic coverage и Windows Claude Code live tool-cycle;
D9 natural directory listing classifier закрыт после deterministic coverage и
live verification RU typo / EN concrete listing / informational control. Открытых
P1 — 0. Остальные
приоритеты и gates — в
`PRODUCTION_READINESS.md`. D11 full schema transport закрыт после deterministic
offline coverage, independent review и Windows Claude Code live WebFetch. D12
nested-array parser ordering исправлен offline и имеет статус
`IMPLEMENTED / VERIFYING`; independent review и Windows live ещё нужны.
D1 остаётся неподтверждённой/deferred P3.

Проект использует **неофициальные** внутренние маршруты веб-сайта DeepSeek
(`/api/v0/chat/completion`), требует PoW (sha3 через WASM) и живую авторизованную
сессию. DeepSeek может менять внутренние API — проект рассчитан на периодическое
обновление.

## Ключевая цель / что должно получиться

Рабочая цепочка «из коробки»:

1. Скачать ZIP, распаковать и запустить `START.bat`, `START.command` или
   `DeepSeek Web Bridge.desktop`. Dependency-free bootstrap проверяет Node/npm,
   при первом запуске выполняет install + build, запускает Bridge и открывает Web UI.
2. Нажать AUTH, войти в DeepSeek (вручную, CAPTCHA/2FA) и сохранить
   `data/auth.json` (token + cookie + опциональные hif-заголовки, права 0600).
3. Выбрать рабочую папку и запустить Claude Code/OpenCode из Bridge Console.
4. Для ручного/developer-сценария остаются `npm run auth`, `npm run doctor` и
   `npm start`; клиенты подключаются:
   - Claude Code: `ANTHROPIC_BASE_URL=http://127.0.0.1:9655`,
     `ANTHROPIC_AUTH_TOKEN=local-key`, модель `deepseek-v4-flash` или
     `deepseek-v4-pro`;
   - OpenCode: временный provider из дочернего process env, модель
     `deepseek-bridge/deepseek-v4-flash` или
     `deepseek-bridge/deepseek-v4-pro`; глобальный config не меняется;
   - любой OpenAI-клиент: `http://127.0.0.1:9655/v1`.
5. `npm run test:live` — live-проверка проходит (health, models, chat, messages).

## Архитектура (кратко)

Три слоя (детали — `docs/architecture.md`):

```
Клиенты → [серверный слой: node:http, middleware, CORS/API-key, request_ref]
        → [протокольный слой: normalize → CanonicalRequest → adapters + SSE]
        → [DeepSeek-слой: auth → сессии → PoW (WASM) → completion → SSE-парсер]
        → chat.deepseek.com
```

Каталоги:
- `src/config/` — константы и загрузка конфига из env / `.env`.
- `src/utils/` — errors, crypto, json, redaction, atomicFile (Windows-safe: skip chmod on win32), logger, tokenEstimate, sessionCreateLimiter.
- `src/auth/` — менеджер сессий-«ключей» (sid cookies), файловое хранилище.
- `src/sessions/` — upstream-состояние, mutex, identity-resolver, lineage.
- `src/api/` — canonical, нормализация трёх протоколов, handler.
- `src/tools/` — tool prompt, безопасный парсер tool_call, retry.
- `src/deepseek/` — PoW (WASM), SSE/update парсеры, upstream-клиент.
  `parentMessageId` — number (uint32), парсится через `parseMessageId()`.
- `src/server/` — HTTP-сервер, middleware, адаптеры вывода, SSE-обрамление.
- `scripts/` — dependency-free desktop bootstrap, auth (CDP), doctor, launcher,
  start, live-тест.
- `tests/unit/` — vitest, offline (без обращения к DeepSeek).

## Статус по фазам

| Фаза | Содержимое | Статус |
| --- | --- | --- |
| 1. Каркас | package.json, tsconfig×2, vitest.config, .gitignore, .env.example, README, SECURITY, docs | ✅ готово |
| 2. Утилиты | errors, crypto, json, redaction, atomicFile, logger, tokenEstimate | ✅ готово |
| 3. Auth | session, storage, sessionManager | ✅ готово |
| 4. Sessions | sessionStore, mutex, sessionResolver, lineage | ✅ готово |
| 5. API | canonical, normalizeOpenAI/Anthropic/Responses, handler | ✅ готово |
| 6. Tools | toolPrompt, toolParser, toolRetry | ✅ готово |
| 7. DeepSeek | pow (WASM), sseParser, updateParser, client | ✅ готово |
| 8. Server | middleware, output-адаптеры, protocolStream, routes, server | ✅ готово |
| 9. Entrypoint | app.ts, index.ts, start.ts | ✅ готово |
| 10. Тесты | 35 файлов, 817 тестов | ✅ готово |
| 11. Скрипты | desktopStart, cdp, auth, doctor, launcher, live, real-OS platform smoke | ✅ live-часть работает |
| 12. Веб-интерфейс | Bridge Console на `GET /` (Mileo dark theme, two-panel, diagnostics, model picker) | ✅ готово |

**Проверки сейчас:**
- `npm run typecheck` — ✅ без ошибок.
- `npm run build` — ✅ собирается.
- `npm test` — ✅ 817/817 (Windows process-lifecycle case требует разрешённый
  `taskkill`; sandbox-only запуск отдельно воспроизводит известный D10 finding).
- `npm run test:platform` — ✅ локально на Windows: real process/platform,
  `buildConfig`, Bridge HTTP, Unicode cwd и env propagation без DeepSeek auth.
- `npm run auth` / Web UI AUTH — ✅ Bearer захватывается из сети, HIF читается из
  localStorage при наличии; отсутствие HIF допустимо только после успешной upstream-верификации.
- `npm run doctor` — ✅ все 6/6 проверок проходят (auth, reachable, challenge,
  pow solved, completion SSE parsed, completion content).
- `npm run test:live` — ✅ все проверки проходят (health, models, chat/completions,
  messages).

## Что уже реализовано (детали)

### Production-hardening control document — 2026-08-23

- `PRODUCTION_READINESS.md` является главным источником production audit
  backlog, architecture invariants, frozen PB-v1 benchmark и бинарного
  Definition of Production Ready. Этот файл сохраняет общий feature/live
  status и не дублирует подробные acceptance criteria.
- Production scope заморожен на Claude Code + Anthropic compatibility +
  DeepSeek Web. Для каждого defect обязателен отдельный PASS A (diagnosis only)
  и только после review — отдельный PASS B implementation branch.
- PB-v1 содержит 39 неизменяемых сценариев. Статус `PRODUCTION READY` запрещён,
  пока открыты P0/P1 либо не пройдены release gates и повторяемые live/stress
  runs. D6 persistence collision и D3 upstream stream lifecycle закрыты после
  independent review и Windows live verification.
- D6 PASS B реализован как один `PersistentSessionDocument` schema v2 для
  `sessions` и `links`: legacy v1 мигрируется, unknown siblings сохраняются,
  invalid/future-version документы fail closed, а FIFO очередь исключает
  lost-update между in-process writers. Оба store делегируют owner-у, который
  инициализируется до HTTP listen; durable write failures не маскируются.
- Atomic JSON write использует уникальный temp, cleanup и recoverable Windows
  `.bak` fallback. Multi-process locking не входит в утверждённый scope.
- PB31/PB33 и дополнительные migration/failure/startup regressions покрыты 23
  новыми tests; текущий suite — 28 test files / 574 tests. Independent review
  завершён. Windows live с Claude Code 2.1.241 и `deepseek-v4-flash` подтвердил:
  после real Bash cycle `sessions.json` v2 содержал sessions=1 и links=2;
  restart восстановил session, а следующий real tool-cycle использовал
  persisted lineage (`upstream_linked:true`). D6 — `CLOSED`; PB31 и релевантные
  persistence-инварианты PB33 live verification — PASS, controlled concurrency/
  crash часть PB33 остаётся подтверждённой deterministic offline tests.
- D7 PASS B устранил silent 33+ catalog mismatch: `buildToolPrompt()` больше
  не обрезает `available` после 32 и описывает все tools, которые остаются
  разрешены parser/handler после case-insensitive фильтрации `Artifact`.
  Исходный порядок, duplicates и 1000-char description cap сохранены. На этапе
  D7 schema representation оставалась top-level-only; D11 PASS B позднее
  заменила её полным compact JSON без изменения D7 membership contract. 17
  focused regressions
  покрывают 0/1/32/33/35/39, Artifact positions, ordering/duplicates, 33+
  handler `tool_use`, continuation и unknown rejection. PB14 подтверждает
  только catalog identity, PB18 — 34th+/unknown, PB20 — catalog stability;
  D8 telemetry и D11 full nested schema fidelity намеренно не менялись самим D7.
  Independent review — PASS; implementation `b09067e`. Windows live с Claude
  Code 2.1.241 и `deepseek-v4-flash` получил 39 tools: `Artifact` received #2
  был unavailable, поэтому available catalog содержал 38; `WebFetch` received
  #34 / available #33 стал первым tool за прежним cap. Реальный
  `Fetch(https://example.com)` получил 559 bytes (HTTP 200), завершился
  `Example Domain`, а `tool_result` continuation использовал
  `upstream_linked:true` и дошёл до `completion_done`. PB14 catalog identity,
  PB18 34th+/unknown и PB20 catalog stability — PASS; D11 schema fidelity
  позднее закрыта отдельной реализацией, D8 теперь `CLOSED`. D7 — `CLOSED`.
- D11 PASS B формирует один authoritative full-schema catalog после того же
  case-insensitive `Artifact` filtering: каждое available occurrence содержит
  полный compact `JSON.stringify(inputSchema)`, round-trip проверяется без
  потерь, а schema не обрезается. Tool order, duplicates и 1000-char tool
  description cap сохранены. Initial prompt и guard-repair без гарантированного
  repair-candidate parent получают один и тот же catalog; parser validation и
  отдельный, на тот момент pending D12 nested-array defect не менялись самим D11.
- Dynamic catalog имеет preflight budget 128 KiB / 131072 UTF-8 bytes до
  session creation, upstream и downstream `stream.start()`. Превышение даёт
  typed `REQUEST_TOO_LARGE`/413. Measurements: 25 tools — 37802 bytes, 30 —
  43375, 34 — 51183; largest entry — 4073. Envelope
  `51183 + 5×4073 = 71548` оставляет 59524 bytes headroom; exact historical
  39/38 size не заявляется. 23 focused D11 tests покрывают PB14/PB17/PB18,
  exact limit/+1 и D7/D12 controls. Implementation
  `cd0b3357eff07dc6cb171228853fac622fac8f51` прошла independent review.
  Windows live с Claude Code 2.1.241 и `deepseek-v4-flash` подтвердил настоящий
  `WebFetch(https://example.com)`: `tool_result` получил 559 bytes (HTTP 200),
  final — `Example Domain`, без `TOOL_PARSE_FAILED`, schema rejection,
  unexpected 502 или hang. D11 — `CLOSED`; malformed/no-parent repair path
  остаётся подтверждён только deterministic offline evidence. D12 реализуется
  отдельно и не переоткрывает D11 transport contract.
- D12 PASS B устраняет только недостижимый array traversal в
  `inspectNestedValues()`: `Array.isArray()` теперь предшествует plain-object
  rejection, после чего каждый element проходит прежнюю recursive safety
  inspection. Root `arguments` остаётся plain object; dangerous keys, depth 32,
  48 KiB, unknown-tool и malformed JSON проверки не ослаблены. 18 focused tests
  покрывают nested-array matrix, exact CanonicalToolCall/Anthropic `tool_use`,
  no-retry DeepSeekClient path и security controls; D11 array-schema transport
  остаётся green. D12 — `IMPLEMENTED / VERIFYING`, independent review и Windows
  live ещё обязательны; open P2 остаётся 5.
- D8 PASS B передаёт уже существующий request-scoped logger явно по всей цепочке
  route → handler → DeepSeek client → PoW. Один случайный process-local salt и
  domain separation создают необратимые `client_ref`, `upstream_ref`,
  `chat_ref`, `call_ref`; refs стабильны только внутри процесса. Raw identity,
  upstream/chat/call IDs, prompts, tool args/results, auth data и arbitrary
  exception messages не входят в telemetry.
- Lifecycle events содержат отдельные `completion_attempt` и `guard_attempt`,
  transport attempt где применимо, `stage`, `latency_ms`, typed outcome/failure,
  `history_entries` и `parent_state: none|accepted|repair_candidate`. Tool flow
  логирует только безопасное имя tool и opaque call ref; per-SSE-chunk events
  отсутствуют. Logger derivatives теперь сохраняют configured LogLevel.
  Focused offline suite покрывает PB20/PB24/PB28/PB34 correlation scope,
  concurrency isolation и redaction. Independent review — PASS; implementation
  `6987ae5`. Windows live с Claude Code 2.1.241 и `deepseek-v4-flash` реально
  выполнил Bash `pwd` и вернул `/d/Проекты/test`: один `request_ref` прошёл
  L1–L4, safe `tool_name` присутствовал, а `call_ref`, `upstream_ref` и
  `chat_ref` совпали через linked tool-result continuation. Guard retry показал
  `completion_attempt=2`, `guard_attempt=1`, `parent_state=repair_candidate`;
  raw marker/identity/upstream/call/chat IDs и tool payloads в логах отсутствовали.
  Opaque refs остаются process-local, cross-restart stability не заявляется.
  D8 — `CLOSED`; PB20/PB24/PB28/PB34 telemetry scope — PASS; открытых P1 — 1.
- D9 PASS B остаётся внутри существующего `looksLikeEnvironmentDataRequest()`:
  узкий concrete-directory-listing matcher покрывает natural RU/EN phrasing,
  включая explicit typo stem `дериктор...`, и переопределяет generic `what is`
  только для конкретного запроса содержимого directory/folder/catalog. Broad
  `находится/лежит/есть` и fuzzy matching не добавлены. 75 regressions покрывают
  direct A–L, PB05 informational/unrelated negatives, full completion guard,
  реальные Bash/Glob/ListDirectory calls, fresh/historical current-cycle
  evidence и отсутствие impossible requirement без listing-capable tool.
  PB02/PB05 deterministic scope — PASS. Live verification на implementation
  `5a5b755e96b6dc965d6013c53a163259473c510d` получила от Claude Code 39 tools:
  exact RU typo request вызвал real Bash `tool_use`, lineage связала `tool_result`
  с тем же upstream, и final completion был принят после fresh result. EN
  `what is inside the current folder?` также вызвал real tools, а informational
  directory control завершился обычным text final без listing evidence. D9 —
  `CLOSED`; открытых P1 — 0. Во второй части live run наблюдались upstream
  `DEEPSEEK_RATE_LIMIT`, один `STREAM_INCOMPLETE` и дополнительные guard retries;
  они зафиксированы как collateral/upstream noise, не как D9 regression, и в этой
  docs-only closure не исправлялись.
- Отдельный D7 live collateral finding не относится к catalog consistency:
  первая streaming-попытка дала `completion_guard_rejected` с
  `malformed_tool_intent=true` и `TOOL_CALL_REQUIRED`/502; retry затем успешно
  выполнил `WebFetch`. Guard/repair в этой docs-only closure не менялся.
- D3 PASS B ввёл explicit upstream terminal classification: new `FINISHED` и
  old `response_message_done` — единственные success terminals, `INCOMPLETE` —
  failure. Empty HTTP 200 и EOF до terminal дают `STREAM_INCOMPLETE`/502;
  malformed supported update даёт non-retryable `STREAM_PARSE_FAILED`/502.
- `DS_TIMEOUT_MS` теперь покрывает completion headers, body reads, parsing,
  terminal и cleanup. FINISHED прекращает чтение без EOF; success делает
  cancel/release без abort, failure/timeout — abort + best-effort cancel/release.
  Completion POST выполняется ровно один раз; challenge JSON body также bounded,
  но безопасный challenge retry сохранён. T1–T21 и PB22–PB27 покрыты 26 новыми
  focused cases. Independent-review regression T16b дополнительно подтверждает,
  что never-settling/rejected `reader.cancel()` после authoritative terminal не
  заменяет success на timeout/error, не abort-ит controller и не мешает
  `releaseLock()`. Текущий suite — 29 files / 601 test. D2 parent acceptance и
  D4 downstream lifecycle намеренно не менялись.
- D3 Windows live verification: Claude Code 2.1.241, `deepseek-v4-flash`,
  `DS_TIMEOUT_MS=120000`. Direct short completion вернул `D3-LIVE-OK`; long
  completion вернул 6600 chars за 21853 ms. Реальный Claude Code Bash `pwd`
  завершил tool-cycle, последующие запросы использовали persisted lineage
  (`upstream_linked:true`), normal generations завершались `completion_done`.
  Unexpected `UPSTREAM_TIMEOUT`, `STREAM_INCOMPLETE`, `STREAM_PARSE_FAILED` и
  `UPSTREAM_ERROR` не наблюдались; релевантная PB22–PB27 live verification PASS.
  D3 — `CLOSED`; D4 также закрыт после отдельной проверки, D2 остаётся открытым.
- D4 PASS B реализовал Anthropic-only lazy HTTP commit: pre-`message_start`
  failure возвращает настоящий HTTP error в Anthropic JSON envelope, а
  post-start failure — ровно один `event:error` с безопасной официальной
  taxonomy. `ProtocolStream` теперь имеет mutually-exclusive success/error
  terminal, не пишет после terminal и не превращает partial content в fake
  completed Message. Все обязательные lineage records выполняются до
  публикации `tool_use`, поэтому persistence failure не экспонирует executable
  block. T1–T26 дают deterministic route/protocol coverage PB28, включая
  timeout/rate-limit/incomplete/partial/persistence/unknown/pre-start cases,
  normal Anthropic text/tool и OpenAI/Responses controls. Independent review и
  Windows live verification implementation commit
  `b16307b0c59586709475aaeac312172e53771573` подтвердили D4: реальный Claude
  Code 2.1.241 Bash `pwd` вернул `/d/Проекты/test`, normal generations дали
  `completion_done`, persisted lineage использовалась с
  `upstream_linked:true`. Controlled stalled challenge при
  `DS_TIMEOUT_MS=700` дал typed `UPSTREAM_TIMEOUT`/504 и видимый Claude Code
  `API Error`, без fake success. Raw PB28 midstream case дал HTTP 200,
  `message_start` и один `event:error` (`timeout_error`) без `message_delta` и
  `message_stop`. Lazy commit подтверждён pre-stream offline coverage,
  persistence-before-exposure и lineage ordering — T21/T22; terminal
  exclusivity подтверждена offline и live. Suite — 30 files / 627 tests; D4 —
  `CLOSED`. D3 остаётся `CLOSED`; D2/D5/D7/D8 не менялись. Claude Code прислал
  39 tools — только evidence для будущего D7.
- D4 collateral findings не расширялись: malformed `/v1/messages` JSON пока
  остаётся safe HTTP 500 вместо 400, а downstream disconnect не отменяет
  upstream operation. Последнее сохраняется как отдельный cancellation/resource
  lifecycle finding; defensive closed-writer regression добавлен без redesign.
- D2 PASS B изолировал rejected DeepSeek parent candidates: `runCompletion()`
  принимает явный request parent и возвращает candidate ID, не меняя shared
  session state. `complete()` локально ведёт repair-chain и публикует только ID
  окончательно принятой generation — после terminal, parsing, guard, callback и
  финальной auth-generation проверки. Failure/exhaustion сохраняют прежний
  accepted parent; successful no-ID result его не меняет. PB29/PB30 защищены 19
  focused tests, включая transport failures, next-request parent и handler
  history. Implementation commit — `bc6d0aec8da2579c463d84c3e44cdcc61e175407`;
  independent review PASS. Baseline: 31 test files / 646 tests, typecheck, build,
  Windows `test:platform` и `git diff --check` PASS. Windows live с Claude Code
  2.1.241 и `deepseek-v4-flash` подтвердил normal turn `D2-TURN-1` и real Bash
  `pwd` → `/d/Проекты/test`; tool-result continuation сохранил upstream key и
  показал `upstream_linked:true`, без `SESSION_CONFLICT`, `STREAM_INCOMPLETE`,
  unexpected 502 или hang. Exact rejected-parent isolation подтверждается
  deterministic PB29/PB30; live logs exact parent IDs не экспонировали. D2 —
  `CLOSED`; open P0 = 0, G6 — PASS. Проект не объявляется production-ready:
  P1/P2 и остальные release gates остаются открытыми.

- D5 PASS B устранил stale lineage selection без изменения D6 ownership:
  `LineageStore` применяет единый `SESSION_LINK_TTL_MS`, считает возраст
  `<= TTL` валидным и `> TTL` expired, проверяет freshness при каждом lookup,
  durably prune-ит persisted links при init и prune-ит siblings на каждой
  awaited mutation. Lookup удаляет expired mapping только из памяти; следующий
  awaited mutation либо restart делает cleanup durable, без fire-and-forget
  write. Commit failure остаётся fail-closed и откатывает локальное состояние.
  Handler собирает current-cycle `tool_use` IDs после последней независимой
  user-инструкции и reverse-scan выбирает только newest matching `tool_result`,
  поэтому historical/orphan results не связывают новый action cycle. Fresh
  header/correlated-result mappings разрешаются независимо: одинаковые
  продолжают session, разные дают `SESSION_CONFLICT`/409, unknown/expired header
  fallback-ится к fresh result; explicit body identity сохраняет precedence.
  PB31/PB32 и protocol regressions покрыты 26 новыми deterministic tests;
  baseline — 32 files / 672 tests, typecheck/build/Windows test:platform/
  diff-check PASS; implementation commits — `3614d4b` и `051e3ec`, independent
  review PASS. Windows live на Claude Code 2.1.241 и `deepseek-v4-flash`
  подтвердил clean stop/restart Bridge: первая post-restart continuation
  восстановила тот же persisted upstream key, показала `upstream_linked:true` и
  дошла до `completion_done`. Исходный Bash `tool_result` уже создавал linked
  request до restart, поэтому не заявляется, что его первое поступление было
  только после restart. D5 — `CLOSED`; открытых P1 остаётся 3.

- Отдельный collateral live finding не относится к D5/lineage: prompt с
  `Write-Output D5-LIVE` был отклонён completion guard с
  `missing_obligation_kinds=["file_mutation"]` и `TOOL_CALL_REQUIRED`/502.
  Это classifier/obligation false-positive; в D5 он не исправлялся и lineage
  work не переоткрывает.

- Нормализация всех трёх протоколов в единый `CanonicalRequest`; tool calls,
  tool results, system prompt, reasoning/search флаги, max_tokens.
- PoW: загрузка/кэш WASM, решение DeepSeekHashV1 через wasm_solve, заголовок
  `x-ds-pow-response` (base64-encoded JSON).
- SSE: накопитель парса чанков, парсер update-событий нового формата
  `{ v: { response: { fragments: [...] } } }` (инкрементальный контент)
  с **THINK/RESPONSE разделением**: fragment type определяет маршрут
  (`"THINK"` → `reasoningDelta`, `"RESPONSE"` → `delta`), APPEND события
  наследуют тип последнего snapshot-фрагмента. plain token deltas
  `{ v: "text" }`, fragment appends, и
  `{ p: "response/status", o: "SET", v: "FINISHED" }` (терминальное).
  Старый формат `{ data: { type: "...", message: { content: "..." } } }`
  сохранён как fallback. **Класс `DeepSeekPatchParser`** с инстансным
  состоянием (currentPath, currentOp, fragments[], status) — каждый
  `runCompletion()` создаёт свой экземпляр, нет модульного глобального state.
  Bare `{v:"text"}` продолжает предыдущий APPEND через persisted
  `currentPath`/`currentOp`. FINISHED/INCOMPLETE фильтруются.
- Upstream-клиент: создание `chat_session_id`; completion POST без auto-retry
  (typed retryable errors caller-у), bounded retry только для безопасного PoW
  challenge; 401/403 → отдельные ошибки; абсолютный headers+body deadline и
  abort/cancel/release cleanup.
  `prompt` заполняется из системного промпта или последнего user-сообщения;
  `messages` содержат `id` + `content_type`. Детекция JSON-ошибок от upstream.
  **Session create limiter**: не более 1 нового chat_session раз в 2 секунды
  (`SESSION_CREATE_INTERVAL_MS`), конкурентные вызовы сериализуются через
  promise-chain. Continuation (existing `chatSessionId`) проходит без лимитера.
  Модель выбирается через единый V4 registry: Flash/Instant отправляет
  `model_type:"default"`, Pro/Expert — `model_type:"expert"`; Thinking и Search
  передаются отдельными boolean-полями. Текущий Web payload использует
  `action:null`/`preempt:false` и не содержит старый `model_name`.
- Сессии: `SessionStore` (история с лимитами), `KeyedMutex` (последовательность
  для одной upstream-сессии), `SessionResolver` (client identity vs upstream
  identity), `LineageStore` (связь call-id → upstream-сессия в sessions.json).
- Сервер: роутинг, middleware (API key, CORS, лимит тела, request_ref),
  SSE-вывод для трёх протоколов, JSON-вывод для non-streaming (no-op
  ProtocolStream вместо null), `/health`, `/readyz`, `/v1/models`,
  `/v1/sessions` (CRUD), `/v1/chat/completions`, `/v1/responses`,
  `/v1/messages`, `GET /api/system`, `/bridge/pick-folder`, `/bridge/logout`,
  `/bridge/shutdown`.
  `/bridge/logout` — локальный выход из DeepSeek: удаляет `auth.json` и dedicated
  Chrome profile, очищает runtime auth и account-bound upstream state/lineage,
  но оставляет HTTP Bridge и запущенные через Web UI Claude Code/OpenCode работать.
  Для удаления используется async `fs.promises.rm`: на Windows с Node 24.12
  `fs.rmSync` молча не удалял targets под кириллическим путём репозитория.
  `/bridge/shutdown` останавливает только tracked CLI-процессы, активный auth Chrome,
  HTTP-сервер и затем Node process; credentials не удаляются. Активный AUTH сначала
  отменяется внутренним AbortController, чтобы graceful stop не ожидал открытый SSE бесконечно.
  `RouteContext.gracefulStop` прокидывается из `AppHandle.stop`.
  **ProtocolStream.start()** — вызывается из CompletionHandler перед
  `stream.push()`, отправляет `message_start` для Anthropic streaming и первым
  SSE write фиксирует lazy HTTP 200. До него route сохраняет возможность вернуть
  настоящий HTTP error. `finish()` и `fail()` являются idempotent mutually-
  exclusive terminals; после terminal новые writes игнорируются.
  **Anthropic content_block lifecycle** — текст отправляется как
  `content_block_start(text) → content_block_delta(text_delta) → content_block_stop`.
  Tool use включает `input: {}`. `textBlockOpen` флаг предотвращает
  дублирование. `closeTextBlock()` вызывается перед любым другим блоком
  или при `finish()`.
- Веб-интерфейс: Bridge Console на `GET /` в стиле Mileo (dark theme) — почти
  чёрный фон (#020101), красные акценты (#FD1000), two-panel layout
  (Connection + Session), статусные LED-точки, model picker из `/v1/models`,
  Working Directory input с platform-aware folder picker: Windows PowerShell
  FolderBrowserDialog (UTF-8/Base64 transport и filesystem-validated mojibake
  fallback), macOS `osascript`, Linux `zenity` → `kdialog` → ручной ввод;
  общий 3-состоятельный результат path/cancelled/unsupported. UI получает
  backend capabilities через `GET /api/system`, всегда сохраняет ручной input,
  показывает платформу и отключает неподдержанные действия. Windows сохраняет
  live-проверенный launch; macOS открывает Terminal.app через `osascript`; Linux
  выбирает `x-terminal-emulator` → `gnome-terminal` → `konsole` →
  `xfce4-terminal` → `kitty` → `xterm`,
  кнопки запуска Claude Code / OpenCode, кнопки LOGOUT (локально удаляет auth + profile,
  не останавливая Bridge/CLI) и отдельная SHUTDOWN (останавливает tracked CLI,
  auth Chrome и Bridge), toggleable diagnostics terminal с имитацией проверок,
  toast notifications. Статические файлы `GET /assets/*` (PNG, CSS, JS) с
  path-traversal protection. Публичные пути: `/`, `/health`, `/readyz`,
  `/assets/*` (GET).
  Model selector показывает только `deepseek-v4-flash` и `deepseek-v4-pro`.
  OpenCode запускается с process-local provider `DeepSeek Bridge` и явным
  `deepseek-bridge/<selected-model>`, не меняя пользовательский global config.
- Безопасность: redaction секретов в логах, 0600 для auth/sessions файлов (Unix; на Windows без chmod для совместимости с NTFS),
  loopback-проверка + PROXY_API_KEY для не-loopback, CORS по умолчанию только
  loopback, ограничение глубины/размера tool аргументов, защита от
  `__proto__`/`prototype`/`constructor`.
  `checkAuthStatus()` и diagnostics передают `x-hif-leim`/`x-hif-dliq` из auth.json
  при наличии (camelCase + legacy fallback) во все upstream-запросы.
  `DeepSeekClient` поддерживает runtime `setAuth()`/`clearAuth()`; успешный Web UI
  AUTH применяет новые credentials без рестарта. Generation guard отклоняет
  завершившиеся после смены аккаунта старые upstream-запросы.
- Скрипты: `auth` (CDP, читает hif_leim из localStorage), `doctor` (6 последовательных
  чеков + реальный completion-запрос), `launcher` (меню), `live/run` (account
  live-test), `platformSmoke` (изолированный real-OS CI smoke без DeepSeek auth).
  `scripts/desktopStart.mjs` использует только built-in Node API и является общей
  логикой one-click launch: Node/npm preflight, первый `npm install`, stale/missing
  dist build, duplicate-server health guard, startup health wait и browser open.
  Тонкие `START.bat`, `START.command`, `START.sh` только находят корень и обрабатывают
  отсутствие Node до запуска bootstrap; Linux `.desktop` передаёт собственный путь
  через freedesktop `%k` отдельным аргументом.

## Исследование: tool calling в других проектах

Обзор GitHub проектов (2026-08-17):

- **`deepseek-bridge`** (PyPI, `breixopd/deepseek-bridge`) — прокси для
  официального API (`api.deepseek.com`). Исправляет missing `reasoning_content`
  в tool-call цепочках. **Использует API-ключ, не web API.**
- **`cursor-deepseek`** (`danilofalcao/cursor-deepseek`) — Go-прокси для
  Cursor IDE. **Использует API-ключ DeepSeek/OpenRouter.**
- **`deepseek-proxy`** (PyPI) — трансляция OpenAI Responses API → Chat Completions.
  **Использует официальный API.**
- **`MikM32/Deepseek-API-Opencode`** — единственный проект, использующий
  web API. Prompt-based tool calling с `<param>` форматом. Наша текущая
  реализация основана на нём.
- **`Reasoning-Content-Proxy`** — генерирует фейковый reasoning_content для
  совместимости с Claude Code.
- **`opencode-pi`** — CLI-мост через `opencode run`, prompt-based tools.

**Вывод**: Все стабильные проекты используют **официальный API** с ключом.
Web API (`chat.deepseek.com`) ненадёжно для tool calling.

**Ключевое**: `deepseek-chat` и `deepseek-reasoner` deprecated (с 2026-07-24).
Текущие модели: `deepseek-v4-flash` и `deepseek-v4-pro`. Live CDP capture
2026-08-20 подтвердил Web mapping: Instant=`model_type:"default"`,
Expert=`model_type:"expert"`; `thinking_enabled` независим для обеих моделей,
Search доступен в Instant и отсутствует в Expert UI. Upstream response оставляет
`response.model` пустым, поэтому Bridge не отправляет выдуманный `model_name`.

Production live-test текущей V4-интеграции 2026-08-20 подтвердил на одном
работающем Bridge: Claude Code Flash → `FLASH-LIVE-731`, Claude Code Pro →
`PRO-LIVE-482`; Flash Bash `pwd` прошёл как настоящий `tool_use`/`tool_result` и
вернул `/d/test CC NODE`. OpenCode process-local provider перечислил только
`deepseek-bridge/deepseek-v4-flash` и `deepseek-bridge/deepseek-v4-pro`, а
реальный Flash completion вернул `OPENCODE-LIVE-517` (exit code 0). Глобальный
OpenCode config не изменялся.

### Claude Code action completion integrity — 2026-08-20

- `Artifact` исключён из фактического DeepSeek tool allowlist/prompt как
  недоступный через Bridge/`ANTHROPIC_AUTH_TOKEN`. Остальные tools, включая
  `Skill`, `Read`, `Write`, `Edit` и `Bash`, остаются доступными.
- Guard находит последний текстовый user request, рассматривает только
  последующие коррелированные `tool_use`/`tool_result` и различает success/error.
  Historical results и compact/history не являются evidence нового action.
- Для file mutation, command execution, launch и dependency install нужны
  соответствующие успешные results. Create и launch проверяются раздельно;
  successful Write не доказывает launch. Bash redirection может подтвердить
  file creation, а `start`/`open`/server command — launch.
- `is_error:true` явно передаётся DeepSeek как `status:error` и не выполняет
  action requirement. Ложный success после failed/missing result получает
  bounded retry; честный failure разрешён. Artifact retry предлагает перейти
  к доступным Write/Edit/Bash и не включает Artifact в allowed names.
- Offline: 22 новых regression cases, итого 440/440 tests. Корневые тесты через
  `DeepSeekClient.complete()` подтверждают реальную фильтрацию initial prompt,
  retry после Artifact error и rejection text-only «готово».
- Production live, исходный prompt «сделай небольшой красивый лендинг на
  произвольную тему и потом запусти его»: `Write(index.html)` success →
  `Bash(start index.html)` success → final. Artifact не вызывался; Skill был
  доступен, но модель его не выбрала. `index.html` существует (14 951 байт),
  содержит HTML/body; Chrome открыл окно с title
  `MindfulSpace — медитация и осознанность`.
- Failure live: `Bash(false)` возвращал `is_error:true`; модель не заявила
  «готово»/успех. Она повторила failed call пять раз и завершила пустым final;
  это исходное наблюдение закрыто отдельным repeated-failure guard ниже.

### Repeated failed tool-call guard — 2026-08-21

- Для каждого коррелированного `tool_use` → `tool_result is_error:true` после
  последнего текстового user request сохраняется fingerprint: точное имя tool +
  рекурсивно key-sorted JSON arguments. Для Bash служебный `description` не
  участвует в fingerprint, поскольку Claude Code меняет его между вызовами, но
  он не меняет исполняемое действие; `command`, `timeout` и остальные
  execution-поля остаются значимыми.
- Повтор failed fingerprint не возвращается Claude Code как новый `tool_use`.
  Bridge делает не более трёх upstream completion attempts и требует другой
  tool, исправленные arguments либо честный непустой failure. При исчерпании
  попыток возвращается `TOOL_CALL_REQUIRED`, а не пустой final.
- Cycle начинается с последнего текстового user message без `tool_result`.
  Поэтому historical/compact failures и предыдущая пользовательская задача не
  блокируют новый явный запрос «попробуй эту команду ещё раз». Successful
  results не добавляются в failed fingerprints.
- Offline: 11 новых regression cases; итого 451/451 tests.
- Windows production live через Claude Code 2.1.238 в `D:\test CC NODE`:
  точный `Bash(command:"false")` реально исполнился один раз в одном request;
  неизменный повтор клиенту не выдавался, изменённые executable commands были
  разрешены, final остался непустым и честно описал exit code 1. Отдельный
  recovery прошёл `Bash(false)` → error result →
  `Bash(printf RECOVERY-OK-482)` → successful result → final
  `RECOVERY-OK-482`.

### Malformed tool-call recovery — 2026-08-21

- Повреждённый JSON в явном envelope доступного tool больше не превращается в
  final text. Parser сохраняет `extracted_json_invalid` и классифицирует
  `tool_call`, bare `{name, arguments}`, `<tool_call>`, `Tool: Name` и
  `{tool, arguments}` marker как malformed intent.
- Неоднозначные escapes (`\a` в production `Edit.old_string`) не исправляются
  угадыванием. Existing bounded guard требует один новый валидный JSON call и
  явно сообщает, что предыдущий tool не выполнялся; после трёх attempts Bridge
  возвращает непустой `TOOL_CALL_REQUIRED` без raw JSON.
- Informational request с JSON-примером остаётся текстовым. Валидные escaped
  Windows paths не проходят repair и сохраняются byte-for-byte после JSON
  decode.
- Offline: 8 новых regression cases; итого 459/459 tests.
- Windows production reproduction в исходной Claude Code TaskFlow-сессии:
  вместо raw malformed final клиент получил настоящий `Edit` и successful
  `tool_result`. В продолжении также подтверждены `Edit(server.js)` → result,
  clean Jest 13/13 и отдельный `node server.js` listener. Полный semantic
  TaskFlow success не заявляется: последующая модель проигнорировала exact
  UTF-8 arguments и преждевременно описала более слабую проверку; это вынесено
  в отдельный TODO ниже.

### Multi-step current-user obligation guard — 2026-08-21

- Последний реальный текстовый user request преобразуется в ограниченный набор
  проверяемых `ToolObligation`: file/data mutation, command execution,
  API/file verification, test execution, launch/server verification и install.
  Standalone `<system-reminder>` удаляется до выбора request; historical turns,
  compact/history и предыдущие user tasks не становятся evidence нового cycle.
- Каждое требование закрывается независимо только коррелированным successful
  `tool_use` → `tool_result` подходящего типа. Edit/Write не подтверждает API,
  API не подтверждает storage, Jest не подтверждает listener. Retry перечисляет
  missing requirements и отдельно уже fulfilled requirements, чтобы не
  заставлять модель повторять подтверждённые шаги.
- Exact title/name, description, content/marker, path и URL сохраняются как
  исходные Unicode strings и сравниваются после NFC normalization. Arguments
  должны реально содержать literal; JSON result проверяется по равным string
  values, а не по escaped/mojibake representation или подстроке. Structured
  `{"error":...}` не считается successful application action.
- Test evidence требует реальный test command, а не `--version`, `--help` или
  `--listTests`. Явные Jest failure summaries не закрывают obligation даже при
  shell exit code 0. Text continuation (`Let me ... rerun`) и raw XML marker
  при missing steps получают bounded retry; exhaustion даёт непустой
  `TOOL_CALL_REQUIRED`.
- Offline: 21 новый regression case; итого 480/480 tests.
- Windows TaskFlow live без command hints: Flash не принял mojibake/failed Jest.
  Pro самостоятельно создал exact Unicode record через Node request, проверил
  API/storage, нашёл parallel storage race и выполнил `npx jest --runInBand`
  (29/29), затем поднял `node server.js`, проверил HTTP 200 и восстановил exact
  record после тестов. Независимо подтверждены API/storage exact values,
  listener PID 21104 и isolated Jest 29/29. Полный clean final остаётся partial:
  CLI harness истёк после последнего Read до captured final, и upstream модель
  повторно создала ту же exact запись; TODO ниже не закрыт.

### Fresh final-state evidence — 2026-08-21

- Obligations больше не считаются монотонными. Correlated tool results получают
  sequence внутри последнего user action cycle; API, storage/file и server
  postconditions засчитываются только если их evidence новее последней
  релевантной state-changing action.
- API evidence инвалидируют последующие data/file mutations, tests,
  dependency install, build и server launch/restart. Storage evidence
  инвалидируют data/file mutations, tests, install и build. Health/server
  evidence требует нового HTTP result после launch/restart, install или build.
  Обычный Read и информационный Bash (`pwd`) не инвалидируют состояние.
- Successful mutation остаётся fulfilled при stale verification. Bounded retry
  прямо требует свежий GET/Read/health и запрещает повторять уже successful
  POST только потому, что более позднее действие сделало старую проверку stale.
  Если свежая проверка показывает неверное состояние, guard требует безопасно
  reconcile текущий state без слепого создания дубликата.
- Multiline labels `title:`/`description:` извлекаются как exact NFC literals.
  Для `ровно одну`/`exactly one` API и storage JSON закрывают obligation только
  при count=1 объекта, содержащего оба exact значения; count=0 и count=2 —
  явные cardinality failures. Claude Read с детерминированной нумерацией строк
  разбирается как JSON; неоднозначный output требует повторной проверки.
- Offline: 12 новых regression cases; итого 492/492 tests. Покрыты stale
  API→tests, storage→Write, reverify без повторного POST, count 0/1/2,
  non-invalidating Read/pwd, restart→new health, correct final order и root
  `DeepSeekClient` retry к настоящему GET.
- Windows TaskFlow live с дословным prompt: первый Pro-run реально дошёл через
  tests до восстановления exact final state. Независимо подтверждены API 200,
  storage/API exact count=1, Jest 29/29, HTTP listener PID 21104. Captured final
  до 15-минутного timeout не получен. Два чистых повтора (Flash и Pro) не
  получили первый real mutation и завершились честным непустым HTTP 502
  `TOOL_CALL_REQUIRED`, exact count оставался 0. Полный autonomous success не
  заявляется; TODO ниже остаётся `[~]`.

### DeepSeek SSE rate-limit hint handling — 2026-08-23

- Реальный DeepSeek подтвердил HTTP 200 SSE error shape: `event: hint` с
  `finish_reason:"rate_limit_reached"`. Раньше событие классифицировалось как
  `other`, completion становился пустым, а guard делал две лишние generation
  attempts и возвращал `TOOL_CALL_REQUIRED`/502 вместо настоящей причины.
- `SseAccumulator` теперь сохраняет отдельный `hint`; точный rate-limit signal
  немедленно становится retryable `DEEPSEEK_RATE_LIMIT` HTTP 429 с
  `upstreamStage="completion"` и `causeCode="rate_limit_reached"`. Ошибка
  выходит из первой `runCompletion()` до tool parsing/guard, поэтому guard не
  создаёт дополнительные upstream completion attempts.
- Обычный hint без `rate_limit_reached` игнорируется как раньше, normal
  successful SSE продолжает парситься. Offline: 5 новых regression cases;
  итого 551/551 tests.
- D1/context ownership, full transcript/delta strategy, session/parent state,
  toolParser, obligation rules, replay/fingerprint и retry limits других
  сценариев не менялись.

### Tool flow regression fix — 2026-08-21

- Эмпирический A/B тест старой (`67c6f689`) и новой (`06b1e4e8`) сборок на
  идентичных сценариях подтвердил три root cause регрессии живого tool-flow:
  нечитаемый count навсегда блокировал API/storage verification; multiline
  `title:`/`description:` literals пере-байндились к аргументам
  `file_mutation`; stale invalidation вместе с выросшим retry-промптом чаще
  упиралась в лимит попыток и давала серии `TOOL_CALL_REQUIRED`.
- Guard классифицирует нечитаемый вывод как inconclusive вместо вечного
  missing/failure: retry требует свежий детерминированный GET/Read с raw JSON
  и запрещает повтор успешной мутации. Добавлены `inconclusiveObligations` в
  evidence, retry-блок «could not be deterministically counted» и телеметрия
  `inconclusive_obligation_count`.
- Exact-count учитывает только релевантный verification-вывод: совпадение
  exact literals либо container JSON. Health `"200"`, `pwd` и скалярные
  выводы больше не создают ложных cardinality failures.
- Аргументы `file_mutation` больше не включают title/description при наличии
  `data_mutation`; независимые файловые задачи сохраняют требование точных
  значений.
- Offline: 9 новых regression cases; итого 501/501 tests; typecheck, build и
  platform-smoke зелёные.

### Pseudo-XML tool intent blocking — 2026-08-22

- Расследована утечка pre-existing (не регрессия `c8693ac`: repro идентичен на
  `67c6f689`, `06b1e4e8`, `c8693ac`): модель эпизодически эмитировала
  OpenAI-style `<tool_calls><invoke name="..."><parameter ...>` вместо
  canonical call. Парсер возвращал `no_tool_call_in_text` с
  `malformedToolIntent=false`, а guard пропускал такой текст как final ровно в
  состоянии «obligations закрыты + успешный tool_result» (`shouldRetry`
  post-success ветка) — raw псевдо-XML уходил клиенту неисполненным.
- Классификация: `looksLikeMalformedToolIntent` помечает исполнимый
  pseudo-XML shape (`<invoke name="<allowed>">`, за которым следует
  `<parameter>`) как malformed tool intent. Bridge XML сам не исполняет;
  recovery — существующий bounded retry с требованием одного canonical JSON
  tool call, уже успешные side effects не повторяются. После safety-review
  `baf72a6` detection сужён: голая цитата `<invoke ...>` в тексте/reasoning и
  пустой `<invoke>` без `<parameter>` больше не считаются intent; обычный
  XML/HTML и invoke неизвестного инструмента не блокируются.
- Offline: 7 regression cases (блокировка при fulfilled/pending/failed,
  invoke+parameter и multiline без wrapper, проза/пустой invoke/безвредный XML
  не блокируются, canonical parsing цел, root «retry без replay»);
  итого 508/508 tests; typecheck, build, platform-smoke зелёные.
- Live smoke (Write/Read/Bash через Claude Code, deepseek-v4-pro): инструменты
  исполнились реально, `completion_guard_rejected=0` — нормальный flow без
  регрессии. Pseudo-XML live воспроизвести не удалось (эпизодический формат);
  корректность блокировки покрыта regression-тестами.

### Obligation granularity foundation — 2026-08-22

- Расследование (см. анализ multi-step мутаций одного файла) подтвердило root
  cause схлопывания: `inferToolObligations` строит строго один obligation на
  `ExternalActionKind`, поэтому create+append одного файла закрывается первым
  же успешным Write. Полный step-level inference пока не реализуем — сначала
  foundation.
- Foundation (`fix/obligation-granularity-foundation`, поведение пользователя
  НЕ меняется): новый `matchObligationsToEvidence` делает one-to-one binding
  внутри одного kind через аугментационные пути; evidence шарится между разными
  kinds как раньше. `inspectCurrentToolCycle` использует матчер; latest-first
  сканирование сохраняет freshness/stale семантику финальных состояний;
  fresh-verification/cardinality/inconclusive ветки и replay-fingerprint
  protection не тронуты. `inferToolObligations` без изменений (без новых regex,
  без step splitting, `pathLiterals.slice(0, 1)` сохранён).
- Offline: 6 новых unit cases на multiple instances per kind; итого 514/514
  tests; typecheck, build, platform-smoke зелёные. Следующий шаг — собственно
  step-level split в инференсе с консервативными условиями и капом шагов.

### Distinct multi-file mutation obligations — 2026-08-22

- Первый пользовательский эффект поверх foundation (`fix/multi-file-obligations`):
  если запрос явно требует мутировать ровно ДВА РАЗНЫХ файла,
  `inferToolObligations` создаёт `file_mutation#1`/`file_mutation#2` с
  per-path `argumentLiterals`; матчер foundation закрывает их разными Write'ами.
  Поддержаны только 2 distinct paths: same-file multi-step (Write→Edit/append)
  и 3+ paths вне scope (fallback на исторический одиночный obligation).
- Кандидат пути на split — только при ближайшем мутационном глаголе перед ним;
  верификационные упоминания («проверь storage-файл data/tasks.json») не
  считаются мутациями, что сохраняет прежнее поведение существующих сценариев.
  Не тронуто: literal/content extraction, file_verification regex, empty final,
  naked `<tool_calls>`, replay/fingerprint, matcher.
- Offline: 8 новых regression cases; все прежние тесты прошли без правок
  ожиданий; итого 522/522 tests; typecheck/build/test:platform зелёные.
- Live deepseek-v4-pro (чистая папка): два отдельных Write по двум файлам
  (bridge-multi-a-952.txt / bridge-multi-b-952.txt), содержимое точное,
  completion_guard_rejected=0, TOOL_CALL_REQUIRED=0, malformed=0, replay=0,
  normal final.
- Safety-review 7017c04: adversarial probes подтвердили silent
  under-enforcement — split происходил даже когда третий запрошенный файл был
  изолирован от распознанных глаголов; система предъявляла «два требования»
  как полные. Патч: tri-state классификация каждого distinct path
  (mutation/verification/none по ближайшему распознанному глаголу в окне до
  120 символов); split только при ровно двух mutation и нуле none путей.
  Итого 524/524 tests. Known limitations вынесены отдельно: read-target как
  первый literal (pre-existing slice(0,1)), P6 over-enforcement на слабых
  упоминаниях, A1 наследование контекста у нераспознанных глаголов,
  extraction ограничен списком расширений, same-file multi-step и 3+ paths
  вне scope.

### Same-file additive final-state verification — 2026-08-23

- Второй пользовательский эффект (`fix/same-file-multi-step-obligations`,
  поверх 93bfde8): для узкого same-file additive scope — ровно две
  последовательные мутационные клаузы об одном файле с явным маркером
  «затем/после этого/потом/then», вторая добавляет значение («Создай report.txt
  с содержимым "STEP-1". Затем добавь строку "STEP-2".») — `inferToolObligations`
  синтезирует final-state `file_verification` (args=[path],
  resultLiterals=[значения обеих клауз]). Верификация обязана быть fresh после
  последней мутации: переиспользованы stale/final-state machinery,
  latest-first binding, `invalidatesFinalState` — без изменений в matcher.
- Root cause исходной дыры подтверждён: extraction ронял литералы второго шага
  (role=null у не-first content), а kind-singleton закрывал file_verification
  первым же Read. S1-вариант (union литералов по всем evidence) отвергнут
  safety-анализом: false positives на destructive последовательностях.
  Выбрана end-state семантика: порядок шагов и промежуточные состояния не
  контролируются, проверяется только итоговое содержимое файла.
- Глобальный extraction НЕ расширен; новый локальный helper
  `inferSequentialAdditiveFinalState` сканирует только два спана клауз.
  Gate: ровно 1 distinct path; ровно 2 мутационные клаузы (доп. маркерные
  сегменты — только без мутационных глаголов); нет conditional/or; нет
  replace-chain (→/->/замени X на Y); Read-like tool в toolset; вторая клауза —
  явный path / местоимение («в этот же файл») / неявное продолжение (отклон
  только при другом path-like токене); при уже выведенной обычным inference
  file_verification — merge resultLiterals, без второй инстанции.
- Offline: describe «same-file additive final-state verification», 14 cases
  (destructive Write/Edit-replace → missing; one-shot/append → fulfilled;
  ранний полный Read → stale; merge; 6 gate-негативов; pronoun-positive).
  Все прежние тесты без правок ожиданий; итого 538/538; typecheck/build/
  test:platform зелёные.
- Live deepseek-v4-pro (чистая папка): Bash printf(обе строки) → Read → normal
  final «обе строки присутствуют»; файл на диске точный;
  completion_guard_rejected=0, TOOL_CALL_REQUIRED=0, malformed=0, replay=0.
- Ограничения: только 2 additive same-file клаузы; quoted/распознанные
  литералы (unquoted значения unsupported); replace-chains, 3+ шага,
  conditional формулировки вне scope.
- Safety-review `bab6a9c` (патч «Narrow same-file additive verification»):
  destructive клаузы в clause2 («измени/edit/change», «удали»,
  «перезапиши/write/save») давали false positives — ложное требование обеих
  строк блокировало легитимные запросы через guard. Clause2 теперь только
  explicit additive verbs (`добав|дополн|допис|append|\badd\b`); широкий
  список остался для clause1 и детекции третьей mutation-клаузы. Foreign path
  в clause2 запрещает synthesis безусловно — местоимение («этот же файл» /
  «same file») больше не перекрывает чужой путь (latent-дыра helper'а,
  ранее маскировалась внешним distinct-paths gate). Семантически additive
  «измени так, чтобы итог содержал…» намеренно unsupported. Итого 546/546;
  live: Bash → Read → normal final, guard=0.

## Стабильная live-точка — 2026-08-20

Подтверждено live-тестами Claude Code (полный workflow «кодирование через бридж»):

- Claude Code корректно понимает cwd из system prompt.
- Новая Claude Code сессия не подтягивает старые задачи.
- Одиночные tool-вызовы работают (Bash, Read, Write, Edit, Grep, Glob).
- Последовательные tool-вызовы в одном запросе работают.
- Создание файлов работает.
- Редактирование существующих файлов работает (Edit tool).
- Повторное чтение файлов работает.
- Запуск shell-команд работает (npm test, ls и т.д.).
- `npm test` запускается и возвращает корректный результат.
- `tool_result` возвращается в DeepSeek через tool_result continuation.
- DeepSeek автоматически продолжает после `tool_result`.
- Tool execution error (Read несуществующего файла) → `is_error: true`
  корректно передаётся и DeepSeek получает ошибку.
- Error recovery: после tool error DeepSeek выполняет альтернативные
  инструменты (Bash → Write) и успешно завершает задачу.
- Multi-step coding workflow успешно выполнен и затем отдельно
  VERIFIED чтением файлов и повторным `npm test`.
- Anthropic SSE lifecycle корректен: `message_start` → `content_block_start`
  → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`.
- Tool use: `content_block_start` с `input: {}`, `input_json_delta`,
  `stop_reason: tool_use`.
- Raw tool JSON не попадает в text block.
- `parent_message_id` (number) корректно передаётся между запросами.
- Параллельные Claude Code сессии (2 сессии через один Bridge)
  работают независимо: session-A пишет в `D:\test CC NODE`,
  session-B в `D:\test 2`, файлы не смешиваются, lineage изолирован.
- Длинные цепочки 5+ последовательных tool-вызовов: созданы
  file1.txt → file2.txt → оба прочитаны → result.txt → file2
  переименован в second.txt → result.txt прочитан → ls папки.
  Все шаги выполнены, PowerShell подтвердил результаты.
- Длинная сессия / compaction: 12 exchanges + /compact.
  После compaction сохранились cwd, ALPHA-731, BETA-482, контекст.
  Простой post-compact workflow (create → read) прошёл успешно.
  PowerShell подтвердил: `compact-simple.txt` → `compact simple ok`.
- Post-/compact stale-action replay live-test (2026-08-20): до compact были
  созданы `anchor.txt` = `ANCHOR-OK` и `victim.txt` = `VICTIM-OK`, затем
  `victim.txt` удалён. После `/compact` он был вручную восстановлен как
  `VICTIM-RESTORED`; Claude Code получил только запрос прочитать `anchor.txt`.
  Проверено: `anchor.txt` = `ANCHOR-OK`, `victim.txt` = `VICTIM-RESTORED`,
  `Test-Path victim.txt` = `True`; старая destructive-команда не повторилась.
- Post-/compact multi-step live-test (2026-08-20): задача из 12 шагов
  завершилась без ручного `continue`. Claude Code прочитал 5 файлов, вывел
  1 каталог и выполнил 3 shell-команды. PowerShell подтвердил:
  `a.txt` = `FINAL2-A-731`, `second.txt` = `FINAL2-B-482`, `result.txt` =
  `FINAL2-A-731|FINAL2-B-482`, `done.txt` = `post compact final 2 verified`,
  `Test-Path b.txt` = `False`; в папке остались `a.txt`, `done.txt`,
  `result.txt`, `second.txt`.
- Большие `tool_result` (>10 000 символов): `large-result.txt`
  18 500 байт прочитан через Read, цепочка продолжилась,
  создан `large-result-ok.txt`. PowerShell подтвердил.

### Области, ещё не проверенные desktop GUI live-тестами

Не являются багами — просто не проверялись:

- macOS: визуальное открытие folder picker и Terminal.app Claude Code/OpenCode,
  интерактивность CLI и точечный SHUTDOWN окна/процесса.
- Linux: визуальное открытие zenity/kdialog и поддержанных terminal emulator,
  интерактивность CLI и точечный SHUTDOWN окна/процесса.

## Известные пробелы и TODO

Отсортировано по приоритету.

### Приоритет 1 (блокирует «из коробки»)
- [x] **Реальный вход через `npm run auth`** — ✅ работает.
- [x] **`npm run doctor` с реальным аккаунтом** — ✅ все 6/6 проверок проходят.
- [x] **`npm run test:live`** — ✅ все проверки проходят (health, models,
  chat/completions, messages).
- [x] **Tool calling работает** — Промпт-эмуляция (FreeDeepseekAPI format)
  + текстовый извлечение JSON + retry. **Live-тест 2026-08-17**: 5/5.
  Claude Code может использовать инструменты через бридж.
  **2026-08-19**: исправлен Anthropic streaming — добавлен `stream.start()`
  (message_start), raw tool JSON больше не попадает в text block,
  FINISHED не утекает в fragment content. Claude Code tool calls теперь
  маршрутизируются через `tool_use` blocks.
  **Ограничение**: модель не всегда генерирует чистый JSON — парсер
  извлекает JSON из текста, retry помогает при неверном формате.
- [x] **Claude Code action completion integrity** — `Artifact` отфильтрован как
      недоступный Bridge tool; failed/current/historical results разделены;
      create, mutation, execution, launch и install требуют соответствующего
      successful evidence текущего canonical cycle. Live landing workflow
      прошёл Write → result → Bash launch → result → final без Artifact.
- [x] **Повтор одинакового failed tool call** — stable current-cycle fingerprint
      блокирует повтор после `is_error:true`, bounded retry требует изменённые
      arguments/другой tool/честный failure, а exhaustion не возвращает пустой
      final. Live: точный `Bash(false)` исполнился один раз; изменённый
      `printf RECOVERY-OK-482` после ошибки успешно выполнился.
- [x] **Malformed Claude Code tool call не утекает в final** — повреждённый
      envelope доступного tool получает bounded retry с требованием valid JSON;
      неоднозначные backslashes не ремонтируются, exhaustion возвращает
      непустой `TOOL_CALL_REQUIRED`. Production TaskFlow reproduction вернул
      настоящий `Edit tool_use`/`tool_result` вместо raw JSON.
- [x] **Multi-step current-user obligations** — exact Unicode literals и
      отдельные mutation/API/storage/test/server requirements требуют
      соответствующего current-cycle evidence. Один successful result не
      закрывает весь request; missing steps получают bounded retry, а failed
      Jest pipeline/structured application error не считаются успехом.
- [x] **Fresh final-state evidence и exact cardinality** — API/storage/health
      verification инвалидируется более поздней релевантной mutation, tests,
      build/install или restart и должна быть повторена перед final. Уже
      successful POST остаётся fulfilled; stale retry просит GET/Read/health,
      а `ровно одну` требует final exact count=1 (0 и 2 отклоняются).
- [x] **Pseudo-XML tool intent не утекает в final** — исполнимый
      `<invoke name="...">…<parameter>` shape распознаётся как malformed tool
      intent (после safety-review `baf72a6` голая цитата `<invoke>` в прозе и
      пустой `<invoke>` без параметров не блокируются); bounded retry требует
      canonical JSON call, успешные мутации не повторяются. Pre-existing gap
      (не регрессия tool-flow fix), закрыт 2026-08-22 на ветке
      `fix/pseudo-xml-tool-intent`; live pseudo-XML не воспроизведён,
      нормальный tool flow подтверждён без регрессии (`guard_rejected=0`).

### Приоритет 2 (расхождения README с кодом) — все закрыты

- [x] **setup-панель `http://127.0.0.1:9655/setup`** — README исправлен:
      описание заменено на реальные шаги (npm install → auth → doctor → start).
- [x] **`START_DEEPSEEK.cmd`** — README исправлен: упоминание удалено,
      описаны реальные npm-команды.
- [x] **`opencode.json`** — README исправлен: упоминание «панель создаёт
      готовый opencode.json» удалено, вместо этого приведён ручной пример
      подключения OpenCode через OPENAI_API_BASE.
- [x] **Битые ссылки** (`docs/protocols.md`, `docs/troubleshooting.md`,
      `docs/live-validation.md`) — удалены из README. Оставлены только
      ссылки на реально существующие документы.
- [x] **`/v1/models` — актуальные модели** — публикуется статический список
      подтверждённых `deepseek-v4-flash` и `deepseek-v4-pro`. Legacy aliases
      `deepseek-chat`/`deepseek-reasoner` принимаются, но не рекламируются.

### Приоритет 3 (улучшения, не блокеры)
- [ ] **Obligation granularity: несколько мутаций одного файла схлопываются** —
      live smoke 2026-08-22 (после pseudo-XML фикса): prompt требовал Write +
      append + Read + Bash verify, модель выполнила только первый Write и
      заявила полный успех; guard не заблокировал, потому что обе мутации того
      же файла инферировались как один `file_mutation`, закрытый единственным
      успешным результатом. Pre-existing obligations gap, вне scope pseudo-XML
      фикса; нужен per-step учёт при нескольких изменениях одного файла.
- [~] **Повторить полный autonomous TaskFlow semantic live-test** — obligation
      guard и final-state freshness реализованы. Новый Pro live без command
      hints после tests восстановил exact UTF-8 state; независимые API/storage
      дали exact count=1, serial Jest 29/29, HTTP 200 и listener PID 21104.
      Однако CLI не дал captured final до 15-минутного timeout. Чистые Flash/Pro
      повторы безопасно вернули непустой `TOOL_CALL_REQUIRED` до mutation, без
      fabricated success. 2026-08-21: offline root causes регрессии tool-flow
      исправлены (inconclusive cardinality, релевантность подсчёта, узкий
      re-binding `file_mutation`); нужен повторный live-run с exact count=1 и
      видимым final после свежих API/storage/HTTP evidence.
- [ ] **Повторно проверить production SHUTDOWN/PID lifecycle** — после
      action-integrity live-run наблюдалось, что `/bridge/shutdown` закрывал HTTP
      listener, но исходный Node PID дважды оставался жив и требовал точечного
      завершения. Ранее успешные SHUTDOWN сценарии также зафиксированы выше;
      root cause нового наблюдения не установлен. В repeated-failure задаче
      shutdown-код не менялся.
- [x] В `src/api/handler.ts` переменная `turn` не используется — tool-цикл
      (повтор после tool_result) не замкнут, история ведётся только в
      `SessionStore`. Продумать и реализовать полный цикл tool calling либо
      явно задокументировать ограничение.
- [x] `toolNames`/`toolPrompt` в `src/deepseek/client.ts` передаются из options,
      но в `src/app.ts` заданы пустыми — прокинуть из request.tools через handler.
      **Решено:** client.complete() строит tool prompt и toolNames из request.tools
      напрямую; toolPrompt/toolNames удалены из DeepSeekClientOptions.
- [x] Проверить `SESSION_ID_ENTROPY_BYTES`=16 (32 hex) — совпадает с тестом.
      `generateSessionId()` → `crypto.randomBytes(16).toString("hex")` → 32 hex chars.
      3 offline-теста (`sessions.test.ts`): константа=16, формат 32 hex, уникальность 100 ID.
- [x] Диагностика PoW: `maxAttempts=10_000_000` — неактуальный TODO.
      `runLegacySha3()` (complexity-based) никогда не вызывался: `solve()`
      при `complexity > 0` сразу бросает ошибку, `difficulty > 0` идёт через WASM.
      Мёртвый код удалён.
- [x] Сброс удалённой сессии при 401/403 (есть в архитектуре) — на клиенте
      «сбросить и предложить npm run auth» реализовано: `sessionStore.reset()` +
      `lineage.removeByUpstreamKey()` + лог `auth_expired_session_reset`.
      14 offline-тестов (`authExpired401.test.ts`).
- [x] DeepSeek иногда придумывает абсолютный путь (например
      `C:\Users\Mi\session-B.txt`) вместо использования cwd/относительного
      пути. **Prompt fix implemented**: добавлены PATH RULES в tool prompt
      (rule 8a-f: cwd = source of truth, запрет на изобретение путей,
      разрешение от cwd, проверка cwd через Bash, исключение явных путей
      пользователя). 6 offline-тестов (`tools.test.ts`).
      **Live-test (2026-08-19)**: session-A cwd=`D:\test CC NODE` создал
      `path-test-A.txt`=AAA, session-B cwd=`D:\test 2` создал
      `path-test-B.txt`=BBB. Файлы изолированы: `Test-Path` подтвердил
      отсутствие смешивания. PowerShell-команды подтвердили пути.
- [x] После compaction на сложной multi-step задаче модель могла
      заявить о выполнении (premature final answer) без фактического
      вызова всех нужных tools. **Prompt fix implemented** (rule 9-10)
      + **runtime completion guard implemented** (fake tool trace
      detector + bounded retry, max 3 total attempts). Live-test
      воспроизвёл формат `Tool: Bash\n{json}` — добавлен детектор
      `looksLikeToolPrefixedFakeTrace()`.
      **Live-test (2026-08-20)**: post-/compact задача из 12 шагов выполнена
      полностью без ручного `continue`: 5 чтений файлов, 1 листинг каталога,
      3 shell-команды. PowerShell подтвердил итоговые файлы и отсутствие
      `b.txt`. Подтверждён именно этот multi-step сценарий.
      **Critical guard hardening (2026-08-20)**: запросы к реальному cwd,
      листингу/структуре каталога, содержимому/существованию файла и выполнению
      команды теперь требуют structured `tool_result` текущего canonical
      tool-cycle. Historical result, compact/history, `pwd` + `Вывод:` и fake
      `ls -la` listing не считаются выполнением. После bounded retries Bridge
      возвращает `TOOL_CALL_REQUIRED` (HTTP 502), а не fabricated final text;
      справочные вопросы о `pwd`/`ls` остаются обычными текстовыми вопросами.
      Добавлены 23 offline regression-теста, включая корневое поведение
      `DeepSeekClient.complete()`.
      **Live-test (2026-08-20, Windows, Claude Code 2.1.237)**: в
      `D:\test CC NODE` запрос cwd дал настоящий `tool_use Bash(pwd)` и
      `tool_result` `/d/test CC NODE` до final. Отдельный запрос листинга дал
      настоящий `tool_use Bash(ls -la)` и result с `post-compact-final-2`,
      `stale-live-test`, `test.txt`; результат совпал с `Get-ChildItem`.
- [x] **Stale tool action replay**: после /compact bridge включал
      executable tool arguments из прошлых turns в upstream prompt.
      **Architectural fix implemented** (2026-08-20):
      1. Удалён `state.history` из `buildPrompt()` (client.ts).
      2. `canonicalToRaw()` использует `sanitizedToolInvocationText()`
         — аргументы tool_use НЕ сериализуются в upstream prompt.
      3. `anthropicMessageText()` аналогично использует sanitized формат.
      4. Добавлен PRIORITY RULE (rule 11) в tool prompt.
      16 offline-тестов в исходном исправлении (`tools.test.ts`) + прямой
      regression-тест через `DeepSeekClient.complete()`, проверяющий реальный
      upstream prompt. OpenAI/Responses runtime проходит canonical normalization;
      raw argument-serializing helper-ветки текущим production path не
      достигаются.
      **Live-test (2026-08-20)**: после настоящего `/compact` вручную
      восстановленный `victim.txt` сохранил `VICTIM-RESTORED`, когда Claude Code
      получил только запрос прочитать `anchor.txt`; `Test-Path victim.txt` =
      `True`, старая destructive-команда не повторилась. Подтверждён именно
      этот stale-action replay сценарий.

### Cross-platform Web UI (архитектурный план)

Цель: пользователь на Windows / macOS / Linux имеет одинаковый сценарий:
`clone` → `npm install` → `npm run auth` → `npm start` → открыть
`http://127.0.0.1:9655` → пользоваться Web UI без ручного выбора ОС.

**Статус**: Windows/auth-lifecycle и Windows CLI launch desktop live-подтверждены.
`GET /api/system`, macOS picker/Terminal.app launch и Linux picker/terminal-emulator
launch реализованы и покрыты platform-mocked offline-тестами. Workflow
`.github/workflows/cross-platform.yml` дополнительно запускает typecheck, все
offline tests, build и `npm run test:platform` на реальных GitHub-hosted
Windows/macOS/Linux runner. Это real-OS CI, но не desktop GUI live-test.

- [x] Добавлен one-click запуск самого Bridge: Windows `START.bat`, macOS
      `START.command`, Linux `DeepSeek Web Bridge.desktop` + fallback `START.sh`.
      Общий dependency-free `scripts/desktopStart.mjs` работает до установки
      dependencies, поддерживает Unicode/пробелы через отдельный `cwd`, не запускает
      второй Bridge при HTTP 200 `/health`, автоматически выполняет install/build,
      ждёт readiness и открывает Web UI. 18 offline-тестов изолируют npm, browser и
      child process; настоящий double-click desktop live-test macOS/Linux не заявлен.

- [x] Windows FolderBrowserDialog передаёт UTF-8 path через ASCII Base64; Node
      явно декодирует UTF-8 и исправляет реально наблюдавшийся Latin-1 mojibake
      только когда восстановленный каталог существует. **Runtime live-test
      (2026-08-20)**: `/bridge/pick-folder` и browser `#workdir` получили точно
      `D:\Проекты\Тестовая папка ёжик`; Web UI `/bridge/launch` передал тот же
      `workDir`, а реальный child probe и `cmd.exe → claude.exe` подтвердили exact
      `process.cwd()`. Windows Terminal открыл живой Claude Code.
- [x] LOGOUT отделён от SHUTDOWN: локальные DeepSeek credentials/profile и runtime
      account state очищаются, Bridge и запущенные CLI остаются работать.
      **Runtime live-test (2026-08-20)**: до LOGOUT `/health` = 200 и auth-status =
      `valid:true`; `POST /bridge/logout` = 200; тот же Node PID остался жив;
      после LOGOUT `/health` = 200, `/readyz` = 200, auth-status = `valid:false`,
      `auth.json` и dedicated Chrome profile отсутствуют, `GET /` = 200.
- [x] AUTH после LOGOUT обновляет credentials работающего `DeepSeekClient` без
      рестарта; старые upstream state/lineage очищаются безопасно без удаления
      соседних данных `sessions.json`. **Runtime live-test (2026-08-20)**:
      `AUTH → completion → LOGOUT → AUTH → completion` прошёл на одном Node PID
      `19944`; completions вернули точные маркеры `AUTH1-FINAL-731` и
      `AUTH2-FINAL-482`, после повторного AUTH создан новый upstream key.
- [x] SHUTDOWN сохраняет `auth.json`, останавливает только tracked CLI, активный
      auth Chrome, HTTP server и Node process. **Runtime live-test (2026-08-20)**:
      tracked `cmd.exe → claude.exe` и Node PID `19944` завершились, посторонний
      Claude PID `6472` остался жив, `auth.json` сохранился без изменения. После
      запуска нового Bridge (PID `23236`) auth сразу был valid, а real completion
      вернул `RESTART-FINAL-963` без повторного AUTH. Отдельный production probe
      на порту 9656 подтвердил edge case: SHUTDOWN отменил активный AUTH, завершил
      Node PID `13880` и все 11 процессов dedicated auth Chrome; HTTP закрылся.
- [x] Реализовать macOS/Linux folder picker: macOS `osascript`; Linux приоритетно
      `zenity`, затем `kdialog`, иначе `supported:false` и ручной ввод.
      Unicode/cancel/fallback покрыты platform-mocked offline-тестами.
- [ ] Провести настоящие macOS/Linux live-тесты one-click START, folder picker,
      нативного CLI launch/SHUTDOWN и Chrome auth.
- [x] Добавить real-OS CI matrix (`windows-latest`, `macos-latest`,
      `ubuntu-latest`) и изолированный `test:platform`: текущая ОС,
      `buildConfig`, startup Bridge, `/health`, `/readyz`, `/api/system`, Unicode
      temp cwd, безопасный child, четыре Bridge env и cleanup. macOS также
      проверяет наличие `osascript`/Terminal.app, production POSIX runner и
      POSIX quoting; Linux — реальное обнаружение terminal transport и
      capability=false при его отсутствии. Smoke не читает auth, не запускает
      DeepSeek/Claude/OpenCode и не делает broad process kill. Path identity
      учитывает реальные OS aliases (`RUNNER~1` на Windows, `/private/var` на
      macOS), одновременно отдельно проверяя неизменный Unicode basename.
- [x] Реализовать `GET /api/system` и UI capabilities. Windows возвращает
      picker/Claude/OpenCode launch `true`; macOS launch = `true` только при
      наличии `osascript` + Terminal.app; Linux launch = `true` только при наличии
      поддержанного terminal emulator. Capability означает terminal transport,
      не наличие CLI binary; `claude`/`opencode` проверяются при Launch.
      **Windows runtime probe (2026-08-20)**: production `dist` вернул HTTP 200
      `{"platform":"win32","folderPicker":true,"claudeCodeLaunch":true,"openCodeLaunch":true}`;
      страница загрузила `/api/system` и сохранила ручной `#workdir` input.

#### 1. Определение ОС

Backend определяет платформу через `process.platform`:
- `win32` → Windows
- `darwin` → macOS
- `linux` → Linux

Пользователь НЕ выбирает ОС вручную. Backend является source of truth.

#### 2. System capabilities API

`GET /api/system` — возвращает capabilities текущей ОС:

```json
{
  "platform": "darwin",
  "folderPicker": true,
  "claudeCodeLaunch": true,
  "openCodeLaunch": true
}
```

Endpoint реализован; backend использует только `process.platform`. На Linux
`folderPicker` определяется безопасной проверкой `zenity`, затем `kdialog`.

#### Уровни cross-platform проверки

1. **Unit/platform-mocked** — Vitest проверяет mocked платформы, picker/terminal
   argv builders, escaping, capabilities и Windows regressions.
2. **Real-OS CI** — GitHub Actions запускает проект и безопасный child runner на
   настоящих Windows/macOS/Linux runner; проверяет filesystem/Unicode/cwd/env и
   backend HTTP без аккаунта DeepSeek. На macOS/Linux выполняется fixed POSIX
   runner, но GUI transport намеренно не открывается.
3. **Desktop GUI live-tested** — требует пользовательской desktop session и
   ручного наблюдения picker/видимого интерактивного терминала. Windows пройден;
   macOS/Linux остаются TODO.

#### 3. Folder picker

- **Windows**: PowerShell / `System.Windows.Forms`, неизменный UTF-8/Base64 transport
  и текущий filesystem-validated mojibake fallback.
- **macOS**: системный picker через `osascript` / AppleScript; UTF-8 stdout,
  cancel `-128` → `cancelled:true`.
- **Linux**: безопасное обнаружение и запуск без shell string: `zenity`, затем
  `kdialog`; если обоих нет — `supported:false` и ручной ввод пути.

Если picker недоступен — Web UI разрешает ручной ввод пути.

#### 4. Запуск Claude Code / OpenCode

- **Windows**: текущий live-подтверждённый `launchProcess()` сохранён без изменения,
  обе capability `true`; Unicode cwd и tracked-process SHUTDOWN продолжают работать.
- **macOS**: новая видимая Terminal.app session через статический AppleScript.
  Cwd/аргументы POSIX-quoted и передаются как AppleScript argv; `~/` раскрывается
  backend. Capability `true` только при наличии `osascript` и Terminal.app.
- **Linux**: первый доступный `x-terminal-emulator`, `gnome-terminal`, `konsole`,
  `xfce4-terminal`, `kitty`, `xterm`; у каждого отдельный argv layout,
  `shell:false`. Если ничего нет — обе launch capability `false`.
- **Env/SHUTDOWN**: фиксированный private runner получает cwd/env/command через
  argv, экспортирует четыре Bridge env и `exec`-ит CLI. Bridge track-ит точный PID
  runner/CLI и собственный terminal launcher child; macOS дополнительно хранит
  window id + tty и закрывает окно только при точном совпадении и одной вкладке.
  Широкого kill Terminal.app/emulator/CLI по имени нет.

Реализация macOS/Linux проверена platform-mocked offline-тестами; настоящая
видимая сессия, desktop environment differences и SHUTDOWN требуют live-теста
на соответствующих ОС.

Не запускать интерактивный CLI невидимо в фоне при нажатии Launch в Web UI.

#### 5. Chrome auth

Chrome discovery уже частично кроссплатформенный (пути для Windows / Linux /
macOS поддерживаются в `scripts/cdp.ts`). Полноценную поддержку macOS / Linux
считать завершённой только после реальных live-тестов на этих ОС.

#### 6. Web UI capabilities

- Интерфейс получает capabilities от backend (`GET /api/system`).
- Показывает доступные действия, скрывает / disable неподдерживаемые.
- НЕ определяет платформу через browser user-agent.

## Как проверить работу после изменений

```
npm run typecheck
npm run build
npm test
npm run auth        # требует ручного входа
npm run doctor      # требует auth.json
npm run test:live   # требует запущенный сервер
```

## Правила для агентов

1. Прочитай `AGENTS.md`, `PROJECT_STATE.md`, `docs/architecture.md`,
   `docs/threat-model.md` **до** начала задачи.
2. Не меняй форматы/полевые имена DeepSeek API без live-проверки —
   это внешняя система, менять её нельзя.
3. После завершения задачи обнови `CHANGELOG.md` и `PROJECT_STATE.md`
   (статусы фаз, пробелы, актуальная дата).
4. Секреты (token, cookie) — только в `data/auth.json` с правами 0600;
   никогда в код, логи или README.
5. Не пиши тесты, обращающиеся к аккаунту DeepSeek, в offline-набор `npm test`.
