// Local storage of places and photos in IndexedDB (falls back to memory if unavailable).
// Swap this module for a server API later (Supabase etc.) — the rest of the app only
// uses the functions exported here.

const DB_NAME = "pinmap", DB_VER = 1;
let dbPromise = null;
let memory = null;   // fallback: { places: Map, photos: Map }

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

export function allPlaces() {
  if (memory) return Promise.resolve([...memory.places.values()]);
  return run("places", "readonly", (s) => s.getAll());
}
export function putPlace(p) {
  p.updatedAt = Date.now();
  if (memory) { memory.places.set(p.id, p); return Promise.resolve(); }
  return run("places", "readwrite", (s) => s.put(p));
}
export async function deletePlace(id) {
  const photos = await photosOf(id);
  if (memory) { memory.places.delete(id); photos.forEach((p) => memory.photos.delete(p.id)); return; }
  await run("photos", "readwrite", (s) => { photos.forEach((p) => s.delete(p.id)); });
  await run("places", "readwrite", (s) => s.delete(id));
}

export function photosOf(placeId) {
  if (memory) return Promise.resolve([...memory.photos.values()].filter((p) => p.placeId === placeId));
  return run("photos", "readonly", (s) => s.index("placeId").getAll(placeId))
    .then((l) => l.sort((a, b) => a.addedAt - b.addedAt));
}
export function putPhoto(p) {
  if (memory) { memory.photos.set(p.id, p); return Promise.resolve(); }
  return run("photos", "readwrite", (s) => s.put(p));
}
export function deletePhoto(id) {
  if (memory) { memory.photos.delete(id); return Promise.resolve(); }
  return run("photos", "readwrite", (s) => s.delete(id));
}
export function countPhotos() {
  if (memory) return Promise.resolve(memory.photos.size);
  return run("photos", "readonly", (s) => s.count());
}
function allPhotos() {
  if (memory) return Promise.resolve([...memory.photos.values()]);
  return run("photos", "readonly", (s) => s.getAll());
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

export async function exportAll() {
  const places = await allPlaces();
  const photos = [];
  for (const p of await allPhotos()) {
    photos.push({ ...p, blob: await toDataURL(p.blob), thumb: await toDataURL(p.thumb) });
  }
  return { app: "pinmap", version: 1, exportedAt: new Date().toISOString(), places, photos };
}

export async function importAll(data) {
  if (!data || data.app !== "pinmap" || !Array.isArray(data.places)) throw new Error("Not a Pinmap backup file");
  for (const p of data.places) await putPlace(p);
  for (const ph of data.photos || []) {
    await putPhoto({ ...ph, blob: await fromDataURL(ph.blob), thumb: await fromDataURL(ph.thumb) });
  }
  return data.places.length;
}
