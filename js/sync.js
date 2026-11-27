// Cloud sync: one account, the same map on every device.
//
// Every device keeps a full local copy (js/store.js), so the map works offline.
// sync() = push local changes (records marked dirty) → pull what changed on the server
// since the last pull. Conflicts: the most recent edit wins (by updatedAt).
// Photo files are uploaded with their record and downloaded lazily: thumbnails in the
// background, full-size images when someone opens them.
/* global supabase */
import * as store from "./store.js";

let remote = null;      // adapter: supabase or the local test fake
let user = null;
let status = { state: "off", lastSync: null, error: "" };
const listeners = { status: [], data: [], prefs: [] };
let lastPrefs = null;
const emit = (n, v) => listeners[n].forEach((f) => f(v));
const setStatus = (s) => { status = { ...status, ...s }; emit("status", { ...status, user }); };

export const on = (n, f) => listeners[n].push(f);
export const available = () => !!remote;
export const currentUser = () => user;
export const getStatus = () => ({ ...status, user });

// ---------- setup ----------
export async function init(cfg) {
  if (cfg?.fake && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    remote = (await import("./remote-fake.js")).createFakeRemote();
  } else if (cfg?.url && cfg?.key && window.supabase) {
    remote = supabaseRemote(cfg.url, cfg.key);
  }
  if (!remote) return false;
  remote.onAuth((u) => {
    const was = user?.id;
    user = u;
    setStatus({ state: u ? "idle" : "signed-out", error: "" });
    if (u && u.id !== was) syncNow();
  });
  user = await remote.getUser();
  setStatus({ state: user ? "idle" : "signed-out" });
  store.onChange(schedulePush);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncNow(); });
  addEventListener("online", () => syncNow());
  setInterval(() => { if (!document.hidden) syncNow(); }, 30000);
  if (user) syncNow();
  return true;
}

export async function signIn(email, password) { user = await remote.signIn(email, password); setStatus({ state: "idle" }); syncNow(); return user; }
export async function signUp(email, password) {
  const r = await remote.signUp(email, password);
  if (r.session) { user = r.user; setStatus({ state: "idle" }); syncNow(); }
  return r;   // no session → the user must confirm the email first
}
export async function signOut() {
  await syncNow().catch(() => {});
  await remote.signOut();
  user = null;
  lastPrefs = null;
  setStatus({ state: "signed-out", lastSync: null });
}

// ---------- sync ----------
let pushTimer = 0, running = null, again = false;
function schedulePush() {
  if (!user) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(syncNow, 1500);
}

export function syncNow() {
  if (!remote || !user) return Promise.resolve();
  if (running) { again = true; return running; }
  running = (async () => {
    setStatus({ state: "syncing", error: "" });
    try {
      do {
        again = false;
        await push();
        const changedCount = await pull();
        if (changedCount) emit("data", changedCount);
        await pullPrefs();
      } while (again);
      setStatus({ state: "idle", lastSync: new Date(), error: "" });
      downloadThumbs();   // background
    } catch (e) {
      console.warn("sync failed", e);
      setStatus({ state: navigator.onLine === false ? "offline" : "error", error: e?.message || String(e) });
    } finally { running = null; }
  })();
  return running;
}

const placeData = (p) => {
  const d = { ...p };
  for (const k of ["dirty", "deleted", "updatedAt"]) delete d[k];
  return d;
};
const photoData = (ph) => ({ w: ph.w, h: ph.h, name: ph.name, takenAt: ph.takenAt ?? null, addedAt: ph.addedAt });
const filePath = (id, kind) => `${user.id}/${id}${kind === "thumb" ? "_t" : ""}.jpg`;

async function push() {
  // places first, so a photo never points at a place the server doesn't know yet
  const places = await store.dirtyPlaces();
  for (let i = 0; i < places.length; i += 200) {
    const chunk = places.slice(i, i + 200);
    await remote.upsert("places", chunk.map((p) => ({
      id: p.id, user_id: user.id, data: p.deleted ? {} : placeData(p), updated_at: p.updatedAt || Date.now(), deleted: !!p.deleted,
    })));
    for (const p of chunk) {
      if (p.deleted) await store.purge("places", p.id);
      else await store.markClean("places", p.id, p.updatedAt);
    }
  }
  for (const ph of await store.dirtyPhotos()) {
    if (ph.deleted) {
      if (ph.uploaded) await remote.remove([filePath(ph.id, "blob"), filePath(ph.id, "thumb")]).catch(() => {});
      await remote.upsert("photos", [{ id: ph.id, user_id: user.id, place_id: ph.placeId, data: {}, updated_at: ph.updatedAt || Date.now(), deleted: true }]);
      await store.purge("photos", ph.id);
      continue;
    }
    if (!ph.uploaded) {
      if (!ph.blob || !ph.thumb) continue;          // nothing to upload (shouldn't happen)
      await remote.upload(filePath(ph.id, "blob"), ph.blob);
      await remote.upload(filePath(ph.id, "thumb"), ph.thumb);
    }
    await remote.upsert("photos", [{ id: ph.id, user_id: user.id, place_id: ph.placeId, data: photoData(ph), updated_at: ph.updatedAt || Date.now(), deleted: false }]);
    await store.markClean("photos", ph.id, ph.updatedAt, { uploaded: true });
  }
}

