# Журнал изменений

Все заметные изменения — здесь. Формат: `YYYY-MM-DD`, краткое описание, ссылка
на файлы. Статусы фаз и пробелы всегда актуализируются в `PROJECT_STATE.md`.

## 2026-08-19 — Add runtime tool completion guard

### Root cause

Prompt-only COMPLETION GUARD недостаточен. Live-test показал два типа ошибок:

1. **Fake tool trace**: модель выводит текст `Read file: D:\...\foo.txt` вместо
   настоящего tool_call JSON. Bridge не детектирует это как проблему и возвращает
   текст клиенту как финальный ответ.
2. **Premature final после цепочки tool_result**: модель заявляет о выполнении
   всех шагов, когда один или более шагов реально не выполнены (нет tool_result).

### Что сделано

**`src/tools/toolParser.ts`:**
- Добавлен `looksLikeFakeToolTrace()` — детектор псевдо-tool строк. Паттерны:
  `Read file:`, `Write file:`, `Edit file:`, `Create file:`, `Delete file:`,
  `Move/Rename file:`, `Run command:`, `Bash:`, `Command:`, `Exec:`,
  `ls`, `cat`, `mkdir`, `echo` и др. Если текст ≤2000 символов и содержит ≥1
  такую строку (или ≥2 при многострочности) при доступных tools — это fake trace.
- Добавлен `verifyFinalAnswer()` — верификатор завершённости: проверяет список
  pending actions (описание + fulfilled). Возвращает `{ complete, pendingActions }`.
- Добавлена константа `COMPLETION_GUARD_MAX_ATTEMPTS = 3` — лимит retry.

**`src/deepseek/client.ts`:**
- `shouldRetry()` теперь также детектирует fake tool traces через
  `looksLikeFakeToolTrace()`.
- `complete()` заменён с однократного retry на bounded completion guard loop:
  максимум `COMPLETION_GUARD_MAX_ATTEMPTS` попыток (initial + retries).
  После исчерпания лимита — возвращается честный ответ/ошибка.

### Новые тесты

`tests/unit/tools.test.ts` — 19 новых offline-тестов:

**looksLikeFakeToolTrace (10 тестов):**
1. `Read file: ...` обнаруживается как fake trace
2. `Write file: ...` обнаруживается как fake trace
3. Несколько Write/Read строк обнаруживаются
4. Обычный текст НЕ считается fake trace
5. Вопрос НЕ считается fake trace
6. Code block НЕ считается fake trace
7. `Bash: ...` обнаруживается
8. Нет tools → всегда false
9. Очень длинный текст → false
10. Пустой текст → false

**shouldRetry + fake traces (4 теста):**
11. Fake trace + tools → retry
12. Fake trace + real tool_call → no retry
13. Нормальный текст + tools → no retry

**verifyFinalAnswer (4 теста):**
14. Все действия fulfilled → complete
15. Часть не fulfilled → not complete
16. Все не fulfilled → not complete
17. Нет actions → complete

**COMPLETION_GUARD_MAX_ATTEMPTS (1 тест):**
18. Константа в диапазоне 2–5

### Итого

291 тест (16 файлов), все проходят.

## 2026-08-19 — Harden multi-step tool completion

### Что сделано

- `src/tools/toolPrompt.ts`: добавлены **COMPLETION GUARD** (rule 9) и **FINAL
  ANSWER RULES** (rule 10) в tool prompt:
  - Финальный ответ разрешён ТОЛЬКО когда ВСЕ действия из запроса реально
    выполнены через tool_call → tool_result;
  - Каждое действие файл/команда подтверждается реальным tool_result;
  - Запрет на подсчёт действий из текста, reasoning, history или compact summary;
  - После каждого tool_result проверяются невыполненные действия;
  - Запрет писать "создано", "прочитано", "выполнено" без tool_result;
  - Compact summary — только контекст, не доказательство выполнения;
  - Перечисление всех действий перед финальным ответом;
  - Честный отчёт об ошибках;
  - Дополнительная проверка при сомнениях.

### Новые тесты

