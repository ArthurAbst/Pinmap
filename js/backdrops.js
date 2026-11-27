// Backgrounds behind the map sheet, painted in code (no image files needed).
// paint(ctx, w, h, id, image?) fills a w×h canvas; textures use a fixed random seed,
// so the same wall comes back every time.

export const BACKDROPS = [
  { id: "wood", label: "Wooden wall" },
  { id: "cork", label: "Cork board" },
  { id: "linen", label: "Linen" },
  { id: "plaster", label: "Plaster" },
  { id: "slate", label: "Dark slate" },
  { id: "plain", label: "Plain" },
];

function rng(seed) {   // mulberry32
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const tile = (size, draw) => {
  const c = document.createElement("canvas"); c.width = c.height = size;
  draw(c.getContext("2d"), size); return c;
};
function vignette(g, w, h, a = 0.35) {
  const r = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) * 0.62);
  r.addColorStop(0, "rgba(0,0,0,0)"); r.addColorStop(1, `rgba(0,0,0,${a})`);
  g.fillStyle = r; g.fillRect(0, 0, w, h);
}

// ---------- wood: horizontal planks with grain, knots and seams ----------
function wood(g, w, h, s) {
  const R = rng(7);
  const tones = ["#a06d42", "#94623a", "#ab7a4d", "#8b5a34", "#9d6a40", "#b3845a"];
  const ph = Math.round(118 * s);
  for (let y = 0, row = 0; y < h; y += ph, row++) {
    // one or two boards per row, joints at random positions
    const cuts = [0];
    let x = -R() * 600 * s;
    while (x < w) { x += (700 + R() * 900) * s; cuts.push(Math.min(w, Math.max(0, x))); }
    for (let i = 0; i < cuts.length - 1; i++) {
      const x0 = cuts[i], x1 = cuts[i + 1];
      if (x1 <= x0) continue;
      const base = tones[Math.floor(R() * tones.length)];
      const lg = g.createLinearGradient(0, y, 0, y + ph);
      lg.addColorStop(0, base); lg.addColorStop(0.5, shade(base, 0.06)); lg.addColorStop(1, shade(base, -0.08));
      g.fillStyle = lg; g.fillRect(x0, y, x1 - x0, ph);
      // grain
      g.save(); g.beginPath(); g.rect(x0, y, x1 - x0, ph); g.clip();
      const lines = 26 + Math.floor(R() * 14);
      for (let k = 0; k < lines; k++) {
        const y0 = y + R() * ph, amp = (1 + R() * 5) * s, f = (0.002 + R() * 0.006) / s, phase = R() * 6.3;
        const dark = R() < 0.6;
        g.strokeStyle = dark ? `rgba(55,28,10,${0.06 + R() * 0.14})` : `rgba(255,235,200,${0.04 + R() * 0.07})`;
        g.lineWidth = (0.6 + R() * 1.6) * s;
        g.beginPath();
        for (let xx = x0; xx <= x1; xx += 8 * s) {
          const yy = y0 + Math.sin(xx * f + phase) * amp + Math.sin(xx * f * 3.1 + phase * 2) * amp * 0.3;
          xx === x0 ? g.moveTo(xx, yy) : g.lineTo(xx, yy);
        }
        g.stroke();
      }
      if (R() < 0.45) {   // a knot
        const kx = x0 + R() * (x1 - x0), ky = y + ph * (0.3 + R() * 0.4), kr = (6 + R() * 10) * s;
        for (let ring = 5; ring >= 0; ring--) {
          g.strokeStyle = `rgba(60,30,12,${0.12 + ring * 0.03})`; g.lineWidth = 1.2 * s;
          g.beginPath(); g.ellipse(kx, ky, kr + ring * 5 * s, (kr + ring * 5 * s) * 0.45, 0, 0, 7); g.stroke();
        }
        g.fillStyle = "rgba(55,26,10,.55)"; g.beginPath(); g.ellipse(kx, ky, kr, kr * 0.45, 0, 0, 7); g.fill();
      }
      g.restore();
      // end joint
      if (x1 < w) { g.fillStyle = "rgba(40,20,8,.55)"; g.fillRect(x1 - 1.5 * s, y, 3 * s, ph); }
    }
    // gap between rows: dark groove + light lip
    g.fillStyle = "rgba(35,18,6,.6)"; g.fillRect(0, y + ph - 3 * s, w, 3 * s);
    g.fillStyle = "rgba(255,230,190,.12)"; g.fillRect(0, y, w, 1.5 * s);
    // a pair of nails at each joint row
    for (const cx of cuts.slice(1, -1)) {
      for (const ny of [y + ph * 0.25, y + ph * 0.72]) nail(g, cx + 12 * s, ny, s);
    }
  }
  vignette(g, w, h, 0.4);
}
function nail(g, x, y, s) {
  g.fillStyle = "rgba(30,20,10,.45)"; g.beginPath(); g.arc(x + 1 * s, y + 1.2 * s, 3.2 * s, 0, 7); g.fill();
  const r = g.createRadialGradient(x - 1 * s, y - 1 * s, 0.5, x, y, 3.4 * s);
  r.addColorStop(0, "#d8d4cc"); r.addColorStop(1, "#5d5953");
  g.fillStyle = r; g.beginPath(); g.arc(x, y, 3 * s, 0, 7); g.fill();
}

