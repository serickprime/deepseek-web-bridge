# Архитектура

## Цель

Локальный мост (Bridge) превращает вашу собственную авторизованную веб-сессию
`chat.deepseek.com` в локальный API:

- `POST /v1/chat/completions` — OpenAI Chat Completions;
- `POST /v1/responses` — OpenAI Responses API;
- `POST /v1/messages` — Anthropic Messages API (основной маршрут для Claude Code);
- `GET /v1/models`, `GET /health`, `GET /readyz`, `GET /v1/sessions` и другие.

## Три слоя

```
Клиенты (Claude Code, OpenCode, OpenAI SDK)
        │
        ▼
[Серверный слой]      node:http, маршруты, безопасность (CORS, API key,
                      лимит тела, таймауты, request_ref, redaction)
        ▼
[Протокольный слой]   нормализация → внутренний CanonicalRequest →
                      DeepSeek-вызов → выходные адаптеры + SSE-обрамление
        ▼
[DeepSeek-слой]       auth-хранилище → сессии → PoW (WASM) → completion → SSE-парсер
        │
        ▼
chat.deepseek.com (ваша авторизованная сессия)
```

### Серверный слой

`src/server/` строит один `http.createServer` без внешних фреймворков.
`src/server/routes.ts` — таблица маршрутов. `src/security/middleware.ts` —
проверка API key, CORS, лимит тела, таймауты. `src/utils/logger.ts` — безопасные
логи с `request_ref` и redaction. Request-scoped logger передаётся явно через
handler в DeepSeek client и PoW без global/AsyncLocalStorage context.

Correlation identifiers не содержат raw client/upstream/chat/call IDs:
`client_ref`, `upstream_ref`, `chat_ref` и `call_ref` вычисляются HMAC с одним
случайным process-local salt и domain separation. Они стабильны только внутри
одного процесса. Lifecycle telemetry использует отдельные completion/guard/
transport attempts, `stage`, `latency_ms`, typed failure metadata,
`history_entries` и `parent_state: none|accepted|repair_candidate`; содержимое
prompt/messages/tool arguments/results и per-SSE-chunk события не логируются.

### Протокольный слой

Входящий запрос любого из трёх протоколов преобразуется в единый внутренний
формат (`src/api/canonical.ts`):

```ts
interface CanonicalRequest {
  model: string;
  stream: boolean;
  system: string;
  messages: CanonicalMessage[];
  tools: CanonicalTool[];
  sessionIdentity?: string;
  reasoning?: boolean;
  search?: boolean;
}
```

`src/api/normalizeOpenAI.ts`, `normalizeAnthropic.ts`, `normalizeResponses.ts`
реализуют разбор каждого протокола. После upstream-ответа работают выходные
адаптеры `outputOpenAI.ts`, `outputAnthropic.ts`, `outputResponses.ts`, а
`protocolStream.ts` пишет правильные SSE-события для каждого протокола.

Top-level Anthropic `system` принимает строку или ordered array text blocks.
Строка и content каждого block сохраняются без trim; blocks соединяются ровно
одним `\n`, а metadata валидного `{ type: "text", text: string }` block может
быть проигнорирована. Empty/absent system нормализуется в `""`.
Unsupported/malformed block, missing/non-string `text` и любой иной top-level
тип fail closed как `INVALID_REQUEST`/400: supplied system prompt никогда не
отбрасывается частично или целиком молча. Внутренний `CanonicalRequest.system`
остаётся строкой.

### DeepSeek-слой

`src/deepseek/client.ts` — оркестратор. Порядок upstream-запроса:

1. убедиться, что для клиента есть DeepSeek `chat_session_id` (создать, если нет);
2. `POST /api/v0/chat/create_pow_challenge` с `{"target_path": "/api/v0/chat/completion"}`;
3. решить PoW через WASM (`src/deepseek/pow.ts`);
4. `POST /api/v0/chat/completion` с заголовком `x-ds-pow-response`;
5. разобрать SSE-поток (`sseParser.ts` + `updateParser.ts`).

Стадии upstream-запроса:

```
challenge_start → challenge_received → wasm_download_start → wasm_downloaded
→ wasm_compile_start → wasm_compiled → pow_solve_start → pow_solved
→ completion_start → stream_received → stream_parsed
```

## Авторизация

- `npm run auth` запускает отдельный Chrome с профилем `data/chrome-profile/`
  и CDP-портом, пользователь входит вручную (включая CAPTCHA и 2FA).
