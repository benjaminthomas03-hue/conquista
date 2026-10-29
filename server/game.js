// Conquista game engine. Pure rules, no networking. The server is authoritative:
// every action is validated here and returns { ok: true } or { ok: false, error }.
//
// Phases: draft (optional) -> capitals (capitals mode only) -> setup -> playing -> over
const crypto = require('crypto');
const MAP = require('../shared/map');
const ODDS = require('../shared/odds');
const { dealMissions, missionComplete, ownsContinent, shuffle } = require('./missions');

const START_ARMIES = { 2: 40, 3: 35, 4: 30, 5: 25, 6: 20 };
const SYMBOLS = ['infantry', 'cavalry', 'artillery'];
const TRADE_VALUES = [4, 6, 8, 10, 12, 15];
const FIXED_VALUES = { infantry: 4, cavalry: 6, artillery: 8, mixed: 10 };
const TERR_IDS = Object.keys(MAP.territories);

const defaultRng = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;
const fail = (error) => ({ ok: false, error });
const OK = { ok: true };
const MODE_NAMES = { domination: 'World domination', missions: 'Secret missions', capitals: 'Capitals' };

class Game {
  // players: [{ id, name, color, colorName, bot? }]
  // options: { mode: 'domination'|'missions'|'capitals', start: 'random'|'draft', cards: 'escalating'|'fixed', fog: bool, rng }
  constructor(players, options = {}) {
    if (players.length < 2 || players.length > 6) throw new Error('Need 2-6 players');
    this.rng = options.rng || defaultRng;
    this.gameId = crypto.randomBytes(4).toString('hex'); // lets clients tell a fresh game from a resumed one
    this.settings = {
      mode: MODE_NAMES[options.mode] ? options.mode : 'domination',
      start: options.start === 'draft' ? 'draft' : 'random',
      cards: options.cards === 'fixed' ? 'fixed' : 'escalating',
      fog: !!options.fog,
    };
    this.mode = this.settings.mode;
    this.players = players.map((p) => ({
      id: p.id, name: p.name, color: p.color, colorName: p.colorName || p.color, bot: p.bot || null,
      alive: true, cards: [], mission: null, eliminatedBy: null, betrayals: 0,
    }));
    this.step = null;
    this.turnIndex = 0;
    this.turnNumber = 0;
    this.reinforcements = 0;
    this.conqueredThisTurn = false;
    this.attacksThisTurn = 0;
    this.pendingMove = null;
    this.returnToAttack = false;
    this.lastBattle = null;
    this.tradeCount = 0;
    this.winner = null;
    this.log = [];
    this.events = []; // recent board events (placements, battles, moves) for client animations
    this.eventSeq = 0;
    this.territories = {};
    this.capitals = {};        // capitals mode: playerId -> territoryId
    this.truces = [];          // { a, b, until } — breakable, public
    this.truceOffers = [];     // { id, from, to, rounds, t } — private to the two players
    this.placeHistory = [];    // undo stack for this turn's reinforcements: [{ tid, n }]
    this.setupHistory = {};    // undo stacks during setup, per player
    this.pickCount = 0;        // draft picks made (also used as a timer key)
    this.stats = { biggestBattle: null, perPlayer: {} };
    this.history = [];         // per-turn snapshots for the end-of-game recap / replay

    // Turn order is random.
    this.players = shuffle(this.players, this.rng);
    for (const p of this.players) this.stats.perPlayer[p.id] = { conquests: 0, kills: 0, losses: 0, luck: 0 };

    // Card deck: one per territory plus two wilds.
    this.deck = shuffle(
      TERR_IDS.map((t, i) => ({ id: t, territory: t, symbol: SYMBOLS[i % 3] }))
        .concat([{ id: 'wild1', territory: null, symbol: 'wild' }, { id: 'wild2', territory: null, symbol: 'wild' }]),
      this.rng
    );
    this.discard = [];

    if (this.mode === 'missions') {
      const missions = dealMissions(this.players, this.rng);
      for (const p of this.players) p.mission = missions[p.id];
    }

    const extras = [this.settings.start === 'draft' && 'draft start', this.settings.cards === 'fixed' && 'fixed card values', this.settings.fog && 'fog of war']
      .filter(Boolean);
    this.addLog(`Game started: ${MODE_NAMES[this.mode]}${extras.length ? ' with ' + extras.join(', ') : ''}.`);

    if (this.settings.start === 'draft') {
      for (const t of TERR_IDS) this.territories[t] = { owner: null, armies: 0 };
      this.phase = 'draft';
      this.turnIndex = 0;
      this.addLog(`Draft: take turns claiming territories. ${this.players[0].name} picks first.`);
    } else {
      // Deal territories round-robin from a freshly shuffled list.
      shuffle(TERR_IDS, this.rng).forEach((tid, i) => {
        this.territories[tid] = { owner: this.players[i % this.players.length].id, armies: 1 };
      });
      this.afterTerritoriesAssigned();
    }
  }

