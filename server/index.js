// Conquista multiplayer server: Express serves the client, Socket.IO runs rooms, relays game
// actions, drives AI bots, diplomacy, reactions and spectators, and saves rooms when a database is set.
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const { Server } = require('socket.io');
const { Game } = require('./game');
const { botAction } = require('./ai');
const { createStore } = require('./store');

const PORT = process.env.PORT || 3000;
const COLORS = [
  { name: 'Crimson', hex: '#d64545' },
  { name: 'Azure', hex: '#3b7ddd' },
  { name: 'Emerald', hex: '#2e9e62' },
  { name: 'Gold', hex: '#e2b42d' },
  { name: 'Violet', hex: '#8f5bd0' },
  { name: 'Tangerine', hex: '#e8792b' },
];
const BOT_NAMES = ['Kestrel', 'Basalt', 'Juniper', 'Vex', 'Ash', 'Saffron'];
const BOT_LEVELS = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
const REACTIONS = ['😱', '🔥', '🤝', '😂', '💀', '👀', '🎯', '🛡️'];
const PRE_GAME_SECONDS = { draft: 30, capitals: 60, setup: 180 };
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;
const DEFEND_SECONDS = Number(process.env.DEFEND_SECONDS || 20); // defender's time to roll before the game rolls 2 dice for them
const BOT_SPEED = Number(process.env.BOT_DELAY_SCALE || 1); // tests set this low to run bot games fast
// How long a bot waits before each move (ms, at Normal speed), so humans can follow along.
const BOT_DELAY = { draft: 900, capitals: 800, setup: 600, attack: 2400, move: 1500, place: 1500, trade: 1600, endAttack: 1100, fortify: 1700, endTurn: 1200, other: 1400 };
const TURN_START_PAUSE = 1200; // extra pause when a bot's turn begins
const BOT_SPEEDS = { slow: 1.6, normal: 1, fast: 0.5 };
function botDelay(room, g, action) {
  let ms = g.phase === 'playing' ? (BOT_DELAY[action[0]] || BOT_DELAY.other) : BOT_DELAY[g.phase] || BOT_DELAY.other;
  if (g.phase === 'playing' && g.step === 'reinforce' && !g.placeHistory.length && !g.returnToAttack) ms += TURN_START_PAUSE;
  return Math.round(ms * (BOT_SPEEDS[room.settings.botSpeed] || 1) * BOT_SPEED);
}

const app = express();
app.use(compression());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
app.get('/healthz', (_req, res) => res.send('ok'));
const server = http.createServer(app);
const io = new Server(server);
const store = createStore();

const rooms = new Map();
const newId = () => crypto.randomBytes(8).toString('hex');
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 5 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(c));
  return c;
}
const cleanName = (s) => String(s || '').replace(/[<>]/g, '').trim().slice(0, 18) || 'Commander';
const DEFAULT_SETTINGS = { mode: 'domination', start: 'random', cards: 'escalating', fog: false, timer: 0, botSpeed: 'normal' };

function makeRoom(code) {
  return { code, hostId: null, players: [], spectators: [], settings: { ...DEFAULT_SETTINGS }, game: null, lastActivity: Date.now() };
}

// Rebuild a room saved in the database.
function restoreRoom(data) {
  const r = makeRoom(data.code);
  r.hostId = data.hostId;
  r.settings = { ...DEFAULT_SETTINGS, ...data.settings };
  r.lastActivity = data.lastActivity || Date.now();
  r.players = data.players.map((p) => ({ ...p, connected: !!p.bot, socketId: null }));
  r.game = data.game ? Game.fromJSON(data.game) : null;
  rooms.set(r.code, r);
  if (r.game) { scheduleTimer(r); scheduleBots(r); }
  return r;
}
async function getRoom(code) {
  code = String(code || '').toUpperCase().trim();
  if (rooms.has(code)) return rooms.get(code);
  if (!store.enabled || !/^[A-Z]{5}$/.test(code)) return null;
  try { const data = await store.load(code); return data ? (rooms.get(code) || restoreRoom(data)) : null; }
  catch (e) { console.error('[store] load failed:', e.message); return null; }
}

