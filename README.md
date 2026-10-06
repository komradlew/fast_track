# fast_track

HTTP-сервис на Node.js, который будет отслеживать цены криптовалют через CoinMarketCap Pro API. Сейчас это каркас Дня 1: конфигурация из окружения, JSON-логи, единый формат ошибок и `GET /status`. Клиент CoinMarketCap, база и фоновая синхронизация появятся в следующих днях. Их настройки уже читаются и проверяются при старте.

## Требования

- Node.js 22.9 или новее. Скрипты `start` и `dev:run` передают окружение через флаг `--env-file-if-exists`, он есть только с этой версии. В корне лежит `.nvmrc` со значением `22`.
- npm.

## Ключ CoinMarketCap

1. Зарегистрируйтесь в Developer Portal: [pro.coinmarketcap.com/signup](https://pro.coinmarketcap.com/signup). Для проверки хватает бесплатного плана Basic.
2. Откройте [pro.coinmarketcap.com/account](https://pro.coinmarketcap.com/account). Ключ лежит в блоке API Key на вкладке Overview. Наведите курсор, чтобы показать его, и скопируйте кнопкой Copy Key.
3. Вставьте ключ в локальный `.env` в поле `CMC_API_KEY`. Файл `.env` в git не попадает. В репозитории остаётся только `.env.example` с плейсхолдером `YOUR_API_KEY`.

Запросы к Pro API пойдут на `https://pro-api.coinmarketcap.com` с заголовком `X-CMC_PRO_API_KEY`. Ключ не пишется в логи и не возвращается в тексте ошибки конфигурации.

## Запуск

```bash
cp .env.example .env
# впишите CMC_API_KEY
npm ci
npm run build
npm start
```

Сервер слушает порт из `PORT` (по умолчанию 3000). Проверка:

```bash
curl -s http://localhost:3000/status
```

Ответ `200` и JSON `{ "status": "ok", "uptimeSec", "timestamp", "version" }`. `version` берётся из `package.json`. В ответе есть заголовок `X-Request-Id`. Заголовка `X-Powered-By` нет.

Если порт занят, процесс пишет лог `Server failed to start` и завершается с кодом 1.

### Разработка

Сборка и процесс разнесены по двум командам. В первом терминале:

```bash
npm run dev
```

Это `tsc -p tsconfig.build.json --watch`: при сохранении файлов в `src` обновляется `dist`. Во втором терминале, когда первая сборка уже прошла:

```bash
npm run dev:run
```

Это `node --watch --env-file-if-exists=.env dist/server.js`. Node перезапускает процесс, когда меняется `dist`.

Проверка типов без запуска тестов: `npm run typecheck`.

## Переменные окружения

Пустое значение не подставляется как значение по умолчанию: если переменная задана, она должна быть валидной. Незаданная переменная получает значение из таблицы. Целые числа принимаются только как последовательность цифр, без пробелов, `0x` и экспоненты. `CMC_API_KEY` обрезается по краям.

| Переменная | По умолчанию | Правило |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `production` или `test` |
| `PORT` | `3000` | целое от 1 до 65535 |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug`, `silent` |
| `DB_PATH` | `./data/app.db` | непустая строка, путь к базе на следующих днях |
| `CMC_BASE_URL` | `https://pro-api.coinmarketcap.com` | URL со схемой `http` или `https` |
| `CMC_API_KEY` | нет | обязателен, если `NODE_ENV` не `test`. В тестах можно не задавать |
| `CMC_TIMEOUT_MS` | `5000` | целое от 100 до 60000 |
| `QUOTE_CURRENCY` | `USD` | 3–5 заглавных латинских букв |
| `PRICE_MAX_AGE_MS` | `60000` | целое ≥ 0 |
| `MAX_TRACKED_COINS` | `200` | целое от 1 до 200 |
| `SYNC_INTERVAL_MS` | `300000` | целое ≥ 60000 |
| `SYNC_ENABLED` | `true` | только `true` или `false` |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | целое от 1000 до 60000 |

Неверное значение останавливает процесс до `listen`: в stderr одна строка вида `Invalid env PORT: expected integer 1..65535, got "abc"`, код выхода 1. Для отсутствующего ключа текст такой: `Invalid env CMC_API_KEY: expected non-empty string`. Сам ключ в это сообщение не попадает.

## Тесты

Ключ CoinMarketCap для тестов не нужен: `tests/setup.ts` выставляет `NODE_ENV=test` и `LOG_LEVEL=silent`.

```bash
npm test
npm run test:coverage
```

Покрытие считается по `src/**/*.ts`, кроме `src/server.ts`: этот файл только запускает процесс.

## Принятые решения

- **Node 22.9+.** Флаг `--env-file-if-exists` не требует отдельного пакета для `.env`. Версия зафиксирована в `engines` и `.nvmrc`. Типы `@types/node` стоят на ветке 22, чтобы компилятор не разрешал API новее рантайма.
- **Один TypeScript 6.** `tsc` и ts-jest используют один и тот же пакет `typescript`. Нативный TypeScript 7 не подходит: у него нет стабильного compiler API, который ждёт ts-jest.
- **CommonJS и `moduleResolution: nodenext`.** Относительные импорты в исходниках заканчиваются на `.js`. Jest сопоставляет такой суффикс с `.ts` через `moduleNameMapper`.
- **Express 5.** Приложение собирается в `createApp` и само не слушает порт. Слушает только `src/server.ts`. Ошибка `listen`, например занятый порт, завершает процесс с кодом 1. Иначе Docker с `restart: on-failure` решит, что сервис поднялся.
- **Остановка по таймауту.** SIGINT и SIGTERM закрывают сервер, затем простаивающие keep-alive соединения. Если за `SHUTDOWN_TIMEOUT_MS` соединения ещё живы, процесс рвёт их и выходит с кодом 1. `uncaughtException` и `unhandledRejection` идут в ту же остановку.
- **Свои валидаторы и логгер.** Отдельные библиотеки для конфига и логов не подключались. Лог — одна JSON-строка. Логгер не бросает исключения: циклы, `bigint`, глубина и `toJSON` обрабатываются внутри. Поля с `apikey`, `secret`, `token`, `password` или `authorization` в имени заменяются на `[REDACTED]`.
- **Один формат ошибок.** Тело ответа: `{ "error": { "code", "message", "requestId" } }`. Детали валидации добавляются только когда они есть. Внутренний текст и stack клиенту не отдаются. `errorHandler` подробно логирует только 5xx. Каждый запрос один раз пишет `requestLogger`, для 4xx туда же попадает `errorCode`.
- **`X-Request-Id`.** Клиентский заголовок принимается, если это 1–128 символов из латиницы, цифр, точки, `_` и `-`. Иначе сервер ставит UUID. Идентификатор возвращается в ответе и в логе.
- **Версия из `package.json`.** `server.ts` читает файл через `fs` и передаёт версию в `createApp`. Импорт JSON из `src` сломал бы сборку из-за `rootDir`. В тестах версию можно подменить.
