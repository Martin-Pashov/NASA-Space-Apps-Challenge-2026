hi

# FieldShift: see what your field can't show you

NASA Space Apps Challenge 2026 · Challenge: **Field Shift: Adapting Farms with NASA Data**

A farmer can see his crops. He can't see how many days his soil stayed bare, whether his field is drier than in earlier years, how often his crops would have failed over 25 years of weather, or how that changes as the climate warms. FieldShift reads that from NASA and ESA satellites for his exact field and turns it into a simple, explained choice between rotation strategies.

## How it works

1. **Pick your field**: search a village or address, or click on the satellite map.
2. **Pick your goal**: "recommend what to plant" or "can I grow X here?", your priorities (save moisture, stop erosion, more income, healthier soil, fewer bad years) and what you grow now.
3. **The server fetches live data for that point** (nothing is pre-downloaded, so it's always current):

| Data | Source | Used for |
|---|---|---|
| 25 years monthly temperature + rain | NASA POWER | Stress test, trends, drought frequency |
| Last 12 months daily weather | NASA POWER | Recent rain vs normal |
| NDVI, SAVI, moisture index (NDMI), Bare Soil Index every 10 days, 5 years | ESA Sentinel-2 via Copernicus Sentinel Hub | Bare days, moisture change, crop vigor |
| Texture, organic carbon, pH | ISRIC SoilGrids | Soil water storage, soil health |
| Elevation and slope | NASA SRTM (via OpenTopoData) | Erosion risk |
| Address search | OpenStreetMap Nominatim | Finding the field |

4. **The results page shows:**
   - **What the satellites see that you can't**: plain-language insight cards (e.g. "your field was bare ~190 days last year", "moisture index 25% below earlier years", "rain 31% below normal in the last 3 months").
   - **Charts**: field greenness and moisture over time, rain vs normal, warming trend, crop survival now vs 2035.
   - **Crop check** ("can I grow corn here?") or **most reliable crops** for the field.
   - **At least 3 strategies compared** (your current rotation, moisture-saving with cover crops, nitrogen-fixing with legumes, best match), each with numbers, why it was suggested, evidence, benefits, risks to check locally and information gaps.
   - Sliders to fine-tune priorities; the ranking updates instantly.

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
server.js              Express server: /api/analyze (all data for a point), /api/geocode, /api/reverse
lib/sources.js         NASA POWER, Sentinel Hub, SoilGrids, SRTM elevation, Nominatim
public/index.html      Start page (map + goal) and results page
public/app.js          UI: map, search, charts, strategy cards
public/analysis.js     Insights, stress test, scoring, strategy explanations
public/data/crops.json      Crop traits (water need, heat limit, season, legume, yield, price, cost, notes)
public/data/rotations.json  Rotation library (traditional, moisture-saving, nitrogen-fixing, drought, diversified)
data/cache/            Automatic backup of the last successful response per location
```

The browser never calls the data APIs directly, so the Copernicus secret stays on the server. Each successful API response is also kept as a backup and only used if the live call fails (e.g. bad Wi-Fi during the demo).

## Method

- **Stress test:** every crop is checked against every past season: enough water (season rain + soil water ≥ 75% of crop need) and no heat stress in its critical months.
- **2035 outlook:** past weather shifted along the measured temperature and rain trend. A projection, not a forecast.
- **Scores (0–100):** moisture (rain vs crop needs), erosion (months of bare soil between crops), income (typical profit using each year's real outcome), soil health (legumes, cover crops, diversity), reliability (share of seasons that passed). Weighted by the farmer's priorities.
- **Satellite indices:** clouds and shadows removed with the Sentinel-2 scene classification (SCL). Bare = BSI > 0 and NDVI < 0.2.

## Limitations

- Crop values are regional estimates for Northeast Bulgaria (Dobrudzha) and should be checked against FAO GAEZ and local data.
- Rain-fed farming assumed; monthly climate for the stress test.
- Satellites average a ~500 m box around the chosen point.
- FieldShift supports decisions; it doesn't replace the farmer's experience or a local agronomist.

## Use of AI

This project was built with help from Claude (Anthropic) for code generation and planning. The team designed the concept, chose the data sources and the farmer-facing logic, and tested and adapted the code.