`tests/unit/tools.test.ts` — 18 offline-тестов для completion guard:
1. Секция COMPLETION GUARD присутствует.
2. Секция FINAL ANSWER RULES присутствует.
3. Финальный ответ только при ВСЕХ действиях.
4. Требуется реальный tool_result.
5. Запрет на подсчёт из text/reasoning/history/compact.
6. Проверка после каждого tool_result.
7. Запрет на claim без tool_result.
8. Compact summary — только контекст.
9. Перечисление действий перед финальным ответом.
10. Требуется success indicator в tool_result.
11. Вызов tool при отсутствии tool_result.
12. Честный отчёт об ошибке.
13. Дополнительная проверка при сомнениях.
14. Rule 10a–e структура.

### Runtime-код

Не изменялся — только prompt-инструкции для модели.

### Итого

272 тестов (16 файлов), все проходят.

## 2026-08-19 — Live-test: path isolation confirmed

### Что сделано

- `PROJECT_STATE.md`: TODO про придуманные абсолютные пути закрыт (`[x]`).
  Зафиксирован результат live-test: два параллельных сессии с разными cwd
  (`D:\test CC NODE` и `D:\test 2`) создали файлы в своих каталогах без
  смешивания. `Test-Path` подтвердил изоляцию.

### Live-test (2026-08-19)

| Параметр | Значение |
| --- | --- |
| Session A cwd | `D:\test CC NODE` |
| Session A файл | `path-test-A.txt` = `AAA` |
| Session A reported path | `/d/test CC NODE/path-test-A.txt` |
| Session B cwd | `D:\test 2` |
| Session B файл | `path-test-B.txt` = `BBB` |
| Session B reported path | `/d/test 2/path-test-B.txt` |
| Isolation check | `Test-Path "D:\test 2\path-test-A.txt"` → `False` |
| Isolation check | `Test-Path "D:\test CC NODE\path-test-B.txt"` → `False` |

### Runtime-код

Не изменялся. Исправления — только в документации.

## 2026-08-19 — Harden tool path handling

### Что сделано

- `src/tools/toolPrompt.ts`: добавлены **PATH RULES** (rule 8a-f) в tool prompt:
  - cwd из system prompt — единственный source of truth для файловых путей;
  - запрет на изобретение абсолютных путей (`C:\Users\...`, `/home/...` и т.д.);
  - разрешение относительных путей от cwd;
  - при неизвестном cwd — запрос через Bash перед работой с файлами;
  - исключение для явных абсолютных путей пользователя.

### Тесты

- `tests/unit/tools.test.ts` — 6 новых offline-тестов для PATH RULES:
  1. Секция "PATH RULES (mandatory)" присутствует.
  2. CWD как source of truth.
  3. Запрет на изобретение абсолютных путей.
  4. Разрешение относительных путей от cwd.
  5. Проверка cwd через Bash при неизвестности.
  6. Исключение для явных путей пользователя.

### Итого

254 теста (16 файлов), все проходят.

## 2026-08-19 — Remove unused legacy PoW solver

### Что сделано

- `src/deepseek/pow.ts`: удалён `runLegacySha3()` (private, 45 строк) —
  мёртвый код, никогда не вызывался. `solve()` при `complexity > 0` сразу
  бросает `POW_CHALLENGE_FAILED` с сообщением "Legacy complexity challenges
  are no longer supported"; `difficulty > 0` идёт через `runWasmSolve()`.
  TODO про `maxAttempts=10_000_000` закрыт как неактуальный.

### Итого

248 тестов (16 файлов), все проходят.

## 2026-08-19 — Verify SESSION_ID_ENTROPY_BYTES = 16 (32 hex)

### Что сделано

- `tests/unit/sessions.test.ts` — 3 новых offline-теста для `generateSessionId()`:
  1. `SESSION_ID_ENTROPY_BYTES === 16`.
  2. `generateSessionId()` возвращает 32 hex-символа (`/^[0-9a-f]{32}$/`).
  3. 100 последовательных вызовов — все уникальны.
- `PROJECT_STATE.md` — TODO «Проверить SESSION_ID_ENTROPY_BYTES=16 (32 hex)» закрыт.