function lobbyView(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    settings: room.settings,
    started: !!room.game,
    colors: COLORS,
    botLevels: BOT_LEVELS,
    reactions: REACTIONS,
    deadline: room.deadline,
    defendDeadline: room.defendDeadline || null,
    saving: store.enabled,
    players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color, colorName: p.colorName, connected: p.connected, bot: p.bot || null })),
    spectators: room.spectators.map((s) => ({ id: s.id, name: s.name })),
  };
}

function broadcast(room) {
  room.lastActivity = Date.now();
  const lobby = lobbyView(room);
  for (const p of room.players) {
    if (!p.socketId) continue;
    io.to(p.socketId).emit('state', { you: p.id, room: lobby, game: room.game ? room.game.viewFor(p.id) : null });
  }
  if (room.spectators.length) {
    const view = room.game ? room.game.viewFor(null) : null;
    for (const s of room.spectators) io.to(s.socketId).emit('state', { you: s.id, spectator: true, room: lobby, game: view });
  }
  store.save(room);
}
const notice = (room, pid, text, kind) => {
  const p = room.players.find((x) => x.id === pid);
  if (p && p.socketId) io.to(p.socketId).emit('notice', { text, kind });
};

// ---------- turn timer ----------
function scheduleTimer(room) {
  clearTimeout(room.timerHandle);
  room.deadline = null;
  const g = room.game;
  if (!g || g.phase === 'over' || !room.settings.timer) return;
  const secs = PRE_GAME_SECONDS[g.phase] ? Math.min(PRE_GAME_SECONDS[g.phase], g.phase === 'draft' ? room.settings.timer : 999) : room.settings.timer;
  room.timerKey = g.timerKey();
  room.deadline = Date.now() + secs * 1000;
  room.timerHandle = setTimeout(() => {
    if (!room.game || room.game !== g) return;
    g.autoPlayTurn();
    afterAction(room);
  }, secs * 1000);
}
// Defender's roll: if they don't respond in time, roll the most dice allowed for them.
function manageDefence(room) {
  const g = room.game, b = g && g.pendingBattle;
  const key = b ? `${g.turnNumber}:${b.from}:${b.to}:${b.round}:${b.rounds}` : null;
  if (key === room.defendKey) return;
  clearTimeout(room.defendTimer);
  room.defendKey = key;
  room.defendDeadline = null;
  if (!b) return;
  const defender = room.players.find((p) => p.id === b.defender);
  const secs = defender && defender.connected ? DEFEND_SECONDS : 2;
  room.defendDeadline = Date.now() + secs * 1000;
  room.defendTimer = setTimeout(() => {
    if (room.game !== g || g.pendingBattle !== b) return;
    const n = Math.min(2, g.territories[b.to].armies);
    g.addLog(`${g.name(b.defender)} didn't roll in time, so the game rolled ${n} for them.`);
    g.defend(b.defender, n, false);
    afterAction(room);
  }, secs * 1000);
}
function afterAction(room) {
  const g = room.game;
  manageDefence(room);
  if (!g || g.timerKey() !== room.timerKey || g.phase === 'over') scheduleTimer(room);
  broadcast(room);
  scheduleBots(room);
}

