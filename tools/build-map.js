// Builds shared/map-geo.js — real-world territory shapes for the board — from Natural Earth data.
// Run with: npm run build:map   (only needed if you change territory definitions; output is committed)
const fs = require('fs');
const path = require('path');
const topo = require('world-atlas/countries-50m.json');
const { feature } = require('topojson-client');
const { presimplify, simplify, quantile, sphericalTriangleArea } = require('topojson-simplify');
const d3 = require('d3-geo');
const { geoMiller } = require('d3-geo-projection');
const pc = require('polygon-clipping');
const polylabel = require('polylabel');
const MAP = require('../shared/map');

// ---- country -> territory assignment ----
// A string assigns the whole country; an array of [territory, [lonMin, latMin, lonMax, latMax]] splits it by boxes.
const C = {
  // North America
  'Greenland': 'greenland',
  'Canada': [['nwt', [-141, 60, -79.5, 84]], ['alberta', [-141, 40, -102, 60]], ['ontario', [-102, 40, -79.5, 60]], ['quebec', [-79.5, 40, -50, 60]]],
  'United States of America': [['alaska', [-169, 50, -129, 75]], ['westernUS', [-125, 24, -100, 50]], ['easternUS', [-100, 24, -66, 50]]],
  'St. Pierre and Miquelon': 'quebec',
  ...Object.fromEntries(['Mexico', 'Guatemala', 'Belize', 'Honduras', 'El Salvador', 'Nicaragua', 'Costa Rica', 'Panama',
    'Cuba', 'Jamaica', 'Haiti', 'Dominican Rep.', 'Bahamas', 'Puerto Rico', 'Cayman Is.', 'Turks and Caicos Is.'].map((n) => [n, 'centralAm'])),
  // South America
  ...Object.fromEntries(['Venezuela', 'Colombia', 'Guyana', 'Suriname', 'Trinidad and Tobago'].map((n) => [n, 'venezuela'])),
  ...Object.fromEntries(['Peru', 'Ecuador', 'Bolivia'].map((n) => [n, 'peru'])),
  ...Object.fromEntries(['Brazil', 'Paraguay'].map((n) => [n, 'brazil'])),
  ...Object.fromEntries(['Argentina', 'Chile', 'Uruguay', 'Falkland Is.'].map((n) => [n, 'argentina'])),
  // Europe
  'Iceland': 'iceland',
  ...Object.fromEntries(['United Kingdom', 'Ireland', 'Isle of Man', 'Guernsey', 'Jersey'].map((n) => [n, 'greatBritain'])),
  ...Object.fromEntries(['Norway', 'Sweden', 'Finland', 'Denmark', 'Åland', 'Faeroe Is.'].map((n) => [n, 'scandinavia'])),
  ...Object.fromEntries(['Germany', 'Poland', 'Netherlands', 'Belgium', 'Luxembourg', 'Czechia', 'Liechtenstein'].map((n) => [n, 'northEurope'])),
  'France': [['westEurope', [-6, 41, 10, 52]], ['venezuela', [-55, 1, -51, 6.5]]],
  ...Object.fromEntries(['Spain', 'Portugal', 'Andorra', 'Monaco'].map((n) => [n, 'westEurope'])),
  ...Object.fromEntries(['Italy', 'Switzerland', 'Austria', 'Hungary', 'Slovakia', 'Slovenia', 'Croatia', 'Bosnia and Herz.', 'Serbia',
    'Montenegro', 'Kosovo', 'Albania', 'Macedonia', 'Greece', 'Bulgaria', 'Romania', 'Malta', 'San Marino', 'Vatican'].map((n) => [n, 'southEurope'])),
  ...Object.fromEntries(['Ukraine', 'Belarus', 'Moldova', 'Estonia', 'Latvia', 'Lithuania'].map((n) => [n, 'ukraine'])),
  'Russia': [
    ['ukraine', [19, 35, 60, 82]], ['ural', [60, 35, 75, 82]], ['siberia', [75, 35, 100, 82]],
    ['irkutsk', [100, 35, 130, 58]], ['yakutsk', [100, 58, 150, 82]],
    ['kamchatka', [130, 35, 150, 58]], ['kamchatka', [150, 35, 192, 82]],
  ],
  // Africa
  ...Object.fromEntries(['Morocco', 'W. Sahara', 'Algeria', 'Tunisia', 'Mauritania', 'Mali', 'Niger', 'Chad', 'Senegal', 'Gambia', 'Guinea',
    'Guinea-Bissau', 'Sierra Leone', 'Liberia', "Côte d'Ivoire", 'Burkina Faso', 'Ghana', 'Togo', 'Benin', 'Nigeria'].map((n) => [n, 'northAfrica'])),
  ...Object.fromEntries(['Egypt', 'Libya'].map((n) => [n, 'egypt'])),
  ...Object.fromEntries(['Sudan', 'S. Sudan', 'Ethiopia', 'Eritrea', 'Djibouti', 'Somalia', 'Somaliland', 'Kenya', 'Uganda', 'Tanzania',
    'Rwanda', 'Burundi'].map((n) => [n, 'eastAfrica'])),
  ...Object.fromEntries(['Dem. Rep. Congo', 'Congo', 'Gabon', 'Cameroon', 'Central African Rep.', 'Eq. Guinea', 'Angola'].map((n) => [n, 'congo'])),
  ...Object.fromEntries(['South Africa', 'Namibia', 'Botswana', 'Zimbabwe', 'Mozambique', 'Zambia', 'Malawi', 'Lesotho', 'eSwatini'].map((n) => [n, 'southAfrica'])),
  'Madagascar': 'madagascar',
  // Asia
  ...Object.fromEntries(['Turkey', 'Syria', 'Iraq', 'Iran', 'Saudi Arabia', 'Yemen', 'Oman', 'United Arab Emirates', 'Qatar', 'Bahrain', 'Kuwait',
    'Jordan', 'Israel', 'Palestine', 'Lebanon', 'Cyprus', 'N. Cyprus', 'Georgia', 'Armenia', 'Azerbaijan'].map((n) => [n, 'middleEast'])),
  ...Object.fromEntries(['Afghanistan', 'Turkmenistan', 'Uzbekistan', 'Tajikistan', 'Kyrgyzstan'].map((n) => [n, 'afghanistan'])),
  // northern Kazakhstan joins Ural so Ural really borders China (as the classic board connects them)
  'Kazakhstan': [['ural', [56, 47, 88, 56]], ['afghanistan', [46, 35, 56, 56]], ['afghanistan', [56, 35, 88, 47]]],
  ...Object.fromEntries(['India', 'Pakistan', 'Nepal', 'Bhutan', 'Bangladesh', 'Sri Lanka', 'Siachen Glacier'].map((n) => [n, 'india'])),
  // Manchuria and Korea join Mongolia so it reaches the coast facing Japan (as on the classic board)
  'China': [['china', [73, 15, 118.5, 54]], ['china', [118.5, 15, 136, 38.5]], ['mongolia', [118.5, 38.5, 136, 54]]],
  ...Object.fromEntries(['Taiwan', 'Hong Kong', 'Macao'].map((n) => [n, 'china'])),
  ...Object.fromEntries(['North Korea', 'South Korea'].map((n) => [n, 'mongolia'])),
  'Mongolia': 'mongolia',
  'Japan': 'japan',
  ...Object.fromEntries(['Myanmar', 'Thailand', 'Laos', 'Cambodia', 'Vietnam', 'Singapore'].map((n) => [n, 'siam'])),
  'Malaysia': [['siam', [99, 0, 105, 8]], ['indonesia', [108, 0, 120, 8]]], // Malaysian Borneo joins the rest of Borneo
  // Australia / Oceania
  'Indonesia': [['indonesia', [94, -12, 132, 7]], ['newGuinea', [132, -12, 142, 2]]],
  ...Object.fromEntries(['Philippines', 'Brunei', 'Timor-Leste'].map((n) => [n, 'indonesia'])),
  ...Object.fromEntries(['Papua New Guinea', 'Solomon Is.'].map((n) => [n, 'newGuinea'])),
  'Australia': [['westAustralia', [110, -45, 135, -9]], ['eastAustralia', [135, -45, 155, -9]]],
  'New Zealand': [['eastAustralia', [165, -48, 179, -34]]],
};
// Whole-country assignments are clipped to their continent's box to drop far-flung overseas islands.
const CONTINENT_BOX = { NA: [-169, 7, -10, 84], SA: [-82, -56, -30, 13], EU: [-25, 34, 62, 82], AF: [-18, -36, 55, 38], AS: [25, -12, 180, 82], AU: [94, -48, 180, 8] };

