// Small helpers shared by host.js and join.js.

export const LETTERS = ["A", "B", "C", "D"];
export const SHAPES = ["▲", "◆", "●", "■"];

export const $ = (sel, root = document) => root.querySelector(sel);

/** Create an element. Text is always set via textContent, so player names can't inject HTML. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Show exactly one `.screen` element. */
export function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => { s.hidden = s.id !== id; });
  window.scrollTo(0, 0);
}

export function fmtPoints(n) {
  return Math.round(n || 0).toLocaleString("en-US");
}

export function fmtSeconds(ms) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

export function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Rank players by a score field. Ties share a rank (1, 2, 2, 4…).
 * @param players {uid: {name}}  @param scores {uid: {total, r1..r6}}
 * @param field "total" or "r3" etc.
 */
export function rankPlayers(players, scores, field = "total") {
  const rows = Object.entries(players || {}).map(([uid, p]) => ({
    uid,
    name: p.name,
    score: (scores?.[uid]?.[field]) || 0,
  }));
  rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  rows.forEach((r, i) => {
    r.rank = i > 0 && rows[i - 1].score === r.score ? rows[i - 1].rank : i + 1;
  });
  return rows;
}

/** Tiny Web Audio sound effects — no audio files needed. */
export const Sound = {
  ctx: null,
  muted: false,
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  },
  tone(freq, dur = 0.12, type = "sine", vol = 0.15, delay = 0) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  },
  tick(urgent) { this.tone(urgent ? 1180 : 880, 0.06, "square", urgent ? 0.07 : 0.045); },
  join() { this.tone(660, 0.08, "sine", 0.12); this.tone(990, 0.12, "sine", 0.1, 0.07); },
  reveal() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.22, "triangle", 0.14, i * 0.08)); },
  timeUp() { this.tone(330, 0.25, "sawtooth", 0.08); this.tone(247, 0.35, "sawtooth", 0.08, 0.2); },
  fanfare() {
    [[523, 0], [659, 0.15], [784, 0.3], [1047, 0.45], [784, 0.62], [1047, 0.78]]
      .forEach(([f, d]) => this.tone(f, 0.3, "triangle", 0.16, d));
  },
};

/** Lightweight confetti burst on a temporary canvas. */
export function confetti(durationMs = 3500) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = h("canvas", { class: "confetti", "aria-hidden": "true" });
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const resize = () => {
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
  };
  resize();
  const colors = ["#e21b3c", "#1368ce", "#d89e00", "#864cbf", "#22c55e", "#facc15"];
  const parts = Array.from({ length: 160 }, () => ({
    x: Math.random() * canvas.width,
    y: -Math.random() * canvas.height * 0.5,
    w: (6 + Math.random() * 8) * dpr,
    h: (8 + Math.random() * 10) * dpr,
    vx: (Math.random() - 0.5) * 3 * dpr,
    vy: (2 + Math.random() * 4) * dpr,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    color: colors[(Math.random() * colors.length) | 0],
  }));
  const start = performance.now();
  (function frame(now) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vy += 0.03 * dpr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (now - start < durationMs) requestAnimationFrame(frame);
    else canvas.remove();
  })(start);
}

/** Show a small "Reconnecting…" banner while Firebase is offline. */
export function watchConnection(fb) {
  const banner = h("div", { class: "offline-banner", role: "status", hidden: true, text: "Reconnecting…" });
  document.body.append(banner);
  let seenOnline = false;
  fb.onConnection((online) => {
    if (online) seenOnline = true;
    banner.hidden = online || !seenOnline;
  });
}

/** Brief non-blocking message at the bottom of the screen. */
export function toast(message, ms = 3500) {
  const el = h("div", { class: "toast", role: "status", text: message });
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

export function showFatal(message) {
  const box = document.getElementById("fatal");
  if (box) {
    box.querySelector("[data-msg]").textContent = message;
    showScreen("fatal");
  } else {
    alert(message);
  }
}
