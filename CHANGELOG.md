# Журнал изменений

Все заметные изменения — здесь. Формат: `YYYY-MM-DD`, краткое описание, ссылка
на файлы. Статусы фаз и пробелы всегда актуализируются в `PROJECT_STATE.md`.

## 2026-08-19 (Auth HIF headers + DeepSeek reasoning fragment routing)

### Исправления

- `src/server/actions.ts` — `checkAuthStatus()`: теперь читает `hifLeim`/`hifDliq`
  из auth.json (camelCase с fallback на legacy `hif_leim`/`hif_dliq`) и передаёт
  заголовки `x-hif-leim`/`x-hif-dliq` в запрос auth-status. Ранее HIF headers
  не отправлялись → false "NO AUTH" в панели.
- `src/server/actions.ts` — `runDiagnosticsSSE()`: upstream check теперь также
  передаёт `x-hif-leim`/`x-hif-dliq` из auth.json.
- `src/deepseek/updateParser.ts` — новый p/o/v формат теперь разделяет
  THINK и RESPONSE фрагменты. Fragment type (`frag.type`) определяет
  маршрут: `"THINK"` → `reasoningDelta`, `"RESPONSE"` → `delta`.
  APPEND события наследуют тип последнего snapshot-фрагмента.
  State сбрасывается при FINISHED. Старый формат не затронут.

### Тесты

- `tests/unit/sse.test.ts` — 8 новых тестов для THINK/RESPONSE routing:
  THINK → reasoningDelta, RESPONSE → delta, переключение THINK→RESPONSE,
  APPEND после THINK → reasoning, APPEND после RESPONSE → content,
  FINISHED сброс state, fragment без type наследует состояние,
  старый формат reasoning_content. Итого 16 тестов в файле.
- `tests/unit/authHifHeaders.test.ts` — 5 новых тестов:
  checkAuthStatus отправляет x-hif-leim (camelCase), x-hif-leim (legacy),
  x-hif-dliq + x-hif-leim; diagnostics отправляет x-hif-leim,
  diagnostics отправляет x-hif-dliq (legacy). Итого 151 тест.

## 2026-08-19 (Windows atomic file write fix)

### Исправления

- `src/utils/atomicFile.ts` — `writeJsonAtomic()`: на Windows (`process.platform === "win32"`)
  mode/chmod больше не применяется. На Windows writeFile вызывается без `mode` в options,
  а `chmod()` после rename не вызывается. Это решает проблему EPERM при rename/unlink
  и накопившихся `*.tmp` файлов, вызванных Unix-правами на NTFS.
- На Linux/macOS поведение сохранено: mode передаётся в writeFile + chmod после rename.
- Atomic rename механизм (temp → rename с fallback unlink на EEXIST/EPERM) сохранён.

### Тесты

- `tests/unit/atomicFile.test.ts` — 15 новых offline-тестов:
  1. writeJsonAtomic: запись и чтение обратно
  2. writeJsonAtomic: перезапись через atomic rename
  3. writeJsonAtomic: создание промежуточных директорий
  4. writeJsonAtomic: нет .tmp файлов после успешной записи
  5. win32: chmod НЕ вызывается
  6. win32: запись без mode option
  7. win32: перезапись работает без EPERM
  8. non-win32: chmod вызывается с указанным mode
  9. non-win32: chmod пропускается при undefined mode
  10. atomic rename fallback: повтор при EPERM через unlink
  11. fileMode возвращает биты прав
  12. fileMode возвращает null для несуществующего файла
  13. isOwnerOnlyMode: 0600 → true
  14. isOwnerOnlyMode: 0644 → false
  15. isOwnerOnlyMode: null → false. Итого 138 тестов.

## 2026-08-18 (DeepSeek re-authentication flow fix)

### Исправления

- `src/server/actions.ts` — `checkAuthStatus()`: HTTP 404 больше не считается
  признаком валидной авторизации. Теперь парсится JSON-енвелоп ответа:
  проверяется `code` (40003 → AUTH INVALID) и отображается реальное API-сообщение.
- `src/server/actions.ts` — `runDiagnosticsSSE()`: upstream check теперь
  требует HTTP 200 (ранее принимал 404).
- `src/server/actions.ts` — `runDoctorSSE()` pow challenge: проверяется
  `code`, `msg`, `data.biz_code`, `data.biz_msg` энвелопа. При ошибке
  API отображается реальное сообщение вместо "challenge format not recognized".
