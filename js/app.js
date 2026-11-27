// Pinmap — app wiring: map, search, pins, place cards, photos, photo import, backup.
/* global exifr */
import { createMap } from "./map.js";
import { createSearch, searchOnline, kindLabel, zoomFor } from "./search.js";
import * as store from "./store.js";
import * as sync from "./sync.js";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { createGlobe } from "./globe.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

const STATUS = [
  { id: "visited", label: "Visited", color: "var(--pin-visited)" },
  { id: "wish", label: "Want to go", color: "var(--pin-wish)" },
  { id: "label", label: "Label only", color: "var(--pin-label)" },
];
const statusOf = (id) => STATUS.find((s) => s.id === id) || STATUS[0];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fmtVisit = (v) => (v.m ? MONTHS[v.m - 1] + " " : "") + v.y;
const fmtVisitShort = (v) => (v.m ? MONTHS[v.m - 1].slice(0, 3) + " " : "") + v.y;

const state = { places: new Map(), current: null, draft: null, filter: "all", results: [], sel: -1, pick: null };
const imp = { groups: [], urls: [] };
let map, search;

// ---------------- boot ----------------
// view mode: "globe" (default) or "flat"
const MODE_KEY = "pinmap:mode";
const mode = (() => { try { return localStorage.getItem(MODE_KEY) === "flat" ? "flat" : "globe"; } catch { return "globe"; } })();

(async function boot() {
  const [world50, labels, persistent, world110] = await Promise.all([
    fetch("data/world50.json").then((r) => r.json()),
    fetch("data/labels.json").then((r) => r.json()),
    store.init(),
    mode === "globe" ? fetch("data/world110.json").then((r) => r.json()) : null,
  ]);
  if (!persistent) toast("Storage is unavailable here — your pins will be lost when the page reloads.", 6000);
  for (const p of await store.allPlaces()) state.places.set(p.id, p);
  sync.on("status", renderAccount);
  sync.on("profile", () => renderAccount(sync.getStatus(), true));
  sync.on("data", reloadFromStore);
  await sync.init({ url: SUPABASE_URL, key: SUPABASE_KEY, fake: new URLSearchParams(location.search).has("fake") });
  renderAccount(sync.getStatus());

  map = mode === "globe" ? createGlobe($("#map"), { world50, world110, labels, initialView }) : createMap($("#map"), { world50, labels, initialView });
  window.__map = map;   // handy for debugging in the console
  $("#zView").title = $("#zView").ariaLabel = mode === "globe" ? "Switch to flat map" : "Switch to globe";
  $("#zView").innerHTML = mode === "globe" ? ICON_FLAT : ICON_GLOBE;
  search = createSearch(labels);
  await repairPlaces();
  refresh();
  map.on("moveend", saveView);

  map.on("mapclick", onMapClick);
  map.on("pin", onPinClick);
  map.on("hover", onHover);
  map.on("move", () => { positionPopover(); positionPeek(); });
  map.on("needDetail", loadDetail);
  setTimeout(loadDetail, 2500);
})().catch((e) => { console.error(e); toast("Could not load map data: " + e.message, 8000); });

function loadDetail() {
  if (loadDetail.started) return;
  loadDetail.started = true; map.markDetailLoading();
  fetch("data/world10.json").then((r) => r.json()).then((w) => map.setDetail(w)).catch(() => {});
}

// another device changed something: reload the local copy and redraw what's open
let reloading = false;
async function reloadFromStore() {
  if (reloading || !map) return;
  reloading = true;
  try {
    const fresh = await store.allPlaces();
    state.places.clear();
    for (const p of fresh) state.places.set(p.id, migrate(p));
    refresh();
    if (state.current) {
      if (!state.places.has(state.current)) closeCard();
      else {
        const p = state.places.get(state.current);
        if (document.activeElement !== $("#cName")) $("#cName").value = p.name;
        if (document.activeElement !== $("#cNotes")) $("#cNotes").value = p.notes || "";
        $("#cStatus").innerHTML = chipsHTML(p.status);
        renderVisits(); renderPhotos();
      }
    }
    if (peek.id && !state.places.has(peek.id)) hidePeek();
  } finally { reloading = false; }
}

// start view: last view on this device, else the user's pins, else a full-screen world
function initialView() {
  try { const v = JSON.parse(localStorage.getItem("pinmap:view")); if (v && isFinite(v.z)) return v; } catch { /* no storage */ }
  const pts = [...state.places.values()].filter((p) => p.status !== "label").map((p) => [p.lon, p.lat]);
  return pts.length ? { points: pts } : null;
}
let viewTimer;
function saveView() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => { try { localStorage.setItem("pinmap:view", JSON.stringify(map.getView())); } catch { /* ignore */ } }, 500);
}

// bring older records up to date: dates → visits, "lived" → "visited", missing country
async function repairPlaces() {
  for (const p of state.places.values()) {
    const before = JSON.stringify(p);
    migrate(p);
    if (p.status === "lived") p.status = "visited";
    if (!p.a3 && p.status !== "label") {
      const c = map.countryAt(p.lon, p.lat);
      if (c) { p.a3 = c.a3; p.country = p.country || c.name; }
    }
    if (JSON.stringify(p) !== before) await store.putPlace(p);
  }
}

// older records stored from/to dates; now a place keeps a list of {y, m} visits
function migrate(p) {
  if (!Array.isArray(p.visits)) {
    p.visits = [];
    if (p.from) p.visits.push({ y: +p.from.slice(0, 4), m: +p.from.slice(5, 7) || 0 });
    delete p.from; delete p.to;
  }
  return p;
}
function addVisit(p, v) {
  if (!v.y || p.visits.some((x) => x.y === v.y && x.m === v.m)) return;
  p.visits.push(v);
  p.visits.sort((a, b) => b.y - a.y || b.m - a.m);
}

function refresh() {
  const list = [...state.places.values()];
  map.setPins(list);
  map.setVisited(new Set(list.filter((p) => p.status === "visited" && p.a3).map((p) => p.a3)));
  $("#count").textContent = list.filter((p) => p.status !== "label").length;
  $("#hint").hidden = list.length > 0 || !!state.pick;
  if (!$("#list").hidden) renderList();
}

