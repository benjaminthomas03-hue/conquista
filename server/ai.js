// AI commanders. botAction(game, pid, level) returns the next [actionType, payload] for a bot,
// or null when it has nothing to do right now. Bots only use what a player could see:
// owners everywhere, troop counts on their own and neighbouring territories (fog-safe).
const MAP = require('../shared/map');
const ODDS = require('../shared/odds');

const LEVELS = {
  // block: how strongly the bot tries to stop a player who looks close to winning (0 = never)
  // blockAt: how close (territories still needed) an opponent must look before the bot reacts
  easy:   { attackWin: 0.5, randomness: 0.45, maxAttacks: 3, tradeEarly: false, cardChase: 0, fortify: 0.5, focus: 0.3, block: 0, blockAt: 0 },
  normal: { attackWin: 0.65, randomness: 0.1, maxAttacks: 12, tradeEarly: true, cardChase: 0.5, fortify: 1, focus: 0.8, block: 0.7, blockAt: 3 },
  hard:   { attackWin: 0.55, randomness: 0, maxAttacks: 30, tradeEarly: true, cardChase: 0.38, fortify: 1, focus: 1, block: 1.2, blockAt: 5 },
};
const CONT = Object.keys(MAP.CONTINENTS);
// The continent missions that exist in the deck (public knowledge, like the rules sheet in the box).
const MISSION_PAIRS = [['NA', 'AF', 0], ['NA', 'AU', 0], ['AS', 'SA', 0], ['AS', 'AF', 0], ['EU', 'SA', 1], ['EU', 'AU', 1]];
const contIds = (k) => MAP.continentTerritories[k];

// How far a player is from completing a given objective, using only what's on the board.
// Returns { rem: territories still needed, area: territories that count towards it, need: ones still missing }.
function objectiveProgress(T, pid, obj) {
  const owns = (t) => T[t].owner === pid;
  if (obj.type === 'continents') {
    let area = [...contIds(obj.req[0]), ...contIds(obj.req[1])];
    let need = area.filter((t) => !owns(t));
    if (obj.extra) {
      let best = null;
      for (const k of CONT) {
        if (obj.req.includes(k)) continue;
        const miss = contIds(k).filter((t) => !owns(t));
        if (!best || miss.length < best.miss.length) best = { k, miss };
      }
      area = area.concat(contIds(best.k)); need = need.concat(best.miss);
    }
    return { rem: need.length, area, need };
  }
  const mine = Object.keys(T).filter(owns);
  if (obj.type === 'territories') {
    const counted = obj.min > 1 ? mine.filter((t) => T[t].armies == null || T[t].armies >= obj.min) : mine;
    return { rem: Math.max(0, obj.count - counted.length), area: mine, need: [], any: true, two: obj.min > 1 };
  }
  return { rem: 99, area: [], need: [] };
}

// Read the board like a strong human: for each opponent, guess which objectives they could be close to
// (bots never see other players' secret missions) and work out where to attack or defend to stop them.
function analyseThreats(g, c, pid) {
  const { T, L, me } = c;
  const block = {}, defend = {};
  const out = { block, defend, leader: null };
  if (!L.block || g.phase !== 'playing' && g.phase !== 'setup') return out;
  const add = (m, t, v) => { m[t] = (m[t] || 0) + v; };
  // how close are we ourselves? if we're closer than everyone, we race instead of blocking
  let myRem = 99;
  if (g.mode === 'missions' && me.mission) myRem = me.mission.type === 'destroy' ? 99 : objectiveProgress(T, pid, me.mission).rem;
  if (g.mode === 'domination') myRem = 42 - c.mine.length;
  if (g.mode === 'capitals') { const caps = Object.values(g.capitals || {}); myRem = caps.filter((t) => T[t].owner !== pid).length; }

  for (const o of g.players) {
    if (o.id === pid || !o.alive) continue;
    const cands = [];
    if (g.mode === 'missions') {
      for (const [a, b, extra] of MISSION_PAIRS) cands.push({ ...objectiveProgress(T, o.id, { type: 'continents', req: [a, b], extra }), at: L.blockAt });
      cands.push({ ...objectiveProgress(T, o.id, { type: 'territories', count: 24, min: 1 }), at: L.blockAt });
      cands.push({ ...objectiveProgress(T, o.id, { type: 'territories', count: 18, min: 2 }), at: L.blockAt });
    } else if (g.mode === 'domination') {
      const n = Object.keys(T).filter((t) => T[t].owner === o.id).length;
      cands.push({ rem: 42 - n, area: Object.keys(T).filter((t) => T[t].owner === o.id), need: [], any: true, at: L.blockAt * 3 });
    } else if (g.mode === 'capitals') {
      const caps = Object.values(g.capitals || {});
      const need = caps.filter((t) => T[t].owner !== o.id);
      cands.push({ rem: need.length, area: caps, need, caps: true, at: 1 });
    }
    for (const cand of cands) {
      if (cand.rem > cand.at) continue;
      // urgency grows as they get closer; ease off if we're even closer to winning ourselves
      let w = L.block * (1 + 2 * (cand.at + 1 - cand.rem) / (cand.at + 1));
      if (myRem < cand.rem) w *= 0.4;
      if (!out.leader || cand.rem < out.leader.rem) out.leader = { id: o.id, rem: cand.rem };
      for (const t of cand.area) {
        if (T[t].owner !== o.id) continue;
        let v = w;
        if (cand.two && T[t].armies === 2) v += w * 0.5; // knocking a 2-stack to 1 undoes "18 with 2 armies"
        if (cand.caps) v += w * 2;
        add(block, t, cand.any ? v * 0.5 : v);
      }
      for (const t of cand.need) if (T[t].owner === pid) add(defend, t, w);
    }
  }
  return out;
}