// Cut boxes are densified (a point every 0.5°) so a straight cut, e.g. along 58°N, is drawn as the same
// line on both sides; otherwise long edges are drawn as great-circle arcs that bulge differently and leave slivers.
function box([x0, y0, x1, y1]) {
  const pts = [], step = 0.5;
  const seg = (ax, ay, bx, by) => { const n = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) / step)); for (let i = 0; i < n; i++) pts.push([ax + (bx - ax) * i / n, ay + (by - ay) * i / n]); };
  seg(x0, y0, x1, y0); seg(x1, y0, x1, y1); seg(x1, y1, x0, y1); seg(x0, y1, x0, y0);
  pts.push([x0, y0]);
  return [pts];
}
const toMulti = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);
// Drop stray islands: keep the main landmass, big islands, and small islands only when they hug the coast.
const ISLAND_BIG = 0.12, ISLAND_MIN = 0.01, ISLAND_NEAR_DEG = 1.2;
function minDistDeg(a, b) {
  let best = Infinity;
  const step = Math.max(1, Math.floor((a.length * b.length) / 400000));
  for (let i = 0; i < a.length; i += step) {
    const k = Math.cos((a[i][1] * Math.PI) / 180);
    for (let j = 0; j < b.length; j++) {
      const d = ((a[i][0] - b[j][0]) * k) ** 2 + (a[i][1] - b[j][1]) ** 2;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}
function pruneIslands(polys) {
  const sorted = polys.slice().sort((x, y) => ringArea(y[0]) - ringArea(x[0]));
  const big = ringArea(sorted[0][0]);
  const kept = [sorted[0]];
  for (const p of sorted.slice(1)) {
    const a = ringArea(p[0]);
    if (a >= ISLAND_BIG * big) kept.push(p);
    else if (a >= ISLAND_MIN * big && kept.some((k) => minDistDeg(k[0], p[0]) <= ISLAND_NEAR_DEG)) kept.push(p);
  }
  return { kept, dropped: sorted.length - kept.length };
}
const ringArea = (r) => { let a = 0; for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return Math.abs(a / 2); };

const parts = {};
const unassigned = [];
// Light simplification keeps borders shared between neighbours while cutting file size.
const pre = presimplify(JSON.parse(JSON.stringify(topo)), sphericalTriangleArea);
const simple = simplify(pre, quantile(pre, Number(process.env.KEEP || 0.35)));
for (const f of feature(simple, simple.objects.countries).features) {
  const rule = C[f.properties.name];
  if (!rule) { unassigned.push(f.properties.name); continue; }
  let geom = toMulti(f.geometry);
  // Russia crosses the antimeridian: shift its far-east (negative) longitudes past 180 so it's one continuous shape
  if (f.properties.name === 'Russia') geom = geom.map((poly) => poly.map((ring) => ring.map(([x, y]) => [x < 0 ? x + 360 : x, y])));
  const rules = typeof rule === 'string' ? [[rule, CONTINENT_BOX[MAP.territories[rule].continent]]] : rule;
  for (const [tid, b] of rules) {
    if (!MAP.territories[tid]) throw new Error('Unknown territory ' + tid);
    const clipped = pc.intersection(geom, box(b));
    if (clipped.length) (parts[tid] = parts[tid] || []).push(clipped);
  }
  // North-east Canada above 60°N: the mainland tip (Ungava) stays with Quebec, the Arctic islands go to NWT
  if (f.properties.name === 'Canada') {
    for (const poly of pc.intersection(geom, box([-79.5, 60, -50, 84]))) {
      const touchesCut = poly[0].some(([, y]) => Math.abs(y - 60) < 1e-6);
      (parts[touchesCut ? 'quebec' : 'nwt'] = parts[touchesCut ? 'quebec' : 'nwt'] || []).push([poly]);
    }
  }
}
const missing = Object.keys(MAP.territories).filter((t) => !parts[t]);
if (missing.length) throw new Error('Territories without land: ' + missing.join(', '));

// ---- projection: Miller, centred so Alaska sits on the left edge and Kamchatka on the right ----
const W = 1000;
const projection = geoMiller().rotate([-11, 0]).precision(0.1);
const shapes = {};
const islandReport = [];
for (const [tid, list] of Object.entries(parts)) {
  let merged = pc.union(...list);
  merged = merged.filter((poly) => ringArea(poly[0]) > 0.12); // drop specks
  const pr = pruneIslands(merged);
  if (pr.dropped) islandReport.push(`${tid} -${pr.dropped}`);
  merged = pr.kept;
  // Densify long straight edges (polygon-clipping drops collinear points) so cut lines along a parallel
  // stay on that parallel instead of being drawn as bulging great-circle arcs.
  merged = merged.map((poly) => poly.map((ring) => {
    const out = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) / 0.5));
      for (let k = 0; k < n; k++) out.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
    }
    out.push(ring[ring.length - 1]);
    return out;
  }));
  // polygon-clipping winds outer rings counter-clockwise; d3-geo (spherical) expects clockwise
  merged = merged.map((poly) => poly.map((ring) => ring.slice().reverse()));
  shapes[tid] = { type: 'MultiPolygon', coordinates: merged };
  if (d3.geoArea(shapes[tid]) > 2 * Math.PI) throw new Error('Inverted winding for ' + tid);
}
const all = { type: 'FeatureCollection', features: Object.entries(shapes).map(([id, g]) => ({ type: 'Feature', id, geometry: g })) };
projection.fitWidth(W - 16, all);
const [[bx0, by0], [bx1, by1]] = d3.geoPath(projection).bounds(all);
const H = Math.ceil(by1 - by0 + 16);
projection.translate([projection.translate()[0] + 8 - bx0, projection.translate()[1] + 8 - by0]);
const pathGen = d3.geoPath(projection).digits(1);

