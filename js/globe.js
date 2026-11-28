// Globe view: the same map on an orthographic "planet" you can spin endlessly.
//
// Unlike the flat map, every frame re-projects the geometry (the rotation changes it),
// so speed comes from:
//   • level of detail: 1:110m while spinning, 1:50m at rest, 1:10m when zoomed in;
//   • culling: geometry is cut into ~20° chunks with a bounding circle, and only chunks
//     on the visible side of the planet (and inside the screen when zoomed in) are drawn;
//   • rivers / province lines only at rest.
// The public API mirrors js/map.js, so the app works with either.
/* global d3, topojson */
import { COLOR_VARS, STYLE, Grid, buildLabelItems, makeCountryAt, shade, pickPin, snapRadius } from "./map.js?v=20261128114801";

const PIN_COLORS = { visited: "#d8312b", wish: "#e8a317" };
const DEG = 180 / Math.PI, RAD = Math.PI / 180;
const SPHERE = { type: "Sphere" };

export function createGlobe(canvas, { world50, world110, labels, initialView }) {
  const countries = topojson.feature(world50, world50.objects.countries).features;
  const countryAt = makeCountryAt(countries);
  const areaByA3 = new Map();
  for (const f of countries) areaByA3.set(f.properties.a3, (areaByA3.get(f.properties.a3) || 0) + d3.geoArea(f));
  const items = buildLabelItems(labels, (ll) => ll, areaByA3);
  const lod = { low: buildLayers(world110, false), mid: buildLayers(world50, true), high: null };
  const grat10 = d3.geoGraticule().step([10, 10])();
  const grat5 = d3.geoGraticule().step([5, 5])();
  let detailLoading = false;

  let userLabels = [], pins = [], visited = new Set(), target = null;
  let placed = [], pinHits = [];

  // ---------- view state ----------
  const proj = d3.geoOrthographic().clipAngle(90);
  const path = d3.geoPath(proj);
  let rot = [-30, -25, 0];        // d3 rotate = [-centre lon, -centre lat]
  let R = 300;                    // globe radius in CSS px
  let W = 0, H = 0, dpr = 1, ready = false, raf = 0, interacting = false;
  const ctx = canvas.getContext("2d");
  path.context(ctx);
  const listeners = {};
  const emit = (n, v) => (listeners[n] || []).forEach((f) => f(v));
  const widthCache = new Map();

  // whole planet visible, clear of the search bar on top
  const fitR = () => Math.max(120, Math.min(W / 2 - (W < 600 ? 16 : 40), (H - 140) / 2));
  const rOfZ = (z) => (256 * 2 ** z) / (2 * Math.PI);
  const ez = (r = R) => Math.log2((2 * Math.PI * r) / 256);
  const clampR = (r) => Math.max(fitR() * 0.6, Math.min(rOfZ(10.5), r));
  const centre = () => [-rot[0], -rot[1]];

  // ---------- colours ----------
  const C = {};
  const probe = document.createElement("i");
  probe.style.display = "none"; document.body.appendChild(probe);
  function readColors() {
    for (const v of COLOR_VARS) { probe.style.color = `var(--${v})`; C[v] = getComputedStyle(probe).color; }
    schedule();
  }
  readColors();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readColors);
  new MutationObserver(readColors).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  Promise.all([
    document.fonts.load("italic 400 13px Spectral"), document.fonts.load("600 12px 'Barlow Semi Condensed'"),
    document.fonts.load("500 12px Barlow"), document.fonts.load("400 12px Barlow"),
  ]).catch(() => {}).then(() => { widthCache.clear(); schedule(); });

  // ---------- size & start view ----------
  function resize() {
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height; dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    if (!ready) { ready = true; startView(); }
    R = clampR(R);
    schedule();
  }
  function startView() {
    const v = initialView ? initialView() : null;
    if (v && v.z != null) { rot = [-v.lon, -v.lat, 0]; R = clampR(rOfZ(v.z)); return; }
    if (v && v.points && v.points.length) {
      const c = d3.geoCentroid({ type: "MultiPoint", coordinates: v.points });
      const spread = Math.max(...v.points.map((p) => d3.geoDistance(c, p)));
      rot = [-c[0], -c[1], 0];
      R = spread > 0.9 ? fitR() : clampR(Math.min(rOfZ(5), (Math.min(W, H) / 2 - 70) / Math.sin(Math.max(spread, 0.05) + 0.08)));
      R = Math.max(R, fitR());
      return;
    }
    rot = [-30, -25, 0]; R = fitR();
  }
  new ResizeObserver(resize).observe(canvas);

  // ---------- gestures: d3.zoom as the input source (mouse, touch, pinch, wheel) ----------
  let last = d3.zoomIdentity, vel = [0, 0], lastT = 0, inertiaRaf = 0;
  const zoom = d3.zoom()
    .scaleExtent([1e-6, 1e9])
    .on("start", (e) => {
      if (!e.sourceEvent) return;
      stopAnim(); interacting = true; vel = [0, 0]; lastT = performance.now();
      if (e.sourceEvent.type === "mousedown") canvas.classList.add("grab");
    })
    .on("zoom", (e) => {
      const t = e.transform;
      if (!e.sourceEvent) { last = t; return; }
      const kr = t.k / last.k;
      if (Math.abs(kr - 1) > 1e-6) R = clampR(R * kr);
      else {
        const dx = t.x - last.x, dy = t.y - last.y, now = performance.now(), dt = Math.max(1, now - lastT);
        rotateBy(dx, dy);
        vel = [0.6 * vel[0] + 0.4 * (dx / dt), 0.6 * vel[1] + 0.4 * (dy / dt)];
        lastT = now;
      }
      last = t;
      schedule(); emit("move");
    })
    .on("end", (e) => {
      if (!e.sourceEvent) return;
      canvas.classList.remove("grab");
      if (performance.now() - lastT < 80 && Math.hypot(vel[0], vel[1]) > 0.08) inertia();
      else { interacting = false; schedule(); emit("moveend"); }
    });
  const sel = d3.select(canvas).call(zoom).on("dblclick.zoom", null);

  function rotateBy(dx, dy) {
    const k = DEG / R;
    rot = [rot[0] + dx * k, Math.max(-89, Math.min(89, rot[1] - dy * k)), 0];
  }
  // keep spinning after a fling, slowing down
  function inertia() {
    let prev = performance.now();
    const step = (now) => {
      const dt = Math.min(48, now - prev); prev = now;
      rotateBy(vel[0] * dt, vel[1] * dt);
      const f = Math.pow(0.94, dt / 16);
      vel = [vel[0] * f, vel[1] * f];
      draw(); emit("move");
      if (Math.hypot(vel[0], vel[1]) > 0.01) inertiaRaf = requestAnimationFrame(step);
      else { inertiaRaf = 0; interacting = false; schedule(); emit("moveend"); }
    };
    inertiaRaf = requestAnimationFrame(step);
  }
  let animRaf = 0;
  function stopAnim() {
    if (inertiaRaf) cancelAnimationFrame(inertiaRaf);
    if (animRaf) cancelAnimationFrame(animRaf);
    inertiaRaf = animRaf = 0;
  }

  // animate to a centre + radius; great-circle path, radius eased in log space
  function animateTo(lon, lat, r1, ms = 1100) {
    stopAnim();
    const c0 = centre(), r0 = R, gi = d3.geoInterpolate(c0, [lon, lat]);
    const dist = d3.geoDistance(c0, [lon, lat]);
    // pull back a little on long trips so the eye follows the globe
    const outR = Math.min(r0, r1, dist > 0.6 ? fitR() : Infinity);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    return new Promise((res) => {
      const t0 = performance.now();
      interacting = true;
      const step = (now) => {
        const t = reduce ? 1 : Math.min(1, (now - t0) / ms), e = d3.easeCubicInOut(t);
        const c = gi(e);
        rot = [-c[0], -c[1], 0];
        const lr = t < 0.5 ? Math.log(r0) + (Math.log(outR) - Math.log(r0)) * d3.easeCubicOut(t * 2)
          : Math.log(outR) + (Math.log(r1) - Math.log(outR)) * d3.easeCubicIn((t - 0.5) * 2);
        R = clampR(Math.exp(lr));
        draw(); emit("move");
        if (t < 1) animRaf = requestAnimationFrame(step);
        else { animRaf = 0; interacting = false; schedule(); emit("moveend"); res(); }
      };
      animRaf = requestAnimationFrame(step);
    });
  }

  // ---------- render ----------
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }

  function draw() {
    if (!W) return;
    const z = ez();
    proj.rotate(rot).scale(R).translate([W / 2, H / 2]).precision(interacting ? 0.9 : 0.35);
    proj.clipExtent(R > Math.max(W, H) * 0.6 ? [[-20, -20], [W + 20, H + 20]] : null);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.desk; ctx.fillRect(0, 0, W, H);

    // soft atmosphere around the planet
    if (R < Math.max(W, H)) {
      const gr = ctx.createRadialGradient(W / 2, H / 2, R * 0.97, W / 2, H / 2, R * 1.13);
      gr.addColorStop(0, "rgba(110,165,205,.38)"); gr.addColorStop(1, "rgba(110,165,205,0)");
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(W / 2, H / 2, R * 1.13, 0, 7); ctx.fill();
    }
    ctx.beginPath(); path(SPHERE); ctx.fillStyle = C.water; ctx.fill();
    ctx.beginPath(); path(z > 4.6 ? grat5 : grat10); ctx.strokeStyle = C.grat; ctx.lineWidth = 0.7; ctx.stroke();

    // detail: 1:110m while spinning far out, 1:50m while spinning close / at rest,
    // 1:10m at rest when zoomed in (and while spinning only when very close)
    const L = lod.high && z >= 5 && (!interacting || z >= 9.5) ? lod.high : interacting && z < 4.5 ? lod.low : lod.mid;
    // Filling continents is the costly part (clipping big polygons at the horizon). Far out,
    // 1 px is >8 km, so the light 1:110m fill under the detailed coastline looks identical.
    const F = z < 4.6 ? lod.low : L;
    const vis = visibility();
    const fillChunks = (chunks) => { ctx.beginPath(); for (const c of chunks) if (vis(c)) path(c.geom); ctx.fill(); };
    const strokeChunks = (chunks) => { ctx.beginPath(); for (const c of chunks) if (vis(c)) path(c.geom); ctx.stroke(); };

    ctx.fillStyle = C.land; fillChunks(F.land);
    if (visited.size) {
      ctx.fillStyle = C.visited; ctx.beginPath();
      for (const a3 of visited) for (const c of (F.byA3.get(a3) || L.byA3.get(a3) || [])) if (vis(c)) path(c.geom);
      ctx.fill();
    }
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    if (!interacting && z >= 3.4 && lod.mid.admin1.length) {
      ctx.strokeStyle = C.admin1; ctx.lineWidth = 0.7; ctx.setLineDash([3, 2]); strokeChunks(lod.mid.admin1); ctx.setLineDash([]);
    }
    if (!interacting || z >= 5) {
      ctx.strokeStyle = C.river;
      for (const [r, chunks] of L.rivers) { if (r > z * 1.6 + 1) continue; ctx.lineWidth = r <= 2 ? 1.1 : 0.7; strokeChunks(chunks); }
    }
    ctx.fillStyle = C.water; fillChunks(F.lakes);
    ctx.strokeStyle = C.coast; ctx.lineWidth = 0.6; strokeChunks(F.lakes);
    ctx.strokeStyle = C.border; ctx.lineWidth = 0.9; ctx.setLineDash([4, 1.8, 1, 1.8]); strokeChunks(L.borders); ctx.setLineDash([]);
    ctx.strokeStyle = C.coast; ctx.lineWidth = 1; strokeChunks(L.coast);

    // light from the upper left, a darker limb: reads as a sphere
    if (R < Math.max(W, H) * 1.2) {
      const sh = ctx.createRadialGradient(W / 2 - R * 0.35, H / 2 - R * 0.4, R * 0.1, W / 2, H / 2, R * 1.02);
      sh.addColorStop(0, "rgba(255,255,255,.10)"); sh.addColorStop(0.65, "rgba(255,255,255,0)"); sh.addColorStop(1, "rgba(10,30,50,.16)");
      ctx.fillStyle = sh; ctx.beginPath(); path(SPHERE); ctx.fill();
      ctx.beginPath(); path(SPHERE); ctx.strokeStyle = C.coast; ctx.lineWidth = 1.2; ctx.stroke();
    }

    const grid = new Grid();
    const clusters = layoutPins(grid, z);
    drawLabels(grid, z);
    drawTarget();
    drawPins(clusters);

    if (!lod.high && !detailLoading && z >= 4.4) emit("needDetail");
  }

  // which chunks face us (and, when zoomed in, fall inside the screen)
  function visibility() {
    const c = centre();
    const far = Math.hypot(W, H) / 2;
    const viewAng = far >= R ? Math.PI / 2 : Math.asin(far / R);
    return (ch) => d3.geoDistance(c, ch.c) < viewAng + ch.r + 0.02;
  }

  // screen position of a point on the visible hemisphere, else null
  let cLon = 0, cSinLat = 0, cCosLat = 1;
  function front() { const c = centre(); cLon = c[0] * RAD; cSinLat = Math.sin(c[1] * RAD); cCosLat = Math.cos(c[1] * RAD); }
  function sxy(lon, lat, margin = 0.04) {
    const la = lat * RAD;
    const dot = cSinLat * Math.sin(la) + cCosLat * Math.cos(la) * Math.cos(lon * RAD - cLon);
    if (dot < margin) return null;
    return proj([lon, lat]);
  }

  // ---------- labels (same styles as the flat map) ----------
  function textW(font, ls, t) {
    const key = font + ls + t;
    let w = widthCache.get(key);
    if (w === undefined) { ctx.font = font; ctx.letterSpacing = ls + "px"; w = ctx.measureText(t).width; widthCache.set(key, w); }
    return w;
  }
  function text(t, x, y, font, color, ls = 0, align = "left") {
    ctx.font = font; ctx.letterSpacing = ls + "px"; ctx.textAlign = align; ctx.textBaseline = "middle";
    ctx.lineJoin = "round"; ctx.strokeStyle = C["label-halo"]; ctx.lineWidth = 3.5; ctx.strokeText(t, x, y);
    ctx.fillStyle = color; ctx.fillText(t, x, y);
  }
  function drawLabels(grid, z) {
    placed = [];
    // when the planet's edge is on screen, keep every label inside the disc
    const edge = R < Math.hypot(W, H) / 2, cx = W / 2, cy = H / 2, r2 = (R - 2) ** 2;
    const inDisc = ([x, y, w, h]) => !edge || [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]
      .every(([px, py]) => (px - cx) ** 2 + (py - cy) ** 2 < r2);
    const budget = interacting ? 140 : 1e9;   // fewer labels while spinning
    let n = 0;
    const all = userLabels.length ? userLabels.concat(items) : items;
    for (const it of all) {
      if (z < it.mz || z > it.xz) continue;
      const p = sxy(it.lon, it.lat, STYLE[it.st].area ? 0.25 : 0.06);
      if (!p) continue;
      const [sx, sy] = p;
      if (sx < -100 || sy < -20 || sx > W + 100 || sy > H + 20) continue;
      const s = STYLE[it.st];
      const t = s.upper ? (it.up ||= it.t.toUpperCase()) : it.t;
      const font = s.font(z), ls = s.ls || 0;
      const tw = textW(font, ls, t), th = s.size + 2;
      if (s.area) {
        const box = [sx - tw / 2, sy - th / 2, tw, th];
        if (!inDisc(box) || !grid.free(box, 2)) continue;
        grid.add(box); text(t, sx, sy, font, C[s.color], ls, "center");
        placed.push({ it, sx, sy, box });
      } else {
        const r = s.sym ? 4 : 0;
        let box = [sx + r + 3, sy - th / 2, tw, th], align = "left";
        const symBox = [sx - r - 1, sy - r - 1, 2 * r + 2, 2 * r + 2];
        if (!grid.free(symBox, 0)) continue;
        if (!inDisc(box) || !grid.free(box, 1)) {
          box = [sx - r - 3 - tw, sy - th / 2, tw, th]; align = "right";
          if (!inDisc(box) || !grid.free(box, 1)) continue;
        }
        grid.add(box); grid.add(symBox);
        drawSymbol(s.sym, sx, sy);
        text(t, align === "left" ? sx + r + 3 : sx - r - 3, sy, font, C[s.color], ls, align);
        placed.push({ it, sx, sy, box });
      }
      if (++n >= budget) break;
    }
  }
  function drawSymbol(sym, x, y) {
    if (!sym) return;
    const g = ctx; g.lineWidth = 1.2;
    if (sym === "dot" || sym === "cap") {
      g.fillStyle = C.label; g.beginPath(); g.arc(x, y, sym === "cap" ? 3.2 : 2.3, 0, 7); g.fill();
      if (sym === "cap") { g.strokeStyle = C.label; g.beginPath(); g.arc(x, y, 5.2, 0, 7); g.stroke(); }
    } else if (sym === "peak") {
      g.fillStyle = C["label-phys"]; g.beginPath(); g.moveTo(x, y - 4.5); g.lineTo(x + 4.5, y + 3.5); g.lineTo(x - 4.5, y + 3.5); g.closePath(); g.fill();
    } else if (sym === "mark") {
      g.fillStyle = C.landmark; g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x + 5, y); g.lineTo(x, y + 5); g.lineTo(x - 5, y); g.closePath(); g.fill();
      g.strokeStyle = C["label-halo"]; g.lineWidth = 1; g.stroke();
    } else if (sym === "user") {
      g.fillStyle = C["pin-label"]; g.strokeStyle = C["label-halo"]; g.beginPath(); g.arc(x, y, 3.6, 0, 7); g.fill(); g.stroke();
    } else if (sym === "tick") {
      g.fillStyle = C["label-soft"]; g.beginPath(); g.arc(x, y, 1.8, 0, 7); g.fill();
    }
  }

  // ---------- pins ----------
  function layoutPins(grid, z) {
    front();
    const vis = [];
    for (const p of pins) {
      const s = sxy(p.lon, p.lat, 0.02);
      if (!s || s[0] < -40 || s[1] < -10 || s[0] > W + 40 || s[1] > H + 40) continue;
      vis.push({ p, sx: s[0], sy: s[1] });
    }
    vis.sort((a, b) => a.sy - b.sy);
    const cl = [];
    for (const v of vis) {
      const c = cl.find((c) => Math.abs(c.sx - v.sx) < 14 && Math.abs(c.sy - v.sy) < 14);
      if (c) c.list.push(v.p); else cl.push({ sx: v.sx, sy: v.sy, list: [v.p] });
    }
    for (const c of cl) {
      grid.add([c.sx - 4, c.sy - 28, 22, 32]);
      if (c.list.length === 1 && z >= 3 && !interacting) {
        const t = c.list[0].name || "";
        const tw = textW("600 13px Barlow, sans-serif", 0, t);
        const box = [c.sx + 19, c.sy - 28, tw, 16];
        if (t && grid.free(box, 1)) { grid.add(box); c.label = t; c.labelW = tw; }
      }
    }
    return cl;
  }
  function drawPins(clusters) {
    pinHits = [];
    for (const c of clusters) {
      const top = c.list[0], n = c.list.length;
      if (n > 1) pushpin(c.sx + 6, c.sy + 1, PIN_COLORS[c.list[1].status] || PIN_COLORS.visited, 1.05);
      const head = pushpin(c.sx, c.sy, PIN_COLORS[top.status] || PIN_COLORS.visited, 1.2);
      if (n > 1) {
        const t = String(n);
        ctx.font = "600 12px Barlow, sans-serif"; ctx.letterSpacing = "0px";
        const w = Math.max(18, ctx.measureText(t).width + 10);
        ctx.fillStyle = C.label; roundRect(head[0] + 7, head[1] - 16, w, 18, 9); ctx.fill();
        ctx.fillStyle = C.land; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(t, head[0] + 7 + w / 2, head[1] - 7);
      } else if (c.label) text(c.label, c.sx + 19, c.sy - 20, "600 13px Barlow, sans-serif", C.label, 0, "left");
      pinHits.push({ x: head[0], y: head[1], sx: c.sx, sy: c.sy, list: c.list, label: c.label ? [c.sx + 19, c.sy - 28, c.labelW, 16] : null });
    }
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function pushpin(x, y, color, s) {
    const g = ctx, hx = x + 6 * s, hy = y - 17 * s;
    g.fillStyle = "rgba(10,25,40,.22)"; g.beginPath(); g.ellipse(x + 9 * s, y - 1, 7 * s, 2.6 * s, -0.25, 0, 7); g.fill();
    g.strokeStyle = "#9aa3ab"; g.lineWidth = 1.6 * s; g.lineCap = "round";
    g.beginPath(); g.moveTo(x, y); g.lineTo(hx - 1.5 * s, hy + 6 * s); g.stroke();
    g.fillStyle = shade(color, -0.25); g.beginPath(); g.ellipse(hx - 1 * s, hy + 5.5 * s, 3.6 * s, 2.2 * s, -0.5, 0, 7); g.fill();
    const gr = g.createRadialGradient(hx - 2.6 * s, hy - 2.8 * s, 0.5, hx, hy, 8 * s);
    gr.addColorStop(0, shade(color, 0.55)); gr.addColorStop(0.35, color); gr.addColorStop(1, shade(color, -0.45));
    g.fillStyle = gr; g.beginPath(); g.arc(hx, hy, 7.2 * s, 0, 7); g.fill();
    return [hx, hy];
  }
  function drawTarget() {
    if (!target) return;
    const p = sxy(target[0], target[1], 0.02); if (!p) return;
    const [sx, sy] = p;
    ctx.strokeStyle = C.accent; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, sy, 11, 0, 7); ctx.stroke();
    ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.arc(sx, sy, 19, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = C.accent; ctx.beginPath(); ctx.arc(sx, sy, 2.5, 0, 7); ctx.fill();
  }

  // ---------- clicks & hover ----------
  const pinAt = (x, y, r = snapRadius()) => pickPin(pinHits, placed, x, y, r);
  function nearestFeature(x, y) {
    let best = null, bd = 1e9;
    for (const p of placed) {
      if (p.it.st === "user" || p.it.st === "country" || p.it.st === "ocean") continue;
      const point = !STYLE[p.it.st].area;
      const [bx, by, bw, bh] = p.box;
      const d = point ? Math.hypot(p.sx - x, p.sy - y)
        : Math.hypot(Math.max(bx - x, 0, x - bx - bw), Math.max(by - y, 0, y - by - bh)) + 12;
      if (d < (point ? 16 : 26) && d < bd) { bd = d; best = p.it; }
    }
    return best;
  }
  function lonLatAt(x, y) {
    if (Math.hypot(x - W / 2, y - H / 2) > R) return null;
    const ll = proj.invert([x, y]);
    return ll && isFinite(ll[0]) && isFinite(ll[1]) ? ll : null;
  }
  const xy = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener("click", (e) => {
    const [x, y] = xy(e);
    const hit = pinAt(x, y);
    if (hit && hit.list.length === 1) return emit("pin", hit.list[0].id);
    if (hit) { const p = hit.list[0]; animateTo(p.lon, p.lat, clampR(R * 4), 700); return; }
    const ll = lonLatAt(x, y);
    if (!ll) return;
    const f = nearestFeature(x, y);
    emit("mapclick", { x, y, lon: f ? f.lon : ll[0], lat: f ? f.lat : ll[1], feature: f, rawLon: ll[0], rawLat: ll[1] });
  });
  let hoverRaf = 0, lastMove = null;
  canvas.addEventListener("mousemove", (e) => {
    lastMove = e;
    if (hoverRaf || interacting) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const [x, y] = xy(lastMove);
      const hit = pinAt(x, y);
      canvas.classList.toggle("point", !!hit);
      emit("hover", hit ? { x, y, list: hit.list } : null);
    });
  });
  canvas.addEventListener("mouseleave", () => emit("hover", null));

  // ---------- public API (same as the flat map) ----------
  return {
    kind: "globe",
    on(n, f) { (listeners[n] = listeners[n] || []).push(f); },
    redraw: schedule,
    zoomLevel: () => ez(),
    setPins(list) {
      pins = []; userLabels = [];
      for (const p of list) {
        if (p.status === "label") userLabels.push({ t: p.name || "Unnamed", st: "user", mz: -9, xz: 99, lon: p.lon, lat: p.lat, place: p });
        else pins.push({ id: p.id, status: p.status, name: p.name, lon: p.lon, lat: p.lat });
      }
      schedule();
    },
    setVisited(set) { visited = set; schedule(); },
    setTarget(ll) { target = ll; schedule(); },
    screenOf(lon, lat) { front(); return sxy(lon, lat, -1) || [-9999, -9999]; },
    countryAt,
    nearestPin(x, y, max = 70) { const h = pickPin(pinHits, placed, x, y, max); return h && h.list.length === 1 ? h.list[0].id : null; },
    getView() { return { lon: +(-rot[0]).toFixed(3), lat: +(-rot[1]).toFixed(3), z: +ez().toFixed(2) }; },
    // offsetY > 0 shows the target above the centre (clear of a bottom sheet)
    flyTo(lon, lat, z, offsetX = 0, offsetY = 0) {
      const r1 = clampR(Math.max(rOfZ(z), R));
      const lat2 = Math.max(-85, Math.min(85, lat - (offsetY / r1) * DEG));
      const lon2 = lon + (offsetX / r1) * DEG / Math.max(0.2, Math.cos(lat * RAD));
      return animateTo(lon2, lat2, r1);
    },
    zoomBy(f) { const c = centre(); return animateTo(c[0], c[1], clampR(R * f), 300); },
    home() { const c = centre(); return animateTo(c[0], c[1], fitR(), 700); },
    setDetail(w) {
      // chunking the 1:10m data takes a moment; do it when the browser is idle
      const go = () => { lod.high = buildLayers(w, false); schedule(); };
      (window.requestIdleCallback || setTimeout)(go);
    },
    markDetailLoading() { detailLoading = true; },
    setZoomLevel(lon, lat, z) { rot = [-lon, -lat, 0]; R = clampR(rOfZ(z)); draw(); },
    bench(n = 5) { const t0 = performance.now(); for (let i = 0; i < n; i++) { draw(); ctx.getImageData(0, 0, 1, 1); } return (performance.now() - t0) / n; },
    benchSpin(n = 20) {
      interacting = true;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) { rotateBy(9, 2); draw(); ctx.getImageData(0, 0, 1, 1); }
      interacting = false; schedule();
      return (performance.now() - t0) / n;
    },
  };
}

