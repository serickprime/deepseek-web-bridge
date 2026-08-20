# DeepSeek Web Bridge

Локальный мост, который превращает вашу собственную авторизованную веб-сессию
`chat.deepseek.com` в локальный API для Claude Code, OpenCode и других
OpenAI-совместимых клиентов.

> Это **не официальный API DeepSeek**. Проект использует внутренний Web API сайта
> `chat.deepseek.com` через вашу личную сессию. DeepSeek может менять внутренние
> маршруты, PoW, WASM и лимиты — после такого обновления Bridge может временно
> перестать работать.

## Быстрый запуск

Понадобятся Node.js 20 или новее, Google Chrome и ваш аккаунт DeepSeek.
Claude Code или OpenCode нужны только для запуска соответствующего CLI-агента.

### Windows

1. Скачайте ZIP проекта с GitHub.
2. Распакуйте ZIP в любую папку.
3. Дважды нажмите `START.bat`.
4. Дождитесь открытия браузера с Bridge Console.
5. Нажмите **AUTH** и войдите в DeepSeek.
6. Выберите папку вашего проекта.
7. Нажмите **Launch Claude Code** или **Launch OpenCode**.

### macOS

1. Скачайте ZIP проекта с GitHub.
2. Распакуйте ZIP в любую папку.
3. Дважды нажмите `START.command`.
4. Дождитесь открытия браузера.
5. Нажмите **AUTH** и войдите в DeepSeek.
6. Выберите папку проекта.
7. Нажмите **Launch Claude Code** или **Launch OpenCode**.

При первом запуске macOS может показать стандартное предупреждение для файла,
скачанного из интернета. В Finder нажмите правой кнопкой на `START.command` и
выберите **Открыть**. Проект не отключает и не обходит Gatekeeper.

### Linux

1. Скачайте и распакуйте ZIP проекта.
2. Дважды нажмите `DeepSeek Web Bridge.desktop`.
3. Если окружение рабочего стола попросит, выберите **Allow Launching / Разрешить запуск**.
4. Дождитесь открытия браузера.
5. Нажмите **AUTH** и войдите в DeepSeek.
6. Выберите папку проекта.
7. Нажмите **Launch Claude Code** или **Launch OpenCode**.

Если `.desktop` не поддерживается вашим окружением, используйте `START.sh`.

При первом запуске START автоматически выполняет `npm install`, собирает проект,
запускает Bridge и открывает `http://127.0.0.1:9655`. При следующих запусках
пересборка выполняется только при необходимости. Если Bridge уже работает,
второй экземпляр не запускается — просто открывается существующий Web UI.

