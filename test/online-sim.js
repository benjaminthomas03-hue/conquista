// End-to-end test: starts the real server, connects bot clients over Socket.IO and plays full games.
process.env.PORT = process.env.PORT || '3999';
const { server } = require('../server/index');
const { io } = require('socket.io-client');
const { nextAction } = require('./bot');

const URL = 'http://localhost:' + process.env.PORT;
const call = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));

async function playGame(nPlayers, mode) {
  const clients = [];
  const host = io(URL, { forceNew: true });
  const r = await call(host, 'room:create', { name: 'Host' });
  if (!r.ok) throw new Error('create failed');
  clients.push({ s: host, id: r.playerId });
  for (let i = 1; i < nPlayers; i++) {
    const s = io(URL, { forceNew: true });
    const j = await call(s, 'room:join', { code: r.code, name: 'Bot' + i });
    if (!j.ok) throw new Error('join failed: ' + j.error);
    clients.push({ s, id: j.playerId, token: j.token, code: r.code });
  }
  await call(host, 'room:settings', { mode, timer: 0 });
  // simulate a disconnect + reconnect of player 2 mid-game
  let reconnected = false;

  return new Promise((resolve, reject) => {
    let actions = 0, finished = false;
    const timeout = setTimeout(() => reject(new Error('game timed out after ' + actions + ' actions')), 120000);
    for (const c of clients) wire(c);
    (async () => {
      const st = await call(host, 'room:start', {});
      if (!st.ok) return reject(new Error('start failed'));
      // a late joiner should be rejected after start
      const late = io(URL, { forceNew: true });
      const lj = await call(late, 'room:join', { code: r.code, name: 'Late' });
      late.close();
      if (lj.ok) reject(new Error('late join should fail'));
    })();
    function wire(c) {
      let busy = false, latest = null;
      c.s.on('state', (state) => { latest = state.game; kick(); });
      async function kick() {
        const g = latest;
        if (!g || finished) return;
        if (g.phase === 'over') {
          finished = true; clearTimeout(timeout);
          const w = g.players.find((p) => p.id === g.winner);
          clients.forEach((x) => x.s.close());
          return resolve({ turns: g.turnNumber, actions, winner: w.name, mission: w.mission });
        }
        if (busy) return;
        const a = nextAction(g, c.id);
        if (!a) return;
        busy = true;
        latest = null; // wait for the state produced by this action
        actions++;
        if (!reconnected && actions === 200 && c.token) {
          reconnected = true;
          c.s.close();
          const s2 = io(URL, { forceNew: true });
          c.s = s2;
          wire(c);
          const rj = await call(s2, 'room:join', { code: c.code, token: c.token });
          if (!rj.ok || rj.playerId !== c.id) return reject(new Error('reconnect failed'));
          busy = false;
          return;
        }
        let res = await call(c.s, 'game:action', { type: a[0], payload: a[1] });
        if (!res.ok && a[0] === 'fortify') res = await call(c.s, 'game:action', { type: 'endTurn' });
        if (!res.ok) return reject(new Error(a[0] + ': ' + res.error));
        busy = false;
        kick();
      }
    }
  });
}

(async () => {
  try {
    for (const [n, mode] of [[2, 'domination'], [3, 'missions'], [4, 'domination'], [6, 'missions']]) {
      const r = await playGame(n, mode);
      console.log(`${n} players, ${mode}: winner ${r.winner} after ${r.turns} turns / ${r.actions} actions${r.mission ? ' — ' + r.mission : ''}`);
    }
    console.log('Online simulation passed');
    process.exit(0);
  } catch (e) {
    console.error('FAILED', e);
    process.exit(1);
  }
})();