- Через CDP захватываются: Bearer token, cookies, `x-hif-dliq`/`x-hif-leim`
  (если есть), URL PoW WASM.
- Данные сохраняются в `data/auth.json` (права `0600` на Linux, локально на Windows).
- Повторный запуск браузер не открывает: `src/auth/verify.ts` проверяет сессию
  коротким безопасным запросом.

## Сессии

- `src/sessions/sessionStore.ts` — in-memory состояние: `chat_session_id`,
  `parent_message_id`, ограниченная история, TTL.
- `src/sessions/sessionResolver.ts` — две независимые identity:
  - **client identity** (`X-Claude-Code-Session-Id` и др.) — только корреляция и диагностика;
  - **upstream identity** (`x-agent-session`, `metadata.user_id`, `user`, либо
    связь call-id → upstream-сессия для tool result).
- `src/sessions/lineage.ts` — опциональное сохранение ссылок сессий в
  `data/sessions.json` через единый `PersistentSessionDocument`. Lineage links
  используют `SESSION_LINK_TTL_MS`: `<= TTL` валидно, `> TTL` expired; lookup
  никогда не разрешает expired mapping, init durably prune-ит persisted expiry,
  а awaited mutations сохраняют накопленный cleanup без фоновых disk writes.
- `src/sessions/mutex.ts` — очередь на одну upstream-сессию: два параллельных
  новых пользовательских сообщения с одинаковым `parent_message_id` не уходят
  одновременно.

Правила:

- новый пользовательский ход без явного upstream identity — новая анонимная
  upstream-сессия (не общая и не «последняя активная»);
- tool result возвращается в исходную upstream-сессию по newest fresh call-id
  только внутри текущего action cycle после последней независимой
  user-инструкции и только если ID соответствует current-cycle `tool_use`;
  historical/orphan result не восстанавливает lineage нового хода;
- без explicit upstream fresh `x-call-id` и correlated current-cycle tool result
  разрешаются независимо: один/совпадающие mappings продолжают session,
  различающиеся дают `SESSION_CONFLICT`, unknown/expired header не подавляет
  valid result fallback;
- разные клиенты не смешиваются.
- `state.parentMessageId` хранит только accepted parent. `runCompletion()`
  получает request parent явно и возвращает `message_id` как локальный candidate,
  не изменяя shared state;
- bounded guard/repair attempts могут продолжать локальную candidate-chain, но
  rejected/failed candidate не публикуется. `complete()` один раз сохраняет ID
  только окончательно принятой generation после terminal, parsing, guard,
  callback и auth-generation проверки; success без ID сохраняет прежний parent.

## Tool calling

DeepSeek Web не имеет нативного function calling. `src/tools/toolPrompt.ts`
описывает инструменты в prompt и требует один строгий JSON-вызов:

```
<tool_call>
{"name":"Read","arguments":{"file_path":"..."}}
</tool_call>
```

или

```
{"tool_call":{"name":"Read","arguments":{"file_path":"..."}}}
```

`src/tools/toolParser.ts` принимает вызов только после проверок: имя в
allowlist, arguments — объект, валидный JSON, ограничены глубина (32) и размер
(48 КБ), имя ограничено, запрещены `__proto__`/`prototype`/`constructor`.

Каталог tools имеет один membership contract: после case-insensitive исключения
недоступного `Artifact` prompt описывает все имена, которые разрешены parser и
handler, сохраняя входной порядок. Description каждого tool по-прежнему
ограничен 1000 символами. Для каждого occurrence prompt содержит полный compact
`JSON.stringify(inputSchema)`: root constraints, `required`, types, enums,
nested object/array schemas, `oneOf`, `$defs`, descriptions и
`additionalProperties` сохраняются losslessly и не обрезаются. Initial prompt и
guard-repair без гарантированного repair-candidate parent context используют
один и тот же authoritative schema catalog.

Полный dynamic catalog ограничен 128 KiB / 131072 UTF-8 bytes. Размер считается
после `Artifact` filtering, с сохранением order/duplicates и description cap,
до session creation, upstream completion и downstream `stream.start()`.
Превышение fail-closed возвращает typed `REQUEST_TOO_LARGE`/413; частичный или
обрезанный каталог не отправляется. Catalog/schema content не логируется.
Этот transport contract не валидирует arguments по JSON Schema и не меняет
schema values через coercion/defaults. D12 отдельно разрешает nested arrays в
tool arguments: array branch выполняется до plain-object rejection и рекурсивно
проверяет каждый element. Root `arguments` остаётся plain object; dangerous
keys, nesting limit и 48 KiB tool-call limit сохраняются.