// ---------------- toast / tooltip ----------------
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("on");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), ms);
}
function onHover(h) {
  const tip = $("#tip");
  const single = h && h.list.length === 1;
  // a single pin shows the photo preview (desktop hover); clusters and pick mode keep the tooltip
  if (single && !state.pick && matchMedia("(hover: hover)").matches) {
    tip.hidden = true;
    clearTimeout(peek.hideTimer);
    clearTimeout(peek.showTimer);
    const id = h.list[0].id;
    peek.showTimer = setTimeout(() => showPeek(id, false), 160);
    return;
  }
  clearTimeout(peek.showTimer);
  if (!peek.pinned) peek.hideTimer = setTimeout(() => { if (!peek.over) hidePeek(); }, 300);
  if (!h) { tip.hidden = true; return; }
  if (single && !state.pick) { tip.hidden = true; return; }   // touch screens: the tap opens the preview
  tip.textContent = state.pick && single ? `Add photos to “${h.list[0].name}”` : `${h.list.length} places — click to zoom in`;
  tip.style.left = h.x + 14 + "px"; tip.style.top = h.y + 10 + "px"; tip.hidden = false;
}

// ---------------- new pin popover ----------------
function chipsHTML(active) {
  return STATUS.map((s) => `<button class="chip" data-s="${s.id}" aria-pressed="${s.id === active}"><i style="background:${s.color}"></i>${s.label}</button>`).join("");
}

function onMapClick({ x, y, lon, lat, feature }) {
  if (!$("#peek").hidden) { hidePeek(); return; }   // first tap outside just closes the preview
  const country = map.countryAt(lon, lat);
  // missed a pin by a little? offer it in the popover
  const nearId = state.pick ? null : map.nearestPin?.(x, y, 70);
  openPopover({ name: feature ? feature.name || feature.t : "", kind: feature ? feature.kind : "", lon, lat, country, source: feature ? "map" : "click", nearId });
}
function onPinClick(id) {
  if (state.pick) return attachAndDrop(state.pick, id).then(() => endPick());
  showPeek(id, true);
}

// On a phone every panel is a bottom sheet, so only one may be open at a time.
const isPhone = () => innerWidth <= 700;
function onlySheet(keep) {
  if (!isPhone()) return;
  if (keep !== "list" && !$("#list").hidden) toggleList(false);
  if (keep !== "card" && !$("#card").hidden) closeCard();
  if (keep !== "import") $("#import").hidden = true;   // pending photo groups stay; the camera button brings them back
  if (keep !== "peek") hidePeek();
  if (keep !== "pop" && !$("#pop").hidden) closePopover();
  updateImportBadge();
}

function openPopover(d) {
  closeResults();
  onlySheet("pop"); hidePeek();
  state.draft = { ...d, status: state.draft?.status && state.draft.status !== "label" ? state.draft.status : "visited" };
  $("#pName").value = d.name || "";
  $("#pName").placeholder = "Name this place";
  const where = d.country?.name || d.countryName || "";
  $("#pMeta").textContent = [d.kind ? kindLabel(d.kind) : "", where, fmtLL(d.lon, d.lat)].filter(Boolean).join(" · ");
  $("#pStatus").innerHTML = chipsHTML(state.draft.status);
  const near = d.nearId && state.places.get(d.nearId);
  $("#pNear").hidden = !near;
  if (near) {
    $("#pNear").innerHTML = `<i style="background:${statusOf(near.status).color}"></i><span>Open <b>${esc(near.name)}</b> instead</span>`;
    $("#pNear").dataset.id = near.id;
  }
  $("#pAdd").textContent = state.pick ? `Pin it + add ${plural(state.pick.files.length, "photo")}` : "Stick a pin";
  map.setTarget([d.lon, d.lat]);
  $("#pop").hidden = false;
  $("#pickBar").hidden = true;          // the popover itself says the photos will be added
  positionPopover();
  if (!d.name) $("#pName").focus();
}
function closePopover() {
  $("#pop").hidden = true; state.draft = null; map.setTarget(null);
  if (state.pick) $("#pickBar").hidden = false;
}
function positionPopover() {
  const pop = $("#pop");
  if (pop.hidden || !state.draft || innerWidth <= 700) return;
  const [x, y] = map.screenOf(state.draft.lon, state.draft.lat);
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let left = x + 24, top = y - h / 2;
  if (left + w > innerWidth - 12) left = x - w - 24;
  top = Math.max(70, Math.min(innerHeight - h - 12, top));
  pop.style.left = Math.max(12, left) + "px"; pop.style.top = top + "px";
}
$("#pStatus").addEventListener("click", (e) => {
  const b = e.target.closest(".chip"); if (!b || !state.draft) return;
  state.draft.status = b.dataset.s; $("#pStatus").innerHTML = chipsHTML(b.dataset.s);
  if (!state.pick) $("#pAdd").textContent = b.dataset.s === "label" ? "Add to map" : "Stick a pin";
});
$("#pCancel").addEventListener("click", closePopover);
$("#pNear").addEventListener("click", () => { const id = $("#pNear").dataset.id; closePopover(); showPeek(id, true); });
$("#pName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#pAdd").click(); });
$("#pAdd").addEventListener("click", async () => {
  const d = state.draft; if (!d) return;
  const p = await createPlace({ name: $("#pName").value, lon: d.lon, lat: d.lat, status: d.status, kind: d.kind, country: d.country, countryName: d.countryName, source: d.source });
  closePopover();
  if (state.pick) {
    await attachAndDrop(state.pick, p.id);
    endPick();
    if (!imp.groups.length) openCard(p.id);
  } else openCard(p.id);
});

async function createPlace({ name, lon, lat, status = "visited", kind = "", country, countryName = "", source = "click" }) {
  country = country || map.countryAt(lon, lat);
  const p = {
    id: store.uid(), name: (name || "").trim() || "Unnamed place", lon: +lon.toFixed(5), lat: +lat.toFixed(5),
    status, kind: kind || "", a3: country?.a3 || "", country: country?.name || countryName || "",
    notes: "", visits: [], createdAt: Date.now(), source,
  };
  await store.putPlace(p);
  state.places.set(p.id, p);
  refresh();
  return p;
}