### Итого

248 тестов (16 файлов), все проходят.

## 2026-08-19 — Обработка истечения авторизации DeepSeek (401/403)

### Что сделано

- `src/deepseek/client.ts`: `ensureSession()`, `fetchChallenge()`, `runCompletion()` —
  унифицированный вывод ошибок при HTTP 401/403 с кодами `DEEPSEEK_HTTP_401` /
  `DEEPSEEK_HTTP_403` и единым сообщением «Run `npm run auth` and restart Bridge».
- `src/sessions/lineage.ts`: новый метод `removeByUpstreamKey(key)` — удаляет все
  связи lineage по upstreamKey и сохраняет в файл.
- `src/api/handler.ts`: `CompletionHandler.run()` — в catch-блоке при `DEEPSEEK_HTTP_401`
  или `DEEPSEEK_HTTP_403`: сброс сессии (`sessionStore.reset()`) + очистка lineage
  (`lineage.removeByUpstreamKey()`), лог `auth_expired_session_reset`.

### Тесты

- `tests/unit/authExpired401.test.ts` — 14 offline-тестов:
  1-2. ensureSession 401/403 → `DEEPSEEK_HTTP_401`/`DEEPSEEK_HTTP_403`.
  3-4. fetchChallenge 401/403 → `DEEPSEEK_HTTP_401`/`DEEPSEEK_HTTP_403`.
  5-7. complete 401/403 → correct code; other errors ≠ auth code.
  8-9. LineageStore.removeByUpstreamKey — removes / no-op.
  10-13. CompletionHandler — сброс сессии + lineage на 401/403, НЕ на 500.
  14. Множественные callId для одного upstreamKey.

### Итого

245 тестов (16 файлов), все проходят.

## 2026-08-19 — Устранение утечек секретов в логах

### Что исправлено

- `src/server/actions.ts`: `checkAuthStatus()`, `runDiagnosticsSSE`, `runAuthSSE` —
  удалены `token.slice(0, 12)` из всех сообщений, возвращаемых клиенту через
  `/bridge/auth-status`, `/bridge/auth` SSE и `/bridge/diagnostics` SSE.
- `scripts/auth.ts`: `printSummary()` — удалены `token.slice(0, 12)` и
  `cookie.slice(0, 12)` из вывода в консоль; теперь печатается только длина.
- `scripts/doctor.ts`: удалены отладочные `console.error("DEBUG ...")` строки
  в `completion SSE stream parsed`.
- `src/server/actions.ts` + `scripts/doctor.ts`: эндпоинт `/api/v0/auth/session`
  заменён на безопасный GET-запрос к `baseUrl` (root URL) для проверки
  доступности DeepSeek — без передачи токена/cookie/hif.

### Тесты

- `tests/unit/authSecretLeaks.test.ts` — 9 regression-тестов, проверяющих
  отсутствие `token.slice`, `cookie.slice`, `/api/v0/auth/session` и
  `console.error("DEBUG")` в исходниках.

## 2026-08-19 (Tool result name correlation fix)

### Live-тест после fix (b848a9d) — подтверждено

Read несуществующего файла → tool error → Bash(pwd) → Write recovery-ok.txt
→ Read recovery-ok.txt → финальный ответ. PowerShell подтвердил:
`Get-Content "D:\test CC NODE\recovery-ok.txt"` → `recovery successful`.

### Известная проблема: intent text вместо tool_call

На первый запрос DeepSeek ответил текстом:
"Я попробую прочитать несуществующий файл через Read."
После "давай" — повторил текст. Только после "действуй" начал tool-вызовы.

**Root cause**: `shouldRetry` в `client.ts:398` требует `content.trim() === ""`
для запуска retry. DeepSeek генерирует текст ("Я попробую..."), content
не пустой → retry не запускается. Модель описывает действие вместо
его выполнения, и текущий retry механизм это не ловит.

**Почему текущий retry пропускает**: retry срабатывает только когда
модель "замолчала" (пустой content, но reasoning есть). Когда модель
пишет intent-текст — content не пустой, retry пропускается.

