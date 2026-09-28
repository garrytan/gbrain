# gbrain: локальное развёртывание на llama.cpp (Postgres, три llama-server)

Инструкция для агента, который настраивает или проверяет локальную
установку gbrain. В ней все модели работают на своей машине через
`llama-server` из llama.cpp: чат, эмбеддинги и реранкер, по процессу на
каждый. Облачные провайдеры не нужны.

Значения, которые у каждой машины свои, записаны заглушками `<ВОТ_ТАК>`.
Их агент получает у пользователя в шаге 1 и подставляет во все команды
ниже. Пример значения, где он есть, дан только как образец формата.

## 0. Правила для агента

- **Ничего не меняй, пока не пройден шаг 1.** Не угадывай значения
  заглушек и не бери их из примеров. Если пользователь не ответил на
  вопрос, остановись и спроси ещё раз.
- **Сначала проверяй, потом меняй.** Прочитай текущее значение. Если оно
  уже правильное, не трогай. Перед записью покажи пользователю список
  изменений «было → станет» и дождись согласия (шаг 1, вопрос 12).
- **Не показывай секреты.** Пароль из строки подключения к базе и
  API-ключи не выводи в чат, в логи и в файлы, которые создаёшь сам.
  В выводе заменяй их на `***`.
- Не переустанавливай и не заменяй глобально установленный `gbrain`.
- Не создавай, не удаляй и не пересоздавай базы данных без отдельного
  согласия пользователя.
- Ключи из раздела 7 («Нельзя») не ставь никогда.
- После каждой записи прочитай значение обратно и сравни.

## 1. Спроси пользователя перед развёртыванием

Задай вопросы одним сообщением, списком. Для каждого вопроса дан пример
ответа. Ответы запиши для себя и используй вместо заглушек.

| № | Вопрос пользователю (дословно или близко) | Заглушка | Пример ответа |
|---|---|---|---|
| 1 | Какую базу настраиваем: основную или тестовую? Дай строку подключения к Postgres. | `<DB_URL>` | `postgresql://postgres:***@localhost:5432/gbrain` |
| 2 | Где лежит каталог настроек gbrain (`config.json`) для этой базы? | `<GBRAIN_HOME>` | `C:\Users\<имя>\.gbrain` или `$GBRAIN_HOME\.gbrain` |
| 3 | Каким `gbrain` пользоваться: установленным глобально или из клона репозитория? Если из клона — путь к нему. | `<GBRAIN_CMD>` | `gbrain` или `bun "<путь к клону>\src\cli.ts"` |
| 4 | На каком порту чат-сервер и какой у него `--alias`? | `<CHAT_PORT>`, `<CHAT_ALIAS>` | `8080`, `qwen3.6-35b` |
| 5 | На каком порту сервер эмбеддингов, какой `--alias` и сколько измерений у модели? | `<EMBED_PORT>`, `<EMBED_ALIAS>`, `<EMBED_DIMS>` | `8081`, `bge-m3`, `1024` |
| 6 | На каком порту реранкер и какой `--alias`? Реранкер вообще нужен? | `<RERANK_PORT>`, `<RERANK_ALIAS>` | `8082`, `bge-reranker-v2-m3` |
| 7 | Чат-модель «думает» перед ответом (семейства qwen3, deepseek-r1 и подобные)? | — | да |
| 8 | Какой режим поиска: `conservative` или `tokenmax`? | `<SEARCH_MODE>` | `conservative` |
| 9 | Заметки в мозге на русском? Если да — как вас записывать в фактах (имя в именительном падеже)? | `<OWNER_NAME>` | `Иван` |
| 10 | Где на диске папка мозга (markdown-файлы), для проверки `dream`? | `<BRAIN_DIR>` | `D:\brain` |
| 11 | Как запускаются серверы llama.cpp: есть скрипт или команды? Пути к `.gguf` и флаги GPU. | — | путь к `.ps1`/`.bat` |
| 12 | Можно ли мне править `config.json` и ставить ключи в базе после того, как я покажу список изменений? | — | да |

