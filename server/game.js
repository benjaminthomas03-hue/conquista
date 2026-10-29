// Conquista game engine. Pure rules, no networking. The server is authoritative:
// every action is validated here and returns { ok: true } or { ok: false, error }.
const crypto = require('crypto');
const MAP = require('../shared/map');
const { dealMissions, missionComplete, ownsContinent, shuffle } = require('./missions');

const START_ARMIES = { 2: 40, 3: 35, 4: 30, 5: 25, 6: 20 };
const SYMBOLS = ['infantry', 'cavalry', 'artillery'];
const TRADE_VALUES = [4, 6, 8, 10, 12, 15];

const defaultRng = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;
const fail = (error) => ({ ok: false, error });
const OK = { ok: true };

class Game {
  constructor(players, options = {}) {
    if (players.length < 2 || players.length > 6) throw new Error('Need 2-6 players');
    this.rng = options.rng || defaultRng;
    this.gameId = crypto.randomBytes(4).toString('hex'); // lets clients tell a fresh game from a resumed one
    this.mode = options.mode === 'missions' ? 'missions' : 'domination';
    this.players = players.map((p) => ({
      id: p.id, name: p.name, color: p.color, colorName: p.colorName || p.color,
      alive: true, cards: [], mission: null, eliminatedBy: null,
    }));
    this.phase = 'setup';
    this.step = null;
    this.turnIndex = 0;
    this.turnNumber = 0;
    this.reinforcements = 0;
    this.conqueredThisTurn = false;
    this.pendingMove = null;
    this.returnToAttack = false;
    this.lastBattle = null;
    this.tradeCount = 0;
    this.winner = null;
    this.log = [];
    this.events = []; // recent board events (placements, battles, moves) for client animations
    this.eventSeq = 0;
    this.territories = {};

    // Turn order is random.
    this.players = shuffle(this.players, this.rng);

    // Deal territories round-robin from a shuffled list.
    const ids = shuffle(Object.keys(MAP.territories), this.rng);
    ids.forEach((tid, i) => {
      this.territories[tid] = { owner: this.players[i % this.players.length].id, armies: 1 };
    });

    // Remaining starting armies are placed simultaneously during setup.
    const start = START_ARMIES[this.players.length];
    this.setupRemaining = {};
    for (const p of this.players) this.setupRemaining[p.id] = start - this.ownedIds(p.id).length;

    // Card deck: one per territory plus two wilds.
    const terrIds = Object.keys(MAP.territories);
    this.deck = shuffle(
      terrIds.map((t, i) => ({ id: t, territory: t, symbol: SYMBOLS[i % 3] }))
        .concat([{ id: 'wild1', territory: null, symbol: 'wild' }, { id: 'wild2', territory: null, symbol: 'wild' }]),
      this.rng
    );
    this.discard = [];

    if (this.mode === 'missions') {
      const missions = dealMissions(this.players, this.rng);
      for (const p of this.players) p.mission = missions[p.id];
    }
    this.addLog(`Game started (${this.mode === 'missions' ? 'Secret missions' : 'World domination'}). Place your starting armies.`);
  }