Completion guard выводит ordered file-action groups из текущей
user-инструкции. Каждая independently requested create/edit/read action-target
группа получает stable `kind#N` obligation; existing one-to-one matcher не
позволяет одному evidence закрыть unrelated instances одного kind.
Explicit one-command/one-operation multi-target clause сохраняется как одна
grouped obligation, которая требует evidence всех targets. Если clause→target
partition неоднозначна, conservative single obligation удерживает все
known targets. Paths нормализуются только в Unicode NFC; filesystem
separator/case canonicalization в этот contract не входит.

Для одного однозначного file target последующая verification action может
унаследовать target предыдущей mutation только при явной file-anaphora: `этот
файл`, `этот же файл`, `that file`, `the same file` или `it`. При нескольких
targets, другом explicit path, conflicting file action либо отсутствии
Read-like tool Bridge не угадывает referent. Cross-context association требует
локально affirmative executable clause: prefix и suffix соответствующей action
проверяются отдельно, поэтому negated, explanatory, conditional,
optional/modal, alternative и subordinate meta references не синтезируют
mandatory Read. Gate анализирует transition между конкретными actions, а не
global prompt, так что unrelated отрицание, explanation или условие о другом
файле в отдельной clause не отключает явный `Then read it`. Для этого D18
association выделяет direct mutation target до локальной границы clause, не
изменяя общий D13 action-group contract. Такое association синтезирует реальную
`file_verification` obligation, поэтому успешный Write не разрешает final до
fresh correlated Read result. Raw output вида `[调用 <allowed-tool>]
{...}` считается malformed tool intent: arguments не парсятся/исполняются,
модель получает bounded canonical repair, а raw marker не публикуется final.

`src/tools/toolRetry.ts` — максимум одна корректирующая попытка. Бесконечных
retry нет. Bridge не выполняет инструменты — он только сообщает клиенту, какой
инструмент запросила модель.

## Retry и отмена

- `DS_TIMEOUT_MS` — абсолютный deadline одного completion HTTP operation: от
  начала `fetch()` до authoritative SSE terminal и cleanup reader. Он покрывает
  ожидание headers, `reader.read()`, parsing и cancel/release.
- Completion POST автоматически не повторяется: после отправки нельзя доказать,
  что upstream generation не была создана. HTTP 429/5xx, transport failure и
  timeout возвращаются caller-у как typed retryable errors после одного attempt.
- Безопасное получение unused PoW challenge сохраняет bounded exponential retry;
  чтение его JSON body покрыто тем же timeout contract.
- New SSE успешен только при `response.status="FINISHED"` или patch
  `response/status → FINISHED`; old wire format — только при
  `response_message_done`. `INCOMPLETE`, empty stream и EOF до terminal дают
  `STREAM_INCOMPLETE`/502, malformed supported update —
  `STREAM_PARSE_FAILED`/502.
- После success terminal reader отменяется и освобождается без ожидания EOF;
  поздние chunks игнорируются. Timeout/failure abort-ит controller и выполняет
  best-effort cancel/release; raw body errors нормализуются в `UPSTREAM_ERROR`.
- HTTP 401/403 не повторяются бесконечно: сбрасывается удалённая сессия,
  пользователю предлагается `npm run auth`.
- Связь downstream disconnect с upstream abort относится к отдельной границе D4;
  D3 гарантирует cancellation-safe внутренний upstream lifecycle.

## Downstream Anthropic SSE lifecycle

Для streaming `/v1/messages` HTTP 200 фиксируется лениво первым SSE write —
`message_start`, а не при создании `ProtocolStream`. Поэтому ошибка до первого
event возвращается как обычный non-200 `application/json` с Anthropic envelope.

После `message_start` route преобразует failure в один terminal `event:error`.
Тип выбирается из безопасной Anthropic taxonomy (`authentication_error`,
`permission_error`, `rate_limit_error`, `timeout_error`, `conflict_error`,
`request_too_large`, `invalid_request_error`, `api_error`); arbitrary exception
message клиенту не передаётся. Error terminal не закрывает открытый content block
искусственно и не сопровождается `message_delta`/`message_stop`.