// ---------------- place card ----------------
let saveTimer, photoURLs = [];
async function openCard(id) {
  const p = state.places.get(id); if (!p) return;
  closePopover(); hidePeek(); onlySheet("card");
  state.current = id;
  $("#cName").value = p.name;
  $("#cMeta").textContent = [p.kind ? kindLabel(p.kind) : "", p.country, fmtLL(p.lon, p.lat)].filter(Boolean).join(" · ");
  $("#cStatus").innerHTML = chipsHTML(p.status);
  $("#cNotes").value = p.notes || "";
  $("#cSaved").textContent = p.updatedAt ? "Saved " + new Date(p.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
  renderVisits();
  resetDelete();
  $("#card").hidden = false;
  await renderPhotos();
}
function closeCard() { $("#card").hidden = true; state.current = null; revokePhotos(); }

function scheduleSave() {
  const p = state.places.get(state.current); if (!p) return;
  p.name = $("#cName").value.trim() || "Unnamed place";
  p.notes = $("#cNotes").value;
  $("#cSaved").textContent = "Saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { await store.putPlace(p); $("#cSaved").textContent = "Saved"; refresh(); }, 400);
}
["#cName", "#cNotes"].forEach((s) => $(s).addEventListener("input", scheduleSave));
$("#cStatus").addEventListener("click", async (e) => {
  const b = e.target.closest(".chip"); const p = state.places.get(state.current); if (!b || !p) return;
  p.status = b.dataset.s; $("#cStatus").innerHTML = chipsHTML(p.status);
  renderVisits();
  await store.putPlace(p); refresh();
});

// visits ("June 2026")
(function fillVisitSelects() {
  const now = new Date();
  $("#vMonth").innerHTML = `<option value="0">Month (optional)</option>` + MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
  $("#vMonth").value = String(now.getMonth() + 1);
  let y = "";
  for (let i = now.getFullYear(); i >= 1950; i--) y += `<option>${i}</option>`;
  $("#vYear").innerHTML = y;
})();
function renderVisits() {
  const p = state.places.get(state.current); if (!p) return;
  $("#cVisitsBox").hidden = p.status === "label" || p.status === "wish";
  $("#cVisits").innerHTML = p.visits.length
    ? p.visits.map((v, i) => `<span class="vchip">${esc(fmtVisit(v))}<button data-rm="${i}" aria-label="Remove ${esc(fmtVisit(v))}">×</button></span>`).join("")
    : `<span class="saved">No date yet — photos with a date fill this in automatically.</span>`;
}
$("#vAdd").addEventListener("click", async () => {
  const p = state.places.get(state.current); if (!p) return;
  addVisit(p, { y: +$("#vYear").value, m: +$("#vMonth").value });
  renderVisits(); await store.putPlace(p); refresh();
});
$("#cVisits").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-rm]"); const p = state.places.get(state.current); if (!b || !p) return;
  p.visits.splice(+b.dataset.rm, 1);
  renderVisits(); await store.putPlace(p); refresh();
});

function resetDelete() { const b = $("#cDelete"); b.textContent = "Delete place"; b.dataset.armed = ""; }
$("#cDelete").addEventListener("click", async () => {
  const b = $("#cDelete");
  if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Click again to delete with photos"; setTimeout(resetDelete, 4000); return; }
  const id = state.current;
  await store.deletePlace(id); state.places.delete(id);
  closeCard(); refresh(); toast("Place deleted");
});

// photos inside a card
function revokePhotos() { photoURLs.forEach((u) => URL.revokeObjectURL(u)); photoURLs = []; }
let cardPhotos = [], photoRender = 0;
// image of a photo as an object URL; downloads it from the cloud if this device doesn't have it yet
async function photoURL(ph, kind) {
  const b = ph[kind] || (await sync.fetchBlob(ph, kind)) || (kind === "blob" ? ph.thumb || (await sync.fetchBlob(ph, "thumb")) : null);
  return b ? URL.createObjectURL(b) : null;
}
async function renderPhotos() {
  revokePhotos();
  if (!state.current) return;
  const token = ++photoRender;
  cardPhotos = await store.photosOf(state.current);
  if (token !== photoRender) return;
  $("#cPhotos").innerHTML = cardPhotos.map((ph, i) =>
    `<div class="ph"><button class="ph-open" data-i="${i}" aria-label="Open photo ${i + 1}"><img alt=""></button><button class="del" data-del="${esc(ph.id)}" aria-label="Remove photo">×</button></div>`
  ).join("") + `<div class="drop">${cardPhotos.length ? "Drop more photos here" : "Drop photos here or use “Add photos”"}</div>`;
  cardPhotos.forEach(async (ph, i) => {
    const u = await photoURL(ph, "thumb");
    if (!u) return;
    if (token !== photoRender) return URL.revokeObjectURL(u);
    photoURLs.push(u);
    const img = $(`#cPhotos [data-i="${i}"] img`); if (img) img.src = u;
  });
}
$("#cPhotos").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) { await store.deletePhoto(del.dataset.del); await renderPhotos(); return; }
  const ph = e.target.closest("[data-i]");
  if (ph) openLightbox(cardPhotos, +ph.dataset.i);
});
$("#cFiles").addEventListener("change", async (e) => {
  const files = [...e.target.files]; e.target.value = "";
  if (!state.current || !files.length) return;
  const metas = await readPhotos(files);
  await attachGroup({ files: metas, visits: visitsOf(metas) }, state.current);
});
const cardDrop = $("#cPhotos");
cardDrop.addEventListener("dragover", (e) => { e.preventDefault(); cardDrop.classList.add("dragover"); });
cardDrop.addEventListener("dragleave", () => cardDrop.classList.remove("dragover"));
cardDrop.addEventListener("drop", async (e) => {
  e.preventDefault(); cardDrop.classList.remove("dragover");
  const files = [...e.dataTransfer.files].filter(isImage);
  if (!state.current || !files.length) return;
  const metas = await readPhotos(files);
  await attachGroup({ files: metas, visits: visitsOf(metas) }, state.current);
});

async function resizeImage(file, max, q) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", q));
  return [blob, c.width, c.height];
}

// ---------------- photo import: read EXIF, group, suggest places ----------------
const isImage = (f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name);

async function readPhotos(files) {
  const out = [];
  for (const file of files) {
    const m = { file, thumb: null, lat: null, lon: null, date: null };
    try {
      const d = await exifr.parse(file, { gps: true, tiff: true, exif: true });
      if (d && isFinite(d.latitude) && isFinite(d.longitude) && (d.latitude || d.longitude)) { m.lat = d.latitude; m.lon = d.longitude; }
      const dt = d && (d.DateTimeOriginal || d.CreateDate || d.ModifyDate);
      if (dt instanceof Date && !isNaN(dt)) m.date = dt;
    } catch { /* no EXIF */ }
    try { [m.thumb] = await resizeImage(file, 480, 0.8); } catch { m.broken = true; }
    out.push(m);
  }
  return out;
}
function visitsOf(metas) {
  const seen = new Map();
  for (const m of metas) if (m.date) { const k = m.date.getFullYear() * 100 + m.date.getMonth() + 1; seen.set(k, { y: m.date.getFullYear(), m: m.date.getMonth() + 1 }); }
  return [...seen.values()].sort((a, b) => b.y - a.y || b.m - a.m);
}
const km = (a, b) => Math.hypot((a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180) * 111.32, (a.lat - b.lat) * 110.57);

