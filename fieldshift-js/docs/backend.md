# FieldShift backend

Node 18+, ESM, Express 4, no build step, no extra npm dependencies. `npm start` runs the server, `npm test` runs `node:test` suites in `test/` (all network calls are mocked).

## Data loading (`lib/cache.js`, `lib/data.js`)
Cache-first: memory (300 entries) -> `data/cache/<name>.json` -> network.
Disk format `{ savedAt, data }`; old files holding raw data are still read (file time = savedAt).

| Source | Cache name | Fresh for | Served stale up to |
|---|---|---|---|
| NASA POWER climate | `climate_<lat>_<lon>` | 30 d | 365 d |
| NASA POWER recent | `recent_<lat>_<lon>` | 12 h | 7 d |
| Sentinel-2 | `sentinel_<geometryKey>` | 2 d | 30 d |
| Sentinel-1 radar | `radar_<geometryKey>` | 2 d | 30 d |
| SoilGrids / SRTM | `soil_*`, `terrain_*` | 365 d | 5 y |
| Open-Meteo forecast | `forecast_<lat>_<lon>` | 3 h | 24 h |
| GBIF plant lookup | `plant_<q>` | 365 d | 5 y |
| Reverse geocode | `reverse_<lat2>_<lon2>` | 30 d | 365 d |

Stale copies are returned at once and refreshed in the background. Concurrent requests share one call.
Failed or invalid fetches fall back to any older copy (`backup: true`). Invalid data (`lib/validate.js`) is never stored.
`/api/parcel` and `/api/geocode` stay live.

## `/api/analyze` (NDJSON stream)
Step: `{type:'step', id, status, ms, backup, error, cached, stale, ageMin}` for ids
`climate, recent, sentinel, soil, terrain, forecast, radar` (radar is optional).
Result `data`: `{ lat, lon, areaHa, geometry, climate, recent, soil, terrain, sentinel, forecast, radar, checks }`.
Each source is `{ ok, data, cached, stale, ageMs, backup, error, issues }`; `checks.<source>` is `{ ok, issues[] }` or `null` if the source failed.
Sentinel rows may carry `ndviStd` (spread of NDVI inside the field).

## Alerts (`public/alerts.js`, shared with the browser)
`buildAlerts({ forecast, sentinel, crops, pests, recent, now })` -> sorted alerts. Levels and channels: urgent = call+SMS+app,
warning = SMS+app, advice/info = app. `smsText()` always fits one GSM-7 SMS (Cyrillic is transliterated).

## Monitoring and notifications (`lib/monitor.js`, `lib/notify.js`)
- `POST /api/monitor {name, geometry, phone, crops, minLevel}` -> `{id, phoneMasked}`; `GET /api/monitor`; `DELETE /api/monitor/:id`
- `POST /api/monitor/:id/check` -> `{alerts, deliveries, sources}` (sends via Twilio, de-duplicated by alert id)
- `POST /api/alerts/preview {alerts, fieldName}` -> `{sms, calls}` (texts only, sends nothing)
- All fields are re-checked every 6 h. Without Twilio env vars messages go to `data/outbox.json` (dry run).
- Phones: E.164, or Bulgarian local `0888123456` -> `+359888123456`.

## Plant check
`GET /api/plant?q=` -> `{found:true, scientificName, family, vernacularName, source:'GBIF'}` | `{found:false}` | `{error, offline:true}` (always HTTP 200).
