// Pinmap — app wiring: map, search, pins, place cards, photos, photo import, backup.
/* global exifr */
import { createMap } from "./map.js?v=20261128183835";
import { createSearch, searchOnline, searchAround, kindLabel, zoomFor, norm } from "./search.js?v=20261128183835";
import * as store from "./store.js?v=20261128183835";
import * as sync from "./sync.js?v=20261128183835";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js?v=20261128183835";
import { waters, heights, OCEANS } from "./stats.js?v=20261128183835";
import { createGlobe } from "./globe.js?v=20261128183835";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fmtVisit = (v) => (v.m ? MONTHS[v.m - 1] + " " : "") + v.y;
const fmtVisitShort = (v) => (v.m ? MONTHS[v.m - 1].slice(0, 3) + " " : "") + v.y;

const state = { places: new Map(), current: null, draft: null, filter: "all", results: [], sel: -1, pick: null };
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
  peakLabels = labels.physical;
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
        if (!editingTrip) renderTrips();
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
    if (p.status !== "visited") p.status = "visited";   // statuses were removed: every place is a place you've been
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
  for (const v of p.visits) v.id ||= "t" + v.y + "-" + (v.m || 0);   // trips get a stable id
  return p;
}
const sortTrips = (p) => p.visits.sort((a, b) => b.y - a.y || b.m - a.m);
/** The trip for a month (creating it if needed). */
function addVisit(p, v) {
  if (!v.y) return null;
  let t = p.visits.find((x) => x.y === v.y && (x.m || 0) === (v.m || 0));
  if (!t) { t = { id: store.uid(), y: v.y, m: v.m || 0 }; p.visits.push(t); sortTrips(p); }
  return t;
}
/** Which trip a photo belongs to: chosen by hand, else by the month it was taken. */
function tripOf(p, ph) {
  if (ph.visitId === "none") return null;
  if (ph.visitId && p.visits.some((v) => v.id === ph.visitId)) return ph.visitId;
  if (ph.takenAt) {
    const d = new Date(ph.takenAt), y = d.getFullYear(), m = d.getMonth() + 1;
    const v = p.visits.find((v) => v.y === y && v.m === m) || p.visits.find((v) => v.y === y && !v.m);
    if (v) return v.id;
  }
  return null;
}