async function startImport(files) {
  files = files.filter(isImage);
  if (!files.length) return;
  closeCard(); toggleList(false); closePopover(); hidePeek(); endPick(false);
  $("#import").hidden = false;
  $("#importNote").textContent = "";
  $("#groups").innerHTML = `<p class="empty">Reading ${plural(files.length, "photo")}…</p>`;
  await search.loadGazetteer("data/gazetteer.json");
  const metas = await readPhotos(files);
  const broken = metas.filter((m) => m.broken);
  const ok = metas.filter((m) => !m.broken);
  const placesList = [...state.places.values()].filter((p) => p.status !== "label");
  const groups = [];
  for (const m of ok) {
    if (m.lat == null) {
      const key = m.date ? `${m.date.getFullYear()}-${m.date.getMonth()}` : "nodate";
      let g = groups.find((g) => g.noLoc === key);
      if (!g) groups.push((g = { noLoc: key, files: [] }));
      g.files.push(m); continue;
    }
    const near = placesList.map((p) => ({ p, d: km(p, m) })).filter((x) => x.d < 25).sort((a, b) => a.d - b.d)[0];
    let g = near ? groups.find((g) => g.pinId === near.p.id)
      : groups.find((g) => !g.pinId && g.lat != null && km(g, m) < 12);
    if (!g) groups.push((g = near ? { pinId: near.p.id, files: [] } : { lat: m.lat, lon: m.lon, files: [] }));
    g.files.push(m);
    if (!g.pinId) {   // running centroid
      const n = g.files.length;
      g.lat += (m.lat - g.lat) / n; g.lon += (m.lon - g.lon) / n;
    }
  }
  for (const g of groups) {
    g.id = store.uid();
    g.visits = visitsOf(g.files);
    if (g.lat != null && !g.pinId) suggest(g);
  }
  // groups with a location first, then those that need a decision
  imp.groups.push(...groups.sort((a, b) => (a.noLoc ? 1 : 0) - (b.noLoc ? 1 : 0)));
  if (broken.length) toast(`${plural(broken.length, "photo")} couldn't be opened by this browser (HEIC?). Try JPEG.`, 6000);
  renderGroups();
}
function suggest(g) {
  const s = search.nearest(g.lon, g.lat, 40);
  const c = map.countryAt(g.lon, g.lat);
  g.country = c; g.countryName = c?.name || s?.country || ""; g.kind = s?.sight ? s.kind : s ? "city" : "";
  g.name = s && (s.sight || s.km < 15) ? s.name : "";
  g.where = s ? `${s.km < 1.5 ? "In" : "Near"} ${s.name}${g.countryName ? ", " + g.countryName : ""}` : g.countryName ? `Somewhere in ${g.countryName}` : "Location found in photos";
}

function visitsText(vs) {
  if (!vs?.length) return "";
  const t = vs.slice(0, 3).map(fmtVisit).join(", ");
  return vs.length > 3 ? t + "…" : t;
}
function renderGroups() {
  imp.urls.forEach((u) => URL.revokeObjectURL(u)); imp.urls = [];
  updateImportBadge();
  if (!imp.groups.length) { $("#import").hidden = true; return; }
  const total = imp.groups.reduce((n, g) => n + g.files.length, 0);
  $("#importNote").textContent = `${plural(total, "photo")} to place. Location and date come from the photos themselves; check and confirm each group.`;
  const others = [...state.places.values()].filter((p) => p.status !== "label").sort((a, b) => a.name.localeCompare(b.name));
  $("#groups").innerHTML = imp.groups.map((g) => {
    const thumbs = g.files.slice(0, 5).map((f) => { const u = URL.createObjectURL(f.thumb); imp.urls.push(u); return `<img src="${u}" alt="">`; }).join("")
      + (g.files.length > 5 ? `<span>+${g.files.length - 5}</span>` : "");
    const head = `<div class="strip">${thumbs}</div><b>${plural(g.files.length, "photo")}${g.visits.length ? " · " + esc(visitsText(g.visits)) : ""}</b>`;
    const skip = `<button class="linkbtn muted" data-act="skip">Skip</button>`;
    if (g.pinId) {
      const p = state.places.get(g.pinId);
      return `<div class="group" data-g="${g.id}">${head}<small>Taken near your place “${esc(p?.name)}”</small>
        <div class="row"><button class="btn primary" data-act="attach">Add to ${esc(p?.name)}</button><button class="btn ghost" data-act="new">New place</button><button class="linkbtn" data-act="show">Show</button>${skip}</div></div>`;
    }
    if (g.lat != null) {
      return `<div class="group" data-g="${g.id}">${head}<small>${esc(g.where)}</small>
        <input data-name value="${esc(g.name)}" placeholder="Name this place" aria-label="Place name">
        <div class="row"><button class="btn primary" data-act="create">Stick a pin</button><button class="linkbtn" data-act="show">Show on map</button>${skip}</div></div>`;
    }
    return `<div class="group" data-g="${g.id}">${head}<small>No location saved in these photos</small>
      <div class="row"><button class="btn primary" data-act="pick">Choose on map</button>${skip}</div>
      ${others.length ? `<select data-act="to" aria-label="Add to one of your places"><option value="">…or add to one of your places</option>${others.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select>` : ""}</div>`;
  }).join("");
}
const groupById = (id) => imp.groups.find((g) => g.id === id);
function dropGroup(g) { imp.groups = imp.groups.filter((x) => x !== g); renderGroups(); }

$("#groups").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]"); if (!b || b.tagName === "SELECT") return;
  const box = b.closest("[data-g]"); const g = groupById(box?.dataset.g); if (!g) return;
  const act = b.dataset.act;
  if (act === "skip") return dropGroup(g);
  if (act === "show") {
    const c = g.pinId ? state.places.get(g.pinId) : g;
    map.setTarget([c.lon, c.lat]);
    return map.flyTo(c.lon, c.lat, 7.5, innerWidth > 700 ? -180 : 0);
  }
  if (act === "new") {   // detach from the nearby pin, make it its own place
    const f0 = g.files[0]; delete g.pinId; g.lat = f0.lat; g.lon = f0.lon; suggest(g); return renderGroups();
  }
  if (act === "pick") return startPick(g);
  b.disabled = true;
  if (act === "attach") { await attachGroup(g, g.pinId); dropGroup(g); }
  if (act === "create") {
    const p = await createPlace({ name: box.querySelector("[data-name]").value || g.name, lon: g.lon, lat: g.lat, kind: g.kind, country: g.country, countryName: g.countryName, source: "photo" });
    await attachGroup(g, p.id); dropGroup(g); map.setTarget(null);
  }
});
$("#groups").addEventListener("change", async (e) => {
  const s = e.target.closest('select[data-act="to"]'); if (!s || !s.value) return;
  const g = groupById(s.closest("[data-g]").dataset.g);
  await attachGroup(g, s.value); dropGroup(g);
});

