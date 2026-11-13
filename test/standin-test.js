// End-to-end test of the stand-in bot: a human leaves mid-game, the host hands their seat to a bot,
// the bot plays their turns, and the human takes the seat back by rejoining.
process.env.PORT = process.env.PORT || '3998';
process.env.BOT_DELAY_SCALE = process.env.BOT_DELAY_SCALE || '0.03';
const { server } = require('../server/index');
const { io } = require('socket.io-client');
const { nextAction } = require('./bot');

const URL = 'http://localhost:' + process.env.PORT;
const call = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 20000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out waiting for ' + what); await sleep(20); } };
const ok = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); };

// a socket player that plays sensible moves whenever it can
function player(s, id) {
  const p = { s, id, game: null, room: null, auto: true };
  let busy = false;
  const kick = async () => {
    if (busy || !p.auto || !p.game || p.game.phase === 'over') return;
    const a = nextAction(p.game, id); if (!a) return;
    busy = true;
    const res = await call(s, 'game:action', { type: a[0], payload: a[1] });
    if (!res.ok && a[0] === 'fortify') await call(s, 'game:action', { type: 'endTurn' });
    busy = false; kick();
  };
  s.on('state', (st) => { p.game = st.game; p.room = st.room; kick(); });
  return p;
}

(async () => {
  const hs = io(URL, { forceNew: true });
  const r = await call(hs, 'room:create', { name: 'Host' });
  const gs = io(URL, { forceNew: true });
  const j = await call(gs, 'room:join', { code: r.code, name: 'Guest' });
  await call(hs, 'room:addBot', { level: 'normal' });
  await call(hs, 'room:settings', { mode: 'domination', timer: 0 });
  const host = player(hs, r.playerId), guest = player(gs, j.playerId);
  ok((await call(hs, 'room:start', {})).ok, 'start');
  await until(() => host.game && host.game.phase === 'playing' && host.game.turnNumber >= 3, 'turn 3');

  // the bot got a random funny name
  const botName = host.room.players.find((p) => p.bot).name;
  ok(/^(General|Major|Captain|Sergeant|Colonel|Baron|Marshal|Admiral|Count|Baroness|Corporal|Duchess|Lieutenant|Brigadier|Private|Commodore|Field Marshal) /.test(botName), 'bot name from the pool: ' + botName);

  // nobody can replace a player who is still online, and only the host may ask
  ok(!(await call(hs, 'game:standIn', { id: guest.id })).ok, 'online player cannot be replaced');
  ok(!(await call(gs, 'game:standIn', { id: host.id })).ok, 'only the host can hand a seat to a bot');

  // the guest leaves; without a stand-in the game waits on their turn
  guest.auto = false;
  await call(gs, 'room:leave', {});
  await until(() => host.room.players.find((p) => p.id === guest.id).connected === false, 'guest offline');
  ok((await call(hs, 'game:standIn', { id: guest.id })).ok, 'host hands the seat to a bot');
  await until(() => host.game.players.find((p) => p.id === guest.id).standIn, 'stand-in flag');
  ok(host.game.players.find((p) => p.id === guest.id).bot === 'hard', 'stand-in plays at Hard');
  ok(!(await call(hs, 'game:standIn', { id: guest.id })).ok, 'cannot hand the same seat over twice');

  // the bot actually plays the guest's turns: wait for the guest's seat to complete two more turns
  const turnsBy = () => host.game.log.filter((l) => l.text.includes('a bot is playing')).length;
  ok(turnsBy() === 1, 'log tells the table');
  const startTurn = host.game.turnNumber;
  await until(() => host.game.phase === 'over' || host.game.turnNumber >= startTurn + 7, 'seven more turns with the stand-in', 60000);
  ok(host.game.phase === 'over' || host.game.players.find((p) => p.id === guest.id).alive !== undefined, 'game carried on');

  if (host.game.phase !== 'over' && host.game.players.find((p) => p.id === guest.id).alive) {
    // the guest comes back and takes the seat again
    const gs2 = io(URL, { forceNew: true });
    const g2 = player(gs2, guest.id); // listen before joining so the first state isn't missed
    const back = await call(gs2, 'room:join', { code: r.code, token: j.token });
    ok(back.ok && back.playerId === guest.id, 'guest rejoined their seat');
    await until(() => !host.game.players.find((p) => p.id === guest.id).standIn, 'seat handed back');
    ok(host.game.players.find((p) => p.id === guest.id).bot === null, 'no longer a bot');
    ok(host.game.log.some((l) => l.text.includes('is back')), 'log says they are back');
    // and the game still runs to the end with the human back in control
    await until(() => host.game.phase === 'over', 'game over', 200000);
    void g2;
    console.log('stand-in bot: seat handed over, bot played, human took it back, game finished ✓ (bot was "' + botName + '")');
  } else {
    console.log('stand-in bot: seat handed over and bot played ✓ (game ended before the human returned)');
  }
  server.close(); process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