## 2026-08-19 — Стабильная live-точка (полный coding workflow)

**Возможный minimal fix** (реализован):
- добавлен `looksLikeToolIntentText()` в `toolParser.ts` — детектирует
  intent-паттерны ("я попробую", "let me", "I'll run" и т.д.) когда
  tools доступны и content короткий (≤ 300 chars);
- `shouldRetry()` в `client.ts` расширен: retry срабатывает также
  когда content выглядит как намерение выполнить действие;
- это ДОПОЛНЕНИЕ к существующему retry (empty content + reasoning).

### Исправления

- `src/deepseek/client.ts` — `canonicalToRaw` передавал `toolUseId` как
  имя tool в `toolResultText`, из-за чего DeepSeek получал вместо
  `name: Read` / `name: Bash` / `name: Write` строку вида
  `name: call_abc123`. Исправлено: добавлена функция
  `buildToolUseIdMap()`, которая сканирует все `tool_use` части
  в messages и строит `Map<toolUseId, toolName>`.
  При обработке `tool_result` реальное имя tool извлекается из map.
  Неизвестный id → fallback `"unknown"`.

### Тесты

- `tests/unit/tools.test.ts` — 8 новых tests для `buildToolUseIdMap`:
  1. Read id=abc → name Read
  2. Bash id=xyz → name Bash
  3. Multiple different tool_uses
  4. Unknown id → fallback
  5. Error tool_result carries name correctly
  6. Chain: failed Read → Bash → Write
  7. Empty messages → empty map
  8. Ignores text and tool_result parts
- 14 новых tests для `looksLikeToolIntentText` и `shouldRetry` intent case:
  1. Russian intent with tool name → true
  2. Russian intent with action verb + object → true
  3. English intent with tool name → true
  4. English "I'll run" → true
  5. normal final answer → false
  6. question about tool → false
  7. long text > 300 → false
  8. no tools → false
  9. empty content → false
  10. intent without tool name or action object → false
  11. "давай я" + tool name → true
  12. "сейчас я" + action object → true
  13. "I can read" → true
  14. "I will create" → true
  15. shouldRetry: Russian intent → retry
  16. shouldRetry: English intent → retry
  17. shouldRetry: normal answer → no retry
  18. shouldRetry: question → no retry
  19. shouldRetry: long text → no retry
  20. shouldRetry: no tools → no retry
  21. shouldRetry: toolCall found → no retry
  22. shouldRetry: empty content + reasoning → retry (legacy)
  23. shouldRetry: empty content + no reasoning → no retry
  Итого 221 тест (14 файлов), все проходят.

## 2026-08-19 — Стабильная live-точка (полный coding workflow)

### Live-тест: параллельные Claude Code сессии — подтверждено

Session A (cwd `D:\test CC NODE`): `session-A2.txt` → `AAA2`
Session B (cwd `D:\test 2`): `session-B2.txt` → `BBB2`
Cross-check: файлы не смешиваются, lineage изолирован.

### Наблюдение (не баг)

DeepSeek однажды придумал абсолютный путь `C:\Users\Mi\session-B.txt`
вместо использования cwd `D:\test 2`. Изолированный случай.

### Live-тест: длинная цепочка 5+ tool-вызовов — подтверждено

8 последовательных шагов: создание файлов → чтение → объединение
→ переименование → повторное чтение → ls. PowerShell подтвердил.

### Live-тест: длинная сессия / compaction — подтверждено

12 exchanges + /compact. После compaction сохранились cwd, ALPHA-731,
BETA-482, контекст. Простой post-compact workflow прошёл успешно.
**Оговорка**: на сложной multi-step задаче после compaction —
premature final answer (модель заявила о создании файла, которого нет).

### Live-тест: большие tool_result — подтверждено

`large-result.txt` 18 500 байт прочитан через Read, цепочка
продолжилась, создан `large-result-ok.txt`. PowerShell подтвердил.

## 2026-08-19 (README аудит и синхронизация с реализацией)

### Исправления README