function ctx(g, pid, level) {
  const L = LEVELS[level] || LEVELS.normal;
  const T = g.territories;
  const mine = Object.keys(T).filter((t) => T[t].owner === pid);
  const enemyNbrs = (t) => MAP.territories[t].neighbors.filter((n) => T[n].owner !== pid);
  const border = mine.filter((t) => enemyNbrs(t).length);
  const me = g.player(pid);
  const rnd = () => g.rng();
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  // Which continents to focus on: missions and capitals shape the plan; otherwise
  // favour continents we already hold much of, weighted towards small, defensible ones.
  const contScore = {};
  for (const c of CONT) {
    const ids = MAP.continentTerritories[c];
    const own = ids.filter((t) => T[t].owner === pid).length;
    let s = (own / ids.length) * 3 + MAP.CONTINENTS[c].bonus / ids.length;
    if (me.mission && me.mission.type === 'continents' && me.mission.req.includes(c)) s += 2.5;
    contScore[c] = s;
  }
  const targets = new Set(CONT.slice().sort((a, b) => contScore[b] - contScore[a]).slice(0, 2));
  const destroyTarget = me.mission && me.mission.type === 'destroy' ? me.mission.target : null;
  const enemyCapitals = new Set(Object.entries(g.capitals || {}).filter(([p]) => p !== pid).map(([, t]) => t));
  const myCapital = g.capitals ? g.capitals[pid] : null;

  // Pressure on a territory = strongest adjacent enemy stack minus our troops there.
  const pressure = (t) => Math.max(0, ...enemyNbrs(t).map((n) => T[n].armies)) - T[t].armies;

  const c = { L, T, mine, border, enemyNbrs, me, rnd, pick, targets, destroyTarget, enemyCapitals, myCapital, pressure, contScore };
  c.threat = analyseThreats(g, c, pid);
  return c;
}

// How much we want to own territory `to`.
function targetValue(g, c, pid, to) {
  const { T, targets, destroyTarget, enemyCapitals, myCapital } = c;
  const cont = MAP.territories[to].continent;
  const ids = MAP.continentTerritories[cont];
  let v = 1;
  if (targets.has(cont)) v += 2 * c.L.focus;
  const missing = ids.filter((t) => T[t].owner !== pid);
  if (missing.length === 1 && missing[0] === to) v += 3 + MAP.CONTINENTS[cont].bonus * 0.5; // completes a continent
  const owner = T[to].owner;
  if (ids.every((t) => T[t].owner === owner)) v += 2 + MAP.CONTINENTS[cont].bonus * 0.3;      // breaks an enemy continent
  if (enemyCapitals.has(to)) v += 4;
  if (myCapital && MAP.territories[myCapital].neighbors.includes(to)) v += 1.5;
  if (destroyTarget && owner === destroyTarget) v += 2;
  if (owner && g.ownedIds(owner).length <= 2) v += 2;                                        // finishing a player gives their cards
  v += c.threat.block[to] || 0;                                                                // stop someone close to winning
  return v;
}

function bestStaging(g, c, pid) {
  const { T, border, pressure, myCapital } = c;
  if (!border.length) return c.mine[0];
  if (myCapital && T[myCapital].owner === pid && pressure(myCapital) > -2) return myCapital;
  let best = null, bestScore = -Infinity;
  for (const t of border) {
    let s = 0;
    for (const n of c.enemyNbrs(t)) s = Math.max(s, targetValue(g, c, pid, n) - T[n].armies * 0.15);
    s += Math.max(0, pressure(t)) * 0.2 + T[t].armies * 0.05;
    s += (c.threat.defend[t] || 0) * (pressure(t) > -3 ? 0.8 : 0.2); // hold territory a near-winner needs
    if (s > bestScore) { bestScore = s; best = t; }
  }
  return best;
}