Если Node.js отсутствует или его версия ниже 20, START покажет понятное сообщение
и откроет [официальную страницу загрузки Node.js](https://nodejs.org/en/download).
Никакая программа при этом не устанавливается скрытно. Chrome можно скачать с
[официальной страницы](https://www.google.com/chrome/download-chrome).

## Ручной запуск / Для разработчиков

```bash
git clone https://github.com/serickprime/deepseek-web-bridge.git
cd deepseek-web-bridge
npm install
npm run build
npm start
```

Для ручной авторизации и диагностики используйте `npm run auth` и
`npm run doctor`. Текстовое меню запускается командой `npm run ui`.

## Авторизация

В обычном сценарии нажмите **AUTH** в Bridge Console. Для ручного запуска можно
использовать `npm run auth`.

Авторизация откроет Chrome и перейдёт на
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
claude --model deepseek-v4-flash
```

Для Expert Mode укажите `--model deepseek-v4-pro`. Thinking не является
отдельной моделью: если клиент отправляет Anthropic
`thinking: { "type": "enabled" }`, Bridge включает его для выбранной Flash/Pro.

`local-key` здесь — локальное служебное значение, не ключ вашего аккаунта DeepSeek.

Также можно запустить Claude Code или OpenCode через Bridge Console (`GET /` в
браузере): выберите модель, рабочую директорию и нажмите Launch. Bridge открывает
видимый интерактивный терминал:

- Windows — текущий системный terminal launch;
- macOS — новая сессия Terminal.app через `osascript`;
- Linux — первый найденный emulator: `x-terminal-emulator`, `gnome-terminal`,
  `konsole`, `xfce4-terminal`, `kitty`, `xterm`.

Если на Linux нет поддержанного terminal emulator, кнопки Launch отключены и CLI
можно запустить вручную. Capability означает доступность поддержанного terminal
transport; наличие бинарников `claude`/`opencode` проверяется при самом запуске.
Пути с Unicode и `~/` поддерживаются на macOS/Linux.

## Запуск OpenCode

При запуске из Bridge Console OpenCode получает временную конфигурацию только
через environment дочернего процесса. Глобальный config пользователя не
изменяется. В интерфейсе OpenCode модель отображается как:

- `deepseek-bridge/deepseek-v4-flash`;
- `deepseek-bridge/deepseek-v4-pro`.

Bridge Console передаёт явный `--model deepseek-bridge/<model>` и локальный
custom provider `DeepSeek Bridge`, поэтому OpenCode не выбирает OpenCode Zen или
другой provider из пользовательских настроек.

## Другой OpenAI-совместимый клиент

```
Base URL: http://127.0.0.1:9655/v1
Model:    deepseek-v4-flash или deepseek-v4-pro
API key:  local-key (если клиент требует что-то указать)
```

## Команды

| Команда | Что делает |
| --- | --- |
| `npm run auth` | вход в DeepSeek через Chrome CDP (откроется браузер) |
| `npm run doctor` | полная диагностика (auth, reachable, challenge, PoW, completion) |
| `npm run ui` | текстовое меню: авторизация → диагностика → запуск |
| `npm test` | offline-тесты без обращения к DeepSeek |
| `npm run test:platform` | изолированный smoke текущей ОС: Bridge HTTP, Unicode cwd и child env; DeepSeek auth не нужен |
| `npm run test:live` | live-проверка с вашим аккаунтом (требует запущенный сервер) |
| `npm run typecheck` | проверка типов TypeScript |
| `npm start` | запуск Bridge-сервера |

## Cross-platform validation

GitHub Actions запускает `npm ci`, typecheck, все offline-тесты, build и
`npm run test:platform` на `windows-latest`, `macos-latest` и `ubuntu-latest`.
Platform smoke использует только временные каталоги и placeholder env, поднимает
локальный Bridge без `auth.json`, проверяет `/health`, `/readyz`, `/api/system`,
Unicode cwd и передачу Bridge env в реальный child process.

Уровни проверки различаются намеренно:

1. `npm test` — unit/platform-mocked проверки логики и argv builders;
2. GitHub Actions — выполнение на реальном kernel/filesystem каждой ОС без GUI;
3. desktop GUI live-test — визуальный picker и интерактивный Terminal.app/Linux
   terminal. Он подтверждён на Windows, но для macOS/Linux пока остаётся TODO.

CI не открывает настоящий Claude Code/OpenCode и не считается проверкой видимого
GUI-терминала.

## Модели

`GET /v1/models` возвращает две основные модели:

| Model ID | Описание |
| --- | --- |
| `deepseek-v4-flash` | DeepSeek V4 Flash; Instant Mode (`model_type: "default"`) |
| `deepseek-v4-pro` | DeepSeek V4 Pro; Expert Mode (`model_type: "expert"`) |

Thinking передаётся отдельно от модели: `reasoning: true/false` в локальном
OpenAI/Responses contract или Anthropic `thinking.type`. Search подтверждён для
Instant/Flash и передаётся как `search: true`; в текущем Expert Web UI Search
недоступен.

Legacy aliases `deepseek-chat` и `deepseek-reasoner` принимаются для
совместимости, но не публикуются в `/v1/models`: оба ведут на V4 Flash, а
`deepseek-reasoner` по умолчанию включает Thinking. Актуальное соответствие
Instant/Expert моделям V4 также опубликовано в
[официальном релизе DeepSeek V4](https://deepseek.com/en/news/v4-preview/).

## Документация

- [Состояние проекта (статус, TODO)](PROJECT_STATE.md)
- [Журнал изменений](CHANGELOG.md)
- [Инструкция для ИИ-агентов](AGENTS.md)
- [Архитектура](docs/architecture.md)
- [Модель угроз](docs/threat-model.md)
- [Безопасность](SECURITY.md)

## Лицензия

MIT.
