# Журнал изменений

Все заметные изменения — здесь. Формат: `YYYY-MM-DD`, краткое описание, ссылка
на файлы. Статусы фаз и пробелы всегда актуализируются в `PROJECT_STATE.md`.

## 2026-08-24 — Align allowed and described tool catalogs

- D7 PASS B удалил отдельный 32-tool cap из `buildToolPrompt()`: после
  case-insensitive фильтрации недоступного `Artifact` prompt теперь описывает
  весь authoritative available catalog в исходном порядке. Parser/handler
  allowlist, duplicate policy, 1000-char description bound и текущая
  top-level-only schema representation не менялись.
- Добавлены 17 deterministic regressions для каталогов 0/1/32/33/35/39,
  Artifact в разных позициях, ordering/duplicates, реального handler
  `tool_use` и `tool_result` continuation для 33+ tool, unknown rejection и
  description cap. PB14 покрывает только catalog identity, PB18 — 34th+/unknown,
  PB20 — catalog stability.
- D11 full nested schema fidelity намеренно остаётся открытым и защищён
  отдельным negative control. D7 переведён в `IMPLEMENTED / VERIFYING`; до
  independent/live verification не закрывается, число открытых P1 остаётся 3.

## 2026-08-24 — Close D5 after live verification

- D5 implementation commits `3614d4b` и `051e3ec` прошли independent review;
  deterministic PB31/PB32 остаются authoritative evidence точной TTL boundary,
  expired lookup, durable init pruning, newest correlated current-cycle result,
  orphan/historical rejection и header/result fallback/conflict. Baseline PASS:
  32 files / 672 tests, typecheck, build, Windows `test:platform` и
  `git diff --check`.
- Windows live verification на Claude Code 2.1.241 и
  `deepseek-v4-flash`: Bridge cleanly остановился и успешно запустился снова;
  первая post-restart continuation показала `upstream_linked:true`, восстановила
  тот же persisted upstream key и дошла до `completion_done`. Исходный Bash
  `tool_result` уже создавал linked request до restart, поэтому live evidence не
  заявляет, что его первое поступление произошло только после restart.
- D5 переведён в `CLOSED`; открытых P1 теперь 3. Проект не объявлен
  production-ready. Отдельный collateral finding не относится к lineage:
  `Write-Output D5-LIVE` дал `completion_guard_rejected` с
  `missing_obligation_kinds=["file_mutation"]` и `TOOL_CALL_REQUIRED`/502. Это
  classifier/obligation false-positive; в D5 он не исправлялся.

## 2026-08-24 — Correlate current-cycle lineage results

- D5 independent review выявил blocking gap: newest result после user boundary
  мог быть orphan ID без соответствующего current-cycle `tool_use`, но handler
  всё равно использовал его lineage mapping и мог создать ложный
  `SESSION_CONFLICT`.
- Extractor теперь, как `inspectCurrentToolCycle()`, собирает IDs только
  current-cycle `tool_use` и reverse-scan выбирает newest matching
  `tool_result`. Historical и orphan results не участвуют в lineage resolution;
  TTL, header conflict и explicit body precedence не менялись.
- Anthropic, OpenAI и Responses fixtures проверяют реальные
  `tool_use → tool_result` пары. Добавлены regressions для orphan mapping и
  false-conflict prevention. D5 coverage теперь включает 26 новых tests; итого
  32 test files / 672 tests. D5 остаётся `IMPLEMENTED / VERIFYING` до live.

## 2026-08-24 — Harden lineage freshness and selection

- D5 PASS B перевёл `LineageStore` на единый `SESSION_LINK_TTL_MS`: возраст
  проверяется при lookup, init durably удаляет expired links до readiness, а
  каждая awaited mutation сохраняет pruning через общий
  `PersistentSessionDocument`. Граница `<= TTL` валидна, `> TTL` expired;
  фоновых disk writes из синхронного lookup нет.
- Handler теперь выбирает newest `tool_result` только после последней
  независимой user-инструкции. Historical/orphan results не восстанавливают
  lineage нового action cycle; Anthropic/OpenAI/Responses normalizers не
  менялись.
- Без explicit body identity свежие `x-call-id` и current-cycle result
  разрешаются независимо. Один mapping или одинаковая пара продолжают session,
  unknown/expired header fallback-ится к result, а различающиеся mappings дают
  `SESSION_CONFLICT`/409. Explicit body precedence сохранён.
- Добавлены 23 deterministic regressions для PB31/PB32: fake-clock TTL
  boundaries, lookup/restart/durable/lazy pruning, sibling preservation,
  persistence rollback, latest current-cycle selection, protocol normalization
  и handler resolution. Итого: 32 test files / 669 tests. D5 —
  `IMPLEMENTED / VERIFYING`; live verification ещё требуется, число открытых P1
  не меняется.

## 2026-08-24 — Close D2 after live verification

- D2 implementation `bc6d0aec8da2579c463d84c3e44cdcc61e175407`
  прошла independent review; deterministic PB29/PB30 подтвердили exact
  rejected-candidate isolation и accepted parent progression.
- Windows live verification на Claude Code 2.1.241 и `deepseek-v4-flash`:
  normal turn вернул `D2-TURN-1`; настоящий Bash `pwd` выполнился один раз и
  вернул `/d/Проекты/test`; tool-result continuation сохранил тот же upstream
  key и показал `upstream_linked:true`. Normal requests завершались
  `completion_done`; `SESSION_CONFLICT`, `STREAM_INCOMPLETE`, unexpected 502 и
  hang не наблюдались. Exact parent IDs в live logs не заявляются.
- Baseline PASS: 31 test files / 646 tests, typecheck, build, Windows
  `test:platform` и `git diff --check`. D2 переведён в `CLOSED`; открытых P0 —
  0, G6 — PASS. Проект не объявлен production-ready: P1/P2 и остальные release
  gates остаются открытыми.

## 2026-08-24 — Isolate rejected DeepSeek parent candidates

- D2 PASS B убрал преждевременную запись `chunk.messageId` в shared session
  state. `runCompletion()` теперь получает parent явно и возвращает candidate ID,
  а `complete()` ведёт repair-chain локально и публикует только окончательно
  принятого parent после guard/callback/auth acceptance boundary.
- Rejected guard attempts и incomplete/timeout/body/rate-limit/parse failures не
  меняют accepted parent; следующий independent request использует последний
  принятый ID. Successful result без candidate ID сохраняет прежний parent.
- Добавлены 19 deterministic PB29/PB30 regressions для accepted progression,
  one/two-repair chains, exhaustion, transport failures, accepted tool call,
  malformed repair, callback/auth rejection, next-request behavior и handler
  history. Итого: 31 test file, 646 offline tests. D2 переведён в
  `IMPLEMENTED / VERIFYING`; live verification ещё требуется.

## 2026-08-24 — Close D4 after live verification

- Independent review и Windows live verification D4 завершены успешно для
  implementation commit `b16307b0c59586709475aaeac312172e53771573`, Claude
  Code 2.1.241 и `deepseek-v4-flash`.
- Реальный Claude Code Bash `pwd` завершил tool-cycle с результатом
  `/d/Проекты/test`; normal generations завершались `completion_done`, а
  последующие requests использовали persisted lineage (`upstream_linked:true`).
- Controlled fake-upstream со stalled PoW challenge body и
  `DS_TIMEOUT_MS=700` дал typed `UPSTREAM_TIMEOUT`/504 на
  `upstream_stage=challenge_body`. Claude Code показал
  `API Error: 504 Upstream request timed out`; fake successful assistant result
  не создавался.
- Raw PB28 midstream-проверка получила HTTP 200, затем `message_start` и ровно
  один `event:error` с `timeout_error` / `Upstream request timed out`, без
  `message_delta` и `message_stop`. Lazy HTTP commit отдельно подтверждён
  pre-stream offline coverage; T21/T22 защищают persistence-before-exposure и
  lineage ordering. Terminal exclusivity подтверждена offline и live.
- D4 переведён в `CLOSED`; D2 остаётся единственным открытым P0. Baseline
  implementation остаётся green: typecheck, 30 test files / 627 tests, build,
  Windows `test:platform` и `git diff --check`. Claude Code прислал 39 tools —
  это только evidence для будущего D7. Malformed JSON 500 и downstream
  disconnect cancellation остаются отдельными открытыми findings.

## 2026-08-24 — Harden Anthropic streaming error lifecycle

- D4 PASS B откладывает фиксацию Anthropic HTTP 200 до первого SSE byte:
  ошибки до `message_start` теперь возвращают реальный HTTP status и
  Anthropic-compatible JSON error, а late failures завершаются одним
  документированным `event:error`, а не немым EOF.
- `ProtocolStream` получил минимальный mutually-exclusive terminal state:
  `finish()`/`fail()` idempotent, success и error взаимоисключаемы, writes после
  terminal игнорируются. Partial content failure не синтезирует
  `content_block_stop`, `message_delta` или `message_stop`.
- BridgeError преобразуется в безопасную Anthropic taxonomy; unknown exception
  возвращает только `api_error` / `Internal server error`. Исходные code/status/
  retryable/stage/cause сохраняются в redacted route log.
- Все обязательные lineage mappings теперь persist-ятся до публикации
  `tool_use`; persistence failure не отдаёт Claude Code executable tool block.
- Добавлены 26 deterministic route/protocol tests T1–T26 для PB28, normal
  Anthropic/OpenAI/Responses regressions и defensive disconnect case. Итого:
  30 test files, 627 offline tests. D4 — `IMPLEMENTED / VERIFYING`, не `CLOSED`;
  downstream-to-upstream disconnect cancellation остаётся отдельным finding.

## 2026-08-24 — Close D3 after live verification

- Independent review и Windows live verification D3 завершены успешно на
  Claude Code 2.1.241, `deepseek-v4-flash` и `DS_TIMEOUT_MS=120000`.
- Direct short completion вернул `D3-LIVE-OK`; long completion вернул 6600
  chars за 21853 ms без false timeout/incomplete/parse failure. Реальный Claude
  Code Bash `pwd` завершил tool-cycle с результатом `D:/Проекты/test`, а
  последующие requests показали `upstream_linked:true`.
