"""Stamp a fresh version on the site's own CSS/JS links (cache-busting).

GitHub Pages lets browsers keep files ~10 minutes; without this, a phone can mix a new
index.html with an old app.js. Every local link and module import gets ?v=<version>, so
each release is fetched as a whole. Run before each commit:  python3 scripts/bump_version.py
"""
import re, time, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
v = time.strftime("%Y%m%d%H%M%S")

def stamp(path, pattern):
    p = root / path
    s = p.read_text(encoding="utf-8")
    s2 = re.sub(pattern, lambda m: f"{m.group(1)}?v={v}{m.group(3)}", s)
    if s2 != s:
        p.write_text(s2, encoding="utf-8")

# index.html: style.css, js/app.js
stamp("index.html", r'((?:href|src)="(?:style\.css|js/app\.js))(\?v=\d+)?(")')
# module imports between our own files: "./name.js" or "./name.js?v=…"
for f in (root / "js").glob("*.js"):
    stamp(f"js/{f.name}", r'((?:from |import\()"\./[\w-]+\.js)(\?v=\d+)?(")')
print("version", v)
