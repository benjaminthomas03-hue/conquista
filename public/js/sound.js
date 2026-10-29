// Sound effects (synthesised with Web Audio, no files to download) and your-turn alerts.
(function () {
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* ignore */ } };
  let ctx = null;
  const audio = () => {
    if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; ctx = new AC(); }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  };
  // browsers only allow audio after a user gesture
  window.addEventListener('pointerdown', () => { if (Sound.enabled) audio(); }, { once: true });

  function tone(freq, start, dur, { type = 'sine', vol = 0.18, slide = 0 } = {}) {
    const a = audio(); if (!a) return;
    const t0 = a.currentTime + start;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(a.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  function click(start, vol = 0.25) {
    const a = audio(); if (!a) return;
    const len = Math.floor(a.sampleRate * 0.03), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const s = a.createBufferSource(), g = a.createGain(), f = a.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 1800 + Math.random() * 1500;
    g.gain.value = vol;
    s.buffer = buf; s.connect(f).connect(g).connect(a.destination);
    s.start(a.currentTime + start);
  }

  const SOUNDS = {
    dice: () => { for (let i = 0; i < 7; i++) click(i * 0.045 + Math.random() * 0.02, 0.3 - i * 0.03); },
    capture: () => { tone(392, 0.05, 0.18, { type: 'triangle' }); tone(523, 0.17, 0.32, { type: 'triangle' }); },
    place: () => tone(660, 0, 0.08, { type: 'sine', vol: 0.08 }),
    turn: () => { tone(587, 0, 0.22, { vol: 0.2 }); tone(880, 0.16, 0.4, { vol: 0.18 }); },
    betrayal: () => { tone(220, 0, 0.5, { type: 'sawtooth', vol: 0.07, slide: 0.7 }); tone(233, 0, 0.5, { type: 'sawtooth', vol: 0.06, slide: 0.7 }); },
    win: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.14, 0.4, { type: 'triangle', vol: 0.16 })); },
    react: () => tone(900, 0, 0.09, { vol: 0.06, slide: 1.4 }),
    alarm: () => { [0, .16, .32].forEach((t) => tone(740, t, 0.12, { type: 'square', vol: 0.06 })); },
    truce: () => { tone(494, 0, 0.18, { vol: 0.12 }); tone(659, 0.12, 0.3, { vol: 0.12 }); },
  };

  const Sound = {
    enabled: get('cq:sound', true),
    alerts: get('cq:alerts', false) && 'Notification' in window && Notification.permission === 'granted',
    play(name) { if (this.enabled && SOUNDS[name] && !document.hidden) try { SOUNDS[name](); } catch { /* ignore */ } },
    toggleSound() { this.enabled = !this.enabled; set('cq:sound', this.enabled); if (this.enabled) { audio(); this.play('place'); } return this.enabled; },
    async toggleAlerts() {
      if (!('Notification' in window)) return { ok: false, error: 'This browser does not support notifications' };
      if (this.alerts) { this.alerts = false; set('cq:alerts', false); return { ok: true, on: false }; }
      const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (perm !== 'granted') return { ok: false, error: 'Notifications are blocked for this site in your browser settings' };
      this.alerts = true; set('cq:alerts', true);
      return { ok: true, on: true };
    },
    // Called when one of your territories is attacked and you need to roll.
    defend(text) {
      if (document.hidden) {
        if (this.alerts) try { new Notification('Conquista: you are under attack', { body: text, tag: 'conquista-defend' }); } catch { /* ignore */ }
        if (this.enabled && ctx) try { SOUNDS.alarm(); } catch { /* ignore */ }
      } else this.play('alarm');
    },
    // Called when it becomes your turn.
    yourTurn(text) {
      if (document.hidden) {
        if (this.alerts) try { new Notification('Conquista: your turn', { body: text, tag: 'conquista-turn' }); } catch { /* ignore */ }
        // when the tab is in the background, still chime (allowed once audio is unlocked)
        if (this.enabled && ctx) try { SOUNDS.turn(); } catch { /* ignore */ }
      } else this.play('turn');
    },
  };
  window.Sound = Sound;
})();