- `src/server/actions.ts` — `runAuthSSE()`: перед запуском Chrome очищается
  dedicated chromeProfile (`rm -rf chrome-profile`), чтобы cookies/localStorage
  старого аккаунта не смешивались с новым при re-auth.
- `src/server/actions.ts` — `runAuthSSE()`: после захвата credentials
  выполняется проверка через `POST /api/v0/chat_session/create` body `{}`.
  Если `code != 0` или `biz_code != 0`, auth.json НЕ сохраняется,
  отображается настоящая ошибка.
- `scripts/auth.ts` — аналогично: очистка dedicated chromeProfile + проверка
  credentials перед сохранением auth.json.
- `scripts/doctor.ts` — `deepseek reachable`: парсится JSON-енвелоп ответа
  (как в `checkAuthStatus`), HTTP 404 больше не считается OK.
- `scripts/doctor.ts` — pow challenge: добавлена проверка `code`/`biz_code`
  энвелопа перед `parseChallengePayload`.

### Тесты

- `tests/unit/authReliability.test.ts` — 18 новых тестов:
  1. checkAuthStatus: code 0 → valid
  2. checkAuthStatus: code 40003 → AUTH INVALID
  3. checkAuthStatus: code 40001 → AUTH INVALID with message
  4. checkAuthStatus: non-numeric code → valid
  5. checkAuthStatus: missing code → valid
  6. checkAuthStatus: code 500 with no msg → shows code number
  7. HTTP 404 is NOT treated as valid
  8. HTTP 403 returns invalid
  9. HTTP 200 + code 40003 → invalid
  10. pow: code 0, biz_code 0 → challenge parsed
  11. pow: code 40003 → API error
  12. pow: code 0, biz_code 10001 → biz error
  13. pow: code 0, biz_code 0, bad challenge → null
  14. session verify: code 0, biz_code 0 → ok
  15. session verify: code 40003 → invalid with msg
  16. session verify: code 0, biz_code 50001 → invalid with biz_msg
  17. session verify: biz_code without biz_msg → shows biz_code
  18. session verify: code -1 → shows code. Итого 123 теста.

## 2026-08-18 (Auth credential propagation fix)

### Исправления

- `src/app.ts` — `AuthFileShape` и `loadAuthFile`: читает `hifLeim`/`hifDliq`
  (camelCase, приоритет) с fallback на `hif_leim`/`hif_dliq` (legacy).
  Ранее читал только snake_case, теряя camelCase из `auth.json`.
- `src/utils/redaction.ts` — `collectAuthSecrets`: добавлены ключи
  `hifDliq`/`hifLeim` для redaction.
- `src/server/actions.ts` — `runDoctorSSE()`: читает `hifLeim`/`hifDliq`
  из auth.json (camelCase + legacy fallback) и передаёт `x-hif-leim`/`x-hif-dliq`
  во все запросы (pow challenge, session create, completion).
- `scripts/doctor.ts` — `requireAuthFile()`: читает `hifLeim`/`hifDliq`
  и передаёт `x-hif-leim`/`x-hif-dliq` во все запросы (pow challenge,
  session create, completion).

### Тесты

- `tests/unit/authCredentialPropagation.test.ts` — 10 новых тестов:
  1. collectAuthSecrets: camelCase hif ключи
  2. collectAuthSecrets: legacy snake_case hif ключи
  3. collectAuthSecrets: оба формата одновременно
  4. collectAuthSecrets: короткие значения не собираются
  5. DeepSeekClient: camelCase hifLeim → fetch headers
  6. DeepSeekClient: legacy hif_leim → fetch headers
  7. loadAuthFile: camelCase приоритет
  8. loadAuthFile: legacy fallback
  9. loadAuthFile: camelCase приоритет над legacy
  10. loadAuthFile: undefined когда нет hif ключей. Итого 105 тестов.

## 2026-08-18 (DeepSeek session creation fix)

### Исправления

- `src/deepseek/client.ts` — `ensureSession()`: тело запроса изменено
  `{ character_id: null }` → `{ }`. Добавлена полноценная проверка
  HTTP-статуса, `json.code`, `json.data.biz_code` перед чтением session id.
  При ошибке — информативное сообщение вида `DeepSeek session creation HTTP 400`,
  `DeepSeek API error: <code> <msg>`, `DeepSeek business error: <code> <msg>`.
  Приоритет чтения id: `data.biz_data.chat_session.id` → fallback `data.biz_data.id`.
