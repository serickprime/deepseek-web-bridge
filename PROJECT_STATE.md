# Состояние проекта

> **Актуально на:** 2026-08-21.
> Этот файл — главный источник правды о стадии проекта. Любой агент обязан
> прочитать его перед началом работы и обновить после внесения изменений.
> Обязательный порядок чтения перед задачей: `AGENTS.md` → `PROJECT_STATE.md`
> → `docs/architecture.md` → `docs/threat-model.md`.

## Кратко

**DeepSeek Web Bridge** — локальный HTTP-мост, который превращает вашу
авторизованную веб-сессию `chat.deepseek.com` в локальный API, совместимый с
OpenAI Chat Completions, OpenAI Responses и Anthropic Messages. Основные клиенты:
Claude Code, OpenCode, любой OpenAI-совместимый SDK.

**Текущий активный фокус:** надёжность tool calling для Claude Code. Изменения
OpenCode в этой итерации deferred и не являются текущим приоритетом.

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
| 10. Тесты | 25 файлов, 451 тест | ✅ готово |
| 11. Скрипты | desktopStart, cdp, auth, doctor, launcher, live, real-OS platform smoke | ✅ live-часть работает |
| 12. Веб-интерфейс | Bridge Console на `GET /` (Mileo dark theme, two-panel, diagnostics, model picker) | ✅ готово |

**Проверки сейчас:**
- `npm run typecheck` — ✅ без ошибок.
- `npm run build` — ✅ собирается.
- `npm test` — ✅ 451/451.
- `npm run test:platform` — ✅ локально на Windows: real process/platform,
  `buildConfig`, Bridge HTTP, Unicode cwd и env propagation без DeepSeek auth.
- `npm run auth` / Web UI AUTH — ✅ Bearer захватывается из сети, HIF читается из
  localStorage при наличии; отсутствие HIF допустимо только после успешной upstream-верификации.
- `npm run doctor` — ✅ все 6/6 проверок проходят (auth, reachable, challenge,
  pow solved, completion SSE parsed, completion content).
- `npm run test:live` — ✅ все проверки проходят (health, models, chat/completions,
  messages).

## Что уже реализовано (детали)

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
- Upstream-клиент: создание `chat_session_id`, completion с ретраями на 429/5xx
  (backoff), 401/403 → отдельные ошибки, AbortController по таймауту.
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
  `stream.push()`, отправляет `message_start` для Anthropic streaming;
  dedup guard предотвращает повторные вызовы.
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