Если ответ на вопрос 6 — «реранкер не нужен», пропусти всё про
`llama-server-reranker` и поставь `search.reranker.enabled false`.

Если ответ на вопрос 7 — «нет», ключ `agent.max_output_tokens` из
раздела 5 можно не ставить.

## 2. Что с чем связано

| Порт | Модель | Режим запуска | Provider id в gbrain |
|---|---|---|---|
| `<CHAT_PORT>` | `<CHAT_ALIAS>` | чат, `--jinja` | `ollama` и `litellm` (оба смотрят на этот порт) |
| `<EMBED_PORT>` | `<EMBED_ALIAS>` (`<EMBED_DIMS>` измерений) | `--embeddings` | `llama-server` |
| `<RERANK_PORT>` | `<RERANK_ALIAS>` | `--reranking` | `llama-server-reranker` |

Названия провайдеров не совпадают с назначением портов. Ни Ollama, ни
LiteLLM здесь не запущены: `ollama` и `litellm` — просто имена, через
которые gbrain ходит на чат-сервер llama.cpp. От имени зависит, что
gbrain считает умеющим этот сервер:

| Имя | Инструменты (агент) | Цена известна gbrain | Запас токенов на «размышления» qwen3 |
|---|---|---|---|
| `ollama` | нет | да ($0) | да |
| `litellm` | да | нет | нет |

- `ollama:<CHAT_ALIAS>` — для обычного чата, расширения запросов и
  извлечения фактов. Рецепт `ollama` объявляет структурированный вывод
  (JSON-схема) и запас токенов под «размышления». Для агента с
  инструментами не годится: поддержку инструментов рецепт не объявляет, и
  gbrain откажется запускать на нём агента.
- `litellm:<CHAT_ALIAS>` — для агентных фаз (`dream patterns`,
  `dream synthesize`). Рецепт `litellm` объявляет поддержку инструментов.
  Цену `litellm` gbrain не знает (обычно это прокси перед платным
  провайдером). Где это безопасно — раздел 7.

Имя `llama-server` для чата не используй: оно занято сервером
эмбеддингов, а у одного имени провайдера может быть только один адрес.

## 3. Серверы llama.cpp

### Проверка

```bash
curl -s http://127.0.0.1:<CHAT_PORT>/v1/models     # id должен быть <CHAT_ALIAS>
curl -s http://127.0.0.1:<EMBED_PORT>/v1/models    # <EMBED_ALIAS>
curl -s http://127.0.0.1:<RERANK_PORT>/v1/models   # <RERANK_ALIAS>
curl -s http://127.0.0.1:<CHAT_PORT>/props         # смотри n_ctx и chat_template
```

Какая модель на каком порту, определяй только по ответу `/v1/models` и
`/props`, а не по имени провайдера. Если ответ расходится с ответами на
вопросы 4–6, остановись и спроси пользователя.

### Обязательные флаги запуска

| Сервер | Флаги | Зачем |
|---|---|---|
| чат | `--alias <CHAT_ALIAS> --jinja --cache-prompt --port <CHAT_PORT>` | без `--jinja` модель не вызывает инструменты, и агент в `patterns` не работает |
| эмбеддинги | `--alias <EMBED_ALIAS> --embeddings --port <EMBED_PORT>` | |
| реранкер | `--alias <RERANK_ALIAS> --reranking --port <RERANK_PORT>` | `--reranking` и `--embeddings` в одном процессе несовместимы |

Путь к `.gguf` и флаги GPU (`-ngl` и т.п.) бери только из ответа на
вопрос 11.

Контекст чат-сервера (`n_ctx` в `/props`) должен вмещать системный промпт
агента, описания инструментов и несколько ходов с результатами. Меньше
32k для `patterns` рискованно. Если меньше, сообщи пользователю.

## 4. Файловый слой: `<GBRAIN_HOME>\config.json`

