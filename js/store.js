// Local copy of places and photos in IndexedDB (falls back to memory if unavailable).
// The app reads and writes only here; js/sync.js mirrors changes to the cloud.
//
// Sync bookkeeping on every record:
//   updatedAt  – client time of the last edit (last write wins)
//   dirty      – changed here and not yet sent to the cloud (undefined = older record, also unsent)
//   deleted    – tombstone, kept until the deletion reaches the cloud
// Photos may arrive from another device without image data (blob / thumb = null);
// sync.fetchBlob() downloads them on demand.

const DB_NAME = "pinmap", DB_VER = 1;
let dbPromise = null;
let memory = null;   // fallback: { places: Map, photos: Map }
const listeners = [];
export const onChange = (fn) => listeners.push(fn);
const changed = () => listeners.forEach((f) => f());

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VER); } catch (e) { return rej(e); }
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("places", { keyPath: "id" });
        const ph = db.createObjectStore("photos", { keyPath: "id" });
        ph.createIndex("placeId", "placeId");
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
      req.onblocked = () => rej(new Error("IndexedDB blocked"));
    });
  }
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => res(r && "result" in r ? r.result : undefined);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  }));
}

export async function init() {
  try { await open(); return true; }
  catch { memory = { places: new Map(), photos: new Map() }; return false; }
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const isDirty = (r) => r.dirty !== false;

// ---------- raw access ----------
const getAll = (s) => (memory ? Promise.resolve([...memory[s].values()]) : run(s, "readonly", (st) => st.getAll()));
const getOne = (s, id) => (memory ? Promise.resolve(memory[s].get(id)) : run(s, "readonly", (st) => st.get(id)));
const putRaw = (s, r) => (memory ? (memory[s].set(r.id, r), Promise.resolve()) : run(s, "readwrite", (st) => st.put(r)));
const delRaw = (s, id) => (memory ? (memory[s].delete(id), Promise.resolve()) : run(s, "readwrite", (st) => st.delete(id)));
export const getPlace = (id) => getOne("places", id);
export const getPhoto = (id) => getOne("photos", id);

// ---------- places ----------
export async function allPlaces() { return (await getAll("places")).filter((p) => !p.deleted); }

/** Save a place edited here (marks it for upload). `remote` = applying a change from the cloud. */
export async function putPlace(p, { remote = false } = {}) {
  if (!remote) { p.updatedAt = Date.now(); p.dirty = true; }
  await putRaw("places", p);
  if (!remote) changed();
}

export async function deletePlace(id) {
  const p = await getPlace(id);
  for (const ph of await photosOf(id)) await deletePhoto(ph.id, { silent: true });
  if (p) await putRaw("places", { id, deleted: true, dirty: true, updatedAt: Date.now() });
  changed();
}

// ---------- photos ----------
export async function photosOf(placeId) {
  const l = memory ? [...memory.photos.values()].filter((p) => p.placeId === placeId)
    : await run("photos", "readonly", (s) => s.index("placeId").getAll(placeId));
  return l.filter((p) => !p.deleted).sort((a, b) => (a.takenAt || a.addedAt) - (b.takenAt || b.addedAt));
}
export async function putPhoto(ph, { remote = false } = {}) {
  if (!remote) { ph.updatedAt = Date.now(); ph.dirty = true; }
  await putRaw("photos", ph);
  if (!remote) changed();
}
/** Store downloaded image data without marking the photo as edited. */
export async function putPhotoBlob(id, kind, blob) {
  const ph = await getPhoto(id); if (!ph) return;
  ph[kind] = blob;
  await putRaw("photos", ph);
}
export async function deletePhoto(id, { silent = false } = {}) {
  const ph = await getPhoto(id); if (!ph) return;
  await putRaw("photos", { id, placeId: ph.placeId, uploaded: ph.uploaded, deleted: true, dirty: true, updatedAt: Date.now() });
  if (!silent) changed();
}
export async function listPhotos() { return (await getAll("photos")).filter((p) => !p.deleted).sort((a, b) => (b.takenAt || b.addedAt) - (a.takenAt || a.addedAt)); }
export async function countPhotos() { return (await getAll("photos")).filter((p) => !p.deleted).length; }

// ---------- for sync ----------
export async function dirtyPlaces() { return (await getAll("places")).filter(isDirty); }
export async function dirtyPhotos() { return (await getAll("photos")).filter(isDirty); }
export async function photosMissing(kind) { return (await getAll("photos")).filter((p) => !p.deleted && !p[kind]); }
/** After an upload: clear `dirty` unless the record was edited again meanwhile. */
export async function markClean(s, id, updatedAt, extra = {}) {
  const r = await getOne(s, id); if (!r || r.updatedAt !== updatedAt) return;
  Object.assign(r, extra, { dirty: false });
  await putRaw(s, r);
}
export const purge = (s, id) => delRaw(s, id);
export async function purgePlaceAndPhotos(id) {
  for (const ph of (await getAll("photos")).filter((p) => p.placeId === id)) await delRaw("photos", ph.id);
  await delRaw("places", id);
}

/** Remove everything from this device (used on sign-out; the cloud copy stays). */
export async function clearAll() {
  if (memory) { memory.places.clear(); memory.photos.clear(); return; }
  await run("places", "readwrite", (s) => s.clear());
  await run("photos", "readwrite", (s) => s.clear());
}

// ---------- backup ----------
const toDataURL = (blob) => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob);
});
function fromDataURL(u) {
  const [head, b64] = u.split(",");
  const mime = (head.match(/:(.*?);/) || [, "image/jpeg"])[1];
  const bin = atob(b64), a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return new Blob([a], { type: mime });
}
const SYNC_FIELDS = ["dirty", "uploaded", "deleted"];
const strip = (r) => { const o = { ...r }; SYNC_FIELDS.forEach((k) => delete o[k]); return o; };

/** Backup of everything stored on this device (photos not yet downloaded are listed in `missing`). */
export async function exportAll() {
  const places = (await allPlaces()).map(strip);
  const photos = [], missing = [];
  for (const p of await getAll("photos")) {
    if (p.deleted) continue;
    if (!p.blob || !p.thumb) { missing.push(p.id); continue; }
    photos.push({ ...strip(p), blob: await toDataURL(p.blob), thumb: await toDataURL(p.thumb) });
  }
  return { app: "pinmap", version: 2, exportedAt: new Date().toISOString(), places, photos, missing };
}

export async function importAll(data) {
  if (!data || data.app !== "pinmap" || !Array.isArray(data.places)) throw new Error("Not a Pinmap backup file");
  for (const p of data.places) await putPlace({ ...p });
  for (const ph of data.photos || []) {
    await putPhoto({ ...ph, blob: fromDataURL(ph.blob), thumb: fromDataURL(ph.thumb) });
  }
  return data.places.length;
}
