// Conquista multiplayer server: Express serves the client, Socket.IO runs rooms and relays game actions.
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const { Server } = require('socket.io');
const { Game } = require('./game');

const PORT = process.env.PORT || 3000;
const COLORS = [
  { name: 'Crimson', hex: '#d64545' },
  { name: 'Azure', hex: '#3b7ddd' },
  { name: 'Emerald', hex: '#2e9e62' },
  { name: 'Gold', hex: '#e2b42d' },
  { name: 'Violet', hex: '#8f5bd0' },
  { name: 'Tangerine', hex: '#e8792b' },
];
const SETUP_SECONDS_WITH_TIMER = 180;
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;

const app = express();
app.use(compression());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
app.get('/healthz', (_req, res) => res.send('ok'));
const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map();
const newId = () => crypto.randomBytes(8).toString('hex');
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 5 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(c));
  return c;
}
const cleanName = (s) => String(s || '').replace(/[<>]/g, '').trim().slice(0, 18) || 'Commander';

function lobbyView(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    settings: room.settings,
    started: !!room.game,
    colors: COLORS,
    deadline: room.deadline,
    players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color, colorName: p.colorName, connected: p.connected })),
  };
}

function broadcast(room) {
  room.lastActivity = Date.now();
  const lobby = lobbyView(room);
  for (const p of room.players) {
    if (!p.socketId) continue;
    io.to(p.socketId).emit('state', { you: p.id, room: lobby, game: room.game ? room.game.viewFor(p.id) : null });
  }
}

// ---------- turn timer ----------
function scheduleTimer(room) {
  clearTimeout(room.timerHandle);
  room.deadline = null;
  const g = room.game;
  if (!g || g.phase === 'over' || !room.settings.timer) return;
  const secs = g.phase === 'setup' ? SETUP_SECONDS_WITH_TIMER : room.settings.timer;
  room.timerKey = g.phase + ':' + g.turnNumber;
  room.deadline = Date.now() + secs * 1000;
  room.timerHandle = setTimeout(() => {
    if (!room.game || room.game !== g) return;
    g.autoPlayTurn();
    afterAction(room);
  }, secs * 1000);
}
function afterAction(room) {
  const g = room.game;
  const key = g ? g.phase + ':' + g.turnNumber : null;
  if (key !== room.timerKey || (g && g.phase === 'over')) scheduleTimer(room);
  broadcast(room);
}

// ---------- action dispatch ----------
function runAction(g, pid, type, p = {}) {
  switch (type) {
    case 'placeSetup': return g.placeSetup(pid, p.territory, p.count);
    case 'place': return g.place(pid, p.territory, p.count);
    case 'trade': return g.trade(pid, p.cards);
    case 'finishTrade': return g.finishForcedTrade(pid);
    case 'attack': return g.attack(pid, p.from, p.to, p.dice, !!p.blitz);
    case 'move': return g.moveAfterConquest(pid, p.count);
    case 'endAttack': return g.endAttack(pid);
    case 'fortify': return g.fortify(pid, p.from, p.to, p.count);
    case 'endTurn': return g.endTurn(pid);
    default: return { ok: false, error: 'Unknown action' };
  }
}