  // ---------- helpers ----------
  player(pid) { return this.players.find((p) => p.id === pid); }
  get current() { return this.players[this.turnIndex]; }
  ownedIds(pid) { return Object.keys(this.territories).filter((t) => this.territories[t].owner === pid); }
  name(pid) { const p = this.player(pid); return p ? p.name : '?'; }
  tname(tid) { return MAP.territories[tid].name; }
  addEvent(e) {
    e.seq = ++this.eventSeq;
    this.events.push(e);
    if (this.events.length > 40) this.events.shift();
  }
  addLog(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 150) this.log.shift();
  }
  roll(n) {
    const d = [];
    for (let i = 0; i < n; i++) d.push(1 + Math.floor(this.rng() * 6));
    return d.sort((a, b) => b - a);
  }
  nextTradeValue() {
    return this.tradeCount < TRADE_VALUES.length ? TRADE_VALUES[this.tradeCount] : 15 + 5 * (this.tradeCount - 5);
  }
  computeReinforcements(pid) {
    const owned = this.ownedIds(pid).length;
    let n = Math.max(3, Math.floor(owned / 3));
    for (const [c, info] of Object.entries(MAP.CONTINENTS)) if (ownsContinent(this, pid, c)) n += info.bonus;
    return n;
  }
  requireTurn(pid) {
    if (this.phase !== 'playing') return 'The game is not in progress';
    if (this.current.id !== pid) return 'It is not your turn';
    return null;
  }

  // ---------- setup ----------
  placeSetup(pid, tid, n = 1) {
    if (this.phase !== 'setup') return fail('Setup is over');
    const t = this.territories[tid];
    if (!t || t.owner !== pid) return fail('You can only place on your own territories');
    n = Math.floor(Number(n));
    if (!(n >= 1)) return fail('Invalid amount');
    n = Math.min(n, this.setupRemaining[pid]);
    if (n <= 0) return fail('You have no armies left to place');
    t.armies += n;
    this.setupRemaining[pid] -= n;
    this.addEvent({ type: 'place', tid, n, pid });
    if (Object.values(this.setupRemaining).every((v) => v === 0)) this.beginPlay();
    return OK;
  }

  beginPlay() {
    this.phase = 'playing';
    this.turnIndex = 0;
    this.addLog('All armies deployed. Let the conquest begin!');
    this.startTurn();
  }

  // Used when a turn timer runs out during setup: scatter remaining armies.
  autoCompleteSetup() {
    if (this.phase !== 'setup') return;
    for (const p of this.players) {
      const owned = this.ownedIds(p.id);
      while (this.setupRemaining[p.id] > 0) {
        this.territories[owned[Math.floor(this.rng() * owned.length)]].armies++;
        this.setupRemaining[p.id]--;
      }
    }
    this.beginPlay();
  }

  // ---------- turn flow ----------
  startTurn() {
    const p = this.current;
    this.turnNumber++;
    this.step = 'reinforce';
    this.conqueredThisTurn = false;
    this.pendingMove = null;
    this.returnToAttack = false;
    this.lastBattle = null;
    this.reinforcements = this.computeReinforcements(p.id);
    this.addLog(`${p.name}'s turn: ${this.reinforcements} reinforcements.`);
  }

  place(pid, tid, n = 1) {
    const e = this.requireTurn(pid); if (e) return fail(e);
    if (this.step !== 'reinforce') return fail('You can only place armies in the reinforce step');
    if (this.current.cards.length >= 5) return fail('You hold 5 or more cards — trade in a set first');
    const t = this.territories[tid];
    if (!t || t.owner !== pid) return fail('Pick one of your own territories');
    n = Math.floor(Number(n));
    if (!(n >= 1)) return fail('Invalid amount');
    n = Math.min(n, this.reinforcements);
    if (n <= 0) return fail('No reinforcements left');
    t.armies += n;
    this.reinforcements -= n;
    this.addEvent({ type: 'place', tid, n, pid });
    if (this.reinforcements === 0) {
      this.step = 'attack'; // also resumes attacking after a forced mid-turn trade
      this.returnToAttack = false;
    }
    return OK;
  }

  static isValidSet(cards) {
    if (cards.length !== 3) return false;
    const syms = cards.map((c) => c.symbol);
    const wilds = syms.filter((s) => s === 'wild').length;
    if (wilds >= 1) return true;
    const uniq = new Set(syms).size;
    return uniq === 1 || uniq === 3;
  }

  trade(pid, cardIds) {
    const e = this.requireTurn(pid); if (e) return fail(e);
    if (this.step !== 'reinforce') return fail('You can only trade cards in the reinforce step');
    if (!Array.isArray(cardIds) || new Set(cardIds).size !== 3) return fail('Select exactly 3 cards');
    const p = this.current;
    const cards = cardIds.map((id) => p.cards.find((c) => c.id === id));
    if (cards.some((c) => !c)) return fail('You do not hold those cards');
    if (!Game.isValidSet(cards)) return fail('Not a valid set: need 3 alike, 3 different, or a wild');
    const value = this.nextTradeValue();
    this.tradeCount++;
    this.reinforcements += value;
    p.cards = p.cards.filter((c) => !cardIds.includes(c.id));
    this.discard.push(...cards);
    // +2 bonus armies on one traded territory you own
    const bonus = cards.find((c) => c.territory && this.territories[c.territory].owner === pid);
    let msg = `${p.name} traded cards for ${value} armies`;
    if (bonus) {
      this.territories[bonus.territory].armies += 2;
      this.addEvent({ type: 'place', tid: bonus.territory, n: 2, pid });
      msg += ` (+2 on ${this.tname(bonus.territory)})`;
    }
    this.addLog(msg + '.');
    return OK;
  }

  findSet(cards) {
    for (let i = 0; i < cards.length; i++)
      for (let j = i + 1; j < cards.length; j++)
        for (let k = j + 1; k < cards.length; k++)
          if (Game.isValidSet([cards[i], cards[j], cards[k]])) return [cards[i].id, cards[j].id, cards[k].id];
    return null;
  }

  attack(pid, from, to, dice = 3, blitz = false) {
    const e = this.requireTurn(pid); if (e) return fail(e);
    if (this.step !== 'attack') return fail('You are not in the attack step');
    if (this.pendingMove) return fail('Move armies into your conquered territory first');
    const a = this.territories[from], d = this.territories[to];
    if (!a || !d) return fail('Unknown territory');
    if (a.owner !== pid) return fail('Attack from your own territory');
    if (d.owner === pid) return fail('You cannot attack yourself');
    if (!MAP.territories[from].neighbors.includes(to)) return fail('Those territories are not adjacent');
    if (a.armies < 2) return fail('You need at least 2 armies to attack');
    const defenderId = d.owner;

    let totalAttLoss = 0, totalDefLoss = 0, rounds = 0, attDice, defDice, usedDice;
    do {
      usedDice = Math.max(1, Math.min(blitz ? 3 : Math.floor(Number(dice)) || 3, 3, a.armies - 1));
      attDice = this.roll(usedDice);
      defDice = this.roll(Math.min(2, d.armies));
      for (let i = 0; i < Math.min(attDice.length, defDice.length); i++) {
        if (attDice[i] > defDice[i]) { d.armies--; totalDefLoss++; } else { a.armies--; totalAttLoss++; }
      }
      rounds++;
    } while (blitz && d.armies > 0 && a.armies >= 2);

    const conquered = d.armies === 0;
    this.lastBattle = {
      from, to, attacker: pid, defender: defenderId, attDice, defDice,
      attLoss: totalAttLoss, defLoss: totalDefLoss, rounds, conquered, t: Date.now(),
    };
    this.addEvent({ type: 'battle', from, to, attacker: pid, defender: defenderId, attLoss: totalAttLoss, defLoss: totalDefLoss, rounds, conquered: d.armies === 0 });
    if (blitz) this.addLog(`${this.name(pid)} blitzed ${this.tname(to)} from ${this.tname(from)}: lost ${totalAttLoss}, killed ${totalDefLoss}.`);

    if (conquered) {
      d.owner = pid;
      d.armies = 0;
      this.conqueredThisTurn = true;
      this.addLog(`${this.name(pid)} conquered ${this.tname(to)} from ${this.name(defenderId)}.`);
      const min = usedDice, max = a.armies - 1;
      this.pendingMove = { from, to, min: Math.min(min, max), max };
      if (this.pendingMove.min >= this.pendingMove.max) this.moveAfterConquest(pid, this.pendingMove.max);
      this.checkElimination(defenderId, pid);
    }
    this.checkWin(pid);
    return OK;
  }

  moveAfterConquest(pid, n) {
    const e = this.requireTurn(pid); if (e) return fail(e);
    const pm = this.pendingMove;
    if (!pm) return fail('Nothing to move');
    n = Math.floor(Number(n));
    if (!(n >= pm.min && n <= pm.max)) return fail(`Move between ${pm.min} and ${pm.max} armies`);
    this.territories[pm.from].armies -= n;
    this.territories[pm.to].armies += n;
    this.addEvent({ type: 'move', from: pm.from, to: pm.to, n, pid });
    this.pendingMove = null;
    return OK;
  }

  checkElimination(defenderId, attackerId) {
    if (this.ownedIds(defenderId).length > 0) return;
    const def = this.player(defenderId), att = this.player(attackerId);
    def.alive = false;
    def.eliminatedBy = attackerId;
    this.addLog(`${def.name} has been eliminated by ${att.name}!`);
    if (def.cards.length) {
      att.cards.push(...def.cards);
      this.addLog(`${att.name} takes ${def.cards.length} card(s) from ${def.name}.`);
      def.cards = [];
    }
    // Missions targeting the eliminated player fall back to 24 territories if someone else did it.
    if (this.phase === 'playing' && att.cards.length >= 6 && !this.isOverAfter(attackerId)) {
      this.step = 'reinforce';
      this.returnToAttack = true;
      this.reinforcements = 0;
      this.addLog(`${att.name} holds ${att.cards.length} cards and must trade before continuing.`);
    }
  }

  isOverAfter(pid) {
    return this.players.filter((p) => p.alive).length <= 1 ||
      (this.mode === 'missions' && missionComplete(this, pid));
  }

  // Ends the reinforce step only for the forced-trade-after-elimination case.
  finishForcedTrade(pid) {
    const e = this.requireTurn(pid); if (e) return fail(e);
    if (!(this.step === 'reinforce' && this.returnToAttack)) return fail('Nothing to finish');
    if (this.current.cards.length >= 5) return fail('Trade until you hold fewer than 5 cards');
    if (this.reinforcements > 0) return fail('Place your armies first');
    this.step = 'attack';
    this.returnToAttack = false;
    return OK;
  }

  endAttack(pid) {
    const e = this.requireTurn(pid); if (e) return fail(e);
    if (this.step !== 'attack') return fail('You are not in the attack step');
    if (this.pendingMove) return fail('Move armies into your conquered territory first');
    this.step = 'fortify';
    return OK;
  }

  connected(pid, from, to) {
    const seen = new Set([from]), q = [from];
    while (q.length) {
      const cur = q.shift();
      if (cur === to) return true;
      for (const n of MAP.territories[cur].neighbors) {
        if (!seen.has(n) && this.territories[n].owner === pid) { seen.add(n); q.push(n); }
      }
    }
    return false;
  }

  fortify(pid, from, to, n) {
    const e = this.requireTurn(pid); if (e) return fail(e);
    if (this.step === 'attack' && !this.pendingMove) this.step = 'fortify';
    if (this.step !== 'fortify') return fail('You are not in the fortify step');
    const a = this.territories[from], b = this.territories[to];
    if (!a || !b || a.owner !== pid || b.owner !== pid) return fail('Both territories must be yours');
    if (from === to) return fail('Pick two different territories');
    if (!this.connected(pid, from, to)) return fail('Those territories are not connected through your land');
    n = Math.floor(Number(n));
    if (!(n >= 1 && n <= a.armies - 1)) return fail(`Move between 1 and ${a.armies - 1} armies`);
    a.armies -= n;
    b.armies += n;
    this.addEvent({ type: 'move', from, to, n, pid });
    this.addLog(`${this.name(pid)} fortified ${this.tname(to)} with ${n} from ${this.tname(from)}.`);
    this.checkWin(pid);
    if (this.phase === 'playing') this.endTurn(pid);
    return OK;
  }

  endTurn(pid) {
    const e = this.requireTurn(pid); if (e) return fail(e);
    if (this.step === 'reinforce') return fail('Place all reinforcements first');
    if (this.pendingMove) return fail('Move armies into your conquered territory first');
    const p = this.current;
    if (this.conqueredThisTurn) this.drawCard(p);
    this.checkWin(pid);
    if (this.phase !== 'playing') return OK;
    do { this.turnIndex = (this.turnIndex + 1) % this.players.length; } while (!this.current.alive);
    this.startTurn();
    return OK;
  }

  drawCard(p) {
    if (!this.deck.length) { this.deck = shuffle(this.discard, this.rng); this.discard = []; }
    const c = this.deck.pop();
    if (c) p.cards.push(c);
  }

  checkWin(pid) {
    if (this.phase === 'over') return true;
    const alive = this.players.filter((p) => p.alive);
    let winner = null;
    if (alive.length === 1) winner = alive[0];
    else if (this.mode === 'missions' && pid && missionComplete(this, pid)) winner = this.player(pid);
    else if (this.mode === 'domination' && pid && this.ownedIds(pid).length === 42) winner = this.player(pid);
    if (winner) {
      this.phase = 'over';
      this.winner = winner.id;
      if (this.pendingMove) {
        const pm = this.pendingMove;
        this.territories[pm.from].armies -= pm.max;
        this.territories[pm.to].armies += pm.max;
        this.pendingMove = null;
      }
      this.addLog(`🏆 ${winner.name} wins${winner.mission ? ': ' + winner.mission.text : ' by conquering the world'}!`);
      return true;
    }
    return false;
  }

  // Called when the turn timer expires (or the host skips an absent player).
  autoPlayTurn() {
    if (this.phase === 'setup') return this.autoCompleteSetup();
    if (this.phase !== 'playing') return;
    const p = this.current;
    if (this.pendingMove) this.moveAfterConquest(p.id, this.pendingMove.min);
    if (this.step === 'reinforce') {
      while (p.cards.length >= 5) {
        const set = this.findSet(p.cards);
        if (!set) break;
        this.trade(p.id, set);
      }
      const owned = this.ownedIds(p.id), added = {};
      while (this.reinforcements > 0) {
        const t = owned[Math.floor(this.rng() * owned.length)];
        this.territories[t].armies++;
        added[t] = (added[t] || 0) + 1;
        this.reinforcements--;
      }
      for (const [tid, n] of Object.entries(added)) this.addEvent({ type: 'place', tid, n, pid: p.id });
      this.returnToAttack = false;
      this.step = 'attack';
    }
    this.addLog(`${p.name}'s turn ended automatically.`);
    this.endTurn(p.id);
  }

  removePlayer(pid) {
    // A player who leaves for good: their territories stay, they just get skipped (auto-turns).
    const p = this.player(pid);
    if (p) p.left = true;
  }

  // ---------- views ----------
  viewFor(pid) {
    const over = this.phase === 'over';
    return {
      mode: this.mode,
      phase: this.phase,
      step: this.step,
      turnNumber: this.turnNumber,
      currentPlayer: this.phase === 'playing' ? this.current.id : null,
      reinforcements: this.reinforcements,
      setupRemaining: this.setupRemaining,
      pendingMove: this.pendingMove,
      returnToAttack: this.returnToAttack,
      lastBattle: this.lastBattle,
      nextTradeValue: this.nextTradeValue(),
      winner: this.winner,
      territories: this.territories,
      log: this.log.slice(-60),
      events: this.events.slice(-20),
      gameId: this.gameId,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, colorName: p.colorName, alive: p.alive,
        cardCount: p.cards.length,
        territoryCount: this.ownedIds(p.id).length,
        armyCount: this.ownedIds(p.id).reduce((s, t) => s + this.territories[t].armies, 0),
        income: p.alive ? this.computeReinforcements(p.id) : 0,
        cards: p.id === pid ? p.cards : undefined,
        mission: (p.id === pid || over) && p.mission ? p.mission.text : undefined,
      })),
    };
  }
}

module.exports = { Game, START_ARMIES };