// Pull with a one-minute overlap: rows committed slightly out of order are not missed,
// and applying a row twice is harmless.
async function pull() {
  const key = `pinmap:cursor:${user.id}`;
  let cursor = null;
  try { cursor = localStorage.getItem(key); } catch { /* no storage */ }
  const since = cursor ? new Date(new Date(cursor).getTime() - 60000).toISOString() : null;
  let n = 0, max = cursor;
  const bump = (r) => { if (!max || r.server_at > max) max = r.server_at; };

  for (const r of await remote.pull("places", since)) {
    bump(r);
    const local = await store.getPlace(r.id);
    if (r.deleted) { if (local) { await store.purgePlaceAndPhotos(r.id); n++; } continue; }
    if (local && local.dirty !== false && (local.updatedAt || 0) > r.updated_at) continue;   // local edit is newer
    if (local && !local.deleted && local.updatedAt === r.updated_at) continue;              // already have it
    if (local?.deleted) continue;                                                             // deleted here, not pushed yet
    await store.putPlace({ ...r.data, id: r.id, updatedAt: r.updated_at, dirty: false }, { remote: true });
    n++;
  }
  for (const r of await remote.pull("photos", since)) {
    bump(r);
    const local = await store.getPhoto(r.id);
    if (r.deleted) { if (local) { await store.purge("photos", r.id); n++; } continue; }
    if (local?.deleted || (local && local.updatedAt >= r.updated_at)) continue;
    await store.putPhoto({
      ...(local || {}), ...r.data, id: r.id, placeId: r.place_id, updatedAt: r.updated_at,
      blob: local?.blob || null, thumb: local?.thumb || null, uploaded: true, dirty: false,
    }, { remote: true });
    n++;
  }
  if (max && max !== cursor) { try { localStorage.setItem(key, max); } catch { /* ignore */ } }
  return n;
}

// ---------- account preferences (e.g. the chosen background) ----------
async function pullPrefs() {
  const p = await remote.getPrefs().catch(() => null);
  if (p && JSON.stringify(p) !== JSON.stringify(lastPrefs)) { lastPrefs = p; emit("prefs", p); }
}
export async function setPrefs(patch) {
  if (!remote || !user) return;
  lastPrefs = { ...(lastPrefs || {}), ...patch };
  await remote.setPrefs(lastPrefs).catch((e) => console.warn("prefs not saved", e));
}

// ---------- photo files ----------
const inflight = new Map();
/** Image data of a photo: local copy, or downloaded from the cloud (and kept). kind: "thumb" | "blob". */
export function fetchBlob(ph, kind) {
  if (ph[kind]) return Promise.resolve(ph[kind]);
  if (!remote || !user || !ph.uploaded) return Promise.resolve(null);
  const k = ph.id + kind;
  if (!inflight.has(k)) {
    inflight.set(k, remote.download(filePath(ph.id, kind))
      .then(async (b) => { await store.putPhotoBlob(ph.id, kind, b); ph[kind] = b; return b; })
      .catch(() => null)
      .finally(() => inflight.delete(k)));
  }
  return inflight.get(k);
}
let thumbsRunning = false;
async function downloadThumbs() {
  if (thumbsRunning) return;
  thumbsRunning = true;
  try {
    const list = await store.photosMissing("thumb");
    for (let i = 0; i < list.length; i += 4) await Promise.all(list.slice(i, i + 4).map((ph) => fetchBlob(ph, "thumb")));
    if (list.length) emit("data", 0);
  } finally { thumbsRunning = false; }
}

// ---------- Supabase adapter ----------
function supabaseRemote(url, key) {
  const sb = supabase.createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  const ok = ({ data, error }) => { if (error) throw error; return data; };
  return {
    async getUser() { return (await sb.auth.getSession()).data.session?.user || null; },
    onAuth(fn) { sb.auth.onAuthStateChange((_e, s) => fn(s?.user || null)); },
    async signIn(email, password) { return ok(await sb.auth.signInWithPassword({ email, password })).user; },
    async signUp(email, password) {
      return ok(await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }));
    },
    async signOut() { await sb.auth.signOut(); },
    async getPrefs() { return (await sb.auth.getUser()).data.user?.user_metadata?.pinmap || null; },
    async setPrefs(p) { ok(await sb.auth.updateUser({ data: { pinmap: p } })); },
    async pull(table, since) {
      const out = [];
      for (let from = 0; ; from += 1000) {
        let q = sb.from(table).select("*").order("server_at", { ascending: true }).range(from, from + 999);
        if (since) q = q.gt("server_at", since);
        const rows = ok(await q);
        out.push(...rows);
        if (rows.length < 1000) return out;
      }
    },
    async upsert(table, rows) { ok(await sb.from(table).upsert(rows)); },
    async upload(path, blob) { ok(await sb.storage.from("photos").upload(path, blob, { upsert: true, contentType: "image/jpeg" })); },
    async download(path) { return ok(await sb.storage.from("photos").download(path)); },
    async remove(paths) { ok(await sb.storage.from("photos").remove(paths)); },
  };
}