- `src/server/actions.ts` — `runDoctorSSE()`: тело запроса `{ }` вместо
  `{ character_id: null }`.
- `scripts/doctor.ts`: тело запроса `{ }` вместо `{ character_id: null }`.

### Тесты

- `tests/unit/sessionCreateLimiter.test.ts` — 6 новых тестов:
  1. body = `{}` (не `{ character_id: null }`)
  2. чтение `data.biz_data.chat_session.id`
  3. fallback на `data.biz_data.id`
  4. HTTP error → descriptive message (не generic 400)
  5. `biz_code != 0` → upstream business error
  6. `code != 0` → API error с msg. Итого 95 тестов.

## 2026-08-18 (Graceful shutdown, folder picker 3-state)

### Исправления

- `src/server/routes.ts` — `/bridge/logout`: при ошибке `performLogout`
  сервер продолжает работать (отдаёт 500, не вызывает `process.exit`).
  При успехе вызывается `gracefulStop()` (остановка HTTP-сервера) перед
  `process.exit(0)`.
- `src/server/routes.ts` — `/bridge/shutdown`: вызывает `gracefulStop()`
  перед `process.exit(0)`.
- `src/server/routes.ts` — `RouteContext`: добавлен опциональный
  `gracefulStop?: () => Promise<void>`.
- `src/app.ts` — `buildApp()` прокидывает `server.stop()` как
  `routeContext.gracefulStop` после создания сервера.
- `src/server/actions.ts` — `pickFolder()` возвращает 3-состоятельный
  результат `{ path, cancelled, supported }` вместо `string | null`.
  На не-Windows: `{ path: null, cancelled: false, supported: false }`.
  При отмене: `{ path: null, cancelled: true, supported: true }`.
- `src/server/landingPage.ts` — `pickFolder()` UI: при отмене пользователя
  (cancel) тост не показывается; при unsupported OS — тост "Enter path
  manually".

### Тесты

- `tests/unit/bridgeConsole.test.ts` — 2 новых теста для `pickFolder()`:
  `supported=false` на Linux и на macOS. Итого 86 тестов.

## 2026-08-18 (Bridge Console shutdown route tests)

### Тесты

- `tests/unit/bridgeConsoleShutdown.test.ts` — 3 новых offline-теста:
  1. `pickFolder` cancel: `cancelled=true` при пустом stdout PowerShell.
  2. `/bridge/logout` при `ok:false` → HTTP 500, `gracefulStop` не вызывается,
     `process.exit` не вызывается.
  3. `/bridge/shutdown` → `stopLaunchedProcesses` вызывается, `gracefulStop`
     вызывается перед `process.exit(0)`. Итого 89 тестов.

## 2026-08-18 (Bridge Console: folder picker, logout, shutdown)

### Исправления

- `src/server/routes.ts` — `serveStaticAsset`: путь `/assets/x.png` теперь
  корректно резолвится в `public/assets/x.png` (ранее stripping `/assets/`
  давал `public/x.png`). Path-traversal protection сохранена.

### Новые endpoints

- `POST /bridge/pick-folder` — вызывает стандартный Windows FolderBrowserDialog
  через PowerShell, возвращает `{ "path": "D:\\Projects\\my-project" }`.
  На не-Windows — `{ "path": null, "message": "..." }`.
- `POST /bridge/logout` — удаляет `auth.json` и `chrome-profile/` (dedicated
  DeepSeek profile), останавливает launched процессы, затем завершает процесс.
  Не удаляет пользовательский Chrome profile.
- `POST /bridge/shutdown` — останавливает только tracked launched процессы
  (Claude Code / OpenCode, запущенные через панель), затем завершает сервер.
  Не убивает посторонние node/claude процессы.

### UI (Bridge Console)

- Кнопки LOGOUT и SHUTDOWN в header.
- `pickFolder()` — вызывает `/bridge/pick-folder`, вставляет путь в поле.
- `doLogout()` — confirm, вызов `/bridge/logout`, показ "Logged out. Bridge stopped."
- `doShutdown()` — вызов `/bridge/shutdown`, показ "Bridge stopped. You can close this tab.", `window.close()`.

### Процесс-трекинг

