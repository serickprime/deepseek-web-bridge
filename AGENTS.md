# AGENTS.md — инструкция для ИИ-агентов

Этот файл читают агенты (Claude Code, OpenCode, Cursor, Copilot и т.д.), которые
работают в этом репозитории. Он определяет **обязательные правила**, а не
рекомендации.

## 1. Обязательное чтение перед началом любой задачи

Перед тем как что-то писать или менять, прочитай в таком порядке:

1. `AGENTS.md` (этот файл) — правила работы;
2. `PROJECT_STATE.md` — **главный файл состояния**: на какой стадии проект,
   что готово, что осталось, какие проверки проходят;
3. `docs/architecture.md` — архитектура и слои;
4. `docs/threat-model.md` — модель угроз и обязательные требования безопасности.

Если задача касается команд/протоколов — сверься также с `README.md`.

## 2. Обязательное чтение при любом изменении кода

- **Всегда** сверяйся с `PROJECT_STATE.md`: не завершай работу «в вакууме»,
  не зная, что уже реализовано и какие есть TODO.
- После завершения задачи **обязательно** обнови:
  - `CHANGELOG.md` — добавь запись `YYYY-MM-DD` с описанием изменения и файлами;
  - `PROJECT_STATE.md` — поменяй статусы фаз, пометь выполненные/закрытые TODO,
    обнови «Актуально на:».

## 3. Правила проверки

- После любых изменений запускай `npm run typecheck` и `npm test`.
  Это минимальный набор. Если изменились скрипты/entry — также `npm run build`.
- Offline-тесты (`npm test`) не должны обращаться к аккаунту DeepSeek.
  Live-проверки — только через `npm run doctor` и `npm run test:live`.
- Не меняй форматы запросов/ответов внутреннего API DeepSeek
  (`src/deepseek/*`) без live-проверки: это внешняя система, которую мы не
  контролируем.

## 4. Безопасность (жёсткие требования)

- Секреты (token, cookie, hif-заголовки) живут только в `data/auth.json`
  с правами `0600`. Никогда: в код, README, логи, коммиты, тесты.
- Логи всегда проходят через `Redactor` (`src/utils/redaction.ts`).
- Нет отладочного вывода token/cookie в stdout.
- Не-loopback слушатель требует `PROXY_API_KEY` (>= 24 символов) — это уже
  проверяется в `src/config/env.ts`; не ослабляй эту проверку.

## 5. Что должно получиться в итоге (для контекста)

Рабочая цепочка «из коробки»:
`npm run auth` (вход) → `npm run doctor` (диагностика) → `npm start`
(сервер на `http://127.0.0.1:9655`) → клиент (Claude Code / OpenCode / OpenAI SDK)
`→ npm run test:live` (проверка). Подробнее — в `PROJECT_STATE.md`.

## 6. Стиль кода

- TypeScript, strict mode, ESM с расширениями `.js` в импортах.
- Без внешних фреймворков в рантайме (только `ws` в зависимостях).
- Комментарии в коде — только когда действительно нужны.
- Ошибки — через `BridgeError` из `src/utils/errors.ts` с кодом и HTTP-статусом.
- Новый модуль — по образцу соседних в том же каталоге.

# Release Mode v1.0

До выпуска v1.0 действует обязательный **scope freeze**. Цель release mode —
стабилизировать существующий контракт Claude Code → Bridge → DeepSeek Web и
выпустить рабочую v1.0, а не бесконечно расширять проект.

## Scope freeze

Без отдельного решения запрещено:

- добавлять новые функции, providers или UI-возможности;
- делать архитектурные рефакторинги и улучшать код «заодно»;
- исправлять unrelated bugs в рамках текущего defect;
- автоматически превращать каждый новый linguistic/edge case в release blocker.

## Release blocker policy

Новый finding блокирует v1.0 только при доказанном хотя бы одном outcome:

