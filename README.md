# fast_track

HTTP-сервис отслеживания курсов криптовалют. Список монет хранится в SQLite, цены берутся из CoinMarketCap Pro API, история пишется в базу, фоновая задача обновляет цены по расписанию. Стек: Node.js 22, Express 5, TypeScript, SQLite (`better-sqlite3`, сырой SQL без ORM), axios, Jest + Supertest, Swagger UI, Docker.

## Быстрый старт

Нужен ключ CoinMarketCap: зарегистрируйтесь на [pro.coinmarketcap.com](https://pro.coinmarketcap.com/signup) (хватает бесплатного плана Basic) и скопируйте API Key в `.env`.

```bash
cp .env.example .env          # впишите CMC_API_KEY
```

**Docker:**

```bash
docker compose up --build -d
docker compose exec api node dist/scripts/create-api-key.js --name local --role admin
```

**Локально** (Node.js 22.9+):

```bash
npm ci
npm run build
npm run apikey:create -- --name local --role admin
npm start
```

Команда создания ключа печатает его один раз. Проверка:

```bash
curl http://localhost:3000/status
curl -H "Authorization: Bearer ft_..." -H "Content-Type: application/json" \
     -X POST http://localhost:3000/api/coins -d '{"symbol":"BTC"}'
curl -H "Authorization: Bearer ft_..." http://localhost:3000/api/coins/BTC/price
```

Документация API и «Try it out»: http://localhost:3000/docs (кнопка Authorize принимает ключ сервиса `ft_...`).

## Переменные окружения

Неверное значение останавливает процесс при старте с понятным сообщением. Полный пример — `.env.example`.

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `3000` | порт HTTP |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug`, `silent` |
| `DB_PATH` | `./data/app.db` | файл SQLite (в Docker — `/data/app.db` в volume) |
| `CMC_API_KEY` | — | ключ CoinMarketCap, обязателен |
| `CMC_BASE_URL` | `https://pro-api.coinmarketcap.com` | адрес API |
| `CMC_TIMEOUT_MS` / `CMC_DEADLINE_MS` | `5000` / `8000` | таймаут одной попытки / всех попыток вместе |
| `QUOTE_CURRENCY` | `USD` | валюта котировок |
| `PRICE_MAX_AGE_MS` | `360000` | сколько цена в базе считается свежей для `/price` |
| `MAX_TRACKED_COINS` | `200` | лимит отслеживаемых монет |
| `SYNC_ENABLED` | `true` | фоновая синхронизация |
| `SYNC_INTERVAL_MS` | `300000` | интервал синхронизации (≥ 60000) |
| `SYNC_INITIAL_DELAY_MS` | `5000` | пауза перед первым запуском |
| `SYNC_MAX_BACKOFF_MS` | `3600000` | максимальная пауза после ошибок CMC |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | сколько ждать корректной остановки |

## API-ключи

Все `/api/*` требуют `Authorization: Bearer <key>`. Роли: `read` — чтение монет и цен; `admin` — ещё создание, изменение, удаление монет и мониторинг задач. В базе хранится только sha256-хеш ключа.

```bash
npm run apikey:create -- --name local --role admin   # в Docker: docker compose exec api node dist/scripts/create-api-key.js ...
npm run apikey:revoke -- --id 1
```

## Эндпоинты

| Метод и путь | Роль | Описание |
|---|---|---|
| `GET /status` | — | живость и проверка базы (200 / 503) |
| `GET /api/coins` | read, admin | список монет, `limit`, `offset`, `isActive` |
| `POST /api/coins` | admin | добавить монету по символу (ищется в CoinMarketCap) |
| `GET /api/coins/:symbol` | read, admin | карточка монеты |
| `PATCH /api/coins/:symbol` | admin | `{ "isActive": false }` — пауза синхронизации |
| `DELETE /api/coins/:symbol` | admin | удалить монету вместе с историей |
| `GET /api/coins/:symbol/price` | read, admin | текущая цена: из базы, если свежая, иначе из CMC; при сбое CMC — последняя сохранённая со `stale: true` |
| `GET /api/coins/:symbol/history` | read, admin | история: `from`, `to` (UTC; дата без времени в `to` — до конца дня), `limit`, `offset`, `order` |
| `GET /api/jobs` | admin | состояние фоновых задач и последний запуск |
| `GET /api/jobs/runs` | admin | история запусков: `job`, `status`, `limit`, `offset` |

Ошибки всегда в формате `{ "error": { "code", "message", "requestId", "details?" } }`. Коды ответов для каждой операции описаны в Swagger (`/docs`, `/openapi.json`).

## Фоновая синхронизация

Задача `sync-prices` раз в `SYNC_INTERVAL_MS` запрашивает котировки всех активных монет **одним** запросом к CoinMarketCap и сохраняет их в историю. Следующий запуск планируется после окончания текущего, поэтому запуски не накладываются. При минутном лимите CMC (1008) цикл пропускается, при проблемах с ключом или бюджетом пауза удваивается до `SYNC_MAX_BACKOFF_MS`.

Каждый запуск пишется в таблицу `job_runs`:

| Статус | Значение |
|---|---|
| `running` | идёт |
| `success` | все монеты обновлены |
| `partial` | часть монет не обновлена |
| `failed` | ошибка, см. `error_code` |
| `skipped` | нет активных монет, запроса не было |
| `aborted` | прерван остановкой сервиса или аварийным завершением процесса |

**Кредиты CMC:** 1 запрос на запуск, при интервале 5 минут — около 8 640 в месяц (план Basic — 10 000). `/price` при `PRICE_MAX_AGE_MS` ≥ `SYNC_INTERVAL_MS` почти всегда отвечает из базы.

## Тесты

```bash
npm test
npm run test:coverage
npm run typecheck
```

Тесты не ходят в сеть: ответы CoinMarketCap лежат в `tests/fixtures/cmc`. Каждый тест работает с отдельным временным файлом SQLite. Планировщик проверяется на fake timers Jest.

## Принятые решения

- **Сырой SQL через `better-sqlite3`**, без ORM. Миграции — TS-модули, применяются при старте в одной транзакции.
- **Данные только в SQLite.** В памяти процесса лишь состояние таймеров (когда следующий запуск); оно не является данными и строится заново после рестарта. Файл базы не входит в репозиторий.
- **Слои:** routes → controller (валидация входа) → service (логика) → repository (SQL). Внешний API скрыт за интерфейсами, поэтому в тестах подменяется фейком.
- **Ключи API** хранятся как sha256: ключ длинный и случайный, а хеш проверяется на каждом запросе.
- **Внешние запросы:** таймаут на попытку и общий дедлайн, повтор только для таймаутов, сетевых ошибок и 5xx, понятные коды 502/503/504 и `Retry-After` при лимите. Ключ CMC не попадает в логи и ответы.
- **Graceful shutdown** по SIGINT/SIGTERM: сервер перестаёт принимать запросы, планировщик очищает таймеры и прерывает текущий запрос к CMC (запуск пишется как `aborted`), затем закрывается база. При старте незавершённые запуски помечаются `aborted`.
- **Docker:** multi-stage сборка, процесс от непривилегированного пользователя, база в volume, healthcheck на `/status`. `CMD ["node", ...]` вместо `npm start`, чтобы SIGTERM от `docker stop` доходил до процесса; `stop_grace_period` больше `SHUTDOWN_TIMEOUT_MS`.
- **Библиотеки:** `express`, `better-sqlite3`, `axios`, `swagger-ui-express`; для разработки — `typescript`, `jest`, `ts-jest`, `supertest`. Конфиг, валидация и логгер написаны без дополнительных пакетов.
