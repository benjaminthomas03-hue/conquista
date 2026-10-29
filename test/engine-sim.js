// Engine tests: rule checks plus many full games played by AI bots across every game option.
const assert = require('assert');
const { Game, TERR_IDS } = require('../server/game');
const { botAction } = require('../server/ai');
const MAP = require('../shared/map');

function dispatch(g, pid, [type, p]) {
  switch (type) {
    case 'draftPick': return g.draftPick(pid, p.territory);
    case 'capital': return g.chooseCapital(pid, p.territory);
    case 'placeSetup': return g.placeSetup(pid, p.territory, p.count);
    case 'place': return g.place(pid, p.territory, p.count);
    case 'trade': return g.trade(pid, p.cards);
    case 'finishTrade': return g.finishForcedTrade(pid);
    case 'attack': return g.attack(pid, p.from, p.to, p.dice, p.blitz);
    case 'move': return g.moveAfterConquest(pid, p.count);
    case 'endAttack': return g.endAttack(pid);
    case 'fortify': return g.fortify(pid, p.from, p.to, p.count);
    case 'endTurn': return g.endTurn(pid);
  }
  throw new Error('unknown action ' + type);
}
const mkPlayers = (n, levels) => Array.from({ length: n }, (_, k) => ({ id: 'p' + k, name: 'P' + k, color: '#000', colorName: 'c' + k, bot: levels[k % levels.length] }));

// Plays one game to the end with bots; returns the finished game.
function playOut(g, { roundTrip = false } = {}) {
  let steps = 0;
  while (g.phase !== 'over') {
    if (++steps > 60000) throw new Error('game did not finish');
    if (g.turnNumber > 1200) { g.autoPlayTurn(); if (g.turnNumber > 1500) throw new Error('turn cap'); continue; }
    let acted = false;
    for (const p of g.players) {
      const a = botAction(g, p.id, p.bot);
      if (!a) continue;
      const r = dispatch(g, p.id, a);
      if (!r.ok) {
        if (a[0] === 'fortify') { const r2 = g.endTurn(p.id); if (!r2.ok) throw new Error('endTurn failed: ' + r2.error); }
        else throw new Error(`${p.bot} bot ${a[0]} failed: ${r.error} (phase ${g.phase}, step ${g.step})`);
      }
      acted = true;
      break;
    }
    if (!acted) throw new Error(`stuck in phase ${g.phase} step ${g.step}`);
    if (roundTrip && steps % 97 === 0) g = Game.fromJSON(JSON.parse(JSON.stringify(g))); // simulate save + restore
    for (const [t, s] of Object.entries(g.territories)) {
      if (g.phase === 'playing' && !g.pendingMove && s.armies < 1) throw new Error('Territory with <1 armies: ' + t);
    }
  }
  return g;
}

