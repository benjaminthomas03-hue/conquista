// Board rendering: draws real-world territory shapes (pre-built by tools/build-map.js into
// shared/map-geo.js), keeps ownership, troop badges, threats and continent control in sync,
// and animates board events (placements, battles, troop movements) for every player.
(function () {
  const MAP = window.CONQUISTA_MAP;
  const GEO = window.CONQUISTA_GEO;
  const NS = 'http://www.w3.org/2000/svg';
  const W = GEO.width, H = GEO.height;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function el(tag, attrs = {}, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }
  // Badge radius grows with troop count so strongholds stand out at a glance.
  const radiusFor = (armies) => Math.min(22, 11 + 3 * Math.log2(Math.max(1, armies)));
  function textColorFor(hex) {
    const n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? '#13201e' : '#ffffff';
  }

  const Board = {
    nodes: {},
    k: 1, // current badge scale (depends on zoom)
    init(svg, handlers) {
      this.svg = svg;
      svg.innerHTML = '';
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      const defs = el('defs', {}, svg);
      const f = el('filter', { id: 'shadow', x: '-10%', y: '-10%', width: '120%', height: '120%' }, defs);
      el('feDropShadow', { dx: 0, dy: 1.5, stdDeviation: 2.5, 'flood-color': '#04161b', 'flood-opacity': 0.6 }, f);
      const bf = el('filter', { id: 'badge-shadow', x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs);
      el('feDropShadow', { dx: 0, dy: 1, stdDeviation: 1.2, 'flood-color': '#000', 'flood-opacity': 0.55 }, bf);

      el('path', { d: GEO.graticule, class: 'graticule' }, svg);
      const gShelf = el('g', { filter: 'url(#shadow)' }, svg);
      const gCont = el('g', {}, svg);
      const gLand = el('g', {}, svg);
      const gRoutes = el('g', { class: 'routes' }, svg); // above the land so routes over land stay visible
      const gLabels = el('g', { class: 'labels' }, svg);
      const gBadges = el('g', {}, svg);
      this.gFx = el('g', { class: 'fx' }, svg);
      this.gCursors = el('g', { class: 'cursors' }, svg);
      this.cursors = {};

      // Sea routes: dotted lines (with a dark casing so they read over sea and land) and a dot at each end.
      this.routes = [];
      for (const [, , , , a, b, wrap] of GEO.seaRoutes) {
        const g = el('g', { class: 'route' + (wrap ? ' wrap' : '') }, gRoutes);
        // badge-to-badge, like a classic board, trimmed so the line meets the edge of each badge
        const [ax, ay] = GEO.points[a];
        let [bx, by] = wrap ? [wrap === 'wrapW' ? 0 : W, ay] : GEO.points[b];
        const len = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / len, uy = (by - ay) / len;
        const x1 = ax + ux * 14, y1 = ay + uy * 14;
        const x2 = wrap ? bx : bx - ux * 14, y2 = wrap ? by : by - uy * 14;
        const d = `M${x1.toFixed(1)},${y1.toFixed(1)}L${x2.toFixed(1)},${y2.toFixed(1)}`;
        el('path', { class: 'sea-route-casing', d }, g);
        el('path', { class: 'sea-route', d }, g);
        if (wrap) {
          // Alaska <-> Kamchatka wraps around the edge of the map: arrow + label at the edge
          const left = x2 === 0, ax2 = left ? 3 : W - 3;
          el('path', { class: 'route-arrow', d: left ? `M${ax2 + 7},${y2 - 6} L${ax2},${y2} L${ax2 + 7},${y2 + 6}` : `M${ax2 - 7},${y2 - 6} L${ax2},${y2} L${ax2 - 7},${y2 + 6}` }, g);
          const t = el('text', { class: 'route-label', x: left ? 6 : W - 6, y: y2 - 10, 'text-anchor': left ? 'start' : 'end' }, g);
          t.textContent = left ? 'to Kamchatka' : 'to Alaska';
        }
        this.routes.push({ g, a, b });
      }

      this.shelves = {};
      for (const t of Object.values(MAP.territories)) {
        const d = GEO.paths[t.id];
        const cc = MAP.CONTINENTS[t.continent].color;
        // continent shelf: a soft halo beneath the land — continent colour, or the holder's colour once it's taken
        const shelf = el('path', { d, class: 'shelf', fill: cc, stroke: cc }, gShelf);
        (this.shelves[t.continent] = this.shelves[t.continent] || []).push(shelf);
        const path = el('path', { d, class: 'terr', 'data-id': t.id, fill: cc }, gLand); // land is coloured by continent
        const [x, y] = GEO.points[t.id];
        const [lx, ly] = (GEO.labelOffsets && GEO.labelOffsets[t.id]) || [0, 21];
        const tag = el('g', { transform: `translate(${x},${y})` }, gLabels);
        const label = el('text', { x: lx, y: ly + 3, class: 'tlabel' }, tag);
        label.textContent = t.name;
        const badge = el('g', { class: 'badge', transform: `translate(${x},${y})` }, gBadges);
        const pop = el('g', { class: 'pop' }, badge);
        const ring = el('circle', { class: 'threat-ring', r: 16 }, pop);
        const circle = el('circle', { class: 'disc', r: 12, filter: 'url(#badge-shadow)' }, pop);
        const text = el('text', {}, pop);
        // capital marker (capitals mode): a star pinned to the badge
        const star = el('path', { class: 'capital-star', d: 'M0,-7 L2,-2.2 L7,-2.2 L3,1 L4.4,6 L0,3 L-4.4,6 L-3,1 L-7,-2.2 L-2,-2.2 Z' }, pop);
        // the badge is clickable too, which makes small islands (Iceland, Japan…) easy to hit
        for (const target of [path, badge]) {
          target.addEventListener('click', () => handlers.onClick(t.id));
          target.addEventListener('mousemove', (e) => handlers.onHover(t.id, e));
          target.addEventListener('mouseenter', () => this.setHover(t.id));
          target.addEventListener('mouseleave', () => { handlers.onHover(null); if (this.hoverId === t.id) this.setHover(null); });
        }
        this.nodes[t.id] = { path, circle, ring, text, star, badge, pop, tag, x, y, armies: null };
      }

      this.contLabels = {};
      for (const [c, [x, y]] of Object.entries(GEO.continentLabels || {})) {
        const tx = el('text', { x, y, class: 'clabel' }, gCont);
        const name = el('tspan', {}, tx);
        name.textContent = MAP.CONTINENTS[c].name + ' +' + MAP.CONTINENTS[c].bonus;
        const holder = el('tspan', { x, dy: 15, class: 'cholder' }, tx);
        this.contLabels[c] = { tx, holder };
      }
      this.enableZoom(svg);
      // report our own pointer position (board coordinates) so other players can see it
      let lastSent = 0, hoverTid = null;
      const send = (x, y) => { if (handlers.onPointer) handlers.onPointer(x, y, hoverTid); };
      for (const [id, n] of Object.entries(this.nodes)) {
        for (const t of [n.path, n.badge]) {
          t.addEventListener('pointerenter', () => { hoverTid = id; });
          t.addEventListener('pointerleave', () => { if (hoverTid === id) hoverTid = null; });
        }
      }
      svg.addEventListener('pointermove', (e) => {
        const now = performance.now();
        if (now - lastSent < 60) return;
        lastSent = now;
        const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
        const p = pt.matrixTransform(svg.getScreenCTM().inverse());
        send(p.x, p.y);
      });
      svg.addEventListener('pointerleave', () => { hoverTid = null; send(null, null); });
    },

    // ---- other players' live cursors ----
    showCursor(c, player) {
      if (!player) return;
      let cur = this.cursors[c.id];
      if (!cur) {
        const g = el('g', { class: 'cursor' }, this.gCursors);
        const outline = el('path', { class: 'cursor-terr', stroke: player.color }, this.gCursors);
        this.gCursors.insertBefore(outline, this.gCursors.firstChild);
        const icon = el('g', {}, g);
        el('path', { d: 'M0,0 L0,15 L4,11.5 L7,18 L9.6,16.8 L6.7,10.5 L11.5,10.5 Z', class: 'cursor-arrow', fill: player.color }, icon);
        const tag = el('g', { transform: 'translate(12,18)' }, icon);
        const bg = el('rect', { rx: 3, height: 13, fill: player.color }, tag);
        const tx = el('text', { x: 4, y: 9.6, class: 'cursor-name' }, tag);
        tx.textContent = player.name;
        cur = this.cursors[c.id] = { g, icon, outline, bg, tx, sized: false, timer: null };
      }
      if (!cur.sized) { try { cur.bg.setAttribute('width', cur.tx.getComputedTextLength() + 8); cur.sized = true; } catch (e) { /* not rendered yet */ } }
      cur.tx.setAttribute('fill', textColorFor(player.color));
      if (c.x == null) { cur.g.classList.add('gone'); cur.outline.classList.add('gone'); return; }
      cur.g.classList.remove('gone');
      cur.g.setAttribute('transform', `translate(${c.x},${c.y})`);
      cur.icon.setAttribute('transform', `scale(${this.k.toFixed(3)})`);
      if (c.tid && GEO.paths[c.tid]) { cur.outline.setAttribute('d', GEO.paths[c.tid]); cur.outline.classList.remove('gone'); }
      else cur.outline.classList.add('gone');
      clearTimeout(cur.timer);
      cur.timer = setTimeout(() => { cur.g.classList.add('gone'); cur.outline.classList.add('gone'); }, 5000);
    },
    // ---- emoji reactions dropped on the map ----
    showReaction(r) {
      const g = el('g', { class: 'fx-react', transform: `translate(${r.x},${r.y}) scale(${this.k.toFixed(3)})` }, this.gCursors);
      const t = el('text', { class: 'fx-react-emoji', y: 0 }, g);
      t.textContent = r.emoji;
      const n = el('text', { class: 'fx-react-name', y: 15, fill: r.color }, g);
      n.textContent = r.name;
      setTimeout(() => g.remove(), 2600);
    },
    toBoardPoint(clientX, clientY) {
      const pt = this.svg.createSVGPoint(); pt.x = clientX; pt.y = clientY;
      return pt.matrixTransform(this.svg.getScreenCTM().inverse());
    },

    removeCursor(id) {
      const cur = this.cursors[id]; if (!cur) return;
      cur.g.remove(); cur.outline.remove(); delete this.cursors[id];
    },

    // ---- zoom & pan (wheel / buttons to zoom, drag to pan) ----
    enableZoom(svg) {
      let vb = { x: 0, y: 0, w: W, h: H };
      const apply = () => {
        vb.w = Math.min(W, Math.max(W / 5, vb.w)); vb.h = vb.w * H / W;
        vb.x = Math.min(W - vb.w, Math.max(0, vb.x)); vb.y = Math.min(H - vb.h, Math.max(0, vb.y));
        svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
        svg.classList.toggle('zoomed', vb.w < W - 1);
        svg.classList.toggle('zoom-names', vb.w < W * 0.6); // names appear automatically once you zoom in
        this.k = Math.pow(vb.w / W, 0.65); // badges grow a little when zoomed, but much less than the land does
        for (const n of Object.values(this.nodes)) {
          const tr = `translate(${n.x},${n.y}) scale(${this.k.toFixed(3)})`;
          n.badge.setAttribute('transform', tr);
          n.tag.setAttribute('transform', tr);
        }
      };
      const toBoard = (cx, cy) => {
        const pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy;
        return pt.matrixTransform(svg.getScreenCTM().inverse());
      };
      const zoomAt = (factor, cx, cy) => {
        const p = cx == null ? { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 } : toBoard(cx, cy);
        const nw = Math.min(W, Math.max(W / 5, vb.w * factor));
        vb.x = p.x - (p.x - vb.x) * (nw / vb.w); vb.y = p.y - (p.y - vb.y) * (nw / vb.w); vb.w = nw;
        apply();
      };
      svg.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(Math.exp(e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });

      let drag = null, dragged = false;
      // two-finger pinch on touch screens
      const touches = new Map();
      let pinch = null;
      svg.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'touch') touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) {
          const [a, b] = [...touches.values()];
          pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
          drag = null; dragged = true;
          return;
        }
        drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y }; dragged = false;
      });
      window.addEventListener('pointermove', (e) => {
        if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && touches.size === 2) {
          const [a, b] = [...touches.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d > 0 && pinch.d > 0) zoomAt(pinch.d / d, (a.x + b.x) / 2, (a.y + b.y) / 2);
          pinch.d = d;
          return;
        }
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!dragged && Math.hypot(dx, dy) < 5) return;
        if (vb.w >= W - 1) return; // nothing to pan when fully zoomed out
        dragged = true;
        const scale = vb.w / svg.getBoundingClientRect().width;
        vb.x = drag.vx - dx * scale; vb.y = drag.vy - dy * scale;
        apply();
      });
      const endTouch = (e) => { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; drag = null; };
      window.addEventListener('pointerup', endTouch);
      window.addEventListener('pointercancel', endTouch);
      // a drag shouldn't also count as clicking a territory
      svg.addEventListener('click', (e) => { if (dragged) { e.stopPropagation(); dragged = false; } }, true);

      this.zoomIn = () => zoomAt(1 / 1.4);
      this.zoomOut = () => zoomAt(1.4);
      this.zoomReset = () => { vb = { x: 0, y: 0, w: W, h: H }; apply(); };
    },

    // ui: { clickable, sel, target, dim, flash, threats:Set, focus:playerId|null }
    // players: [{id, name, color}]
    update(view, players, ui) {
      const colors = Object.fromEntries(players.map((p) => [p.id, p.color]));
      for (const [id, n] of Object.entries(this.nodes)) {
        const s = view.territories[id];
        const unclaimed = !s.owner;                 // draft: nobody has picked it yet
        const fogged = s.armies == null && !unclaimed; // fog of war: owner known, troops hidden
        const color = unclaimed ? '#55696d' : colors[s.owner] || '#777';
        // badge: owner-coloured disc, sized by troop count
        const r = unclaimed ? 7 : radiusFor(fogged ? 1 : s.armies);
        n.circle.setAttribute('r', r.toFixed(1));
        n.circle.setAttribute('fill', color);
        n.ring.setAttribute('r', (r + 4.5).toFixed(1));
        n.text.textContent = unclaimed ? '' : fogged ? '?' : s.armies > 0 ? s.armies : '…'; // 0 only while armies are moving in
        n.badge.classList.toggle('fogged', fogged);
        n.badge.classList.toggle('unclaimed', unclaimed);
        const capOwner = view.capitals && Object.keys(view.capitals).find((pid) => view.capitals[pid] === id);
        n.star.style.display = capOwner ? '' : 'none';
        if (capOwner) {
          n.star.setAttribute('transform', `translate(${(r * 0.72).toFixed(1)},${(-r * 0.72).toFixed(1)}) scale(1.15)`);
          n.star.setAttribute('fill', colors[capOwner] || '#fff');
        }
        n.text.setAttribute('fill', textColorFor(color));
        n.text.style.fontSize = Math.max(11, r * 1.05).toFixed(1) + 'px';
        n.armies = s.armies;
        const cl = n.path.classList;
        cl.toggle('clickable', ui.clickable.has(id));
        n.badge.classList.toggle('clickable', ui.clickable.has(id));
        cl.toggle('sel', ui.sel === id);
        cl.toggle('target', ui.target === id);
        const dim = ui.dim.has(id) || (ui.focus && s.owner !== ui.focus);
        cl.toggle('dim', !!dim);
        n.badge.classList.toggle('dim', !!dim);
        n.badge.classList.toggle('threatened', !!(ui.threats && ui.threats.has(id)));
        if (ui.flash.has(id)) { cl.remove('flash'); void n.path.getBBox(); cl.add('flash'); }
        // keep selected shapes on top so their outline is visible
        if (ui.sel === id || ui.target === id) n.path.parentNode.appendChild(n.path);
      }
      this.ui = ui;
      this.highlightRoutes();
      // continent control: tint the shelf and name the holder
      for (const [c, ids] of Object.entries(MAP.continentTerritories)) {
        const owner = view.territories[ids[0]].owner;
        const held = ids.every((t) => view.territories[t].owner === owner);
        const p = held && players.find((x) => x.id === owner);
        const col = p ? p.color : MAP.CONTINENTS[c].color;
        for (const sh of this.shelves[c]) { sh.setAttribute('stroke', col); sh.setAttribute('fill', col); sh.classList.toggle('held', !!p); }
        const lab = this.contLabels[c];
        if (lab) {
          lab.holder.textContent = p ? `held by ${p.name}` : '';
          lab.holder.setAttribute('fill', p ? p.color : 'transparent');
          lab.tx.classList.toggle('held', !!p);
        }
      }
    },

    // Light up the sea routes of the selected territory (or the one under the pointer).
    highlightRoutes() {
      const focus = new Set([this.ui && this.ui.sel, this.hoverId].filter(Boolean));
      for (const r of this.routes || []) r.g.classList.toggle('lit', focus.has(r.a) || focus.has(r.b));
    },
    setHover(id) { this.hoverId = id; this.highlightRoutes(); },

    // ---- animations ----
    // events come from the server: {type:'place'|'battle'|'move', ...}
    animate(events, players) {
      const colors = Object.fromEntries(players.map((p) => [p.id, p.color]));
      // cap how many run at once (e.g. a timer auto-placing many armies)
      events.slice(-8).forEach((e, i) => setTimeout(() => this.playEvent(e, colors), i * 120));
    },
    playEvent(e, colors) {
      const delay = (ms) => (reduceMotion ? 0 : ms);
      if (e.type === 'place') {
        this.float(e.tid, '+' + e.n, colors[e.pid], 'above');
        this.bump(e.tid, 'pop-grow');
      } else if (e.type === 'battle') {
        const col = colors[e.attacker];
        this.arrow(e.from, e.to, col, 'attack');
        setTimeout(() => {
          this.burst(e.to, col, e.conquered ? 1 : 0.6);
          if (e.attLoss) this.float(e.from, '−' + e.attLoss, '#ff8a7a', 'right');
          if (e.defLoss) this.float(e.to, '−' + e.defLoss, '#ff8a7a', 'right');
          this.bump(e.to, 'pop-shake');
        }, delay(380));
        if (e.conquered) setTimeout(() => this.float(e.to, 'Captured', col, 'below', true), delay(700));
      } else if (e.type === 'move') {
        this.arrow(e.from, e.to, colors[e.pid], 'move');
        // after a conquest the move-in follows the battle, so let the battle labels clear first
        setTimeout(() => this.float(e.to, '+' + e.n, colors[e.pid], 'above'), delay(1100));
      }
    },
    bump(tid, cls) {
      const n = this.nodes[tid]; if (!n || reduceMotion) return;
      n.pop.classList.remove('pop-grow', 'pop-shake'); void n.pop.getBBox(); n.pop.classList.add(cls);
    },
    // where: 'above' (gains), 'right' (losses), 'below' (status words)
    float(tid, text, color, where, small) {
      const n = this.nodes[tid]; if (!n) return;
      const r = radiusFor(n.armies || 1) * this.k;
      const pos = {
        above: [n.x - 4 * this.k, n.y - r - 6 * this.k, -22],
        right: [n.x + r + 3 * this.k, n.y + 5 * this.k, 16],
        below: [n.x, n.y + r + 14 * this.k, 10],
      }[where];
      const t = el('text', { x: pos[0], y: pos[1], class: 'fx-float' + (small ? ' small' : ''), fill: color || '#fff' }, this.gFx);
      t.style.fontSize = ((small ? 12 : 18) * this.k).toFixed(1) + 'px';
      t.style.setProperty('--rise', pos[2] * this.k + 'px');
      t.textContent = text;
      setTimeout(() => t.remove(), 1700);
    },
    burst(tid, color, size) {
      const n = this.nodes[tid]; if (!n) return;
      const c = el('circle', { cx: n.x, cy: n.y, r: 8 * this.k, class: 'fx-burst', stroke: color }, this.gFx);
      c.style.setProperty('--burst', (50 * size * this.k) + 'px');
      setTimeout(() => c.remove(), 1000);
    },
    arrow(from, to, color, kind) {
      const A = this.nodes[from], B = this.nodes[to]; if (!A || !B) return;
      // Alaska <-> Kamchatka wraps around the map edge: draw two half-arrows
      if (Math.abs(A.x - B.x) > W / 2) {
        const edgeA = A.x < B.x ? 0 : W, edgeB = A.x < B.x ? W : 0;
        this.drawArrow(A.x, A.y, edgeA, A.y, color, kind, false);
        this.drawArrow(edgeB, B.y, B.x, B.y, color, kind, true);
        return;
      }
      this.drawArrow(A.x, A.y, B.x, B.y, color, kind, true);
    },
    drawArrow(x1, y1, x2, y2, color, kind, head) {
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      // start/end just outside the badges, curve slightly to one side
      const sx = x1 + ux * 12 * this.k, sy = y1 + uy * 12 * this.k;
      const ex = x2 - ux * (head ? 20 : 0) * this.k, ey = y2 - uy * (head ? 20 : 0) * this.k;
      const bend = Math.min(40, len * 0.22);
      const cx = (sx + ex) / 2 - uy * bend, cy = (sy + ey) / 2 + ux * bend;
      const g = el('g', { class: 'fx-arrow ' + kind }, this.gFx);
      el('path', { d: `M${sx},${sy} Q${cx},${cy} ${ex},${ey}`, class: 'fx-arrow-casing' }, g);
      const p = el('path', { d: `M${sx},${sy} Q${cx},${cy} ${ex},${ey}`, class: 'fx-arrow-line', stroke: color }, g);
      const L = p.getTotalLength();
      p.style.setProperty('--len', L);
      if (head) {
        // arrowhead aligned with the curve's end tangent
        const tx = ex - cx, ty = ey - cy, tl = Math.hypot(tx, ty) || 1, hx = tx / tl, hy = ty / tl;
        const s = 12 * this.k;
        el('path', {
          d: `M${ex + hx * s},${ey + hy * s} L${ex - hy * s * 0.7},${ey + hx * s * 0.7} L${ex + hy * s * 0.7},${ey - hx * s * 0.7} Z`,
          class: 'fx-arrow-head', fill: color,
        }, g);
      }
      setTimeout(() => g.remove(), kind === 'attack' ? 2600 : 2000);
    },
  };
  window.Board = Board;
})();
