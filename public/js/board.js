// Board rendering: draws real-world territory shapes (pre-built by tools/build-map.js into
// shared/map-geo.js) and keeps fills, army badges and selection highlights in sync with the game.
(function () {
  const MAP = window.CONQUISTA_MAP;
  const GEO = window.CONQUISTA_GEO;
  const NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs = {}, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  const Board = {
    nodes: {},
    init(svg, handlers) {
      this.svg = svg;
      svg.innerHTML = '';
      svg.setAttribute('viewBox', `0 0 ${GEO.width} ${GEO.height}`);
      const defs = el('defs', {}, svg);
      const f = el('filter', { id: 'shadow', x: '-10%', y: '-10%', width: '120%', height: '120%' }, defs);
      el('feDropShadow', { dx: 0, dy: 1.5, stdDeviation: 2.5, 'flood-color': '#04161b', 'flood-opacity': 0.6 }, f);

      el('path', { d: GEO.graticule, class: 'graticule' }, svg);
      const gShelf = el('g', { filter: 'url(#shadow)' }, svg);
      const gRoutes = el('g', {}, svg);
      const gLand = el('g', {}, svg);
      const gLabels = el('g', {}, svg);
      const gBadges = el('g', {}, svg);

      for (const [a, b, c, d] of GEO.seaRoutes) el('path', { class: 'sea-route', d: `M${a},${b}L${c},${d}` }, gRoutes);

      for (const t of Object.values(MAP.territories)) {
        const d = GEO.paths[t.id];
        // continent shelf: a soft halo in the continent's colour beneath the land
        el('path', { d, class: 'shelf', fill: MAP.CONTINENTS[t.continent].color, stroke: MAP.CONTINENTS[t.continent].color }, gShelf);
        const path = el('path', { d, class: 'terr', 'data-id': t.id }, gLand);
        const [x, y] = GEO.points[t.id];
        const [lx, ly] = (GEO.labelOffsets && GEO.labelOffsets[t.id]) || [0, 21];
        // name + badge live in one group so they keep a constant on-screen size when zoomed
        const tag = el('g', { transform: `translate(${x},${y})` }, gLabels);
        const label = el('text', { x: lx, y: ly, class: 'tlabel' }, tag);
        label.textContent = t.name;
        const badge = el('g', { class: 'badge', transform: `translate(${x},${y})` }, gBadges);
        const circle = el('circle', { r: 13.5 }, badge);
        const text = el('text', {}, badge);
        // the badge is clickable too, which makes small islands (Iceland, Japan…) easy to hit
        for (const target of [path, badge]) {
          target.addEventListener('click', () => handlers.onClick(t.id));
          target.addEventListener('mousemove', (e) => handlers.onHover(t.id, e));
          target.addEventListener('mouseleave', () => handlers.onHover(null));
        }
        this.nodes[t.id] = { path, circle, text, badge, tag, x, y };
      }

      for (const [c, [x, y]] of Object.entries(GEO.continentLabels || {})) {
        const tx = el('text', { x, y, class: 'clabel' }, gShelf.parentNode.insertBefore(el('g'), gRoutes));
        tx.textContent = MAP.CONTINENTS[c].name + ' +' + MAP.CONTINENTS[c].bonus;
      }
      this.enableZoom(svg);
    },

    // ---- zoom & pan (wheel / buttons to zoom, drag to pan) ----
    enableZoom(svg) {
      const W = GEO.width, H = GEO.height;
      let vb = { x: 0, y: 0, w: W, h: H };
      const apply = () => {
        vb.w = Math.min(W, Math.max(W / 5, vb.w)); vb.h = vb.w * H / W;
        vb.x = Math.min(W - vb.w, Math.max(0, vb.x)); vb.y = Math.min(H - vb.h, Math.max(0, vb.y));
        svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
        svg.classList.toggle('zoomed', vb.w < W - 1);
        const k = Math.pow(vb.w / W, 0.65); // badges grow a little when zoomed, but much less than the land does
        for (const n of Object.values(this.nodes)) {
          const tr = `translate(${n.x},${n.y}) scale(${k.toFixed(3)})`;
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
      svg.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y }; dragged = false; });
      window.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!dragged && Math.hypot(dx, dy) < 5) return;
        if (vb.w >= W - 1) return; // nothing to pan when fully zoomed out
        dragged = true;
        const scale = vb.w / svg.getBoundingClientRect().width;
        vb.x = drag.vx - dx * scale; vb.y = drag.vy - dy * scale;
        apply();
      });
      window.addEventListener('pointerup', () => { drag = null; });
      // a drag shouldn't also count as clicking a territory
      svg.addEventListener('click', (e) => { if (dragged) { e.stopPropagation(); dragged = false; } }, true);

      this.zoomIn = () => zoomAt(1 / 1.4);
      this.zoomOut = () => zoomAt(1.4);
      this.zoomReset = () => { vb = { x: 0, y: 0, w: W, h: H }; apply(); };
    },

    // ui: { clickable:Set, sel, target, dim:Set, flash:Set }
    update(view, colors, ui) {
      for (const [id, n] of Object.entries(this.nodes)) {
        const s = view.territories[id];
        const color = colors[s.owner] || '#777';
        n.path.setAttribute('fill', color);
        n.circle.setAttribute('stroke', color);
        n.text.textContent = s.armies > 0 ? s.armies : '…'; // 0 only while armies are moving in
        const cl = n.path.classList;
        cl.toggle('clickable', ui.clickable.has(id));
        n.badge.classList.toggle('clickable', ui.clickable.has(id));
        cl.toggle('sel', ui.sel === id);
        cl.toggle('target', ui.target === id);
        cl.toggle('dim', ui.dim.has(id));
        n.badge.classList.toggle('dim', ui.dim.has(id));
        if (ui.flash.has(id)) { cl.remove('flash'); void n.path.getBBox(); cl.add('flash'); }
        // keep selected shapes on top so their outline is visible
        if (ui.sel === id || ui.target === id) n.path.parentNode.appendChild(n.path);
      }
    },
  };
  window.Board = Board;
})();
