// Contour world map on <canvas>.
//
// Speed strategy:
//  1. Geometry is projected ONCE into "world units" and cut into spatial chunks (Path2D + bbox),
//     so a render only touches chunks that are on screen.
//  2. The heavy part (geometry + labels) is rendered into an off-screen SNAPSHOT that is
//     30% larger than the viewport. While the user drags/zooms we only scale/shift that
//     snapshot (one drawImage) and redraw pins; a crisp re-render happens when the gesture
//     ends, or mid-gesture if the snapshot gets too blurry or runs out of margin.
//  3. Label collisions use a grid hash instead of a flat list.
/* global d3, topojson */

const W0 = 1000;                       // projected world width in world units
const CELL = 50;                       // geometry chunk size in world units
const MARGIN = 0.3;                    // snapshot margin around the viewport (fraction)
const PIN_COLORS = { visited: "#d8312b", wish: "#e8a317" };
export const COLOR_VARS = ["desk", "water", "land", "visited", "coast", "border", "admin1", "river", "grat",
  "label", "label-soft", "label-water", "label-phys", "label-halo", "landmark", "pin-label", "accent"];

export function createMap(canvas, { world50, labels, initialView }) {
  const projection = d3.geoNaturalEarth1().fitWidth(W0, { type: "Sphere" }).precision(0.2);
  const pathGen = d3.geoPath(projection);
  const H0 = pathGen.bounds({ type: "Sphere" })[1][1];
  const P = (g) => new Path2D(pathGen(g) || "");

  const sphere = P({ type: "Sphere" });
  const grat10 = P(d3.geoGraticule().step([10, 10])());
  const grat5 = P(d3.geoGraticule().step([5, 5])());

  const base = buildLayers(world50, true);
  const countries = topojson.feature(world50, world50.objects.countries).features;
  for (const c of countries) c.bounds = d3.geoBounds(c);
  let detail = null, detailLoading = false;

  const areaByA3 = new Map();
  for (const f of countries) areaByA3.set(f.properties.a3, (areaByA3.get(f.properties.a3) || 0) + d3.geoArea(f));
  const items = buildLabelItems(labels, projection, areaByA3);
  let userLabels = [];   // places with status "label"
  let pins = [];         // {id,status,name,wx,wy}
  let visited = new Set();
  let target = null;     // [wx,wy] of a search result marker
  let placed = [];       // labels drawn in the last full render (screen coords at S)
  let clusters = [];     // pin clusters from the last full render (world coords)
  let pinHits = [];      // pin hit areas from the last composite

  // ---------- canvas, snapshot, zoom ----------
  const ctx = canvas.getContext("2d");
  const snap = document.createElement("canvas");
  const sctx = snap.getContext("2d");
  let G = sctx;          // context the label/pin helpers draw into
  let W = 0, H = 0, dpr = 1, T = d3.zoomIdentity, fitK = 1, ready = false;
  let S = null;          // transform the snapshot was rendered at
  let dirty = true, interacting = false, raf = 0;
  const listeners = {};
  const widthCache = new Map();
  const emit = (n, v) => (listeners[n] || []).forEach((f) => f(v));

  const zoom = d3.zoom()
    .translateExtent([[-W0 * 0.3, -H0 * 0.3], [W0 * 1.3, H0 * 1.3]])
    .on("start", (e) => {
      interacting = true;
      if (e.sourceEvent && e.sourceEvent.type === "mousedown") canvas.classList.add("grab");
    })
    .on("end", () => { interacting = false; canvas.classList.remove("grab"); schedule(); emit("moveend"); })
    .on("zoom", (e) => { T = e.transform; schedule(); emit("move"); });
  const sel = d3.select(canvas).call(zoom).on("dblclick.zoom", null);

  function homeTransform() {
    return d3.zoomIdentity.translate((W - W0 * fitK) / 2, (H - H0 * fitK) / 2).scale(fitK);
  }
  function centerT(lon, lat, k) {
    const [wx, wy] = projection([lon, lat]);
    return d3.zoomIdentity.translate(W / 2, H / 2).scale(k).translate(-wx, -wy);
  }
  const kOfZ = (z) => (256 * 2 ** z) / W0;
  // First view: the saved one, else the user's pins, else a world map that fills the screen.
  function startTransform() {
    const v = initialView ? initialView() : null;
    const coverK = Math.max(W / W0, H / H0) * 1.15;
    if (v && v.z != null) return centerT(v.lon, v.lat, kOfZ(v.z));
    if (v && v.points && v.points.length) {
      const xy = v.points.map((p) => projection(p));
      const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      let k = Math.min((W - 120) / Math.max(x1 - x0, 1e-6), (H - 220) / Math.max(y1 - y0, 1e-6));
      k = Math.max(coverK, Math.min(k, kOfZ(5)));
      const ll = projection.invert([(x0 + x1) / 2, (y0 + y1) / 2]);
      return centerT(ll[0], ll[1], k);
    }
    return centerT(30, 20, coverK);
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height; dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    fitK = Math.min(W / W0, (H - 60) / H0) * 0.96;
    zoom.scaleExtent([fitK * 0.8, fitK * 900]).extent([[0, 0], [W, H]]);
    if (!ready) { ready = true; sel.call(zoom.transform, startTransform()); }
    invalidate();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  // ---------- theme colours (CSS custom properties resolved through a probe) ----------
  const C = {};
  const probe = document.createElement("i");
  probe.style.display = "none"; document.body.appendChild(probe);
  function readColors() {
    for (const v of COLOR_VARS) { probe.style.color = `var(--${v})`; C[v] = getComputedStyle(probe).color; }
    invalidate();
  }
  readColors();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readColors);
  const themeObs = new MutationObserver(readColors);
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });

  Promise.all([
    document.fonts.load("italic 400 13px Spectral"), document.fonts.load("600 12px 'Barlow Semi Condensed'"),
    document.fonts.load("500 12px Barlow"), document.fonts.load("400 12px Barlow"),
  ]).catch(() => {}).then(() => { widthCache.clear(); invalidate(); });

  // ---------- frame scheduling ----------
  function invalidate() { dirty = true; schedule(); }
  function schedule() { if (!raf) raf = requestAnimationFrame(frame); }
  const ez = (k = T.k) => Math.log2((k * W0) / 256);   // ≈ web-map zoom level

  function frame() {
    raf = 0;
    if (!W) return;
    const moved = !S || S.k !== T.k || S.x !== T.x || S.y !== T.y;
    if (dirty || (moved && !interacting) || (interacting && snapTooFar())) fullRender();
    composite();
    if (!detail && !detailLoading && ez() >= 3.6) emit("needDetail");
  }
  function snapTooFar() {
    const s = T.k / S.k;
    if (s > 1.7 || s < 0.6) return true;
    // crossing the 1:10m switch also needs a fresh render
    if ((ez() >= 4.2) !== (ez(S.k) >= 4.2) && detail) return true;
    const sx = (x) => ((x - T.x) / T.k) * S.k + S.x + W * MARGIN;
    const sy = (y) => ((y - T.y) / T.k) * S.k + S.y + H * MARGIN;
    return sx(0) < 0 || sy(0) < 0 || sx(W) > W * (1 + 2 * MARGIN) || sy(H) > H * (1 + 2 * MARGIN);
  }

  // ---------- full render into the snapshot ----------
  function fullRender() {
    const ox = W * MARGIN, oy = H * MARGIN, SW = W + 2 * ox, SH = H + 2 * oy;
    const sd = dpr;
    const pw = Math.round(SW * sd), ph = Math.round(SH * sd);
    if (snap.width !== pw || snap.height !== ph) { snap.width = pw; snap.height = ph; }
    const g = sctx, z = ez(), px = 1 / T.k;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, pw, ph);
    g.setTransform(sd * T.k, 0, 0, sd * T.k, sd * (T.x + ox), sd * (T.y + oy));
    const view = [(-ox - T.x) / T.k, (-oy - T.y) / T.k, (SW - ox - T.x) / T.k, (SH - oy - T.y) / T.k];
    const vis = (b) => b[2] >= view[0] && b[0] <= view[2] && b[3] >= view[1] && b[1] <= view[3];
    const fill = (chunks) => { for (const c of chunks) if (vis(c.b)) g.fill(c.p); };
    const stroke = (chunks) => { for (const c of chunks) if (vis(c.b)) g.stroke(c.p); };

    g.fillStyle = C.water; g.fill(sphere);
    g.save(); g.clip(sphere);
    g.strokeStyle = C.grat; g.lineWidth = 0.8 * px; g.stroke(z > 4.6 ? grat5 : grat10);

    const L = z >= 4.2 && detail ? detail : base;
    g.fillStyle = C.land; fill(L.land);
    g.fillStyle = C.visited;
    for (const a3 of visited) { const cs = L.byA3.get(a3); if (cs) fill(cs); }

    if (z >= 3.4) {
      g.strokeStyle = C.admin1; g.lineWidth = 0.7 * px; g.setLineDash([3 * px, 2 * px]);
      stroke(base.admin1); g.setLineDash([]);
    }
    g.strokeStyle = C.river; g.lineCap = "round"; g.lineJoin = "round";
    for (const [r, chunks] of L.rivers) {
      if (r > z * 1.6 + 1) continue;
      g.lineWidth = (r <= 2 ? 1.1 : 0.7) * px; stroke(chunks);
    }
    g.fillStyle = C.water; fill(L.lakes);
    g.strokeStyle = C.coast; g.lineWidth = 0.6 * px; stroke(L.lakes);

    g.strokeStyle = C.border; g.lineWidth = 0.9 * px;
    g.setLineDash([4 * px, 1.8 * px, 1 * px, 1.8 * px]); stroke(L.borders); g.setLineDash([]);
    g.strokeStyle = C.coast; g.lineWidth = 1 * px; stroke(L.coast);
    g.restore();
    g.strokeStyle = C.coast; g.lineWidth = 1.4 * px; g.stroke(sphere);

    // labels in screen space (offset by the margin so they also fill the margin)
    g.setTransform(sd, 0, 0, sd, sd * ox, sd * oy);
    G = g;
    const grid = new Grid();
    layoutPins(grid, z, ox, oy);
    drawLabels(grid, z, ox, oy);
    S = { k: T.k, x: T.x, y: T.y };
    dirty = false;
  }

  // ---------- composite: snapshot + live pins ----------
  function composite() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.desk; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const s = T.k / S.k, ox = W * MARGIN, oy = H * MARGIN;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (T.x - s * (S.x + ox)), dpr * (T.y - s * (S.y + oy)));
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(snap, 0, 0, W + 2 * ox, H + 2 * oy);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    G = ctx;
    drawTarget();
    drawPins();
  }

  // ---------- labels ----------
  function textW(font, ls, t) {
    const key = font + ls + t;
    let w = widthCache.get(key);
    if (w === undefined) { G.font = font; G.letterSpacing = ls + "px"; w = G.measureText(t).width; widthCache.set(key, w); }
    return w;
  }
  function text(t, x, y, font, color, ls = 0, align = "left") {
    G.font = font; G.letterSpacing = ls + "px"; G.textAlign = align; G.textBaseline = "middle";
    G.lineJoin = "round"; G.strokeStyle = C["label-halo"]; G.lineWidth = 3.5; G.strokeText(t, x, y);
    G.fillStyle = color; G.fillText(t, x, y);
  }

  function drawLabels(grid, z, ox, oy) {
    placed = [];
    const all = userLabels.length ? userLabels.concat(items) : items;
    for (const it of all) {
      if (z < it.mz || z > it.xz) continue;
      const sx = T.k * it.wx + T.x, sy = T.k * it.wy + T.y;
      if (sx < -ox - 100 || sy < -oy - 20 || sx > W + ox + 100 || sy > H + oy + 20) continue;
      const s = STYLE[it.st];
      const t = s.upper ? (it.up ||= it.t.toUpperCase()) : it.t;
      const font = s.font(z), ls = s.ls || 0;
      const tw = textW(font, ls, t), th = s.size + 2;
      if (s.area) {
        const box = [sx - tw / 2, sy - th / 2, tw, th];
        if (!grid.free(box, 2)) continue;
        grid.add(box);
        text(t, sx, sy, font, C[s.color], ls, "center");
        placed.push({ it, sx, sy, box });
        continue;
      }
      const r = s.sym ? 4 : 0;
      let box = [sx + r + 3, sy - th / 2, tw, th], align = "left";
      const symBox = [sx - r - 1, sy - r - 1, 2 * r + 2, 2 * r + 2];
      if (!grid.free(symBox, 0)) continue;
      if (!grid.free(box, 1)) {
        box = [sx - r - 3 - tw, sy - th / 2, tw, th]; align = "right";
        if (!grid.free(box, 1)) continue;
      }
      grid.add(box); grid.add(symBox);
      drawSymbol(s.sym, sx, sy);
      text(t, align === "left" ? sx + r + 3 : sx - r - 3, sy, font, C[s.color], ls, align);
      placed.push({ it, sx, sy, box });
    }
  }

  function drawSymbol(sym, x, y) {
    if (!sym) return;
    const g = G;
    g.lineWidth = 1.2;
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
  // Clustering + name placement happen in the full render (so labels avoid pins);
  // the composite redraws pins at the live transform every frame.
  function layoutPins(grid, z, ox, oy) {
    const vis = [];
    for (const p of pins) {
      const sx = T.k * p.wx + T.x, sy = T.k * p.wy + T.y;
      if (sx < -ox - 40 || sy < -oy - 10 || sx > W + ox + 40 || sy > H + oy + 40) continue;
      vis.push({ p, sx, sy });
    }
    vis.sort((a, b) => a.sy - b.sy);
    const cl = [];
    for (const v of vis) {
      const c = cl.find((c) => Math.abs(c.sx - v.sx) < 14 && Math.abs(c.sy - v.sy) < 14);
      if (c) c.list.push(v.p); else cl.push({ sx: v.sx, sy: v.sy, wx: v.p.wx, wy: v.p.wy, list: [v.p] });
    }
    for (const c of cl) {
      grid.add([c.sx - 4, c.sy - 28, 22, 32]);
      if (c.list.length === 1 && z >= 3) {
        const t = c.list[0].name || "";
        const tw = textW("600 13px Barlow, sans-serif", 0, t);
        const box = [c.sx + 19, c.sy - 28, tw, 16];
        if (t && grid.free(box, 1)) { grid.add(box); c.label = t; }
      }
    }
    clusters = cl;
  }

  function drawPins() {
    pinHits = [];
    const g = G;
    for (const c of clusters) {
      const sx = T.k * c.wx + T.x, sy = T.k * c.wy + T.y;
      if (sx < -40 || sy < -10 || sx > W + 40 || sy > H + 40) continue;
      const top = c.list[0], n = c.list.length;
      if (n > 1) pushpin(sx + 6, sy + 1, PIN_COLORS[c.list[1].status] || PIN_COLORS.visited, 1.05);
      const head = pushpin(sx, sy, PIN_COLORS[top.status] || PIN_COLORS.visited, 1.2);
      if (n > 1) {
        const t = String(n);
        g.font = "600 12px Barlow, sans-serif"; g.letterSpacing = "0px";
        const w = Math.max(18, g.measureText(t).width + 10);
        g.fillStyle = C.label; roundRect(head[0] + 7, head[1] - 16, w, 18, 9); g.fill();
        g.fillStyle = C.land; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(t, head[0] + 7 + w / 2, head[1] - 7);
      } else if (c.label && !interacting) {
        text(c.label, sx + 19, sy - 20, "600 13px Barlow, sans-serif", C.label, 0, "left");
      }
      pinHits.push({ x: head[0], y: head[1], sx, sy, list: c.list });
    }
  }

  function roundRect(x, y, w, h, r) {
    const g = G;
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }

  // a stationery push pin whose needle tip touches (x, y); returns head centre
  function pushpin(x, y, color, s) {
    const g = G, hx = x + 6 * s, hy = y - 17 * s;
    g.fillStyle = "rgba(10,25,40,.22)";
    g.beginPath(); g.ellipse(x + 9 * s, y - 1, 7 * s, 2.6 * s, -0.25, 0, 7); g.fill();
    g.strokeStyle = "#9aa3ab"; g.lineWidth = 1.6 * s; g.lineCap = "round";
    g.beginPath(); g.moveTo(x, y); g.lineTo(hx - 1.5 * s, hy + 6 * s); g.stroke();
    g.fillStyle = shade(color, -0.25);
    g.beginPath(); g.ellipse(hx - 1 * s, hy + 5.5 * s, 3.6 * s, 2.2 * s, -0.5, 0, 7); g.fill();
    const gr = g.createRadialGradient(hx - 2.6 * s, hy - 2.8 * s, 0.5, hx, hy, 8 * s);
    gr.addColorStop(0, shade(color, 0.55)); gr.addColorStop(0.35, color); gr.addColorStop(1, shade(color, -0.45));
    g.fillStyle = gr; g.beginPath(); g.arc(hx, hy, 7.2 * s, 0, 7); g.fill();
    return [hx, hy];
  }

  function drawTarget() {
    if (!target) return;
    const g = G, sx = T.k * target[0] + T.x, sy = T.k * target[1] + T.y;
    g.strokeStyle = C.accent; g.lineWidth = 2;
    g.beginPath(); g.arc(sx, sy, 11, 0, 7); g.stroke();
    g.globalAlpha = 0.35; g.beginPath(); g.arc(sx, sy, 19, 0, 7); g.stroke(); g.globalAlpha = 1;
    g.fillStyle = C.accent; g.beginPath(); g.arc(sx, sy, 2.5, 0, 7); g.fill();
  }

  // ---------- interaction ----------
  // `placed` is in screen coords of transform S; clicks happen after the gesture ends, so S === T.
  function pinAt(x, y) {
    for (let i = pinHits.length - 1; i >= 0; i--) {
      const h = pinHits[i];
      if (Math.hypot(h.x - x, h.y - y) < 11 || Math.hypot(h.sx - x, h.sy - y) < 6) return h;
    }
    for (const p of placed) if (p.it.st === "user" && Math.hypot(p.sx - x, p.sy - y) < 9) return { list: [p.it.place] };
    return null;
  }
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
  function eventXY(e) { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  canvas.addEventListener("click", (e) => {
    const [x, y] = eventXY(e);
    const hit = pinAt(x, y);
    if (hit && hit.list.length === 1) return emit("pin", hit.list[0].id);
    if (hit) {   // cluster: zoom into it
      const k = Math.min(T.k * 4, fitK * 900);
      sel.transition().duration(reduceMotion() ? 0 : 600).call(zoom.scaleTo, k, [hit.sx, hit.sy]);
      return;
    }
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
      const [x, y] = eventXY(lastMove);
      const hit = pinAt(x, y);
      canvas.classList.toggle("point", !!hit);
      emit("hover", hit ? { x, y, list: hit.list } : null);
    });
  });
  canvas.addEventListener("mouseleave", () => emit("hover", null));

  function lonLatAt(x, y) {
    const [wx, wy] = T.invert([x, y]);
    const ll = projection.invert([wx, wy]);
    if (!ll || !isFinite(ll[0]) || Math.abs(ll[1]) > 90) return null;
    const back = projection(ll);
    if (!back || Math.hypot(back[0] - wx, back[1] - wy) > 1) return null;   // outside the map oval
    return ll;
  }

  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- public API ----------
  return {
    on(n, f) { (listeners[n] = listeners[n] || []).push(f); },
    redraw: invalidate,
    zoomLevel: () => ez(),
    setPins(list) {
      pins = []; userLabels = [];
      for (const p of list) {
        const [wx, wy] = projection([p.lon, p.lat]);
        if (p.status === "label") userLabels.push({ t: p.name || "Unnamed", st: "user", wx, wy, mz: -9, xz: 99, lon: p.lon, lat: p.lat, place: p });
        else pins.push({ id: p.id, status: p.status, name: p.name, wx, wy });
      }
      invalidate();
    },
    setVisited(set) { visited = set; invalidate(); },
    setTarget(ll) { target = ll ? projection(ll) : null; schedule(); },
    screenOf(lon, lat) { const [wx, wy] = projection([lon, lat]); return [T.k * wx + T.x, T.k * wy + T.y]; },
    // Country under a point. Simplified coastlines leave seaside towns "in the sea",
    // so if the exact point misses, probe rings of points 4–50 km around it.
    countryAt: makeCountryAt(countries),
    getView() {
      const [wx, wy] = T.invert([W / 2, H / 2]);
      const ll = projection.invert([wx, wy]);
      return ll ? { lon: +ll[0].toFixed(3), lat: +ll[1].toFixed(3), z: +ez().toFixed(2) } : null;
    },
    flyTo(lon, lat, z, offsetX = 0) {
      const [wx, wy] = projection([lon, lat]);
      const k = Math.max((256 * 2 ** z) / W0, fitK);
      const t = d3.zoomIdentity.translate(W / 2 - offsetX, H / 2).scale(k).translate(-wx, -wy);
      return new Promise((res) => {
        sel.transition().duration(reduceMotion() ? 0 : 1100).call(zoom.transform, t).on("end interrupt", () => res());
      });
    },
    zoomBy(f) { sel.transition().duration(reduceMotion() ? 0 : 300).call(zoom.scaleBy, f); },
    home() { sel.transition().duration(reduceMotion() ? 0 : 700).call(zoom.transform, homeTransform()); },
    setDetail(world10) { detail = buildLayers(world10, false); invalidate(); },
    markDetailLoading() { detailLoading = true; },
    // dev helpers
    bench(n = 5) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) { fullRender(); composite(); ctx.getImageData(0, 0, 1, 1); }
      return (performance.now() - t0) / n;
    },
    benchComposite(n = 20) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) { composite(); ctx.getImageData(0, 0, 1, 1); }
      return (performance.now() - t0) / n;
    },
    setZoomLevel(lon, lat, z) {
      const [wx, wy] = projection([lon, lat]); const k = (256 * 2 ** z) / W0;
      sel.call(zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(k).translate(-wx, -wy));
    },
  };

  // ---------- geometry → spatial chunks ----------
  // Every polygon / line is projected once and binned into CELL×CELL world-unit cells;
  // each cell holds one Path2D plus its bounding box, so off-screen cells are skipped.
  function chunk(geoms) {
    const cells = new Map();
    for (const g of geoms) {
      const b = pathGen.bounds(g);
      if (!isFinite(b[0][0])) continue;
      const key = Math.floor((b[0][0] + b[1][0]) / 2 / CELL) + ":" + Math.floor((b[0][1] + b[1][1]) / 2 / CELL);
      let c = cells.get(key);
      if (!c) cells.set(key, (c = { p: new Path2D(), b: [Infinity, Infinity, -Infinity, -Infinity] }));
      c.p.addPath(P(g));
      c.b[0] = Math.min(c.b[0], b[0][0]); c.b[1] = Math.min(c.b[1], b[0][1]);
      c.b[2] = Math.max(c.b[2], b[1][0]); c.b[3] = Math.max(c.b[3], b[1][1]);
    }
    return [...cells.values()];
  }
  function parts(geom) {   // split Multi* geometries into single polygons / lines
    if (!geom) return [];
    if (geom.type === "MultiPolygon") return geom.coordinates.map((c) => ({ type: "Polygon", coordinates: c }));
    if (geom.type === "MultiLineString") return geom.coordinates.map((c) => ({ type: "LineString", coordinates: c }));
    if (geom.type === "GeometryCollection") return geom.geometries.flatMap(parts);
    return [geom];
  }
  function buildLayers(w, withAdmin) {
    const o = w.objects;
    const all = [], byA3Geoms = new Map();
    for (const f of topojson.feature(w, o.countries).features) {
      const ps = parts(f.geometry); all.push(...ps);
      const a3 = f.properties.a3;
      if (!byA3Geoms.has(a3)) byA3Geoms.set(a3, []);
      byA3Geoms.get(a3).push(...ps);
    }
    const byA3 = new Map();
    for (const [a3, gs] of byA3Geoms) byA3.set(a3, chunk(gs));
    const riverGeoms = new Map();
    for (const f of topojson.feature(w, o.rivers).features) {
      const r = Math.max(0, Math.round(f.properties.r ?? 6));
      if (!riverGeoms.has(r)) riverGeoms.set(r, []);
      riverGeoms.get(r).push(...parts(f.geometry));
    }
    return {
      land: chunk(all), byA3,
      coast: chunk(parts(topojson.mesh(w, o.countries, (a, b) => a === b))),
      borders: chunk(parts(topojson.mesh(w, o.countries, (a, b) => a !== b))),
      lakes: chunk(topojson.feature(w, o.lakes).features.flatMap((f) => parts(f.geometry))),
      rivers: [...riverGeoms.entries()].sort((a, b) => a[0] - b[0]).map(([r, gs]) => [r, chunk(gs)]),
      admin1: withAdmin && o.admin1 ? chunk(parts(topojson.mesh(w, o.admin1))) : [],
    };
  }
}

