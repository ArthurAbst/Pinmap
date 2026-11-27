#!/usr/bin/env bash
# Rebuild all map data. Needs: node, python3, curl.
set -e
cd "$(dirname "$0")/.."
mkdir -p raw tools data
B=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson
for f in ne_50m_admin_0_countries ne_50m_lakes ne_50m_rivers_lake_centerlines ne_50m_admin_1_states_provinces_lines \
         ne_50m_geography_marine_polys ne_10m_admin_0_countries ne_10m_lakes ne_10m_rivers_lake_centerlines \
         ne_10m_populated_places_simple ne_10m_geography_regions_points ne_10m_geography_regions_elevation_points \
         ne_10m_geography_regions_polys; do
  [ -f raw/$f.geojson ] || curl -sfL -o raw/$f.geojson $B/$f.geojson
done
cp scripts/landmarks.json raw/landmarks.json
(cd tools && [ -f package.json ] || npm init -y >/dev/null; npm i mapshaper all-the-cities >/dev/null)
MS=tools/node_modules/.bin/mapshaper
cd raw
../$MS -i ne_50m_admin_0_countries.geojson -filter-fields NAME_EN,ISO_A2_EH,ADM0_A3 -rename-fields name=NAME_EN,iso=ISO_A2_EH,a3=ADM0_A3 -rename-layers countries \
  -i ne_50m_lakes.geojson -filter 'scalerank<=4' -filter-fields name -rename-layers lakes \
  -i ne_50m_rivers_lake_centerlines.geojson -filter-fields name,scalerank -rename-fields r=scalerank -rename-layers rivers \
  -i ne_50m_admin_1_states_provinces_lines.geojson -filter-fields -rename-layers admin1 \
  -target '*' -o format=topojson quantization=100000 ../data/world50.json
../$MS -i ne_10m_admin_0_countries.geojson -simplify 40% keep-shapes -filter-fields ADM0_A3 -rename-fields a3=ADM0_A3 -rename-layers countries \
  -i ne_10m_lakes.geojson -simplify 40% -filter-fields name -rename-layers lakes \
  -i ne_10m_rivers_lake_centerlines.geojson -simplify 40% -filter-fields name,scalerank -rename-fields r=scalerank -rename-layers rivers \
  -target '*' -o format=topojson quantization=200000 ../data/world10.json
../$MS -i ne_10m_geography_regions_polys.geojson -points inner -filter-fields NAME,FEATURECLA,MIN_LABEL,SCALERANK -o format=geojson regions_pts.geojson
../$MS -i ne_50m_geography_marine_polys.geojson -points inner -filter-fields name,featurecla,min_label,scalerank -o format=geojson marine_pts.geojson
../$MS -i ne_50m_lakes.geojson -filter 'Boolean(name)' -dissolve fields=name -each 'a=Math.round(this.area/1e6)' -points inner -o format=geojson lakes_pts.geojson
cd ..
python3 scripts/build_labels.py raw data tools
