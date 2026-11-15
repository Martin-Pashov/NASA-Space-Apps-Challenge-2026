# FieldShift: see what your field can't show you

NASA Space Apps Challenge 2026 · Challenge: **Field Shift: Adapting Farms with NASA Data**

**Try it live: https://fieldshift-o2cu.onrender.com** (free hosting: the first visit after a quiet spell takes about a minute to wake up)

**Full walkthrough video (49 s):** https://www.youtube.com/watch?v=5BIDRKyOs-c

[![FieldShift walkthrough video](https://img.youtube.com/vi/5BIDRKyOs-c/hqdefault.jpg)](https://www.youtube.com/watch?v=5BIDRKyOs-c)

**Who we are:** a Bulgarian team at NASA Space Apps 2026 (Sofia).
**The problem:** NASA and ESA collect huge amounts of free data about every field, but almost none of it reaches the farmer in a usable form.
**What we do:** FieldShift turns that data into plain, explained decisions about the farmer's own field: what to sow, what it earns in normal and bad years, and what to watch out for (hail, frost, drought, pests), with alerts by SMS and automated call.

A farmer can see his crops. He can't see how many days his soil stayed bare, whether his field is drier than in earlier years, how often his crops would have failed over 25 years of weather, or how that changes as the climate warms. FieldShift reads that from NASA and ESA satellites for his exact field and turns it into a simple, explained choice between rotation strategies.

## How it works

1. **Pick your field**: the map opens on Bulgaria with the 28 provinces (oblasti) as a layer. Search a village, zoom in and click your field. FieldShift tries to find the real field outline on OpenStreetMap; if there is none, it draws a 300 × 300 m square. Drag the corners, or (most reliable) draw your own rectangle or polygon with the tools on the left. The area in hectares updates live. Your last 10 fields are remembered.
2. **Tell us about you**:
   - *I already farm this field*: enter up to 5 past seasons. Known crops (English or Bulgarian) are recognised; for any other crop you pick the closest group. Quick-fill buttons for common rotations.
   - *I'm starting out*: no history needed; you get a starter rotation and the basics explained.
   - *Recommend what to plant* or *Can I grow a specific crop?*
   - Priorities: the three main ones first (**💧 Water, 🌱 Soil, 🚜 Market & machinery**), plus more: stop erosion, more income, fewer bad years, lower costs, less work, animal feed, break pests and diseases, EU subsidies.
   - **Input validation as you type:** crop names are spell-checked in English and Bulgarian ("Sunflwer" → *Did you mean Sunflower?*), other names are understood ("maize" → Corn, "рапица" → Rapeseed), text that isn't a plant name is rejected ("1234"), and unknown crops are looked up in the GBIF world plant database to confirm they exist. A check list above the button must pass before the analysis starts.
3. **Live analysis with a progress screen**: the server fetches every source for that exact field shape and reports each step as it happens (done, failed, or used saved copy):

| Data | Source | Used for |
|---|---|---|
| 25 years monthly temperature + rain | NASA POWER | Stress test, trends, drought frequency |
| Last 12 months daily weather | NASA POWER | Recent rain vs normal |
| NDVI, SAVI, moisture index (NDMI), Bare Soil Index every 10 days, 5 years, only inside the field outline | ESA Sentinel-2 via Copernicus Sentinel Hub | Bare days, moisture change, crop vigor |
| Texture, organic carbon, pH | ISRIC SoilGrids | Soil water storage, soil health |
| Elevation and slope | NASA SRTM (via OpenTopoData) | Erosion risk |
| Field outlines | OpenStreetMap (Overpass API, main OSM API as backup) | Auto-detecting the field shape |
| Province borders | Natural Earth (public domain) | Map layer |
| Address search | OpenStreetMap Nominatim | Finding the village |
| 7-day weather forecast | Open-Meteo (ECMWF, DWD models), MET Norway as backup | Hail, frost, heavy rain, heat, drought and wind alerts; pest-weather risk; season risk model |
| Plant names | GBIF species database | Checking that an unknown crop name is a real plant |

4. **Results** in two views (switch at the top):
   - **👀 Simple**: only what matters: the suggestion, 5 traffic-light tiles (alerts, water, season risk, pests, soil), alerts, the 3 strategies in plain words, pests to watch, fertilizer, phone alerts and a "how to read this" guide.
   - **🔬 Detailed**: everything below, with the data source and scientific reason behind every number.
   - A clear note on every result page: **FieldShift helps, it does not replace the local agronomist.**

   Results:
   - **Answer card**: what to sow next season, when (sowing window), up to 3 reasons with numbers, the main risk, any trade-off, and how to fit a cover crop in.
   - **Satellites vs your memory**: autumn-sown crops are already green in March–April, spring crops are bare; FieldShift detects which kind grew each year and flags differences from the history you entered.
   - **Decares by default** (switch to hectares), and your own yields and prices to replace the regional estimates.
   - **What the satellites see that you can't**: plain-language insight cards (bare days, moisture vs earlier years, rain vs normal, drought frequency, warming, crop outlook for 2035, slope, soil).
   - **Charts**: field greenness and moisture over time, rain vs normal, warming trend, crop survival now vs 2035.
   - **Crop check** or **most reliable crops** for the field; a **basics** box for beginners.
   - **Exactly 3 strategies compared**: A = the current rotation (baseline), B and C = two new strategies. Each has 4 clear sections: **why we suggest it**, **the NASA & ESA data behind it** (NASA POWER good seasons and 2035 trend, Sentinel-2 bare soil, SoilGrids, SRTM slope, the prediction model), **benefits**, and **risks and gaps in the data**. Plus a concrete next-season step that avoids planting the same crop family twice.
   - **Alerts in 4 levels**: URGENT / СПЕШНО (automated call + SMS), WARNING / ПРЕДУПРЕЖДЕНИЕ (SMS), RECOMMENDATION / ПРЕПОРЪКА and INFO / ИНФОРМАЦИЯ (in the app). Weather (hail, heavy rain and flooding, frost, heat, drought, storm), satellite (a sudden drop in the field's greenness vs the same weeks in earlier years: patchy = possible pests or disease, uniform = possible nitrogen shortage, with moisture drop = drought) and pests (each crop's main pests checked against the forecast temperature and rain).
   - **Phone alerts**: enter a mobile number; the server checks the field every 6 hours and sends an automated call + SMS for urgent alerts and an SMS for warnings (Twilio; without Twilio keys it runs in demo mode and writes to `data/outbox.json`). SMS is used because it's delivered as soon as the phone has even a weak 2G signal, no internet needed.
   - **Season risk (machine learning)**: a 0–100 risk score and the chance of a good season for each crop, from analog-year k-nearest neighbours on NASA POWER data + the 7-day forecast, with a leave-one-out retrospective test shown next to it.
   - **Pests, diseases and fertilizer**: 92 pests, diseases and weeds for 24 crops (Bulgarian names, when to check, thresholds, what to do in IPM order), nutrient needs (N, P₂O₅, K₂O) adjusted for the crop before and the soil, and how nutrient shortages show from space.
   - **Data and result checks**: every source is validated (ranges, completeness) before use or caching, and the results are checked for consistency.
   - Sliders to fine-tune all 12 priorities; the ranking updates instantly.

## Run it

Needs Node.js 18 or newer. The app lives in the `fieldshift-js` folder.

```bash
cd fieldshift-js
npm install
npm start
```

Open http://localhost:3000

For Sentinel-2 data, copy `.env.example` to `.env`, add your Copernicus Data Space OAuth client (dataspace.copernicus.eu → User settings → OAuth clients) and restart. Without it, everything else still works.

## Project structure

Inside `fieldshift-js/`:

```
server.js              Express server: POST /api/analyze (streams progress), /api/parcel, /api/geocode, /api/reverse
lib/sources.js         NASA POWER, Sentinel Hub, SoilGrids, SRTM elevation, Overpass, Nominatim
public/index.html      Start page (map + questions), progress screen, results page
public/map.js          Map: provinces layer, field auto-detect, editable field (Leaflet-Geoman)
public/app.js          Questions, planting history, live progress, charts, strategy cards
public/analysis.js     Insights, stress test, scoring for 12 priorities, strategy explanations
public/geo.js          Field area, centroid and cache keys (shared by browser and server)
public/data/crops.json      24 crops with traits (water, heat, season, legume, yield, price, cost, labour, market, ...)
public/data/rotations.json  26 rotations (traditional, moisture-saving, drought, nitrogen-fixing, forage, diversified, ...)
public/data/bg-oblasti.json Bulgarian province borders
public/ml.js           Season-risk model (analog-year kNN) + leave-one-out retrospective
public/validate.js     Crop name spell check, pre-analysis checks, result checks
public/alerts.js       Alert engine (4 levels), SMS and call texts; shared by browser and server
public/data/pests.json Pests, diseases, weeds, nutrient needs and deficiency signs for 24 crops
lib/cache.js           Fast cache: memory + disk, stale-while-revalidate, de-duplicated requests
lib/validate.js        Data validation of every source before it's used or cached
lib/notify.js          SMS + automated voice call (Twilio), demo mode without keys
lib/monitor.js         Field monitoring: subscriptions, checks every 6 hours
data/cache/            Cached responses per field (re-used until they expire, so repeat analyses are fast)
```

The browser never calls the data APIs directly, so the Copernicus secret stays on the server. Responses are cached per source (climate 30 days, satellite 2 days, recent weather 12 h, forecast 3 h, soil and slope 1 year), so a field you've analysed before loads in a second; a stale copy is shown immediately and refreshed in the background, and an old copy is used if a service is down (e.g. bad Wi-Fi during the demo).

**If a service is slow or down**, the analysis keeps going: SoilGrids gets 20 seconds before typical soil values are used, the forecast falls back from Open-Meteo to MET Norway (Open-Meteo's free limit is per IP address, which shared cloud servers can hit), and any source falls back to its last saved copy.

Optional `.env` keys: `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` (Sentinel-2), `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` (real SMS and calls). Run the tests with `npm test`.

## Hosting

The live version runs on Render's free plan as a Node web service: root directory `fieldshift-js`, build `npm install`, start `npm start`, and the `.env` keys added as environment variables in Render (never committed). Every push to `main` redeploys. On the free plan the server sleeps after 15 minutes without visitors and its disk is wiped on restart, so the cache and phone-alert subscriptions start empty after a restart.

## Method

- **Stress test:** every crop is checked against every past season: enough rain at sowing for autumn crops (e.g. rapeseed needs ≥ 40 mm in Aug–Sep), enough water while growing (season rain + soil water ≥ 75% of crop need), no dry winter and spring (rain from October to the end of the crop's sensitive months ≥ 80% of this field's own median) and no heat stress in its sensitive months.
- **Validation:** back-tested against the Ministry of Agriculture report on 2019/2020 (Dobrich wheat 178 kg/dka, −68%; barley −40%; rapeseed −30%). NASA POWER monthly rain matched the General Toshevo station within a few mm in most months. The first version of the model counted 2020 as a good year (it assumed the soil was always full after winter and counted June rain at harvest); the winter/spring check fixes that. Use "Check past years: year by year" in the app to compare any year yourself.
- **2035 outlook:** past weather shifted along the measured temperature and rain trend. A projection, not a forecast.
- **Verdicts:** options are shown as *Better / About the same / Worse for you*. Better means clearly better on what you picked, or more money in bad years without being worse otherwise. Never better if it earns less and fails more often.
- **Scores (0–100, internal):** moisture (rain vs crop needs), erosion (months of bare soil between crops), income (typical profit using each year's real outcome), soil health (legumes, cover crops, diversity), reliability (share of seasons that passed). Weighted by the farmer's priorities.
- **Rotation effects:** a crop after itself yields ~15% less; perennials have an establishment year; hard-to-adopt crops count less unless you already grow them; monocultures are never recommended.
- **Season risk model:** for each of the 24 past seasons we compute what we can also measure today (rain before sowing in Aug–Sep, rain since October including this month's measured rain and the 7-day forecast, temperature). The 13 most similar past seasons vote on whether the crop's season ends well (label = the full-season stress test), closer seasons count more, mixed with the long-term average. Leave-one-out: in November it is right ~70% of the time vs ~67% for "assume an average year" (Brier skill ≈ +0.1); the skill grows through winter and spring. For the 2026/27 season on our demo field the most similar past season is 2020, the Dobrich drought year.
- **Satellite indices:** clouds and shadows removed with the Sentinel-2 scene classification (SCL). Bare = BSI > 0.05 and NDVI < 0.25 (calibrated on real Dobrudzha fields).

## Limitations

- Crop values are regional estimates for Northeast Bulgaria (Dobrudzha) and should be checked against FAO GAEZ and local data.
- Rain-fed farming assumed; monthly climate for the stress test.
- Sentinel-2 values are averaged over the field outline you draw; climate data comes from NASA POWER's ~50 km grid, so it describes the area, not single field corners.
- Pest thresholds and weather triggers are typical values for Bulgaria; always check with БАБХ-registered products and the label.
- FieldShift supports decisions; it doesn't replace the farmer's experience or a local agronomist.

## Use of AI

This project was built with help from Claude (Anthropic) for code generation and planning. The team designed the concept, chose the data sources and the farmer-facing logic, and tested and adapted the code.