// Country under a point. Simplified coastlines leave seaside towns "in the sea",
// so if the exact point misses, probe rings of points 4–50 km around it.
export function makeCountryAt(countries) {
  for (const c of countries) c.bounds ||= d3.geoBounds(c);
  const hit = ([x, y]) => countries.find((c) => {
    const [[bx0, by0], [bx1, by1]] = c.bounds;
    if (y < by0 - 0.01 || y > by1 + 0.01) return false;
    if (bx0 <= bx1 && (x < bx0 - 0.01 || x > bx1 + 0.01)) return false;
    return d3.geoContains(c, [x, y]);
  });
  return (lon, lat) => {
    let f = hit([lon, lat]);
    const cos = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    for (const km of [4, 10, 25, 50]) {
      if (f) break;
      const d = km / 111;
      for (let a = 0; a < 12 && !f; a++) {
        const t = (a * Math.PI) / 6;
        f = hit([lon + (d * Math.cos(t)) / cos, lat + d * Math.sin(t)]);
      }
    }
    return f ? { a3: f.properties.a3, iso: f.properties.iso, name: f.properties.name } : null;
  };
}

// label styles: font(z) returns a canvas font string
const ser = (s) => () => `italic 400 ${s}px Spectral, Georgia, serif`;
export const STYLE = {
  ocean:   { font: ser(17), size: 17, ls: 4, color: "label-water", area: true },
  sea:     { font: ser(13), size: 13, ls: 1, color: "label-water", area: true },
  lake:    { font: ser(12), size: 12, color: "label-water", area: true },
  country: { font: (z) => `600 ${z > 4 ? 14 : 12}px 'Barlow Semi Condensed', sans-serif`, size: 13, ls: 1.6, upper: true, color: "label-soft", area: true },
  region:  { font: ser(13), size: 13, ls: 2, color: "label-phys", area: true },
  capital: { font: () => "600 13px Barlow, sans-serif", size: 13, color: "label", sym: "cap" },
  city:    { font: () => "400 12px Barlow, sans-serif", size: 12, color: "label", sym: "dot" },
  peak:    { font: () => "400 11px Barlow, sans-serif", size: 11, color: "label-phys", sym: "peak" },
  landmark:{ font: () => "500 12px Barlow, sans-serif", size: 12, color: "landmark", sym: "mark" },
  island:  { font: ser(11), size: 11, color: "label-soft", sym: "tick" },
  user:    { font: () => "600 12px Barlow, sans-serif", size: 12, color: "label", sym: "user" },
};

