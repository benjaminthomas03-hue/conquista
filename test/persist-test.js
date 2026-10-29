// Saved-games test: real Postgres, real server process. Start a game, kill the server,
// restart it, and check players can resume exactly where they were.
// Run with:  DATABASE_URL=postgres://... node test/persist-test.js   (use a throwaway database)
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (s, ev, d) => new Promise((r) => s.emit(ev, d, r));
const DB = process.env.DATABASE_URL;
if (!DB) { console.log('Set DATABASE_URL to run the saved-games test (skipped).'); process.exit(0); }

function startServer() {
  const p = spawn('node', ['server/index.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '4100', DATABASE_URL: DB } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.log = () => out;
  return p;
}
const waitFor = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(100); } return false; };

(async () => {
  let srv = startServer();
  try {
    await waitFor(() => /running on/.test(srv.log()));
    console.log(srv.log().trim().split('\n').join(' | '));
    const a = io('http://localhost:4100', { forceNew: true });
    let state = null; a.on('state', (s) => { state = s; });
    const r = await call(a, 'room:create', { name: 'Benjamin' });
    await call(a, 'room:addBot', { level: 'normal' });
    await call(a, 'room:settings', { mode: 'capitals', fog: true });
    await call(a, 'room:start', {});
    await waitFor(() => state && state.game && state.game.phase === 'setup');
    // choose capital happened? capitals phase first
    await waitFor(() => state && state.game && state.game.phase !== 'capitals', 3000);
    if (state.game.phase === 'capitals') {
      const mine = Object.keys(state.game.territories).filter((t) => state.game.territories[t].owner === r.playerId);
      await call(a, 'game:action', { type: 'capital', payload: { territory: mine[0] } });
    }
    await waitFor(() => state.game.phase === 'setup');
    const mine = Object.keys(state.game.territories).filter((t) => state.game.territories[t].owner === r.playerId);
    await call(a, 'game:action', { type: 'placeSetup', payload: { territory: mine[1], count: 7 } });
    await sleep(300);
    const before = { gameId: state.game.gameId, armies: state.game.territories[mine[1]].armies, left: state.game.setupRemaining[r.playerId], capital: state.game.capitals[r.playerId] };
    await sleep(2000); // let the debounced save land
    a.close();
    srv.kill('SIGKILL');
    console.log('server killed; restarting…');
    srv = startServer();
    await waitFor(() => /running on/.test(srv.log()));
    const b = io('http://localhost:4100', { forceNew: true });
    let st2 = null; b.on('state', (s) => { st2 = s; });
    const peek = await call(b, 'room:peek', { games: [{ code: r.code, token: r.token }] });
    const j = await call(b, 'room:join', { code: r.code, token: r.token });
    await waitFor(() => st2 && st2.game);
    const after = { gameId: st2.game.gameId, armies: st2.game.territories[mine[1]].armies, left: st2.game.setupRemaining[r.playerId], capital: st2.game.capitals[r.playerId] };
    console.log('peek:', JSON.stringify(peek.games));
    console.log('rejoined as same player:', j.ok && j.playerId === r.playerId);
    console.log('before:', JSON.stringify(before));
    console.log('after: ', JSON.stringify(after));
    const same = JSON.stringify(before) === JSON.stringify(after);
    // the bot should still be able to play after restore: finish setup and see play start
    await call(b, 'game:action', { type: 'placeSetup', payload: { territory: mine[1], count: 99 } });
    const started = await waitFor(() => st2.game.phase === 'playing', 8000);
    console.log(same && started && peek.games.length === 1 ? 'PERSISTENCE TEST PASSED' : 'PERSISTENCE TEST FAILED', '(game resumed and continued:', started + ')');
    b.close();
  } catch (e) { console.error(e); console.log(srv.log()); }
  srv.kill('SIGKILL');
  process.exit(0);
})();
