// Statistics from the places on the map: northernmost / southernmost place, highest place,
// oceans and seas visited.
//
// Seas and oceans: data/marine.json holds the Natural Earth marine areas (oceans, seas, gulfs,
// bays, straits…), each with the sea and the ocean it belongs to (scripts/build_marine.py).
// A place counts for an area if it lies in it or within NEAR_KM of its shore. Enclosed seas
// (Mediterranean, Black, Baltic, Red, Caspian, Persian Gulf…) count as seas but not as an ocean.
//
// Height above sea level: Copernicus DEM (90 m) via the Open-Meteo elevation API, cached on this
// device. For a summit, the height from the map's own peak labels wins if it is higher.

const NEAR_KM = 10;
const KM_PER_DEG = 111.32;
const ELEV_KEY = "pinmap:elev";
export const OCEANS = ["Pacific Ocean", "Atlantic Ocean", "Indian Ocean", "Southern Ocean", "Arctic Ocean"];

let marine = null;
async function loadMarine(url) {
  if (marine) return marine;
  const data = await (await fetch(url)).json();
  marine = data.map((a) => {
    let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
    for (const r of a.r) for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return { ...a, box: [x0, y0, x1, y1] };
  });
  return marine;
}

// is the point inside the area, or closer than km to its edge?
function near(a, lon, lat, km) {
  const dy = km / KM_PER_DEG, kx = Math.cos((lat * Math.PI) / 180), dx = dy / Math.max(kx, 0.05);
  const [x0, y0, x1, y1] = a.box;
  if (lon < x0 - dx || lon > x1 + dx || lat < y0 - dy || lat > y1 + dy) return false;
  let inside = false, best = Infinity;
  for (const r of a.r) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      // distance to the segment, in km, on a local flat projection around the point
      const ax = (xj - lon) * kx, ay = yj - lat, bx = (xi - lon) * kx, by = yi - lat;
      const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
      const t = l2 ? Math.max(0, Math.min(1, -(ax * ex + ay * ey) / l2)) : 0;
      const px = ax + t * ex, py = ay + t * ey, d = px * px + py * py;
      if (d < best) best = d;
    }
  }
  return inside || Math.sqrt(best) * KM_PER_DEG <= km;
}

/** Seas and oceans touched by the places: { seas: Map(name → [place]), oceans: Map(name → [place]) } */
export async function waters(places, url = "data/marine.json") {
  const areas = await loadMarine(url);
  const seas = new Map(), oceans = new Map();
  const put = (m, k, p) => { if (!k) return; const l = m.get(k) || m.set(k, []).get(k); if (!l.includes(p)) l.push(p); };
  for (const p of places) {
    for (const a of areas) {
      if (!near(a, p.lon, p.lat, NEAR_KM)) continue;
      if (a.c === "sea") put(seas, a.n, p);
      put(seas, a.s, p);
      put(oceans, a.o, p);
    }
  }
  return { seas, oceans };
}

/** Height above sea level (m) of each place, by id; places that couldn't be looked up are missing. */
export async function heights(places, peaks = []) {
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(ELEV_KEY) || "{}"); } catch {}
  const key = (p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
  const todo = [...new Map(places.filter((p) => !(key(p) in cache)).map((p) => [key(p), p])).values()];
  for (let i = 0; i < todo.length; i += 100) {
    const part = todo.slice(i, i + 100);
    try {
      const u = `https://api.open-meteo.com/v1/elevation?latitude=${part.map((p) => p.lat.toFixed(4)).join(",")}&longitude=${part.map((p) => p.lon.toFixed(4)).join(",")}`;
      const r = await fetch(u);
      if (!r.ok) break;
      const { elevation } = await r.json();
      part.forEach((p, k) => { if (Number.isFinite(elevation?.[k])) cache[key(p)] = Math.round(elevation[k]); });
    } catch { break; }   // offline: show what we have, try again next time
  }
  try { localStorage.setItem(ELEV_KEY, JSON.stringify(cache)); } catch {}
  const out = new Map();
  for (const p of places) {
    let h = cache[key(p)];
    if (p.kind === "peak") {
      // summits: the DEM smooths the top off, so prefer the peak's known height
      for (const [, kind, lon, lat, , elev] of peaks) {
        if (kind !== "peak" || !elev) continue;
        const d = Math.hypot((lon - p.lon) * Math.cos((p.lat * Math.PI) / 180), lat - p.lat) * KM_PER_DEG;
        if (d < 3) h = Math.max(h ?? -Infinity, elev);
      }
    }
    if (Number.isFinite(h)) out.set(p.id, h);
  }
  return out;
}
