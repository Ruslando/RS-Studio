"""Fetch the UI and mono families from Google Fonts for offline rendering.

Keeps the latin and latin-ext subsets only: the UI is English and those two
cover every accented character a European title needs. A Cyrillic or Greek
song title still renders — the browser falls back per glyph, which is what a
missing subset is supposed to do.
"""
import io, os, re, urllib.request
from pathlib import Path

CSS = ("https://fonts.googleapis.com/css2?"
       "family=Atkinson+Hyperlegible+Next:wght@400..700&family=IBM+Plex+Mono:wght@400;600&display=swap")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
KEEP = ("latin", "latin-ext")
OUT = "web/fonts"


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


css = get(CSS).decode("utf-8")
os.makedirs(OUT, exist_ok=True)

# Each face is preceded by a /* subset */ comment.
blocks = re.findall(r"/\*\s*([\w-]+)\s*\*/\s*(@font-face\s*\{[^}]*\})", css)
faces, seen = [], set()
for subset, block in blocks:
    if subset not in KEEP:
        continue
    fam = re.search(r"font-family:\s*'([^']+)'", block).group(1)
    weight = re.search(r"font-weight:\s*([\d ]+);", block).group(1).strip()
    url = re.search(r"url\((https://[^)]+\.woff2)\)", block).group(1)
    rng = re.search(r"unicode-range:\s*([^;]+);", block).group(1).strip()
    name = "%s-%s-%s.woff2" % (fam.lower().replace(" ", "-"), weight.replace(" ", "-"), subset)
    if name in seen:
        continue
    seen.add(name)
    data = get(url)
    io.open(os.path.join(OUT, name), "wb").write(data)
    faces.append((fam, weight, name, rng, len(data)))
    print("  %-40s %6.1f KB" % (name, len(data) / 1024))

faces.sort(key=lambda f: (f[0], int(f[1].split()[0]), f[2]))
out = ["/* Self-hosted latin and latin-ext fonts. SIL OFL 1.1 notices in fonts/.\n   Regenerate with tools/fetch-fonts.py. No runtime network requests. */"]
for fam, weight, name, rng, _ in faces:
    out.append("""@font-face {
  font-family: '%s';
  font-style: normal;
  font-weight: %s;
  font-display: swap;
  src: url('fonts/%s') format('woff2');
  unicode-range: %s;
}""" % (fam, weight, name, rng))
for folder, notice in [('atkinsonhyperlegiblenext','AtkinsonHyperlegibleNext'), ('ibmplexmono','IBMPlexMono')]:
    Path(OUT, notice + '-LICENSE.txt').write_bytes(get('https://raw.githubusercontent.com/google/fonts/main/ofl/' + folder + '/OFL.txt'))
io.open("web/fonts.css", "w", encoding="utf-8", newline="").write("\n".join(out) + "\n")

total = sum(f[4] for f in faces)
print("\n%d faces, %.1f KB total -> web/fonts.css" % (len(faces), total / 1024))