const out = { width: W, height: H, paths: {}, points: {}, seaRoutes: [], graticule: '' };
const projRings = {};
for (const [tid, g] of Object.entries(shapes)) {
  out.paths[tid] = pathGen(g);
  projRings[tid] = g.coordinates.map((poly) => poly.map((ring) => ring.map((p) => projection(p))));
}

// Badge anchor: the "pole of inaccessibility" of each territory's largest landmass, unless overridden.
const OVERRIDE_LONLAT = { // [lon, lat] for crowded areas, chosen after visual review
  greatBritain: [-1.9, 53.4], northEurope: [16.5, 52.3], southEurope: [21, 43.8], westEurope: [-3.6, 40.2],
  scandinavia: [15, 63.5], irkutsk: [104, 55.5],
};
const OVERRIDE = Object.fromEntries(Object.entries(OVERRIDE_LONLAT).map(([k, ll]) => [k, projection(ll).map((v) => Math.round(v * 10) / 10)]));
// Where each name sits relative to its badge (default: just below).
out.labelOffsets = { greatBritain: [-38, 4], northEurope: [4, -17], scandinavia: [0, -17], irkutsk: [36, 4], newGuinea: [10, 21], westAustralia: [-14, 21], westEurope: [0, 21] };
out.continentLabels = { NA: [75, 250], SA: [180, 400], EU: [470, 78], AF: [440, 430], AS: [690, 345], AU: [850, 470] };
for (const [tid, polys] of Object.entries(projRings)) {
  const big = polys.slice().sort((a, b) => ringArea(b[0]) - ringArea(a[0]))[0];
  const p = polylabel(big, 0.5);
  out.points[tid] = OVERRIDE[tid] || [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
}

// Sea routes: adjacent territories whose shapes don't share a border get a dashed line between closest coasts.
function closest(a, b) {
  // distance between two territories' outlines, measured point-to-segment so long straight
  // borders (e.g. the 49th parallel) count as touching
  const segs = (rings) => { const out = []; for (const poly of rings) for (const ring of poly) for (let i = 0; i < ring.length - 1; i++) out.push([ring[i], ring[i + 1]]); return out; };
  const ptSeg = (p, [u, v]) => {
    const dx = v[0] - u[0], dy = v[1] - u[1], L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / L)) : 0;
    const q = [u[0] + t * dx, u[1] + t * dy];
    return [Math.hypot(p[0] - q[0], p[1] - q[1]), q];
  };
  let best = [Infinity];
  const A = projRings[a].flat(2), B = projRings[b].flat(2), SA = segs(projRings[a]), SB = segs(projRings[b]);
  for (const p of A) for (const sg of SB) { const [d, q] = ptSeg(p, sg); if (d < best[0]) best = [d, p, q]; }
  for (const p of B) for (const sg of SA) { const [d, q] = ptSeg(p, sg); if (d < best[0]) best = [d, q, p]; }
  return best;
}
for (const [a, b] of MAP.edges) {
  if ((a === 'alaska' && b === 'kamchatka') || (a === 'kamchatka' && b === 'alaska')) {
    const al = projRings.alaska.flat(2).reduce((m, p) => (p[0] < m[0] ? p : m));
    const ka = projRings.kamchatka.flat(2).reduce((m, p) => (p[0] > m[0] ? p : m));
    const r1 = (v) => Math.round(v * 10) / 10;
    out.seaRoutes.push([r1(al[0]), r1(al[1]), 0, r1(al[1]), 'alaska', 'kamchatka', 'wrapW'], [r1(ka[0]), r1(ka[1]), W, r1(ka[1]), 'kamchatka', 'alaska', 'wrapE']);
    continue;
  }
  const [d, p, q] = closest(a, b);
  if (d > 1.2) out.seaRoutes.push([...[p[0], p[1], q[0], q[1]].map((v) => Math.round(v * 10) / 10), a, b]);
}
// latitude/longitude lines every 15°, plus the equator (drawn a little stronger)
out.graticule = pathGen(d3.geoGraticule().extent([[-180, -75], [180, 85.0001]]).step([15, 15])());
out.proj = { type: 'miller', scale: projection.scale(), translate: projection.translate(), rotate: projection.rotate() }; // used by tools/build-relief.py
out.equator = pathGen({ type: 'LineString', coordinates: [[-180, 0], [-90, 0], [0, 0], [90, 0], [180, 0]] });

