# FieldShift: see what your field can't show you

NASA Space Apps Challenge 2026 · Challenge: **Field Shift: Adapting Farms with NASA Data**

A farmer can see his crops. He can't see how many days his soil stayed bare, whether his field is drier than in earlier years, how often his crops would have failed over 25 years of weather, or how that changes as the climate warms. FieldShift reads that from NASA and ESA satellites for his exact field and turns it into a simple, explained choice between rotation strategies.

## How it works

1. **Pick your field**: the map opens on Bulgaria with the 28 provinces (oblasti) as a layer. Search a village, zoom in and click your field. FieldShift tries to find the real field outline on OpenStreetMap; if there is none, it draws a 300 × 300 m square. Drag the corners, or draw your own rectangle or polygon with the tools on the left. The area in hectares updates live. Your last 10 fields are remembered.
2. **Tell us about you**:
   - *I already farm this field*: enter up to 5 past seasons. Known crops (English or Bulgarian) are recognised; for any other crop you pick the closest group. Quick-fill buttons for common rotations.
   - *I'm starting out*: no history needed; you get a starter rotation and the basics explained.
   - *Recommend what to plant* or *Can I grow a specific crop?*
   - Priorities: save moisture, stop erosion, more income, healthier soil, fewer bad years, lower costs, less work, my machinery, easy to sell, animal feed, break pests and diseases, EU subsidies.
3. **Live analysis with a progress screen**: the server fetches every source for that exact field shape and reports each step as it happens (done, failed, or used saved copy):

| Data | Source | Used for |
|---|---|---|
| 25 years monthly temperature + rain | NASA POWER | Stress test, trends, drought frequency |
| Last 12 months daily weather | NASA POWER | Recent rain vs normal |
| NDVI, SAVI, moisture index (NDMI), Bare Soil Index every 10 days, 5 years, only inside the field outline | ESA Sentinel-2 via Copernicus Sentinel Hub | Bare days, moisture change, crop vigor |
| Texture, organic carbon, pH | ISRIC SoilGrids | Soil water storage, soil health |
| Elevation and slope | NASA SRTM (via OpenTopoData) | Erosion risk |
| Field outlines | OpenStreetMap (Overpass API) | Auto-detecting the field shape |
| Province borders | Natural Earth (public domain) | Map layer |
| Address search | OpenStreetMap Nominatim | Finding the village |

4. **Results** (answer first, details on demand):
   - **Answer card**: what to sow next season, when (sowing window), up to 3 reasons with numbers, the main risk, any trade-off, and how to fit a cover crop in.
   - **Satellites vs your memory**: autumn-sown crops are already green in March–April, spring crops are bare; FieldShift detects which kind grew each year and flags differences from the history you entered.
   - **Decares by default** (switch to hectares), and your own yields and prices to replace the regional estimates.
   - **What the satellites see that you can't**: plain-language insight cards (bare days, moisture vs earlier years, rain vs normal, drought frequency, warming, crop outlook for 2035, slope, soil).
   - **Charts**: field greenness and moisture over time, rain vs normal, warming trend, crop survival now vs 2035.
   - **Crop check** or **most reliable crops** for the field; a **basics** box for beginners.
   - **At least 3 strategies compared** (current or typical rotation, moisture-saving or drought-tolerant, nitrogen-fixing, best match), each with why, evidence, benefits, risks to check locally and information gaps, plus a concrete next-season step that avoids planting the same crop family twice.
   - Sliders to fine-tune all 12 priorities; the ranking updates instantly.

## Run it

Needs Node.js 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000

For Sentinel-2 data, copy `.env.example` to `.env`, add your Copernicus Data Space OAuth client (dataspace.copernicus.eu → User settings → OAuth clients) and restart. Without it, everything else still works.

## Project structure

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
data/cache/            Automatic backup of the last successful response per field
```

The browser never calls the data APIs directly, so the Copernicus secret stays on the server. Each successful API response is also kept as a backup and only used if the live call fails (e.g. bad Wi-Fi during the demo).

## Method

- **Stress test:** every crop is checked against every past season: enough rain at sowing for autumn crops (e.g. rapeseed needs ≥ 40 mm in Aug–Sep), enough water while growing (season rain + soil water ≥ 75% of crop need), no dry winter and spring (rain from October to the end of the crop's sensitive months ≥ 80% of this field's own median) and no heat stress in its sensitive months.
- **Validation:** back-tested against the Ministry of Agriculture report on 2019/2020 (Dobrich wheat 178 kg/dka, −68%; barley −40%; rapeseed −30%). NASA POWER monthly rain matched the General Toshevo station within a few mm in most months. The first version of the model counted 2020 as a good year (it assumed the soil was always full after winter and counted June rain at harvest); the winter/spring check fixes that. Use "Check past years: year by year" in the app to compare any year yourself.
- **2035 outlook:** past weather shifted along the measured temperature and rain trend. A projection, not a forecast.
- **Verdicts:** options are shown as *Better / About the same / Worse for you*. Better means clearly better on what you picked, or more money in bad years without being worse otherwise. Never better if it earns less and fails more often.
- **Scores (0–100, internal):** moisture (rain vs crop needs), erosion (months of bare soil between crops), income (typical profit using each year's real outcome), soil health (legumes, cover crops, diversity), reliability (share of seasons that passed). Weighted by the farmer's priorities.
- **Rotation effects:** a crop after itself yields ~15% less; perennials have an establishment year; hard-to-adopt crops count less unless you already grow them; monocultures are never recommended.
- **Satellite indices:** clouds and shadows removed with the Sentinel-2 scene classification (SCL). Bare = BSI > 0.05 and NDVI < 0.25 (calibrated on real Dobrudzha fields).

## Limitations

- Crop values are regional estimates for Northeast Bulgaria (Dobrudzha) and should be checked against FAO GAEZ and local data.
- Rain-fed farming assumed; monthly climate for the stress test.
- Satellites average a ~500 m box around the chosen point.
- FieldShift supports decisions; it doesn't replace the farmer's experience or a local agronomist.

## Use of AI

This project was built with help from Claude (Anthropic) for code generation and planning. The team designed the concept, chose the data sources and the farmer-facing logic, and tested and adapted the code.