// ---------- cork: speckled tile ----------
const corkTile = (s) => tile(Math.round(256 * s), (g, n) => {
  const R = rng(11);
  g.fillStyle = "#b98b5b"; g.fillRect(0, 0, n, n);
  const cols = ["#8a5f36", "#9d6e41", "#c9a072", "#d8b588", "#6f4a28", "#a57a4c"];
  for (let i = 0; i < n * n / 9; i++) {
    g.fillStyle = cols[Math.floor(R() * cols.length)];
    g.globalAlpha = 0.35 + R() * 0.6;
    const sz = (0.8 + R() * 2.6) * s;
    g.fillRect(R() * n, R() * n, sz, sz * (0.6 + R()));
  }
  g.globalAlpha = 1;
});

// ---------- linen: woven threads ----------
const linenTile = (s) => tile(Math.round(200 * s), (g, n) => {
  const R = rng(5);
  g.fillStyle = "#e6dccb"; g.fillRect(0, 0, n, n);
  for (let i = 0; i < n; i += 2) {
    g.fillStyle = `rgba(120,100,70,${0.04 + R() * 0.09})`; g.fillRect(0, i, n, 1);
    g.fillStyle = `rgba(120,100,70,${0.03 + R() * 0.08})`; g.fillRect(i, 0, 1, n);
  }
  for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(90,70,40,${0.05 + R() * 0.08})`; g.fillRect(R() * n, R() * n, (6 + R() * 30) * s, 1); }
});

// ---------- plaster: soft mottled wall ----------
const plasterTile = (s) => tile(Math.round(256 * s), (g, n) => {
  const R = rng(3);
  g.fillStyle = "#e9e5de"; g.fillRect(0, 0, n, n);
  for (let i = 0; i < 260; i++) {
    const x = R() * n, y = R() * n, r = (8 + R() * 40) * s;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const c = R() < 0.5 ? "120,110,95" : "255,255,255";
    gr.addColorStop(0, `rgba(${c},${0.03 + R() * 0.05})`); gr.addColorStop(1, `rgba(${c},0)`);
    g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  for (let i = 0; i < n * n / 40; i++) { g.fillStyle = `rgba(80,70,60,${R() * 0.08})`; g.fillRect(R() * n, R() * n, 1, 1); }
});

const slateTile = (s) => tile(Math.round(256 * s), (g, n) => {
  const R = rng(9);
  g.fillStyle = "#2b3238"; g.fillRect(0, 0, n, n);
  for (let i = 0; i < n * n / 14; i++) { g.fillStyle = `rgba(${R() < 0.5 ? "255,255,255" : "0,0,0"},${R() * 0.05})`; g.fillRect(R() * n, R() * n, 2 * s, 2 * s); }
});

const cache = new Map();
function pattern(g, id, s) {
  const key = id + s;
  if (!cache.has(key)) cache.set(key, { cork: corkTile, linen: linenTile, plaster: plasterTile, slate: slateTile }[id](s));
  return g.createPattern(cache.get(key), "repeat");
}

/** Paint background `id` onto a w×h canvas context. s = pixel scale (devicePixelRatio). */
export function paint(g, w, h, id, s = 1, image = null, plainColor = "#eef2f3") {
  g.save();
  if (id === "photo" && image) {
    const k = Math.max(w / image.width, h / image.height);
    const iw = image.width * k, ih = image.height * k;
    g.filter = `blur(${Math.round(6 * s)}px) saturate(1.05)`;
    g.drawImage(image, (w - iw) / 2 - 20 * s, (h - ih) / 2 - 20 * s, iw + 40 * s, ih + 40 * s);
    g.filter = "none";
    g.fillStyle = "rgba(10,14,20,.22)"; g.fillRect(0, 0, w, h);
    vignette(g, w, h, 0.35);
  } else if (id === "wood") {
    wood(g, w, h, s);
  } else if (id === "plain" || !id || id === "photo") {
    g.fillStyle = plainColor; g.fillRect(0, 0, w, h);
  } else {
    g.fillStyle = pattern(g, id, s); g.fillRect(0, 0, w, h);
    vignette(g, w, h, id === "slate" ? 0.45 : 0.22);
  }
  g.restore();
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, gg = (n >> 8) & 255, b = n & 255;
  const t = f < 0 ? 0 : 255, p = Math.abs(f);
  r = Math.round((t - r) * p + r); gg = Math.round((t - gg) * p + gg); b = Math.round((t - b) * p + b);
  return `rgb(${r},${gg},${b})`;
}
