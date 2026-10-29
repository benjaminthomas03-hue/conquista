// Saved games. When DATABASE_URL is set (e.g. a Supabase Postgres connection string), every room
// is saved shortly after each change and reloaded on demand, so games survive server restarts and
// can be resumed another day. Without DATABASE_URL this is a no-op and games live in memory only.
const KEEP_DAYS = 21;

function serializeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    settings: room.settings,
    lastActivity: room.lastActivity,
    players: room.players.map(({ id, token, name, color, colorName, bot }) => ({ id, token, name, color, colorName, bot: bot || null })),
    game: room.game ? room.game.toJSON() : null,
  };
}

class NoStore {
  get enabled() { return false; }
  async init() {}
  save() {}
  async load() { return null; }
  async remove() {}
  async peek() { return null; }
}

class PgStore {
  constructor(url) {
    const { Pool } = require('pg');
    const local = /localhost|127\.0\.0\.1/.test(url);
    this.pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 3 });
    this.pool.on('error', (e) => console.error('[store] pool error:', e.message));
    this.timers = new Map();
  }
  get enabled() { return !this.disabled; }
  async init() {
    try {
      await this.pool.query(`create table if not exists conquista_rooms (
      code text primary key, data jsonb not null, updated_at timestamptz not null default now())`);
      const r = await this.pool.query(`delete from conquista_rooms where updated_at < now() - interval '${KEEP_DAYS} days'`);
      console.log(`[store] saved games enabled (removed ${r.rowCount} old rooms)`);
    } catch (e) {
      this.disabled = true; // keep the game running without saving rather than failing
      throw e;
    }
  }
  // Batched: many quick actions become one write, but every change is written within ~1s
  // even during non-stop activity (the pending write always saves the room's latest state).
  save(room) {
    if (this.disabled || this.timers.has(room.code)) return;
    this.timers.set(room.code, setTimeout(() => {
      this.timers.delete(room.code);
      const data = JSON.stringify(serializeRoom(room));
      this.pool.query(
        `insert into conquista_rooms (code, data, updated_at) values ($1, $2, now())
         on conflict (code) do update set data = excluded.data, updated_at = now()`, [room.code, data],
      ).catch((e) => console.error('[store] save failed:', e.message));
    }, 1200));
  }
  async load(code) {
    const r = await this.pool.query('select data from conquista_rooms where code = $1', [code]);
    return r.rows[0] ? r.rows[0].data : null;
  }
  async peek(code) {
    const r = await this.pool.query(
      `select data->'game'->>'phase' as phase, data->'players' as players, updated_at from conquista_rooms where code = $1`, [code]);
    return r.rows[0] || null;
  }
  async remove(code) {
    clearTimeout(this.timers.get(code));
    this.timers.delete(code);
    await this.pool.query('delete from conquista_rooms where code = $1', [code]).catch(() => {});
  }
}

function createStore() {
  const url = process.env.DATABASE_URL;
  return url ? new PgStore(url) : new NoStore();
}

module.exports = { createStore };