// ---------- AI bots ----------
function nextBotMove(g) {
  if (g.pendingBattle) return null; // a human is rolling to defend
  for (const p of g.players) {
    if (!p.bot || !p.alive) continue;
    const a = botAction(g, p.id, p.bot);
    if (a) return { pid: p.id, action: a };
  }
  return null;
}
function scheduleBots(room) {
  clearTimeout(room.botTimer);
  const g = room.game;
  if (!g || g.phase === 'over') return;
  const first = nextBotMove(g);
  if (!first) return;
  const delay = botDelay(room, g, first.action);
  room.botTimer = setTimeout(() => {
    if (room.game !== g || g.phase === 'over') return;
    const n = nextBotMove(g);
    if (!n) return;
    let res;
    try { res = runAction(g, n.pid, n.action[0], n.action[1], room); } catch (e) { res = { ok: false, error: e.message }; }
    if (!res.ok && n.action[0] === 'fortify') res = g.endTurn(n.pid);
    if (!res.ok) {
      console.warn(`[bot] ${n.action[0]} failed (${res.error}); auto-playing`);
      if (g.phase === 'playing' && g.current.id === n.pid) g.autoPlayTurn();
      else if (g.phase !== 'playing') g.autoCompleteSetup();
    }
    afterAction(room);
  }, delay);
}

// ---------- action dispatch ----------
// A defender rolls their own dice only if they're a human who is online.
function defendsInteractively(room, g, tid) {
  const t = g.territories[tid];
  const def = t && room && room.players.find((p) => p.id === t.owner);
  return !!(def && !def.bot && def.connected);
}
function runAction(g, pid, type, p = {}, room = null) {
  switch (type) {
    case 'draftPick': return g.draftPick(pid, p.territory);
    case 'capital': return g.chooseCapital(pid, p.territory);
    case 'placeSetup': return g.placeSetup(pid, p.territory, p.count);
    case 'place': return g.place(pid, p.territory, p.count);
    case 'undo': return g.undoPlace(pid);
    case 'trade': return g.trade(pid, p.cards);
    case 'finishTrade': return g.finishForcedTrade(pid);
    case 'attack': return g.attack(pid, p.from, p.to, p.dice, !!p.blitz, defendsInteractively(room, g, p.to));
    case 'defend': return g.defend(pid, p.dice, !!p.autoDefend);
    case 'stopBattle': return g.stopBattle(pid);
    case 'move': return g.moveAfterConquest(pid, p.count);
    case 'endAttack': return g.endAttack(pid);
    case 'fortify': return g.fortify(pid, p.from, p.to, p.count);
    case 'endTurn': return g.endTurn(pid);
    default: return { ok: false, error: 'Unknown action' };
  }
}

