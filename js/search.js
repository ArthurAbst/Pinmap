// Place search: a local index (Natural Earth + curated sights + GeoNames cities)
// with an optional online fallback to OpenStreetMap Nominatim.

export const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[’'`]/g, "").replace(/[-‐]/g, " ").replace(/\s+/g, " ").trim();

const KIND_LABEL = {
  country: "Country", capital: "Capital", city: "City", town: "Town", ocean: "Ocean", sea: "Sea", bay: "Bay",
  gulf: "Gulf", strait: "Strait", channel: "Channel", lake: "Lake", range: "Mountain range", desert: "Desert",
  plateau: "Plateau", plain: "Plain", basin: "Basin", peninsula: "Peninsula", delta: "Delta", valley: "Valley",
  tundra: "Tundra", wetland: "Wetland", peak: "Peak", island: "Island", islands: "Islands", cape: "Cape",
  waterfall: "Waterfall", pole: "Pole", canyon: "Canyon", mountain: "Mountain", volcano: "Volcano", park: "Nature park",
  rock: "Rock formation", glacier: "Glacier", coast: "Coast", reef: "Reef", forest: "Forest", cave: "Cave",
  river: "River", depression: "Depression", isthmus: "Isthmus", sound: "Sound", lagoon: "Lagoon", fjord: "Fjord",
};
export const kindLabel = (k) => KIND_LABEL[k] || (k ? k[0].toUpperCase() + k.slice(1).replace(/_/g, " ") : "Place");

// suggested zoom level when flying to a result
export function zoomFor(kind, sight) {
  if (sight) return 7.2;
  if (kind === "ocean") return 2.4;
  if (kind === "country") return 4;
  if (["sea", "range", "desert", "plateau", "plain", "basin", "tundra", "gulf", "bay"].includes(kind)) return 4.6;
  if (["lake", "islands", "peninsula", "delta"].includes(kind)) return 5.4;
  if (kind === "capital" || kind === "city") return 6.6;
  return 7.2;
}

export function createSearch(L) {
  const iso = L.isoNames;
  const items = [];
  const add = (name, kind, cc, lon, lat, w, extra) =>
    items.push({ name, nn: norm(name), kind, cc, country: iso[cc] || "", lon, lat, w, ...extra });

  for (const [n, , cc, lon, lat] of L.countries) add(n, "country", cc, lon, lat, 120);
  for (const [n, kind, lon, lat] of L.water) add(n, kind, "", lon, lat, kind === "ocean" ? 110 : 45);
  for (const [n, kind, lon, lat] of L.landmarks) add(n, kind, "", lon, lat, 70, { sight: true });
  for (const [n, kind, lon, lat, , elev] of L.physical) add(n, kind, "", lon, lat, kind === "peak" ? 25 + (elev || 0) / 400 : 30, elev ? { elev } : {});
  const neCity = new Map();
  for (const [n, cc, pop, lon, lat, , cap] of L.cities) {
    add(n, cap ? "capital" : "city", cc, lon, lat, 12 + Math.log10(pop + 10) * 6 + (cap ? 25 : 0), { pop });
    const k = norm(n);
    if (!neCity.has(k)) neCity.set(k, []);
    neCity.get(k).push([lon, lat]);
  }

  let gazetteer = null;
  async function loadGazetteer(url) {
    if (gazetteer) return gazetteer;
    gazetteer = fetch(url).then((r) => r.json()).then((rows) => {
      for (const [n, cc, pop, lon, lat] of rows) {
        const k = norm(n);
        const dup = (neCity.get(k) || []).some(([x, y]) => Math.abs(x - lon) < 0.3 && Math.abs(y - lat) < 0.3);
        if (!dup) add(n, pop >= 15000 ? "city" : "town", cc, lon, lat, 4 + Math.log10(pop + 10) * 6, { pop });
      }
    }).catch(() => { gazetteer = null; });
    return gazetteer;
  }

  function search(q, extra = [], limit = 12) {
    const nq = norm(q);
    if (!nq) return [];
    const top = [];
    const consider = (it, bonus = 0) => {
      const nn = it.nn || norm(it.name);
      const ix = nn.indexOf(nq);
      if (ix < 0) return;
      let s = ix === 0 ? (nn.length === nq.length ? 400 : 200) : nn[ix - 1] === " " ? 120 : 10;
      s += it.w + bonus;
      if (top.length < limit || s > top[top.length - 1].s) {
        top.push({ ...it, s });
        top.sort((a, b) => b.s - a.s);
        if (top.length > limit) top.pop();
      }
    };
    for (const it of extra) consider(it, 300);
    for (const it of items) consider(it);
    // drop near-duplicates (same name & place from different layers)
    const seen = [];
    return top.filter((r) => {
      const d = seen.some((o) => o.nn === r.nn && Math.abs(o.lon - r.lon) < 0.5 && Math.abs(o.lat - r.lat) < 0.5);
      if (!d) seen.push(r);
      return !d;
    });
  }

  // Closest named place to a coordinate (for photos with GPS). Sights win only when very close.
  const NEAR = new Set(["city", "capital", "town"]);
  function nearest(lon, lat, maxKm = 40) {
    const kx = Math.cos((lat * Math.PI) / 180) * 111.32, ky = 110.57;
    let best = null, bd = maxKm;
    for (const it of items) {
      if (!it.sight && !NEAR.has(it.kind)) continue;
      const dx = (it.lon - lon) * kx, dy = (it.lat - lat) * ky;
      if (Math.abs(dx) > maxKm || Math.abs(dy) > maxKm) continue;
      const d = Math.hypot(dx, dy);
      const eff = it.sight ? (d < 6 ? d * 0.4 : d * 3) : it.kind === "town" ? d * 1.4 : d;
      if (eff < bd) { bd = eff; best = { ...it, km: d }; }
    }
    return best;
  }

  // Everything named within maxKm of a point (for "what's here?" after a tap on the map), closest first.
  // Seas, oceans and countries are left out: they are too big to be "here".
  const SKIP = new Set(["country", "ocean", "sea"]);
  function around(lon, lat, maxKm = 20, limit = 12) {
    const kx = Math.cos((lat * Math.PI) / 180) * 111.32, ky = 110.57;
    const out = [];
    for (const it of items) {
      if (SKIP.has(it.kind)) continue;
      const dx = (it.lon - lon) * kx, dy = (it.lat - lat) * ky;
      if (Math.abs(dx) > maxKm || Math.abs(dy) > maxKm) continue;
      const d = Math.hypot(dx, dy);
      if (d <= maxKm) out.push({ ...it, km: d, rank: d / maxKm - Math.min(it.w, 90) / 300 });
    }
    return out.sort((a, b) => a.rank - b.rank).slice(0, limit);
  }

  return { search, loadGazetteer, nearest, around, countryName: (cc) => iso[cc] || "" };
}

export async function searchOnline(q) {
  const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&accept-language=en&q="
    + encodeURIComponent(q);
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const rows = await r.json();
  return rows.map((x) => ({
    name: x.name || x.display_name.split(",")[0],
    sub: x.display_name,
    kind: x.type === "administrative" ? x.addresstype || "area" : x.type,
    cc: (x.address?.country_code || "").toUpperCase(),
    country: x.address?.country || "",
    lon: +x.lon, lat: +x.lat, source: "osm",
  }));
}

// Named places around a point from OpenStreetMap (Overpass API): villages, beaches, peaks, waterfalls,
// sights… plus the island / national park the point lies in. English names where OSM has them.
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const OSM_KIND = [
  ["place", { city: "city", town: "town", village: "village", hamlet: "village", suburb: "district", quarter: "district", neighbourhood: "district", island: "island", islet: "island", archipelago: "islands", locality: "place" }],
  ["natural", { beach: "beach", peak: "peak", volcano: "volcano", bay: "bay", cape: "cape", cave_entrance: "cave", glacier: "glacier", hot_spring: "hot spring", spring: "spring", ridge: "ridge", lagoon: "lagoon" }],
  ["waterway", { waterfall: "waterfall" }],
  ["tourism", { attraction: "sight", viewpoint: "viewpoint", museum: "museum", theme_park: "theme park", zoo: "zoo" }],
  ["historic", { castle: "castle", fort: "fort", ruins: "ruins", archaeological_site: "ruins", monument: "monument", monastery: "monastery" }],
  ["amenity", { place_of_worship: "temple" }],
  ["boundary", { national_park: "nature park", protected_area: "nature park" }],
  ["leisure", { nature_reserve: "nature park", park: "park" }],
];
function osmKind(t) {
  for (const [k, map] of OSM_KIND) if (t[k] && map[t[k]]) {
    if (k === "amenity" && !(t.tourism || t.historic || t.wikidata)) return null; // only notable temples
    return map[t[k]];
  }
  return null;
}
export async function searchAround(lon, lat, km, signal) {
  const r = Math.round(Math.max(300, Math.min(25000, km * 1000)));
  const a = `(around:${r},${lat.toFixed(5)},${lon.toFixed(5)})`;
  const q = `[out:json][timeout:10];(
nwr${a}[name][place~"^(city|town|village|hamlet|suburb|quarter|neighbourhood|island|islet|archipelago|locality)$"];
nwr${a}[name][natural~"^(beach|peak|volcano|bay|cape|cave_entrance|glacier|hot_spring|ridge|lagoon)$"];
nwr${a}[name][waterway=waterfall];
nwr${a}[name][tourism~"^(attraction|viewpoint|museum|theme_park|zoo)$"];
nwr${a}[name][historic~"^(castle|fort|ruins|archaeological_site|monument|monastery)$"];
nwr${a}[name][amenity=place_of_worship][wikidata];
nwr${a}[name][boundary~"^(national_park|protected_area)$"];
nwr${a}[name][leisure=nature_reserve];
);out center tags qt 150;
is_in(${lat.toFixed(5)},${lon.toFixed(5)})->.in;
area.in[name][place~"^(island|islet|archipelago)$"];out tags;
area.in[name][boundary=national_park];out tags;`;
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(q), signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const { elements = [] } = await res.json();
      const kx = Math.cos((lat * Math.PI) / 180) * 111.32;
      const out = [];
      for (const el of elements) {
        const t = el.tags || {};
        const kind = osmKind(t); if (!kind) continue;
        const name = t["name:en"] || t.int_name || t.name;
        const inside = el.type === "area";
        const x = el.lon ?? el.center?.lon, y = el.lat ?? el.center?.lat;
        if (!inside && (x == null || y == null)) continue;
        const d = inside ? 0 : Math.hypot((x - lon) * kx, (y - lat) * 110.57);
        out.push({ name, kind, lon: inside ? lon : x, lat: inside ? lat : y, km: d, inside, source: "osm",
          notable: !!(t.wikidata || t.wikipedia) });
      }
      return out;
    } catch (e) {
      if (e.name === "AbortError") throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}