// ---------- geometry → chunks with bounding circles ----------
function parts(geom) {
  if (!geom) return [];
  if (geom.type === "MultiPolygon") return geom.coordinates.map((c) => ({ type: "Polygon", coordinates: c }));
  if (geom.type === "MultiLineString") return geom.coordinates.flatMap((c) => splitLine(c));
  if (geom.type === "LineString") return splitLine(geom.coordinates);
  if (geom.type === "GeometryCollection") return geom.geometries.flatMap(parts);
  return [geom];
}
// long coastlines / borders → pieces of ≤64 points, so only the visible pieces get projected
function splitLine(coords, n = 64) {
  if (coords.length <= n) return [{ type: "LineString", coordinates: coords }];
  const out = [];
  for (let i = 0; i < coords.length - 1; i += n - 1) out.push({ type: "LineString", coordinates: coords.slice(i, i + n) });
  return out;
}
function radiusOf(g, c) {
  let r = 0;
  const rings = g.type === "Polygon" ? g.coordinates : [g.coordinates];
  for (const ring of rings) {
    const step = Math.max(1, Math.floor(ring.length / 60));
    for (let i = 0; i < ring.length; i += step) r = Math.max(r, d3.geoDistance(c, ring[i]));
  }
  return r + 0.01;
}
function chunk(geoms, cell = 20) {
  const cells = new Map();
  for (const g of geoms) {
    const c = d3.geoCentroid(g);
    if (!isFinite(c[0])) continue;
    const key = Math.floor((c[0] + 180) / cell) + ":" + Math.floor((c[1] + 90) / cell);
    let ch = cells.get(key);
    if (!ch) cells.set(key, (ch = { list: [], cs: [] }));
    ch.list.push(g); ch.cs.push([c, radiusOf(g, c)]);
  }
  return [...cells.values()].map(({ list, cs }) => {
    const geom = { type: "GeometryCollection", geometries: list };
    const c = d3.geoCentroid({ type: "MultiPoint", coordinates: cs.map((x) => x[0]) });
    let r = 0;
    for (const [pc, pr] of cs) r = Math.max(r, d3.geoDistance(c, pc) + pr);
    return { geom, c: isFinite(c[0]) ? c : cs[0][0], r: Math.min(Math.PI, r) };
  });
}
function buildLayers(w, withAdmin) {
  const o = w.objects;
  const all = [], byA3G = new Map();
  for (const f of topojson.feature(w, o.countries).features) {
    const ps = parts(f.geometry); all.push(...ps);
    const a3 = f.properties.a3;
    if (!byA3G.has(a3)) byA3G.set(a3, []);
    byA3G.get(a3).push(...ps);
  }
  const byA3 = new Map();
  for (const [a3, gs] of byA3G) byA3.set(a3, chunk(gs));
  const riverG = new Map();
  for (const f of topojson.feature(w, o.rivers).features) {
    const r = Math.max(0, Math.round(f.properties.r ?? 6));
    if (!riverG.has(r)) riverG.set(r, []);
    riverG.get(r).push(...parts(f.geometry));
  }
  return {
    land: chunk(all), byA3,
    coast: chunk(parts(topojson.mesh(w, o.countries, (a, b) => a === b)), 6),
    borders: chunk(parts(topojson.mesh(w, o.countries, (a, b) => a !== b)), 6),
    lakes: chunk(topojson.feature(w, o.lakes).features.flatMap((f) => parts(f.geometry))),
    rivers: [...riverG.entries()].sort((a, b) => a[0] - b[0]).map(([r, gs]) => [r, chunk(gs, 6)]),
    admin1: withAdmin && o.admin1 ? chunk(parts(topojson.mesh(w, o.admin1)), 6) : [],
  };
}
