# KinoPub API — изучение и контракт KPTV

Изучено по официальной документации `https://kinoapi.com` (Sphinx, разделы
authentication, api_video, api_watching, api_bookmarks, api_tv,
api_collections, api_history, api_device, api_references, user) и сверено
с проверенным временем кодом kp-msx. Где документация и поведение kp-msx
расходятся — помечено; код поддерживает оба варианта.

## Upstream: `https://api.service-kp.com/v1`

### OAuth 2.0 Device Code Flow

- `device_code` и `device_token` — `POST https://api.service-kp.com/oauth2/device`
  с query-параметрами (`client_id`, `client_secret`, `code` для device_token).
- `refresh_token` — `POST https://api.service-kp.com/oauth2/token` (отдельный
  URL!). Ответ — новая пара токенов; любая `error` = пара мертва, токены
  очищаем и возвращаем устройство к экрану активации.
- Polling `device_token`: `error: authorization_pending` — нормальное
  состояние ожидания; любая другая ошибка (`invalid_code`, `expired_token`)
  финальна — запускаем флоу заново.

| grant_type | URL | параметры | ответ |
|---|---|---|---|
| `device_code` | `/oauth2/device` | — | `user_code` (5 симв.), `code` (device code), `verification_uri`, `expires_in`, `interval` (сек, дефолт 5) |
| `device_token` | `/oauth2/device` | `code` | токены или `{"error": ...}` |
| `refresh_token` | `/oauth2/token` | `refresh_token` | новая пара токенов |

Токены: `Authorization: Bearer <access_token>`. Токены протухают; рефреш —
прозрачно на 401 (per-device lock). Refresh-пара может умереть серверной
стороной (unlink/ротация/истёк 30-дневный refresh) — тогда единственный
выход очистить токены и вернуть устройство к экрану активации.

### Ресурсы (все GET, если не указано иное)

| Эндпоинт | Назначение | Особенности |
|---|---|---|
| `/items` | каталог | пагинация `page`; фильтры `type,genre,country,sort` |
| `/items/fresh`, `/items/popular` | новинки/популярное | **требуют `type`** (movie/serial) |
| `/items/hot` | «горячее» | найдено в Kino Watch |
| `/items/search?q=` | поиск | `q`, `page` |
| `/items/{id}` | карточка | `?nolinks=1` — без ссылок (быстрее); сезоны/файлы/постеры |
| `/items/similar?id=` | похожие | |
| `/items/media-links` | ссылки на стримы | использует Kino Watch вместо парсинга `files[]` |
| `/types`, `/genres?type=`, `/countries` | фильтры-справочники | по докам — голые массивы; kp-msx читал `items` — поддерживаем оба формата |
| `/watching/movies`, `/watching/serials?subscribed=` | «смотрю» | **shallow** (нет года/рейтинга/сюжета); у serials есть `new` — счётчик новых серий (в полных `/items/{id}` доками не гарантирован, kp-msx его там читал) |
| `/watching/marktime` GET | прогресс | `id,time[,season,video]` |
| `/watching/toggle` GET | просмотрено | `id[,season,video]` |
| `/watching/togglewatchlist` GET | подписка «смотрю» | `id` |
| `/watching/clearhistory` POST | очистить историю | недокументирован (взят из kp-msx); официальная альтернатива — `/history/clear-for-item?id=` |
| `/history?page=` | история | только **завершённые** просмотры; начатое живёт в `/watching/*` |
| `/bookmarks` | папки закладок | |
| `/bookmarks/{id}?page=` | содержимое папки | |
| `/bookmarks/create` POST | новая папка | `{title}` |
| `/bookmarks/toggle-item` POST | в закладки/из | `{item, folder}` |
| `/bookmarks/get-item-folders?item=` | папки тайтла | |
| `/collections?page=` | подборки | |
| `/collections/view?id=` | содержимое подборки | |
| `/tv` | каналы | `channels[]`: `id,title,name,logo,stream` |
| `/user` | аккаунт | |
| `/device/info`, `/device/notify` POST, `/device/{id}/settings` POST | устройство | sync настроек на сервер KP |