Этот слой читается первым и побеждает базу по каждому ключу. Модели
`embedding_model`, `expansion_model`, `chat_model` должны жить ТОЛЬКО здесь.

Нужные ключи (прочие, например `mcp`, `self_upgrade`, `memory`,
`protocol_installed_at`, не трогать):

```json
{
  "engine": "postgres",
  "database_url": "<DB_URL>",
  "schema_pack": "gbrain-everything",
  "embedding_model": "llama-server:<EMBED_ALIAS>",
  "embedding_dimensions": <EMBED_DIMS>,
  "expansion_model": "ollama:<CHAT_ALIAS>",
  "chat_model": "ollama:<CHAT_ALIAS>",
  "provider_base_urls": {
    "ollama": "http://127.0.0.1:<CHAT_PORT>/v1",
    "litellm": "http://127.0.0.1:<CHAT_PORT>/v1",
    "llama-server": "http://127.0.0.1:<EMBED_PORT>/v1",
    "llama-server-reranker": "http://127.0.0.1:<RERANK_PORT>/v1"
  }
}
```

Команды `gbrain config set` в этот файл не пишут, кроме `database_url`.
Правь JSON напрямую и сохрани остальные ключи.

Строку `provider_base_urls.litellm` легко пропустить. Без неё имя
`litellm` уходит на `http://localhost:4000` (порт LiteLLM по умолчанию),
где ничего не слушает.

Если в окружении задан `LITELLM_API_KEY`, gbrain отправит его как
Bearer-токен на чат-сервер. llama-server без `--api-key` его игнорирует,
так что это не мешает. Значение ключа никуда не копируй.

## 5. Слой базы: таблица `config` в Postgres

`gbrain init` эти ключи не создаёт. На чистой базе их нужно поставить
вручную. Все команды — через `<GBRAIN_CMD>`, подключённый к `<DB_URL>`.

Сначала прочитай текущие значения:

```bash
<GBRAIN_CMD> config get <ключ>    # для каждого ключа из списка ниже
```

Покажи пользователю, что будет изменено, и только после согласия пиши:

```bash
# Адреса серверов (дублируют файловый слой; файл главнее, база его дополняет)
<GBRAIN_CMD> config set provider_base_urls.ollama "http://127.0.0.1:<CHAT_PORT>/v1"
<GBRAIN_CMD> config set provider_base_urls.litellm "http://127.0.0.1:<CHAT_PORT>/v1"
<GBRAIN_CMD> config set provider_base_urls.llama-server "http://127.0.0.1:<EMBED_PORT>/v1"
<GBRAIN_CMD> config set provider_base_urls.llama-server-reranker "http://127.0.0.1:<RERANK_PORT>/v1"

# Тир reasoning: чат через имя ollama
<GBRAIN_CMD> config set models.tier.reasoning "ollama:<CHAT_ALIAS>"

# Агент с инструментами (dream patterns / synthesize)
<GBRAIN_CMD> config set agent.use_gateway_loop true
<GBRAIN_CMD> config set agent.max_output_tokens 32000        # только если ответ на вопрос 7 — «да»
<GBRAIN_CMD> config set models.dream.patterns "litellm:<CHAT_ALIAS>"
<GBRAIN_CMD> config set models.dream.synthesize "litellm:<CHAT_ALIAS>"

# Реранкер и поиск
<GBRAIN_CMD> config set search.reranker.enabled true
<GBRAIN_CMD> config set search.reranker.model "llama-server-reranker:<RERANK_ALIAS>"
<GBRAIN_CMD> config set search.mode <SEARCH_MODE>

# Извлечение фактов
<GBRAIN_CMD> config set facts.extraction_max_tokens 6000
<GBRAIN_CMD> config set facts.default_visibility world

# Dream / propose_takes
<GBRAIN_CMD> config set dream.propose_takes.max_tokens 3000
<GBRAIN_CMD> config set dream.propose_takes.retry_max_tokens 6000

# Прочее
<GBRAIN_CMD> config set conversation_parser.llm_fallback_enabled false
<GBRAIN_CMD> config set chunk_strategy semantic
```