// save a group's photos into a place; dates from the photos become visits
async function attachGroup(g, placeId) {
  const p = state.places.get(placeId); if (!p) return;
  const files = g.files.filter((f) => !f.broken);
  let done = 0;
  for (const f of files) {
    toast(`Saving photos ${++done}/${files.length}…`, 10000);
    try {
      const [blob, w, h] = await resizeImage(f.file, 2048, 0.86);
      const thumb = f.thumb || (await resizeImage(f.file, 480, 0.8))[0];
      await store.putPhoto({ id: store.uid(), placeId, blob, thumb, w, h, name: f.file.name, takenAt: f.date ? +f.date : null, addedAt: Date.now() });
    } catch { done--; }
  }
  if (p.status === "wish" && g.visits?.length) p.status = "visited";
  for (const v of g.visits || []) addVisit(p, v);
  await store.putPlace(p);
  refresh();
  if (state.current === placeId) { renderVisits(); $("#cStatus").innerHTML = chipsHTML(p.status); await renderPhotos(); }
  toast(done ? `${plural(done, "photo")} added to ${p.name}` : "No photos could be saved", 3000);
}

// "Choose on map" for photos without GPS: next map click / pin click / search result decides
function startPick(g) {
  state.pick = g;
  $("#import").hidden = true; $("#hint").hidden = true;
  $("#pickText").textContent = `Where ${g.files.length === 1 ? "was this photo" : `were these ${g.files.length} photos`} taken? Click the map, a pin, or search.`;
  $("#pickBar").hidden = false;
}
function endPick(reopen = true) {
  if (!state.pick) return;
  state.pick = null;
  $("#pickBar").hidden = true;
  if (reopen && imp.groups.length) openImportPanel();
  updateImportBadge();
  refresh();
}
$("#pickCancel").addEventListener("click", () => { closePopover(); endPick(); });
// attach a picked group, then remove it from the import list
async function attachAndDrop(g, id) { await attachGroup(g, id); if (imp.groups.includes(g)) dropGroup(g); }

// photos waiting to be placed: the camera button shows their count and reopens the panel
function updateImportBadge() {
  const n = imp.groups.reduce((k, g) => k + g.files.length, 0);
  const waiting = n > 0 && $("#import").hidden && !state.pick;
  $("#btnPhotos").dataset.file = waiting ? "" : "importFiles";
  let b = $("#btnPhotos .count");
  if (waiting) { if (!b) { b = document.createElement("span"); b.className = "count"; $("#btnPhotos").appendChild(b); } b.textContent = n; }
  else b?.remove();
}
function openImportPanel() { onlySheet("import"); $("#import").hidden = false; updateImportBadge(); }
$("#btnPhotos").addEventListener("click", () => { if (!$("#btnPhotos").dataset.file && imp.groups.length) openImportPanel(); });

// top-bar button + drag & drop anywhere on the map
$("#importFiles").addEventListener("change", (e) => { const f = [...e.target.files]; e.target.value = ""; startImport(f); });
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
addEventListener("dragenter", (e) => { if (hasFiles(e)) { dragDepth++; $("#dropzone").hidden = !!e.target.closest?.("#card"); } });
addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); $("#dropzone").hidden = !!e.target.closest?.("#card"); } });
addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("#dropzone").hidden = true; });
addEventListener("drop", (e) => {
  dragDepth = 0; $("#dropzone").hidden = true;
  if (!hasFiles(e) || e.target.closest?.("#card")) return;
  e.preventDefault();
  startImport([...e.dataTransfer.files]);
});

// ---------------- endless photo strips (preview and full screen) ----------------
// A copy of the last photo goes before the first and a copy of the first after the last.
// When scrolling settles on a copy, the strip silently jumps to the real photo, so
// "next" after the last photo is the first one, and "previous" before the first is the last.
const loopOrder = (n) => (n > 1 ? [n - 1, ...Array.from({ length: n }, (_, i) => i), 0] : Array.from({ length: n }, (_, i) => i));
function loopTrack(track, n, start, onIndex) {
  track._off?.();
  const w = () => track.clientWidth || 1;
  const pos = () => Math.round(track.scrollLeft / w());
  const real = () => (n > 1 ? (pos() - 1 + n) % n : pos());
  let timer = 0;
  const settle = () => {
    if (n > 1) {
      const i = pos();
      if (i === 0) track.scrollLeft = n * w();          // copy of the last → the real last
      else if (i === n + 1) track.scrollLeft = w();     // copy of the first → the real first
    }
    onIndex?.(real());
  };
  const onScroll = () => { onIndex?.(real()); clearTimeout(timer); timer = setTimeout(settle, 140); };
  track.addEventListener("scroll", onScroll, { passive: true });
  track.addEventListener("scrollend", settle);
  track._off = () => { track.removeEventListener("scroll", onScroll); track.removeEventListener("scrollend", settle); clearTimeout(timer); };
  requestAnimationFrame(() => { track.scrollLeft = (start + (n > 1 ? 1 : 0)) * w(); onIndex?.(start); });
}
const stepTrack = (track, d) => track.scrollBy({ left: d * track.clientWidth, behavior: "smooth" });

// lightbox
let lbURLs = [];
function openLightbox(photos, i) {
  const track = $("#lbTrack");
  lbURLs = [];
  track.innerHTML = loopOrder(photos.length).map((j) => `<figure data-i="${j}"><img alt="Photo ${j + 1}"></figure>`).join("");
  photos.forEach(async (ph, j) => {
    const u = await photoURL(ph, "blob");
    if (!u) return;
    if ($("#lightbox").hidden) return URL.revokeObjectURL(u);
    lbURLs.push(u);
    track.querySelectorAll(`[data-i="${j}"] img`).forEach((img) => { img.src = u; });
  });
  $("#lightbox").hidden = false;
  $("#lbPrev").hidden = $("#lbNext").hidden = photos.length < 2;
  loopTrack(track, photos.length, i);
  $("#lbClose").focus();
}
function closeLightbox() { $("#lightbox").hidden = true; $("#lbTrack")._off?.(); $("#lbTrack").innerHTML = ""; lbURLs.forEach((u) => URL.revokeObjectURL(u)); lbURLs = []; }
function lbStep(d) { stepTrack($("#lbTrack"), d); }
$("#lbPrev").addEventListener("click", () => lbStep(-1));
$("#lbNext").addEventListener("click", () => lbStep(1));
$("#lbClose").addEventListener("click", closeLightbox);