function refresh() {
  const list = [...state.places.values()];
  map.setPins(list);
  map.setVisited(new Set(list.filter((p) => p.a3).map((p) => p.a3)));
  $("#hint").hidden = list.length > 0 || wizOpen();
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
  if (single && !wizOpen() && matchMedia("(hover: hover)").matches) {
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
  if (single && wizOpen()) tip.textContent = `Add the photos to “${h.list[0].name}”`;
  else if (single) { tip.hidden = true; return; }   // touch screens: the tap opens the preview
  else tip.textContent = `${h.list.length} places — click to zoom in`;
  tip.style.left = h.x + 14 + "px"; tip.style.top = h.y + 10 + "px"; tip.hidden = false;
}

// ---------------- new pin popover ----------------
function onMapClick({ x, y, lon, lat, feature }) {
  if (wizOpen()) return wizChoose({ name: feature ? feature.name || feature.t : "", kind: feature ? feature.kind : "", lon, lat });
  if (!$("#peek").hidden) { hidePeek(); return; }   // first tap outside just closes the preview
  const country = map.countryAt(lon, lat);
  // missed a pin by a little? offer it in the popover
  const nearId = map.nearestPin?.(x, y, 70);
  openPopover({ name: feature ? feature.name || feature.t : "", kind: feature ? feature.kind : "", lon, lat, country, source: feature ? "map" : "click", nearId });
}
function onPinClick(id) {
  if (wizOpen()) return wizChoose({ placeId: id });
  showPeek(id, true);
}

// On a phone every panel is a bottom sheet, so only one may be open at a time.
const isPhone = () => innerWidth <= 700;
function onlySheet(keep) {
  if (!isPhone()) return;
  if (keep !== "list" && !$("#list").hidden) toggleList(false);
  if (keep !== "card" && !$("#card").hidden) closeCard();
  if (keep !== "peek") hidePeek();
  if (keep !== "pop" && !$("#pop").hidden) closePopover();
}

function openPopover(d) {
  closeResults();
  onlySheet("pop"); hidePeek();
  state.draft = { ...d, status: state.draft?.status && state.draft.status !== "label" ? state.draft.status : "visited" };
  $("#pName").value = d.name || "";
  $("#pName").placeholder = "Name this place";
  const where = d.country?.name || d.countryName || "";
  $("#pMeta").textContent = [d.kind ? kindLabel(d.kind) : "", where, fmtLL(d.lon, d.lat)].filter(Boolean).join(" · ");
  const near = d.nearId && state.places.get(d.nearId);
  $("#pNear").hidden = !near;
  if (near) {
    $("#pNear").innerHTML = `<i></i><span>Open <b>${esc(near.name)}</b> instead</span>`;
    $("#pNear").dataset.id = near.id;
  }
  $("#pAdd").textContent = "Stick a pin";
  $("#pName").placeholder = "…or type a name";
  map.setTarget([d.lon, d.lat]);
  $("#pop").hidden = false;
  startPick(d);
  positionPopover();
  if (!d.name && !isPhone()) $("#pName").focus();
}
function closePopover() {
  $("#pop").hidden = true; state.draft = null;
  pick.ctrl?.abort(); pick.ctrl = null;
  if (!wizOpen()) map.setTarget(null);
}

// ---- "What's here?": places around the tapped point, to pick from instead of typing ----
const pick = { items: [], sel: -1, ctrl: null, loading: false, at: null };
const pickCache = new Map();
const KIND_BONUS = { capital: .5, city: .4, island: .45, islands: .45, "nature park": .3, town: .25, peak: .2, volcano: .25,
  waterfall: .2, beach: .15, sight: .15, castle: .2, ruins: .15, temple: .1, lake: .2, village: .1, district: .05 };
// kilometres per screen pixel at the tapped point
function kmPerPx(lon, lat) {
  const a = map.screenOf(lon, lat), b = map.screenOf(lon, lat + 0.05);
  const px = Math.hypot(a[0] - b[0], a[1] - b[1]);
  return px > 0.01 ? 5.53 / px : 50;
}
function pickRank(it, R) {
  return (it.inside ? 0 : it.km / R) - (it.inside ? 0.6 : 0) - (KIND_BONUS[it.kind] || 0) - (it.notable ? 0.15 : 0)
    - (it.pop ? Math.min(0.3, Math.log10(it.pop + 1) / 25) : 0);
}
function mergePick(list, R) {
  const out = [];
  for (const it of list) {
    const nn = norm(it.name);
    if (!nn) continue;
    const dup = out.find((o) => o.nn === nn && (o.inside || it.inside || Math.abs(o.lon - it.lon) + Math.abs(o.lat - it.lat) < 0.08));
    if (dup) {
      if (it.inside && !dup.inside) Object.assign(dup, { inside: true, kind: it.kind });   // "Ko Pha-ngan": the island, not the town
      dup.notable ||= it.notable; continue;
    }
    out.push({ ...it, nn });
  }
  for (const it of out) it.r = it.top ? -9 : pickRank(it, R);
  return out.sort((a, b) => a.r - b.r).slice(0, 12);
}
async function startPick(d) {
  pick.ctrl?.abort();
  const kpp = kmPerPx(d.lon, d.lat);
  const R = Math.max(1.5, Math.min(60, kpp * 90));            // local data: generous
  const Ro = Math.max(0.4, Math.min(12, kpp * 50));            // OpenStreetMap: tighter, it is dense
  const local = search ? search.around(d.lon, d.lat, R, 20) : [];
  const first = d.name ? [{ name: d.name, kind: d.kind || "", lon: d.lon, lat: d.lat, km: 0, top: true }] : [];
  pick.at = d; pick.sel = d.name ? 0 : -1;
  pick.items = mergePick([...first, ...local], Ro * 2);
  pick.loading = navigator.onLine !== false;
  renderPick();
  search?.loadGazetteer("data/gazetteer.json").then(() => {
    if (pick.at !== d) return;
    pick.items = mergePick([...pick.items, ...search.around(d.lon, d.lat, R, 20)], Ro * 2);
    renderPick();
  });
  if (!pick.loading) return;
  const key = `${d.lon.toFixed(3)},${d.lat.toFixed(3)},${Ro.toFixed(1)}`;
  const ctrl = new AbortController(); pick.ctrl = ctrl;
  try {
    let osm = pickCache.get(key);
    if (!osm) { osm = await searchAround(d.lon, d.lat, Ro, ctrl.signal); pickCache.set(key, osm); }
    if (pick.at !== d) return;
    const selName = pick.items[pick.sel]?.nn;
    pick.items = mergePick([...pick.items, ...osm], Ro * 2);
    pick.sel = selName ? pick.items.findIndex((x) => x.nn === selName) : -1;
  } catch (e) {
    if (e.name === "AbortError") return;
  }
  if (pick.at !== d) return;
  pick.loading = false; renderPick();
}
function renderPick() {
  const box = $("#pList");
  const rows = pick.items.map((it, i) => {
    const where = it.inside ? "You're on it" : it.km < 0.05 ? "" : it.km < 1 ? `${Math.round(it.km * 1000 / 10) * 10} m` : `${it.km < 10 ? it.km.toFixed(1) : Math.round(it.km)} km`;
    return `<button class="res" type="button" role="option" data-k="${i}" aria-selected="${i === pick.sel}"><span class="ic">${ICON[it.kind] || "•"}</span><span><b>${esc(it.name)}</b><small>${esc([kindLabel(it.kind), where].filter(Boolean).join(" · "))}</small></span></button>`;
  }).join("");
  const more = pick.loading ? `<div class="more"><i></i>Looking around…</div>` : pick.items.length ? "" : `<div class="more">Nothing named nearby — type a name below.</div>`;
  box.innerHTML = rows + more;
  positionPopover();
  keepPointVisible();
}
// phone: the sheet covers the bottom of the map — slide the map so the tapped point stays in view
function keepPointVisible() {
  const d = state.draft; if (!d || !isPhone() || $("#pop").hidden) return;
  const top = $("#pop").getBoundingClientRect().top, [, y] = map.screenOf(d.lon, d.lat);
  if (y > 70 && y < top - 40) return;
  map.flyTo(d.lon, d.lat, map.zoomLevel(), 0, (innerHeight - top) / 2);
}
$("#pList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-k]"); if (!b || !state.draft) return;
  const it = pick.items[+b.dataset.k]; if (!it) return;
  pick.sel = +b.dataset.k;
  $("#pName").value = it.name;
  // the pin goes where the place is (an island or park you are "on" keeps the tapped point)
  const at = it.inside ? pick.at : it;
  Object.assign(state.draft, { name: it.name, kind: it.kind || "", lon: at.lon, lat: at.lat });
  state.draft.country = map.countryAt(at.lon, at.lat) || state.draft.country;
  $("#pMeta").textContent = [state.draft.country?.name || state.draft.countryName || "", fmtLL(at.lon, at.lat)].filter(Boolean).join(" · ");
  map.setTarget([at.lon, at.lat]);
  selPick(); keepPointVisible();
});
function selPick() { document.querySelectorAll("#pList [data-k]").forEach((x) => x.setAttribute("aria-selected", +x.dataset.k === pick.sel)); }
$("#pName").addEventListener("input", () => {
  if (pick.sel >= 0 && norm($("#pName").value) !== pick.items[pick.sel]?.nn) { pick.sel = -1; selPick(); }
});
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
$("#pCancel").addEventListener("click", closePopover);
$("#pNear").addEventListener("click", () => { const id = $("#pNear").dataset.id; closePopover(); showPeek(id, true); });
$("#pName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#pAdd").click(); });
$("#pAdd").addEventListener("click", async () => {
  const d = state.draft; if (!d) return;
  const p = await createPlace({ name: $("#pName").value, lon: d.lon, lat: d.lat, status: d.status, kind: d.kind, country: d.country, countryName: d.countryName, source: d.source });
  closePopover();
  openCard(p.id);
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
  $("#cNotes").value = p.notes || "";
  $("#cSaved").textContent = p.updatedAt ? "Saved " + new Date(p.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
  editingTrip = null;
  resetDelete();
  $("#card").hidden = false;
  await renderTrips();
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
function resetDelete() { const b = $("#cDelete"); b.textContent = "Delete place"; b.dataset.armed = ""; }
$("#cDelete").addEventListener("click", async () => {
  const b = $("#cDelete");
  if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Click again to delete with photos"; setTimeout(resetDelete, 4000); return; }
  const id = state.current;
  await store.deletePlace(id); state.places.delete(id);
  closeCard(); refresh(); toast("Place deleted");
});

// ---------------- trips & photos in the place card ----------------
// A trip is a month + year. Photos sit under their trip (by hand or by the month they were taken);
// the rest are under "Other photos".
function revokePhotos() { photoURLs.forEach((u) => URL.revokeObjectURL(u)); photoURLs = []; }
let cardPhotos = [], photoRender = 0, editingTrip = null, addTo = null;
// image of a photo as an object URL; downloads it from the cloud if this device doesn't have it yet
async function photoURL(ph, kind) {
  const b = ph[kind] || (await sync.fetchBlob(ph, kind)) || (kind === "blob" ? ph.thumb || (await sync.fetchBlob(ph, "thumb")) : null);
  return b ? URL.createObjectURL(b) : null;
}
const monthOptions = (sel) => `<option value="0"${!sel ? " selected" : ""}>Month</option>` + MONTHS.map((m, i) => `<option value="${i + 1}"${sel === i + 1 ? " selected" : ""}>${m}</option>`).join("");
const yearOptions = (sel) => { let o = ""; for (let y = new Date().getFullYear(); y >= 1950; y--) o += `<option${y === sel ? " selected" : ""}>${y}</option>`; return o; };
// v: the trip to change; null: a new trip; other: give the photos without a trip a month
function tripEditor(v, other = false) {
  const now = new Date();
  return `<div class="trip-edit" data-editing="${other ? "other" : v ? esc(v.id) : "new"}">
    <b class="te-title">${other ? "When were these photos taken?" : v ? "Change the month of this trip" : "New trip — when was it?"}</b>
    <select data-te="m" aria-label="Month">${monthOptions(v ? v.m : now.getMonth() + 1)}</select>
    <select data-te="y" aria-label="Year">${yearOptions(v ? v.y : now.getFullYear())}</select>
    <div class="row">${v || other
      ? `<button class="btn small primary" data-te="save">Save</button>`
      : `<button class="btn small primary" data-te="saveadd">Create &amp; add photos</button><button class="btn small" data-te="save">Create</button>`}
    <button class="linkbtn muted" data-te="cancel">Cancel</button>
    ${v ? `<button class="linkbtn danger-l" data-te="del">Delete trip</button>` : ""}</div></div>`;
}
const tileHTML = (ph) => `<div class="ph"><button class="ph-open" data-ph="${esc(ph.id)}" aria-label="Open photo"><img alt=""></button><button class="del" data-del="${esc(ph.id)}" aria-label="Remove photo">×</button></div>`;
// the "+" tile at the end of a trip's photos; wide with the trip's name when the trip is empty
const addTile = (id, label, empty) => empty
  ? `<button class="add-tile wide" data-addto="${esc(id)}"><span>＋</span>Add photos to ${esc(label)}</button>`
  : `<button class="add-tile" data-addto="${esc(id)}" aria-label="Add photos to ${esc(label)}"><span>＋</span>Add</button>`;

async function renderTrips() {
  revokePhotos();
  const p = state.places.get(state.current); if (!p) return;
  const token = ++photoRender;
  cardPhotos = await store.photosOf(p.id);
  if (token !== photoRender) return;
  const by = new Map([[null, []], ...p.visits.map((v) => [v.id, []])]);
  for (const ph of cardPhotos) by.get(tripOf(p, ph))?.push(ph) ?? by.get(null).push(ph);
  let html = editingTrip === "new" ? `<section class="trip">${tripEditor(null)}</section>` : "";
  for (const v of p.visits) {
    const list = by.get(v.id);
    html += `<section class="trip" data-v="${esc(v.id)}">` + (editingTrip === v.id ? tripEditor(v)
      : `<div class="trip-head"><button class="trip-when" data-edit="${esc(v.id)}" aria-label="Change the month of this trip">${esc(fmtVisit(v))}<span class="pen" aria-hidden="true">✎</span></button>
         <span class="trip-n">${list.length ? plural(list.length, "photo") : "no photos yet"}</span></div>`)
      + `<div class="photos">${list.map(tileHTML).join("")}${addTile(v.id, fmtVisit(v), !list.length)}</div></section>`;
  }
  const other = by.get(null);
  if (other.length || !p.visits.length) {
    html += `<section class="trip other" data-v="">` + (editingTrip === "other" ? tripEditor(null, true)
      : `<div class="trip-head"><b class="trip-other">${p.visits.length ? "Other photos" : "Photos"}</b>
      <span class="trip-n">${other.length ? plural(other.length, "photo") : ""}</span>
      ${other.length ? `<button class="linkbtn set-month" data-edit="other" aria-label="Set the month for these photos">Set month <span class="pen" aria-hidden="true">✎</span></button>` : ""}</div>`)
      + `<div class="photos">${other.map(tileHTML).join("")}${addTile("", p.visits.length ? "Other photos" : "this place", !other.length)}</div>
      <p class="saved">${p.visits.length ? "Photos without a trip. Added here, dated photos go to their month's trip." : "Photos with a date create their trip automatically."}</p></section>`;
  }
  $("#cTrips").innerHTML = html;
  cardPhotos.forEach(async (ph) => {
    const u = await photoURL(ph, "thumb");
    if (!u) return;
    if (token !== photoRender) return URL.revokeObjectURL(u);
    photoURLs.push(u);
    const img = document.querySelector(`#cTrips [data-ph="${CSS.escape(ph.id)}"] img`); if (img) img.src = u;
  });
}
// keep photos with their trip when its month changes: pin the ones matched by date
async function pinPhotosTo(p, tripId) {
  for (const ph of cardPhotos) if (tripOf(p, ph) === tripId && ph.visitId !== tripId) { ph.visitId = tripId; await store.putPhoto(ph); }
}
$("#tripNew").addEventListener("click", () => { editingTrip = "new"; renderTrips(); });
$("#cTrips").addEventListener("click", async (e) => {
  const p = state.places.get(state.current); if (!p) return;
  const t = e.target;
  const del = t.closest("[data-del]");
  if (del) { await store.deletePhoto(del.dataset.del); return renderTrips(); }
  const open = t.closest("[data-ph]");
  if (open) {
    const sec = open.closest("[data-v]");
    const list = cardPhotos.filter((ph) => (tripOf(p, ph) || "") === (sec?.dataset.v ?? ""));
    return openLightbox(list, list.findIndex((ph) => ph.id === open.dataset.ph), p.id);
  }
  const ed = t.closest("[data-edit]");
  if (ed) { editingTrip = ed.dataset.edit; return renderTrips(); }
  const add = t.closest("[data-addto]");
  if (add) { addTo = add.dataset.addto || null; return $("#cFiles").click(); }
  const te = t.closest("[data-te]"); if (!te || te.tagName === "SELECT") return;
  const box = te.closest(".trip-edit"), id = box.dataset.editing;
  if (te.dataset.te === "cancel") { editingTrip = null; return renderTrips(); }
  if (te.dataset.te === "del") {
    if (te.dataset.armed !== "1") { te.dataset.armed = "1"; te.textContent = "Delete? Photos stay"; return; }
    p.visits = p.visits.filter((v) => v.id !== id);
  }
  let flash = null;
  if (te.dataset.te === "save" || te.dataset.te === "saveadd") {
    const y = +box.querySelector('[data-te="y"]').value, m = +box.querySelector('[data-te="m"]').value;
    if (id === "other") {
      // all photos without a trip go to the trip of this month (created if there isn't one)
      const v = addVisit(p, { y, m }), moving = cardPhotos.filter((ph) => !tripOf(p, ph));
      for (const ph of moving) { ph.visitId = v.id; await store.putPhoto(ph); }
      editingTrip = null;
      await store.putPlace(p); refresh(); await renderTrips();
      toast(`${plural(moving.length, "photo")} moved to ${fmtVisit(v)}`);
      const sec = document.querySelector(`#cTrips [data-v="${CSS.escape(v.id)}"]`);
      sec?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      sec?.classList.add("flash"); setTimeout(() => sec?.classList.remove("flash"), 1600);
      return;
    }
    const clash = p.visits.find((v) => v.y === y && (v.m || 0) === m && v.id !== id);
    if (clash) { toast(`There's already a trip in ${fmtVisit(clash)} — add the photos there`); return; }
    if (id === "new") {
      const v = { id: store.uid(), y, m };
      p.visits.push(v); flash = v.id;
      if (te.dataset.te === "saveadd") { addTo = v.id; $("#cFiles").click(); }
    } else { await pinPhotosTo(p, id); const v = p.visits.find((v) => v.id === id); v.y = y; v.m = m; flash = id; }
    sortTrips(p);
  }
  editingTrip = null;
  await store.putPlace(p); refresh(); await renderTrips();
  if (flash) {
    const sec = document.querySelector(`#cTrips [data-v="${CSS.escape(flash)}"]`);
    sec?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    sec?.classList.add("flash"); setTimeout(() => sec?.classList.remove("flash"), 1600);
  }
});
$("#cFiles").addEventListener("change", async (e) => {
  const files = [...e.target.files]; e.target.value = "";
  if (!state.current || !files.length) return;
  const metas = await readPhotos(files);
  await attachGroup({ files: metas, visits: visitsOf(metas) }, state.current, addTo);
  addTo = null;
});
// drop photos on a trip → that trip; anywhere else in the card → by date
const cardDrop = $("#cTrips");
cardDrop.addEventListener("dragover", (e) => { e.preventDefault(); e.target.closest(".trip")?.classList.add("dragover"); });
cardDrop.addEventListener("dragleave", (e) => e.target.closest(".trip")?.classList.remove("dragover"));
cardDrop.addEventListener("drop", async (e) => {
  e.preventDefault();
  const sec = e.target.closest("[data-v]"); sec?.classList.remove("dragover");
  const files = [...e.dataTransfer.files].filter(isImage);
  if (!state.current || !files.length) return;
  const metas = await readPhotos(files);
  await attachGroup({ files: metas, visits: visitsOf(metas) }, state.current, sec?.dataset.v || null);
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

// ---------------- "Add photos" wizard: photos → where → when → save ----------------
// One linear flow. While it is open, tapping the map or a pin answers "where", and the
// top search is hidden so there is only one search on screen.
const wiz = { groups: [], gi: 0, choice: null, trip: null, online: null, urls: [] };
const wizOpen = () => !$("#wiz").hidden;

// group photos: by GPS (same place within ~12 km, or next to one of your pins), the rest by month
function groupPhotos(metas) {
  const mine = [...state.places.values()];
  const groups = [];
  for (const m of metas) {
    if (m.lat == null) {
      const key = m.date ? `${m.date.getFullYear()}-${m.date.getMonth()}` : "nodate";
      let g = groups.find((g) => g.noLoc === key);
      if (!g) groups.push((g = { noLoc: key, files: [] }));
      g.files.push(m); continue;
    }
    const near = mine.map((p) => ({ p, d: km(p, m) })).filter((x) => x.d < 25).sort((a, b) => a.d - b.d)[0];
    let g = near ? groups.find((g) => g.pinId === near.p.id) : groups.find((g) => !g.pinId && g.lat != null && km(g, m) < 12);
    if (!g) groups.push((g = near ? { pinId: near.p.id, lat: m.lat, lon: m.lon, files: [] } : { lat: m.lat, lon: m.lon, files: [] }));
    g.files.push(m);
    if (!g.pinId) { const n = g.files.length; g.lat += (m.lat - g.lat) / n; g.lon += (m.lon - g.lon) / n; }
  }
  for (const g of groups) { g.visits = visitsOf(g.files); if (g.lat != null && !g.pinId) suggest(g); }
  return groups.sort((a, b) => (a.noLoc ? 1 : 0) - (b.noLoc ? 1 : 0));
}
function suggest(g) {
  const s = search.nearest(g.lon, g.lat, 40);
  const c = map.countryAt(g.lon, g.lat);
  g.country = c; g.countryName = c?.name || s?.country || ""; g.kind = s?.sight ? s.kind : s ? "city" : "";
  g.name = s && (s.sight || s.km < 15) ? s.name : "";
  g.where = s ? `${s.km < 1.5 ? "In" : "Near"} ${s.name}${g.countryName ? ", " + g.countryName : ""}` : g.countryName ? `Somewhere in ${g.countryName}` : "Location from the photos";
}
function visitsText(vs) {
  if (!vs?.length) return "";
  const t = vs.slice(0, 3).map(fmtVisit).join(", ");
  return vs.length > 3 ? t + "…" : t;
}

async function wizStart(files) {
  files = files.filter(isImage);
  if (!files.length) return;
  closeCard(); toggleList(false); closePopover(); hidePeek(); closeResults();
  Object.assign(wiz, { groups: [], gi: 0, choice: null, trip: null, online: null });
  document.body.classList.add("wizard-on");
  $("#wiz").hidden = false; $("#hint").hidden = true;
  $("#wzTitle").textContent = "Add photos";
  $("#wzBody").innerHTML = `<p class="empty">Reading ${plural(files.length, "photo")}…</p>`;
  await search.loadGazetteer("data/gazetteer.json");
  const metas = await readPhotos(files);
  const broken = metas.filter((m) => m.broken);
  if (broken.length) toast(`${plural(broken.length, "photo")} couldn't be opened by this browser (HEIC?). Try JPEG.`, 6000);
  wiz.groups = groupPhotos(metas.filter((m) => !m.broken));
  if (!wiz.groups.length) return wizClose();
  wizGroupStart();
}
function wizGroupStart() {
  const g = wiz.groups[wiz.gi];
  wiz.choice = null; wiz.trip = null; wiz.online = null;
  // a GPS suggestion is pre-selected, so "where" is answered already (one tap to change)
  if (g.pinId && state.places.has(g.pinId)) wizChoose({ placeId: g.pinId }, false);
  else if (g.lat != null) wizChoose({ name: g.name, kind: g.kind, lon: g.lon, lat: g.lat, gps: true }, false);
  else { map.setTarget(null); renderWiz(); }
}
function wizClose() {
  $("#wiz").hidden = true; $("#wzBody").innerHTML = "";
  document.body.classList.remove("wizard-on");
  wiz.urls.forEach((u) => URL.revokeObjectURL(u)); wiz.urls = []; wiz.groups = [];
  map.setTarget(null); refresh();
}
function wizCancel() { if (wizOpen()) { wizClose(); toast("Photos not added"); } }

// "where" answered: an existing place {placeId} or a new spot {name, lon, lat, kind}
function wizChoose(c, fly = true) {
  const g = wiz.groups[wiz.gi]; if (!g) return;
  if (c.placeId) {
    const p = state.places.get(c.placeId); if (!p) return;
    wiz.choice = { placeId: p.id, name: p.name, lon: p.lon, lat: p.lat, country: p.country };
  } else {
    const country = map.countryAt(c.lon, c.lat);
    const near = c.name ? null : search.nearest(c.lon, c.lat, 25);
    wiz.choice = { name: c.name || (near && near.km < 8 ? near.name : ""), kind: c.kind || "", lon: c.lon, lat: c.lat, country: country?.name || c.countryName || "", countryObj: country, gps: c.gps };
  }
  // default trip: the month the photos were taken (an existing trip of that month if there is one)
  const pv = wiz.choice.placeId && state.places.get(wiz.choice.placeId);
  const d = g.visits[0];
  wiz.trip = pv && d ? pv.visits.find((v) => v.y === d.y && v.m === d.m)?.id || null : null;
  wiz.ym = d ? { y: d.y, m: d.m } : { y: new Date().getFullYear(), m: new Date().getMonth() + 1 };
  map.setTarget([wiz.choice.lon, wiz.choice.lat]);
  renderWiz();
  // show the place in the part of the map the wizard doesn't cover
  const sheet = $("#wiz");
  const offX = isPhone() ? 0 : -(sheet.offsetWidth + 14) / 2, offY = isPhone() ? sheet.offsetHeight / 2 : 0;
  map.flyTo(wiz.choice.lon, wiz.choice.lat, Math.max(map.zoomLevel(), wiz.choice.placeId ? 6 : 7), offX, offY);
}

function renderWiz() {
  const g = wiz.groups[wiz.gi]; if (!g) return;
  const n = wiz.groups.length;
  $("#wzTitle").textContent = n > 1 ? `Add photos · ${wiz.gi + 1} of ${n}` : "Add photos";
  wiz.urls.forEach((u) => URL.revokeObjectURL(u)); wiz.urls = [];
  const thumbs = g.files.slice(0, 5).map((f) => { const u = URL.createObjectURL(f.thumb); wiz.urls.push(u); return `<img src="${u}" alt="">`; }).join("")
    + (g.files.length > 5 ? `<span>+${g.files.length - 5}</span>` : "");
  const head = `<div class="strip">${thumbs}</div><p class="wz-sub">${plural(g.files.length, "photo")}${g.visits.length ? " · taken " + esc(visitsText(g.visits)) : ""}</p>`;
  const c = wiz.choice;
  let html = head + `<h3 class="wz-q"><span>1</span>Where ${g.files.length === 1 ? "was it" : "were they"} taken?</h3>`;
  if (c) {
    html += `<div class="wz-chosen"><i class="pin-dot"></i><div class="wz-chosen-t">${c.placeId
      ? `<b>${esc(c.name)}</b><small>Your place${c.country ? " · " + esc(c.country) : ""}</small>`
      : `<input id="wzName" value="${esc(c.name)}" placeholder="Name this place" aria-label="Place name"><small>${c.gps ? "From the photo's location" : "New place"}${c.country ? " · " + esc(c.country) : ""}</small>`}</div>
      <button class="linkbtn" data-wz="change">Change</button></div>`;
    html += `<h3 class="wz-q"><span>2</span>When?</h3>`;
    const p = c.placeId && state.places.get(c.placeId);
    if (p && p.visits.length) {
      html += `<div class="chips wz-trips">${p.visits.map((v) => `<button class="chip" data-trip="${esc(v.id)}" aria-pressed="${wiz.trip === v.id}">${esc(fmtVisit(v))}</button>`).join("")}
        <button class="chip" data-trip="" aria-pressed="${!wiz.trip}">Another month</button></div>`;
    }
    if (!wiz.trip) {
      html += `<div class="wz-when"><select id="wzM" aria-label="Month">${monthOptions(wiz.ym.m)}</select><select id="wzY" aria-label="Year">${yearOptions(wiz.ym.y)}</select></div>`;
    }
    html += `<button class="btn primary wz-save" data-wz="save">Save ${plural(g.files.length, "photo")}</button>`;
  } else {
    html += `<div class="wz-search"><input id="wzQ" type="search" autocomplete="off" placeholder="Search a city, village, mountain…" aria-label="Search a place"><div id="wzRes" class="wz-res"></div></div>
      <p class="wz-hint">…or tap the map where it was${state.places.size ? ", or one of your pins" : ""}.</p>`;
    const mine = [...state.places.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 8);
    if (mine.length) html += `<div class="chips">${mine.map((p) => `<button class="chip" data-place="${esc(p.id)}"><i class="pin-dot"></i>${esc(p.name)}</button>`).join("")}</div>`;
  }
  if (n > 1) html += `<button class="linkbtn muted wz-skip" data-wz="skip">Skip these photos</button>`;
  $("#wzBody").innerHTML = html;
  if (!c && !isPhone()) $("#wzQ")?.focus();
}

$("#wzBody").addEventListener("click", async (e) => {
  const t = e.target;
  const pl = t.closest("[data-place]"); if (pl) return wizChoose({ placeId: pl.dataset.place });
  const tr = t.closest("[data-trip]");
  if (tr) {
    wiz.trip = tr.dataset.trip || null;
    if (!wiz.trip) { const g = wiz.groups[wiz.gi]; const d = g.visits[0]; wiz.ym = d ? { y: d.y, m: d.m } : wiz.ym; }
    return renderWiz();
  }
  const r = t.closest("[data-r]");
  if (r) {
    if (r.dataset.r === "osm") {
      const text = $("#wzQ").value.trim();
      wiz.online = "loading"; renderWizResults(text);
      try { wiz.online = await searchOnline(text); } catch { wiz.online = "Online search isn't reachable right now."; }
      return renderWizResults(text);
    }
    const it = wiz.res[+r.dataset.r];
    return it.mine ? wizChoose({ placeId: it.id }) : wizChoose({ name: it.name, kind: it.kind, lon: it.lon, lat: it.lat, countryName: it.country });
  }
  const b = t.closest("[data-wz]"); if (!b) return;
  if (b.dataset.wz === "change") { wiz.choice = null; map.setTarget(null); return renderWiz(); }
  if (b.dataset.wz === "skip") return wizNext();
  if (b.dataset.wz === "save") {
    b.disabled = true;
    const g = wiz.groups[wiz.gi], c = wiz.choice;
    if (!c.placeId) c.name = $("#wzName").value.trim() || c.name;
    if (!wiz.trip && $("#wzM")) wiz.ym = { y: +$("#wzY").value, m: +$("#wzM").value };
    const p = c.placeId ? state.places.get(c.placeId)
      : await createPlace({ name: c.name, lon: c.lon, lat: c.lat, kind: c.kind, country: c.countryObj, countryName: c.country, source: c.gps ? "photo" : "click" });
    const tripId = wiz.trip || addVisit(p, wiz.ym).id;
    await attachGroup(g, p.id, tripId);
    wiz.lastPlace = p.id;
    wizNext();
  }
});
let wzTimer;
$("#wzBody").addEventListener("input", (e) => {
  if (e.target.id === "wzQ") { clearTimeout(wzTimer); wzTimer = setTimeout(() => { wiz.online = null; renderWizResults(e.target.value.trim()); }, 110); }
});
$("#wzBody").addEventListener("change", (e) => {
  if (e.target.id === "wzM" || e.target.id === "wzY") wiz.ym = { y: +$("#wzY").value, m: +$("#wzM").value };
  if (e.target.id === "wzName" && wiz.choice) wiz.choice.name = e.target.value.trim();
});
function renderWizResults(text) {
  const box = $("#wzRes"); if (!box) return;
  if (!text) { box.innerHTML = ""; return; }
  const mine = [...state.places.values()].map((p) => ({ ...p, mine: true, w: 0, kind: p.kind || "place" }));
  wiz.res = search.search(text, mine, 6);
  if (Array.isArray(wiz.online)) wiz.res = wiz.res.concat(wiz.online);
  box.innerHTML = wiz.res.map((it, i) => `<button class="res" data-r="${i}"><span class="ic">${it.mine ? "●" : ICON[it.kind] || "•"}</span><span><b>${esc(it.name)}</b><small>${esc(it.mine ? "Your place" : [kindLabel(it.kind), it.country].filter(Boolean).join(" · "))}</small></span></button>`).join("")
    + (wiz.online === "loading" ? `<p class="res-note">Searching OpenStreetMap…</p>`
      : typeof wiz.online === "string" ? `<p class="res-note">${esc(wiz.online)}</p>`
      : wiz.online ? "" : `<button class="res res-online" data-r="osm"><span class="ic">⌕</span><span><b>Search OpenStreetMap for “${esc(text)}”</b><small>Villages, streets, viewpoints…</small></span></button>`);
}
function wizNext() {
  wiz.gi++;
  if (wiz.gi < wiz.groups.length) return wizGroupStart();
  const last = wiz.lastPlace;
  wizClose();
  if (last) openCard(last);
}

// save a group's photos into a place; dates from the photos become visits
// toTrip: put every photo into this trip; otherwise each photo goes to the trip of the month
// it was taken in (created if needed), and undated photos stay without a trip.
async function attachGroup(g, placeId, toTrip = null) {
  const p = state.places.get(placeId); if (!p) return;
  const files = g.files.filter((f) => !f.broken);
  let done = 0;
  for (const f of files) {
    toast(`Saving photos ${++done}/${files.length}…`, 10000);
    try {
      const [blob, w, h] = await resizeImage(f.file, 2048, 0.86);
      const thumb = f.thumb || (await resizeImage(f.file, 480, 0.8))[0];
      const visitId = toTrip || (f.date ? addVisit(p, { y: f.date.getFullYear(), m: f.date.getMonth() + 1 }).id : null);
      await store.putPhoto({ id: store.uid(), placeId, blob, thumb, w, h, name: f.file.name, takenAt: f.date ? +f.date : null, addedAt: Date.now(), visitId });
    } catch { done--; }
  }
  await store.putPlace(p);
  refresh();
  if (state.current === placeId) await renderTrips();
  const trip = toTrip && p.visits.find((v) => v.id === toTrip);
  toast(done ? `${plural(done, "photo")} added to ${trip ? fmtVisit(trip) : p.name}` : "No photos could be saved", 3000);
}

// top-bar button + drag & drop anywhere on the map
$("#importFiles").addEventListener("change", (e) => { const f = [...e.target.files]; e.target.value = ""; wizStart(f); });
$("#wzClose").addEventListener("click", wizCancel);
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
addEventListener("dragenter", (e) => { if (hasFiles(e)) { dragDepth++; $("#dropzone").hidden = !!e.target.closest?.("#card"); } });
addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); $("#dropzone").hidden = !!e.target.closest?.("#card"); } });
addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("#dropzone").hidden = true; });
addEventListener("drop", (e) => {
  dragDepth = 0; $("#dropzone").hidden = true;
  if (!hasFiles(e) || e.target.closest?.("#card")) return;
  e.preventDefault();
  wizStart([...e.dataTransfer.files]);
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
  let cur = start;
  onIndex = ((orig) => (i) => { cur = i; orig?.(i); })(onIndex);
  const ro = new ResizeObserver(() => { track.scrollLeft = (cur + (n > 1 ? 1 : 0)) * w(); });
  ro.observe(track);
  track._off = () => { track.removeEventListener("scroll", onScroll); track.removeEventListener("scrollend", settle); clearTimeout(timer); ro.disconnect(); };
  requestAnimationFrame(() => { track.scrollLeft = (start + (n > 1 ? 1 : 0)) * w(); onIndex?.(start); });
}
const stepTrack = (track, d) => track.scrollBy({ left: d * track.clientWidth, behavior: "smooth" });

// lightbox
let lbURLs = [];
let lb = { photos: [], idx: 0, placeId: null };
function openLightbox(photos, i, placeId = null) {
  const track = $("#lbTrack");
  lb = { photos, idx: i, placeId };
  const p = placeId && state.places.get(placeId);
  $("#lbBar").hidden = !p;
  if (p) $("#lbTrip").innerHTML = p.visits.map((v) => `<option value="${esc(v.id)}">${esc(fmtVisit(v))}</option>`).join("") + `<option value="none">No trip</option>`;
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
  // on phones, hide the browser's own bars too (needs the tap that opened the viewer)
  if (isPhone() && $("#lightbox").requestFullscreen && !document.fullscreenElement) {
    $("#lightbox").requestFullscreen({ navigationUI: "hide" }).catch(() => {});
  }
  $("#lbPrev").hidden = $("#lbNext").hidden = photos.length < 2;
  zmReset();
  loopTrack(track, photos.length, i, (k) => { if (k !== lb.idx) zmReset(); lb.idx = k; syncLbTrip(); });
  $("#lbClose").focus();
}
function syncLbTrip() {
  const p = lb.placeId && state.places.get(lb.placeId), ph = lb.photos[lb.idx];
  if (p && ph) $("#lbTrip").value = tripOf(p, ph) || "none";
}
$("#lbTrip").addEventListener("change", async () => {
  const ph = lb.photos[lb.idx]; if (!ph) return;
  ph.visitId = $("#lbTrip").value;
  await store.putPhoto(ph);
  toast($("#lbTrip").value === "none" ? "Photo moved to Other photos" : `Photo moved to ${$("#lbTrip").selectedOptions[0].text}`);
  if (state.current === lb.placeId) renderTrips();
});
// leaving full screen (e.g. the phone's back gesture) also closes the viewer
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && !$("#lightbox").hidden) closeLightbox(); });
function closeLightbox() {
  zmReset();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $("#lightbox").hidden = true; $("#lbTrack")._off?.(); $("#lbTrack").innerHTML = ""; lbURLs.forEach((u) => URL.revokeObjectURL(u)); lbURLs = []; }
