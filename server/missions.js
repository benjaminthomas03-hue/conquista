// Secret mission definitions and checks.
const MAP = require('../shared/map');

function ownsContinent(game, pid, c) {
  return MAP.continentTerritories[c].every((t) => game.territories[t].owner === pid);
}
function countOwned(game, pid, minArmies = 1) {
  return Object.values(game.territories).filter((t) => t.owner === pid && t.armies >= minArmies).length;
}

const CONTINENT_MISSIONS = [
  { key: 'NA_AF', text: 'Conquer North America and Africa', req: ['NA', 'AF'] },
  { key: 'NA_AU', text: 'Conquer North America and Australia', req: ['NA', 'AU'] },
  { key: 'AS_SA', text: 'Conquer Asia and South America', req: ['AS', 'SA'] },
  { key: 'AS_AF', text: 'Conquer Asia and Africa', req: ['AS', 'AF'] },
  { key: 'EU_SA_X', text: 'Conquer Europe, South America and one other continent', req: ['EU', 'SA'], extra: 1 },
  { key: 'EU_AU_X', text: 'Conquer Europe, Australia and one other continent', req: ['EU', 'AU'], extra: 1 },
];

// Builds the mission pool for a set of players and deals one to each.
function dealMissions(players, rng) {
  const pool = [];
  for (const m of CONTINENT_MISSIONS) pool.push({ type: 'continents', ...m });
  pool.push({ type: 'territories', key: 'T24', text: 'Occupy 24 territories', count: 24, min: 1 });
  pool.push({ type: 'territories', key: 'T18x2', text: 'Occupy 18 territories with at least 2 armies in each', count: 18, min: 2 });
  for (const p of players) {
    pool.push({ type: 'destroy', key: 'D_' + p.id, target: p.id, text: `Destroy ${p.name} (${p.colorName}). If that is not possible, occupy 24 territories` });
  }
  const shuffled = shuffle(pool, rng);
  const out = {};
  for (const p of players) {
    // never draw a mission to destroy yourself
    const idx = shuffled.findIndex((m) => !(m.type === 'destroy' && m.target === p.id));
    out[p.id] = shuffled.splice(idx, 1)[0];
  }
  return out;
}

function missionComplete(game, pid) {
  const player = game.player(pid);
  const m = player && player.mission;
  if (!m) return false;
  if (m.type === 'continents') {
    if (!m.req.every((c) => ownsContinent(game, pid, c))) return false;
    if (!m.extra) return true;
    const others = Object.keys(MAP.CONTINENTS).filter((c) => !m.req.includes(c) && ownsContinent(game, pid, c));
    return others.length >= m.extra;
  }
  if (m.type === 'territories') return countOwned(game, pid, m.min) >= m.count;
  if (m.type === 'destroy') {
    const target = game.player(m.target);
    if (target && !target.alive) {
      if (target.eliminatedBy === pid) return true;
      return countOwned(game, pid) >= 24; // someone else got there first
    }
    return false;
  }
  return false;
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { dealMissions, missionComplete, ownsContinent, countOwned, shuffle };