export function buildLabelItems(L, projection, areaByA3) {
  const out = [];
  const add = (t, st, lon, lat, mz, xz, extra) => {
    const p = projection([lon, lat]);
    if (!p) return;
    out.push({ t, st, wx: p[0], wy: p[1], mz, xz, lon, lat, ...extra });
  };
  for (const [n, kind, lon, lat, mz] of L.water) {
    if (kind === "ocean") add(n, "ocean", lon, lat, Math.min(mz, 1), 6, { kind });
  }
  for (const [n, a3, iso, lon, lat, mz] of L.countries) {
    const tiny = (areaByA3.get(a3) || 0) < 2.5e-5;          // microstates: only when zoomed far in
    add(n, "country", lon, lat, tiny ? 6.8 : mz - 0.3, tiny ? 10 : 7.2, { kind: "country", iso });
  }
  for (const [n, iso, pop, lon, lat, mz, cap] of L.cities) {
    if (cap) add(n, "capital", lon, lat, Math.max(1.5, mz - 1.2), 99, { kind: "capital", iso, pop });
  }
  for (const [n, kind, lon, lat] of L.landmarks) add(n, "landmark", lon, lat, 3.3, 99, { kind });
  for (const [n, kind, lon, lat, mz] of L.water) {
    if (kind !== "ocean" && kind !== "lake") add(n, "sea", lon, lat, mz - 0.5, 9, { kind });
  }
  const REGION = ["range", "desert", "plateau", "plain", "basin", "tundra", "delta", "peninsula", "valley", "wetland", "isthmus"];
  for (const [n, kind, lon, lat, mz] of L.physical) if (REGION.includes(kind)) add(n, "region", lon, lat, mz - 0.3, 8, { kind });
  for (const [n, iso, pop, lon, lat, mz, cap] of L.cities) {
    if (!cap) add(n, "city", lon, lat, mz - 0.6, 99, { kind: "city", iso, pop });
  }
  for (const [n, kind, lon, lat, mz] of L.water) if (kind === "lake") add(n, "lake", lon, lat, mz, 99, { kind });
  for (const [n, kind, lon, lat, mz, elev] of L.physical) {
    if (kind === "peak") add(elev ? `${n} ${elev.toLocaleString("en-US")}` : n, "peak", lon, lat, mz, 99, { kind, name: n });
  }
  for (const [n, kind, lon, lat, mz] of L.physical) {
    if (["island", "islands", "cape", "waterfall", "pole"].includes(kind)) add(n, "island", lon, lat, mz + 0.5, 99, { kind });
  }
  return out;
}

// grid-hashed collision boxes (64 px cells)
export class Grid {
  constructor() { this.c = new Map(); }
  *cells([x, y, w, h], pad) {
    for (let i = Math.floor((x - pad) / 64); i <= Math.floor((x + w + pad) / 64); i++)
      for (let j = Math.floor((y - pad) / 64); j <= Math.floor((y + h + pad) / 64); j++) yield i * 100003 + j;
  }
  free(b, pad) {
    const [x, y, w, h] = b;
    for (const k of this.cells(b, pad)) {
      const list = this.c.get(k);
      if (!list) continue;
      for (const [bx, by, bw, bh] of list)
        if (x < bx + bw + pad && x + w + pad > bx && y < by + bh + pad && y + h + pad > by) return false;
    }
    return true;
  }
  add(b) {
    for (const k of this.cells(b, 0)) { let l = this.c.get(k); if (!l) this.c.set(k, (l = [])); l.push(b); }
  }
}

export function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const t = f < 0 ? 0 : 255, p = Math.abs(f);
  r = Math.round((t - r) * p + r); g = Math.round((t - g) * p + g); b = Math.round((t - b) * p + b);
  return `rgb(${r},${g},${b})`;
}