// ---------------- pin preview ("peek"): photos at a glance ----------------
const peek = { id: null, pinned: false, over: false, photos: [], urls: [], showTimer: 0, hideTimer: 0 };
async function showPeek(id, pinned) {
  const p = state.places.get(id); if (!p) return;
  clearTimeout(peek.hideTimer);
  if (peek.id === id && !$("#peek").hidden) { peek.pinned ||= pinned; return; }
  peek.id = id; peek.pinned = pinned;
  closePopover(); onlySheet("peek");
  $("#pkName").textContent = p.name;
  $("#pkMeta").textContent = [p.status === "wish" ? "Want to go" : p.visits?.map(fmtVisit).slice(0, 2).join(", "), p.country].filter(Boolean).join(" · ");
  $("#pkNotes").textContent = (p.notes || "").trim();
  $("#pkNotes").hidden = !p.notes?.trim();
  const photos = await store.photosOf(id);
  if (peek.id !== id) return;
  peek.urls.forEach((u) => URL.revokeObjectURL(u));
  peek.photos = photos;
  peek.urls = [];
  $("#pkTrack").innerHTML = loopOrder(photos.length).map((i) => `<button class="pk-slide" data-i="${i}" aria-label="Open photo ${i + 1}"><img alt=""></button>`).join("");
  photos.forEach(async (ph, i) => {
    const u = await photoURL(ph, ph.blob ? "blob" : "thumb");
    if (!u) return;
    if (peek.id !== id) return URL.revokeObjectURL(u);
    peek.urls.push(u);
    document.querySelectorAll(`#pkTrack [data-i="${i}"] img`).forEach((img) => { img.src = u; });
  });
  $("#pkPhotos").hidden = !photos.length;
  $("#pkEmpty").hidden = !!photos.length;
  $("#pkPrev").hidden = $("#pkNext").hidden = photos.length < 2;
  $("#pkOpen").textContent = photos.length ? "Open place" : "Add photos & notes";
  $("#peek").hidden = false;
  loopTrack($("#pkTrack"), photos.length, 0, updatePeekCount);
  positionPeek();
}
function hidePeek() {
  clearTimeout(peek.hideTimer); clearTimeout(peek.showTimer);
  if ($("#peek").hidden) return;
  $("#peek").hidden = true; $("#pkTrack")._off?.(); $("#pkTrack").innerHTML = "";
  peek.urls.forEach((u) => URL.revokeObjectURL(u)); peek.urls = []; peek.id = null; peek.pinned = false;
}
function positionPeek() {
  const el = $("#peek");
  if (el.hidden || !peek.id || innerWidth <= 700) return;
  const p = state.places.get(peek.id); if (!p) return hidePeek();
  const [x, y] = map.screenOf(p.lon, p.lat);
  const w = el.offsetWidth, h = el.offsetHeight;
  let top = y - 34 - h;                       // above the pin head
  if (top < 70) top = y + 14;                 // or below the needle
  const left = Math.max(12, Math.min(innerWidth - w - 12, x + 7 - w / 2));
  el.style.left = left + "px"; el.style.top = Math.min(innerHeight - h - 12, top) + "px";
}
function updatePeekCount(i = 0) {
  const n = peek.photos.length;
  $("#pkCount").textContent = n > 1 ? `${i + 1} / ${n}` : n === 1 ? "1 photo" : "";
}
$("#pkPrev").addEventListener("click", () => stepTrack($("#pkTrack"), -1));
$("#pkNext").addEventListener("click", () => stepTrack($("#pkTrack"), 1));
$("#pkTrack").addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) openLightbox(peek.photos, +b.dataset.i); });
$("#pkOpen").addEventListener("click", () => { const id = peek.id; hidePeek(); openCard(id); });
$("#pkClose").addEventListener("click", hidePeek);
$("#peek").addEventListener("mouseenter", () => { peek.over = true; clearTimeout(peek.hideTimer); });
$("#peek").addEventListener("mouseleave", () => { peek.over = false; if (!peek.pinned) peek.hideTimer = setTimeout(hidePeek, 300); });

// ---------------- my places list ----------------
function toggleList(show = $("#list").hidden) {
  $("#list").hidden = !show; $("#btnList").setAttribute("aria-expanded", show);
  if (show) { onlySheet("list"); $("#import").hidden = true; renderList(); }
}
$("#btnList").addEventListener("click", () => toggleList());

async function renderList() {
  const all = [...state.places.values()];
  const been = all.filter((p) => p.status === "visited");
  const countries = new Set(been.map((p) => p.country).filter(Boolean));
  const photos = await store.countPhotos();
  $("#stats").innerHTML = [["Countries", countries.size], ["Places been", been.length], ["Photos", photos]]
    .map(([l, n]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join("");
  $("#filter").innerHTML = [{ id: "all", label: "All" }, ...STATUS]
    .map((s) => `<button class="chip" data-f="${s.id}" aria-pressed="${state.filter === s.id}">${s.id === "all" ? "" : `<i style="background:${s.color}"></i>`}${s.label}</button>`).join("");
  const list = all.filter((p) => state.filter === "all" || p.status === state.filter);
  if (!list.length) {
    $("#places").innerHTML = `<p class="empty">${all.length ? "Nothing in this filter yet." : "No places yet. Click on the map, search, or add photos to stick your first pin."}</p>`;
    return;
  }
  const groups = new Map();
  for (const p of list) { const c = p.country || "Elsewhere"; if (!groups.has(c)) groups.set(c, []); groups.get(c).push(p); }
  $("#places").innerHTML = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([c, ps]) =>
    `<div class="country-h"><span>${esc(c)}</span><span>${ps.length}</span></div>` +
    ps.sort((a, b) => a.name.localeCompare(b.name)).map((p) =>
      `<button class="place" data-id="${esc(p.id)}"><i style="background:${statusOf(p.status).color}"></i><span>${esc(p.name)}</span><small>${esc(whenShort(p))}</small></button>`).join("")
  ).join("");
}
$("#filter").addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (b) { state.filter = b.dataset.f; renderList(); } });
$("#places").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-id]"); if (!b) return;
  const p = state.places.get(b.dataset.id);
  if (innerWidth <= 700) toggleList(false);
  await openCard(p.id);
  map.flyTo(p.lon, p.lat, Math.max(map.zoomLevel(), 6), innerWidth > 700 ? 180 : 0);
});

// backup
$("#btnExport").addEventListener("click", async () => {
  const data = await store.exportAll();
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const filename = `pinmap-backup-${new Date().toISOString().slice(0, 10)}.json`;
  // inside a Claude artifact, downloads go through the platform's `downloads` capability
  const dl = window.claude?.use ? await window.claude.use("downloads").catch(() => null) : null;
  if (dl) {
    try { await dl.save({ filename, data: blob }); toast("Backup saved"); }
    catch (err) { toast(err?.code === "declined" ? "Backup cancelled" : "Couldn't save the backup here: " + (err?.message || err?.code), 4000); }
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("Backup prepared — check your downloads", 3000);
});
$("#fileImport").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const n = await store.importAll(JSON.parse(await f.text()));
    state.places.clear(); for (const p of await store.allPlaces()) state.places.set(p.id, migrate(p));
    refresh(); toast(`Imported ${n} places`);
  } catch (err) { toast("Import failed: " + err.message, 5000); }
});

