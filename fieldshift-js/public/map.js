// Map: Bulgaria overview, province layer, and an editable field shape.
import { areaHa, centroid, squareAround, contains, OVERPASS_MIRRORS, overpassQuery, parseOverpass, pickParcel, osmMapUrl, parseOsmMap } from './geo.js';

const FIELD_ZOOM = 11; // zoomed in this far you're looking at fields: no province labels
const BULGARIA = { center: [42.75, 25.35], zoom: 7 };
const FIELD_STYLE = { color: '#e0b12f', weight: 3, fillColor: '#e0b12f', fillOpacity: 0.16 }; // ripe-wheat gold stands out on satellite imagery
let map, fieldLayer = null, onChange = () => {}, requestId = 0;

const hint = text => { const el = document.getElementById('mapHint'); el.textContent = text; el.hidden = !text; };

export async function initMap(changeHandler) {
  onChange = changeHandler;
  map = L.map('map', { zoomControl: true }).setView(BULGARIA.center, BULGARIA.zoom);

  const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Imagery © Esri' });
  const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution: '© OpenStreetMap contributors' });
  satellite.addTo(map);

  // Provinces (oblasti)
  const provinces = L.geoJSON(null, {
    pmIgnore: true,
    bubblingMouseEvents: false,
    attribution: 'Province borders © Natural Earth',
    style: { color: '#ffffff', weight: 1.5, opacity: 0.9, fillColor: '#ffffff', fillOpacity: 0.03 },
    onEachFeature: (f, layer) => {
      layer.bindTooltip(`${f.properties.name_local || f.properties.name} <span style="opacity:.7">(${f.properties.name})</span>`, { sticky: true, className: 'province-label' });
      layer.on('tooltipopen', () => { if (map.getZoom() >= FIELD_ZOOM) layer.closeTooltip(); });
      layer.on('mouseover', () => { if (map.getZoom() < FIELD_ZOOM) layer.setStyle({ fillOpacity: 0.15, weight: 2.5 }); });
      layer.on('mouseout', () => provinces.resetStyle(layer));
      layer.on('click', e => {
        if (drawing()) return;
        // first click zooms to the province; once you're in it, clicks select fields
        if (map.getZoom() < map.getBoundsZoom(layer.getBounds()) - 0.5) map.fitBounds(layer.getBounds());
        else handleClick(e.latlng);
      });
    },
  });
  try {
    provinces.addData(await (await fetch('data/bg-oblasti.json')).json());
    provinces.addTo(map);
  } catch { /* the layer is optional */ }
  L.control.layers({ Satellite: satellite, Map: streets }, { 'Provinces (oblasti)': provinces }, { collapsed: false }).addTo(map);

  map.on('click', e => handleClick(e.latlng));
  map.on('zoomend', () => { if (!fieldLayer) hint(map.getZoom() < 12 ? 'Zoom in to your field' : 'Draw your field with ⬠ on the left, or click on it'); });
  hint('Zoom in to your field');

  // Drawing tools (Leaflet-Geoman). The map still works without them.
  if (!map.pm) { console.warn('Drawing tools not loaded: run "npm install" in the fieldshift-js folder.'); return; }
  map.pm.addControls({
    position: 'topleft', drawMarker: false, drawCircleMarker: false, drawPolyline: false, drawCircle: false,
    drawText: false, cutPolygon: false, rotateMode: false, drawRectangle: true, drawPolygon: true,
    editMode: false, dragMode: true, removalMode: true,
  });
  map.pm.setPathOptions(FIELD_STYLE);
  map.on('pm:create', e => setFieldLayer(e.layer, 'Drawn by you. Drag the corners to adjust.'));
}

const drawing = () => !!map.pm && (map.pm.globalDrawModeEnabled() || map.pm.globalRemovalModeEnabled() || map.pm.globalDragModeEnabled());

function handleClick(latlng) {
  if (drawing()) return;
  if (fieldLayer && contains(fieldLayer.toGeoJSON().geometry, latlng.lat, latlng.lng)) return;
  if (map.getZoom() < 12) { map.setView(latlng, 15); hint('Now click on your field'); return; }
  selectAt(latlng.lat, latlng.lng);
}

// Click on the map: draw a default square right away, then try to find the real field outline.
async function selectAt(lat, lon) {
  const id = ++requestId;
  setFieldLayer(toLayer(squareAround(lat, lon, 300)), 'Looking for your field outline…');
  try {
    let r = await (await fetch(`/api/parcel?lat=${lat}&lon=${lon}`)).json();
    if (id !== requestId) return; // the user clicked somewhere else meanwhile
    if (r.unavailable) r = (await parcelFromBrowser(lat, lon)) ?? r; // server couldn't reach OSM: try from the browser
    if (id !== requestId) return;
    if (r.found) setFieldLayer(toLayer(r.geometry), `Outline found on OpenStreetMap (${r.landuse}). Drag the corners if it isn't quite right.`);
    else setFieldLayer(fieldLayer, `${r.reason} We drew a 300 × 300 m square. Drag the corners to fit your field.`);
  } catch {
    if (id === requestId) setFieldLayer(fieldLayer, 'We drew a 300 × 300 m square. Drag the corners to fit your field.');
  }
}

// Some networks block the server's requests to OpenStreetMap but not the browser's.
async function parcelFromBrowser(lat, lon) {
  for (const url of OVERPASS_MIRRORS) {
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: overpassQuery(lat, lon) }), signal: AbortSignal.timeout(6000) });
      if (res.ok) return pickParcel(parseOverpass(await res.json()));
    } catch { /* try the next mirror */ }
  }
  try {
    const res = await fetch(osmMapUrl(lat, lon, 0.01), { signal: AbortSignal.timeout(15000) });
    if (res.ok) return pickParcel(parseOsmMap(await res.json(), lat, lon));
  } catch { /* give up: the user can drag the square */ }
  return null;
}

const toLayer = geometry => L.polygon(geometry.coordinates[0].slice(0, -1).map(([x, y]) => [y, x]), FIELD_STYLE);

function setFieldLayer(layer, note) {
  if (fieldLayer && fieldLayer !== layer) fieldLayer.remove();
  fieldLayer = layer;
  if (!map.hasLayer(layer)) layer.addTo(map);
  layer.setStyle?.(FIELD_STYLE);
  layer.pm?.enable({ allowSelfIntersection: false });
  layer.off('pm:change pm:edit pm:dragend pm:remove');
  layer.on('pm:change pm:edit pm:dragend', () => emit());
  layer.on('pm:remove', () => { fieldLayer = null; emit(); });
  hint('');
  emit(note);
}

function emit(note) {
  if (!fieldLayer) { onChange(null); hint('Click on your field to select it'); return; }
  const geometry = fieldLayer.toGeoJSON().geometry;
  onChange({ geometry, areaHa: areaHa(geometry), center: centroid(geometry), note });
}

export function showField(geometry, note) {
  setFieldLayer(toLayer(geometry), note);
  map.fitBounds(fieldLayer.getBounds(), { maxZoom: 16, padding: [40, 40] });
}

export function clearField() {
  requestId++;
  fieldLayer?.remove();
  fieldLayer = null;
  emit();
}

export const zoomTo = (lat, lon, zoom = 14) => { map.setView([lat, lon], zoom); hint('Now click on your field'); };
export const refresh = () => map.invalidateSize();