// ---------- rule checks ----------
{ // every game deals differently
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const g = new Game(mkPlayers(4, [null]));
    seen.add(TERR_IDS.map((t) => g.territories[t].owner).join(','));
  }
  assert.strictEqual(seen.size, 500, 'territory deals repeated');
  console.log('✓ deal randomness: 500 games, 500 different deals');
}
{ // undo during setup and reinforce
  const g = new Game(mkPlayers(3, [null]));
  const pid = g.players[0].id, t = g.ownedIds(pid)[0], before = g.territories[t].armies, left = g.setupRemaining[pid];
  g.placeSetup(pid, t, 3); assert.ok(g.canUndo(pid)); g.undoPlace(pid);
  assert.strictEqual(g.territories[t].armies, before); assert.strictEqual(g.setupRemaining[pid], left);
  g.autoCompleteSetup();
  const cur = g.current.id, r0 = g.reinforcements, tt = g.ownedIds(cur)[0];
  g.place(cur, tt, r0); assert.strictEqual(g.step, 'attack');
  assert.ok(g.canUndo(cur)); g.undoPlace(cur);
  assert.strictEqual(g.step, 'reinforce'); assert.strictEqual(g.reinforcements, r0);
  console.log('✓ undo placement (setup, and reinforce even after it auto-advanced)');
}
{ // fixed card values
  const c = (s) => ({ symbol: s });
  assert.strictEqual(Game.setValue([c('infantry'), c('infantry'), c('infantry')]), 4);
  assert.strictEqual(Game.setValue([c('artillery'), c('artillery'), c('wild')]), 8);
  assert.strictEqual(Game.setValue([c('infantry'), c('cavalry'), c('artillery')]), 10);
  assert.strictEqual(Game.setValue([c('infantry'), c('cavalry'), c('wild')]), 10);
  console.log('✓ fixed card values');
}
{ // draft + capitals flow
  const g = new Game(mkPlayers(3, [null]), { start: 'draft', mode: 'capitals' });
  assert.strictEqual(g.phase, 'draft');
  assert.ok(!g.draftPick(g.players[1].id, 'brazil').ok, 'out of turn pick should fail');
  while (g.phase === 'draft') { const free = TERR_IDS.filter((t) => !g.territories[t].owner); g.draftPick(g.current.id, free[0]); }
  assert.strictEqual(g.phase, 'capitals');
  const v = g.viewFor(g.players[1].id);
  g.chooseCapital(g.players[0].id, g.ownedIds(g.players[0].id)[0]);
  assert.deepStrictEqual(Object.keys(g.viewFor(g.players[1].id).capitals), [], 'capitals secret until all chosen');
  g.autoCompleteSetup();
  assert.strictEqual(g.phase, 'setup'); assert.strictEqual(Object.keys(g.capitals).length, 3);
  assert.ok(v.territories);
  console.log('✓ draft start and capital selection (secret until everyone has chosen)');
}
{ // fog of war hides distant troop counts
  const g = new Game(mkPlayers(3, [null]), { fog: true });
  g.autoCompleteSetup();
  const pid = g.players[0].id, view = g.viewFor(pid);
  const hidden = TERR_IDS.filter((t) => view.territories[t].armies === null);
  assert.ok(hidden.length > 0, 'fog should hide something');
  for (const t of hidden) {
    assert.notStrictEqual(g.territories[t].owner, pid);
    assert.ok(!MAP.territories[t].neighbors.some((n) => g.territories[n].owner === pid), 'neighbours of own land must be visible');
  }
  assert.strictEqual(view.players.find((p) => p.id !== pid).armyCount, null);
  console.log(`✓ fog of war hides ${hidden.length} distant troop counts`);
}
{ // truces: agreed, broken with a betrayal flag
  const g = new Game(mkPlayers(2, [null]));
  g.autoCompleteSetup();
  const a = g.current.id, b = g.players.find((p) => p.id !== a).id;
  const off = g.proposeTruce(a, b, 2); assert.ok(off.ok);
  assert.ok(g.respondTruce(b, off.offer.id, true).ok);
  assert.ok(g.truceBetween(a, b));
  g.place(a, g.ownedIds(a)[0], g.reinforcements);
  let from = null, to = null;
  for (const t of g.ownedIds(a)) for (const n of MAP.territories[t].neighbors) if (g.territories[n].owner === b && !from) { from = t; to = n; }
  g.territories[from].armies = 10;
  assert.ok(g.attack(a, from, to, 3, false).ok);
  assert.ok(!g.truceBetween(a, b), 'truce should be broken');
  assert.strictEqual(g.player(a).betrayals, 1);
  console.log('✓ truce agreed, then broken with a betrayal flag');
}

// ---------- full bot games across options ----------
const N = Number(process.argv[2] || 120);
const modes = ['domination', 'missions', 'capitals'];
const levelsMix = [['hard', 'normal', 'easy'], ['hard'], ['normal'], ['easy', 'hard']];
const wins = { easy: 0, normal: 0, hard: 0 };
let turns = 0;
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const opts = { mode: modes[i % 3], start: i % 4 < 2 ? 'random' : 'draft', cards: i % 5 < 2 ? 'fixed' : 'escalating', fog: i % 2 === 1 };
  const g = playOut(new Game(mkPlayers(2 + (i % 5), levelsMix[i % levelsMix.length]), opts), { roundTrip: i % 10 === 0 });
  const w = g.player(g.winner);
  if (levelsMix[i % levelsMix.length].length > 1) wins[w.bot]++;
  turns += g.turnNumber;
  assert.ok(g.viewFor(w.id).recap.history.length > 0, 'recap history recorded');
}
console.log(`✓ ${N} full bot games (all modes, draft/random, fixed/escalating cards, fog on/off, save+restore) finished; avg ${Math.round(turns / N)} turns, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('  wins in mixed-level games:', JSON.stringify(wins));