function botAction(g, pid, level) {
  const c = ctx(g, pid, level);
  const { L, T, mine, border, rnd, pick } = c;
  const me = c.me;
  if (!me || !me.alive) return null;

  // ----- draft: claim territories -----
  if (g.phase === 'draft') {
    if (g.current.id !== pid) return null;
    const free = Object.keys(T).filter((t) => !T[t].owner);
    if (rnd() < L.randomness) return ['draftPick', { territory: pick(free) }];
    let best = free[0], bestS = -Infinity;
    for (const t of free) {
      const cont = MAP.territories[t].continent, ids = MAP.continentTerritories[cont];
      const own = ids.filter((x) => T[x].owner === pid).length;
      const taken = ids.filter((x) => T[x].owner && T[x].owner !== pid).length;
      let s = own * 1.5 - taken * 0.8 + MAP.CONTINENTS[cont].bonus / ids.length * 2;
      s += MAP.territories[t].neighbors.filter((n) => T[n].owner === pid).length;
      if (level === 'hard' && (cont === 'AU' || cont === 'SA')) s += 1.5;
      if (s > bestS) { bestS = s; best = t; }
    }
    return ['draftPick', { territory: best }];
  }

  // ----- capitals: pick a safe interior territory -----
  if (g.phase === 'capitals') {
    if (g.capitals[pid]) return null;
    if (rnd() < L.randomness) return ['capital', { territory: pick(mine) }];
    const score = (t) => MAP.territories[t].neighbors.filter((n) => T[n].owner === pid).length * 2 - c.enemyNbrs(t).length * 3;
    return ['capital', { territory: mine.slice().sort((a, b) => score(b) - score(a))[0] }];
  }

  // ----- setup: place starting armies in a few chunks -----
  if (g.phase === 'setup') {
    const left = g.setupRemaining[pid];
    if (!left) return null;
    const n = Math.min(left, Math.max(3, Math.ceil(left / 3)));
    const where = rnd() < L.randomness ? pick(border.length ? border : mine) : bestStaging(g, c, pid);
    return ['placeSetup', { territory: where, count: n }];
  }

  if (g.phase !== 'playing' || g.current.id !== pid) return null;

  if (g.pendingMove) {
    const pm = g.pendingMove;
    const fromThreat = c.enemyNbrs(pm.from).length;
    const toThreat = c.enemyNbrs(pm.to).length;
    let n = pm.max;
    if (fromThreat && level !== 'easy') n = Math.round(pm.min + (pm.max - pm.min) * (toThreat / (toThreat + fromThreat)));
    if (pm.from === c.myCapital) n = pm.min;
    return ['move', { count: Math.max(pm.min, Math.min(pm.max, n)) }];
  }

  if (g.step === 'reinforce') {
    const set = g.findSet(me.cards);
    if (set && (me.cards.length >= 5 || (L.tradeEarly && (level !== 'hard' || g.settings.cards === 'fixed' || me.cards.length >= 4 || g.tradeCount >= 3)))) {
      return ['trade', { cards: set }];
    }
    if (g.reinforcements > 0) {
      const where = rnd() < L.randomness ? pick(border.length ? border : mine) : bestStaging(g, c, pid);
      // normal bots hedge: shore up the most pressured border with part of the troops
      if (level === 'normal' && g.reinforcements > 3) {
        const weak = border.slice().sort((a, b) => c.pressure(b) - c.pressure(a))[0];
        if (weak && weak !== where && c.pressure(weak) > 0) return ['place', { territory: weak, count: Math.ceil(g.reinforcements / 3) }];
      }
      return ['place', { territory: where, count: g.reinforcements }];
    }
    return ['finishTrade', {}];
  }

  if (g.step === 'attack') {
    if (g.attacksThisTurn >= L.maxAttacks) return ['endAttack', {}];
    let best = null, bestScore = -Infinity;
    for (const from of border) {
      const a = T[from].armies;
      if (a < 2) continue;
      for (const to of c.enemyNbrs(from)) {
        if (g.truceBetween(pid, T[to].owner) && level !== 'easy') continue; // honour truces
        const odds = ODDS.blitz(a, T[to].armies);
        const v = targetValue(g, c, pid, to);
        const score = odds.win * v + (rnd() - 0.5) * L.randomness * 2;
        if (score > bestScore) { bestScore = score; best = { from, to, win: odds.win, v }; }
      }
    }
    if (best) {
      const needCard = !g.conqueredThisTurn && L.cardChase && best.win >= L.cardChase;
      let threshold = level === 'hard' && best.v >= 3 ? L.attackWin - 0.1 : L.attackWin;
      if ((c.threat.block[best.to] || 0) >= 2) threshold -= level === 'hard' ? 0.15 : 0.08; // worth a riskier attack to stop a win
      if (best.win >= threshold || needCard || (level === 'easy' && rnd() < 0.15 && best.win > 0.3)) {
        return ['attack', { from: best.from, to: best.to, blitz: true }];
      }
    }
    return ['endAttack', {}];
  }

  if (g.step === 'fortify') {
    if (rnd() > L.fortify) return ['endTurn', {}];
    // move the biggest idle stack towards the most pressured border it can reach
    const interior = mine.filter((t) => !c.enemyNbrs(t).length && T[t].armies > 1).sort((a, b) => T[b].armies - T[a].armies);
    for (const from of interior) {
      const reach = border.filter((t) => g.connected(pid, from, t)).sort((a, b) => c.pressure(b) - c.pressure(a) || T[b].armies - T[a].armies);
      const to = reach.includes(c.myCapital) && c.pressure(c.myCapital) > -2 ? c.myCapital : reach[0];
      if (to) return ['fortify', { from, to, count: T[from].armies - 1 }];
    }
    return ['endTurn', {}];
  }
  return null;
}

module.exports = { botAction, LEVELS };