// ---------------- globe / flat switch ----------------
const ICON_GLOBE = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.7"/><ellipse cx="12" cy="12" rx="3.8" ry="8.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3.8 9h16.4M3.8 15h16.4" stroke="currentColor" stroke-width="1.4"/></svg>`;
const ICON_FLAT = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9 5.5v13M15 5.5v13M3 12h18" stroke="currentColor" stroke-width="1.3"/></svg>`;
$("#zView").addEventListener("click", () => {
  try { localStorage.setItem(MODE_KEY, mode === "globe" ? "flat" : "globe"); } catch { /* ignore */ }
  location.reload();
});

// ---------------- account & sync ----------------
// Account block: who you are (avatar, name, email). Sync runs by itself, so its status is
// only mentioned when something needs attention.
let acctKey = "";
function initials(pr) { return ((pr.name || pr.email || "?").trim()[0] || "?").toUpperCase(); }
async function paintAvatars() {
  const pr = sync.profile();
  const url = pr ? await sync.avatarURL() : null;
  document.querySelectorAll(".avatar").forEach((el) => {
    el.style.backgroundImage = url ? `url("${url}")` : "";
    el.textContent = url || !pr ? "" : initials(pr);
  });
  const mini = $("#btnList .avatar");
  if (mini) mini.hidden = !pr;
}
function renderAccount(st, force = false) {
  const box = $("#acct");
  if (!sync.available()) { box.hidden = true; return; }
  box.hidden = false;
  const pr = sync.profile();
  // the status line alone changes often: update it without rebuilding the form
  const note = !pr ? "" : st.state === "offline" ? "Offline — your changes will sync when you're back online."
    : st.state === "error" ? "Couldn't sync just now — will try again." : "";
  const key = pr ? `in:${pr.name}|${pr.email}|${pr.avatarV}` : "out";
  if (key === acctKey && !force && $("#acctNote")) { $("#acctNote").textContent = note; $("#acctNote").hidden = !note; return; }
  acctKey = key;
  if (!pr) {
    box.innerHTML = `<p>Sign in to keep the same map on your phone and computer.</p><button class="btn primary" data-acct="in">Sign in or create account</button>`;
    paintAvatars();
    return;
  }
  box.innerHTML = `<div class="prof">
      <button class="avatar big" data-file="avatarFile" aria-label="Change your photo" title="Change your photo"></button>
      <div class="prof-text">
        <input id="profName" class="prof-name" value="${esc(pr.name)}" placeholder="Add your name" aria-label="Your name" maxlength="40">
        <small>${esc(pr.email)}</small>
      </div>
      <button class="linkbtn muted" data-acct="out">Sign out</button>
    </div>
    <p id="acctNote" class="amsg" ${note ? "" : "hidden"}>${esc(note)}</p>`;
  paintAvatars();
}
$("#acct").addEventListener("change", (e) => {
  if (e.target.id !== "profName") return;
  const v = e.target.value.trim().slice(0, 40);
  sync.setName(v).then(() => toast(v ? "Name saved" : "Name removed")).catch(() => toast("Couldn't save your name — try again online", 4000));
});
$("#acct").addEventListener("keydown", (e) => { if (e.target.id === "profName" && e.key === "Enter") e.target.blur(); });
$("#avatarFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    // square crop from the centre, 256 px
    const bmp = await createImageBitmap(f, { imageOrientation: "from-image" });
    const side = Math.min(bmp.width, bmp.height), c = document.createElement("canvas");
    c.width = c.height = 256;
    c.getContext("2d").drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.86));
    await sync.setAvatar(blob);
    toast("Photo updated");
  } catch { toast("Couldn't update the photo — try another picture or check your connection.", 4000); }
});
$("#acct").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-acct]"); if (!b) return;
  if (b.dataset.acct === "in") openAuth();
  if (b.dataset.acct === "out") {
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Sign out and clear this device?"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "Sign out"; }, 4000); return; }
    await sync.syncNow();
    if ((await store.dirtyPlaces()).length || (await store.dirtyPhotos()).length) {
      toast("Some changes haven't reached the cloud yet — try again when you're online.", 5000); return;
    }
    await sync.signOut();
    await store.clearAll();
    try { localStorage.removeItem("pinmap:view"); } catch { /* ignore */ }
    closeCard(); hidePeek();
    state.places.clear(); refresh();
    toast("Signed out. Your map is safe in your account.");
  }
});

let authMode = "in";
function openAuth(mode = "in") {
  authMode = mode;
  $("#authTitle").textContent = mode === "in" ? "Sign in" : "Create account";
  $("#aSubmit").textContent = mode === "in" ? "Sign in" : "Create account";
  $("#aSwitch").textContent = mode === "in" ? "No account yet? Create one" : "Already have an account? Sign in";
  $("#aPass").autocomplete = mode === "in" ? "current-password" : "new-password";
  $("#aNameRow").hidden = mode === "in";
  $("#aMsg").hidden = true;
  $("#auth").hidden = false;
  $("#aEmail").focus();
}
function closeAuth() { $("#auth").hidden = true; }
$("#aSwitch").addEventListener("click", () => openAuth(authMode === "in" ? "up" : "in"));
$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#aEmail").value.trim(), pass = $("#aPass").value;
  const msg = (t) => { $("#aMsg").textContent = t; $("#aMsg").hidden = false; };
  $("#aSubmit").disabled = true;
  try {
    if (authMode === "in") {
      await sync.signIn(email, pass);
      closeAuth(); toast("Signed in — syncing your map");
    } else {
      const r = await sync.signUp(email, pass, $("#aName").value.trim().slice(0, 40));
      if (r.session) { closeAuth(); toast("Account created — your map is now syncing"); }
      else { msg(`We sent a confirmation link to ${email}. Open it, then sign in here.`); openAuthKeepMsg(); }
    }
  } catch (err) {
    const m = String(err?.message || err);
    msg(/invalid login/i.test(m) ? "Wrong email or password." : /not confirmed/i.test(m) ? "Please confirm your email first (check your inbox), then sign in."
      : /already registered|already exists/i.test(m) ? "This email already has an account — sign in instead." : /password/i.test(m) ? "Password must be at least 6 characters." : m);
  } finally { $("#aSubmit").disabled = false; }
});
function openAuthKeepMsg() {
  authMode = "in";
  $("#authTitle").textContent = "Sign in"; $("#aSubmit").textContent = "Sign in"; $("#aNameRow").hidden = true;
  $("#aSwitch").textContent = "No account yet? Create one";
}