Только если заметки на русском (вопрос 9). Подставь `<OWNER_NAME>` и
его падежные формы:

```bash
<GBRAIN_CMD> config set facts.extraction_prompt_appendix 'When emitting the "entity" field for a Russian-language fact, normalize personal names to the nominative case (именительный падеж) — write "<OWNER_NAME>", not its inflected forms (genitive, dative, instrumental, prepositional), even if the source text uses an inflected form. Same for any other Russian name or noun used as an entity.'
```

Если в базе уже есть своё `facts.extraction_prompt_appendix`, не
затирай его: покажи пользователю оба текста и спроси, какой оставить.

Зачем ключи для агента:

- `agent.use_gateway_loop true`: без него агент запускается только на
  моделях Anthropic. Задача упадёт с сообщением
  `non-Anthropic but agent.use_gateway_loop is not enabled`.
- `models.dream.patterns` / `models.dream.synthesize`: без них фаза берёт
  модель из тира reasoning (`ollama:…`). `patterns` на `ollama` сразу
  получает отказ `lacks native tool calling`. `synthesize` в обычном
  режиме (oneshot) инструменты не использует и работает и на `ollama`, но
  на `litellm` он тоже работает.
- `agent.max_output_tokens 32000`: «думающая» модель сначала рассуждает и
  тратит на это токены ответа. Для имени `ollama` gbrain сам даёт такой
  запас, для `litellm` — нет, там по умолчанию 8192 токена на ход. Если
  запаса не хватит, ход агента обрывается пустым ответом. Ключ действует
  на все задачи агента.

## 6. Проверка после настройки

Выполнять по порядку. Если шаг падает, остановись и сообщи.

```bash
# 1. Ключи базы на месте
<GBRAIN_CMD> config get agent.use_gateway_loop          # true
<GBRAIN_CMD> config get models.dream.patterns           # litellm:<CHAT_ALIAS>
<GBRAIN_CMD> config get provider_base_urls.litellm      # http://127.0.0.1:<CHAT_PORT>/v1

# 2. Таблица маршрутизации моделей
<GBRAIN_CMD> models

# 3. Пробный вызов каждой модели (около 1 токена на модель)
<GBRAIN_CMD> models doctor

# 4. Фаза patterns
<GBRAIN_CMD> dream --source default --dir "<BRAIN_DIR>" --phase patterns --json
```

Результат шага 4:

| Что видно | Что значит |
|---|---|
| фаза `ok`, созданы страницы паттернов | всё работает |
| `skipped: insufficient_evidence` | настройка верна, просто мало заметок-рефлексий (нужно 3 за 30 дней) |
| `lacks native tool calling` | `models.dream.patterns` не задан или указывает на `ollama:` |
| ошибка соединения с `localhost:4000` | нет `provider_base_urls.litellm` |
| `no_pricing` на модели `litellm:…` | `litellm` стоит на пути с лимитом стоимости (раздел 7) |
| `agent.use_gateway_loop is not enabled` | не стоит `agent.use_gateway_loop true` |
| ход агента пустой, причина `length` | не хватает `agent.max_output_tokens` или `n_ctx` сервера |
| ошибка соединения с `<CHAT_PORT>` | чат-сервер не запущен |

## 7. Нельзя

- **`models.dream.extract_atoms`** не ставить. Без него фаза сама берёт
  файловый `expansion_model`. Ключ, выставленный на провайдера без чата
  (например `lmstudio:…`), маскирует ошибку с портами другой ошибкой.
- **`expansion_model` и `chat_model` в базе** не дублировать. Путь выбора
  модели по умолчанию (`resolveTierDefault`) читает только файл.
  Устаревшая копия в базе молча расходится с файлом и путает.
