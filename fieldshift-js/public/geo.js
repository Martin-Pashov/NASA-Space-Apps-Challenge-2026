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
