# Состояние проекта

> **Актуально на:** 2026-08-19.
> Этот файл — главный источник правды о стадии проекта. Любой агент обязан
> прочитать его перед началом работы и обновить после внесения изменений.
> Обязательный порядок чтения перед задачей: `AGENTS.md` → `PROJECT_STATE.md`
> → `docs/architecture.md` → `docs/threat-model.md`.

## Кратко

**DeepSeek Web Bridge** — локальный HTTP-мост, который превращает вашу
авторизованную веб-сессию `chat.deepseek.com` в локальный API, совместимый с
OpenAI Chat Completions, OpenAI Responses и Anthropic Messages. Основные клиенты:
Claude Code, OpenCode, любой OpenAI-совместимый SDK.

Проект использует **неофициальные** внутренние маршруты веб-сайта DeepSeek
(`/api/v0/chat/completion`), требует PoW (sha3 через WASM) и живую авторизованную
сессию. DeepSeek может менять внутренние API — проект рассчитан на периодическое
обновление.

## Ключевая цель / что должно получиться

Рабочая цепочка «из коробки»:

1. `npm run auth` — открыть Chrome, войти в DeepSeek (вручную, CAPTCHA/2FA),
   сохранить `data/auth.json` (token + cookie + hif-заголовки, права 0600).
2. `npm run doctor` — все проверки зелёные (auth, доступность, PoW, session,
   completion SSE).
3. `npm start` — сервер на `http://127.0.0.1:9655`.
4. Клиенты подключаются:
   - Claude Code: `ANTHROPIC_BASE_URL=http://127.0.0.1:9655`,
     `ANTHROPIC_AUTH_TOKEN=local-key`, модель `deepseek-reasoner`;
   - OpenCode: `OPENCODE_CONFIG=opencode.json`, модель `deepseek-web/deepseek-reasoner`;
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
- `scripts/` — auth (CDP), doctor, launcher, start, live-тест.
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
| 10. Тесты | 16 файлов, 291 offline-тест | ✅ готово |
| 11. Скрипты | cdp, auth, doctor, launcher, live | ✅ live-часть работает |
| 12. Веб-интерфейс | Bridge Console на `GET /` (Mileo dark theme, two-panel, diagnostics, model picker) | ✅ готово |

**Проверки сейчас:**
- `npm run typecheck` — ✅ без ошибок.
- `npm run build` — ✅ собирается.
- `npm test` — ✅ 291/291.
- `npm run auth` — ✅ окно Chrome открывается, захват работает (сеть + localStorage
  fallback).
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
- Сессии: `SessionStore` (история с лимитами), `KeyedMutex` (последовательность
  для одной upstream-сессии), `SessionResolver` (client identity vs upstream
  identity), `LineageStore` (связь call-id → upstream-сессия в sessions.json).
- Сервер: роутинг, middleware (API key, CORS, лимит тела, request_ref),
  SSE-вывод для трёх протоколов, JSON-вывод для non-streaming (no-op
  ProtocolStream вместо null), `/health`, `/readyz`, `/v1/models`,
  `/v1/sessions` (CRUD), `/v1/chat/completions`, `/v1/responses`,
  `/v1/messages`, `/bridge/pick-folder`, `/bridge/logout`, `/bridge/shutdown`.
  `/bridge/logout` при ошибке удаления файлов отдаёт 500 и не завершает процесс;
  при успехе вызывает `gracefulStop()` → `process.exit(0)`.
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
  Working Directory input с реальным folder picker (PowerShell FolderBrowserDialog,
  3-состоятельный: path/cancelled/unsupported),
  кнопки запуска Claude Code / OpenCode, кнопки LOGOUT (удаляет auth + profile
  и останавливает Bridge) и SHUTDOWN (останавливает только tracked процессы
  и Bridge), toggleable diagnostics terminal с имитацией проверок,
  toast notifications. Статические файлы `GET /assets/*` (PNG, CSS, JS) с
  path-traversal protection. Публичные пути: `/`, `/health`, `/readyz`,
  `/assets/*` (GET).