- Normal generations завершались `completion_done`; unexpected
  `UPSTREAM_TIMEOUT`, `STREAM_INCOMPLETE`, `STREAM_PARSE_FAILED` и
  `UPSTREAM_ERROR` не наблюдались. Релевантная PB22–PB27 live verification PASS.
  D3 переведён в `CLOSED`; D2 и D4 остаются открытыми. Claude Code прислал 39
  tools — это только дополнительное evidence для будущего D7, без изменения
  его кода или статуса. Production code/tests не менялись; baseline 601/601.

## 2026-08-24 — Preserve terminal success during cleanup

- Independent review D3 выявил узкий cleanup edge case: после authoritative
  `FINISHED` / old `response_message_done` зависший `reader.cancel()` ожидался
  через оставшийся absolute deadline и мог заменить уже доказанный success на
  `UPSTREAM_TIMEOUT`.
- Terminal cleanup теперь вызывает `reader.cancel()` и `releaseLock()` только
  best-effort, не abort-ит controller и не позволяет hanging/rejected cancel
  заменить successful result. Failure/timeout path сохраняет исходный
  `BridgeError`, abort и best-effort cleanup без изменения taxonomy/retry policy.
- Добавлен regression T16b с never-settling `reader.cancel()`: completion
  boundedly возвращает valid FINISHED result, releaseLock вызывается, signal
  остаётся not aborted. Итого: 29 test files, 601 offline test. D3 остаётся
  `IMPLEMENTED / VERIFYING`.

## 2026-08-23 — Harden DeepSeek stream lifecycle

- D3 PASS B заменил неоднозначный `done` на explicit terminal classification:
  new `FINISHED` и old `response_message_done` завершают generation как success
  без ожидания EOF; new `INCOMPLETE` немедленно даёт
  `STREAM_INCOMPLETE`/502. Empty HTTP 200 и partial/non-terminal EOF больше не
  возвращаются как успешный completion.
- `DS_TIMEOUT_MS` теперь является абсолютным deadline completion от начала
  fetch до body parsing и cleanup. Timeout/failure abort-ит controller и
  best-effort cancel/release reader; terminal success cancel/release-ит reader
  без abort. Mid-body/raw transport failures нормализованы в typed
  `UPSTREAM_ERROR`, malformed supported update — в explicit
  `STREAM_PARSE_FAILED`/502.
- Normal chunks и trailing `SseAccumulator.flush()` проходят один processing
  path; undelimited trailing FINISHED поддержан, а post-terminal data
  игнорируется. Harmless raw/unknown/hint SSE остаются ignorable; closed HTTP
  200 `rate_limit_reached` contract не изменён.
- Completion POST всегда выполняется максимум один раз, включая HTTP 429/5xx,
  pre-header timeout/network failure и body failure. Safe PoW challenge сохраняет
  bounded retry, а чтение challenge JSON body также покрыто deadline.
- Добавлен `tests/unit/deepseekStreamLifecycle.test.ts`: 26 deterministic cases
  T1–T21 для PB22–PB27, cleanup, error taxonomy, no-guard transport failure и
  negative controls. Payload/prompt-capture fixtures обновлены на valid FINISHED.
  Итого: 29 test files, 600 offline tests. D3 остаётся
  `IMPLEMENTED / VERIFYING` до independent review, merge и live verification;
  D2/D4 не менялись.

## 2026-08-23 — Close D6 after live verification

- Independent review D6 завершён успешно. Реальный Windows Bridge с отдельным
  `DS_SESSIONS_FILE`, Claude Code 2.1.241 и `deepseek-v4-flash` после настоящего
  Bash tool-cycle сохранил schema-v2 документ с sessions=1 и links=2: lineage
  mutation не уничтожила созданную через `/v1/sessions` session `D6-LIVE`.
- После SIGINT Bridge корректно сообщил `server_stopped`; повторный запуск с тем
  же файлом восстановил `D6-LIVE`. Следующий real Claude Code tool-cycle прошёл
  с `upstream_linked:true`, подтвердив фактическое восстановление и использование
  persisted lineage. PB31 и релевантные persistence-инварианты PB33 live PASS;
  controlled concurrency/crash часть PB33 ранее подтверждена offline tests.
- D6 переведён из `IMPLEMENTED / VERIFYING` в `CLOSED`. Production code и tests
  не менялись; implementation baseline остаётся green: typecheck, 574/574 tests,
  build и Windows `test:platform`.
- Зафиксировано отдельное evidence для будущего D7: Claude Code 2.1.241 прислал
  39 tools. Tool catalog в этой docs-only задаче не исправлялся.

## 2026-08-23 — Coordinate persistent session state

- Добавлен единый `PersistentSessionDocument` — единственный владелец
  `sessions.json`. Schema v2 хранит `sessions` и `links` в одном документе,
  мигрирует legacy v1 sessions-only, links-only и mixed shapes и сохраняет
  неизвестные sibling fields. Invalid JSON и future schema version завершают
  startup fail-closed без перезаписи файла.
- `FileSessionStorage` и `LineageStore` делегируют чтение/изменения общему owner;
  мутации сериализуются через FIFO in-process queue. Bridge загружает документ
  до начала HTTP listen, durable write failures доходят до вызывающего кода, а
  фоновая expired-session cleanup обрабатывает ошибку без unhandled rejection.
- `writeJsonAtomic()` использует уникальный temp-файл, очищает его при ошибке и
  сохраняет recoverable `.bak` для Windows rename fallback; при второй ошибке
  прежний target восстанавливается. Multi-process locking намеренно не добавлялся.
- Добавлены 23 deterministic offline regression tests: interleaved/concurrent
  session+lineage writes, restart, v1/v2 migration, unknown siblings,
  invalid/future-version fail-closed, mutation failure propagation/rollback,
  init-before-listen и atomic-file failure/recovery. Итого: 28 test files,
  574 tests.
- D6 переведён в `IMPLEMENTED / VERIFYING`: реализация и PB31/PB33 offline
  evidence готовы, но defect не закрыт до независимого diff review, merge и
  release-commit verification.

## 2026-08-23 — Define production readiness gates

- Создан `PRODUCTION_READINESS.md` — единый источник production-hardening
  backlog и release gates для frozen scope Claude Code → Anthropic-compatible
  Bridge → DeepSeek Web. OpenCode, новые providers и новые UI-функции deferred
  до прохождения production gates.
- Зафиксированы четыре архитектурных слоя, неизменяемые invariants и центральный
  audit backlog: 4 открытых P0, 4 P1, 6 P2 и одна неподтверждённая/deferred P3.
  Каждый defect имеет evidence status, acceptance criteria, required tests,
  dependencies и связанные benchmark cases. D1 не объявлена подтверждённой;
  HTTP 200 SSE rate-limit fix остаётся закрытым и regression-protected.
- Добавлен frozen benchmark PB-v1 из 39 сценариев: environment/read, mutation,
  verification, tool protocol, upstream/downstream transport, session/lineage,
  long-run/compact и platform/shutdown. Существующие cases нельзя ослаблять или
  переписывать ради новой реализации; regressions добавляются новыми IDs.
- Определены 16 бинарных Definition of Production Ready gates и обязательный
  двухпроходный workflow: PASS A — diagnosis only, затем отдельно одобренный
  PASS B — implementation. Первый рекомендуемый diagnostic defect — D6,
  collision независимых writers `FileSessionStorage`/`LineageStore` в общем
  `sessions.json`.
- Проведена сверка текущего кода, tests и git history. В документе отдельно
  отмечены расхождения документации с реализацией и факты, доступные только как
  diagnostic handoff/NEEDS VERIFICATION. Production TypeScript, tests, scripts,
  config и runtime behavior не изменялись.

## 2026-08-23 — Handle DeepSeek SSE rate limit hints

- Подтверждённый live root cause: DeepSeek может вернуть HTTP 200, но сообщить
  ограничение quota внутри SSE как `event: hint` с
  `finish_reason:"rate_limit_reached"`. Раньше `SseAccumulator` относил `hint`
  к `other`, `DeepSeekClient.runCompletion()` игнорировал событие и возвращал
  пустой completion; completion guard ошибочно запускал ещё две generation
  attempts и завершался misleading `TOOL_CALL_REQUIRED`/502.
- `src/deepseek/sseParser.ts` теперь сохраняет отдельный тип `hint` и распознаёт
  rate limit только по точному сочетанию типа события и
  `finish_reason:"rate_limit_reached"`. Обычные hint events не считаются rate
  limit и остаются не влияющей на normal SSE подсказкой.
- `src/deepseek/client.ts` немедленно преобразует явный сигнал в существующий
  retryable `BridgeError`: `code="DEEPSEEK_RATE_LIMIT"`, HTTP 429,
  `upstreamStage="completion"`, `causeCode="rate_limit_reached"`. Ошибка
  возникает внутри первой `runCompletion()` и не попадает в completion guard,
  поэтому rate-limit storm дополнительными generation retries не усиливается.
- `tests/unit/deepseekRateLimit.test.ts` — 5 offline regressions: точный hint,
  обычный non-rate hint, один completion attempt и корректная upstream error,
  normal successful SSE, normal SSE после информационного hint. Существующие
  malformed-tool bounded-repair tests проходят без изменения ожиданий.
- Не изменялись: `toolParser.ts`, obligation/guard rules, replay/fingerprint,
  context ownership/full-vs-delta, DeepSeek session/parent semantics,
  SessionStore/LineageStore, auth, tool correlation и Claude Code integration.
  Неподтверждённая D1-гипотеза не затрагивалась.
- Итого: 26 test files, 551 offline test.

## 2026-08-23 — Narrow same-file additive verification

- Safety-review `bab6a9c` выявил destructive-clause false positives в
  same-file синтезе: «измени…стало STEP-2», EN «edit so final is STEP-2»,
  «удали строку TMP-X» (инверсия семантики), «перезапиши содержимым S2» —
  всё получало ложное final-state требование `[S1,S2]` и блокировало
  легитимные запросы через completion guard.
- Clause2 теперь принимается только с явно аддитивными глаголами
  (`добав|дополн|допис|append|\badd\b`); широкий мутационный список сохранён
  для clause1 и отбраковки третьей mutation-клаузы. Семантически additive
  формулировки вида «измени так, чтобы итог содержал…» намеренно остаются
  unsupported (консервативный false-negative лучше false-positive).