- `src/server/actions.ts` — `trackProcess()`, `stopLaunchedProcesses()`.
  Каждый `launchClaudeCode` / `launchOpenCode` автоматически трекается.
  Shutdown использует `taskkill /PID <pid> /T /F` на Windows.

### Тесты

- `tests/unit/bridgeConsole.test.ts` — 10 новых тестов:
  1. static asset path resolution (3 теста)
  2. path traversal detection
  3. encoded path traversal blocked
  4. performLogout удаляет auth.json
  5. performLogout удаляет chrome-profile
  6. performLogout ok если ничего нет
  7. stopLaunchedProcesses убивает tracked
  8. stopLaunchedProcesses не трогает untracked

**Итог**: `npm run typecheck` ✅, `npm test` ✅ (84/84), `npm run build` ✅.

## 2026-08-18 (rate-limit на создание DeepSeek chat sessions)

### Проблема

Claude Code отправляет много служебных/повторных запросов, каждый из которых
генерировал новый `upstreamKey` и вызывал `DeepSeekClient.ensureSession()` →
новый `chat_session` на DeepSeek. Слишком много чатов подряд.

### Решение

- `src/config/constants.ts` — добавлена `SESSION_CREATE_INTERVAL_MS = 2_000`.
- `src/utils/sessionCreateLimiter.ts` — **`SessionCreateLimiter`**: promise-chain
  сериализует конкурентные вызовы, `Date.now()` лимитирует интервал между
  созданиями. Не блокирует продолжения (existing `chatSessionId` обходится
  до лимитера).
- `src/deepseek/client.ts` — `ensureSession()`:
  1. `if (state.chatSessionId) return` — continuation без лимитера.
  2. `await sessionLimiter.acquire()` — ждёт свою очередь + интервал.
  3. Повторная проверка `chatSessionId` — если другой поток уже создал
     сессию пока ждали, пропускаем.
  4. `POST /api/v0/chat_session/create`.
- **Не затронуто**: tool parser, tool prompt, lineage, reasoning parser,
  Anthropic protocol, KeyedMutex.

### Тесты

- `tests/unit/sessionCreateLimiter.test.ts` — 7 новых тестов (линет
  минимум + DeepSeekClient.ensureSession через mock `globalThis.fetch`):
  1. сериализация конкурентных `acquire()`
  2. интервал между `acquire()`
  3. первый `acquire()` без задержки
  4. `ensureSession` с существующим `chatSessionId` — без запроса
  5. два быстрых `ensureSession` — последовательное создание
  6. интервал между `ensureSession` соблюдается
  7. `chatSessionId` существует — `fetch` не вызывается

**Итог**: `npm run typecheck` ✅, `npm test` ✅ (74/74), `npm run build` ✅.

## 2026-08-17 (tool calling — prompt-based emulation)

### Tool calling через промпт-эмуляцию

DeepSeek web API (`chat.deepseek.com/api/v0/`) **не поддерживает** нативный
tool/function calling — только API `api.deepseek.com`. Реализована prompt-based
эмуляция на основе `MikM32/Deepseek-API-Opencode`.

- `src/tools/toolPrompt.ts` — переписан: сильный system prompt с
  `<tool_call name="X"><param name="Y">VALUE</param></tool_call>` форматом,
  запрет JSON внутри тегов, обязательные инструкции и примеры.
- `src/tools/toolParser.ts` — множественные стратегии парсинга:
  1. `<tool_call name="X"><param>...</param>` — XML формат (приоритет)
  2. `<tool_call name="X">{JSON}</tool_call>` — JSON fallback
  3. `<tool_call>{"name":"X",...}</tool_call>` — старый формат
  4. `{"tool_call":{"name":"X",...}}` — JSON без тегов
  5. Эвристика: поиск имени тулзы в тексте + `<param>` теги
  Защита от prototype pollution сохранена.
- `src/deepseek/client.ts` — `complete()` теперь:
  - Строит tool prompt из `request.tools` при каждом запросе
  - Использует `parseToolInvocation()` вместо regex для детекции tool call
  - Формат tool results для upstream: `<param>` теги вместо JSON
  - Tool call ID генерируется один раз для SSE и результата
- `src/api/normalizeAnthropic.ts` — `normalizeTools` читает `input_schema`
  для Anthropic формата `{name, description, input_schema}`.