io.on('connection', (socket) => {
  let room = null, me = null, spectating = false;
  const reply = (cb, data) => typeof cb === 'function' && cb(data);
  const isHost = () => room && me && !spectating && room.hostId === me.id;

  function attach(r, p, asSpectator = false) {
    room = r; me = p; spectating = asSpectator;
    p.socketId = socket.id;
    p.connected = true;
    socket.join(r.code);
    if (asSpectator) return;
    // if the current host is offline, whoever comes back takes over hosting
    const host = r.players.find((x) => x.id === r.hostId);
    if (!host || !host.connected || host.bot) r.hostId = p.id;
  }

  socket.on('room:create', ({ name } = {}, cb) => {
    const r = makeRoom(newCode());
    const p = { id: newId(), token: newId(), name: cleanName(name), color: COLORS[0].hex, colorName: COLORS[0].name };
    r.players.push(p);
    r.hostId = p.id;
    rooms.set(r.code, r);
    attach(r, p);
    reply(cb, { ok: true, code: r.code, playerId: p.id, token: p.token });
    broadcast(r);
  });

  socket.on('room:join', async ({ code, name, token, watch } = {}, cb) => {
    const r = await getRoom(code);
    if (!r) return reply(cb, { ok: false, error: 'Room not found — check the code' });
    let p = token && r.players.find((x) => x.token === token);
    if (p) { attach(r, p); reply(cb, { ok: true, code: r.code, playerId: p.id, token: p.token }); return afterAction(r); }
    let s = token && r.spectators.find((x) => x.token === token);
    if (!s && (r.game || watch)) {
      // the game has started (or they asked to watch): join as a spectator
      s = { id: newId(), token: newId(), name: cleanName(name) };
      r.spectators.push(s);
    }
    if (s) { attach(r, s, true); reply(cb, { ok: true, code: r.code, playerId: s.id, token: s.token, spectator: true }); return broadcast(r); }
    if (r.players.length >= 6) return reply(cb, { ok: false, error: 'Room is full (6 players max). Choose Watch to spectate.' });
    const free = COLORS.find((c) => !r.players.some((x) => x.color === c.hex));
    p = { id: newId(), token: newId(), name: cleanName(name), color: free.hex, colorName: free.name };
    r.players.push(p);
    attach(r, p);
    reply(cb, { ok: true, code: r.code, playerId: p.id, token: p.token });
    broadcast(r);
  });

  // status of saved games for the "Your games" list on the start screen
  socket.on('room:peek', async ({ games } = {}, cb) => {
    const out = [];
    for (const { code, token } of (Array.isArray(games) ? games : []).slice(0, 12)) {
      const c = String(code || '').toUpperCase();
      let r = rooms.get(c), entry = null;
      if (r) {
        const p = r.players.find((x) => x.token === token);
        entry = p && { code: c, phase: r.game ? r.game.phase : 'lobby', players: r.players.map((x) => x.name), turn: r.game ? r.game.turnNumber : 0 };
      } else if (store.enabled && /^[A-Z]{5}$/.test(c)) {
        try {
          const row = await store.peek(c);
          const players = row && Array.isArray(row.players) ? row.players : [];
          if (row && players.some((x) => x.token === token)) entry = { code: c, phase: row.phase || 'lobby', players: players.map((x) => x.name), saved: row.updated_at };
        } catch (e) { /* ignore */ }
      }
      if (entry) out.push(entry);
    }
    reply(cb, { ok: true, games: out });
  });

  socket.on('room:settings', (s = {}, cb) => {
    if (!isHost() || room.game) return reply(cb, { ok: false, error: 'Only the host can change settings' });
    const st = room.settings;
    if (['domination', 'missions', 'capitals'].includes(s.mode)) st.mode = s.mode;
    if (['random', 'draft'].includes(s.start)) st.start = s.start;
    if (['escalating', 'fixed'].includes(s.cards)) st.cards = s.cards;
    if (typeof s.fog === 'boolean') st.fog = s.fog;
    if ([0, 60, 90, 120, 180, 300].includes(Number(s.timer))) st.timer = Number(s.timer);
    if (BOT_SPEEDS[s.botSpeed]) st.botSpeed = s.botSpeed;
    reply(cb, { ok: true });
    broadcast(room);
  });

  // Bot speed can be changed by the host at any time, even mid-game.
  socket.on('room:botSpeed', ({ speed } = {}, cb) => {
    if (!isHost() || !BOT_SPEEDS[speed]) return reply(cb, { ok: false, error: 'Only the host can change bot speed' });
    room.settings.botSpeed = speed;
    reply(cb, { ok: true });
    broadcast(room);
  });

  socket.on('room:addBot', ({ level } = {}, cb) => {
    if (!isHost() || room.game) return reply(cb, { ok: false, error: 'Only the host can add bots' });
    if (!BOT_LEVELS[level]) return reply(cb, { ok: false, error: 'Unknown difficulty' });
    if (room.players.length >= 6) return reply(cb, { ok: false, error: 'Room is full (6 players max)' });
    const free = COLORS.find((c) => !room.players.some((x) => x.color === c.hex));
    const name = BOT_NAMES.find((n) => !room.players.some((x) => x.name === n)) || 'Bot';
    room.players.push({ id: newId(), token: null, name, color: free.hex, colorName: free.name, bot: level, connected: true, socketId: null });
    reply(cb, { ok: true });
    broadcast(room);
  });

  socket.on('room:removeBot', ({ id } = {}, cb) => {
    if (!isHost() || room.game) return reply(cb, { ok: false });
    room.players = room.players.filter((p) => !(p.id === id && p.bot));
    reply(cb, { ok: true });
    broadcast(room);
  });

  socket.on('room:color', ({ color } = {}, cb) => {
    if (!room || room.game || spectating) return reply(cb, { ok: false });
    const c = COLORS.find((x) => x.hex === color);
    if (!c || room.players.some((x) => x.color === c.hex && x.id !== me.id)) return reply(cb, { ok: false, error: 'Colour taken' });
    me.color = c.hex; me.colorName = c.name;
    reply(cb, { ok: true });
    broadcast(room);
  });

  socket.on('room:start', (_ = {}, cb) => {
    if (!isHost()) return reply(cb, { ok: false, error: 'Only the host can start' });
    if (room.game && room.game.phase !== 'over') return reply(cb, { ok: false, error: 'Game already running' });
    if (room.players.length < 2) return reply(cb, { ok: false, error: 'Need at least 2 players — invite a friend or add a bot' });
    room.game = new Game(room.players.map((p) => ({ id: p.id, name: p.name, color: p.color, colorName: p.colorName, bot: p.bot || null })), room.settings);
    reply(cb, { ok: true });
    afterAction(room);
  });

  socket.on('room:lobby', (_ = {}, cb) => {
    // host returns everyone to the lobby after a game ends (for a rematch)
    if (!isHost() || !room.game || room.game.phase !== 'over') return reply(cb, { ok: false });
    room.game = null;
    room.players = room.players.filter((p) => p.connected);
    clearTimeout(room.timerHandle); clearTimeout(room.botTimer);
    room.deadline = null;
    reply(cb, { ok: true });
    broadcast(room);
  });

  socket.on('room:leave', (_ = {}, cb) => {
    if (!room) return reply(cb, { ok: true });
    const r = room;
    if (spectating) r.spectators = r.spectators.filter((s) => s !== me);
    else if (!r.game) {
      r.players = r.players.filter((p) => p !== me);
      if (r.hostId === me.id) { const h = r.players.find((p) => !p.bot); r.hostId = h ? h.id : null; }
      if (!r.players.some((p) => !p.bot)) { rooms.delete(r.code); store.remove(r.code); }
    } else {
      me.connected = false; me.socketId = null;
    }
    socket.leave(r.code);
    room = null; me = null; spectating = false;
    reply(cb, { ok: true });
    if (rooms.has(r.code)) broadcast(r);
  });

  socket.on('game:action', ({ type, payload } = {}, cb) => {
    if (!room || !room.game || spectating) return reply(cb, { ok: false, error: 'No game running' });
    let res;
    try { res = runAction(room.game, me.id, type, payload, room); }
    catch (e) { console.error(e); res = { ok: false, error: 'Server error' }; }
    reply(cb, res);
    if (res.ok) afterAction(room);
  });

  socket.on('game:skip', (_ = {}, cb) => {
    // host can skip the turn of a player who is offline
    const g = room && room.game;
    if (!g || !isHost()) return reply(cb, { ok: false, error: 'Only the host can skip' });
    if (g.phase === 'playing') {
      const cur = room.players.find((p) => p.id === g.current.id);
      if (cur && cur.connected) return reply(cb, { ok: false, error: 'That player is online' });
    }
    g.autoPlayTurn();
    reply(cb, { ok: true });
    afterAction(room);
  });

  // ---------- diplomacy ----------
  socket.on('truce:propose', ({ to, rounds } = {}, cb) => {
    const g = room && room.game;
    if (!g || spectating) return reply(cb, { ok: false, error: 'No game running' });
    const res = g.proposeTruce(me.id, to, rounds);
    reply(cb, res);
    if (!res.ok) return;
    const target = room.players.find((p) => p.id === to);
    if (target && target.bot) {
      // bots keep their own counsel
      setTimeout(() => {
        const r2 = g.respondTruce(to, res.offer.id, false);
        if (r2.ok) { notice(room, me.id, `${target.name} declined your truce.`, 'truce'); afterAction(room); }
      }, 1500);
    } else {
      notice(room, to, `${me.name} offers you a truce for ${res.offer.rounds} round${res.offer.rounds > 1 ? 's' : ''}.`, 'truce');
    }
    afterAction(room);
  });

  socket.on('truce:respond', ({ id, accept } = {}, cb) => {
    const g = room && room.game;
    if (!g || spectating) return reply(cb, { ok: false });
    const res = g.respondTruce(me.id, id, !!accept);
    reply(cb, res);
    if (!res.ok) return;
    if (res.declined) notice(room, res.offer.from, `${me.name} declined your truce.`, 'truce');
    afterAction(room);
  });

  // Live cursors: relay where each player is pointing on the board (throttled), so others see moves brewing.
  let lastCursor = 0;
  socket.on('cursor', (c = {}) => {
    if (!room || !room.game || !me || spectating) return;
    const now = Date.now();
    if (now - lastCursor < 50) return;
    lastCursor = now;
    const ok = (v, max) => typeof v === 'number' && isFinite(v) && v >= 0 && v <= max;
    const out = { id: me.id };
    if (ok(c.x, 2000) && ok(c.y, 2000)) { out.x = Math.round(c.x * 10) / 10; out.y = Math.round(c.y * 10) / 10; }
    if (typeof c.tid === 'string' && room.game.territories[c.tid]) out.tid = c.tid;
    socket.to(room.code).emit('cursor', out);
  });

  // Emoji reactions dropped on the map, seen by everyone.
  let lastReact = 0;
  socket.on('react', ({ emoji, x, y } = {}) => {
    if (!room || !room.game || !me || !REACTIONS.includes(emoji)) return;
    const now = Date.now();
    if (now - lastReact < 700) return;
    lastReact = now;
    if (![x, y].every((v) => typeof v === 'number' && isFinite(v) && v >= 0 && v <= 2000)) return;
    io.to(room.code).emit('react', { id: me.id, name: me.name, color: me.color || '#cfd8d6', emoji, x, y });
  });

  // Table chat, or a private message to one player.
  socket.on('chat', ({ text, to } = {}) => {
    if (!room) return;
    const msg = String(text || '').replace(/[<>]/g, '').trim().slice(0, 200);
    if (!msg) return;
    const base = { from: me.name, fromId: me.id, color: me.color || '#cfd8d6', text: msg, t: Date.now(), watching: spectating };
    const target = to && !spectating && room.players.find((p) => p.id === to && p.id !== me.id);
    if (target) {
      const m = { ...base, private: true, to: target.id, toName: target.name };
      socket.emit('chat', m);
      if (target.socketId) io.to(target.socketId).emit('chat', m);
    } else io.to(room.code).emit('chat', base);
  });

  socket.on('disconnect', () => {
    if (!room || !me || me.socketId !== socket.id) return;
    const r = room;
    if (spectating) { r.spectators = r.spectators.filter((s) => s !== me); return broadcast(r); }
    me.connected = false;
    me.socketId = null;
    if (!r.game) {
      // in the lobby, drop players who don't come back within 30s
      setTimeout(() => {
        if (me.connected || r.game) return;
        r.players = r.players.filter((p) => p !== me);
        if (r.hostId === me.id) { const h = r.players.find((p) => !p.bot && p.connected); r.hostId = h ? h.id : null; }
        if (!r.players.some((p) => !p.bot)) { rooms.delete(r.code); store.remove(r.code); } else broadcast(r);
      }, 30000);
    } else if (r.hostId === me.id) {
      const other = r.players.find((p) => p.connected && !p.bot);
      if (other) r.hostId = other.id;
    }
    broadcast(r);
  });
});

// free memory from idle rooms (they stay in the database when saving is on)
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (now - r.lastActivity > ROOM_IDLE_MS && !r.players.some((p) => p.connected && !p.bot) && !r.spectators.length) {
      clearTimeout(r.timerHandle); clearTimeout(r.botTimer);
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

store.init()
  .catch((e) => console.error('[store] could not connect, saved games are off:', e.message))
  .finally(() => server.listen(PORT, () => console.log(`Conquista running on http://localhost:${PORT}`)));
module.exports = { server };