1. неправильный tool call или выполнение не того действия;
2. потеря, повреждение или неправильная запись пользовательских данных;
3. security/privacy defect;
4. fabricated, replayed или duplicate tool execution;
5. `tool_result`, относящийся не к тому `tool_use`, session или lineage;
6. воспроизводимый unexpected 5xx/502;
7. hang, deadlock или unbounded retry;
8. crash;
9. потеря session/persistence state в заявленном supported flow;
10. regression уже закрытого и протестированного P0/P1 contract;
11. основной supported Claude Code workflow невозможно нормально использовать.

Редкий linguistic edge case, cosmetic issue, unsupported wording, minor
observability issue, deferred provider/UI feature или архитектурное улучшение,
не ломающие supported workflow, по умолчанию идут в backlog v1.1. Исключение —
конкретный edge case с доказанным blocker outcome из списка выше.

## Regression-first rule

До изменения production-кода обязательны deterministic reproduction, а когда
возможно — A/B с предыдущей known-good revision и классификация finding как
introduced regression либо pre-existing collateral.

После любого изменения кода обязательны:

```text
npm run typecheck
npm test
npm run build
npm run test:platform
git diff --check
```

Focused tests сами по себе не закрывают задачу.

## Existing-test protection

Старый тест нельзя удалить, ослабить или переписать expectation под новый код
только ради green suite. Изменение прежнего contract требует сначала
документированного доказательства. Неожиданное падение старого теста сначала
считается regression.

## One defect / one layer

Сохраняется hardening rule: один defect, один primary layer, минимальный
production diff, никакого scope creep. Collateral findings фиксируются отдельно.

## Independent review

Для P0/P1 действует цепочка:

`implementation → full regression → independent read-only review → live acceptance (если defect runtime-facing) → closure`.

Reviewer не исправляет код во время review.

## Stop rule

После закрытия текущего P1 D18 запрещено продолжать бесконечный поиск новых
искусственных языковых форм. Работа переходит к release acceptance. Findings из
acceptance классифицируются только через Release Blocker Policy. P2/P3 не
останавливают релиз без доказанного влияния на supported workflow.

## v1.0 supported scope

- primary client: Claude Code;
- primary protocol: Anthropic Messages API compatible flow;
- upstream: DeepSeek Web;
- normal text completion;
- `Write`, `Read`, `Edit`, `Bash`;
- sequential/multi-step tool cycles;
- корректная корреляция `tool_use`/`tool_result`;
- bounded malformed-tool repair;
- persistence/restart/resume в заявленном contract;
- graceful shutdown, `/compact` и нормальная long-session работа.

OpenCode, дополнительные providers и новые UI-возможности не являются v1.0
release blockers, если они явно не входят в supported scope.

## Release path

После D18 этапы выполняются последовательно:

1. R1 — D18 independent review;
2. R2 — D18 Windows live;
3. R3 — pre-merge core acceptance: text / Write / Read / Edit / Bash /
   multi-step / shutdown;
4. R4 — PB-v1 deterministic acceptance;
5. R5 — 30–50 tool stress runs;
6. R6 — `/compact`;
7. R7 — restart/resume/persistence;
8. R8 — final full regression + release documentation;
9. R9 — v1.0 release candidate;
10. R10 — v1.0.

После PASS этап не повторяется без regression evidence.

## Production exit criteria

v1.0 RC допустим, когда open P0 = 0, open release-blocking P1 = 0, full и
platform tests green, core live/stress/`compact`/restart/resume/shutdown
acceptance green, в supported flow нет reproducible unexpected 502/hang, а
известные P2/P3 перечислены в backlog/known limitations.

`Production Ready` не означает отсутствие вообще любых bugs. Это означает, что
в поддерживаемом v1.0 contract нет известных release blockers.

## Backlog v1.1

Structured obligation planner, shadow mode и другие архитектурные улучшения —
отдельный backlog v1.1. До v1.0 они не внедряются, если текущий parser проходит
release acceptance.
