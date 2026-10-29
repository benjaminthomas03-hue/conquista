// A simple greedy bot used by the tests. Works against a view + an `act(type, payload)` function.
const MAP = require('../shared/map');

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function findSet(cards) {
  const valid = (s) => s.some((c) => c.symbol === 'wild') || new Set(s.map((c) => c.symbol)).size !== 2;
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length; j++)
      for (let k = j + 1; k < cards.length; k++)
        if (valid([cards[i], cards[j], cards[k]])) return [cards[i].id, cards[j].id, cards[k].id];
  return null;
}

// Returns the next action for player `me` given view `v`, or null if nothing to do.
function nextAction(v, me) {
  const T = v.territories;
  const mine = Object.keys(T).filter((t) => T[t].owner === me);
  const border = mine.filter((t) => MAP.territories[t].neighbors.some((n) => T[n].owner !== me));
  if (v.phase === 'setup') {
    if (v.setupRemaining[me] > 0) return ['placeSetup', { territory: pick(border.length ? border : mine), count: Math.min(3, v.setupRemaining[me]) }];
    return null;
  }
  if (v.phase !== 'playing' || v.currentPlayer !== me) return null;
  const meP = v.players.find((p) => p.id === me);
  if (v.pendingMove) return ['move', { count: v.pendingMove.max }];
  if (v.step === 'reinforce') {
    const set = meP.cards && findSet(meP.cards);
    if (set && (meP.cards.length >= 5 || Math.random() < 0.5)) return ['trade', { cards: set }];
    if (v.reinforcements > 0) {
      const best = border.sort((a, b) => T[b].armies - T[a].armies)[0] || mine[0];
      return ['place', { territory: best, count: v.reinforcements }];
    }
    return ['finishTrade', {}];
  }
  if (v.step === 'attack') {
    const options = [];
    for (const f of mine) {
      if (T[f].armies < 3) continue;
      for (const n of MAP.territories[f].neighbors) if (T[n].owner !== me && T[n].armies < T[f].armies) options.push([f, n]);
    }
    if (options.length && Math.random() < 0.95) {
      const [f, n] = pick(options);
      return ['attack', { from: f, to: n, dice: 3, blitz: Math.random() < 0.7 }];
    }
    return ['endAttack', {}];
  }
  if (v.step === 'fortify') {
    const interior = mine.filter((t) => !border.includes(t) && T[t].armies > 1);
    if (interior.length && border.length) {
      const from = interior[0];
      // engine checks connectivity; try a random border target
      return ['fortify', { from, to: pick(border), count: T[from].armies - 1 }];
    }
    return ['endTurn', {}];
  }
  return null;
}

module.exports = { nextAction };
