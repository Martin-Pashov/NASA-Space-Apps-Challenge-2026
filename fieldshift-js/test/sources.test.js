import { offline, json, realFetch } from './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as src from '../lib/sources.js';
import { validateForecast, validateRadar } from '../lib/validate.js';
import { squareAround } from '../public/geo.js';

test.after(() => { globalThis.fetch = realFetch; });

test('getForecast parses Open-Meteo daily data', async () => {
  let seen;
  offline(u => {
    seen = new URL(u);
    return json({ daily: {
      time: ['2026-11-15', '2026-11-16', '2026-11-17'],
      temperature_2m_max: [12, 9.5, 8], temperature_2m_min: [3, 1, -1], temperature_2m_mean: [7, 5, null],
      precipitation_sum: [0, 4.2, 12], precipitation_probability_max: [5, 60, 90],
      weather_code: [3, 61, 95], wind_gusts_10m_max: [20, 35, 72], et0_fao_evapotranspiration: [0.8, 0.5, 0.4],
    } });
  });
  const f = await src.getForecast(43.673, 27.832);
  assert.equal(seen.host, 'api.open-meteo.com');
  assert.equal(seen.searchParams.get('forecast_days'), '7'); assert.equal(seen.searchParams.get('models'), 'ecmwf_ifs025,icon_seamless');
  assert.equal(seen.searchParams.get('timezone'), 'auto');
  assert.match(seen.searchParams.get('daily'), /weather_code.*wind_gusts_10m_max.*et0_fao_evapotranspiration/);
  assert.equal(f.source, 'ECMWF IFS + DWD ICON (via Open-Meteo)');
  assert.deepEqual(f.days[1], { date: '2026-11-16', tMax: 9.5, tMin: 1, tMean: 5, rainMm: 4.2, rainProb: 60, code: 61, gustKmh: 35, et0Mm: 0.5 });
  assert.equal(f.days[2].tMean, 3.5); // mean filled from max/min
  assert.equal(validateForecast(f).ok, true);
});

test('getForecast failures throw (the cache turns them into a failed step)', async () => {
  offline();
  await assert.rejects(src.getForecast(43, 27), /fetch failed/);
  offline(() => json({ error: true, reason: 'bad' }, 400));
  await assert.rejects(src.getForecast(43, 27), /Open-Meteo 400/);
});

function statsMock(outputsFor) {
  return (u, opts) => {
    if (u.includes('/token')) return json({ access_token: 'tok', expires_in: 600 });
    if (u.includes('/statistics')) {
      const body = JSON.parse(opts.body);
      return json({ data: outputsFor(body) });
    }
  };
}

test('getSentinel adds ndviStd from the stats object', async () => {
  process.env.CDSE_CLIENT_ID = 'id'; process.env.CDSE_CLIENT_SECRET = 'secret';
  const stat = (mean, stDev) => ({ bands: { B0: { stats: { mean, stDev, min: 0, max: 1 } } } });
  offline(statsMock(() => [
    { interval: { from: '2026-05-01T00:00:00Z' }, outputs: { ndvi: stat(0.6, 0.11), savi: stat(0.4), ndmi: stat(0.2), bsi: stat(-0.1) } },
    { interval: { from: '2026-05-11T00:00:00Z' }, outputs: { ndvi: stat(0.62), savi: stat(0.4), ndmi: stat(0.2), bsi: stat(-0.1) } },
    { interval: { from: '2026-05-21T00:00:00Z' }, outputs: {} },
  ]));
  const rows = await src.getSentinel(squareAround(43.673, 27.832, 300));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ndviStd, 0.11);
  assert.equal('ndviStd' in rows[1], false);
  assert.equal(rows[0].bare, 0);
});

test('getSentinel1 returns radar rows with RVI', async () => {
  process.env.CDSE_CLIENT_ID = 'id'; process.env.CDSE_CLIENT_SECRET = 'secret';
  let type;
  const stat = mean => ({ bands: { B0: { stats: { mean } } } });
  offline(statsMock(body => {
    type = body.input.data[0].type;
    return Array.from({ length: 12 }, (_, i) => ({ interval: { from: `2026-0${1 + (i % 9)}-01T00:00:00Z` }, outputs: { vv: stat(0.1), vh: stat(0.02 + i * 0.001) } }));
  }));
  const rows = await src.getSentinel1(squareAround(43.673, 27.832, 300));
  assert.equal(type, 'sentinel-1-grd');
  assert.equal(rows.length, 12);
  assert.ok(Math.abs(rows[0].rvi - 4 * 0.02 / 0.12) < 1e-9);
  assert.equal(validateRadar(rows).ok, true);
  delete process.env.CDSE_CLIENT_ID; delete process.env.CDSE_CLIENT_SECRET;
});

test('getForecast combines ECMWF and ICON: hail and gusts from the worse model', async () => {
  const daily = {
    time: ['2026-11-15', '2026-11-16'],
    temperature_2m_max_ecmwf_ifs025: [10, 12], temperature_2m_min_ecmwf_ifs025: [2, 3],
    temperature_2m_max_icon_seamless: [11, 13], temperature_2m_min_icon_seamless: [1, 2],
    precipitation_sum_ecmwf_ifs025: [0, 5], precipitation_sum_icon_seamless: [1, 9],
    weather_code_ecmwf_ifs025: [3, 95], weather_code_icon_seamless: [3, 96],
    wind_gusts_10m_max_ecmwf_ifs025: [30, 50], wind_gusts_10m_max_icon_seamless: [40, 82],
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ daily }), { status: 200 });
  const f = await src.getForecast(43.6, 27.8);
  assert.equal(f.days.length, 2);
  assert.equal(f.days[1].tMax, 12);          // temperature from ECMWF
  assert.equal(f.days[1].rainMm, 5);         // rain from ECMWF
  assert.equal(f.days[1].code, 96);          // hail seen by ICON is kept
  assert.equal(f.days[1].gustKmh, 82);       // worse gust
  assert.match(f.source, /ECMWF/);
});