- **`llama-server:<CHAT_ALIAS>`** нигде не использовать. Имя
  `llama-server` ведёт на сервер эмбеддингов.
- **`provider_base_urls.llama-server` не перенаправлять на чат-сервер.**
  Сломаются эмбеддинги.
- **`lmstudio:`** не использовать, если LM Studio не запущен. У его рецепта
  нет чата.
- **`litellm:` — только для агентных фаз** (`patterns`, `synthesize`).
  Обычный чат, расширение запросов, факты оставлять на `ollama:`.

### Цена `litellm` и лимиты стоимости

Когда у операции задан лимит стоимости, gbrain перед каждым вызовом
модели оценивает цену. Если цена модели неизвестна, вызов не делается, и
операция останавливается с `no_pricing`. Цены `litellm` gbrain не знает.

| Путь | Что будет на `litellm:` |
|---|---|
| `dream synthesize`, `dream patterns` | работает: у агента свой счётчик, на неизвестную цену он только предупреждает (`BUDGET_METER_NO_PRICING`) |
| `extract_atoms` | работает: на модели без цены фаза сама снимает лимит и пишет предупреждение |
| факты, `enrich`, эмбеддинги | с лимитом — `no_pricing`, если не задан `pricing.overrides` (см. ниже) |
| `brainstorm` | лимит всегда ($5), `pricing.overrides` не читает — `no_pricing`. Берёт `chat_model`, поэтому при настройке выше не затронут |
| `remediation` с `--max-usd`, `reindex-code` и `skillopt` с лимитом | `pricing.overrides` не читают — `no_pricing`, если модель `litellm:` |

Если `litellm:` понадобится на пути с лимитом, который читает
`pricing.overrides`, объяви цену 0:

```bash
<GBRAIN_CMD> config set pricing.overrides '{"litellm:<CHAT_ALIAS>": 0}'
```

При настройке из разделов 4–5 это не нужно.

## 8. Почему агентные фазы идут через `litellm` (задача #27)

История, чтобы не повторять уже сделанную работу.

- **Симптом.** `dream --phase patterns` падал с
  `PATTERNS_PHASE_FAIL: … data.model "ollama:…" lacks native tool calling`.
- **Причина.** `models.dream.patterns` не был задан, фаза взяла модель из
  тира reasoning (`ollama:…`). Рецепт `ollama` не объявляет поддержку
  инструментов, и gbrain отказался запускать агента. Сама модель
  инструменты умеет (сервер запущен с `--jinja`) — дело только в имени
  провайдера.
- **Решение.** Настройка из разделов 4 и 5. Код gbrain не менялся.
- **Отклонено.** Отдельный рецепт `llama-server-chat` (своё имя и адрес,
  поддержка инструментов, цена $0) был написан и отозван. При этой
  настройке он ничего не добавляет. Не предлагай его заново.
- Задача `rustam-python/gbrain#27` закрыта как «not planned»; в
  комментарии там та же настройка и разбор по лимитам стоимости.

## 9. Тестовая база рядом с основной

Если пользователь держит отдельный мозг для экспериментов (ответ на
вопрос 1 — «тестовую»):

- У тестового мозга своя база и свой каталог настроек: переменные
  `GBRAIN_DATABASE_URL` и `GBRAIN_HOME`. Спроси, есть ли готовый скрипт,
  который их выставляет, и пользуйся им.
- В `$GBRAIN_HOME\.gbrain\config.json` должен лежать СВОЙ файл: копия
  основного из раздела 4, но с `database_url` тестовой базы. Без него
  gbrain берёт встроенную модель эмбеддингов по умолчанию, и схема
  получается неправильной ширины.
- Для русскоязычных заметок полезна `GBRAIN_FTS_LANGUAGE=russian`.
- Ключи базы из раздела 5 нужны и здесь. Свои отличия тестовой базы
  (режим поиска, `facts.extraction_prompt_appendix`, настройки
  `dream.synthesize.*`) не выравнивай с основной без просьбы
  пользователя.