### Тесты
- `tests/unit/tools.test.ts`: добавлены 3 теста для JSON extraction из текста,
  18/18 проходят. Всего: **49/49**.

### Исправления tool calling (2026-08-17)
- `src/tools/toolParser.ts`: `extractToolCallFromText` — извлекает JSON
  `{"tool_call":{...}}` или `{name, arguments}` из prose-text модели.
- `src/tools/toolParser.ts`: `inspectToolCallFromOutput` сканирует и reasoning.
- `src/tools/toolParser.ts`: строгая валидация `tool_call` объекта — 2 ключа,
  prototype pollution protection.
- `src/deepseek/client.ts`: `shouldRetry` retry если tools запрошены, но
  tool call не обнаружен.
- `src/deepseek/client.ts`: убрана дублирующая system prompt в buildUpstreamPrompt.
- `src/api/normalizeOpenAI.ts`: чтение `function.name` из вложенного
  OpenAI формата `{type: "function", function: {name}}`.
- `src/tools/toolPrompt.ts`: FreeDeepseekAPI формат — `JSON.stringify(safe)`.

### Live-тест tool calling (2026-08-17)
- **Live-тест (1)**: 0/5 — модель игнорирует tool calling через web API.
- **Live-тест (2)**: **5/5** — после переключения на FreeDeepseekAPI формат
  (`{"tool_call":{...}}`), JSON-within-text extraction, retry, и исправления
  OpenAI normalization.

### Исследование GitHub проектов
- `deepseek-bridge`, `cursor-deepseek`, `deepseek-proxy` — используют
  официальный API с ключом.
- `MikM32/Deepseek-API-Opencode` — единственный с web API, наша основа.
- `deepseek-chat`/`deepseek-reasoner` deprecated (с 2026-07-24).
  Текущие модели: `deepseek-v4-flash`, `deepseek-v4-pro`.

---

## 2026-08-17 (UI redesign — Bridge Console)

### Redesign of local web interface (`GET /`)

