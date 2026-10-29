// Conquista client: connects to the server, renders lobby and game, turns clicks into actions.
(function () {
  const MAP = window.CONQUISTA_MAP;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
    getL(k) { try { return localStorage.getItem(k); } catch { return null; } },
    setL(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  const S = {
    socket: io(),
    code: null, token: null, you: null,
    room: null, game: null, prevGame: null,
    chat: [],
    ui: { sel: null, target: null, amount: 1, dice: 3, cards: new Set(), names: store.getL('cq:names') !== '0', goDismissed: false, lastBattleT: 0 },
  };

  // ---------- helpers ----------
  function toast(msg, info) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (info ? ' info' : '');
    t.hidden = false;
    clearTimeout(toast.h);
    toast.h = setTimeout(() => (t.hidden = true), 2600);
  }
  function emit(ev, data) {
    return new Promise((res) => S.socket.emit(ev, data, (r) => { if (r && !r.ok && r.error) toast(r.error); res(r || {}); }));
  }
  const act = (type, payload) => emit('game:action', { type, payload });
  const me = () => S.game && S.game.players.find((p) => p.id === S.you);
  const playerById = (id) => S.game && S.game.players.find((p) => p.id === id);
  const isMyTurn = () => S.game && S.game.phase === 'playing' && S.game.currentPlayer === S.you;
  const T = (id) => S.game.territories[id];
  const owns = (id) => T(id).owner === S.you;
  const hasEnemyNeighbor = (id) => MAP.territories[id].neighbors.some((n) => !owns(n));
  function connectedSet(from) {
    const seen = new Set([from]), q = [from];
    while (q.length) {
      const c = q.shift();
      for (const n of MAP.territories[c].neighbors) if (!seen.has(n) && owns(n)) { seen.add(n); q.push(n); }
    }
    seen.delete(from);
    return seen;
  }
  function dot(color) { return `<span class="dot" style="background:${color}"></span>`; }

  // ---------- joining ----------
  async function joinRoom(code, token) {
    const r = await emit('room:join', { code, token, name: $('in-name').value });
    if (r.ok) saveSession(r);
    else if (token) { store.set('cq:' + code, null); }
    return r;
  }
  function saveSession(r) {
    S.code = r.code; S.token = r.token; S.you = r.playerId;
    store.set('cq:' + r.code, { token: r.token });
    store.setL('cq:name', $('in-name').value || '');
    const url = new URL(location.href);
    url.searchParams.set('room', r.code);
    history.replaceState(null, '', url);
  }

  $('in-name').value = store.getL('cq:name') || '';
  $('btn-create').onclick = async () => {
    if (!$('in-name').value.trim()) { $('in-name').focus(); return toast('Enter your name first'); }
    const r = await emit('room:create', { name: $('in-name').value });
    if (r.ok) saveSession(r);
  };
  $('btn-join').onclick = () => {
    const code = $('in-code').value.trim().toUpperCase();
    if (!$('in-name').value.trim()) { $('in-name').focus(); return toast('Enter your name first'); }
    if (code.length !== 5) return toast('Room codes are 5 letters');
    joinRoom(code);
  };
  $('in-code').addEventListener('keydown', (e) => e.key === 'Enter' && $('btn-join').click());
  $('in-name').addEventListener('keydown', (e) => e.key === 'Enter' && ($('in-code').value ? $('btn-join') : $('btn-create')).click());

  // Resume from the URL / session after refresh or reconnect.
  function tryResume() {
    const code = S.code || new URL(location.href).searchParams.get('room');
    if (!code) return;
    const saved = store.get('cq:' + code.toUpperCase());
    if (saved && saved.token) joinRoom(code.toUpperCase(), saved.token);
    else $('in-code').value = code.toUpperCase();
  }
  S.socket.on('connect', tryResume);
  S.socket.on('disconnect', () => toast('Connection lost — reconnecting…'));

  // ---------- lobby ----------
  $('btn-copy').onclick = async () => {
    const url = location.origin + location.pathname + '?room=' + S.code;
    try { await navigator.clipboard.writeText(url); toast('Invite link copied', true); }
    catch { prompt('Copy this link', url); }
  };
  $('btn-leave').onclick = async () => {
    await emit('room:leave');
    store.set('cq:' + S.code, null);
    S.code = S.token = S.you = null; S.room = S.game = null;
    history.replaceState(null, '', location.pathname);
    render();
  };
  $('btn-start').onclick = () => emit('room:start');
  $('seg-mode').onclick = (e) => { const b = e.target.closest('button'); if (b) emit('room:settings', { mode: b.dataset.mode }); };
  $('sel-timer').onchange = (e) => emit('room:settings', { timer: Number(e.target.value) });

  function renderLobby() {
    const r = S.room, isHost = r.hostId === S.you;
    $('home-entry').hidden = true;
    $('lobby').hidden = false;
    $('lobby-code').textContent = r.code;
    $('lobby-players').innerHTML = r.players.map((p) =>
      `<li class="${p.connected ? '' : 'offline'}">${dot(p.color)}<span>${esc(p.name)}</span>
        <span class="tag">${p.id === r.hostId ? 'Host' : ''}${p.id === S.you ? (p.id === r.hostId ? ' · you' : 'You') : ''}</span></li>`).join('');
    const mine = r.players.find((p) => p.id === S.you);
    $('color-swatches').innerHTML = r.colors.map((c) => {
      const taken = r.players.some((p) => p.color === c.hex && p.id !== S.you);
      return `<button class="swatch ${mine && mine.color === c.hex ? 'on' : ''}" style="background:${c.hex}" title="${c.name}" data-c="${c.hex}" ${taken ? 'disabled' : ''}></button>`;
    }).join('');
    $('color-swatches').querySelectorAll('.swatch').forEach((b) => (b.onclick = () => emit('room:color', { color: b.dataset.c })));
    $('lobby-settings').disabled = !isHost;
    $('seg-mode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === r.settings.mode));
    $('sel-timer').value = String(r.settings.timer);
    $('btn-start').hidden = !isHost;
    $('btn-start').disabled = r.players.length < 2;
    $('lobby-hint').textContent = r.players.length < 2
      ? 'Share the invite link — you need at least 2 players.'
      : isHost ? `${r.players.length} players ready. Start when everyone has joined.` : 'Waiting for the host to start the game.';
  }

  // ---------- board interaction ----------
  function clearSel() { S.ui.sel = null; S.ui.target = null; }

  async function onTerritoryClick(id) {
    const g = S.game;
    if (!g) return;
    const u = S.ui;
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
    tip.innerHTML = `<b>${esc(t.name)}</b> · ${s.armies} ${s.armies === 1 ? 'army' : 'armies'} · ${p ? esc(p.name) : ''}<br><span class="muted">${MAP.CONTINENTS[t.continent].name}</span>`;
    const box = $('screen-game').querySelector('.board-wrap').getBoundingClientRect();
    tip.style.left = Math.min(e.clientX - box.left + 14, box.width - 200) + 'px';
    tip.style.top = (e.clientY - box.top + 14) + 'px';
    tip.hidden = false;
  }

  function boardUi() {
    const g = S.game, u = S.ui;
    const clickable = new Set(), dim = new Set(), flash = new Set();
    const all = Object.keys(g.territories);
    if (g.phase === 'setup') {
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
    if (S.prevGame && S.prevGame.phase !== 'setup') {
      for (const id of all) if (S.prevGame.territories[id] && S.prevGame.territories[id].owner !== g.territories[id].owner) flash.add(id);
    }
    return { clickable, dim, flash, sel: u.sel, target: u.target };
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
  function rangeRow(id, min, max, val, label) {
    return `<div class="range-row"><input type="range" id="${id}" min="${min}" max="${max}" value="${val}" aria-label="${label}"><output id="${id}-out">${val}</output></div>`;
  }
  function bindRange(id) {
    const r = $(id); if (r) r.oninput = () => ($(id + '-out').textContent = r.value);
  }

  function renderActionPanel() {
    const g = S.game, u = S.ui, P = $('action-panel'), mp = me();
    const curr = playerById(g.currentPlayer);
    let h = '';

    if (g.phase === 'setup') {
      const left = g.setupRemaining[S.you];
      const waiting = g.players.filter((p) => g.setupRemaining[p.id] > 0).length;
      if (left > 0) {
        h = `<h3>Deploy your armies</h3><div class="big-num">${left}</div><p>Click your territories to place them. Everyone deploys at the same time.</p>${amountSeg()}`;
      } else {
        h = `<h3>Deployed</h3><p>Waiting for ${waiting} ${waiting === 1 ? 'player' : 'players'} to finish placing.</p>`;
      }
    } else if (g.phase === 'over') {
      h = `<h3>Game over</h3><p>${esc(playerById(g.winner).name)} won.</p>`;
    } else if (!isMyTurn()) {
      const lp = S.room.players.find((p) => p.id === g.currentPlayer);
      const offline = lp && !lp.connected;
      h = `<h3>${esc(curr.name)}'s turn</h3><p>${stepText(g.step, false)}${offline ? ' They are offline.' : ''}</p>`;
      if (offline && S.room.hostId === S.you) h += `<button class="btn btn-sm" id="btn-skip">Skip their turn</button>`;
    } else if (g.step === 'reinforce') {
      if (mp.cards.length >= 5) {
        h = `<h3>Trade in cards</h3><p>You hold ${mp.cards.length} cards. Select a set below and trade it before placing armies.</p>`;
      } else {
        h = `<h3>Reinforce</h3><div class="big-num">${g.reinforcements}</div><p>Click your territories to place armies.</p>${amountSeg()}`;
      }
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
        h = `<h3>Attack</h3>
          <div class="vs"><div class="side">${dot(mp.color)}<span>${esc(MAP.territories[u.sel].name)}</span><b>${a.armies}</b></div>
          <div class="side">${dot(dp.color)}<span>${esc(MAP.territories[u.target].name)}</span><b>${d.armies}</b></div></div>
          <div class="seg" id="dice-seg">${[1, 2, 3].map((n) => `<button data-d="${n}" class="${u.dice === n ? 'on' : ''}" ${n > maxDice ? 'disabled' : ''}>${n} ${n === 1 ? 'die' : 'dice'}</button>`).join('')}</div>
          <div class="row"><button class="btn btn-brass" id="btn-attack">Roll</button><button class="btn" id="btn-blitz" title="Keep rolling until you win or run out of armies">Blitz</button></div>`;
      } else if (u.sel) {
        h = `<h3>Attack</h3><p>Pick an enemy territory next to ${esc(MAP.territories[u.sel].name)}.</p>`;
      } else {
        h = `<h3>Attack</h3><p>Pick one of your territories with 2 or more armies, then an enemy next to it.</p>`;
      }
      h += `<div class="row"><button class="btn btn-ghost" id="btn-endattack">End attacks</button></div>`;
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
    on('btn-move', () => act('move', { count: Number($('mv').value) }));
    on('btn-attack', () => act('attack', { from: u.sel, to: u.target, dice: u.dice }));
    on('btn-blitz', () => act('attack', { from: u.sel, to: u.target, blitz: true }));
    on('btn-endattack', () => { clearSel(); act('endAttack'); });
    on('btn-endturn', () => { clearSel(); act('endTurn'); });
    on('btn-fortify', async () => { const r = await act('fortify', { from: u.sel, to: u.target, count: Number($('fv').value) }); if (r.ok) clearSel(); });
    const ds = $('dice-seg');
    if (ds) ds.onclick = (e) => { const b = e.target.closest('button'); if (b && !b.disabled) { u.dice = Number(b.dataset.d); renderGame(); } };
  }

  function stepText(step, mine) {
    return { reinforce: mine ? 'Place reinforcements' : 'Placing reinforcements.', attack: mine ? 'Attack' : 'Attacking.', fortify: mine ? 'Fortify' : 'Fortifying.' }[step] || '';
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
  function renderHand() {
    const mp = me(), g = S.game;
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
    $('trade-value').textContent = `Next set: ${g.nextTradeValue} armies`;
    const canTrade = isMyTurn() && g.step === 'reinforce' && S.ui.cards.size === 3;
    $('btn-trade').disabled = !canTrade;
    $('btn-trade').hidden = !cards.length;
  }
  $('btn-trade').onclick = async () => {
    const r = await act('trade', { cards: [...S.ui.cards] });
    if (r.ok) S.ui.cards.clear();
  };

  function renderPlayers() {
    const g = S.game;
    $('player-list').innerHTML = g.players.map((p) => {
      const lp = S.room.players.find((x) => x.id === p.id);
      const cls = [p.id === g.currentPlayer ? 'current' : '', p.alive ? '' : 'dead', lp && !lp.connected ? 'offline' : ''].join(' ');
      return `<li class="${cls}"><div class="pname">${dot(p.color)}${esc(p.name)}${p.id === S.you ? '<span class="you">you</span>' : ''}${lp && !lp.connected ? '<span class="you">offline</span>' : ''}</div>
        <div class="stats">${p.alive ? `<span><b>${p.territoryCount}</b> lands</span><span><b>${p.armyCount}</b> armies</span><span><b>${p.cardCount}</b> cards</span>` : '<span>Eliminated</span>'}</div></li>`;
    }).join('');
    const mp = me();
    $('mission-box').hidden = !(mp && mp.mission);
    if (mp && mp.mission) $('mission-text').textContent = mp.mission;
    $('continent-list').innerHTML = Object.entries(MAP.CONTINENTS).map(([c, info]) => {
      const held = MAP.continentTerritories[c].every((t) => g.territories[t].owner === S.you);
      const n = MAP.continentTerritories[c].filter((t) => g.territories[t].owner === S.you).length;
      return `<li class="${held ? 'held' : ''}"><span>${info.name}</span><span>${n}/${MAP.continentTerritories[c].length} · +${info.bonus}</span></li>`;
    }).join('');
  }

  function renderBanner() {
    const g = S.game, b = $('turn-banner');
    if (g.phase === 'setup') { b.innerHTML = `<span class="who">Deployment</span><span class="step">Everyone places starting armies</span>`; return; }
    if (g.phase === 'over') { const w = playerById(g.winner); b.innerHTML = `${dot(w.color)}<span class="who">${esc(w.name)} wins</span>`; return; }
    const c = playerById(g.currentPlayer);
    b.innerHTML = `${dot(c.color)}<span class="who">${isMyTurn() ? 'Your turn' : esc(c.name)}</span><span class="step">${stepText(g.step, true)} · turn ${g.turnNumber}</span>`;
  }

  function renderLog() {
    const entries = S.game.log.map((l) => ({ t: l.t, html: esc(l.text) }))
      .concat(S.chat.map((c) => ({ t: c.t, chat: true, html: `<b style="color:${c.color}">${esc(c.from)}:</b> ${esc(c.text)}` })))
      .sort((a, b) => a.t - b.t).slice(-80);
    const L = $('log');
    const atBottom = L.scrollHeight - L.scrollTop - L.clientHeight < 30;
    L.innerHTML = entries.map((e) => `<li class="${e.chat ? 'chat' : ''}">${e.html}</li>`).join('');
    if (atBottom || !renderLog.done) L.scrollTop = L.scrollHeight;
    renderLog.done = true;
  }

  function renderGameOver() {
    const g = S.game;
    if (g.phase !== 'over' || S.ui.goDismissed) { $('gameover').hidden = true; return; }
    const w = playerById(g.winner);
    $('go-title').textContent = w.id === S.you ? 'You conquered the world' : `${w.name} wins`;
    $('go-sub').textContent = g.mode === 'missions' ? `Mission completed: ${w.mission}` : 'Every territory now flies one flag.';
    $('go-missions').innerHTML = g.mode === 'missions'
      ? g.players.map((p) => `<li>${dot(p.color)}<span><b>${esc(p.name)}</b>: ${esc(p.mission || '')}</span></li>`).join('') : '';
    const host = S.room.hostId === S.you;
    $('btn-rematch').hidden = !host;
    $('gameover').hidden = false;
  }
  $('btn-view-board').onclick = () => { S.ui.goDismissed = true; $('gameover').hidden = true; };
  $('btn-rematch').onclick = () => emit('room:lobby');

  function renderGame() {
    const g = S.game;
    // drop stale selections
    if (S.ui.sel && (!owns(S.ui.sel) || !isMyTurn())) clearSel();
    if (S.ui.target && g.step === 'attack' && owns(S.ui.target)) S.ui.target = null;
    if (S.ui.sel && g.step === 'attack' && T(S.ui.sel).armies < 2) clearSel();
    if (g.step !== 'attack' && g.step !== 'fortify') clearSel();

    $('game-code').textContent = S.room.code;
    renderBanner();
    renderPlayers();
    const colors = Object.fromEntries(g.players.map((p) => [p.id, p.color]));
    Board.update(g, colors, boardUi());
    renderActionPanel();
    renderDice();
    renderHand();
    renderLog();
    renderGameOver();
    document.title = isMyTurn() ? '● Your turn · Conquista' : 'Conquista';
  }

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
    if (!inGame) { S.ui.goDismissed = false; S.prevGame = null; return renderLobby(); }
    if (!boardReady) {
      Board.init($('board'), { onClick: onTerritoryClick, onHover });
      $('zoom-in').onclick = () => Board.zoomIn();
      $('zoom-out').onclick = () => Board.zoomOut();
      $('zoom-fit').onclick = () => Board.zoomReset();
      boardReady = true;
    }
    $('board').classList.toggle('hide-names', !S.ui.names);
    renderGame();
  }
  $('btn-names').onclick = () => {
    S.ui.names = !S.ui.names;
    store.setL('cq:names', S.ui.names ? '1' : '0');
    $('board').classList.toggle('hide-names', !S.ui.names);
  };

  let wasMyTurn = false;
  S.socket.on('state', (st) => {
    S.you = st.you;
    S.room = st.room;
    S.prevGame = S.game;
    S.game = st.game;
    render();
    S.prevGame = S.game; // later local re-renders shouldn't re-flash captures
    const mine = isMyTurn();
    if (mine && !wasMyTurn && S.game.turnNumber > 0) toast('Your turn', true);
    wasMyTurn = mine;
  });
  S.socket.on('chat', (c) => {
    S.chat.push(c);
    if (S.chat.length > 100) S.chat.shift();
    if (S.game) renderLog();
  });
  $('chat-form').onsubmit = (e) => {
    e.preventDefault();
    const v = $('chat-in').value.trim();
    if (v) S.socket.emit('chat', { text: v });
    $('chat-in').value = '';
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.game) { clearSel(); renderGame(); } });
})();
