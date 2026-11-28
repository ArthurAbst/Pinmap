"""Build data/marine.json for the statistics: Natural Earth 10m marine areas (oceans, seas, gulfs,
bays, straits…), each with the ocean and the sea it belongs to, simplified to ~400 m.
Usage: python3 scripts/build_marine.py raw/ne_10m_geography_marine_polys.geojson data/marine.json  (needs shapely)

Ocean of an area: the ocean reached through the fewest neighbouring areas (largest shared shore wins),
plus the fixes below. Sea of a gulf/bay/fjord…: its largest neighbour if that is a sea."""
import json, sys
from shapely.geometry import shape
from shapely.strtree import STRtree
from collections import deque
SRC, DST = sys.argv[1], sys.argv[2]
g = json.load(open(SRC))
OCEAN = {'North Atlantic Ocean':'Atlantic Ocean','South Atlantic Ocean':'Atlantic Ocean','North Pacific Ocean':'Pacific Ocean',
         'South Pacific Ocean':'Pacific Ocean','INDIAN OCEAN':'Indian Ocean','SOUTHERN OCEAN':'Southern Ocean','Arctic Ocean':'Arctic Ocean'}
F = []
for f in g['features']:
    p = f['properties']
    F.append({'name': p['name'], 'c': p['featurecla'], 'geom': shape(f['geometry']).buffer(0)})
geoms = [f['geom'] for f in F]
tree = STRtree(geoms)
contact = [dict() for _ in F]
for i, f in enumerate(F):
    b = f['geom'].buffer(0.03)
    for j in tree.query(b):
        j = int(j)
        if j == i: continue
        a = b.intersection(geoms[j]).area
        if a > 1e-6: contact[i][j] = a
# ocean via BFS
ocean = [OCEAN.get(f['name']) if f['c']=='ocean' else None for f in F]
level = [0 if o else None for o in ocean]
q = deque(i for i in range(len(F)) if ocean[i])
while q:
    i = q.popleft()
    for j in contact[i]:
        if level[j] is None:
            level[j] = level[i] + 1; q.append(j)
order = sorted([i for i in range(len(F)) if level[i] not in (None, 0)], key=lambda i: level[i])
for i in order:
    cands = [(a, j) for j, a in contact[i].items() if ocean[j] and level[j] < level[i]]
    ocean[i] = ocean[max(cands)[1]]
# sea parent for non-sea, non-ocean: largest-contact neighbor among sea/ocean/other
sea = [None]*len(F)
for _ in range(4):
    for i, f in enumerate(F):
        if f['c'] in ('sea', 'ocean') or not f['name']: continue
        if not contact[i]: continue
        j = max(contact[i], key=contact[i].get)
        n = F[j]
        sea[i] = n['name'] if n['c'] == 'sea' else (None if n['c']=='ocean' else sea[j])

# ---- write the file ----
MED = ['Alboran Sea','Balearic Sea','Ligurian Sea','Tyrrhenian Sea','Ionian Sea','Adriatic Sea','Aegean Sea','Sea of Crete']
# enclosed seas: being there doesn't mean you've seen an ocean
ENCLOSED = set(MED + ['Mediterranean Sea','Golfe du Lion','Gulf of Gabès','Gulf of Sidra','Dardanelles','Sea of Marmara','Bosporus',
  'Black Sea','Sea of Azov','Baltic Sea','Gulf of Bothnia','Gulf of Finland','Gulf of Riga','Kaliningrad','Stettiner Haff',
  'Mecklenburger Bucht','Øresund','Caspian Sea','Garabogaz Bay','Red Sea','Gulf of Aqaba','Gulf of Suez','Persian Gulf'])
OCEAN_FIX = {'Tasman Sea':'Pacific Ocean','Arafura Sea':'Pacific Ocean','Gulf of Carpentaria':'Pacific Ocean','Banda Sea':'Pacific Ocean',
  'Flores Sea':'Pacific Ocean','Java Sea':'Pacific Ocean','Bali Sea':'Pacific Ocean','Ceram Sea':'Pacific Ocean','Makassar Strait':'Pacific Ocean',
  'Luzon Strait':'Pacific Ocean','Smith Sound':'Arctic Ocean','Hudson Bay':'Arctic Ocean','James Bay':'Arctic Ocean','Foxe Basin':'Arctic Ocean',
  'Wager Bay':'Arctic Ocean'}
SEA_NONE = {'Baffin Bay','Kane Basin','Melville Bay','Uummannaq Fjord','Murchison Sound','Jones Sound','Disko Bay','Persian Gulf','Gulf of Aden'}
out = []
for i, f in enumerate(g['features']):
    p = f['properties']; n = p['name'] or ''; c = p['featurecla']
    if c == 'river': continue
    ocean_i = OCEAN_FIX.get(n, ocean[i]) or ''
    if n in ENCLOSED: ocean_i = ''
    sea_i = sea[i] or ''
    if c in ('strait', 'generic') or n in SEA_NONE: sea_i = ''
    if n in MED: sea_i = 'Mediterranean Sea'
    if c == 'sea' and n not in MED: sea_i = ''
    geom = shape(f['geometry']).buffer(0).simplify(0.004, preserve_topology=True)
    polys = [geom] if geom.geom_type == 'Polygon' else list(geom.geoms)
    rings = []
    for pg in polys:
        for r in [pg.exterior, *pg.interiors]:
            cs = [[round(x, 3), round(y, 3)] for x, y in r.coords]
            if len(cs) >= 4: rings.append(cs)
    out.append({'n': n, 'c': c, 's': sea_i, 'o': ocean_i, 'r': rings})
json.dump(out, open(DST, 'w'), separators=(',', ':'), ensure_ascii=False)