- `src/server/landingPage.ts` — полная переработка HTML/CSS/JS:
  компактная «Bridge Console» вместо лендинг-страницы; тёмная палитра Mileo
  (#020101 фон, #FD1000 акценты, #E5E3E3 текст); two-panel layout
  (Connection + Session); статусные индикаторы с LED-точками; модели через
  `<select>` из `/v1/models`; Working Directory input; RUN CLAUDE CODE /
  RUN OPENCODE кнопки; toggleable diagnostics terminal; toast notifications;
  responsive breakpoints (860/768/480px).

- `src/server/routes.ts` — статический роут `GET /assets/*` для serving файлов
  из `public/assets/`; MIME-типы PNG/JPG/SVG/CSS/JS/JSON; path traversal
  protection через `resolve()` + `startsWith()`.

- `src/server/server.ts` — `matchPath` теперь поддерживает prefix matching
  (`/assets/*` → любой путь под `/assets/`).

- `src/server/middleware.ts` — `isPublicPath` теперь пропускает любые пути
  `/assets/*` без API-ключа.

- `public/assets/bridge-network-map.png` — изображение для баннера консоли.

---

## 2026-08-17 (полный live-пайплайн)

### Критические исправления для работы через сервер

**Проблема 5: Non-streaming crash — null ProtocolStream**
- `src/server/routes.ts` — `buildProtocolStream` теперь всегда возвращает
  `ProtocolStream` (no-op write для non-streaming вместо `null`), убран
  `null as unknown as ProtocolStream` cast.

**Проблема 6: Anthropic normalizer дефолт stream: true вместо false**
- `src/api/normalizeAnthropic.ts` — `stream` теперь дефолтится в `false`
  (как в реальном Anthropic API), было `true`.

**Проблема 7: Upstream возвращает JSON-ошибку вместо SSE**
- `src/deepseek/client.ts` — добавлена детекция JSON-ответа от upstream
  (`{"code":0,"data":{"biz_code":6,...}}`); ошибки `biz_code !== 0`
  корректно бросают `BridgeError`.

**Проблема 8: Пустой `prompt` в payload → `biz_code: 6 missing prompt`**
- `src/deepseek/client.ts` — `buildPayload` теперь заполняет `prompt`
  из системного промпта или последнего user-сообщения; `messages` получают
  обязательные `id` и `content_type: "text"`.

**Проблема 9: SSE-события нового формата не распознавались**
- `src/deepseek/updateParser.ts` — три типа событий DeepSeek:
  1. `{ v: { response: { fragments: [...] } } }` — инкрементальный контент
  2. `{ v: "text" }` — plain token delta (v строка, не объект!)
  3. `{ p: "response/fragments/-1/content", o: "APPEND", v: "text" }`
  4. `{ p: "response/status", o: "SET", v: "FINISHED" }` — терминальное
  Старый формат `{ data: { type: "...", message: { content: "..." } } }`
  сохранён как fallback.

### Результат
- `npm run test:live` — все проверки проходят (health, models,
  chat/completions → "pong", messages → "pong").
- `npm run doctor` — 6/6.
- Streaming: токен-за-токнем вывод корректный для длинных ответов.
- Non-streaming: полный ответ накапливается и возвращается как JSON.

## 2026-08-13 (live-подключение к DeepSeek)

### Критические исправления для работы с реальным DeepSeek API

**Проблема 1: `x-ds-pow-response` должен быть base64-encoded**
- `src/deepseek/client.ts` — `x-ds-pow-response` теперь `Buffer.from(json).toString("base64")`
  вместо `JSON.stringify(...)`. DeepSeek возвращает `40300 MISSING_HEADER` если
  значение не base64.
- `scripts/doctor.ts` — аналогичное исправление.

**Проблема 2: PoW answer должен быть числом, не строкой**
- `src/deepseek/pow.ts` — `PowSolution.answer: number` (был `string`).
  `runWasmSolve` возвращает `answerFloat` напрямую без `String()`.
  DeepSeek возвращает `40301 INVALID_POW_RESPONSE` если ответ — строка.

**Проблема 3: SSE-формат DeepSeek полностью изменился**
- `src/deepseek/sseParser.ts` — безымянные SSE-события (без `event:` строки)
  теперь маппятся на `"update"` вместо `"other"`.
- `src/deepseek/updateParser.ts` — новый формат данных:
  `{ v: { response: { fragments: [{ content: "..." }], status: "FINISHED" } } }`
  и пакетные обновления `{ p: "response/status", o: "SET", v: "FINISHED" }`.
  Старый формат `{ data: { type: "...", message: { content: "..." } } }`
  сохранён как fallback.

**Проблема 4: Устаревшие заголовки**
- `src/config/constants.ts` — `x-client-version: "2.3.0"` (было `"1.8.0"`),
  User-Agent Chrome 151 (был 136), sec-ch-ua обновлён.
- `scripts/auth.ts` — `hif_leim` теперь читается из `localStorage("hif_leim_cached")`
  (канонический источник), а не из сетевых заголовков.

### Результат
- `npm run doctor` — все 6/6 проверок проходят (auth, reachable, challenge,
  pow, completion SSE, completion content).
- `npm test` — 41/41, typecheck чистый.

## 2026-08-13 (веб-интерфейс)

### Лендинг-статус в стиле Mileo (Vektora Web)
- `src/server/landingPage.ts` — самодостаточный HTML-лендинг (тёмный,
  сине-фиолетовые градиенты, glassmorphism-карточки, glow, анимированный
  терминал): hero, секции «Live status» / «Protocols» / «Setup», CTA, footer.
  Никаких внешних зависимостей — всё инлайн (CSS + JS).
- Живой статус на странице: `/health`, `/readyz`, `/v1/models`, `/v1/sessions`
  опрашиваются каждые 5 секунд; секреты не выводятся.
- `src/server/routes.ts` — новый маршрут `GET /` (отдаёт `LANDING_PAGE_HTML`);
  `middlewareWrapper` пропускает публичные пути без API-ключа.
- `src/server/middleware.ts` — `PUBLIC_PATHS` / `isPublicPath()` (`/`, `/health`,
  `/readyz`, только GET) — безопасно: только read-only эндпоинты без ключа.
- `/v1/models`, `/v1/sessions` остаются под API-ключом для не-loopback.

## 2026-08-13

### Реализован каркас и все три слоя проекта
- **Каркас**: `package.json` (ESM, Node>=20), `tsconfig.json`/`tsconfig.build.json`,
  `vitest.config.ts`, `.gitignore`, `.env.example`, `README.md`, `SECURITY.md`,
  `docs/architecture.md`, `docs/threat-model.md`.
- **Конфиг**: `src/config/constants.ts`, `src/config/env.ts` (env + .env,
  loopback-проверка, PROXY_API_KEY >= 24 символов).
- **Утилиты** (`src/utils/`): `errors.ts` (BridgeError с кодами/HTTP-статусами),
  `crypto.ts` (constant-time compare, randomToken, sha256, hmacFingerprint),
  `json.ts` (isRecord/isPlainObject/safeJsonParse/deepClone),
  `redaction.ts` (Redactor + isSensitiveKey + collectAuthSecrets),
  `atomicFile.ts` (writeJsonAtomic/readJsonIfExists с правами 0600),
  `logger.ts` (JSON-logs с request_ref и redaction),
  `tokenEstimate.ts` (оценка токенов, включая CJK).
- **Auth-слой** (`src/auth/`): `session.ts`, `storage.ts` (файловое хранилище),
  `sessionManager.ts` (create/list/remove/purge/touch, TTL, лимит записей).

### Протокольный слой
- `src/api/canonical.ts` — внутренний формат CanonicalRequest/Message/Tool/Chunk.
- `src/api/normalizeOpenAI.ts`, `normalizeAnthropic.ts`, `normalizeResponses.ts`,
  `normalizeByProtocol.ts` — нормализация трёх протоколов (включая tool_calls,
  tool results, thinking, system prompt, max_tokens).
- `src/api/handler.ts` — CompletionHandler: identity, mutex, upstream-вызов,
  SSE-пуш, lineage для call-id.

### DeepSeek-слой
- `src/deepseek/pow.ts` — PoW: загрузка/кэш WASM, решение sha3 с префиксом
  нулей, парсинг challenge.
- `src/deepseek/sseParser.ts` — SseAccumulator + parseSseBlock.
- `src/deepseek/updateParser.ts` — парсинг `update`-событий (delta, reasoning,
  message_id, parent_message_id, usage).
- `src/deepseek/client.ts` — оркестратор: session create, challenge → solve →
  completion, ретраи (429/5xx, backoff), 401/403, AbortController, tool-парсинг.

### Серверный слой
- `src/server/middleware.ts` — API key, CORS, лимит тела, readBody.
- `src/server/outputOpenAI.ts`, `outputAnthropic.ts`, `outputResponses.ts` —
  адаптеры JSON-вывода и SSE-хелперы.
- `src/server/protocolStream.ts` — SSE-обрамление для трёх протоколов.
- `src/server/routes.ts` — таблица маршрутов (`/health`, `/readyz`, `/v1/models`,
  `/v1/sessions` CRUD, `/v1/chat/completions`, `/v1/responses`, `/v1/messages`,
  OPTIONS).
- `src/server/server.ts` — BridgeServer (node:http, request_ref, матчинг путей).
- `src/app.ts`, `src/index.ts` — сборка зависимостей и entrypoint.

### Sessions / Tools
- `src/sessions/`: `sessionStore.ts`, `mutex.ts` (KeyedMutex), `sessionResolver.ts`,
  `lineage.ts`.
- `src/tools/`: `toolPrompt.ts`, `toolParser.ts` (безопасный парсинг tool_call,
  защита от prototype pollution, подсчёт скобок), `toolRetry.ts`.

### Скрипты (`scripts/`)
- `cdp.ts` — CDP-клиент (запуск Chrome, WebSocket, команды).
- `auth.ts` — захват token/cookie/hif через сеть + localStorage fallback,
  сохранение `data/auth.json` (0600).
- `doctor.ts` — последовательная диагностика с реальным запросом.
- `launcher.ts` — меню (auth/doctor/start).
- `start.ts` — запуск сервера из скрипта.
- `live/run.ts` — smoke-тест по HTTP.

### Тесты
- `tests/unit/`: redaction, tokenEstimate, sse, tools, normalize, sessions.
   Итог: **45 тестов, все зелёные** (`npm test`).
- `npm run typecheck` и `npm run build` — без ошибок.

### Известные ограничения на дату
- Реальный вход в DeepSeek через `npm run auth` не завершён пользователем —
  `data/auth.json` отсутствует, поэтому `doctor`/`test:live` не прогнаны.
- README содержит упоминания несуществующих артефактов (setup-панель,
  `START_DEEPSEEK.cmd`, `opencode.json`, часть `docs/*.md`) — см. TODO в
  `PROJECT_STATE.md`.