function lbStep(d) { zmReset(); stepTrack($("#lbTrack"), d); }
$("#lbPrev").addEventListener("click", () => lbStep(-1));
$("#lbNext").addEventListener("click", () => lbStep(1));
$("#lbClose").addEventListener("click", closeLightbox);

// ---- zoom in the viewer: pinch or double-tap on phones, wheel or double-click with a mouse;
// while zoomed in, one finger (or the mouse) moves the photo instead of flipping to the next one
const zm = { s: 1, x: 0, y: 0, img: null };
function lbImg() {
  const t = $("#lbTrack"), k = Math.round(t.scrollLeft / (t.clientWidth || 1));
  return t.children[k]?.querySelector("img") || null;
}
// the visible picture inside the <img> box (object-fit: contain leaves bars around it)
function zmBox(img) {
  const W = img.clientWidth, H = img.clientHeight, r = (img.naturalWidth || W) / (img.naturalHeight || H);
  const cw = Math.min(W, H * r), ch = Math.min(H, W / r);
  return { W, H, cw, ch, ox: (W - cw) / 2, oy: (H - ch) / 2 };
}
function zmClamp() {
  const b = zmBox(zm.img);
  const fit = (t, size, c, o) => {
    const lo = size - zm.s * (o + c), hi = -zm.s * o;           // content edges must cover the box
    return zm.s * c <= size ? (size - zm.s * c) / 2 - zm.s * o : Math.min(hi, Math.max(lo, t));
  };
  zm.x = fit(zm.x, b.W, b.cw, b.ox); zm.y = fit(zm.y, b.H, b.ch, b.oy);
}
function zmApply(anim) {
  const img = zm.img; if (!img) return;
  img.style.transition = anim ? "transform .22s ease" : "none";
  img.style.transformOrigin = "0 0";
  img.style.transform = zm.s > 1 ? `translate(${zm.x}px,${zm.y}px) scale(${zm.s})` : "";
  $("#lightbox").classList.toggle("zoomed", zm.s > 1);
}
function zmReset(anim) {
  if (zm.img) { zm.s = 1; zm.x = zm.y = 0; zmApply(anim); }
  zm.img = null; $("#lightbox").classList.remove("zoomed", "pinching");
}
// scale to s around the screen point (cx, cy)
function zmTo(s, cx, cy, anim) {
  zm.img ||= lbImg(); if (!zm.img) return;
  const r = zm.img.getBoundingClientRect();                     // includes the current transform
  const ix = (cx - r.left) / zm.s, iy = (cy - r.top) / zm.s;    // point in unscaled image coords
  const s0 = zm.s;
  zm.s = Math.max(1, Math.min(6, s));
  zm.x += ix * (s0 - zm.s); zm.y += iy * (s0 - zm.s);
  if (zm.s <= 1.01) { zm.s = 1; zm.x = zm.y = 0; }
  zmClamp(); zmApply(anim);
}
const zmToggle = (cx, cy) => (zm.s > 1 ? zmTo(1, cx, cy, true) : zmTo(2.5, cx, cy, true));
{
  const track = $("#lbTrack");
  let pinch = null, pan = null, lastTap = { t: 0, x: 0, y: 0 }, moved = false;
  const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
  track.addEventListener("touchstart", (e) => {
    moved = false;
    if (e.touches.length === 2) {
      e.preventDefault();
      zm.img ||= lbImg(); if (!zm.img) return;
      $("#lightbox").classList.add("pinching");                  // stop the strip from scrolling
      pinch = { d: dist(e.touches[0], e.touches[1]), m: mid(e.touches[0], e.touches[1]), s: zm.s };
      pan = null;
    } else if (e.touches.length === 1 && zm.s > 1) {
      e.preventDefault();
      pan = { x: e.touches[0].clientX, y: e.touches[0].clientY, zx: zm.x, zy: zm.y };
    }
  }, { passive: false });
  track.addEventListener("touchmove", (e) => {
    moved = true;
    if (pinch && e.touches.length >= 2) {
      e.preventDefault();
      const m = mid(e.touches[0], e.touches[1]);
      zmTo(pinch.s * dist(e.touches[0], e.touches[1]) / pinch.d, pinch.m.x, pinch.m.y);
      zm.x += m.x - pinch.m.x; zm.y += m.y - pinch.m.y;           // two fingers also drag
      pinch.m = m; zmClamp(); zmApply();
    } else if (pan && e.touches.length === 1) {
      e.preventDefault();
      zm.x = pan.zx + e.touches[0].clientX - pan.x; zm.y = pan.zy + e.touches[0].clientY - pan.y;
      zmClamp(); zmApply();
    }
  }, { passive: false });
  track.addEventListener("touchend", (e) => {
    if (pinch && e.touches.length < 2) {
      pinch = null;
      $("#lightbox").classList.remove("pinching");
      if (zm.s <= 1) zmReset(true);
      if (e.touches.length === 1 && zm.s > 1) pan = { x: e.touches[0].clientX, y: e.touches[0].clientY, zx: zm.x, zy: zm.y };
      lastTap.t = 0; return;
    }
    if (!e.touches.length) pan = null;
    // double tap
    const t = e.changedTouches[0];
    if (moved || e.touches.length || !t) return;
    const now = performance.now();
    if (now - lastTap.t < 320 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 40) {
      e.preventDefault(); zmToggle(t.clientX, t.clientY); lastTap.t = 0;
    } else lastTap = { t: now, x: t.clientX, y: t.clientY };
  }, { passive: false });
  // mouse
  track.addEventListener("wheel", (e) => {
    e.preventDefault();
    zmTo(zm.s * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0022)), e.clientX, e.clientY);
  }, { passive: false });
  track.addEventListener("dblclick", (e) => { if (e.pointerType !== "touch") zmToggle(e.clientX, e.clientY); });
  let drag = null;
  track.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || zm.s <= 1) return;
    e.preventDefault(); drag = { x: e.clientX, y: e.clientY, zx: zm.x, zy: zm.y }; track.setPointerCapture(e.pointerId);
  });
  track.addEventListener("pointermove", (e) => {
    if (!drag) return;
    zm.x = drag.zx + e.clientX - drag.x; zm.y = drag.zy + e.clientY - drag.y; zmClamp(); zmApply();
  });
  const endDrag = () => { drag = null; };
  track.addEventListener("pointerup", endDrag); track.addEventListener("pointercancel", endDrag);
  // a new photo on screen starts unzoomed; so does a rotated phone
  addEventListener("resize", () => { if (!$("#lightbox").hidden) zmReset(); });
}

