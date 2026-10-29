// End-to-end test: starts the real server, connects socket "players" (simple bots), adds server-side
// AI bots, and plays full games under different settings. Also checks spectators, truces and DMs.
process.env.PORT = process.env.PORT || '3999';
process.env.BOT_DELAY_SCALE = process.env.BOT_DELAY_SCALE || '0.03'; // run AI bots quickly in tests
const { server } = require('../server/index');
const { io } = require('socket.io-client');
const { nextAction } = require('./bot');

const URL = 'http://localhost:' + process.env.PORT;
const call = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function playGame({ humans, bots, settings, label }) {
  const clients = [];
  const host = io(URL, { forceNew: true });
  const r = await call(host, 'room:create', { name: 'Host' });
  if (!r.ok) throw new Error('create failed');
  clients.push({ s: host, id: r.playerId, token: r.token, code: r.code });
  for (let i = 1; i < humans; i++) {
    const s = io(URL, { forceNew: true });
    const j = await call(s, 'room:join', { code: r.code, name: 'Human' + i });
    if (!j.ok) throw new Error('join failed: ' + j.error);
    clients.push({ s, id: j.playerId, token: j.token, code: r.code });
  }
  for (const level of bots) { const b = await call(host, 'room:addBot', { level }); if (!b.ok) throw new Error('addBot failed: ' + b.error); }
  await call(host, 'room:settings', { ...settings, timer: 0 });

  const checks = { spectatorSawGame: false, botDeclinedTruce: false, dmPrivate: true, dmDelivered: false };
  let reconnected = false;

  return new Promise((resolve, reject) => {
    let actions = 0, finished = false, latestHost = null;
    const timeout = setTimeout(() => reject(new Error(`${label}: game timed out after ${actions} actions`)), 240000);
    for (const c of clients) wire(c);

    (async () => {
      const st = await call(host, 'room:start', {});
      if (!st.ok) return reject(new Error('start failed: ' + st.error));
      // a late joiner becomes a spectator
      const spec = io(URL, { forceNew: true });
      spec.on('state', (s) => { if (s.spectator && s.game) checks.spectatorSawGame = true; });
      spec.on('chat', (m) => { if (m.private) checks.dmPrivate = false; });
      const sj = await call(spec, 'room:join', { code: r.code, name: 'Watcher' });
      if (!sj.ok || !sj.spectator) reject(new Error('late joiner should become a spectator'));
      // private message between two humans
      if (clients[1]) {
        clients[1].s.on('chat', (m) => { if (m.private && m.text === 'psst') checks.dmDelivered = true; });
        host.emit('chat', { text: 'psst', to: clients[1].id });
      }
      await sleep(300);
      spec.close();
    })();

    function wire(c) {
      let busy = false, latest = null;
      c.s.on('notice', (n) => { if (/declined your truce/.test(n.text)) checks.botDeclinedTruce = true; });
      c.s.on('state', (state) => { latest = state.game; if (c.s === host) latestHost = state; kick(); });
      async function kick() {
        const g = latest;
        if (!g || finished) return;
        if (g.phase === 'over') {
          finished = true; clearTimeout(timeout);
          const w = g.players.find((p) => p.id === g.winner);
          // give late notices (a bot answers truce offers after 1.5s) time to arrive
          return setTimeout(() => {
            clients.forEach((x) => x.s.close());
            resolve({ turns: g.turnNumber, actions, winner: w.name, bot: w.bot, checks, recap: !!g.recap });
          }, 2000);
        }
        // once play starts, offer a bot a truce (it should decline)
        if (c.s === host && g.phase === 'playing' && !c.offered && bots.length) {
          c.offered = true;
          const bot = g.players.find((p) => p.bot && p.alive);
          if (bot) call(host, 'truce:propose', { to: bot.id, rounds: 2 });
        }
        if (busy) return;
        const a = nextAction(g, c.id);
        if (!a) return;
        busy = true;
        latest = null;
        actions++;
        if (!reconnected && actions === 150 && c !== clients[0]) {
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
        if (!res.ok && /not your (turn|pick)|not in progress|already|over|no attack to defend|wait for the defender/i.test(res.error)) { busy = false; return; } // raced a bot
        if (!res.ok) return reject(new Error(`${label}: ${a[0]}: ${res.error}`));
        busy = false;
        kick();
      }
    }
  });
}

(async () => {
  try {
    const cases = [
      { label: '2 humans, domination', humans: 2, bots: [], settings: { mode: 'domination' } },
      { label: '2 humans + Hard bot, capitals, draft, fog', humans: 2, bots: ['hard'], settings: { mode: 'capitals', start: 'draft', fog: true } },
      { label: '2 humans + Easy & Normal bots, missions, fixed cards', humans: 2, bots: ['easy', 'normal'], settings: { mode: 'missions', cards: 'fixed' } },
      { label: '1 human + 3 Hard bots, domination', humans: 1, bots: ['hard', 'hard', 'normal'], settings: { mode: 'domination' } },
    ];
    for (const c of cases) {
      const r = await playGame(c);
      const failed = Object.entries(r.checks).filter(([k, v]) => !v && !(k.startsWith('dm') && c.humans < 2) && !(k === 'botDeclinedTruce' && !c.bots.length));
      console.log(`${c.label}: ${r.winner} won after ${r.turns} turns / ${r.actions} socket actions; recap ${r.recap ? 'sent' : 'MISSING'}; checks ${failed.length ? 'FAILED ' + failed.map((f) => f[0]) : 'ok'}`);
      if (failed.length || !r.recap) throw new Error('checks failed');
    }
    console.log('Online simulation passed');
    process.exit(0);
  } catch (e) {
    console.error('FAILED', e);
    process.exit(1);
  }
})();