Полный аудит README против фактического содержимого репозитория.
Все утверждения, не соответствующие коду, исправлены:

- **Установка**: удалены ссылки на `START_DEEPSEEK.cmd` и `/setup`-панель.
  Описаны реальные шаги: `npm install` → `npm run auth` → `npm run doctor`
  → `npm start`. Добавлено упоминание `npm run ui` (текстовое меню).
- **Авторизация**: описание заменено на реальный процесс через Chrome CDP:
  перехват токена/cookies из запросов, проверка, сохранение в `data/auth.json`.
- **OpenCode**: удалено утверждение «панель предлагает готовый opencode.json».
  Приведён ручной пример подключения через `OPENAI_API_BASE`.
- **Документация**: удалены битые ссылки на `docs/protocols.md`,
  `docs/troubleshooting.md`, `docs/live-validation.md`. Оставлены только
  реально существующие документы. Добавлена ссылка на `docs/threat-model.md`.
- **Модели**: описание `/v1/models` исправлено: статический список
  (`deepseek-chat`, `deepseek-reasoner`), без обещания runtime-probe.

### Закрытые Priority 2 пункты (PROJECT_STATE.md)

Все 5 пунктов «расхождения README с кодом» отмечены как [x] resolved.

## 2026-08-19 (Cross-platform Web UI roadmap)

Зафиксирован архитектурный план полноценной кроссплатформенной поддержки
Web UI для Windows / macOS / Linux:

- Определение ОС через `process.platform` (автоматически, без выбора
  пользователем).
- Будущий `GET /api/system` для capabilities (endpoint не реализовывать).
- Folder picker: Windows (PowerShell), macOS (osascript), Linux (zenity).
- CLI launch: Windows (Terminal), macOS (Terminal.app), Linux (обнаружение
  терминального эмулятора).
- Chrome auth: уже частично кроссплатформенный; macOS / Linux — live-test.
- Web UI получает capabilities от backend, не определяет ОС через
  user-agent.

Добавлено в `PROJECT_STATE.md` и `docs/architecture.md`.

Подтверждено live-тестами Claude Code — полный workflow «кодирование через бридж»:

- Claude Code понимает cwd.
- Новая сессия не подтягивает старые задачи.
- Одиночные tool-вызовы работают.
- Последовательные tool-вызовы работают.
- Создание файлов работает.
- Редактирование файлов работает.
- Повторное чтение файлов работает.
- Запуск shell-команд работает.
- `npm test` запускается корректно.
- `tool_result` возвращается в DeepSeek.
- DeepSeek автоматически продолжает после `tool_result`.
- Multi-step coding workflow выполнен и VERIFIED (чтение + npm test).

## 2026-08-19 (Tool prompt: mandatory action execution)

### Исправления

- `src/tools/toolPrompt.ts` — переработан TOOL REQUEST SYSTEM prompt.
  Добавлены жёсткие правила:
  1. Если пользователь попросил действие и tool доступен — НЕ просить
     подтверждение, НЕ объяснять, НЕ показывать команду текстом —
     НЕМЕДЛЕННО вернуть tool_call JSON.
  2. Если задача требует чтения/записи файлов, листинга, запуска
     команд — текстовый ответ вместо tool_call запрещён.
  3. Запрещены фразы "я выполню...", "давайте выполним...",
     "используйте команду...", "ls ..." если операция доступна через tool.
  4. После tool_result — автоматическое продолжение: если нужен ещё
     один tool — вызвать сразу, если работа закончена — финальный ответ.
  5. "сделай это", "выполни", "да", "продолжай" — немедленный tool_call.

### Тесты

- `tests/unit/tools.test.ts` — 9 новых tests:
  1. содержит правило немедленного tool_call
  2. содержит запрет на подтверждение
  3. содержит запрет на текстовый ответ вместо tool_call
  4. содержит запрет на объяснение
  5. содержит запрет на команду как текст
  6. содержит автоматическое продолжение после tool_result
  7. содержит правило не ждать сообщение пользователя
  8. содержит немедленное выполнение на подтверждающие фразы
  9. содержит примеры запрещённых фраз
  Итого 190 тестов (14 файлов), все проходят.