const js = `// Generated by tools/build-map.js from Natural Earth (public domain). Do not edit by hand.
(function (root) { const GEO = ${JSON.stringify(out)};
if (typeof module === 'object' && module.exports) module.exports = GEO; else root.CONQUISTA_GEO = GEO; })(typeof self !== 'undefined' ? self : this);
`;
fs.writeFileSync(path.join(__dirname, '..', 'shared', 'map-geo.js'), js);
console.log(`Wrote shared/map-geo.js: ${W}x${H}, ${(js.length / 1024).toFixed(0)} KB, ${out.seaRoutes.length} sea routes`);
console.log('Stray islands removed:', islandReport.join(', '));

// Consistency check: territories that visibly share a border must be connected in the rules.
{
  const bboxes = Object.fromEntries(Object.entries(projRings).map(([t, polys]) => {
    const pts = polys.flat(2); const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [t, [Math.min(...xs) - 2, Math.min(...ys) - 2, Math.max(...xs) + 2, Math.max(...ys) + 2]];
  }));
  const overlap = (a, b) => !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
  const edgeSet = new Set(MAP.edges.map(([a, b]) => [a, b].sort().join('|')));
  const ids = Object.keys(projRings), bad = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = ids[i], b = ids[j];
    if (edgeSet.has([a, b].sort().join('|')) || !overlap(bboxes[a], bboxes[b])) continue;
    if (closest(a, b)[0] < 1.2) bad.push(`${a}-${b}`);
  }
  console.log(bad.length ? 'WARNING: touching but not connected: ' + bad.join(', ') : 'Check passed: every shared border is a real connection');
}
if (process.env.DEBUG_PT) {
  for (const [lon, lat] of JSON.parse(process.env.DEBUG_PT)) {
    const hit = Object.entries(shapes).filter(([, g]) => d3.geoContains(g, [lon, lat])).map(([t]) => t);
    console.log(`(${lon}, ${lat}) -> ${hit.join(',') || 'nothing'}  board ${projection([lon, lat]).map((v) => v.toFixed(1))}`);
  }
}