// ---------------- pin preview ("peek"): photos at a glance ----------------
const peek = { id: null, pinned: false, over: false, photos: [], urls: [], showTimer: 0, hideTimer: 0 };
async function showPeek(id, pinned) {
  const p = state.places.get(id); if (!p) return;
  clearTimeout(peek.hideTimer);
  if (peek.id === id && !$("#peek").hidden) { peek.pinned ||= pinned; return; }
  peek.id = id; peek.pinned = pinned;
  closePopover(); onlySheet("peek");
  $("#pkName").textContent = p.name;
  $("#pkMeta").textContent = [p.visits?.map(fmtVisit).slice(0, 2).join(", "), p.country].filter(Boolean).join(" · ");
  $("#pkNotes").textContent = (p.notes || "").trim();
  $("#pkNotes").hidden = !p.notes?.trim();
  let photos = await store.photosOf(id);
  if (peek.id !== id) return;
  // photos trip by trip (newest trip first, photos without a trip last), so the caption
  // under the picture can name the trip of the photo on screen
  const order = new Map(p.visits.map((v, i) => [v.id, i]));
  const rank = (ph) => { const t = tripOf(p, ph); return t ? order.get(t) : 1e9; };
  photos = photos.map((ph) => ({ ph, r: rank(ph) })).sort((a, b) => a.r - b.r || (a.ph.takenAt || a.ph.addedAt) - (b.ph.takenAt || b.ph.addedAt)).map((x) => x.ph);
  peek.urls.forEach((u) => URL.revokeObjectURL(u));
  peek.photos = photos;
  peek.place = p;
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
// counter + caption for the photo on screen: its trip (or the month it was taken), and the country
function updatePeekCount(i = 0) {
  const n = peek.photos.length, p = peek.place, ph = peek.photos[i];
  $("#pkCount").textContent = n > 1 ? `${i + 1} / ${n}` : n === 1 ? "1 photo" : "";
  if (!p || !ph) return;
  const t = tripOf(p, ph), v = t && p.visits.find((x) => x.id === t);
  const when = v ? fmtVisit(v) : ph.takenAt ? fmtVisit({ y: new Date(ph.takenAt).getFullYear(), m: new Date(ph.takenAt).getMonth() + 1 }) : "";
  $("#pkMeta").textContent = [when, p.country].filter(Boolean).join(" · ");
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
  if (show) { if (wizOpen()) wizCancel(); onlySheet("list"); renderList(); }
}
$("#btnList").addEventListener("click", () => toggleList());

async function listStats() {
  const all = [...state.places.values()];
  return { countries: new Set(all.map((p) => p.country).filter(Boolean)).size, places: all.length, photos: await store.countPhotos() };
}
const statTiles = (st) => [["Countries", st.countries], ["Places", st.places], ["Photos", st.photos]]
  .map(([l, n]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join("");

let listTab = "history", peakLabels = [], statsRender = 0;
const fmtLat = (lat) => `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? "N" : "S"}`;
const recRow = (label, p, value) => `<button class="place hist rec" data-id="${esc(p.id)}"><span>${esc(label)}<small>${esc(p.name)}${p.country ? " · " + esc(p.country) : ""}</small></span><b>${esc(value)}</b></button>`;
// a sea or ocean and the places by it; tapping opens the first place
const waterRow = (name, ps) => `<button class="place hist rec" data-id="${esc(ps[0].id)}"><span>${esc(name)}<small>${esc(ps.map((p) => p.name).slice(0, 3).join(", "))}${ps.length > 3 ? ` +${ps.length - 3}` : ""}</small></span></button>`;
// the Statistics tab: the counts, then extremes and waters (these need data files / a lookup, so they fill in after)
async function statsHTML(st) {
  const geo = [...state.places.values()].filter((p) => p.status !== "label" && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  let html = `<div class="stats stats-tab">${statTiles(st)}</div>`;
  if (!geo.length) return html + `<p class="empty">Stick a few pins to see your records here.</p>`;
  const north = geo.reduce((a, b) => (b.lat > a.lat ? b : a)), south = geo.reduce((a, b) => (b.lat < a.lat ? b : a));
  const [w, h] = await Promise.all([waters(geo).catch(() => null), heights(geo, peakLabels).catch(() => new Map())]);
  html += `<div class="country-h"><span>Records</span></div>` + recRow("Northernmost", north, fmtLat(north.lat)) + recRow("Southernmost", south, fmtLat(south.lat));
  const top = geo.filter((p) => h.has(p.id)).sort((a, b) => h.get(b.id) - h.get(a.id))[0];
  html += top ? recRow("Highest", top, `${h.get(top.id).toLocaleString("en-US")} m`) : `<p class="empty">Highest point: couldn't look up heights — check the connection.</p>`;
  if (w) {
    const oceans = OCEANS.filter((o) => w.oceans.has(o)), seas = [...w.seas.keys()].sort();
    html += `<div class="country-h"><span>Oceans</span><span>${oceans.length} of ${OCEANS.length}</span></div>`
      + (oceans.length ? oceans.map((o) => waterRow(o, w.oceans.get(o))).join("") : `<p class="empty">None yet.</p>`);
    html += `<div class="country-h"><span>Seas</span><span>${seas.length}</span></div>`
      + (seas.length ? seas.map((s) => waterRow(s, w.seas.get(s))).join("") : `<p class="empty">None yet.</p>`);
  }
  return html + `<p class="credit">A sea or ocean counts if a place is on it or within 10 km of its shore. Heights: Copernicus DEM via Open-Meteo. Seas: Natural Earth.</p>`;
}
async function renderList() {
  const st = await listStats();
  $("#stats").innerHTML = statTiles(st);
  document.querySelectorAll("#listTabs [data-tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === listTab));
  if (listTab === "stats") {
    const token = ++statsRender;
    $("#places").innerHTML = `<div class="stats stats-tab">${statTiles(st)}</div><p class="empty">Counting records, oceans and seas…</p>`;
    const html = await statsHTML(st);
    if (token === statsRender && listTab === "stats") $("#places").innerHTML = html;
    return;
  }
  statsRender++;
  $("#places").innerHTML = historyHTML();
}
// History: every trip (month + year) newest first, grouped by year; places without a date at the end
function historyHTML() {
  const rows = [];
  for (const p of state.places.values()) {
    if (p.visits?.length) for (const v of p.visits) rows.push({ p, y: v.y, m: v.m || 0 });
    else rows.push({ p, y: 0, m: 0 });
  }
  if (!rows.length) return `<p class="empty">No places yet. Click on the map, search, or add photos to stick your first pin.</p>`;
  rows.sort((a, b) => b.y - a.y || b.m - a.m || a.p.name.localeCompare(b.p.name));
  let html = "", year = null;
  for (const r of rows) {
    if (r.y !== year) {
      year = r.y;
      const n = rows.filter((x) => x.y === year).length;
      html += `<div class="country-h"><span>${year ? year : "No date"}</span><span>${n}</span></div>`;
    }
    const month = r.m ? MONTHS[r.m - 1].slice(0, 3) : "";
    html += `<button class="place hist" data-id="${esc(r.p.id)}"><i></i><span>${esc(r.p.name)}<small>${esc(r.p.country || "")}</small></span><small>${esc(month)}</small></button>`;
  }
  return html;
}
$("#listTabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]"); if (!b) return;
  listTab = b.dataset.tab; renderList();
});
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
const ICON = { country: "▦", capital: "★", city: "●", town: "•", ocean: "≈", sea: "≈", lake: "≈", bay: "≈", gulf: "≈", peak: "▲", mountain: "▲", volcano: "▲", range: "⋀", waterfall: "⌇", island: "◌", islands: "◌", desert: "∴", canyon: "⋁", park: "♣", forest: "♣", glacier: "❄",
  village: "•", district: "•", beach: "◠", "nature park": "♣", sight: "✦", viewpoint: "◉", museum: "▣", castle: "♜", fort: "♜",
  ruins: "♜", monument: "✦", monastery: "✝", temple: "✦", cave: "◖", cape: "◣", "hot spring": "≈", spring: "≈", lagoon: "≈", "theme park": "✦", zoo: "✦" };
function renderResults(text) {
  const r = state.results;
  const row = (it, i) => {
    const sub = it.mine ? ["Your place", it.country].filter(Boolean).join(" · ") :
      [kindLabel(it.kind), it.country || it.sub?.split(",").slice(-1)[0]?.trim()].filter(Boolean).join(" · ");
    const icon = it.mine ? "●" : ICON[it.kind] || "•";
    return `<button class="res" role="option" data-n="${i}" aria-selected="${i === state.sel}"><span class="ic" ${it.mine ? `style="color:var(--pin-visited)"` : ""}>${icon}</span><span><b>${esc(it.name)}</b><small>${esc(sub)}</small></span></button>`;
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
  if (w === "card") closeCard(); else if (w === "auth") closeAuth(); else toggleList(false);
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
    else if (wizOpen()) wizCancel();
    else if (!$("#card").hidden) closeCard();
  }
});

function fmtLL(lon, lat) {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
}
function whenShort(p) {
  if (!p.visits?.length) return "";
  return fmtVisitShort(p.visits[0]) + (p.visits.length > 1 ? ` +${p.visits.length - 1}` : "");
}
