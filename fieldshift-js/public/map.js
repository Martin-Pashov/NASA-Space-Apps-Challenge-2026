// Map: Bulgaria overview, province layer, and an editable field shape.
import { areaHa, centroid, squareAround, contains } from './geo.js';

const BULGARIA = { center: [42.75, 25.35], zoom: 7 };
const FIELD_STYLE = { color: '#1d9e75', weight: 3, fillColor: '#1d9e75', fillOpacity: 0.18 };
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
      layer.on('mouseover', () => layer.setStyle({ fillOpacity: 0.15, weight: 2.5 }));
      layer.on('mouseout', () => provinces.resetStyle(layer));
      layer.on('click', e => {
        if (map.pm.globalDrawModeEnabled()) return;
        if (map.getZoom() < 10) map.fitBounds(layer.getBounds()); // zoom to the province
        else handleClick(e.latlng);                                // zoomed in: select a field
      });
    },
  });
  try {
    provinces.addData(await (await fetch('data/bg-oblasti.json')).json());
    provinces.addTo(map);
  } catch { /* the layer is optional */ }
  L.control.layers({ Satellite: satellite, Map: streets }, { 'Provinces (oblasti)': provinces }, { collapsed: false }).addTo(map);

  // Drawing tools (Leaflet-Geoman)
  map.pm.addControls({
    position: 'topleft', drawMarker: false, drawCircleMarker: false, drawPolyline: false, drawCircle: false,
    drawText: false, cutPolygon: false, rotateMode: false, drawRectangle: true, drawPolygon: true,
    editMode: false, dragMode: true, removalMode: true,
  });
  map.pm.setPathOptions(FIELD_STYLE);
  map.on('pm:create', e => setFieldLayer(e.layer, 'Drawn by you. Drag the corners to adjust.'));
  map.on('click', e => handleClick(e.latlng));
  map.on('zoomend', () => { if (!fieldLayer) hint(map.getZoom() < 12 ? 'Zoom in and click on your field' : 'Click on your field to select it'); });
  hint('Zoom in and click on your field');
}

function handleClick(latlng) {
  if (map.pm.globalDrawModeEnabled() || map.pm.globalRemovalModeEnabled() || map.pm.globalDragModeEnabled()) return;
  if (fieldLayer && contains(fieldLayer.toGeoJSON().geometry, latlng.lat, latlng.lng)) return;
  if (map.getZoom() < 12) { map.setView(latlng, 15); hint('Now click on your field'); return; }
  selectAt(latlng.lat, latlng.lng);
}

// Click on the map: draw a default square right away, then try to find the real field outline.
async function selectAt(lat, lon) {
  const id = ++requestId;
  setFieldLayer(toLayer(squareAround(lat, lon, 300)), 'Looking for your field outline…');
  try {
    const r = await (await fetch(`/api/parcel?lat=${lat}&lon=${lon}`)).json();
    if (id !== requestId) return; // the user clicked somewhere else meanwhile
    if (r.found) setFieldLayer(toLayer(r.geometry), `Outline found on OpenStreetMap (${r.landuse}). Drag the corners if it isn't quite right.`);
    else setFieldLayer(fieldLayer, `${r.reason} We drew a 300 × 300 m square. Drag the corners to fit your field.`);
  } catch {
    if (id === requestId) setFieldLayer(fieldLayer, 'We drew a 300 × 300 m square. Drag the corners to fit your field.');
  }
}

const toLayer = geometry => L.polygon(geometry.coordinates[0].slice(0, -1).map(([x, y]) => [y, x]), FIELD_STYLE);

function setFieldLayer(layer, note) {
  if (fieldLayer && fieldLayer !== layer) fieldLayer.remove();
  fieldLayer = layer;
  if (!map.hasLayer(layer)) layer.addTo(map);
  layer.setStyle?.(FIELD_STYLE);
  layer.pm.enable({ allowSelfIntersection: false });
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
