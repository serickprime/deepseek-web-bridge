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
логи с `request_ref` и redaction.

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
  `data/sessions.json` атомарно.
- `src/sessions/mutex.ts` — очередь на одну upstream-сессию: два параллельных
  новых пользовательских сообщения с одинаковым `parent_message_id` не уходят
  одновременно.

Правила:

- новый пользовательский ход без явного upstream identity — новая анонимная
  upstream-сессия (не общая и не «последняя активная»);
- tool result возвращается в исходную upstream-сессию по call-id;
- разные клиенты не смешиваются.

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

`src/tools/toolRetry.ts` — максимум одна корректирующая попытка. Бесконечных
retry нет. Bridge не выполняет инструменты — он только сообщает клиенту, какой
инструмент запросила модель.

## Retry и отмена

- Повторяются только: HTTP 429, временные 5xx, временные сетевые ошибки.
- Exponential backoff, максимум 2 повтора.
- HTTP 401/403 не повторяются бесконечно: сбрасывается удалённая сессия,
  пользователю предлагается `npm run auth`.
- При закрытии соединения клиентом upstream-запрос прерывается через
  `AbortController`.

## Безопасность

Подробнее — в `docs/threat-model.md`. Ключевое:

- слушаем только `127.0.0.1`; не-loopback требует `PROXY_API_KEY` (>= 24 символов);
- CORS по умолчанию только loopback;
- лимит размера тела; таймауты запросов;
- логи с redaction: token, cookies, authorization, полные prompt и tool result
  не пишутся;
- `request_ref` связывает события одного HTTP-запроса и не отправляется в DeepSeek.

## Модели

`src/config/modelCapabilities.ts` — таблица:

```ts
interface ModelCapability {
  id: string;
  modelType: string;
  reasoning: boolean;
  search: boolean;
  available: boolean;
  checkedAt?: number;
}
```

Доступность проверяется короткими запросами (runtime capability probe). Модель
попадает в `/v1/models`, только если probe подтвердил её. Не подтверждённые
режимы помечаются `UNKNOWN` и скрываются.

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
| CLI launch capability | ✅ live-подтверждена | ❌ до Terminal.app реализации | ❌ до terminal-emulator реализации |
| Chrome auth | ✅ поддерживается | ✅ частично (live-test) | ✅ частично (live-test) |

### Правила

- Backend является source of truth для capabilities.
- Web UI не определяет платформу через user-agent.
- Интерактивный CLI не запускается невидимо в фоне.
- Если picker недоступен — разрешается ручной ввод пути.
- Все picker-команды запускаются через `spawn` с `shell:false`; выбранный путь
  читается из UTF-8 stdout и не вставляется в shell command string.
- macOS/Linux picker покрыты platform-mocked offline-тестами, но требуют
  настоящих live-тестов на соответствующих ОС.