Anthropic usage следует contract `exact-or-unavailable`. Внутренний
`CanonicalResult.usage` зарезервирован только для точного upstream split
`promptTokens`/`completionTokens`: non-streaming response включает
`input_tokens`/`output_tokens` лишь при наличии обоих значений. Streaming
`message_start` отправляется немедленно без fabricated usage; успешный terminal
`message_delta` включает `output_tokens` только при известном точном
`completionTokens`, включая реальный zero. Если exact usage отсутствует, поле
не передаётся. V4 `response.accumulated_token_usage` распознаётся отдельно как
cumulative counter DeepSeek parent chain и не преобразуется в Anthropic usage;
локальные estimates также не рекламируются как authoritative counts.

`ProtocolStream` хранит минимальный terminal state `open | success | error`:
`finish()` и `fail()` idempotent и взаимоисключаемы, `push()` после terminal —
no-op. Для tool-use все обязательные lineage mappings сохраняются до публикации
tool block. Ошибка persistence поэтому даёт failure lifecycle без executable
`tool_use` у клиента. Связь downstream disconnect с upstream cancellation в эту
реализацию не входит и остаётся отдельным resource-lifecycle finding.

## Безопасность

Подробнее — в `docs/threat-model.md`. Ключевое:

- слушаем только `127.0.0.1`; не-loopback требует `PROXY_API_KEY` (>= 24 символов);
- CORS по умолчанию только loopback;
- лимит размера тела; таймауты запросов;
- логи с redaction: token, cookies, authorization, полные prompt и tool result
  не пишутся;
- `request_ref` связывает события одного HTTP-запроса и не отправляется в DeepSeek.

## Модели

`src/config/modelCapabilities.ts` — статическая таблица подтверждённых режимов:

```ts
interface ModelCapability {
  id: string;
  upstreamModelType: "default" | "expert";
  reasoning: boolean;
  search: boolean;
}
```

Live CDP capture текущего `chat.deepseek.com` подтвердил:

- Instant / V4 Flash → `model_type: "default"`;
- Expert / V4 Pro → `model_type: "expert"`;
- Thinking → отдельный `thinking_enabled` для обеих моделей;
- Search → отдельный `search_enabled`, доступный в текущем UI для Instant,
  но отсутствующий в Expert.

Upstream payload не содержит `model_name`; поле `response.model` сейчас пустое.
Названия V4 являются client-facing IDs Bridge и соответствуют официально
опубликованной DeepSeek связи Instant/Expert с Flash/Pro. `/v1/models` показывает
только эти две основные модели. `deepseek-chat`/`deepseek-reasoner` принимаются
как скрытые legacy aliases V4 Flash; второй alias включает Thinking по умолчанию.

## Диагностика

`npm run doctor` (src/diagnostics/doctor.ts) последовательно проверяет:
auth-файл, token/cookie, доступность DeepSeek, создание сессии, PoW challenge,
WASM, компиляцию, решение PoW, completion, SSE, reasoning, `response_message_id`
и capability probe. Последний тест отправляет случайный диагностический маркер и
проверяет, что он вернулся.

Обычные offline-тесты (`npm test`) не обращаются к аккаунту DeepSeek.

## Cross-platform platform abstraction

Web UI должен работать одинаково на Windows, macOS и Linux.
Backend определяет платформу через `process.platform` и предоставляет
capabilities клиенту. Пользователь НЕ выбирает ОС вручную.

### System capabilities API

`GET /api/system` возвращает JSON с `platform`, `folderPicker`,
`claudeCodeLaunch`, `openCodeLaunch`. Backend использует `process.platform`;
browser user-agent не участвует. Read-only endpoint публичен наравне с health.

### Platform-specific компоненты

| Компонент | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Folder picker | PowerShell / WinForms, UTF-8/Base64 | osascript / AppleScript | zenity → kdialog → manual input |
| CLI launch capability | ✅ live-подтверждена | Terminal.app / osascript (offline mocked) | x-terminal-emulator → gnome-terminal → konsole → xfce4-terminal → kitty → xterm (offline mocked) |
| Chrome auth | ✅ поддерживается | ✅ частично (live-test) | ✅ частично (live-test) |

### Нативный CLI launch

- Windows сохраняет прежний `launchProcess()` с проверенным Unicode `cwd`,
  detached/tracked child и `taskkill /T` только по PID запущенного Bridge процесса.
- macOS запускает статический AppleScript через `osascript`; пользовательский
  путь и CLI-аргументы передаются AppleScript как один POSIX-quoted аргумент, а
  не вставляются в AppleScript source. Terminal.app открывает новую видимую
  сессию. `~/` раскрывается backend в home directory.
