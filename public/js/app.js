// Conquista client: connects to the server, renders the start screen, lobby and game,
// and turns clicks into actions. Board drawing lives in board.js, sounds in sound.js, the recap in recap.js.
(function () {
  const MAP = window.CONQUISTA_MAP;
  const ODDS = window.CONQUISTA_ODDS;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const local = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  // Seats you hold in rooms, kept in this browser so you can resume another day.
  const seats = {
    all() { return local.get('cq:games', []); },
    get(code) { return this.all().find((g) => g.code === code); },
    put(entry) { local.set('cq:games', [entry, ...this.all().filter((g) => g.code !== entry.code)].slice(0, 12)); },
    drop(code) { local.set('cq:games', this.all().filter((g) => g.code !== code)); },
  };

  const S = {
    socket: io(),
    code: null, token: null, you: null, spectator: false,
    room: null, game: null, prevGame: null,
    chat: [],
    ui: { sel: null, target: null, amount: 1, dice: 3, cards: new Set(), names: local.get('cq:names2') === '1', focus: null,
      lastSeq: null, gameId: null, goDismissed: false, lastBattleT: 0, react: null, truceFor: null, recapShownFor: null },
  };

  // ---------- helpers ----------
  function toast(msg, info) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (info ? ' info' : '');
    t.hidden = false;
    clearTimeout(toast.h);
    toast.h = setTimeout(() => (t.hidden = true), 3200);
  }
  function emit(ev, data) {
    return new Promise((res) => S.socket.emit(ev, data, (r) => { if (r && !r.ok && r.error) toast(r.error); res(r || {}); }));
  }
  const act = (type, payload) => emit('game:action', { type, payload });
  const me = () => S.game && S.game.players.find((p) => p.id === S.you);
  const playerById = (id) => S.game && S.game.players.find((p) => p.id === id);
  const isMyTurn = () => !S.spectator && S.game && S.game.phase === 'playing' && S.game.currentPlayer === S.you;
  const T = (id) => S.game.territories[id];
  const owns = (id) => T(id).owner === S.you;
  const hasEnemyNeighbor = (id) => MAP.territories[id].neighbors.some((n) => !owns(n));
  const isHost = () => S.room && S.room.hostId === S.you && !S.spectator;
  function connectedSet(from) {
    const seen = new Set([from]), q = [from];
    while (q.length) {
      const c = q.shift();
      for (const n of MAP.territories[c].neighbors) if (!seen.has(n) && owns(n)) { seen.add(n); q.push(n); }
    }
    seen.delete(from);
    return seen;
  }
  const dot = (color) => `<span class="dot" style="background:${color}"></span>`;
  const pct = (p) => (p > 0.995 ? '>99%' : p < 0.005 ? '<1%' : Math.round(p * 100) + '%');
  const MODE_LABEL = { domination: 'World domination', missions: 'Secret missions', capitals: 'Capitals' };

  // ---------- joining ----------
  async function joinRoom(code, token, watch) {
    const r = await emit('room:join', { code, token, watch: !!watch, name: $('in-name').value });
    if (r.ok) { saveSession(r); if (token) S.resumed = true; }
    else if (token) seats.drop(code);
    return r;
  }
  function saveSession(r) {
    S.code = r.code; S.token = r.token; S.you = r.playerId; S.spectator = !!r.spectator;
    seats.put({ code: r.code, token: r.token, spectator: !!r.spectator, t: Date.now() });
    local.set('cq:name', $('in-name').value || '');
    const url = new URL(location.href);
    url.searchParams.set('room', r.code);
    history.replaceState(null, '', url);
  }
  function leaveToHome() {
    S.code = S.token = S.you = null; S.room = S.game = null; S.spectator = false; S.chat = [];
    history.replaceState(null, '', location.pathname);
    render();
    refreshMyGames();
  }

  $('in-name').value = local.get('cq:name', '') || '';
  const needName = () => { if ($('in-name').value.trim()) return false; $('in-name').focus(); toast('Enter your name first'); return true; };
  $('btn-create').onclick = async () => {
    if (needName()) return;
    const r = await emit('room:create', { name: $('in-name').value });
    if (r.ok) saveSession(r);
  };
  const codeInput = () => $('in-code').value.trim().toUpperCase();
  $('btn-join').onclick = () => { if (needName()) return; if (codeInput().length !== 5) return toast('Room codes are 5 letters'); joinRoom(codeInput()); };
  $('btn-watch').onclick = () => { if (needName()) return; if (codeInput().length !== 5) return toast('Room codes are 5 letters'); joinRoom(codeInput(), null, true); };
  $('in-code').addEventListener('keydown', (e) => e.key === 'Enter' && $('btn-join').click());
  $('in-name').addEventListener('keydown', (e) => e.key === 'Enter' && ($('in-code').value ? $('btn-join') : $('btn-create')).click());

  // "Your games": rooms this browser has a seat in, with their current status.
  async function refreshMyGames() {
    const mine = seats.all().filter((g) => !g.spectator);
    if (!mine.length) { $('my-games').hidden = true; return; }
    const r = await emit('room:peek', { games: mine.map(({ code, token }) => ({ code, token })) });
    const live = (r.games || []);
    for (const g of mine) if (!live.some((x) => x.code === g.code)) seats.drop(g.code);
    const label = { lobby: 'In the lobby', draft: 'Drafting', capitals: 'Choosing capitals', setup: 'Deploying', playing: 'In progress', over: 'Finished' };
    $('my-games').hidden = !live.length;
    $('my-games-list').innerHTML = live.map((g) => `<li><div><b>${g.code}</b> <span class="muted small">${label[g.phase] || g.phase}${g.turn ? ` · turn ${g.turn}` : ''}</span>
      <div class="muted small">${g.players.map(esc).join(', ')}</div></div>
      <button class="btn btn-sm" data-code="${g.code}">${g.phase === 'over' ? 'View' : 'Resume'}</button></li>`).join('');
    $('my-games-list').querySelectorAll('button').forEach((b) => (b.onclick = () => { const s = seats.get(b.dataset.code); if (s) joinRoom(s.code, s.token); }));
  }

  // Resume from the URL after refresh or reconnect.
  function tryResume() {
    const code = (S.code || new URL(location.href).searchParams.get('room') || '').toUpperCase();
    if (!code) { refreshMyGames(); return; }
    const saved = seats.get(code);
    if (saved && saved.token) joinRoom(code, saved.token);
    else { $('in-code').value = code; refreshMyGames(); }
  }
  S.socket.on('connect', tryResume);
  S.socket.on('disconnect', () => toast('Connection lost — reconnecting…'));

  // ---------- lobby ----------
  $('btn-copy').onclick = async () => {
    const url = location.origin + location.pathname + '?room=' + S.code;
    try { await navigator.clipboard.writeText(url); toast('Invite link copied', true); }
    catch { prompt('Copy this link', url); }
  };
  $('btn-leave').onclick = async () => { await emit('room:leave'); seats.drop(S.code); leaveToHome(); };
  $('btn-start').onclick = () => emit('room:start');
  $('btn-add-bot').onclick = () => emit('room:addBot', { level: $('sel-bot').value });
  const bindSeg = (id, key) => { $(id).onclick = (e) => { const b = e.target.closest('button'); if (b && !b.disabled) emit('room:settings', { [key]: b.dataset.v }); }; };
  bindSeg('seg-mode', 'mode'); bindSeg('seg-start', 'start'); bindSeg('seg-cards', 'cards'); bindSeg('seg-botspeed', 'botSpeed');
  $('sel-botspeed').onchange = (e) => emit('room:botSpeed', { speed: e.target.value });
  $('chk-fog').onchange = (e) => emit('room:settings', { fog: e.target.checked });
  $('sel-timer').onchange = (e) => emit('room:settings', { timer: Number(e.target.value) });

  function renderLobby() {
    const r = S.room, host = isHost();
    $('home-entry').hidden = true;
    $('lobby').hidden = false;
    $('lobby-code').textContent = r.code;
    $('lobby-players').innerHTML = r.players.map((p) =>
      `<li class="${p.connected ? '' : 'offline'}">${dot(p.color)}<span>${esc(p.name)}</span>
        <span class="tag">${p.bot ? `${S.room.botLevels[p.bot]} bot` : ''}${p.id === r.hostId ? 'Host' : ''}${p.id === S.you ? (p.id === r.hostId ? ' (you)' : 'You') : ''}</span>
        ${p.bot && host ? `<button class="btn btn-sm btn-ghost remove-bot" data-id="${p.id}" aria-label="Remove ${esc(p.name)}">Remove</button>` : ''}</li>`).join('')
      + r.spectators.map((s) => `<li class="spectator-row"><span class="dot hollow"></span><span>${esc(s.name)}</span><span class="tag">Watching</span></li>`).join('');
    $('lobby-players').querySelectorAll('.remove-bot').forEach((b) => (b.onclick = () => emit('room:removeBot', { id: b.dataset.id })));
    $('bot-row').hidden = !host || r.players.length >= 6;
    const mine = r.players.find((p) => p.id === S.you);
    $('color-swatches').parentElement.hidden = S.spectator;
    $('color-swatches').innerHTML = r.colors.map((c) => {
      const taken = r.players.some((p) => p.color === c.hex && p.id !== S.you);
      return `<button class="swatch ${mine && mine.color === c.hex ? 'on' : ''}" style="background:${c.hex}" title="${c.name}" data-c="${c.hex}" ${taken ? 'disabled' : ''}></button>`;
    }).join('');
    $('color-swatches').querySelectorAll('.swatch').forEach((b) => (b.onclick = () => emit('room:color', { color: b.dataset.c })));
    $('lobby-settings').disabled = !host;
    const st = r.settings;
    for (const [id, key] of [['seg-mode', 'mode'], ['seg-start', 'start'], ['seg-cards', 'cards'], ['seg-botspeed', 'botSpeed']]) {
      $(id).querySelectorAll('button').forEach((b) => { const on = b.dataset.v === st[key]; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    }
    $('hint-start').textContent = st.start === 'draft' ? 'Players take turns claiming territories' : 'Territories are dealt out at random';
    $('hint-cards').textContent = st.cards === 'fixed' ? 'Sets are worth 4, 6, 8 or 10' : 'Each set is worth more: 4, 6, 8, 10…';
    $('chk-fog').checked = !!st.fog;
    $('bot-speed-field').hidden = !r.players.some((p) => p.bot);
    $('sel-timer').value = String(st.timer);
    $('btn-start').hidden = !host;
    $('btn-start').disabled = r.players.length < 2;
    const humans = r.players.filter((p) => !p.bot).length;
    let hint = r.players.length < 2
      ? 'Share the invite link or add a bot — you need at least 2 players.'
      : host ? `${r.players.length} players ready (${humans} human${humans > 1 ? 's' : ''}). Start when everyone has joined.` : S.spectator ? 'You are watching. The game will appear when the host starts it.' : 'Waiting for the host to start the game.';
    if (r.saving) hint += ' Games are saved, so you can finish another day.';
    $('lobby-hint').textContent = hint;
  }

  // ---------- board interaction ----------
  function clearSel() { S.ui.sel = null; S.ui.target = null; }

  async function onTerritoryClick(id) {
    const g = S.game;
    if (!g || S.spectator || Recap.replaying) return;
    const u = S.ui;
    if (g.phase === 'draft') {
      if (g.currentPlayer !== S.you) return toast(`Waiting for ${playerById(g.currentPlayer).name} to pick`, true);
      if (T(id).owner) return toast('That territory is already taken', true);
      return act('draftPick', { territory: id });
    }
    if (g.phase === 'capitals') {
      if (g.capitals[S.you]) return;
      if (!owns(id)) return toast('Choose one of your own territories as your capital', true);
      return act('capital', { territory: id });
    }
    if (g.phase === 'setup') {
      if (!owns(id)) return;
      const left = g.setupRemaining[S.you];
      const n = u.amount === 'all' ? left : Math.min(u.amount, left);
      if (n > 0) act('placeSetup', { territory: id, count: n });
      return;
    }
    if (!isMyTurn()) return;
    if (g.step === 'reinforce') {
      if (!owns(id)) return;
      if (me().cards.length >= 5) return toast('Trade in a set of cards first');
      const n = u.amount === 'all' ? g.reinforcements : Math.min(u.amount, g.reinforcements);
      if (n > 0) act('place', { territory: id, count: n });
      return;
    }
    if (g.pendingMove) return;
    if (g.step === 'attack') {
      if (owns(id)) {
        if (u.sel === id) { clearSel(); }
        else if (T(id).armies >= 2 && hasEnemyNeighbor(id)) { u.sel = id; u.target = null; }
        else toast(T(id).armies < 2 ? 'You need at least 2 armies to attack from there' : 'No enemies next to that territory', true);
      } else if (u.sel && MAP.territories[u.sel].neighbors.includes(id)) {
        u.target = id;
      } else if (u.sel) toast('That territory is not next to your selection', true);
      renderGame();
      return;
    }
    if (g.step === 'fortify') {
      if (!owns(id)) return;
      if (u.sel && u.sel !== id && connectedSet(u.sel).has(id)) { u.target = id; }
      else if (u.sel === id) clearSel();
      else if (T(id).armies > 1) { u.sel = id; u.target = null; }
      else toast('Pick a territory with more than 1 army to move from', true);
      renderGame();
    }
  }

  const tip = $('tooltip');
  function onHover(id, e) {
    if (!id || !S.game) { tip.hidden = true; return; }
    const t = MAP.territories[id], s = T(id), p = playerById(s.owner);
    const capOf = S.game.capitals && Object.keys(S.game.capitals).find((k) => S.game.capitals[k] === id);
    const troops = !s.owner ? 'unclaimed' : s.armies == null ? 'troops hidden by fog' : `${s.armies} ${s.armies === 1 ? 'army' : 'armies'}`;
    tip.innerHTML = `<b>${esc(t.name)}</b> · ${troops}${p ? ' · ' + esc(p.name) : ''}<br><span class="muted">${MAP.CONTINENTS[t.continent].name}${capOf ? ` · ★ ${esc(playerById(capOf).name)}'s capital` : ''}</span>`;
    const box = $('screen-game').querySelector('.board-wrap').getBoundingClientRect();
    tip.style.left = Math.min(e.clientX - box.left + 14, box.width - 220) + 'px';
    tip.style.top = (e.clientY - box.top + 14) + 'px';
    tip.hidden = false;
  }

  // Your territories next to a bigger enemy stack (where you're vulnerable).
  function threatSet() {
    const g = S.game, out = new Set();
    if (!g || g.phase !== 'playing' || !me() || !me().alive) return out;
    for (const id of Object.keys(g.territories)) {
      if (!owns(id)) continue;
      const strongest = Math.max(0, ...MAP.territories[id].neighbors.filter((n) => !owns(n) && T(n).armies != null).map((n) => T(n).armies));
      if (strongest > T(id).armies) out.add(id);
    }
    return out;
  }

  function boardUi() {
    const g = S.game, u = S.ui;
    const clickable = new Set(), dim = new Set(), flash = new Set();
    const all = Object.keys(g.territories);
    if (S.spectator) { /* nothing clickable */ }
    else if (g.phase === 'draft') {
      if (g.currentPlayer === S.you) all.filter((t) => !T(t).owner).forEach((t) => clickable.add(t));
    } else if (g.phase === 'capitals') {
      if (!g.capitals[S.you]) all.filter(owns).forEach((t) => clickable.add(t));
    } else if (g.phase === 'setup') {
      if (g.setupRemaining[S.you] > 0) all.filter(owns).forEach((id) => clickable.add(id));
    } else if (isMyTurn() && !g.pendingMove) {
      if (g.step === 'reinforce') {
        if (g.reinforcements > 0 && me().cards.length < 5) all.filter(owns).forEach((id) => clickable.add(id));
      } else if (g.step === 'attack') {
        all.filter((id) => owns(id) && T(id).armies >= 2 && hasEnemyNeighbor(id)).forEach((id) => clickable.add(id));
        if (u.sel) {
          MAP.territories[u.sel].neighbors.filter((n) => !owns(n)).forEach((n) => clickable.add(n));
          all.forEach((id) => { if (!clickable.has(id)) dim.add(id); });
        }
      } else if (g.step === 'fortify') {
        all.filter((id) => owns(id) && T(id).armies > 1).forEach((id) => clickable.add(id));
        if (u.sel) {
          const c = connectedSet(u.sel);
          c.forEach((id) => clickable.add(id));
          all.forEach((id) => { if (!c.has(id) && id !== u.sel) dim.add(id); });
        }
      }
    }
    // flash territories that changed hands
    if (S.prevGame && S.prevGame.phase === 'playing') {
      for (const id of all) if (S.prevGame.territories[id] && S.prevGame.territories[id].owner !== g.territories[id].owner) flash.add(id);
    }
    return { clickable, dim, flash, sel: u.sel, target: u.target, threats: threatSet(), focus: u.focus };
  }

  // ---------- action panel ----------
  function amountSeg() {
    return `<div class="seg amount-seg" id="amt">${[1, 5, 'all'].map((a) =>
      `<button data-a="${a}" class="${S.ui.amount === a ? 'on' : ''}">${a === 'all' ? 'All' : '+' + a}</button>`).join('')}</div>`;
  }
  function bindAmount() {
    const seg = $('amt');
    if (seg) seg.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S.ui.amount = b.dataset.a === 'all' ? 'all' : Number(b.dataset.a); renderGame(); };
  }
  const rangeRow = (id, min, max, val, label) =>
    `<div class="range-row"><input type="range" id="${id}" min="${min}" max="${max}" value="${val}" aria-label="${label}"><output id="${id}-out">${val}</output></div>`;
  function bindRange(id) { const r = $(id); if (r) r.oninput = () => ($(id + '-out').textContent = r.value); }
  const undoBtn = () => (S.game.canUndo ? `<button class="btn btn-ghost btn-sm" id="btn-undo" title="Take back your last placement">Undo</button>` : '');

  // Odds for the selected attack: a full blitz, and the next single roll.
  function oddsHtml(a, d, dice) {
    const b = ODDS.blitz(a, d);
    const outcomes = ODDS.ROLL[dice][Math.min(2, d)];
    const parts = outcomes.map((o) => (o.def && o.att ? `${pct(o.p)} one each` : o.def ? `${pct(o.p)} they lose ${o.def}` : `${pct(o.p)} you lose ${o.att}`));
    return `<div class="odds">
      <div class="odds-main"><span class="odds-pct ${b.win >= 0.6 ? 'good' : b.win < 0.4 ? 'bad' : ''}">${pct(b.win)}</span>
      <span>chance to conquer if you blitz${b.win > 0.05 ? `, keeping about ${Math.max(1, Math.round(b.attLeft))} armies` : ''}</span></div>
      <div class="odds-roll muted small">This roll: ${parts.join(' · ')}</div></div>`;
  }

  function renderActionPanel() {
    const g = S.game, u = S.ui, P = $('action-panel'), mp = me();
    const curr = playerById(g.currentPlayer);
    let h = '';

    if (S.spectator) {
      h = `<h3>Watching</h3><p>${g.phase === 'playing' ? `${esc(curr.name)} is ${stepText(g.step, false).toLowerCase()}` : g.phase === 'over' ? `${esc(playerById(g.winner).name)} won.` : 'The players are getting set up.'}</p>`;
    } else if (g.phase === 'draft') {
      const left = Object.values(g.territories).filter((t) => !t.owner).length;
      h = g.currentPlayer === S.you
        ? `<h3>Your pick</h3><p>Click any unclaimed territory to claim it. ${left} left.</p>`
        : `<h3>Draft</h3><p>${esc(curr.name)} is picking. ${left} territories left.</p>`;
    } else if (g.phase === 'capitals') {
      const waiting = g.players.filter((p) => !p.capitalChosen).length;
      h = !g.capitals[S.you]
        ? `<h3>Choose your capital</h3><p>Click one of your territories. Hold every capital to win, so pick one you can defend. Others won't see it until everyone has chosen.</p>`
        : `<h3>Capital chosen</h3><p>${esc(MAP.territories[g.capitals[S.you]].name)}. Waiting for ${waiting} more.</p>`;
    } else if (g.phase === 'setup') {
      const left = g.setupRemaining[S.you];
      const waiting = g.players.filter((p) => g.setupRemaining[p.id] > 0).length;
      h = left > 0
        ? `<h3>Deploy your armies</h3><div class="big-num">${left}</div><p>Click your territories to place them. Everyone deploys at the same time.</p>${amountSeg()}<div class="row">${undoBtn()}</div>`
        : `<h3>Deployed</h3><p>Waiting for ${waiting} ${waiting === 1 ? 'player' : 'players'} to finish placing.</p><div class="row">${undoBtn()}</div>`;
    } else if (g.phase === 'over') {
      h = `<h3>Game over</h3><p>${esc(playerById(g.winner).name)} won.</p><div class="row"><button class="btn btn-sm" id="btn-show-recap">Show results</button></div>`;
    } else if (!isMyTurn()) {
      const lp = S.room.players.find((p) => p.id === g.currentPlayer);
      const offline = lp && !lp.connected;
      h = `<h3>${esc(curr.name)}'s turn</h3><p>${curr.bot ? 'Bot thinking… ' : ''}${stepText(g.step, false)}${offline ? ' They are offline.' : ''}</p>`;
      if (offline && isHost()) h += `<button class="btn btn-sm" id="btn-skip">Skip their turn</button>`;
    } else if (g.step === 'reinforce') {
      h = mp.cards.length >= 5
        ? `<h3>Trade in cards</h3><p>You hold ${mp.cards.length} cards. Select a set below and trade it before placing armies.</p>`
        : `<h3>Reinforce</h3><div class="big-num">${g.reinforcements}</div><p>Click your territories to place armies.</p>${amountSeg()}<div class="row">${undoBtn()}</div>`;
    } else if (g.pendingMove) {
      const pm = g.pendingMove;
      h = `<h3>Victory!</h3><p>Move armies from ${esc(MAP.territories[pm.from].name)} into ${esc(MAP.territories[pm.to].name)}.</p>
        ${rangeRow('mv', pm.min, pm.max, pm.max, 'Armies to move')}
        <div class="row"><button class="btn btn-brass" id="btn-move">Move armies</button></div>`;
    } else if (g.step === 'attack') {
      if (u.sel && u.target) {
        const a = T(u.sel), d = T(u.target), dp = playerById(d.owner);
        const maxDice = Math.min(3, a.armies - 1);
        u.dice = Math.min(u.dice, maxDice) || maxDice;
        const truce = g.truces.find((t) => (t.a === S.you && t.b === d.owner) || (t.b === S.you && t.a === d.owner));
        h = `<h3>Attack</h3>
          <div class="vs"><div class="side">${dot(mp.color)}<span>${esc(MAP.territories[u.sel].name)}</span><b>${a.armies}</b></div>
          <div class="side">${dot(dp.color)}<span>${esc(MAP.territories[u.target].name)}</span><b>${d.armies}</b></div></div>
          ${oddsHtml(a.armies, d.armies, u.dice)}
          ${truce ? `<p class="warn">You have a truce with ${esc(dp.name)}. Attacking breaks it, and everyone will know.</p>` : ''}
          <div class="seg" id="dice-seg">${[1, 2, 3].map((n) => `<button data-d="${n}" class="${u.dice === n ? 'on' : ''}" ${n > maxDice ? 'disabled' : ''}>${n} ${n === 1 ? 'die' : 'dice'}</button>`).join('')}</div>
          <div class="row"><button class="btn btn-brass" id="btn-attack">Roll</button><button class="btn" id="btn-blitz" title="Keep rolling until you win or run out of armies">Blitz</button></div>`;
      } else if (u.sel) {
        h = `<h3>Attack</h3><p>Pick an enemy territory next to ${esc(MAP.territories[u.sel].name)}.</p>`;
      } else {
        h = `<h3>Attack</h3><p>Pick one of your territories with 2 or more armies, then an enemy next to it.</p>`;
      }
      h += `<div class="row">${undoBtn()}<button class="btn btn-ghost" id="btn-endattack">End attacks</button></div>`;
    } else if (g.step === 'fortify') {
      if (u.sel && u.target) {
        const a = T(u.sel);
        h = `<h3>Fortify</h3><p>Move armies from ${esc(MAP.territories[u.sel].name)} to ${esc(MAP.territories[u.target].name)}. This ends your turn.</p>
          ${rangeRow('fv', 1, a.armies - 1, a.armies - 1, 'Armies to move')}
          <div class="row"><button class="btn btn-brass" id="btn-fortify">Fortify and end turn</button></div>`;
      } else {
        h = `<h3>Fortify</h3><p>Optionally move armies once between connected territories${u.sel ? `. Pick where to send them from ${esc(MAP.territories[u.sel].name)}.` : '.'}</p>`;
      }
      h += `<div class="row"><button class="btn ${u.sel && u.target ? 'btn-ghost' : 'btn-brass'}" id="btn-endturn">End turn</button></div>`;
    }
    P.innerHTML = h;

    bindAmount();
    bindRange('mv'); bindRange('fv');
    const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    on('btn-skip', () => emit('game:skip'));
    on('btn-undo', () => act('undo'));
    on('btn-move', () => act('move', { count: Number($('mv').value) }));
    on('btn-attack', () => act('attack', { from: u.sel, to: u.target, dice: u.dice }));
    on('btn-blitz', () => act('attack', { from: u.sel, to: u.target, blitz: true }));
    on('btn-endattack', () => { clearSel(); act('endAttack'); });
    on('btn-endturn', () => { clearSel(); act('endTurn'); });
    on('btn-fortify', async () => { const r = await act('fortify', { from: u.sel, to: u.target, count: Number($('fv').value) }); if (r.ok) clearSel(); });
    on('btn-show-recap', () => { S.ui.goDismissed = false; renderGameOver(); });
    const ds = $('dice-seg');
    if (ds) ds.onclick = (e) => { const b = e.target.closest('button'); if (b && !b.disabled) { u.dice = Number(b.dataset.d); renderGame(); } };
  }

  function stepText(step, mine) {
    return { reinforce: mine ? 'Place reinforcements' : 'Placing reinforcements.', attack: mine ? 'Attack' : 'Attacking.', fortify: mine ? 'Fortify' : 'Fortifying.' }[step] || '';
  }

  // ---------- diplomacy ----------
  function renderDiplomacy() {
    const g = S.game, P = $('diplo-panel');
    if (S.spectator || g.phase !== 'playing' || !me() || !me().alive) { P.hidden = true; return; }
    const offers = g.truceOffers || [];
    const incoming = offers.filter((o) => o.to === S.you), outgoing = offers.filter((o) => o.from === S.you);
    const mine = g.truces.filter((t) => t.a === S.you || t.b === S.you);
    const proposing = S.ui.truceFor && playerById(S.ui.truceFor);
    if (!incoming.length && !outgoing.length && !mine.length && !proposing) { P.hidden = true; return; }
    let h = '<h2 class="rail-title">Diplomacy</h2>';
    for (const o of incoming) {
      const p = playerById(o.from);
      h += `<div class="offer">${dot(p.color)}<span><b>${esc(p.name)}</b> offers a truce for ${o.rounds} round${o.rounds > 1 ? 's' : ''}.</span>
        <div class="row"><button class="btn btn-sm btn-brass" data-accept="${o.id}">Accept</button><button class="btn btn-sm btn-ghost" data-decline="${o.id}">Decline</button></div></div>`;
    }
    for (const o of outgoing) h += `<div class="offer muted small">Waiting for ${esc(playerById(o.to).name)} to answer your truce offer…</div>`;
    for (const t of mine) {
      const other = playerById(t.a === S.you ? t.b : t.a);
      h += `<div class="offer small">${dot(other.color)}<span>Truce with <b>${esc(other.name)}</b>: ${t.roundsLeft} round${t.roundsLeft > 1 ? 's' : ''} left. Breaking it is allowed, but it's announced to everyone.</span></div>`;
    }
    if (proposing) {
      h += `<div class="offer propose"><span>Offer <b>${esc(proposing.name)}</b> a truce for</span>
        <select id="truce-rounds">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${n === 2 ? 'selected' : ''}>${n} round${n > 1 ? 's' : ''}</option>`).join('')}</select>
        <div class="row"><button class="btn btn-sm btn-brass" id="truce-send">Send offer</button><button class="btn btn-sm btn-ghost" id="truce-cancel">Cancel</button></div></div>`;
    }
    P.innerHTML = h;
    P.hidden = false;
    P.querySelectorAll('[data-accept]').forEach((b) => (b.onclick = () => emit('truce:respond', { id: b.dataset.accept, accept: true })));
    P.querySelectorAll('[data-decline]').forEach((b) => (b.onclick = () => emit('truce:respond', { id: b.dataset.decline, accept: false })));
    if ($('truce-send')) $('truce-send').onclick = async () => {
      const r = await emit('truce:propose', { to: S.ui.truceFor, rounds: Number($('truce-rounds').value) });
      if (r.ok) { toast('Truce offer sent', true); S.ui.truceFor = null; renderDiplomacy(); }
    };
    if ($('truce-cancel')) $('truce-cancel').onclick = () => { S.ui.truceFor = null; renderDiplomacy(); };
  }

  // ---------- other panels ----------
  function renderDice() {
    const b = S.game.lastBattle, P = $('dice-panel');
    if (!b || S.game.phase !== 'playing') { P.hidden = true; return; }
    const fresh = b.t !== S.ui.lastBattleT;
    S.ui.lastBattleT = b.t;
    const ac = playerById(b.attacker).color, dc = playerById(b.defender).color;
    const pairs = Math.min(b.attDice.length, b.defDice.length);
    const die = (v, i, att) => {
      let cls = '';
      if (i < pairs) { const won = att ? v > b.defDice[i] : v >= b.attDice[i]; cls = won ? 'won' : 'lost'; }
      return `<div class="die ${cls} ${fresh ? 'fresh' : ''}" style="background:${att ? ac : dc}">${v}</div>`;
    };
    P.innerHTML = `
      <div class="dice-row"><span class="lbl">${esc(playerById(b.attacker).name)}</span>${b.attDice.map((v, i) => die(v, i, true)).join('')}</div>
      <div class="dice-row"><span class="lbl">${esc(playerById(b.defender).name)}</span>${b.defDice.map((v, i) => die(v, i, false)).join('')}</div>
      <div class="dice-sum">${b.rounds > 1 ? `Blitz, ${b.rounds} rolls. ` : ''}${esc(MAP.territories[b.from].name)} lost ${b.attLoss}, ${esc(MAP.territories[b.to].name)} lost ${b.defLoss}.${b.conquered ? ' Conquered!' : ''}</div>`;
    P.hidden = false;
  }

  const ICONS = {
    infantry: '<path d="M4 15 L12 9 L20 15" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/>',
    cavalry: '<path d="M4 12 L12 6 L20 12 M4 19 L12 13 L20 19" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/>',
    artillery: '<path d="M12 3 L14.6 9.2 L21 9.6 L16 13.8 L17.6 20.4 L12 16.8 L6.4 20.4 L8 13.8 L3 9.6 L9.4 9.2 Z" fill="currentColor"/>',
    wild: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 5 L13.6 10.4 L19 12 L13.6 13.6 L12 19 L10.4 13.6 L5 12 L10.4 10.4 Z" fill="currentColor"/>',
  };
  const FIXED = { infantry: 4, cavalry: 6, artillery: 8 };
  function selectedSetValue(cards) {
    if (cards.length !== 3) return null;
    const syms = cards.map((c) => c.symbol).filter((s) => s !== 'wild');
    if (syms.length === 3 && new Set(syms).size === 2) return null; // not a valid set
    if (S.game.settings.cards !== 'fixed') return S.game.nextTradeValue;
    if (syms.length >= 2 && new Set(syms).size === 1) return FIXED[syms[0]];
    return 10;
  }
  function renderHand() {
    const mp = me(), g = S.game;
    $('cards-panel').hidden = S.spectator;
    if (S.spectator) return;
    const cards = (mp && mp.cards) || [];
    for (const id of [...S.ui.cards]) if (!cards.some((c) => c.id === id)) S.ui.cards.delete(id);
    $('hand').innerHTML = cards.length ? cards.map((c) => {
      const t = c.territory && MAP.territories[c.territory];
      const owned = c.territory && g.territories[c.territory].owner === S.you;
      return `<button class="card ${S.ui.cards.has(c.id) ? 'on' : ''} ${owned ? 'owned' : ''}" data-id="${c.id}" title="${c.symbol}${owned ? ' — you own this territory (+2 when traded)' : ''}">
        <svg viewBox="0 0 24 24">${ICONS[c.symbol]}</svg><span class="cn">${t ? esc(t.name) : 'Wild'}</span></button>`;
    }).join('') : '<span class="empty">Conquer a territory on your turn to earn a card.</span>';
    $('hand').querySelectorAll('.card').forEach((b) => (b.onclick = () => {
      const id = b.dataset.id;
      if (S.ui.cards.has(id)) S.ui.cards.delete(id); else if (S.ui.cards.size < 3) S.ui.cards.add(id);
      renderHand();
    }));
    const sel = cards.filter((c) => S.ui.cards.has(c.id));
    const val = selectedSetValue(sel);
    $('trade-value').textContent = g.settings.cards === 'fixed' ? 'Fixed: 4 / 6 / 8 / mixed 10' : `Next set: ${g.nextTradeValue} armies`;
    const canTrade = isMyTurn() && g.step === 'reinforce' && val != null;
    $('btn-trade').disabled = !canTrade;
    $('btn-trade').textContent = val != null ? `Trade in set for ${val}` : 'Trade in set';
    $('btn-trade').hidden = !cards.length;
  }
  $('btn-trade').onclick = async () => {
    const r = await act('trade', { cards: [...S.ui.cards] });
    if (r.ok) S.ui.cards.clear();
  };

  function renderPlayers() {
    const g = S.game;
    const alive = g.players.filter((p) => p.alive);
    if (g.fogged) {
      // with fog of war, only territory counts are public
      const total = alive.reduce((a, p) => a + p.territoryCount, 0) || 1;
      $('power').innerHTML = `<h2 class="rail-title">Balance of power</h2>
        <div class="power-bar" role="img" aria-label="Share of territories by player">${alive.map((p) =>
          `<span style="flex-grow:${p.territoryCount};background:${p.color}" title="${esc(p.name)}: ${p.territoryCount} territories"></span>`).join('')}</div>
        <div class="power-legend"><span>Share of territories</span><span>troops hidden by fog</span></div>`;
      void total;
    } else {
      const totalArmies = alive.reduce((a, p) => a + (p.armyCount || 0), 0) || 1;
      $('power').innerHTML = `<h2 class="rail-title">Balance of power</h2>
        <div class="power-bar" role="img" aria-label="Share of armies by player">${alive.map((p) =>
          `<span style="flex-grow:${p.armyCount};background:${p.color}" title="${esc(p.name)}: ${p.armyCount} armies (${Math.round(100 * p.armyCount / totalArmies)}%)"></span>`).join('')}</div>
        <div class="power-legend"><span>Share of all armies</span><span>${totalArmies} total</span></div>`;
    }
    const threats = threatSet();
    $('threat-note').hidden = !threats.size;
    $('threat-note').innerHTML = `<span class="ring"></span><span>${threats.size} of your territories face a bigger enemy stack next door</span>`;
    const canDiplo = !S.spectator && g.phase === 'playing' && me() && me().alive;
    $('player-list').innerHTML = g.players.map((p) => {
      const lp = S.room.players.find((x) => x.id === p.id);
      const cls = [p.id === g.currentPlayer ? 'current' : '', p.alive ? '' : 'dead', lp && !lp.connected ? 'offline' : ''].join(' ');
      const truce = g.truces.find((t) => t.a === p.id || t.b === p.id);
      const tags = [
        p.id === S.you ? '<span class="you">you</span>' : '',
        p.bot ? `<span class="you">${p.bot} bot</span>` : '',
        lp && !lp.connected ? '<span class="you">offline</span>' : '',
        p.betrayals ? `<span class="betray" title="Broke ${p.betrayals} truce${p.betrayals > 1 ? 's' : ''}">🗡 ${p.betrayals}</span>` : '',
      ].join('');
      const truceLine = g.truces.filter((t) => t.a === p.id || t.b === p.id).map((t) => {
        const o = playerById(t.a === p.id ? t.b : t.a);
        return `<span class="truce-tag" title="Truce, ${t.roundsLeft} round(s) left">🤝 ${esc(o.name)}</span>`;
      }).join('');
      const stats = p.alive
        ? `<span><b>${p.territoryCount}</b> lands</span><span><b>${p.armyCount == null ? '?' : p.armyCount}</b> armies</span><span><b>${p.cardCount}</b> cards</span>`
        : '<span>Eliminated</span>';
      const offerBtn = canDiplo && p.alive && p.id !== S.you && !p.bot && !g.truces.some((t) => (t.a === S.you && t.b === p.id) || (t.b === S.you && t.a === p.id))
        ? `<button class="btn btn-sm btn-ghost truce-btn" data-pid="${p.id}" title="Offer ${esc(p.name)} a truce">Truce</button>` : '';
      void truce;
      return `<li class="${cls}" data-pid="${p.id}"><div class="pname">${dot(p.color)}<span class="pn">${esc(p.name)}</span>${tags}${offerBtn}</div>
        <div class="stats">${stats}</div>${truceLine ? `<div class="truces">${truceLine}</div>` : ''}</li>`;
    }).join('');
    $('player-list').querySelectorAll('li').forEach((li) => {
      li.onmouseenter = () => { S.ui.focus = li.dataset.pid; Board.update(S.game, S.game.players, boardUi()); };
      li.onmouseleave = () => { S.ui.focus = null; Board.update(S.game, S.game.players, boardUi()); };
    });
    $('player-list').querySelectorAll('.truce-btn').forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      S.ui.truceFor = b.dataset.pid; renderDiplomacy();
    }));
    const mp = me();
    $('mission-box').hidden = !(mp && mp.mission);
    if (mp && mp.mission) $('mission-text').textContent = mp.mission;
    // capitals mode: who holds which capital
    const caps = g.capitals || {};
    const showCaps = g.mode === 'capitals' && Object.keys(caps).length && g.phase !== 'capitals';
    $('capitals-box').hidden = !showCaps;
    if (showCaps) {
      const counts = g.players.map((p) => ({ p, n: Object.values(caps).filter((t) => g.territories[t].owner === p.id).length })).filter((x) => x.n);
      $('capitals-box').innerHTML = `<div class="mission-label">Capitals: hold all ${Object.keys(caps).length} to win</div>
        <ul class="caps">${g.players.filter((p) => caps[p.id]).map((p) => {
          const holder = playerById(g.territories[caps[p.id]].owner);
          return `<li><span class="star" style="color:${p.color}">★</span>${esc(MAP.territories[caps[p.id]].name)} <span class="muted">(${esc(p.name)})</span>${holder.id !== p.id ? ` held by ${dot(holder.color)}${esc(holder.name)}` : ''}</li>`;
        }).join('')}</ul>
        <div class="muted small">${counts.map((x) => `${esc(x.p.name)} ${x.n}`).join(' · ')}</div>`;
    }
    $('continent-list').innerHTML = Object.entries(MAP.CONTINENTS).map(([c, info]) => {
      const held = MAP.continentTerritories[c].every((t) => g.territories[t].owner === S.you);
      const n = MAP.continentTerritories[c].filter((t) => g.territories[t].owner === S.you).length;
      return `<li class="${held ? 'held' : ''}"><span class="cname">${dot(info.color)}${info.name}</span><span>${S.spectator ? '' : `${n}/${MAP.continentTerritories[c].length} · `}+${info.bonus}</span></li>`;
    }).join('');
  }

  function renderBanner() {
    const g = S.game, b = $('turn-banner');
    const mode = `<span class="mode-tag">${MODE_LABEL[g.mode]}${g.settings.fog ? ' · fog' : ''}</span>`;
    if (g.phase === 'draft') { const c = playerById(g.currentPlayer); b.innerHTML = `${dot(c.color)}<span class="who">${c.id === S.you ? 'Your pick' : esc(c.name) + ' picking'}</span><span class="step">Draft</span>${mode}`; return; }
    if (g.phase === 'capitals') { b.innerHTML = `<span class="who">Capitals</span><span class="step">Everyone chooses a capital</span>${mode}`; return; }
    if (g.phase === 'setup') { b.innerHTML = `<span class="who">Deployment</span><span class="step">Everyone places starting armies</span>${mode}`; return; }
    if (g.phase === 'over') { const w = playerById(g.winner); b.innerHTML = `${dot(w.color)}<span class="who">${esc(w.name)} wins</span>${mode}`; return; }
    const c = playerById(g.currentPlayer);
    b.innerHTML = `${dot(c.color)}<span class="who">${isMyTurn() ? 'Your turn' : esc(c.name)}</span><span class="step">${stepText(g.step, true)} · turn ${g.turnNumber}</span>${mode}`;
  }

  function renderLog() {
    const entries = S.game.log.map((l) => ({ t: l.t, html: esc(l.text), cls: /broke their truce/.test(l.text) ? 'betrayal' : '' }))
      .concat(S.chat.map((c) => ({
        t: c.t, cls: 'chat' + (c.private ? ' private' : ''),
        html: c.private
          ? `<span class="pm">${c.fromId === S.you ? `To ${esc(c.toName)}` : `From ${esc(c.from)}`} (private):</span> ${esc(c.text)}`
          : `<b style="color:${c.color}">${esc(c.from)}${c.watching ? ' (watching)' : ''}:</b> ${esc(c.text)}`,
      })))
      .sort((a, b) => a.t - b.t).slice(-80);
    const L = $('log');
    const atBottom = L.scrollHeight - L.scrollTop - L.clientHeight < 30;
    L.innerHTML = entries.map((e) => `<li class="${e.cls}">${e.html}</li>`).join('');
    if (atBottom || !renderLog.done) L.scrollTop = L.scrollHeight;
    renderLog.done = true;
    // recipients for private messages
    const sel = $('chat-to'), cur = sel.value;
    const opts = S.spectator ? [] : S.game.players.filter((p) => p.id !== S.you && !p.bot);
    const html = `<option value="">Everyone</option>` + opts.map((p) => `<option value="${p.id}">Only ${esc(p.name)}</option>`).join('');
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; sel.value = opts.some((p) => p.id === cur) ? cur : ''; }
    sel.hidden = !opts.length;
  }

  function renderGameOver() {
    const g = S.game;
    if (g.phase !== 'over' || S.ui.goDismissed || Recap.replaying) { $('gameover').hidden = true; return; }
    const w = playerById(g.winner);
    $('go-title').textContent = w.id === S.you ? 'You won' : `${w.name} wins`;
    $('go-sub').textContent = g.mode === 'missions' ? `Mission completed: ${w.mission}` : g.mode === 'capitals' ? 'Every capital now answers to one commander.' : 'Every territory now flies one flag.';
    if (g.recap && S.ui.recapShownFor !== g.gameId) { Recap.render(g); S.ui.recapShownFor = g.gameId; }
    $('go-missions').innerHTML = g.mode === 'missions'
      ? g.players.map((p) => `<li>${dot(p.color)}<span><b>${esc(p.name)}</b>: ${esc(p.mission || '')}</span></li>`).join('') : '';
    $('btn-rematch').hidden = !isHost();
    $('btn-replay').hidden = !(g.recap && g.recap.history.length > 1);
    $('gameover').hidden = false;
  }
  $('btn-view-board').onclick = () => { S.ui.goDismissed = true; $('gameover').hidden = true; };
  $('btn-rematch').onclick = () => emit('room:lobby');
  $('btn-replay').onclick = () => {
    $('gameover').hidden = true;
    Recap.startReplay(S.game, () => { Board.update(S.game, S.game.players, boardUi()); S.ui.goDismissed = false; renderGameOver(); });
  };

  function renderGame() {
    const g = S.game;
    // drop stale selections
    if (S.ui.sel && (!owns(S.ui.sel) || !isMyTurn())) clearSel();
    if (S.ui.target && g.step === 'attack' && owns(S.ui.target)) S.ui.target = null;
    if (S.ui.sel && g.step === 'attack' && T(S.ui.sel).armies < 2) clearSel();
    if (g.step !== 'attack' && g.step !== 'fortify') clearSel();

    $('game-code').textContent = S.room.code;
    $('spectator-banner').hidden = !S.spectator;
    renderBanner();
    renderPlayers();
    if (!Recap.replaying) Board.update(g, g.players, boardUi());
    renderActionPanel();
    renderDice();
    renderDiplomacy();
    renderHand();
    renderLog();
    renderReactions();
    renderGameOver();
    document.title = isMyTurn() || (g.phase === 'draft' && g.currentPlayer === S.you) ? '● Your turn · Conquista' : 'Conquista';
  }

  // ---------- emoji reactions ----------
  function renderReactions() {
    const bar = $('reactions'), list = (S.room && S.room.reactions) || [];
    if (bar.dataset.n === String(list.length) && bar.dataset.sel === String(S.ui.react)) return;
    bar.dataset.n = String(list.length); bar.dataset.sel = String(S.ui.react);
    bar.innerHTML = list.map((e, i) => `<button class="react-btn ${S.ui.react === e ? 'on' : ''}" data-e="${e}" title="Drop ${e} on the map (or press ${i + 1} while pointing)">${e}</button>`).join('');
    bar.querySelectorAll('button').forEach((b) => (b.onclick = () => {
      S.ui.react = S.ui.react === b.dataset.e ? null : b.dataset.e;
      $('board').classList.toggle('reacting', !!S.ui.react);
      renderReactions();
      if (S.ui.react) toast('Click the map to drop it', true);
    }));
  }
  let lastPointer = null;
  $('board').addEventListener('pointermove', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; });
  $('board').addEventListener('pointerleave', () => { lastPointer = null; });
  // when a reaction is armed, the next map click drops it instead of acting on a territory
  $('board').addEventListener('click', (e) => {
    if (!S.ui.react) return;
    e.stopPropagation(); e.preventDefault();
    const p = Board.toBoardPoint(e.clientX, e.clientY);
    S.socket.emit('react', { emoji: S.ui.react, x: p.x, y: p.y });
    S.ui.react = null;
    $('board').classList.remove('reacting');
    renderReactions();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.game) { clearSel(); S.ui.react = null; $('board').classList.remove('reacting'); renderGame(); return; }
    if (!S.game || !lastPointer || /input|select|textarea/i.test(document.activeElement.tagName)) return;
    const list = (S.room && S.room.reactions) || [];
    const i = Number(e.key) - 1;
    if (i >= 0 && i < list.length) {
      const p = Board.toBoardPoint(lastPointer.x, lastPointer.y);
      S.socket.emit('react', { emoji: list[i], x: p.x, y: p.y });
    }
  });

  // ---------- timer ----------
  setInterval(() => {
    const el = $('timer');
    const d = S.room && S.room.deadline;
    if (!d || !S.game || S.game.phase === 'over') { el.hidden = true; return; }
    const s = Math.max(0, Math.ceil((d - Date.now()) / 1000));
    el.hidden = false;
    el.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    el.classList.toggle('low', s <= 15);
  }, 250);

  // ---------- top-level render ----------
  let boardReady = false;
  function render() {
    const inGame = S.room && S.room.started && S.game;
    $('screen-home').hidden = !!inGame;
    $('screen-game').hidden = !inGame;
    if (!S.room) { $('home-entry').hidden = false; $('lobby').hidden = true; return; }
    if (!inGame) { S.ui.goDismissed = false; S.prevGame = null; S.ui.recapShownFor = null; return renderLobby(); }
    if (!boardReady) {
      Board.init($('board'), {
        onClick: onTerritoryClick, onHover,
        onPointer: (x, y, tid) => { if (!S.spectator) S.socket.emit('cursor', x == null ? {} : { x, y, tid }); },
      });
      $('zoom-in').onclick = () => Board.zoomIn();
      $('zoom-out').onclick = () => Board.zoomOut();
      $('zoom-fit').onclick = () => Board.zoomReset();
      boardReady = true;
    }
    $('board').classList.toggle('show-names', S.ui.names);
    $('btn-names').classList.toggle('on', S.ui.names);
    // host can change bot speed mid-game from the top bar
    const hasBots = S.room.players.some((p) => p.bot);
    $('sel-botspeed').hidden = !(isHost() && hasBots && S.game.phase !== 'over');
    $('sel-botspeed').value = S.room.settings.botSpeed || 'normal';
    $('btn-sound').classList.toggle('on', Sound.enabled);
    $('btn-alerts').classList.toggle('on', Sound.alerts);
    renderGame();
  }
  $('btn-names').onclick = () => {
    S.ui.names = !S.ui.names;
    local.set('cq:names2', S.ui.names ? '1' : '0');
    $('board').classList.toggle('show-names', S.ui.names);
    $('btn-names').classList.toggle('on', S.ui.names);
  };
  $('btn-sound').onclick = () => { const on = Sound.toggleSound(); $('btn-sound').classList.toggle('on', on); toast(on ? 'Sound on' : 'Sound off', true); };
  $('btn-alerts').onclick = async () => {
    const r = await Sound.toggleAlerts();
    if (!r.ok) return toast(r.error);
    $('btn-alerts').classList.toggle('on', r.on);
    toast(r.on ? "Alerts on: you'll get a notification when it's your turn and this tab is in the background" : 'Alerts off', true);
  };

  // Animate board events we haven't shown yet (but don't replay history when joining or rejoining).
  function playNewEvents() {
    const g = S.game;
    if (!g || !boardReady) { S.ui.lastSeq = null; S.ui.gameId = null; return; }
    const evs = g.events || [];
    const maxSeq = evs.length ? evs[evs.length - 1].seq : 0;
    if (S.ui.gameId !== g.gameId || S.ui.lastSeq == null) { S.ui.gameId = g.gameId; S.ui.lastSeq = maxSeq; return; }
    const fresh = evs.filter((e) => e.seq > S.ui.lastSeq);
    S.ui.lastSeq = maxSeq;
    if (!fresh.length || document.hidden) return;
    if (!Recap.replaying) Board.animate(fresh.filter((e) => e.type !== 'betrayal'), g.players);
    if (fresh.some((e) => e.type === 'betrayal')) Sound.play('betrayal');
    else if (fresh.some((e) => e.type === 'battle' && e.conquered)) Sound.play('capture');
    else if (fresh.some((e) => e.type === 'battle')) Sound.play('dice');
    else if (fresh.some((e) => e.type === 'place' && e.pid === S.you)) Sound.play('place');
  }

  // Leaving a running game: two clicks to avoid accidents.
  $('btn-leave-game').onclick = async () => {
    const b = $('btn-leave-game');
    if (!b.classList.contains('confirm')) {
      b.classList.add('confirm'); b.textContent = 'Click again to leave';
      setTimeout(() => { b.classList.remove('confirm'); b.textContent = 'Leave'; }, 3000);
      return;
    }
    await emit('room:leave');
    if (S.spectator || (S.game && S.game.phase === 'over')) seats.drop(S.code);
    b.classList.remove('confirm'); b.textContent = 'Leave';
    leaveToHome();
  };

  let wasMyTurn = false, lastPhase = null;
  S.socket.on('state', (st) => {
    S.you = st.you;
    S.spectator = !!st.spectator;
    S.room = st.room;
    S.prevGame = S.game;
    S.game = st.game;
    render();
    S.prevGame = S.game; // later local re-renders shouldn't re-flash captures
    playNewEvents();
    if (S.resumed && S.game && S.game.phase !== 'over') toast(S.spectator ? 'Watching the game' : 'Rejoined your game in progress. Use Leave to exit it.', true);
    S.resumed = false;
    const g = S.game;
    const mine = isMyTurn() || (g && g.phase === 'draft' && g.currentPlayer === S.you);
    if (mine && !wasMyTurn && g && (g.turnNumber > 0 || g.phase === 'draft')) {
      if (g.phase === 'playing') toast('Your turn', true);
      Sound.yourTurn(g.phase === 'draft' ? 'Your pick in the draft' : `Turn ${g.turnNumber}: ${g.reinforcements} reinforcements to place`);
    }
    wasMyTurn = mine;
    if (g && g.phase === 'over' && lastPhase && lastPhase !== 'over') Sound.play('win');
    lastPhase = g ? g.phase : null;
  });
  S.socket.on('cursor', (c) => {
    if (!boardReady || !S.game || S.game.phase === 'over') return;
    const p = S.game.players.find((x) => x.id === c.id);
    if (p) Board.showCursor(c, p);
  });
  S.socket.on('react', (r) => { if (boardReady && S.game) { Board.showReaction(r); Sound.play('react'); } });
  S.socket.on('notice', (n) => { toast(n.text, true); if (n.kind === 'truce') Sound.play('truce'); if (S.game) renderGame(); });

  S.socket.on('chat', (c) => {
    S.chat.push(c);
    if (S.chat.length > 100) S.chat.shift();
    if (S.game) renderLog();
  });
  $('chat-form').onsubmit = (e) => {
    e.preventDefault();
    const v = $('chat-in').value.trim();
    if (v) S.socket.emit('chat', { text: v, to: $('chat-to').value || undefined });
    $('chat-in').value = '';
  };
})();
