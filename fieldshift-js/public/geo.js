// Small geometry helpers, shared by the browser and the server.
// Geometries are GeoJSON Polygons: coordinates = [[ [lon, lat], ... ]].

const R = 6378137; // earth radius in metres
const rad = d => d * Math.PI / 180;

// Geodesic area of a polygon's outer ring, in hectares.
export function areaHa(geometry) {
  const ring = geometry.coordinates[0];
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i], [lon2, lat2] = ring[i + 1];
    sum += rad(lon2 - lon1) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
  }
  return Math.abs(sum * R * R / 2) / 10000;
}

// Simple centroid (average of the ring's vertices), good enough for small fields.
export function centroid(geometry) {
  const ring = geometry.coordinates[0].slice(0, -1);
  const lon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  return { lat, lon };
}

// Square polygon of `sizeM` metres around a point.
export function squareAround(lat, lon, sizeM = 300) {
  const dLat = sizeM / 2 / 111320, dLon = sizeM / 2 / (111320 * Math.cos(rad(lat)));
  return {
    type: 'Polygon',
    coordinates: [[[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat], [lon - dLon, lat - dLat]]],
  };
}

// Is a point inside a polygon's outer ring? (ray casting)
export function contains(geometry, lat, lon) {
  const ring = geometry.coordinates[0];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Short stable key for caching a field shape.
export function geometryKey(geometry) {
  const s = geometry.coordinates[0].map(([x, y]) => `${x.toFixed(5)},${y.toFixed(5)}`).join(';');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// ---------- Field outlines from OpenStreetMap (Overpass), used by the server AND the browser ----------
// The free Overpass servers are often busy, so callers try several mirrors.
export const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const MAX_PARCEL_HA = 150;

// farmland polygons that contain the point
export function overpassQuery(lat, lon) {
  const tags = '^(farmland|farmyard|orchard|vineyard|meadow|grass|plant_nursery)$';
  return `[out:json][timeout:25];is_in(${lat},${lon})->.a;(way(pivot.a)[landuse~"${tags}"];rel(pivot.a)[landuse~"${tags}"];);out geom;`;
}

export function parseOverpass(json) {
  const shapes = [];
  for (const el of json.elements ?? []) {
    let pts = null;
    if (el.type === 'way' && el.geometry) pts = el.geometry;
    if (el.type === 'relation') {
      const outers = (el.members ?? []).filter(m => m.role === 'outer' && m.geometry);
      if (outers.length === 1) pts = outers[0].geometry;
    }
    if (!pts || pts.length < 4) continue;
    const ring = pts.map(p => [p.lon, p.lat]);
    if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) ring.push(ring[0]);
    const geometry = { type: 'Polygon', coordinates: [ring] };
    shapes.push({ geometry, landuse: el.tags?.landuse, areaHa: areaHa(geometry) });
  }
  return shapes.sort((a, b) => a.areaHa - b.areaHa);
}

// the smallest outline is the field; a huge one is a whole farming area, not one field
export function pickParcel(shapes) {
  const best = shapes[0];
  if (!best) return { found: false, reason: 'No field outline on OpenStreetMap here.' };
  if (best.areaHa > MAX_PARCEL_HA) return { found: false, reason: `The OpenStreetMap outline here covers ${Math.round(best.areaHa)} ha (many fields at once).` };
  return { found: true, ...best };
}

// ---------- Backup: the main OpenStreetMap API (same servers as the address search) ----------
// Used when the Overpass servers can't be reached. Returns everything in a small box around the
// click; we keep closed farmland shapes that contain the point.
const LANDUSE = new Set(['farmland', 'farmyard', 'orchard', 'vineyard', 'meadow', 'grass', 'plant_nursery']);

export function osmMapUrl(lat, lon, d = 0.008) {
  const dLon = d / Math.cos(rad(lat));
  return `https://api.openstreetmap.org/api/0.6/map.json?bbox=${(lon - dLon).toFixed(5)},${(lat - d).toFixed(5)},${(lon + dLon).toFixed(5)},${(lat + d).toFixed(5)}`;
}

export function parseOsmMap(json, lat, lon) {
  const nodes = new Map(), ways = new Map();
  for (const el of json.elements ?? []) {
    if (el.type === 'node') nodes.set(el.id, [el.lon, el.lat]);
    else if (el.type === 'way') ways.set(el.id, el);
  }
  const ringOf = way => {
    const ring = way?.nodes?.map(id => nodes.get(id));
    if (!ring || ring.length < 4 || ring.some(p => !p)) return null;
    return ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring : null; // must be closed
  };
  const candidates = [];
  for (const w of ways.values()) if (LANDUSE.has(w.tags?.landuse)) candidates.push({ ring: ringOf(w), landuse: w.tags.landuse });
  for (const el of json.elements ?? []) {
    if (el.type !== 'relation' || !LANDUSE.has(el.tags?.landuse)) continue;
    const outers = (el.members ?? []).filter(m => m.type === 'way' && m.role === 'outer');
    if (outers.length === 1) candidates.push({ ring: ringOf(ways.get(outers[0].ref)), landuse: el.tags.landuse });
  }
  return candidates
    .filter(c => c.ring)
    .map(c => ({ geometry: { type: 'Polygon', coordinates: [c.ring] }, landuse: c.landuse }))
    .filter(s => contains(s.geometry, lat, lon))
    .map(s => ({ ...s, areaHa: areaHa(s.geometry) }))
    .sort((a, b) => a.areaHa - b.areaHa);
}
