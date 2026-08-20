# DeepSeek Web Bridge

Локальный мост, который превращает вашу собственную авторизованную веб-сессию
`chat.deepseek.com` в локальный API для Claude Code, OpenCode и других
OpenAI-совместимых клиентов.

> Это **не официальный API DeepSeek**. Проект использует внутренний Web API сайта
> `chat.deepseek.com` через вашу личную сессию. DeepSeek может менять внутренние
> маршруты, PoW, WASM и лимиты — после такого обновления Bridge может временно
> перестать работать.

## Что нужно

- Windows 10/11, macOS или Linux;
- Node.js 20 или новее;
- Google Chrome;
- ваш собственный аккаунт DeepSeek;
- Claude Code или OpenCode — только если хотите запускать этих CLI-агентов.

Node.js ставьте LTS-версией с [официального сайта](https://nodejs.org/en/download).
Chrome скачайте с [официальной страницы](https://www.google.com/chrome/download-chrome).

## Установка и запуск

```bash
git clone https://github.com/serickprime/deepseek-web-bridge.git
cd deepseek-web-bridge
npm install
npm run auth       # первый вход (см. раздел «Авторизация»)
npm run doctor     # диагностика — убедитесь, что все проверки пройдены
npm start          # запуск сервера на http://127.0.0.1:9655
```

Альтернатива — текстовое меню:

```bash
npm run ui
```

Оно предложит: `[1]` авторизация, `[2]` диагностика, `[3]` запуск сервера, `[4]` выход.

## Авторизация

```bash
npm run auth
```

Скрипт откроет Chrome через CDP (Chrome DevTools Protocol) и перейдёт на
`chat.deepseek.com`. Войдите в свой аккаунт (CAPTCHA и 2FA — вручную).
**После входа отправьте любое сообщение** (например `ok`) — это генерирует
авторизованный API-запрос, из которого Bridge захватывает Bearer token. HIF
сохраняется дополнительно, если текущая версия DeepSeek его предоставляет.

Скрипт перехватит токен и cookies из запросов к DeepSeek API, проверит их
и сохранит в `data/auth.json` (права `0600`). Логин и пароль не сохраняются.

## Запуск Claude Code

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:9655"
$env:ANTHROPIC_AUTH_TOKEN="local-key"
$env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1"
claude --model deepseek-reasoner
```

`local-key` здесь — локальное служебное значение, не ключ вашего аккаунта DeepSeek.

Также можно запустить Claude Code через Bridge Console (`GET /` в браузере) —
на Windows выберите модель, рабочую директорию и нажмите Launch. На macOS/Linux
автоматический запуск интерактивного терминала пока отключён: запустите CLI вручную.

## Запуск OpenCode

OpenCode подключается к Bridge как к OpenAI-совместимому серверу:

```powershell
$env:OPENAI_API_BASE="http://127.0.0.1:9655/v1"
$env:OPENAI_API_KEY="local-key"
opencode --model deepseek-chat
```

## Другой OpenAI-совместимый клиент

```
Base URL: http://127.0.0.1:9655/v1
Model:    deepseek-chat или deepseek-reasoner
API key:  local-key (если клиент требует что-то указать)
```

## Команды

| Команда | Что делает |
| --- | --- |
| `npm run auth` | вход в DeepSeek через Chrome CDP (откроется браузер) |
| `npm run doctor` | полная диагностика (auth, reachable, challenge, PoW, completion) |
| `npm run ui` | текстовое меню: авторизация → диагностика → запуск |
| `npm test` | offline-тесты без обращения к DeepSeek |
| `npm run test:live` | live-проверка с вашим аккаунтом (требует запущенный сервер) |
| `npm run typecheck` | проверка типов TypeScript |
| `npm start` | запуск Bridge-сервера |

## Модели

`GET /v1/models` возвращает статический список:

| Model ID | Описание |
| --- | --- |
| `deepseek-chat` | DeepSeek Chat |
| `deepseek-reasoner` | DeepSeek Reasoner |

Клиент (Claude Code / OpenCode) указывает модель при подключении.
Список моделей обновляется в коде при добавлении новых рабочих режимов.

## Документация

- [Состояние проекта (статус, TODO)](PROJECT_STATE.md)
- [Журнал изменений](CHANGELOG.md)
- [Инструкция для ИИ-агентов](AGENTS.md)
- [Архитектура](docs/architecture.md)
- [Модель угроз](docs/threat-model.md)
- [Безопасность](SECURITY.md)

## Лицензия

MIT.