- Linux использует отдельный argv-контракт каждого emulator. `shell:false`;
  пользовательский путь передаётся отдельным argv и как `cwd`, а не частью shell
  command string.
- macOS/Linux используют временный mode-0700 `sh` runner с фиксированным кодом.
  Он принимает cwd, Bridge env и CLI как argv, экспортирует
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_BASE`,
  `OPENAI_API_KEY`, записывает свой PID в private temp file и делает `exec` CLI.
- OpenCode получает только в дочернем процессе `OPENCODE_CONFIG_CONTENT` с
  custom provider `deepseek-bridge` и явный `--model
  deepseek-bridge/deepseek-v4-*`. Глобальные файлы конфигурации OpenCode не
  создаются и не изменяются.
- SHUTDOWN посылает signal только точному owned PID runner/CLI и точному launcher
  child. На Windows сохраняется `taskkill /PID <owned-pid> /T /F`; helper success
  не заменяет подтверждение target `exit`/`close`. На macOS Bridge дополнительно
  закрывает только созданное им окно Terminal.app, если совпадают window id + tty
  и в окне осталась одна вкладка. Terminal.app или terminal-emulator процессы не
  ищутся и не завершаются по имени.

### Graceful shutdown lifecycle

- `AppHandle.stop()` — единственный idempotent coordinator для server listener,
  tracked Web UI CLI/native launches и active auth Chrome. Concurrent/repeated
  calls возвращают тот же Promise; SIGINT, SIGTERM и `/bridge/shutdown` используют
  этот путь без отдельной cleanup implementation.
- HTTP shutdown endpoint сначала завершает acknowledgement
  `{"ok":true,"message":"Shutdown accepted."}`, затем запускает coordinator.
  Это исключает deadlock текущего request с `server.close()` и не утверждает, что
  cleanup уже завершён.
- Owned target termination имеет deadline 5 s, macOS exact-window helper — 2 s,
  весь shutdown — один absolute deadline 10 s. Cleanup разных owners начинается
  конкурентно, поэтому deadline не умножается на число processes.
- Signal/helper completion не считается доказательством target termination.
  Ownership удаляется только после observed `exit`/`close` либо подтверждения,
  что exact target уже отсутствует. Иначе coordinator возвращает
  `SHUTDOWN_INCOMPLETE`; entrypoint завершает Node с code 1. Success даёт code 0.
- Native PID capture является частью shutdown ownership boundary: shutdown ждёт
  PID file в пределах существующего target deadline. Неизвестный PID не
  доказывает отсутствие CLI; record/temp data сохраняются, а unresolved capture
  возвращает `SHUTDOWN_INCOMPLETE/native_pid_capture_timeout` и допускает retry.
  PID file принимается только как полная decimal string после trim; malformed или
  partial content не становится ownership target. После успешного launcher
  `spawn` долговечный lifecycle listener обрабатывает любое число последующих
  `error`: они не удаляют record/temp до подтверждённого termination и не
  превращают repeated cleanup retry в unhandled EventEmitter error.
- Shutdown не вызывает logout, не удаляет `auth.json`, credentials или Chrome
  profile. Logical auth abort закрывает CDP/SSE, но auth Chrome остаётся tracked
  до подтверждённого process exit; shutdown abort не посылает ранний
  `child.kill()`, чтобы Windows exact-PID tree cleanup сохранил root ownership.
  Logout по-прежнему не останавливает Bridge/CLI.

`claudeCodeLaunch`/`openCodeLaunch` означают наличие поддержанного visible-terminal
transport, а не установленного CLI binary. Наличие `claude`/`opencode` проверяется
при `POST /bridge/launch`; отсутствие даёт понятную SSE-ошибку. На macOS transport
доступен только при наличии `osascript` и Terminal.app; на Linux — только если
найден один из поддержанных emulator.

### Правила

- Backend является source of truth для capabilities.
- Web UI не определяет платформу через user-agent.
- Интерактивный CLI не запускается невидимо в фоне.
- Если picker недоступен — разрешается ручной ввод пути.
- Все picker-команды запускаются через `spawn` с `shell:false`; выбранный путь
  читается из UTF-8 stdout и не вставляется в shell command string.
- macOS/Linux picker и CLI launch покрыты platform-mocked offline-тестами, но
  требуют настоящих live-тестов на соответствующих ОС.