io.on('connection', (socket) => {
  let room = null, me = null;
  const reply = (cb, data) => typeof cb === 'function' && cb(data);

  function attach(r, p) {
    room = r; me = p;
    p.socketId = socket.id;
    p.connected = true;
    socket.join(r.code);
    // if the current host is offline, whoever comes back takes over hosting
    const host = r.players.find((x) => x.id === r.hostId);
    if (!host || !host.connected) r.hostId = p.id;
  }

  socket.on('room:create', ({ name } = {}, cb) => {
    const code = newCode();
    const r = { code, hostId: null, players: [], settings: { mode: 'domination', timer: 0 }, game: null, lastActivity: Date.now() };
    const p = { id: newId(), token: newId(), name: cleanName(name), color: COLORS[0].hex, colorName: COLORS[0].name };
    r.players.push(p);
    r.hostId = p.id;
    rooms.set(code, r);
    attach(r, p);
    reply(cb, { ok: true, code, playerId: p.id, token: p.token });
    broadcast(r);
  });

  socket.on('room:join', ({ code, name, token } = {}, cb) => {
    const r = rooms.get(String(code || '').toUpperCase().trim());
    if (!r) return reply(cb, { ok: false, error: 'Room not found — check the code' });
    let p = token && r.players.find((x) => x.token === token);
    if (!p) {
      if (r.game) return reply(cb, { ok: false, error: 'That game has already started' });
      if (r.players.length >= 6) return reply(cb, { ok: false, error: 'Room is full (6 players max)' });
      const free = COLORS.find((c) => !r.players.some((x) => x.color === c.hex));
      p = { id: newId(), token: newId(), name: cleanName(name), color: free.hex, colorName: free.name };
      r.players.push(p);
    }
    attach(r, p);
    reply(cb, { ok: true, code: r.code, playerId: p.id, token: p.token });
    broadcast(r);
  });

  socket.on('room:settings', (s = {}, cb) => {
    if (!room || room.hostId !== me.id || room.game) return reply(cb, { ok: false, error: 'Only the host can change settings' });
    if (s.mode === 'domination' || s.mode === 'missions') room.settings.mode = s.mode;
    if ([0, 60, 90, 120, 180, 300].includes(Number(s.timer))) room.settings.timer = Number(s.timer);
    reply(cb, { ok: true });
    broadcast(room);
  });

  socket.on('room:color', ({ color } = {}, cb) => {
    if (!room || room.game) return reply(cb, { ok: false });
    const c = COLORS.find((x) => x.hex === color);
    if (!c || room.players.some((x) => x.color === c.hex && x.id !== me.id)) return reply(cb, { ok: false, error: 'Colour taken' });
    me.color = c.hex; me.colorName = c.name;
    reply(cb, { ok: true });
    broadcast(room);
  });

  socket.on('room:rename', ({ name } = {}, cb) => {
    if (!room || room.game) return reply(cb, { ok: false });
    me.name = cleanName(name);
    reply(cb, { ok: true });
    broadcast(room);
  });

  socket.on('room:start', (_ = {}, cb) => {
    if (!room || room.hostId !== me.id) return reply(cb, { ok: false, error: 'Only the host can start' });
    if (room.game && room.game.phase !== 'over') return reply(cb, { ok: false, error: 'Game already running' });
    if (room.players.length < 2) return reply(cb, { ok: false, error: 'Need at least 2 players' });
    room.game = new Game(room.players, { mode: room.settings.mode });
    reply(cb, { ok: true });
    afterAction(room);
  });

  socket.on('room:lobby', (_ = {}, cb) => {
    // host returns everyone to the lobby after a game ends (for a rematch)
    if (!room || room.hostId !== me.id || !room.game || room.game.phase !== 'over') return reply(cb, { ok: false });
    room.game = null;
    room.players = room.players.filter((p) => p.connected);
    clearTimeout(room.timerHandle);
    room.deadline = null;
    reply(cb, { ok: true });
    broadcast(room);
  });

  socket.on('room:leave', (_ = {}, cb) => {
    if (!room) return reply(cb, { ok: true });
    if (!room.game) {
      room.players = room.players.filter((p) => p !== me);
      if (room.hostId === me.id && room.players[0]) room.hostId = room.players[0].id;
      if (!room.players.length) rooms.delete(room.code);
    } else {
      me.connected = false; me.socketId = null;
    }
    socket.leave(room.code);
    const r = room; room = null; me = null;
    reply(cb, { ok: true });
    if (rooms.has(r.code)) broadcast(r);
  });

  socket.on('game:action', ({ type, payload } = {}, cb) => {
    if (!room || !room.game) return reply(cb, { ok: false, error: 'No game running' });
    let res;
    try { res = runAction(room.game, me.id, type, payload); }
    catch (e) { console.error(e); res = { ok: false, error: 'Server error' }; }
    reply(cb, res);
    if (res.ok) afterAction(room);
  });

  socket.on('game:skip', (_ = {}, cb) => {
    // host can skip the turn of a player who is offline
    const g = room && room.game;
    if (!g || room.hostId !== me.id) return reply(cb, { ok: false, error: 'Only the host can skip' });
    if (g.phase === 'playing') {
      const cur = room.players.find((p) => p.id === g.current.id);
      if (cur && cur.connected) return reply(cb, { ok: false, error: 'That player is online' });
    }
    g.autoPlayTurn();
    reply(cb, { ok: true });
    afterAction(room);
  });

  socket.on('chat', ({ text } = {}) => {
    if (!room) return;
    const msg = String(text || '').replace(/[<>]/g, '').trim().slice(0, 200);
    if (msg) io.to(room.code).emit('chat', { from: me.name, color: me.color, text: msg, t: Date.now() });
  });

  socket.on('disconnect', () => {
    if (!room || !me || me.socketId !== socket.id) return;
    me.connected = false;
    me.socketId = null;
    const r = room;
    if (!r.game) {
      // in the lobby, drop players who don't come back within 30s
      setTimeout(() => {
        if (me.connected || r.game) return;
        r.players = r.players.filter((p) => p !== me);
        if (r.hostId === me.id && r.players[0]) r.hostId = r.players[0].id;
        if (!r.players.length) rooms.delete(r.code); else broadcast(r);
      }, 30000);
    } else if (r.hostId === me.id) {
      const other = r.players.find((p) => p.connected);
      if (other) r.hostId = other.id;
    }
    broadcast(r);
  });
});

// clean up idle rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (now - r.lastActivity > ROOM_IDLE_MS && !r.players.some((p) => p.connected)) {
      clearTimeout(r.timerHandle);
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`Conquista running on http://localhost:${PORT}`));
module.exports = { server };