## 2026-08-19 (DeepSeek parent message id type fix)

### Исправления

- `src/deepseek/updateParser.ts` — `UpdateChunk.messageId` и
  `UpdateChunk.parentMessageId` теперь `number` вместо `string`.
  Добавлена `parseMessageId()`: безопасное преобразование number/string
  в uint32 (0..4294967295), отбрасывание NaN/отрицательных/дробных.
  `applyInitialSnapshot` теперь сохраняет `response.message_id` как number
  (ранее `String()` превращал в строку). `applyOldData` парсит
  `message_id` и `new_parent_message_id` через `parseMessageId`.
- `src/sessions/sessionStore.ts` — `UpstreamSessionState.parentMessageId`:
  `string | null` → `number | null`. `ChatEntry.messageId`:
  `string | undefined` → `number | undefined`.
- `src/deepseek/client.ts` — `CompletionResult.parentMessageId`:
  `string | null` → `number | null`. Payload теперь отправляет
  `"parent_message_id": 2` (number) вместо `"parent_message_id": "2"`.

### Тесты

- `tests/unit/sse.test.ts` — 7 новых regression tests:
  1. message_id: 2 из initial snapshot → messageId === 2
  2. legacy numeric string "2" → messageId === 2
  3. invalid numeric string отбрасывается
  4. отрицательное число отбрасывается
  5. дробное число отбрасывается
  6. new_parent_message_id: numeric string → parentMessageId === 2
  7. new_parent_message_id: number → parentMessageId === 2
  Итого 181 тест (14 файлов), все проходят.

## 2026-08-19 (DeepSeek patch continuation fix)

### Исправления

- `src/deepseek/updateParser.ts` — убран `hasPathContext` guard с проверок
  fragment APPEND. Теперь bare `{v:"text"}` автоматически продолжает
  предыдущий APPEND через persisted `currentPath`/`currentOp`. Ранее
  bare values без собственных p/o полей отбрасывались → обрыв ответа
  ("Выпол", "{\"tool"). Добавлен фильтр FINISHED/INCOMPLETE: эти токены
  не попадают в content даже при активном fragment APPEND.

### Тесты

- `tests/unit/sse.test.ts` — 4 новых regression tests:
  1. tool call JSON, разбитый на 3 события, собирается полностью
  2. THINK APPEND → bare continuation идёт в reasoningDelta
  3. RESPONSE APPEND → bare continuation идёт в delta
  4. bare FINISHED после fragment APPEND не попадает в content
  Итого 174 теста (14 файлов), все проходят.

## 2026-08-19 (Anthropic SSE content blocks fix)

### Исправления

- `src/api/handler.ts` — `CompletionHandler.run()` теперь использует
  `result.content` напрямую вместо пустых callback-массивов `textChunks`/
  `reasoningChunks`. Ранее `callbacks.onText`/`onReasoning` никогда не
  вызывались → textChunks всегда пуст → Claude Code получал пустой ответ.
- `src/server/protocolStream.ts` — полная переработка Anthropic lifecycle:
  - Текст: `content_block_start` (`{type:"text", text:""}`) →
    `content_block_delta` (`{type:"text_delta"}`) → `content_block_stop`.
    Флаг `textBlockOpen` предотвращает дублирование start/stop.
  - Tool use: `content_block_start` теперь включает `input: {}`.
  - `closeTextBlock()` вызывается перед thinking/tool_use/finish для
    корректного закрытия текстового блока.
  - Индексы корректно инкрементируются для каждого блока.

### Тесты

- `tests/unit/sse.test.ts` — 10 новых regression tests:
  1. text: полный start/delta/stop lifecycle
  2. text: result.content появляется в SSE как text_delta
  3. text: несколько content push делят один text block
  4. text: индекс блока = 0
  5. tool_use: content_block_start содержит input:{}
  6. tool_use: правильный порядок событий
  7. tool_use: stop_reason = tool_use
  8. tool_use: нет text_delta в tool response
  9. reasoning: thinking блок отделён от text блока
  10. reasoning: индекс thinking инкрементируется за text блоком
  Итого 170 тестов (14 файлов), все проходят.

