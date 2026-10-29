// End-of-game recap: armies-over-time chart, highlights, and a turn-by-turn replay on the board.
(function () {
  const MAP = window.CONQUISTA_MAP;
  const NS = 'http://www.w3.org/2000/svg';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (id) => document.getElementById(id);

  // Turn a history snapshot back into a board view.
  function snapshotView(game, i) {
    const snap = game.recap.history[i], order = game.recap.territoryOrder, territories = {};
    order.forEach((t, k) => { territories[t] = { owner: game.players[snap.owners[k]] ? game.players[snap.owners[k]].id : null, armies: snap.armies[k] }; });
    return { territories, capitals: game.capitals, turn: snap.turn };
  }
  function armiesPerPlayer(game) {
    return game.recap.history.map((snap) => {
      const totals = game.players.map(() => 0);
      snap.owners.forEach((o, k) => { if (o != null) totals[o] += snap.armies[k]; });
      return totals;
    });
  }

  function drawChart(game) {
    const svg = $('go-chart');
    const W = 480, H = 170, pad = { l: 34, r: 10, t: 8, b: 20 };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';
    const series = armiesPerPlayer(game);
    if (series.length < 2) return;
    const max = Math.max(10, ...series.flat());
    const x = (i) => pad.l + (i / (series.length - 1)) * (W - pad.l - pad.r);
    const y = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);
    const add = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; svg.appendChild(e); return e; };
    // gridlines with round-number labels
    const step = Math.pow(10, Math.floor(Math.log10(max))) * (max / Math.pow(10, Math.floor(Math.log10(max))) > 5 ? 2 : 1);
    for (let v = 0; v <= max; v += step) {
      add('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'chart-grid' });
      add('text', { x: pad.l - 6, y: y(v) + 3.5, class: 'chart-label', 'text-anchor': 'end' }, v);
    }
    const lastTurn = game.recap.history[game.recap.history.length - 1].turn;
    add('text', { x: pad.l, y: H - 4, class: 'chart-label' }, 'Turn 1');
    add('text', { x: W - pad.r, y: H - 4, class: 'chart-label', 'text-anchor': 'end' }, `Turn ${lastTurn}`);
    game.players.forEach((p, pi) => {
      const pts = series.map((tot, i) => `${x(i).toFixed(1)},${y(tot[pi]).toFixed(1)}`).join(' ');
      add('polyline', { points: pts, class: 'chart-line', stroke: p.color });
    });
    $('go-legend').innerHTML = game.players.map((p) => `<span><i style="background:${p.color}"></i>${esc(p.name)}</span>`).join('');
  }

  function highlights(game) {
    const st = game.recap.stats, P = (id) => game.players.find((p) => p.id === id);
    const rows = [];
    const bb = st.biggestBattle;
    if (bb && P(bb.attacker) && P(bb.defender)) {
      rows.push(['Biggest battle', `${esc(P(bb.attacker).name)} vs ${esc(P(bb.defender).name)} in ${esc(MAP.territories[bb.to].name)}: ${bb.size} armies lost (turn ${bb.turn})`]);
    }
    const per = game.players.map((p) => ({ p, ...st.perPlayer[p.id] }));
    const by = (k, dir = -1) => per.slice().sort((a, b) => dir * (a[k] - b[k]))[0];
    const lucky = by('luck'), unlucky = by('luck', 1);
    if (lucky && Math.abs(lucky.luck) >= 0.5) rows.push(['Luckiest dice', `${esc(lucky.p.name)}: ${lucky.luck > 0 ? '+' : ''}${lucky.luck.toFixed(1)} armies better than the odds`]);
    if (unlucky && unlucky !== lucky && unlucky.luck <= -0.5) rows.push(['Unluckiest dice', `${esc(unlucky.p.name)}: ${unlucky.luck.toFixed(1)} armies worse than the odds`]);
    const conq = by('conquests');
    if (conq && conq.conquests) rows.push(['Most conquests', `${esc(conq.p.name)}: ${conq.conquests} territories taken`]);
    const kills = by('kills');
    if (kills && kills.kills) rows.push(['Most armies defeated', `${esc(kills.p.name)}: ${kills.kills}`]);
    const traitors = game.players.filter((p) => p.betrayals);
    if (traitors.length) rows.push(['Broken truces', traitors.map((p) => `${esc(p.name)} ×${p.betrayals}`).join(', ')]);
    rows.push(['Game length', `${game.recap.history[game.recap.history.length - 1].turn} turns`]);
    return `<dl>${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
  }

  const Recap = {
    render(game) {
      $('go-stats').innerHTML = highlights(game);
      drawChart(game);
    },

    // ---- replay ----
    replaying: false,
    startReplay(game, onExit) {
      const n = game.recap.history.length;
      const slider = $('replay-slider');
      this.replaying = true;
      slider.max = String(n - 1);
      slider.value = '0';
      $('replay-bar').hidden = false;
      const empty = { clickable: new Set(), dim: new Set(), flash: new Set(), threats: new Set() };
      let prev = null;
      const show = (i) => {
        const v = snapshotView(game, i);
        const flash = new Set();
        if (prev) for (const t of Object.keys(v.territories)) if (prev.territories[t].owner !== v.territories[t].owner) flash.add(t);
        prev = v;
        Board.update(v, game.players, { ...empty, flash });
        const who = game.players.find((p) => p.id === (game.recap.history[i].current || null));
        $('replay-label').textContent = i === n - 1 ? 'Final board' : `Turn ${v.turn}${who ? ' · ' + who.name : ''}`;
      };
      show(0);
      slider.oninput = () => show(Number(slider.value));
      let timer = null;
      const stop = () => { clearInterval(timer); timer = null; $('replay-play').textContent = 'Play'; };
      $('replay-play').onclick = () => {
        if (timer) return stop();
        if (Number(slider.value) >= n - 1) slider.value = '0';
        $('replay-play').textContent = 'Pause';
        timer = setInterval(() => {
          const i = Number(slider.value) + 1;
          if (i >= n) return stop();
          slider.value = String(i); show(i);
        }, Math.max(120, Math.min(600, 24000 / n)));
      };
      $('replay-close').onclick = () => { stop(); this.replaying = false; $('replay-bar').hidden = true; onExit(); };
    },
  };
  window.Recap = Recap;
})();
