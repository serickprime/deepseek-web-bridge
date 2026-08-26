# Модель угроз (threat model)

## Активы

- `data/auth.json` — токен и cookies DeepSeek-сессии. Эквивалент доступа к
  аккаунту пользователя.
- `data/sessions.json` — ссылки на upstream-сессии.
- `data/chrome-profile/` — локальные данные браузера авторизации.
- `PROXY_API_KEY` — локальный ключ API (если задан).
- Пользовательские промпты и результаты инструментов.

## Угрозы и меры

| Угроза | Мера |
| --- | --- |
| Утечка токена/куки в логи | redaction в `src/utils/redaction.ts`; логгер удаляет Authorization, Bearer, cookie, token, полные пути. Уровень `DS_DEBUG` не отключает redaction. |
| Утечка в терминал | `npm run auth` и doctor не печатают token/cookies. |
| Файлы auth в Git | `.gitignore` исключает `data/`, `deepseek-auth.json`, `.env`, chrome-profiles. |
| Доступ к серверу извне | по умолчанию `127.0.0.1`; не-loopback `HOST` блокируется без `PROXY_API_KEY` (>= 24 символов). Ключи сравниваются constant-time. |
| CSRF / подмена Origin | CORS по умолчанию только loopback-источники; дополнительные задаются явно. |
| Огромное тело запроса | лимит размера тела (413). |
| Долгие/зависшие запросы | таймауты upstream и сервера. |
| Модель зовёт неизвестный/вредный инструмент | allowlist из `tools` запроса клиента; строгий парсер; опасные ключи `__proto__`/`prototype`/`constructor` запрещены; глубина и размер ограничены. |
| Токен подменён в логах при отладке | `request_ref` случайный на запрос; session refs непрозрачны (HMAC со случайной солью процесса). |
| Подмена upstream | TLS-проверка не отключается; самоподписанный upstream сертификат не принимается. |
| Смешивание сессий клиентов | нет общей fallback-сессии; explicit upstream identity и связь call-id; mutex на одну upstream-сессию. |
| Повторное использование чужих credential | токен/куки из `data/auth.json` принадлежат только владельцу; никакие auth-данные не отправляются третьим сторонам. |
| Orphan owned process или broad shutdown kill | Bridge хранит только созданные им process records; Windows использует exact PID tree, Unix — exact runner/launcher PID, macOS — exact window id + tty. Signal/helper result не очищает ownership без подтверждённого target exit. Untracked processes и весь Terminal.app/emulator по имени не завершаются. |
| Зависший shutdown helper | Owned process wait ограничен 5 s, macOS helper — 2 s, весь coordinator — 10 s. Неподтверждённая cleanup возвращает `SHUTDOWN_INCOMPLETE` и exit code 1 без raw error/argv/path telemetry. |

## Не принимаемые меры

Bridge не обходит и не отключает: CAPTCHA, 2FA, rate limits, блокировки аккаунта,
TLS. Эти механизмы пользователь проходит/соблюдает вручную. При ошибке
авторизации Bridge просит выполнить `npm run auth` вручную, а не пытается
автоматически «оживить» сессию.

## Остаточные риски

- Внутренний Web API DeepSeek может меняться; новые версии могут требовать новых
  заголовков, другого PoW или формата SSE.
- Prompt-совместимый tool calling не гарантирует, что модель всегда вернёт
  строгий JSON-вызов.
- Локальный `count_tokens` — приблизительная оценка, не официальный токенизатор.
- Recap/compaction в текущем Claude Code воспроизводимо не подтверждены; поведение
  помечается `UNKNOWN`, пока не подтверждено live-тестом.
- Точечное Unix PID ownership не включает portable process-start identity;
  теоретический PID reuse остаётся residual risk. Новый cross-platform identity
  subsystem не вводится без отдельного доказательства необходимости.
- D10 lifecycle покрыт deterministic tests, но Windows desktop PB39 и настоящие
  macOS/Linux GUI terminal shutdown остаются pending до independent/live проверки.
