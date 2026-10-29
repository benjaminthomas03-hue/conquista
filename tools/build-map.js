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
  'Canada': [['nwt', [-141, 60, -50, 84]], ['alberta', [-141, 40, -102, 60]], ['ontario', [-102, 40, -79.5, 60]], ['quebec', [-79.5, 40, -50, 60]]],
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
    ['irkutsk', [100, 35, 135, 58]], ['yakutsk', [100, 58, 150, 82]],
    ['kamchatka', [135, 35, 150, 58]], ['kamchatka', [150, 35, 192, 82]],
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
  ...Object.fromEntries(['Afghanistan', 'Turkmenistan', 'Uzbekistan', 'Tajikistan', 'Kyrgyzstan', 'Kazakhstan'].map((n) => [n, 'afghanistan'])),
  ...Object.fromEntries(['India', 'Pakistan', 'Nepal', 'Bhutan', 'Bangladesh', 'Sri Lanka', 'Siachen Glacier'].map((n) => [n, 'india'])),
  ...Object.fromEntries(['China', 'Taiwan', 'North Korea', 'South Korea', 'Hong Kong', 'Macao'].map((n) => [n, 'china'])),
  'Mongolia': 'mongolia',
  'Japan': 'japan',
  ...Object.fromEntries(['Myanmar', 'Thailand', 'Laos', 'Cambodia', 'Vietnam', 'Malaysia', 'Singapore'].map((n) => [n, 'siam'])),
  // Australia / Oceania
  'Indonesia': [['indonesia', [94, -12, 132, 7]], ['newGuinea', [132, -12, 142, 2]]],
  ...Object.fromEntries(['Philippines', 'Brunei', 'Timor-Leste'].map((n) => [n, 'indonesia'])),
  ...Object.fromEntries(['Papua New Guinea', 'Solomon Is.'].map((n) => [n, 'newGuinea'])),
  'Australia': [['westAustralia', [110, -45, 135, -9]], ['eastAustralia', [135, -45, 155, -9]]],
  'New Zealand': [['eastAustralia', [165, -48, 179, -34]]],
};
// Whole-country assignments are clipped to their continent's box to drop far-flung overseas islands.
const CONTINENT_BOX = { NA: [-169, 7, -10, 84], SA: [-82, -56, -30, 13], EU: [-25, 34, 62, 82], AF: [-18, -36, 55, 38], AS: [25, -12, 180, 82], AU: [94, -48, 180, 8] };

const box = ([x0, y0, x1, y1]) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
const toMulti = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);
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
}
const missing = Object.keys(MAP.territories).filter((t) => !parts[t]);
if (missing.length) throw new Error('Territories without land: ' + missing.join(', '));

// ---- projection: Miller, centred so Alaska sits on the left edge and Kamchatka on the right ----
const W = 1000;
const projection = geoMiller().rotate([-11, 0]).precision(0.1);
const shapes = {};
for (const [tid, list] of Object.entries(parts)) {
  let merged = pc.union(...list);
  merged = merged.filter((poly) => ringArea(poly[0]) > 0.12); // drop specks
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
  let best = [Infinity];
  const A = projRings[a].flat(2), B = projRings[b].flat(2);
  for (let i = 0; i < A.length; i += 1) for (let j = 0; j < B.length; j += 1) {
    const d = (A[i][0] - B[j][0]) ** 2 + (A[i][1] - B[j][1]) ** 2;
    if (d < best[0]) best = [d, A[i], B[j]];
  }
  return [Math.sqrt(best[0]), best[1], best[2]];
}
for (const [a, b] of MAP.edges) {
  if ((a === 'alaska' && b === 'kamchatka') || (a === 'kamchatka' && b === 'alaska')) {
    const al = projRings.alaska.flat(2).reduce((m, p) => (p[0] < m[0] ? p : m));
    const ka = projRings.kamchatka.flat(2).reduce((m, p) => (p[0] > m[0] ? p : m));
    out.seaRoutes.push([al[0], al[1], 0, al[1]], [ka[0], ka[1], W, ka[1]]);
    continue;
  }
  const [d, p, q] = closest(a, b);
  if (d > 1.2) out.seaRoutes.push([p[0], p[1], q[0], q[1]].map((v) => Math.round(v * 10) / 10));
}
out.graticule = pathGen(d3.geoGraticule().step([20, 20]).extentMinor([[-180, -60], [180, 80]])());

const js = `// Generated by tools/build-map.js from Natural Earth (public domain). Do not edit by hand.
(function (root) { const GEO = ${JSON.stringify(out)};
if (typeof module === 'object' && module.exports) module.exports = GEO; else root.CONQUISTA_GEO = GEO; })(typeof self !== 'undefined' ? self : this);
`;
fs.writeFileSync(path.join(__dirname, '..', 'shared', 'map-geo.js'), js);
console.log(`Wrote shared/map-geo.js: ${W}x${H}, ${(js.length / 1024).toFixed(0)} KB, ${out.seaRoutes.length} sea routes`);
console.log('Unassigned (dropped):', unassigned.join(', '));