  // ---------- persistence ----------
  toJSON() {
    const o = {};
    for (const [k, v] of Object.entries(this)) if (k !== 'rng') o[k] = v;
    return o;
  }
  static fromJSON(o) {
    const g = Object.assign(Object.create(Game.prototype), o);
    g.rng = defaultRng;
    return g;
  }

  // ---------- helpers ----------
  player(pid) { return this.players.find((p) => p.id === pid); }
  get current() { return this.players[this.turnIndex]; }
  ownedIds(pid) { return TERR_IDS.filter((t) => this.territories[t].owner === pid); }
  name(pid) { const p = this.player(pid); return p ? p.name : '?'; }
  tname(tid) { return MAP.territories[tid].name; }
  timerKey() { return this.phase === 'draft' ? 'draft:' + this.pickCount : this.phase + ':' + this.turnNumber; }
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
  static setValue(cards) {
    const syms = cards.map((c) => c.symbol).filter((s) => s !== 'wild');
    if (syms.length === 3 && new Set(syms).size === 1) return FIXED_VALUES[syms[0]];
    if (syms.length === 2 && syms[0] === syms[1]) return FIXED_VALUES[syms[0]];
    return FIXED_VALUES.mixed;
  }
  nextTradeValue() {
    if (this.settings.cards === 'fixed') return null; // depends on the set
    return this.tradeCount < TRADE_VALUES.length ? TRADE_VALUES[this.tradeCount] : 15 + 5 * (this.tradeCount - 5);
  }
  tradeValue(cards) {
    return this.settings.cards === 'fixed' ? Game.setValue(cards) : this.nextTradeValue();
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
  truceBetween(a, b) { return this.truces.find((t) => (t.a === a && t.b === b) || (t.a === b && t.b === a)); }

  // ---------- draft ----------
  draftPick(pid, tid) {
    if (this.phase !== 'draft') return fail('The draft is over');
    if (this.current.id !== pid) return fail('It is not your pick');
    const t = this.territories[tid];
    if (!t) return fail('Unknown territory');
    if (t.owner) return fail('That territory is already taken');
    t.owner = pid; t.armies = 1;
    this.pickCount++;
    this.addEvent({ type: 'place', tid, n: 1, pid });
    if (TERR_IDS.every((x) => this.territories[x].owner)) {
      this.addLog('Draft complete.');
      this.turnIndex = 0;
      this.afterTerritoriesAssigned();
    } else {
      this.turnIndex = (this.turnIndex + 1) % this.players.length;
    }
    return OK;
  }

  afterTerritoriesAssigned() {
    const start = START_ARMIES[this.players.length];
    this.setupRemaining = {};
    for (const p of this.players) {
      this.setupRemaining[p.id] = Math.max(0, start - this.ownedIds(p.id).length);
      this.setupHistory[p.id] = [];
    }
    if (this.mode === 'capitals') {
      this.phase = 'capitals';
      this.addLog('Everyone chooses a capital: one of your territories. Hold every capital to win.');
    } else {
      this.phase = 'setup';
      this.addLog('Place your starting armies.');
    }
  }

  // ---------- capitals ----------
  chooseCapital(pid, tid) {
    if (this.phase !== 'capitals') return fail('Capitals have already been chosen');
    const t = this.territories[tid];
    if (!t || t.owner !== pid) return fail('Choose one of your own territories');
    if (this.capitals[pid]) return fail('You already chose a capital');
    this.capitals[pid] = tid;
    if (this.players.every((p) => this.capitals[p.id])) {
      this.phase = 'setup';
      this.addLog('Capitals chosen: ' + this.players.map((p) => `${p.name} in ${this.tname(this.capitals[p.id])}`).join(', ') + '. Place your starting armies.');
    }
    return OK;
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
    this.setupHistory[pid].push({ tid, n });
    this.addEvent({ type: 'place', tid, n, pid });
    if (Object.values(this.setupRemaining).every((v) => v === 0)) this.beginPlay();
    return OK;
  }

  beginPlay() {
    this.phase = 'playing';
    this.turnIndex = 0;
    this.setupHistory = {};
    this.addLog('All armies deployed. Let the conquest begin!');
    this.startTurn();
  }

  // ---------- undo ----------
  canUndo(pid) {
    if (this.phase === 'setup') return !!(this.setupHistory[pid] && this.setupHistory[pid].length);
    if (this.phase !== 'playing' || this.current.id !== pid || this.pendingMove) return false;
    if (this.step === 'reinforce') return this.placeHistory.length > 0;
    return this.step === 'attack' && this.attacksThisTurn === 0 && this.placeHistory.length > 0 && !this.returnToAttack;
  }
  undoPlace(pid) {
    if (!this.canUndo(pid)) return fail('Nothing to undo');
    const stack = this.phase === 'setup' ? this.setupHistory[pid] : this.placeHistory;
    const last = stack.pop();
    this.territories[last.tid].armies -= last.n;
    if (this.phase === 'setup') this.setupRemaining[pid] += last.n;
    else { this.reinforcements += last.n; this.step = 'reinforce'; }
    this.addEvent({ type: 'place', tid: last.tid, n: -last.n, pid });
    return OK;
  }

  // Used when a timer runs out before play starts: finish the current pre-game step automatically.
  autoCompleteSetup() {
    if (this.phase === 'draft') {
      const free = TERR_IDS.filter((t) => !this.territories[t].owner);
      return this.draftPick(this.current.id, free[Math.floor(this.rng() * free.length)]);
    }
    if (this.phase === 'capitals') {
      for (const p of this.players) {
        if (this.capitals[p.id]) continue;
        const owned = this.ownedIds(p.id);
        this.chooseCapital(p.id, owned[Math.floor(this.rng() * owned.length)]);
      }
      return;
    }
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
    this.attacksThisTurn = 0;
    this.pendingMove = null;
    this.returnToAttack = false;
    this.lastBattle = null;
    this.placeHistory = [];
    // truces that have run their course
    for (const t of this.truces.filter((x) => this.turnNumber >= x.until)) {
      this.addLog(`The truce between ${this.name(t.a)} and ${this.name(t.b)} has ended.`);
    }
    this.truces = this.truces.filter((x) => this.turnNumber < x.until);
    this.reinforcements = this.computeReinforcements(p.id);
    this.snapshot();
    this.addLog(`${p.name}'s turn: ${this.reinforcements} reinforcements.`);
  }

  snapshot() {
    const idx = Object.fromEntries(this.players.map((p, i) => [p.id, i]));
    this.history.push({
      turn: this.turnNumber,
      owners: TERR_IDS.map((t) => idx[this.territories[t].owner]),
      armies: TERR_IDS.map((t) => this.territories[t].armies),
    });
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
    this.placeHistory.push({ tid, n });
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
    const value = this.tradeValue(cards);
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
    let best = null, bestVal = -1;
    for (let i = 0; i < cards.length; i++)
      for (let j = i + 1; j < cards.length; j++)
        for (let k = j + 1; k < cards.length; k++) {
          const set = [cards[i], cards[j], cards[k]];
          if (!Game.isValidSet(set)) continue;
          const v = this.settings && this.settings.cards === 'fixed' ? Game.setValue(set) : 0;
          if (v > bestVal) { bestVal = v; best = set.map((c) => c.id); }
        }
    return best;
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

    // Breaking a truce is allowed, but everyone hears about it.
    const truce = this.truceBetween(pid, defenderId);
    if (truce) {
      this.truces = this.truces.filter((t) => t !== truce);
      this.player(pid).betrayals++;
      this.addLog(`⚠ ${this.name(pid)} broke their truce with ${this.name(defenderId)}!`);
      this.addEvent({ type: 'betrayal', attacker: pid, defender: defenderId });
    }

    const sa = this.stats.perPlayer[pid], sd = this.stats.perPlayer[defenderId];
    let totalAttLoss = 0, totalDefLoss = 0, rounds = 0, attDice, defDice, usedDice;
    do {
      usedDice = Math.max(1, Math.min(blitz ? 3 : Math.floor(Number(dice)) || 3, 3, a.armies - 1));
      attDice = this.roll(usedDice);
      defDice = this.roll(Math.min(2, d.armies));
      const exp = ODDS.expectedLosses(attDice.length, defDice.length);
      let al = 0, dl = 0;
      for (let i = 0; i < Math.min(attDice.length, defDice.length); i++) {
        if (attDice[i] > defDice[i]) { d.armies--; dl++; } else { a.armies--; al++; }
      }
      totalAttLoss += al; totalDefLoss += dl;
      // luck = kills above expectation (attacker) and losses avoided (defender)
      sa.luck += dl - exp.def; sd.luck += exp.def - dl;
      rounds++;
    } while (blitz && d.armies > 0 && a.armies >= 2);
    this.attacksThisTurn++;
    sa.kills += totalDefLoss; sa.losses += totalAttLoss;
    sd.kills += totalAttLoss; sd.losses += totalDefLoss;

    const conquered = d.armies === 0;
    const size = totalAttLoss + totalDefLoss;
    if (!this.stats.biggestBattle || size > this.stats.biggestBattle.size) {
      this.stats.biggestBattle = { size, attacker: pid, defender: defenderId, to, turn: this.turnNumber, attLoss: totalAttLoss, defLoss: totalDefLoss };
    }
    this.lastBattle = {
      from, to, attacker: pid, defender: defenderId, attDice, defDice,
      attLoss: totalAttLoss, defLoss: totalDefLoss, rounds, conquered, t: Date.now(),
    };
    this.addEvent({ type: 'battle', from, to, attacker: pid, defender: defenderId, attLoss: totalAttLoss, defLoss: totalDefLoss, rounds, conquered });
    if (blitz) this.addLog(`${this.name(pid)} blitzed ${this.tname(to)} from ${this.tname(from)}: lost ${totalAttLoss}, killed ${totalDefLoss}.`);

    if (conquered) {
      d.owner = pid;
      d.armies = 0;
      this.conqueredThisTurn = true;
      sa.conquests++;
      const capOf = Object.keys(this.capitals).find((k) => this.capitals[k] === to);
      this.addLog(`${this.name(pid)} conquered ${this.tname(to)} from ${this.name(defenderId)}${capOf ? ` — ${this.name(capOf)}'s capital!` : ''}.`);
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
    this.truces = this.truces.filter((t) => t.a !== defenderId && t.b !== defenderId);
    this.truceOffers = this.truceOffers.filter((o) => o.from !== defenderId && o.to !== defenderId);
    this.addLog(`${def.name} has been eliminated by ${att.name}!`);
    if (def.cards.length) {
      att.cards.push(...def.cards);
      this.addLog(`${att.name} takes ${def.cards.length} card(s) from ${def.name}.`);
      def.cards = [];
    }
    if (this.phase === 'playing' && att.cards.length >= 6 && !this.isOverAfter(attackerId)) {
      this.step = 'reinforce';
      this.returnToAttack = true;
      this.reinforcements = 0;
      this.placeHistory = [];
      this.addLog(`${att.name} holds ${att.cards.length} cards and must trade before continuing.`);
    }
  }

  holdsAllCapitals(pid) {
    const caps = Object.values(this.capitals);
    return caps.length > 0 && caps.every((t) => this.territories[t].owner === pid);
  }

  isOverAfter(pid) {
    return this.players.filter((p) => p.alive).length <= 1 ||
      (this.mode === 'missions' && missionComplete(this, pid)) ||
      (this.mode === 'capitals' && this.holdsAllCapitals(pid));
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
    let winner = null, how = '';
    if (alive.length === 1) { winner = alive[0]; how = 'as the last commander standing'; }
    else if (this.mode === 'missions' && pid && missionComplete(this, pid)) { winner = this.player(pid); how = ': ' + winner.mission.text; }
    else if (this.mode === 'domination' && pid && this.ownedIds(pid).length === 42) { winner = this.player(pid); how = 'by conquering the world'; }
    else if (this.mode === 'capitals' && pid && this.holdsAllCapitals(pid)) { winner = this.player(pid); how = 'by holding every capital'; }
    if (winner) {
      this.phase = 'over';
      this.winner = winner.id;
      if (this.pendingMove) {
        const pm = this.pendingMove;
        this.territories[pm.from].armies -= pm.max;
        this.territories[pm.to].armies += pm.max;
        this.pendingMove = null;
      }
      this.snapshot();
      this.addLog(`🏆 ${winner.name} wins ${how}!`.replace(' :', ':'));
      return true;
    }
    return false;
  }

  // Called when the turn timer expires (or the host skips an absent player).
  autoPlayTurn() {
    if (this.phase === 'draft' || this.phase === 'capitals' || this.phase === 'setup') return this.autoCompleteSetup();
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

  // ---------- diplomacy (breakable truces) ----------
  proposeTruce(from, to, rounds) {
    if (this.phase !== 'playing') return fail('Truces can only be agreed during play');
    const a = this.player(from), b = this.player(to);
    if (!a || !b || !a.alive || !b.alive || from === to) return fail('Pick another commander who is still in the game');
    if (this.truceBetween(from, to)) return fail(`You already have a truce with ${b.name}`);
    if (this.truceOffers.some((o) => (o.from === from && o.to === to) || (o.from === to && o.to === from))) return fail('An offer between you two is already waiting for an answer');
    rounds = Math.max(1, Math.min(5, Math.floor(Number(rounds)) || 2));
    const offer = { id: crypto.randomBytes(4).toString('hex'), from, to, rounds, t: Date.now() };
    this.truceOffers.push(offer);
    return { ok: true, offer };
  }
  respondTruce(pid, offerId, accept) {
    const o = this.truceOffers.find((x) => x.id === offerId);
    if (!o || o.to !== pid) return fail('That offer is no longer open');
    this.truceOffers = this.truceOffers.filter((x) => x !== o);
    if (!accept) return { ok: true, declined: true, offer: o };
    const alive = this.players.filter((p) => p.alive).length;
    this.truces.push({ a: o.from, b: o.to, until: this.turnNumber + o.rounds * alive, rounds: o.rounds });
    this.addLog(`🤝 ${this.name(o.from)} and ${this.name(o.to)} agreed a truce for ${o.rounds} round${o.rounds > 1 ? 's' : ''}.`);
    return { ok: true, offer: o };
  }

  // ---------- views ----------
  // Fog of war: you only see troop counts on your own territories and their neighbours.
  visibleSet(pid) {
    if (!this.settings.fog || this.phase === 'over' || this.phase === 'draft' || this.phase === 'capitals') return null; // everything visible
    const vis = new Set();
    for (const t of TERR_IDS) {
      if (this.territories[t].owner !== pid) continue;
      vis.add(t);
      for (const n of MAP.territories[t].neighbors) vis.add(n);
    }
    return vis;
  }

  viewFor(pid) {
    const over = this.phase === 'over';
    const vis = this.visibleSet(pid);
    const territories = {};
    for (const t of TERR_IDS) {
      const s = this.territories[t];
      territories[t] = !vis || vis.has(t) ? s : { owner: s.owner, armies: null };
    }
    const hide = (p) => vis && p.id !== pid;
    const events = this.events.slice(-20).filter((e) => !vis
      || (e.type === 'place' && vis.has(e.tid)) || (e.type === 'move' && vis.has(e.to))
      || e.type === 'battle' || e.type === 'betrayal')
      .map((e) => (vis && e.type === 'battle' ? { ...e, attLoss: vis.has(e.from) ? e.attLoss : 0, defLoss: vis.has(e.to) ? e.defLoss : 0 } : e));
    const alive = this.players.filter((p) => p.alive).length;
    return {
      mode: this.mode,
      settings: this.settings,
      phase: this.phase,
      step: this.step,
      turnNumber: this.turnNumber,
      currentPlayer: this.phase === 'playing' || this.phase === 'draft' ? this.current.id : null,
      reinforcements: this.reinforcements,
      setupRemaining: this.setupRemaining,
      pendingMove: this.pendingMove,
      returnToAttack: this.returnToAttack,
      lastBattle: vis && this.lastBattle && !(vis.has(this.lastBattle.from) || vis.has(this.lastBattle.to)) ? null : this.lastBattle,
      nextTradeValue: this.nextTradeValue(),
      canUndo: pid ? this.canUndo(pid) : false,
      winner: this.winner,
      territories,
      fogged: !!vis,
      // capitals stay secret until everyone has chosen
      capitals: this.phase === 'capitals' ? (this.capitals[pid] ? { [pid]: this.capitals[pid] } : {}) : this.capitals,
      truces: this.truces.map((t) => ({ a: t.a, b: t.b, roundsLeft: Math.max(1, Math.ceil((t.until - this.turnNumber) / Math.max(1, alive))) })),
      truceOffers: this.truceOffers.filter((o) => o.from === pid || o.to === pid),
      log: this.log.slice(-60),
      events,
      gameId: this.gameId,
      recap: over ? { history: this.history, stats: this.stats, territoryOrder: TERR_IDS } : undefined,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, colorName: p.colorName, alive: p.alive, bot: p.bot,
        betrayals: p.betrayals,
        cardCount: p.cards.length,
        territoryCount: this.ownedIds(p.id).length,
        armyCount: hide(p) ? null : this.ownedIds(p.id).reduce((s, t) => s + this.territories[t].armies, 0),
        income: hide(p) || !p.alive || this.phase !== 'playing' ? null : this.computeReinforcements(p.id),
        capitalChosen: !!this.capitals[p.id],
        cards: p.id === pid ? p.cards : undefined,
        mission: (p.id === pid || over) && p.mission ? p.mission.text : undefined,
      })),
    };
  }
}

module.exports = { Game, START_ARMIES, TERR_IDS };