- Безопасность: redaction секретов в логах, 0600 для auth/sessions файлов (Unix; на Windows без chmod для совместимости с NTFS),
  loopback-проверка + PROXY_API_KEY для не-loopback, CORS по умолчанию только
  loopback, ограничение глубины/размера tool аргументов, защита от
  `__proto__`/`prototype`/`constructor`.
  `checkAuthStatus()` и diagnostics передают `x-hif-leim`/`x-hif-dliq` из auth.json
  (camelCase + legacy fallback) во все upstream-запросы.
- Скрипты: `auth` (CDP, читает hif_leim из localStorage), `doctor` (6 последовательных
  чеков + реальный completion-запрос), `launcher` (меню), `live/run` (smoke-тест).

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
Текущие модели: `deepseek-v4-flash` и `deepseek-v4-pro`.

## Стабильная live-точка — 2026-08-19

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
  **Оговорка**: на сложной multi-step задаче после compaction модель
  заявила о создании файла, который реально отсутствовал
  (premature final answer). **Prompt fix implemented**: COMPLETION GUARD
  + FINAL ANSWER RULES в tool prompt. Требуется post-/compact live-test.
- Большие `tool_result` (>10 000 символов): `large-result.txt`
  18 500 байт прочитан через Read, цепочка продолжилась,
  создан `large-result-ok.txt`. PowerShell подтвердил.

### Области, ещё не проверенные live-тестами

Не являются багами — просто не проверялись:

_(все проверены)_

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
- [x] **`/v1/models` — «runtime probe»** — README исправлен: описан
      статический список из 2 моделей (`deepseek-chat`, `deepseek-reasoner`).

### Приоритет 3 (улучшения, не блокеры)
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
- [~] После compaction на сложной multi-step задаче модель может
      заявить о выполнении (premature final answer) без фактического
      вызова всех нужных tools. **Prompt fix implemented** (rule 9-10)
      + **runtime completion guard implemented**: fake tool trace
      detector (`looksLikeFakeToolTrace`), bounded retry loop
      (max 3 attempts), final answer verifier (`verifyFinalAnswer`).
      19 offline-тестов (`tools.test.ts`). Требуется повторный
      post-/compact live-test.

### Cross-platform Web UI (архитектурный план)

Цель: пользователь на Windows / macOS / Linux имеет одинаковый сценарий:
`clone` → `npm install` → `npm run auth` → `npm start` → открыть
`http://127.0.0.1:9655` → пользоваться Web UI без ручного выбора ОС.

**Статус**: план. Runtime-код не реализуется до отдельного решения.

#### 1. Определение ОС

Backend определяет платформу через `process.platform`:
- `win32` → Windows
- `darwin` → macOS
- `linux` → Linux

Пользователь НЕ выбирает ОС вручную. Backend является source of truth.

#### 2. System capabilities API (будущий endpoint)

`GET /api/system` — возвращает capabilities текущей ОС:

```json
{
  "platform": "darwin",
  "folderPicker": true,
  "claudeCodeLaunch": true,
  "openCodeLaunch": true
}
```

Endpoint сейчас не реализовывать.

#### 3. Folder picker

- **Windows**: PowerShell / `System.Windows.Forms` (текущий механизм).
- **macOS**: системный picker через `osascript` / AppleScript.
- **Linux**: `zenity` / `kdialog` или fallback на ручной ввод пути.

Если picker недоступен — Web UI разрешает ручной ввод пути.

#### 4. Запуск Claude Code / OpenCode

- **Windows**: Windows Terminal / PowerShell (текущий механизм).
- **macOS**: интерактивный CLI через `Terminal.app` или совместимый терминал.
- **Linux**: обнаружение терминального эмулятора:
  `x-terminal-emulator`, `gnome-terminal`, `konsole` и т.п.

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
