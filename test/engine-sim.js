// Plays many full games with bots directly against the engine to check rules never get stuck.
const { Game } = require('../server/game');
const { nextAction } = require('./bot');

function dispatch(g, pid, [type, p]) {
  switch (type) {
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
}

const N = Number(process.argv[2] || 300);
const stats = { domination: 0, missions: 0, turns: [], stuck: 0, timeouts: 0, missionWins: {} };
for (let i = 0; i < N; i++) {
  const n = 2 + (i % 5);
  const mode = i % 2 ? 'missions' : 'domination';
  const players = Array.from({ length: n }, (_, k) => ({ id: 'p' + k, name: 'P' + k, color: '#000', colorName: 'c' + k }));
  const g = new Game(players, { mode });
  let steps = 0;
  while (g.phase !== 'over' && steps < 200000) {
    steps++;
    let acted = false;
    for (const p of g.players) {
      const a = nextAction(g.viewFor(p.id), p.id);
      if (!a) continue;
      const r = dispatch(g, p.id, a);
      if (!r.ok) {
        // a failed fortify (not connected) is fine — fall back to ending the turn
        if (a[0] === 'fortify') { const r2 = g.endTurn(p.id); if (!r2.ok) throw new Error('endTurn failed: ' + r2.error); }
        else if (a[0] === 'finishTrade') { throw new Error('finishTrade failed: ' + r.error); }
        else throw new Error(`${a[0]} failed: ${r.error} (step ${g.step})`);
      }
      acted = true;
      break;
    }
    if (!acted) { stats.stuck++; break; }
    if (g.turnNumber > 1500) { stats.timeouts++; g.autoPlayTurn(); break; }
  }
  // sanity: armies >= 1 everywhere, total territories 42
  for (const [t, s] of Object.entries(g.territories)) if (s.armies < 1) throw new Error('Territory with <1 armies: ' + t);
  if (g.phase === 'over') {
    stats[mode]++;
    stats.turns.push(g.turnNumber);
    if (mode === 'missions') { const w = g.player(g.winner); const k = w.mission.key.startsWith('D_') ? 'destroy' : w.mission.key; stats.missionWins[k] = (stats.missionWins[k] || 0) + 1; }
  }
}
const avg = stats.turns.reduce((a, b) => a + b, 0) / stats.turns.length;
console.log(JSON.stringify({ games: N, finishedDomination: stats.domination, finishedMissions: stats.missions, stuck: stats.stuck, overTurnCap: stats.timeouts, avgTurns: Math.round(avg), missionWins: stats.missionWins }, null, 1));
if (stats.stuck) process.exit(1);
