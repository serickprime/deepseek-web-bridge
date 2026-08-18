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

## Как скачать и запустить (Windows)

1. Скачайте проект (кнопка **Code → Download ZIP**) и распакуйте, например, в `D:\AI\DeepSeekBridge`.
   Не распаковывайте в `C:\Program Files`.
2. Дважды нажмите `START_DEEPSEEK.cmd`.
3. Дождитесь открытия панели `http://127.0.0.1:9655/setup`.

## Первый вход в DeepSeek

1. В панели нажмите **Войти в DeepSeek**.
2. В отдельном окне Chrome войдите в свой аккаунт. CAPTCHA и 2FA проходите сами.
3. Отправьте в DeepSeek короткое сообщение (например `ok`) и дождитесь ответа.
4. Вернитесь в терминал и нажмите Enter.

Bridge сохранит данные сессии в `data/auth.json`. Логин и пароль не сохраняются,
token и cookies в терминале не показываются.

## Запуск Claude Code

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:9655"
$env:ANTHROPIC_AUTH_TOKEN="local-key"
$env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1"
claude --model deepseek-reasoner
```

`local-key` здесь — локальное служебное значение, не ключ вашего аккаунта DeepSeek.

## Запуск OpenCode

Панель предлагает готовый `opencode.json`. Ручной запуск из папки Bridge:

```powershell
$env:OPENCODE_CONFIG=(Resolve-Path ".\opencode.json")
opencode --model deepseek-web/deepseek-reasoner
```

## Другой OpenAI-совместимый клиент

```
Base URL: http://127.0.0.1:9655/v1
Model:    deepseek-chat или другой доступный режим
API key:  local-key (если клиент требует что-то указать)
```

## Команды

| Команда | Что делает |
| --- | --- |
| `npm run auth` | повторить вход в DeepSeek в отдельном Chrome |
| `npm run doctor` | полная диагностика DeepSeek Web (делает реальный короткий запрос) |
| `npm test` | offline-тесты без обращения к DeepSeek |
| `npm run test:live` | ручная live-проверка с вашим аккаунтом |
| `npm run typecheck` | проверка типов |

## Модели

`GET /v1/models` показывает только те режимы, которые подтверждены как рабочие.
Базовый набор: `deepseek-chat`, `deepseek-reasoner`, `deepseek-chat-search`,
`deepseek-reasoner-search`, `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-expert`.
Доступность проверяется на лету.

## Документация

- [Состояние проекта (статус, TODO)](PROJECT_STATE.md)
- [Журнал изменений](CHANGELOG.md)
- [Инструкция для ИИ-агентов](AGENTS.md)
- [Архитектура](docs/architecture.md)
- [Протоколы](docs/protocols.md)
- [Диагностика](docs/troubleshooting.md)
- [Live-проверка](docs/live-validation.md)
- [Безопасность](SECURITY.md)

## Лицензия

MIT.