- Foreign path в clause2 теперь запрещает same-file synthesis всегда:
  сканируются ВСЕ path-like токены clause2, местоимения («в этот же файл»,
  «same file») больше не перекрывают наличие чужого пути (ранее ветка
  pronoun перекрывала проверку в `referencesSameFile`; дыра была latent —
  внешний gate distinct-paths спасал на всех прозвоненных shape'ах).
- Не тронуто: matcher, stale/fresh machinery, replay/fingerprint,
  multi-file inference, global extraction, retry limits.
- Tests: +8 regression cases (RU измени/EN edit/удали/перезапиши → нет fv;
  RU добавь/EN add+append → fv сохраняется; RU pronoun+b.txt и EN
  same file+another.txt → нет fv); прежние 538 без правок ожиданий;
  итого 546/546 offline; typecheck/build/test:platform зелёные.
- Live deepseek-v4-pro: Bash printf(обе строки) → Read → normal final;
  файл точный; completion_guard_rejected=0, TOOL_CALL_REQUIRED=0.

## 2026-08-23 — Verify additive same-file final state

- `fix/same-file-multi-step-obligations`. Для узкого same-file additive scope
  (ровно две последовательные мутационные клаузы об одном файле с явным маркером
  «затем/после этого/потом/then», вторая добавляет значение) inference теперь
  синтезирует final-state `file_verification`: `argumentLiterals=[path]`,
  `resultLiterals` = все явно выраженные значения обеих клауз. Верификация
  обязана быть fresh после последней мутации — переиспользована существующая
  stale/final-state machinery (`invalidatesFinalState`, latest-first binding).
- Глобальный extraction НЕ расширен: новый локальный helper
  (`inferSequentialAdditiveFinalState`) сканирует только два спана клауз своим
  quoted-проходом плюс уже распознанные content-литералы. Вторая клауза может
  продолжаться неявно/местоимением («в этот же файл»); отклоняется только при
  упоминании ДРУГОГО path-like токена.
- Gate: ровно 1 distinct path; ровно 2 мутационные клаузы (доп. маркерные
  сегменты разрешены только без мутационных глаголов); нет conditional/or
  (если/иначе/либо/или/if/else/or); нет replace-chain (→/->/замени X на Y/
  replace X with Y); в toolset есть Read-like tool; если обычный inference уже
  вывел file_verification для пути — resultLiterals вливаются в неё (MERGE),
  вторая не создаётся.
- Не тронуто: matchObligationsToEvidence, one-to-one binding,
  invalidatesFinalState, replay/fingerprint, COMPLETION_GUARD_MAX_ATTEMPTS,
  multi-file logic, empty final, naked `<tool_calls>`.
- Tests: describe «same-file additive final-state verification», 14 cases
  (destructive rewrite/Edit-replace → missing; one-shot/append → fulfilled;
  ранний Read → stale; merge; 6 gate-негативов; pronoun-positive). Все прежние
  тесты без правок ожиданий; итого 538/538 offline; typecheck/build/
  test:platform зелёные.
- Live deepseek-v4-pro (чистая папка): Bash printf(обе строки) → Read → normal
  final «обе строки присутствуют»; файл на диске с точным содержимым;
  completion_guard_rejected=0, TOOL_CALL_REQUIRED=0, malformed=0, replay=0.
- Ограничения: только 2 additive same-file клаузы; quoted/распознанные
  литералы (unquoted значения шагов unsupported); end-state семантика — порядок
  шагов и промежуточные состояния не контролируются; replace-chains, 3+ шага,
  conditional формулировки вне scope.

## 2026-08-22 — Guard multi-file obligation splitting

- Safety-review коммита 7017c04 выявил ambiguous third-path under-enforcement:
  если третий запрошенный файл был изолирован от распознанных глаголов
  (>120 символов либо экранирован нераспознанным/верификационным глаголом),
  split всё равно создавал ровно `file_mutation#1/#2` — система предъявляла
  «два требования» как полные, и модель могла завершиться, не создав третий
  файл (adversarial probes A1/A2).
- Каждый distinct path теперь классифицируется по ближайшему распознанному
  глаголу в окне до 120 символов: `mutation` / `verification` / `none`.
  Split разрешён ТОЛЬКО при ровно двух `mutation` путях и полном отсутствии
  `none` путей (все остальные — только `verification`). Любой unknown-context
  путь → fallback на исторический одиночный obligation.
- Regression tests: изолированный третий path class=none → fallback;
  verification third path → split сохранён. Итого 524/524 offline;
  typecheck/build/test:platform зелёные.
- Known limitations (намеренно не исправлены в этом scope): read-target как
  первый path literal направляет одиночный obligation на неверный файл
  (pre-existing `slice(0,1)`, P5a/P5e/P7); слабое упоминание второго файла
  наследует mutation-контекст и даёт split (P6, over-enforcement); третий путь
  с нераспознанным глаголом рядом с другими глаголами классифицируется по
  соседям (A1); пути с расширениями вне extraction-списка (напр. `.doc`) не
  становятся literals вовсе; same-file multi-step и 3+ mutation paths вне scope.

## 2026-08-22 — Track distinct file mutation obligations

- `fix/multi-file-obligations` (поверх foundation 8dfd84f). Если пользователь явно
  просит мутировать ДВА РАЗНЫХ файла, `inferToolObligations` теперь создаёт две
  per-path инстанции: `file_mutation#1` / `file_mutation#2` с
  `argumentLiterals=[pathA]` / `[pathB]`. Поддержаны ТОЛЬКО ровно 2 distinct paths;
  same-file multi-step (Write→Edit) и 3+ paths остаются вне scope.
- Консервативная дизамбигуация: путь — кандидат на split только если ближайший
  глагол перед ним (в окне до 120 символов) мутационный, а не верификационный
  («запиши отчёт в report.txt» — кандидат, «проверь storage-файл data/tasks.json» —
  нет). Один кандидат, повторные упоминания того же пути и три и более путей —
  fallback на исторический одиночный `id="file_mutation"`.
- Не тронуто: Write→Edit/append одного файла, literal/content extraction,
  file_verification regex, empty final, naked `<tool_calls>` detection,
  replay/fingerprint logic, matcher foundation (`matchObligationsToEvidence`).
- `tests/unit/tools.test.ts` — describe «distinct file mutation obligations»,
  8 regression cases (два пути → #1/#2; после Write(a) → #2 missing; после обоих
  Write → fulfilled; Write(c) вместо b → b missing; один файл → исторический id;
  два упоминания a.txt → без split; 3 пути → fallback; один tool_result не
  закрывает обе same-kind инстанции). Все прежние 514 тестов прошли без правок
  ожиданий (diff тестов — только добавления). Итого 522/522 offline;
  typecheck/build/test:platform зелёные.
- Live deepseek-v4-pro (чистая папка): модель выполнила Write(bridge-multi-a-952.txt)
  → Write(bridge-multi-b-952.txt) отдельными шагами, оба файла на диске с точным
  содержимым MULTI-A-952/MULTI-B-952; completion_guard_rejected=0,
  TOOL_CALL_REQUIRED=0, malformed/pseudo-XML=0, replay=0, normal final.

## 2026-08-22 — Support multiple obligation instances per kind

- Foundation для будущей obligation granularity (`fix/obligation-granularity-foundation`,
  ответ на расследование схлопывания нескольких мутаций одного файла в одну
  `file_mutation`). Пользовательское поведение НЕ расширено: `inferToolObligations`
  не менялся — никаких новых regex, без step splitting, `pathLiterals.slice(0, 1)`
  и извлечение литералов сохранены как есть.
- Новый `matchObligationsToEvidence` (`src/tools/toolParser.ts`): one-to-one
  binding внутри одного `ExternalActionKind` (аугментационные пути Кузена) — один
  успешный tool_result закрывает максимум один instance того же kind; разные
  instances могут закрываться разными evidence; evidence остаётся разделяемым
  между РАЗНЫМИ kinds (прежняя семантика сохранена).
- `inspectCurrentToolCycle` использует матчер вместо экзистенциальной проверки:
  bound-evidence участвует в прямой ветке fulfillment и stale-проверке;
  fresh-verification/cardinality/inconclusive ветки не изменились. Сканирование
  latest-first сохраняет историческую freshness-семантику финальных состояний.
  Для сегодняшних одиночных obligations поведение идентично прежнему.
- Ownership-карты изолированы per-kind: внутри kind evidence обслуживает одну
  obligation, между kinds шаринг разрешён.
- `tests/unit/tools.test.ts` — describe «multiple obligation instances per kind»,
  6 unit cases: 2×file_mutation + 1 evidence → закрыт один; последовательные
  evidence → оба; неверные literals второго шага не закрывают его; один Bash
  append удовлетворяет file_mutation + command_execution одновременно;
  реассигнация при конфликте; structured-error/пустые входы игнорируются.
  Итого 514/514 offline.

## 2026-08-22 — Block pseudo XML tool call leakage

- Закрыта **pre-existing** утечка: модель иногда эмитировала OpenAI-style
  pseudo-XML (`<tool_calls><invoke name="Bash"><parameter ...>`) вместо
  canonical tool call. Парсер такой формат не понимал
  (`no_tool_call_in_text`, `malformedToolIntent=false`), а guard пропускал его
  как обычный текстовый final, когда obligations уже были закрыты успешным
  tool_result — raw псевдо-XML уходил клиенту и не исполнялся. Поведение
  идентично на `67c6f689`, `06b1e4e8` и `c8693ac` (эмпирический repro на dist
  каждой сборки) — это не регрессия ветки tool-flow fix.
- `looksLikeMalformedToolIntent` теперь распознаёт `<invoke name="<allowed>">`
  как malformed tool intent (`src/tools/toolParser.ts`). XML Bridge
  самостоятельно НЕ исполняет: recovery использует существующий bounded
  canonical tool-call retry («Return exactly one correct tool call using valid
  JSON»), successful side effects не повторяются.
- Safety-review `baf72a6` выявил false positive: голое цитирование
  `<invoke name="Bash">` в обычном тексте/reasoning тоже считалось intent.
  Detection сужен до исполнимого shape — открывающий тег `<invoke ...>`,
  за которым следует `<parameter>`; plain quoted invoke больше не считается
  tool intent.
- Обычный XML/HTML и `<invoke>` с недоступным именем инструмента не
  блокируются; canonical JSON envelope и `<tool_call>{...}</tool_call>` парсятся
  как раньше.
- `tests/unit/tools.test.ts` — 7 regression cases: блокировка полного envelope
  после fulfilled obligations (сценарий утечки), invoke+parameter без wrapper,
  multiline параметры, блокировка при pending obligation и после failed
  tool_result; проза с цитатой `<invoke ...>`, пустой `<invoke>` без параметров,
  обычный XML/HTML и неизвестное имя не блокируются; canonical parsing цел;
  root-тест «retry запрашивает canonical call без replay успешных мутаций».
  Итого 508/508 offline.
- Live smoke (Write/Read/Bash, deepseek-v4-pro через Claude Code): инструменты
  исполнились реально, `completion_guard_rejected=0` — нормальный tool flow не
  сломан. Сам pseudo-XML в live не воспроизведён (формат эпизодический);
  корректность блокировки подтверждена regression-тестами.

## 2026-08-21 — Fix final-state guard tool flow regression

- Root cause (эмпирически подтверждён A/B-сборками `67c6f689` vs `06b1e4e8`):
  (1) нечитаемый count (не-JSON verification output) трактовался как вечный
  cardinality mismatch; (2) multiline `title:`/`description:` literals
  пере-байндились к аргументам `file_mutation`, поэтому успешный
  `Write(report.txt)` не мог закрыть obligation; (3) stale invalidation в
  связке с выросшим retry-промптом чаще упиралась в
  `COMPLETION_GUARD_MAX_ATTEMPTS` и давала серии `TOOL_CALL_REQUIRED`.
- Cardinality стала трёхзначной: count=1 fulfilled, count=0/>1 — явный
  failure, нечитаемый/неоднозначный вывод — inconclusive. Retry требует свежий
  детерминированный GET/Read с raw JSON и запрещает повторять уже успешную
  мутацию (`src/tools/toolParser.ts`, `src/deepseek/client.ts`, телеметрия
  `inconclusive_obligation_count`).
- Exact-count считается только по релевантному verification-выводу:
  совпадение exact literals либо container JSON (массив/объект). Health
  `"200"`, `pwd` и другие скалярные выводы не участвуют в подсчёте.
- `title`/`description` исключены из аргументов `file_mutation` при наличии
  `data_mutation` в том же запросе; независимые файловые задачи по-прежнему
  требуют точных значений.
- `tests/unit/tools.test.ts` — 9 новых regression cases: sequential flow без
  blocking final, inconclusive unit+root recovery через GET, health-noise,
  независимый Write отчёта, пины explicit-values/stale/malformed. Итого
  501/501 offline.

## 2026-08-21 — Require fresh final-state evidence

- Root cause: current-cycle `ToolObligation` evidence было монотонным. После
  первого successful API/Read/health result obligation оставался fulfilled,
  даже если более поздний POST/Write/Edit, test, install/build или server
  restart мог изменить проверенное состояние. Guard не сохранял порядок
  evidence и поэтому мог принять устаревшую проверку как финальную.
- `src/tools/toolParser.ts` теперь назначает каждому коррелированному
  `tool_result` sequence и вычисляет последнюю релевантную invalidation для
  API, storage/file и server postconditions. Финальная verification должна
  быть новее этой точки; обычные Read и информационные команды вроде `pwd`
  ничего не инвалидируют. Successful mutation остаётся fulfilled, поэтому
  stale verification требует новый GET/Read/health, а не повторный POST.
- State-changing actions учитывают Write/Edit и другие file tools, HTTP
  POST/PUT/PATCH/DELETE, test execution, dependency install, build commands и
  server launch/restart. Неуспешная потенциально mutating action также
  инвалидирует старое evidence консервативно, поскольку могла частично изменить
  состояние до ошибки.
- Labeled multiline `title`/`description` теперь извлекаются как exact Unicode
  literals. Для запросов `ровно одну`/`exactly one` API и storage JSON должны
  содержать ровно один объект с одновременно совпадающими exact полями; count
  0 и count 2 не закрывают obligation. Поддерживается детерминированный JSON из
  обычного tool result и line-numbered Claude `Read`; неоднозначный текст не
  угадывается.
- Retry сообщает отдельно stale postconditions и cardinality mismatch,
  запрещает слепо повторять уже successful mutation/POST и требует свежую
  финальную проверку. Также исправлена классификация shell redirection: стрелка
  JavaScript `=>` больше не считается файловой записью `>`.
- `tests/unit/tools.test.ts` — 12 новых regression cases: API→tests и
  storage→Write invalidation, reverify без повторного POST, post-test API/storage,
  exact count 0/1/2, unrelated Read и `pwd`, restart→new health, fresh ordered
  final и корневой `DeepSeekClient` retry→real GET.
- Windows live TaskFlow с точным prompt: первый Pro-run после tests восстановил
  exact record; независимые API/storage дали count=1, Jest прошёл 29/29, HTTP
  200 и listener PID 21104. Однако CLI не вернул captured final до 15-минутного
  timeout. Чистые Flash и Pro повторы завершились непустым HTTP 502
  `TOOL_CALL_REQUIRED` до mutation (exact count оставался 0), не ложным success.
  Полный autonomous final поэтому не заявляется и live TODO остаётся `[~]`.
- Итого: 25 test files, 492 tests.

## 2026-08-21 — Enforce multi-step Claude Code completion integrity

- Root cause: completion guard хранил только coarse action kinds и разрешал
  final после любого подходящего successful `tool_result`. Он не представлял
  отдельные требования текущего user request, не связывал exact title/
  description/path/URL с arguments и не требовал раздельных API, storage,
  test и server evidence. Кроме того, standalone Claude `system-reminder`
  мог быть ошибочно выбран как последний текстовый user request.
- `src/tools/toolParser.ts` теперь строит консервативный current-cycle набор
  `ToolObligation`: file/data mutation, command, API/file verification, tests,
  launch/server и install. Каждый obligation закрывается только подходящим
  коррелированным successful `tool_use` → `tool_result`; historical turns,
  compact/history и standalone system reminders не учитываются.
- Явно заданные user literals (title/name, description, content/marker, path,
  URL) сохраняются без перекодирования и сравниваются как Unicode NFC. Tool
  arguments должны содержать исходное значение; JSON results сравниваются по
  точным string values, поэтому mojibake, weaker/suffixed values и structured
  `{"error":...}` не подтверждают obligation.
- Jest version/help probes не считаются test execution. Явный failed Jest
  summary (`FAIL`, `Test Suites: ... failed`, `Tests: ... failed`) не считается
  success даже если shell pipeline скрыл exit code. Raw XML continuation и
  обещание вроде `Let me ... rerun` не выходят как final при незакрытых шагах.
- `src/deepseek/client.ts` передаёт bounded retry точный список ещё не
  подтверждённых requirements и уже закрытых evidence, запрещает объявлять
  успех и просит не повторять завершённые шаги. После трёх неудачных attempts
  возвращается непустой `TOOL_CALL_REQUIRED`; логи содержат только count/kinds,
  без пользовательских literals.
- `tests/unit/tools.test.ts` — 21 новый regression: exact Unicode, weaker и
  suffixed values, structured application error, отдельные API/storage/test/
  launch obligations, failed Jest через успешный pipeline, promised/raw XML
  continuation, masked file/server failures, Edit-only partial evidence,
  fulfilled/historical/new-cycle semantics, system reminder, informational
  request и bounded root rejection.
- Windows live TaskFlow: Flash корректно отклонил mojibake и failed Jest вместо
  ложного success. Pro без command hints самостоятельно использовал Unicode-safe
  Node request, `npx jest --runInBand` (29/29), поднял `node server.js`, получил
  HTTP 200 и повторно подтвердил exact API/storage после тестов. Независимая
  проверка: API и JSON содержали exact title `Проверка UTF-8 — ёжик №482` и
  description `Съешь ещё этих мягких французских булок`, listener PID 21104;
  изолированный повтор Jest — 29/29. Чистый end-to-end final не заявляется:
  10-минутный CLI harness завершился после последнего Read без captured final,
  а модель создала две одинаковые записи. TODO остаётся частично открытым.
- Итого: 25 test files, 480 tests.

## 2026-08-21 — Recover malformed Claude Code tool calls

- Root cause: `extractToolCallFromText()` уже находил JSON-кандидат с доступным
  tool, но при `JSON.parse()` error (production пример `\app.use(...)`) причина
  `extracted_json_invalid` терялась в `inspectToolCallFromOutput()`. Completion
  guard получал обобщённое `no_tool_call_found`; raw JSON не совпадал с
  text-intent/fake-trace эвристиками и выходил как успешный final вместо
  Anthropic `tool_use`.
- `src/tools/toolParser.ts` теперь сохраняет точную причину/source rejected
  candidate и отдельно классифицирует явный malformed tool intent только для
  доступных tools: `{"tool_call":...}`, bare `{"name":...,"arguments":...}`,
  `<tool_call>`, `Tool: Name` и подтверждённый live marker
  `{"tool":"Edit","arguments":...}`. Справочный вопрос остаётся обычным
  text-response; строгий bare envelope поддерживается как настоящий call.
- Неоднозначный malformed escape не ремонтируется подстановкой: `\a` может
  означать потерянный newline, literal backslash или другой текст. Bridge не
  меняет arguments и не применяет global backslash replace; корректно escaped
  Windows paths проходят прежний parser без изменений.
- `src/deepseek/client.ts` направляет malformed intent в существующий bounded
  completion guard (три total attempts). Retry сообщает, что tool не
  выполнялся, запрещает текстовую имитацию и требует один валидный JSON call с
  корректно escaped backslashes. После exhaustion возвращается непустой
  `TOOL_CALL_REQUIRED`; raw syntax пользователю не отдаётся.
- `tests/unit/tools.test.ts` — 8 regressions: production `Edit` с `\a`, raw
  envelope classification/no leak, corrected retry → настоящий `Edit tool_use`,
  strict valid call, informational JSON example, сохранность escaped Windows
  path, malformed marker и retry после successful result при незавершённом
  action.
- Windows production reproduction через Claude Code 2.1.238 в исходном
  TaskFlow project больше не завершился malformed JSON: Claude Code получил
  настоящий `Edit` и successful `tool_result`. Продолжение реально выполнило
  `Edit(server.js)` → result, чистые Jest 13/13 и запустило отдельный
  `node server.js`; точная UTF-8 end-to-end задача при этом не принимается как
  полностью autonomous success — модель позже проигнорировала exact arguments
  и преждевременно описала более слабый результат. Это отдельный model-side
  action-integrity TODO, а не утечка malformed tool syntax.
- Итого: 25 test files, 459 tests.

## 2026-08-21 — Prevent repeated failed tool calls

- Root cause: completion guard считал любой валидный распарсенный `tool_call`
  достаточным и сразу возвращал его Claude Code. Evidence текущего action cycle
  хранил только имя failed tool, поэтому не мог отличить исправленный вызов от
  повтора тех же arguments; после `Bash(false)` модель могла снова отдавать тот
  же action и в конце вернуть пустой final.
- `src/tools/toolParser.ts` — добавлен стабильный fingerprint из точного имени
  tool и рекурсивно key-sorted JSON arguments. Для Bash исключён только
  неисполняемый `description`: live Claude Code меняет этот текст между
  одинаковыми calls, тогда как `command`, `timeout` и остальные execution-поля
  сохраняются в fingerprint. Учитываются только коррелированные
  `tool_use` → `tool_result is_error:true` после последнего текстового user
  request; successful и historical results не блокируют новые calls.
- `src/deepseek/client.ts` — повтор failed fingerprint больше не выходит через
  `onToolCall` и не выполняется Claude Code. Вместо этого existing bounded guard
  запрашивает другой tool, исправленные arguments или честный failure. После
  трёх неудачных completion attempts Bridge возвращает непустой
  `TOOL_CALL_REQUIRED`; пустой final после failed result также отклоняется.
- Retry prompt явно сообщает, что точный вызов уже выполнялся и вернул
  `is_error:true`, запрещает неизменный повтор и разрешает альтернативу,
  исправленные arguments либо честное объяснение невозможности.
- `tests/unit/tools.test.ts` — 11 regressions: стабильность fingerprint при
  разном JSON key order и Bash descriptions, identical failed Bash block,
  changed arguments/другой tool, successful result, historical failure, новый
  user cycle, bounded attempts, отсутствие повторного callback, recovery и
  непустой BridgeError после empty-final exhaustion.
- Production live на Windows через Claude Code 2.1.238 в `D:\test CC NODE`:
  точный `Bash(false)` выполнился один раз в одном user request. Изменённые
  executable commands были разрешены, а final честно сообщил об ошибке. Второй
  сценарий прошёл `false` → `is_error:true` →
  `printf RECOVERY-OK-482` → successful result → final `RECOVERY-OK-482`.
- Отдельно в `PROJECT_STATE.md` оставлен открытый TODO по наблюдаемому
  SHUTDOWN/PID lifecycle; production shutdown code в этой задаче не менялся.
- Итого: 25 test files, 451 tests.

## 2026-08-20 — Claude Code action completion integrity

- Runtime root cause воспроизведён до изменения: `Artifact` попадал в DeepSeek
  tool prompt/allowlist, а `inspectCurrentToolCycle()` выбирал последний
  `tool_result` вместо исходного user action. Любой result, включая
  `is_error:true`, выставлял `hasCurrentToolResult:true`; `shouldRetry()` сразу
  разрешал final и не проверял, что create/launch действительно выполнены.
- `src/tools/toolPrompt.ts` — exact tool `Artifact` теперь исключается из
  фактического Bridge allowlist и initial prompt. Рабочие Claude Code tools
  `Skill`, `Read`, `Write`, `Edit`, `Bash` и остальные не фильтруются. Prompt
  отдельно закрепляет, что failed result является доказательством ошибки, а не
  успеха.
- `src/tools/toolParser.ts`, `src/deepseek/client.ts` — action guard строит
  evidence только после последнего текстового user request, коррелирует
  `tool_use`/`tool_result` по id и различает successful/failed results. Для
  file mutation, command execution, launch и dependency install требуются
  соответствующие successful results; historical/compact results не учитываются.
  Create и launch — отдельные требования: успешный Write не доказывает запуск.
- Bash `cat > index.html`/redirection считается file-mutation evidence;
  `start`/`open`, HTTP server и dev-server команды — launch evidence. Failed
  Bash/Artifact не выполняют ни одно требование. Честный failure разрешён, но
  success claim без необходимого evidence получает bounded retry/rejection.
- Failed canonical results теперь сериализуются upstream с явными
  `status:error` и `is_error:true`. Artifact retry объясняет, что tool недоступен
  через Bridge, ничего не создал/не открыл, и предлагает обычные доступные
  Claude Code tools; `Artifact` не возвращается в allowed names.
- `tests/unit/tools.test.ts` — 22 новых regressions: Artifact filtering,
  сохранение Skill/Write/Edit/Bash, error serialization, create/launch evidence,
  Write и Bash redirection, failed Bash/Artifact, historical result,
  informational questions и корневое поведение `DeepSeekClient.complete()`.
- Production live-test в пустом
  `D:\test CC NODE\action-integrity-live-20260820` с исходным prompt выполнил
  `Write(index.html)` → successful result → `Bash(start index.html)` → successful
  result → final. Artifact не вызывался; Skill/Write/Edit/Bash оставались
  доступны. Независимая проверка: `index.html` = 14 951 байт, HTML/body есть,
  Chrome открыл видимое окно `MindfulSpace — медитация и осознанность`.
- Failure live-test `Bash(false)` вернул `is_error:true`; ложных «готово» или
  success claim не было. Модель повторила failed command пять раз и завершила
  пустым final — повторение не объявляется исправленным и остаётся наблюдаемым
  model-side ограничением.
- OpenCode provider/launcher/tool behavior не изменялись: текущий активный фокус
  — Claude Code tool reliability, OpenCode для этой итерации deferred.
- Итого: 25 test files, 440 tests.

## 2026-08-20 — Current DeepSeek V4 Web models

- До изменения runtime через dedicated Chrome/CDP перехвачены реальные запросы
  текущего `chat.deepseek.com`. Instant отправляет `model_type:"default"`, Expert
  — `model_type:"expert"`; Thinking меняет отдельный `thinking_enabled` для обеих
  моделей. Smart Search в Instant меняет `search_enabled`; в Expert его toggle
  отсутствует. Во всех режимах остальные scalar-поля совпали:
  `action:null`, `preempt:false`. Token/cookie/HIF и prompt не логировались.
- Response capture подтвердил `model_type`, thinking/search flags и показал, что
  `response.model` сейчас пустой. Связь Instant→V4 Flash и Expert→V4 Pro
  дополнительно сверена с официальным релизом DeepSeek V4; Bridge не выдумывает
  upstream `model_name`.
- `src/config/modelCapabilities.ts`, `src/deepseek/client.ts` — добавлен единый
  registry: основные `deepseek-v4-flash`/`deepseek-v4-pro` маппятся на Web
  `default`/`expert`; Thinking остаётся отдельным capability. Payload приведён к
  текущему Web schema. Search разрешён для Flash и отклоняется для Pro.
  `deepseek-chat`/`deepseek-reasoner` сохранены только как скрытые legacy aliases
  V4 Flash; Reasoner alias по умолчанию включает Thinking.
- `src/app.ts`, `src/api/normalize*.ts`, `src/server/routes.ts`,
  `src/server/landingPage.ts` — `/v1/models`, defaults и Web UI selector переведены
  на V4; unknown model возвращает `MODEL_UNAVAILABLE` HTTP 400 до создания
  upstream session.
- `src/server/actions.ts`, `src/server/terminalLaunch.ts` — Claude Code получает
  выбранный V4 model. OpenCode получает явный
  `deepseek-bridge/deepseek-v4-flash|pro` и process-local
  `OPENCODE_CONFIG_CONTENT` с provider `DeepSeek Bridge`; глобальный config
  пользователя не изменяется. Unix runner безопасно передаёт эту переменную
  отдельным argv наряду с существующими Bridge env.
- `scripts/doctor.ts`, `scripts/live/run.ts`, `README.md`,
  `docs/architecture.md`, `PROJECT_STATE.md` синхронизированы с текущим Web
  payload, V4 моделями и legacy aliases.
- `tests/unit/models.test.ts` и существующие normalize/launcher regressions:
  Flash/Pro, Thinking OFF/ON, Search, exact upstream payload, `/v1/models`,
  unknown model, aliases, Claude Code и OpenCode selected model/provider.
- Production live-test на одном работающем Bridge подтвердил Claude Code с
  Flash (`FLASH-LIVE-731`) и Pro (`PRO-LIVE-482`). Отдельный Flash-запрос
  выполнил настоящий Bash `pwd`: Claude Code получил `tool_use`, вернул
  `tool_result` `/d/test CC NODE` и только затем сформировал final answer.
- OpenCode live-test подтвердил process-local provider: `opencode models
  deepseek-bridge` показал только обе V4-модели, а completion через
  `deepseek-bridge/deepseek-v4-flash` вернул `OPENCODE-LIVE-517` с exit code 0.
- Итого: 25 test files, 418 tests.

## 2026-08-20 — One-click desktop launchers

- `scripts/desktopStart.mjs` — добавлен общий dependency-free bootstrap только на
  built-in Node API. Он независимо определяет корень репозитория, требует Node.js
  20+, проверяет npm, при отсутствии `node_modules` запускает `npm install`, а при
  missing/stale `dist/index.js` — `npm run build`.
- Перед установкой/build bootstrap проверяет `http://127.0.0.1:9655/health`.
  Уже работающий Bridge не дублируется: открывается существующий Web UI. Для нового
  процесса bootstrap ждёт HTTP 200 readiness, затем открывает браузер и остаётся
  привязанным к `npm start`, сохраняя видимые логи и lifecycle окна.
- Ошибки Node/npm/install/build/startup сначала показываются простым русским
  сообщением, затем краткой технической причиной. Node не устанавливается скрытно:
  при отсутствии или версии ниже 20 открывается официальная download page.
- `START.bat`, `START.command`, `START.sh`, `DeepSeek Web Bridge.desktop` — тонкие
  launchers для двойного клика. Все вычисляют корень относительно собственного
  файла; пути передаются через quoted argv/cwd без shell interpolation. Linux
  desktop entry использует freedesktop `%k` отдельным аргументом и оставляет
  `START.sh` fallback; macOS launcher не пытается обходить Gatekeeper.
- `tests/unit/desktopStart.test.ts` — 18 offline-тестов: Node <20, missing npm,
  first/already-installed launch, build decision, duplicate Bridge, health polling,
  Unicode cwd, install/build/startup failures, timeout, dependency-free imports и
  безопасные относительные launcher contracts. npm, browser и Bridge в тестах
  заменены injected runtime и реально не запускаются.
- `README.md`, `PROJECT_STATE.md` — one-click flow сделан основным сценарием;
  npm-команды перенесены в «Ручной запуск / Для разработчиков». macOS/Linux
  double-click GUI остаётся честным desktop live-test TODO; существующий real-OS
  CI matrix продолжает выполнять весь offline suite на трёх ОС.
- Итого: 24 test files, 400 tests.

## 2026-08-20 — Reject fabricated environment tool results

- `src/tools/toolParser.ts`, `src/deepseek/client.ts` — completion guard теперь
  сопоставляет ответ модели с текущим canonical tool-cycle. Запросы текущего cwd,
  листинга/структуры каталога, содержимого или существования файла и выполнения
  команды при доступных Bash/Read/Glob-подобных инструментах требуют настоящего
  структурированного `tool_result` текущего цикла. Historical tool results,
  compact/history и правдоподобный текстовый вывод доказательством не считаются.
- Детектор fabricated execution распознаёт русские и английские заявления о
  выполнении команд, `pwd`/`ls -la` с `Вывод:`/`Output:` и fake shell listing.
  Обычные справочные вопросы (`что такое pwd?`, `как работает ls -la?`) остаются
  текстовыми и не требуют инструмента.
- `src/tools/toolPrompt.ts` — явно закреплено, что текст команды или похожий на
  shell output фрагмент не является `tool_result`. Retry prompt сообщает, что
  инструмент не выполнялся, запрещает выдумывать cwd/files/output, требует
  настоящий tool-call JSON и разрешает final только после текущего real result.
- `src/utils/errors.ts` — после трёх безуспешных completion attempts Bridge
  возвращает безопасную retryable ошибку `TOOL_CALL_REQUIRED` (HTTP 502), а не
  выдаёт fabricated shell/file result как успешный ответ.
- `tests/unit/tools.test.ts` — добавлены 23 regression-теста детектора и корневого
  поведения `DeepSeekClient.complete()`: fake `pwd`/`ls`, выдуманный и даже
  правильный cwd без result, RU/EN environment intents, real Bash tool-call,
  final после текущего result и отказ учитывать historical result нового turn.
- Windows live-test через реальный Claude Code 2.1.237 в `D:\test CC NODE`
  подтвердил два полных цикла. `Bash(pwd)` вернул `/d/test CC NODE`; `Bash(ls -la)`
  вернул `post-compact-final-2`, `stale-live-test`, `test.txt`. В обоих случаях
  Claude Code зафиксировал настоящий `tool_use` и `tool_result` до final answer;
  листинг совпал с независимым `Get-ChildItem`.
- Проверки: typecheck, 382/382 offline tests, build и Windows platform smoke.

## 2026-08-20 — Cross-platform CI and platform smoke tests

- `.github/workflows/cross-platform.yml` — добавлена real-OS matrix для
  `windows-latest`, `macos-latest`, `ubuntu-latest`: `npm ci`, typecheck, 359
  offline tests, build и отдельный `npm run test:platform` на каждой ОС.
- `scripts/platformSmoke.ts`, `package.json` — новый auth-free smoke изолирует
  все Bridge data во временном каталоге, проверяет фактический
  `process.platform`, `buildConfig`, startup Bridge, HTTP 200 для `/health` и
  `/readyz`, backend `/api/system`, Unicode temp cwd и точную передачу
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_BASE`,
  `OPENAI_API_KEY` в безопасный `spawn(..., shell:false)` child.
- `src/server/terminalLaunch.ts` — существующая фабрика fixed POSIX runner
  экспортирована для real-OS smoke без изменения production launch behavior.
  На macOS/Linux smoke реально исполняет этот runner и проверяет PID/cwd/env;
  macOS также проверяет наличие `osascript`/Terminal.app и POSIX quoting пробелов,
  кириллицы, одинарной кавычки и shell metacharacters. Linux сверяет capability
  с реально найденным terminal emulator, не поднимая fake GUI.
- Smoke не читает реальные credentials, не логирует placeholder token values,
  не обращается к DeepSeek, не запускает Claude/OpenCode, не делает broad kill и
  удаляет только собственные временные файлы/processes.
- Первый real-OS CI run выявил и исправил portability самих проверок:
  Windows 8.3 path alias и macOS `/var` → `/private/var` теперь сравниваются по
  canonical filesystem identity при отдельной точной проверке Unicode basename;
  Windows launcher unit tests явно inject `platform: "win32"`, а picker tests
  больше не открывают настоящий GUI. Actions обновлены до Node-24-based v5,
  проект при этом по-прежнему тестируется на Node.js 20.
- `README.md`, `PROJECT_STATE.md` — явно разделены unit/platform-mocked,
  real-OS CI и desktop GUI live-test. CI не объявляется GUI-проверкой;
  настоящие macOS/Linux picker/interactive terminal/SHUTDOWN live-тесты остаются TODO.

## 2026-08-20 — Native macOS and Linux CLI launch

### Реализация

- `src/server/terminalLaunch.ts`, `src/server/actions.ts`, `src/server/routes.ts` —
  добавлены отдельные native launch strategies без изменения Windows
  `launchProcess()`. Windows сохраняет live-проверенные Unicode cwd, detached
  child tracking, `taskkill /T` по tracked PID и обе launch capabilities `true`.
- macOS открывает новую видимую Terminal.app session через `osascript` и
  статический AppleScript. Пользовательский cwd/аргументы не вставляются в
  AppleScript source: они POSIX-quoted и передаются как argv. Поддержаны Unicode
  и раскрытие `~/`. Capability `true` только при наличии `osascript` и Terminal.app.
- Linux безопасно ищет terminal emulator по PATH без его запуска, приоритет:
  `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `kitty`,
  `xterm`. Для каждого используется отдельный документированный argv layout и
  `spawn(..., shell:false)`. Если emulator не найден, launch capabilities `false`.
- macOS/Linux запускают fixed mode-0700 runner. Cwd, CLI и четыре Bridge env
  (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_BASE`,
  `OPENAI_API_KEY`) передаются runner как argv; runner экспортирует env, пишет
  собственный PID в private temp file и делает `exec` CLI.
- SHUTDOWN завершает только точный runner/CLI PID и launcher child, созданные
  Bridge. macOS дополнительно закрывает только tracked Terminal.app window при
  совпадении window id + tty и одной вкладке. Нет kill по имени Terminal.app,
  emulator, `claude` или `opencode`; delegated Linux terminal window может остаться
  открытым, если emulator завершил launcher process и не реагирует на завершение CLI.
- `src/server/system.ts`, `src/server/landingPage.ts` — capabilities теперь
  отражают наличие native terminal transport. При отсутствии Linux emulator UI
  показывает `No supported terminal emulator found`; ручной запуск остаётся доступен.
  Наличие CLI binary не входит в capability и проверяется при `/bridge/launch` с
  понятной SSE-ошибкой.
- `README.md`, `docs/architecture.md`, `PROJECT_STATE.md` обновлены. macOS/Linux
  реализация не объявляется live-проверенной на Windows.

### Offline tests

- `tests/unit/nativeCliLaunch.test.ts` — 15 тестов: root Claude/OpenCode macOS
  launch, Unicode/`~/`, env propagation, safe escaping; argv layouts всех шести
  Linux emulator, root x-terminal-emulator Unicode/env, fallback priority,
  no-terminal/missing-CLI errors и узкий SHUTDOWN tracking.
- `tests/unit/systemCapabilities.test.ts` — дополнены transport-aware macOS/Linux
  capabilities и UI hint; Linux picker tests переведены на безопасный injected
  availability probe.
- Существующие Windows Unicode launch integration и SHUTDOWN regressions проходят;
  добавлен Windows missing-CLI error regression.
- Итого: 23 test files, 359 tests.

## 2026-08-20 — Cross-platform system capabilities and folder picker

### Реализация

- `src/server/system.ts`, `src/server/routes.ts`, `src/server/middleware.ts` —
  добавлен публичный read-only `GET /api/system`. Backend определяет платформу
  через `process.platform`; browser platform/user-agent не используется. Schema:
  `platform`, `folderPicker`, `claudeCodeLaunch`, `openCodeLaunch`.
- Windows capabilities: folder picker, Claude Code launch и OpenCode launch =
  `true`. Проверенный WinForms picker в `src/server/actions.ts` не изменён:
  сохранены UTF-8/Base64 transport и filesystem-validated mojibake fallback.
- macOS: folder picker через статический AppleScript в `osascript`, UTF-8 stdout,
  Unicode path и cancel `-128` → `cancelled:true`. CLI launch capabilities =
  `false`, пока нет отдельного Terminal.app launch и настоящего live-теста.
- Linux: безопасная проверка наличия `zenity`, затем `kdialog`; picker запускается
  через `spawn(..., shell:false)` со статическими аргументами. Если обе утилиты
  отсутствуют, возвращается `supported:false`, Web UI оставляет ручной ввод.
  CLI launch capabilities = `false` до terminal-emulator реализации/live-теста.
- `src/server/landingPage.ts` — UI загружает `/api/system`, показывает платформу,
  включает picker только при `folderPicker:true`, никогда не скрывает ручной
  workDir input и отключает неподтверждённый CLI launch. Backend также отклоняет
  direct `/bridge/launch` на платформах с launch capability `false`.
- `src/deepseek/client.ts` — сообщения 401/403 больше не требуют restart Bridge;
  пользователь направляется к AUTH в Bridge Console или `npm run auth`.
- `README.md`, `docs/architecture.md`, `PROJECT_STATE.md` синхронизированы с
  текущими capabilities и ограничениями.

### Offline tests и границы проверки

- `tests/unit/systemCapabilities.test.ts` — 5 тестов: endpoint для mocked
  win32/darwin/linux, Linux без picker utilities, Web UI `folderPicker:false`.
- `tests/unit/crossPlatformPicker.test.ts` — 5 тестов: macOS Unicode/cancel,
  Linux zenity, kdialog fallback, отсутствие обоих picker.
- Существующие Windows Unicode picker/launch regressions продолжают проверяться.
  macOS/Linux сценарии в этой итерации только platform-mocked/offline; настоящий
  live-test на macOS/Linux не заявляется и остаётся TODO.
- Реальный Windows production probe на порту 9657: `GET /api/system` = HTTP 200
  `{"platform":"win32","folderPicker":true,"claudeCodeLaunch":true,"openCodeLaunch":true}`;
  HTML действительно запрашивает endpoint и сохраняет ручной `#workdir` input.
- Итого: 22 test files, 341 test.

## 2026-08-20 — Verify Web UI auth lifecycle and shutdown

### Runtime root causes и исправления

- `src/server/actions.ts`, `scripts/auth.ts` — актуальный DeepSeek после реального
  входа передавал Bearer, но не создавал `hif_leim_cached` и не отправлял
  `x-hif-leim`. Web UI AUTH ошибочно требовал HIF до запуска upstream verification,
  поэтому fallback был логически недостижим. Теперь HIF по-прежнему подхватывается
  из сети/localStorage при наличии, но Bearer + cookie сохраняются без HIF только
  после успешного `POST /api/v0/chat_session/create`.
- `src/server/actions.ts` — SHUTDOWN при активном `/bridge/auth` закрывал HTTP listener
  и Chrome, но Node оставался жив: graceful server close ожидал незавершённый AUTH
  SSE, а auth-loop не получал сигнал отмены. Активные AUTH теперь регистрируют
  внутренний AbortController; SHUTDOWN отменяет цикл до graceful stop.

### Live-проверка

- Полный `AUTH → completion → LOGOUT → AUTH → completion` прошёл без рестарта на
  одном Node PID `19944`. Оба real DeepSeek completion вернули точные маркеры
  `AUTH1-FINAL-731` и `AUTH2-FINAL-482`.
- LOGOUT вернул 200; тот же PID продолжил работать, `/health` = 200,
  auth-status = `valid:false`, `auth.json` и dedicated profile отсутствовали.
  После второго AUTH auth-status снова стал `valid:true`, `auth.json` появился,
  а completion использовал новый upstream key. Очистка `chatSessionId`/lineage и
  auth-generation guard сопоставлены с существующими offline regression-тестами.
- SHUTDOWN завершил Node PID `19944` и только tracked `cmd.exe → claude.exe`;
  посторонний Claude PID `6472` остался жив. HTTP перестал отвечать, `auth.json`
  сохранился с тем же timestamp. После запуска Bridge на PID `23236` auth сразу
  был valid, real completion вернул `RESTART-FINAL-963` без повторного AUTH.
- Отдельный production probe на порту 9656 воспроизвёл SHUTDOWN во время открытого
  AUTH: Node PID `13880` завершился, 11 процессов dedicated auth Chrome закрылись,
  HTTP перестал отвечать; основной Bridge на 9655 продолжил работать.

### Тесты

- `tests/unit/webUiAuthCapture.test.ts` — 3 regression-теста: HIF из localStorage
  при отсутствии сетевого header, verified Bearer/cookie без HIF и отмена активного
  AUTH при SHUTDOWN.
- Итого: 20 test files, 331 test.

## 2026-08-20 — Fix Unicode working directory launch on Windows

### Runtime reproduction и root cause

- На Windows создана и выбрана через настоящий `FolderBrowserDialog` папка
  `D:\Проекты\Тестовая папка ёжик`. До исправления системное дерево показывало
  правильное имя, но `POST /bridge/pick-folder` возвращал mojibake
  (`D:\Ð...`): `FolderBrowserDialog.SelectedPath` в текущем Windows
  PowerShell/.NET runtime уже содержал UTF-8 bytes как Latin-1 code points.
- Повреждённый путь не существовал; обратное Latin-1 bytes → UTF-8
  преобразование давало точный существующий каталог. Поэтому одной настройки
  `[Console]::OutputEncoding = UTF-8` было недостаточно.

### Исправление

- `src/server/actions.ts` — picker передаёт путь как ASCII Base64 от явных
  UTF-8 bytes. Node декодирует Base64 и UTF-8; узкий mojibake fallback применяется
  только если исходный path не существует, восстановленный path существует и
  декодирование не содержит replacement characters. Корректные пути не меняются.
- `launchProcess()` не изменялся: отдельный реальный child probe и production
  Claude Code подтвердили, что `spawn(..., { shell: true, cwd })` на этом Windows
  runtime сохраняет Unicode `cwd` без искажения.

### Live-проверка и тесты

- Реальный Web UI click вызвал `POST /bridge/pick-folder` →
  `{"path":"D:\\Проекты\\Тестовая папка ёжик"}`; browser JS записал в
  `#workdir` ту же строку с UTF-8 hex
  `443a5cd09fd180d0bed0b5d0bad182d18b5cd0a2d0b5d181d182d0bed0b2d0b0d18f20d0bfd0b0d0bfd0bad0b020d191d0b6d0b8d0ba`.
- Реальный Web UI launch отправил `{"tool":"claude","workDir":"D:\\Проекты\\Тестовая папка ёжик","model":"deepseek-chat"}`.
  Windows PEB подтвердил exact cwd для запущенных `cmd.exe` и `claude.exe`:
  `D:\Проекты\Тестовая папка ёжик\`; Windows Terminal открыл живую вкладку
  Claude Code.
- `tests/unit/webUiUnicode.test.ts` — regression для реально наблюдавшегося
  mojibake и filesystem-validated восстановления.
- `tests/unit/unicodeLaunchIntegration.test.ts` — настоящий child-process test:
  Unicode workDir → `launchProcess()` → child записывает `process.cwd()` → exact match.
- Итого: 19 test files, 328 tests.

## 2026-08-20 — Fix Web UI logout runtime behavior

### Root cause и исправление

- Реальный runtime-тест commit `9b7eaa6` показал ложный успех LOGOUT:
  `POST /bridge/logout` возвращал `200 {"ok":true,"message":"Logged out"}`,
  Node PID и `/health` оставались живы, но `auth.json` и dedicated Chrome profile
  не удалялись, поэтому `/bridge/auth-status` продолжал возвращать `valid:true`.
- Точная причина: на Windows с Node `v24.12.0` синхронный
  `fs.rmSync(..., { force/recursive })` молча не удалял файлы и каталоги под
  кириллическим путём `D:\Проекты\...`, не выбрасывая исключение.
  `performLogout()` поэтому ошибочно возвращал `ok:true`.
- `src/server/actions.ts` — LOGOUT переведён на `await fs.promises.rm()` для
  dedicated Chrome profile и `auth.json`; async-вариант проверен на том же
  Unicode path и реально удаляет targets. Маршрут SHUTDOWN не менялся.
- `src/server/landingPage.ts` проверен отдельно: `doLogout()` показывает toast и
  обновляет индикаторы, не заменяет `document.body`; замена страницы остаётся
  только в `doShutdown()`.

### Runtime regression

- До исправления: PID `644`, `GET /health` = 200, auth-status = `valid:true`,
  auth/profile присутствуют. После LOGOUT PID и `/health` оставались живы, но
  auth-status ошибочно оставался `valid:true`, оба filesystem target сохранялись.
- После исправления: PID `24128`, до LOGOUT `GET /health` = 200 и auth-status =
  `valid:true`; `POST /bridge/logout` = 200. После LOGOUT тот же PID жив,
  `GET /health` = 200, `GET /readyz` = 200, auth-status =
  `{"valid":false,"message":"NO AUTH"}`, `auth.json` и Chrome profile удалены,
  `GET /` = 200.

### Тесты

- `tests/unit/logoutRuntimeIntegration.test.ts` — новый HTTP integration-тест:
  поднимает настоящий `buildApp()`/`BridgeServer` с Unicode data path и проверяет
  `health → auth-status → logout → health/readyz/auth-status`, физическое удаление
  auth/profile и доступность того же сервера после LOGOUT.
- Итого: `npm run typecheck` ✅, `npm test` ✅ (326/326), `npm run build` ✅.

## 2026-08-20 — Web UI auth lifecycle and Unicode Windows paths

### Исправления

- `src/server/actions.ts` — Windows FolderBrowserDialog теперь задаёт
  `[Console]::OutputEncoding` и `$OutputEncoding` как UTF-8 без BOM. Node собирает
  stdout как bytes и явно декодирует единый UTF-8 buffer, поэтому кириллические
  пути (включая разрыв многобайтного символа между chunks) не искажаются.
- `src/deepseek/client.ts`, `src/app.ts`, `src/api/handler.ts` — credentials стали
  заменяемым runtime-состоянием `DeepSeekClient`: `setAuth()` немедленно применяет
  новый token/cookie/hif, `clearAuth()` блокирует upstream-запросы без остановки
  Bridge. Auth-generation guard не позволяет завершившемуся после смены аккаунта
  старому запросу записать старый `chatSessionId` или lineage.
- `src/sessions/sessionStore.ts`, `src/sessions/lineage.ts` — account-bound upstream
  state очищается при LOGOUT и перед установкой новых credentials. Очистка lineage
  сохраняет соседние `sessions` и прочие поля общего `sessions.json`; файл целиком
  не удаляется.
- `src/server/routes.ts`, `src/server/landingPage.ts` — LOGOUT теперь удаляет только
  локальные DeepSeek credentials и dedicated Chrome profile, очищает runtime auth,
  показывает toast `Logged out` и обновляет status indicators. Bridge и запущенные
  через Web UI Claude Code/OpenCode продолжают работать; `process.exit()` не
  вызывается. Confirmation: `Logout from DeepSeek?`.
- SHUTDOWN остаётся отдельным действием: останавливает только tracked Claude Code /
  OpenCode, активный auth Chrome, HTTP server и Node process. `auth.json` не
  удаляется, посторонние CLI-процессы не затрагиваются.
- `buildApp()` теперь может поднять Bridge без исходного `auth.json`, чтобы Web UI
  AUTH был доступен и после локального logout; успешный `/bridge/auth` применяет
  captured credentials до отправки успешного SSE result, без рестарта.
- macOS/Linux picker и `GET /api/system` не реализовывались в этой итерации.

### Тесты

- Добавлено 11 offline regression-тестов: UTF-8 кириллического Windows path,
  exact Unicode `cwd` для обоих launcher-ов, UI Logout semantics, runtime auth
  clear/swap, установка credentials после `/bridge/auth`, отклонение in-flight
  результата старого аккаунта, очистка state/lineage без потери `sessions.json`,
  разделение LOGOUT/SHUTDOWN и сохранение credentials при SHUTDOWN.
- Итого: `npm run typecheck` ✅, `npm test` ✅ (325/325), `npm run build` ✅.

## 2026-08-20 — Successful post-compact live tests

Проведены два live-теста Claude Code после настоящего `/compact`.

### Stale-action replay

- До compaction были созданы `anchor.txt` = `ANCHOR-OK` и
  `victim.txt` = `VICTIM-OK`, затем `victim.txt` был удалён.
- После `/compact` файл `victim.txt` вручную восстановлен со значением
  `VICTIM-RESTORED`.
- Claude Code получил только запрос прочитать `anchor.txt`.
- Результат: `anchor.txt` сохранил `ANCHOR-OK`, `victim.txt` сохранил
  `VICTIM-RESTORED`, `Test-Path victim.txt` вернул `True`; старая destructive
  команда не повторилась.

### Post-compact multi-step workflow

- Задача из 12 шагов завершилась без ручного `continue`.
- Claude Code прочитал 5 файлов, вывел содержимое 1 каталога и выполнил
  3 shell-команды.
- PowerShell подтвердил:
  - `a.txt` = `FINAL2-A-731`;
  - `second.txt` = `FINAL2-B-482`;
  - `result.txt` = `FINAL2-A-731|FINAL2-B-482`;
  - `done.txt` = `post compact final 2 verified`;
  - `Test-Path b.txt` = `False`;
  - в папке остались `a.txt`, `done.txt`, `result.txt`, `second.txt`.

Эти результаты подтверждают именно описанные post-compact сценарии; более
широкая гарантия для любых возможных compaction/workflow не заявляется.
Runtime-код не изменялся.

## 2026-08-20 — Tighten stale action replay regression coverage

- Исправлено число тестов в записи для commit `7bb70ca`: там было добавлено
  16, а не 19 offline-тестов (297 → 313).
- `tests/unit/tools.test.ts`: добавлен прямой regression-тест через публичный
  `DeepSeekClient.complete()`. Тест перехватывает реальный completion payload,
  создаёт `state.history` со старым опасным assistant content и подтверждает,
  что upstream prompt не содержит историю, но содержит текущий user request.
- `src/deepseek/client.ts`: удалены неиспользуемый импорт
  `historicalToolInvocationText` и ставший ненужным параметр `state` у
  `buildPrompt()`.
- Проверен OpenAI/Responses runtime path: HTTP-маршруты сначала нормализуют
  запрос в `CanonicalRequest`; `canonicalToRaw()` очищает canonical `tool_use`
  до `buildUpstreamPrompt()`. Raw OpenAI/Responses ветки, сериализующие
  historical arguments, текущим production runtime не достигаются. Поведение
  не изменено, отдельный TODO не добавлен.
- Итог: 314 тестов (16 файлов), все проходят.

## 2026-08-20 — Prevent stale tool action replay (architectural fix)

### Root cause

После `/compact` (или при наличии `state.history`) bridge включал в upstream
prompt **executable tool arguments** (напр. `{"command":"rm ..."}`) из прошлых
turns. DeepSeek модель, получив эти аргументы в контексте, могла повторить
опасные действия (stale-action replay). Три корневых причины:

1. `state.history` добавлялась в `buildPrompt()` ПОСЛЕ `request.messages` —
   stale assistant actions оказывались ниже текущего user message.
2. `historicalToolInvocationText()` сериализовала полные executable arguments
   в fresh upstream prompts.
3. Не было priority-правила,告诉 модели, что текущий request authoritative
   над историческим контекстом.

### Что сделано

**`src/deepseek/client.ts`:**
- Удалён цикл `for (const h of state.history)` из `buildPrompt()` —
  `state.history` больше не попадает в upstream prompt.
- `canonicalToRaw()`: tool_use parts теперь используют
  `sanitizedToolInvocationText(name, id)` вместо
  `historicalToolInvocationText(name, id, arguments)` — аргументы не
  сериализуются в upstream prompt.
- Добавлен импорт `sanitizedToolInvocationText`.

**`src/tools/toolParser.ts`:**
- Добавлена `sanitizedToolInvocationText(name, callId)` — безопасный формат
  без аргументов, с предупреждением "DO NOT execute this action again".
- `anthropicMessageText()` теперь использует `sanitizedToolInvocationText`
  вместо `historicalToolInvocationText` для tool_use блоков.

**`src/tools/toolPrompt.ts`:**
- Добавлено правило 11 (PRIORITY RULE): CURRENT user request is authoritative;
  historical conversation, compact summaries, Historical Tool Actions and
  previous tool calls are context only.

### Тесты

`tests/unit/tools.test.ts` — 16 новых offline-тестов:

**sanitizedToolInvocationText (6 тестов):**
1. содержит tool name
2. содержит call_id
3. НЕ содержит arguments
4. содержит DO NOT execute warning
5. fallback для пустого name
6. fallback для пустого callId

**buildUpstreamPrompt — stale action replay prevention (4 теста):**
7. anthropic tool_use использует sanitized формат без arguments
8. tool_result сохраняется в upstream prompt
9. tool_result использует имя из session map
10. openai path использует historicalToolInvocationText с arguments

**toolPrompt — priority rule (6 тестов):**
11. содержит PRIORITY RULE секцию
12. CURRENT user request is authoritative
13. historical context — context only
14. Historical Tool Actions упоминается как context only
15. NEVER repeat a previous external action
16. исключение для current tool_result cycle

### Итого

313 тестов (16 файлов), все проходят.

## 2026-08-19 — Handle Tool-prefixed fake tool traces

### Root cause

Live-test после `/compact` выявил новый формат fake trace. Модель выводит:

```
Tool: Bash
{"command": "pwd", "description": "Check current working directory"}
```

Это НЕ настоящий tool_call JSON — это текстовый вывод, который bridge
возвращает клиенту как финальный ответ. Старый детектор (`FAKE_TRACE_PATTERNS`)
ловит `Bash:` (с двоеточием сразу), но не `Tool: Bash` (с префиксом `Tool:`).

### Что сделано

**`src/tools/toolParser.ts`:**
- Добавлена `looksLikeToolPrefixedFakeTrace()` — детектор нового формата:
  строка `Tool: <name>` (регистронезависимо) + следующая строка `{JSON}`.
  Имя после `Tool:` сопоставляется с `allowedToolNames` (не хардкод).
- `looksLikeFakeToolTrace()` вызывает `looksLikeToolPrefixedFakeTrace()` перед
  проверкой `FAKE_TRACE_PATTERNS`.

**`tests/unit/tools.test.ts` — 10 новых тестов:**

- Tool-prefixed format (7):
  1. `Tool: Bash\n{json}` → fake trace
  2. `Tool: Read\n{json}` → fake trace
  3. `Tool: Write\n{json}` → fake trace
  4. Неизвестное имя → false
  5. Обычный текст "The Tool: Bash integration" → false
  6. Tool: без JSON на следующей строке → false
  7. Регистронезависимость `tool: bash`

- shouldRetry + Tool: prefixed (3):
  8. `Tool: Bash\n{json}` → retry
  9. `Tool: Read\n{json}` → retry
  10. Настоящий tool_call → no retry

### Итого

297 тестов (16 файлов), все проходят.

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

## 2026-08-19 — Fix completion guard attempt semantics

### Что сделано

Две проблемы в runtime completion guard (commit `8fe929e`):

1. **`verifyFinalAnswer()` — мёртвый код.** Функция добавлена в `toolParser.ts`,
   но нигде не вызывается. Она требует `PendingAction[]` — список из описания
   + fulfilled — а чтобы сформировать этот список из текста запроса пользователя,
   нужен ненадёжный эвристический парсинг естественного языка. Интеграция
   невозможна без фиктивного `PendingAction[]`. **Удалена** вместе с
   интерфейсами `PendingAction`, `FinalVerificationResult`. Честное описание:
   текущий runtime guard = fake-trace detector + bounded retry.

2. **Off-by-one в лимите attempts.** `COMPLETION_GUARD_MAX_ATTEMPTS = 3` +
   `attempts < 3` давали до 4 completion-запросов (initial + 3 retries).
   **Исправлено:** `retries < COMPLETION_GUARD_MAX_ATTEMPTS - 1` (то есть
   `retries < 2`), что даёт ровно **3 completion attempts TOTAL**
   (initial + 2 retries). Переименовано `attempts` → `retries` для ясности.

### Изменённые файлы

- `src/tools/toolParser.ts` — удалены `PendingAction`, `FinalVerificationResult`,
  `verifyFinalAnswer()`; `COMPLETION_GUARD_MAX_ATTEMPTS = 3` осталась.
- `src/deepseek/client.ts` — while loop: `attempts` → `retries`;
  условие `retries < COMPLETION_GUARD_MAX_ATTEMPTS - 1`.
- `tests/unit/tools.test.ts` — удалены 4 теста `verifyFinalAnswer`;
  тест `COMPLETION_GUARD_MAX_ATTEMPTS` теперь проверяет точное значение `3`.

### Итого

287 тестов (16 файлов), все проходят.

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