## 2026-08-19 (Anthropic tool streaming fix)

### Исправления

- `src/server/protocolStream.ts` — добавлен флаг `started` в `ProtocolStream`.
  `start()` теперь отправляет `message_start` SSE event для Anthropic и
  игнорирует повторные вызовы (dedup guard). Ранее `start()` никогда не
  вызывался → Claude Code не мог распарсить tool_use блок.
- `src/api/handler.ts` — `CompletionHandler.run()` теперь вызывает
  `stream.start()` перед любыми `stream.push()`. Гарантирует что
  `message_start` — первый SSE event в Anthropic streaming response.
- `src/deepseek/client.ts` — `complete()` теперь возвращает `content: ""`
  когда tool call обнаружен. Ранее возвращался raw tool_call JSON как текст,
  что приводило к дублированию: text block + tool_use block в non-streaming
  Anthropic response.
- `src/deepseek/updateParser.ts` — `DeepSeekPatchParser` теперь отслеживает
  `hasPathContext`: bare values `{v: "FINISHED"}` без собственных `p`/`o`
  полей больше не наследуют stale `currentPath` от предыдущего fragment APPEND.
  Также сбрасывает `currentPath`/`currentOp` после обработки status events.
  Предотвращает утечку "FINISHED" в fragment content.

### Тесты

- `tests/unit/sse.test.ts` — 7 новых тестов:
  1. message_start идёт раньше content_block_start для tool_use
  2. double start() не отправляет message_start дважды
  3. bare {v:"FINISHED"} после APPEND не засоряет delta
  4. bare {v:"FINISHED"} после THINK APPEND не засоряет reasoningDelta
  5. proper status event работает после reset
  6. toAnthropicMessage: tool_call → tool_use block, без text block
  7. toAnthropicMessage: text-only → text block, без tool_use block
  Итого 160 тестов (14 файлов), все проходят.

## 2026-08-19 (Local auth status + DeepSeek patch state machine)

### Исправления

- `src/server/actions.ts` — `checkAuthStatus()`: теперь полностью локальная
  (без HTTP-запроса upstream). Проверяет только наличие auth.json и наличие
  token/cookie. Возвращает "NO AUTH" если файла нет или нет credentials,
  "AUTH SVED" если есть token/cookie. Устраняет ложные "NO AUTH" из-за
  ненадёжного `/api/v0/auth/session`.
- `src/deepseek/updateParser.ts` — полная переработка в класс
  `DeepSeekPatchParser` с инстансным состоянием. Модульный глобальный state
  (`fragmentState`) заменён на экземпляр `currentPath`, `currentOp`,
  `fragments[]`, `status`. Каждый `runCompletion()` создаёт свой экземпляр
  парсера. Критический случай THINK→APPEND→text теперь корректно
  маршрутизируется в `reasoningDelta`.
- `src/deepseek/client.ts` — создаёт `new DeepSeekPatchParser()` на каждый
  `runCompletion()`. Парсер инкапсулирует state.
- `scripts/doctor.ts` — аналогично, создаёт свой экземпляр парсера.
- `src/deepseek/updateParser.ts` — удалены `resetFragmentState()` и
  `isTerminalUpdate()` (не нужны при инстансном подходе).

### Тесты

- `tests/unit/sse.test.ts` — переработаны для инстансного API (`new DeepSeekPatchParser()`).
  Добавлены: THINK→APPEND→text reasoning-only, RESPONSE→APPEND content-only,
  BATCH dispatch, два независимых инстанса. Итого 17 тестов.
- `tests/unit/authHifHeaders.test.ts` — переработаны: убраны 3 теста,
  ожидавшие HTTP-запрос от `checkAuthStatus` (теперь локальная). Добавлены
  тесты: AUTH SAVED, NO AUTH (нет файла), NO AUTH (пустые credentials),
  ноль HTTP-вызовов. Итого 6 тестов.
- Общее количество: 153 теста (14 файлов), все проходят.

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
