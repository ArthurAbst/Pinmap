"""Build data/labels.json (things drawn on the map) and data/gazetteer.json (search index).

Inputs (in RAW dir): Natural Earth GeoJSON layers, label points made with mapshaper,
landmarks.json (hand-curated natural sights), and all-the-cities (GeoNames, CC-BY) via node.
"""
import json, os, subprocess, sys

RAW = sys.argv[1] if len(sys.argv) > 1 else "raw"
OUT = sys.argv[2] if len(sys.argv) > 2 else "data"
TOOLS = sys.argv[3] if len(sys.argv) > 3 else "tools"


def load(name):
    with open(os.path.join(RAW, name), encoding="utf-8") as f:
        return json.load(f)["features"] if name.endswith(".geojson") else json.load(f)


def r(x, n=3):
    return round(float(x), n)


# ---------- countries ----------
countries = []
iso_names = {}
for f in load("ne_50m_admin_0_countries.geojson"):
    p = f["properties"]
    iso = p["ISO_A2_EH"] if p["ISO_A2_EH"] != "-99" else ""
    if iso:
        iso_names.setdefault(iso, p["NAME_EN"])
    countries.append([p["NAME_EN"], p["ADM0_A3"], iso, r(p["LABEL_X"]), r(p["LABEL_Y"]), r(p["MIN_LABEL"], 1)])

# ---------- cities drawn on the map (Natural Earth) ----------
cities = []
for f in load("ne_10m_populated_places_simple.geojson"):
    p = f["properties"]
    cap = 1 if p["adm0cap"] else 0
    cities.append([p["name"], p["iso_a2"] if p["iso_a2"] != "-99" else "", int(p["pop_max"] or 0),
                   r(p["longitude"]), r(p["latitude"]), r(p["min_zoom"], 1), cap])
cities.sort(key=lambda c: (-c[6], c[5], -c[2]))

# ---------- physical features ----------
KIND = {"Range/mtn": "range", "Desert": "desert", "Plateau": "plateau", "Plain": "plain", "Basin": "basin",
        "Peninsula": "peninsula", "Pen/cape": "peninsula", "Delta": "delta", "Valley": "valley",
        "Tundra": "tundra", "Wetlands": "wetland", "Gorge": "canyon", "Lowland": "plain", "Depression": "depression",
        "Island group": "islands", "Island": "island", "Isthmus": "isthmus"}
physical = []  # [name, kind, lon, lat, minzoom]
for f in load("regions_pts.geojson"):
    p, g = f["properties"], f["geometry"]
    k = KIND.get(p["FEATURECLA"])
    if not g or not k or not p["NAME"]:
        continue
    physical.append([p["NAME"], k, r(g["coordinates"][0]), r(g["coordinates"][1]), r(p["MIN_LABEL"] or 5, 1)])

for f in load("ne_10m_geography_regions_elevation_points.geojson"):
    p, g = f["properties"], f["geometry"]
    if p["featurecla"] not in ("mountain", "depression") or not p["name"]:
        continue
    elev = p.get("elevation") or 0
    physical.append([p["name"], "peak" if p["featurecla"] == "mountain" else "depression",
                     r(g["coordinates"][0]), r(g["coordinates"][1]), r(p["min_zoom"] or 6, 1), int(elev)])

for f in load("ne_10m_geography_regions_points.geojson"):
    p, g = f["properties"], f["geometry"]
    if p["featurecla"] in ("waterfall", "pole", "cape"):
        physical.append([p["name"], p["featurecla"], r(g["coordinates"][0]), r(g["coordinates"][1]),
                         r(p["min_zoom"] or 5, 1)])

water = []  # [name, kind, lon, lat, minzoom]
for f in load("marine_pts.geojson"):
    p, g = f["properties"], f["geometry"]
    if not g or not p["name"]:
        continue
    water.append([p["name"], p["featurecla"].lower(), r(g["coordinates"][0]), r(g["coordinates"][1]),
                  r(p["min_label"] or 3, 1)])
for f in load("lakes_pts.geojson"):
    p, g = f["properties"], f["geometry"]
    if not g:
        continue
    a = p["a"]
    mz = 2 if a > 20000 else 3 if a > 5000 else 4 if a > 1500 else 5.5
    water.append([p["name"], "lake", r(g["coordinates"][0]), r(g["coordinates"][1]), mz])

landmarks = [[n, k, lon, lat] for n, k, lon, lat in load("landmarks.json")]

labels = {"countries": countries, "cities": cities, "physical": physical, "water": water,
          "landmarks": landmarks, "isoNames": iso_names}
with open(os.path.join(OUT, "labels.json"), "w", encoding="utf-8") as f:
    json.dump(labels, f, ensure_ascii=False, separators=(",", ":"))

# ---------- gazetteer for search: GeoNames cities (pop >= 1000) ----------
js = ("const c=require('all-the-cities');process.stdout.write(JSON.stringify("
      "c.filter(x=>x.population>=1000).map(x=>[x.name,x.country,x.population,"
      "+x.loc.coordinates[0].toFixed(3),+x.loc.coordinates[1].toFixed(3)])))")
gn = json.loads(subprocess.check_output(["node", "-e", js], cwd=TOOLS))
gn.sort(key=lambda c: -c[2])
with open(os.path.join(OUT, "gazetteer.json"), "w", encoding="utf-8") as f:
    json.dump(gn, f, ensure_ascii=False, separators=(",", ":"))

print("countries", len(countries), "cities", len(cities), "physical", len(physical), "water", len(water),
      "landmarks", len(landmarks), "gazetteer", len(gn))