### Квирки апстрима (важно)

- **Пагинация клампится**: запрос странцы за пределами возвращает последнюю
  страницу, а не пустоту — `has_more` считать по `pagination.current/total`.
- **Стримы**: `files[]` у видео, у каждого `url{hls4,hls2,hls,http}` и
  `quality`. Приоритет протоколов: `hls4 > hls2 > hls > http` (адаптивный HLS
  важнее прогрессивного mp4). Постеры: несколько размеров + wide-варианты.
- **Субтитры**: отдельные SRT-файлы (у Kino Watch есть `/subtitles` отдельно)
  + встроенные в m3u8; плеер принимает только WebVTT — конвертируем.
- **CDN-ссылки протухают** — проксировать и не кешировать агрессивно.
- **4K/HDR/HEVC** — флаги на устройстве KP (`support4k` и т.д.), влияют на
  выдачу ссылок.

## KPTV API: ` /api/v1/*`

Авторизация: устройство идентифицируется заголовком `X-Device-Id` (или
`?id=` — совместимость с MSX; литерал `{ID}` не принимается). Без идентификатора
→ 400 `no_device`. Неактивированное устройство → 401 `not_registered`.
Формат ошибок единый: `{"error": {"code", "message"}}`.

### auth
- `POST /auth/code` → `{user_code}` (409 `already_registered`)
- `GET /auth/poll` → `{status: pending|active}`
- `GET /auth/qr.svg?code=` → SVG QR на `https://kino.pub/device?code=…`
  (без авторизации — кодирует только строку из запроса)

### browse
- `GET /home` → `{rails: [{id,title,items:[card]}]}` — continue/fresh/popular/
  collections/watching (enrich `/watching/*` полными карточками)
- `GET /catalog?type&genre&country&sort&section(fresh|popular)&page`
  → `{items, page, has_more}`
- `GET /search?q&page` → `{items, page, has_more}`
- `GET /filters` → `{types, genres, countries}`
- `GET /items/{id}` → карточка + `plot, cast, voice, subscribed, bookmarks,
  bookmark_folders, seasons[], videos[], similar[]`
- `GET /collections`, `GET /collections/{id}` → `{items}`

### library
- `GET /bookmarks` → `{folders: [{id,title,count}]}`; `GET /bookmarks/{folder}?page` → `{items, page, has_more}`
- `POST /bookmarks/folders {title}`; `POST /bookmarks/toggle {item, folder}`
- `GET /history?page` → `{items, page, has_more}` (начатое + завершённое)
- `POST /history/clear`
- `POST /watching/toggle {id, season?, episode?}` — отметить просмотренным
- `POST /subscription/toggle {id}` — «смотрю»

### playback
- `GET /play/{id}?season&episode&hevc` → `{content_id,title,season,episode,
  duration,position,url,subtitles[],thumbnail, watched}`; стрим выбирается
  по приоритету протоколов, субтитры конвертируются в WebVTT, все URL — через
  allowlist-прокси. `hevc=0|1` — реальная поддержка HEVC у клиента: перед
  запросом к KP флаг `supportHevc` устройства выравнивается под неё (иначе
  KP отдаёт HEVC-only манифесты, которые браузер не сможет декодировать)
- `POST /progress {id,time,season?,episode?}` — доклад позиции

### settings · media
- `GET /settings` → `{settings, account}`; `POST /settings` — patch
  `{uhd,hdr,hevc,poster_size}` (синхронизируется на сервер KP)
- `GET /proxy?url=[&audio=NAME]` — allowlist-прокси медиа/HLS (плейлисты
  переписываются: сегменты тоже через прокси)
- `GET /subtitle?url=` — субтитры, SRT→WebVTT