// ---------------- search ----------------
let qTimer;
const q = $("#q");
q.addEventListener("focus", () => search?.loadGazetteer("data/gazetteer.json"));
q.addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(runSearch, 110); });
q.addEventListener("keydown", (e) => {
  const n = state.results.length + (Array.isArray(state.online) ? state.online.length : 0);
  if (e.key === "ArrowDown") { e.preventDefault(); setSel(Math.min(n, state.sel + 1)); }
  else if (e.key === "ArrowUp") { e.preventDefault(); setSel(Math.max(0, state.sel - 1)); }
  else if (e.key === "Enter") { e.preventDefault(); $(`#results [data-n="${Math.max(0, state.sel)}"]`)?.click(); }
  else if (e.key === "Escape") { closeResults(); q.blur(); }
});

async function runSearch() {
  const text = q.value.trim();
  if (!text || !search) return closeResults();
  await search.loadGazetteer("data/gazetteer.json");
  if (q.value.trim() !== text) return;
  const mine = [...state.places.values()].map((p) => ({ ...p, mine: true, w: 0, kind: p.kind || "place" }));
  state.results = search.search(text, mine);
  state.online = null; state.sel = -1;
  renderResults(text);
}
const ICON = { country: "▦", capital: "★", city: "●", town: "•", ocean: "≈", sea: "≈", lake: "≈", bay: "≈", gulf: "≈", peak: "▲", mountain: "▲", volcano: "▲", range: "⋀", waterfall: "⌇", island: "◌", islands: "◌", desert: "∴", canyon: "⋁", park: "♣", forest: "♣", glacier: "❄" };
function renderResults(text) {
  const r = state.results;
  const row = (it, i) => {
    const sub = it.mine ? `Your place · ${statusOf(it.status).label}` :
      [kindLabel(it.kind), it.country || it.sub?.split(",").slice(-1)[0]?.trim()].filter(Boolean).join(" · ");
    const icon = it.mine ? "●" : ICON[it.kind] || "•";
    return `<button class="res" role="option" data-n="${i}" aria-selected="${i === state.sel}"><span class="ic" ${it.mine ? `style="color:${statusOf(it.status).color}"` : ""}>${icon}</span><span><b>${esc(it.name)}</b><small>${esc(sub)}</small></span></button>`;
  };
  let html = r.length ? r.map(row).join("") : `<p class="res-note">Nothing found in the built-in atlas.</p>`;
  if (state.online === "loading") html += `<p class="res-note">Searching OpenStreetMap…</p>`;
  else if (Array.isArray(state.online)) {
    html += `<div class="res-sec">OpenStreetMap</div>` + (state.online.length
      ? state.online.map((it, i) => row(it, r.length + i)).join("") : `<p class="res-note">No online results.</p>`);
  } else if (typeof state.online === "string") html += `<p class="res-note">${esc(state.online)}</p>`;
  else html += `<button class="res res-online" data-online="1" data-n="${r.length}"><span class="ic">⌕</span><span><b>Search OpenStreetMap for “${esc(text)}”</b><small>Villages, streets, viewpoints, anything not in the atlas</small></span></button>`;
  $("#results").innerHTML = html;
  $("#results").hidden = false;
}
function setSel(i) {
  state.sel = i;
  document.querySelectorAll("#results [data-n]").forEach((b) => b.setAttribute("aria-selected", +b.dataset.n === i));
  $(`#results [data-n="${i}"]`)?.scrollIntoView({ block: "nearest" });
}
function closeResults() { $("#results").hidden = true; state.sel = -1; }

$("#results").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-n]"); if (!b) return;
  if (b.dataset.online) {
    const text = q.value.trim();
    state.online = "loading"; renderResults(text);
    try { state.online = await searchOnline(text); }
    catch { state.online = "Online search isn't reachable from here (it works when the app runs from your own computer or a normal web host)."; }
    renderResults(text);
    return;
  }
  const i = +b.dataset.n;
  const it = i < state.results.length ? state.results[i] : state.online[i - state.results.length];
  closeResults(); q.blur();
  if (it.mine) {
    if (state.pick) { await attachAndDrop(state.pick, it.id); return endPick(); }
    await openCard(it.id);
    map.flyTo(it.lon, it.lat, Math.max(6, map.zoomLevel()), innerWidth > 700 ? 180 : 0);
    return;
  }
  closeCard();
  map.setTarget([it.lon, it.lat]);
  await map.flyTo(it.lon, it.lat, zoomFor(it.kind, it.sight));
  const country = map.countryAt(it.lon, it.lat);
  openPopover({ name: it.name, kind: it.kind, lon: it.lon, lat: it.lat, country, countryName: it.country, source: it.source || "atlas" });
});

// ---------------- file pickers ----------------
// Buttons open their file input programmatically inside the tap handler; the inputs stay in
// the layout (not display:none), which is what iOS / in-app webviews need to show the picker.
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-file]"); if (!b || !b.dataset.file) return;
  document.getElementById(b.dataset.file).click();
});

// ---------------- global ----------------
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => {
  const w = b.dataset.close;
  if (w === "card") closeCard(); else if (w === "import") { $("#import").hidden = true; updateImportBadge(); } else if (w === "auth") closeAuth(); else toggleList(false);
}));
$("#zIn").addEventListener("click", () => map.zoomBy(2));
$("#zOut").addEventListener("click", () => map.zoomBy(0.5));
$("#zHome").addEventListener("click", () => map.home());
document.addEventListener("click", (e) => { if (!e.target.closest(".search")) closeResults(); });
document.addEventListener("keydown", (e) => {
  if (!$("#lightbox").hidden) {
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowRight") lbStep(1);
    if (e.key === "ArrowLeft") lbStep(-1);
    return;
  }
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (e.key === "/" && !typing) { e.preventDefault(); q.focus(); }
  if (e.key === "Escape") {
    if (!$("#auth").hidden) closeAuth();
    else if (!$("#peek").hidden) hidePeek();
    else if (!$("#pop").hidden) closePopover();
    else if (state.pick) endPick();
    else if (!$("#card").hidden) closeCard();
  }
});

function fmtLL(lon, lat) {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
}
function whenShort(p) {
  if (p.status === "wish") return "someday";
  if (!p.visits?.length) return "";
  return fmtVisitShort(p.visits[0]) + (p.visits.length > 1 ? ` +${p.visits.length - 1}` : "");
}
