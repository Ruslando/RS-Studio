# Chord showcase

24 Griffbilder und vier unspielbare Testakkorde in E-Standard (E A D G H E),
60 BPM, 4/4, ohne Audiodatei.
Jeder Akkord steht vier Sekunden: 3,5 Sekunden halten, dann 0,5 Sekunden Pause.
Bei den 24 Griffbildern sind Saiten und Bünde als lokale Positionen vorgegeben.
Der Fingersatz wird von RS Studio berechnet; je nach Griff sind mehrere Fingersätze möglich.

## Öffnen und ansehen

Das Beispiel ist wie das Reference- und Effect-Showcase direkt in der lokalen
Projektbibliothek als **RS Studio - Chord showcase** verfügbar. Die `.chart`-Datei
ist die portable Kopie.

1. `RS Studio - Chord showcase.chart` im Projektordner mit RS Studio öffnen.
2. Die Fretboard-Ansicht einblenden.
3. In der Artefakt-Sidebar unter **Sections** zum gewünschten Akkord springen.
4. Für ruhige Griffbilder unter **Settings → Editor** die Fretboard-Animation ausschalten.
   Zum Beobachten der Übergänge wieder einschalten und die Wiedergabe starten.

Die Griffschreibweise liest sich von der tiefen E-Saite zur hohen E-Saite.
`x` bedeutet: Diese Saite wird nicht gespielt; sie ist keine angeschlagene Dead Note.
`0` bedeutet: offene Saite. Internationales `B` entspricht deutschem `H`, `Bb` deutschem `B`.

| Nr. | Start | Akkord / Fall | Griff (tief → hoch) | Worauf achten? |
| --- | --- | --- | --- | --- |
| 01 | 0:00 | Em | `022000` | Offener Mollakkord |
| 02 | 0:04 | E | `022100` | Offener Durakkord |
| 03 | 0:08 | Am | `x02210` | Offener Mollakkord |
| 04 | 0:12 | C | `x32010` | Offener Durakkord |
| 05 | 0:16 | D | `xx0232` | Offener Durakkord auf vier Saiten |
| 06 | 0:20 | G | `320003` | Offener Durakkord über sechs Saiten |
| 07 | 0:24 | A | `x02220` | Drei benachbarte Saiten am zweiten Bund |
| 08 | 0:28 | Dm7 | `xx0211` | Kleiner Barre auf H- und hoher E-Saite |
| 09 | 0:32 | F (klein) | `xx3211` | Kleiner Barre auf den beiden hohen Saiten |
| 10 | 0:36 | F | `133211` | Vollständiger Barre am ersten Bund; höhere Finger überdecken die Mitte |
| 11 | 0:40 | F#m | `244222` | Vollständiger Barre am zweiten Bund |
| 12 | 0:44 | Bm | `x24432` | A-Moll-Form als Barre am zweiten Bund |
| 13 | 0:48 | Bb | `x13331` | A-Dur-Form mit kleinem Barre am dritten Bund |
| 14 | 0:52 | B | `x24442` | Barre am zweiten Bund und drei Saiten am vierten Bund |
| 15 | 0:56 | Cmaj7 | `x32000` | Erweiterter Akkord mit offenen Saiten |
| 16 | 1:00 | Cadd9 | `x32033` | Kleiner Barre am dritten Bund auf den hohen Saiten |
| 17 | 1:04 | Gmaj7 | `3x443x` | Ausgelassene A-Saite trennt die beiden Noten am dritten Bund |
| 18 | 1:08 | D9 | `x5455x` | Tieferer D-Saiten-Ton unterbricht den Barre am fünften Bund |
| 19 | 1:12 | E7#9 | `x7678x` | Mehrere benachbarte Bünde und vier verschiedene Finger |
| 20 | 1:16 | B7 | `x21202` | Offene H-Saite und tieferer Bund unterbrechen gleiche Bünde |
| 21 | 1:20 | Barre-Test 1: A-Saite fehlt | `5x55xx` | Kein durchgehender Barre: Low E separat, D/G als Teilbarre; Am7 ohne Quinte |
| 22 | 1:24 | Barre-Test 2: A-Saite höher | `5755xx` | Durchgehender Barre am fünften Bund möglich: A-Saite am siebten Bund überdeckt ihn; Am7 |
| 23 | 1:28 | Barre-Test 3: A-Saite tiefer | `5355xx` | Kein durchgehender Barre: A-Saite am dritten Bund verhindert ihn; Am7 ohne Quinte |
| 24 | 1:32 | Am7 | `575555` | Vollständiger Barre am fünften Bund mit höher gegriffener A-Saite |

Die Fälle 21–23 isolieren dieselbe Ausgangsform: E-, D- und G-Saite am fünften Bund.
Nur eine höher gegriffene A-Saite darf die fehlende Saite für einen durchgehenden
Barre überdecken. Bei fehlender oder tiefer gegriffener A-Saite bleibt D/G als
kleiner Barre möglich, während die tiefe E-Saite separat gegriffen wird.

## Bundle aus dem Quellprojekt erzeugen

Die `.chart`-Datei ist ein ZIP-Archiv mit dieser `project.json` im Archivwurzelverzeichnis.
Mit Python aus dem Repository-Stamm:

```python
from zipfile import ZipFile, ZIP_DEFLATED
with ZipFile("RS Studio - Chord showcase.chart", "w", ZIP_DEFLATED) as bundle:
    bundle.write("examples/chord-showcase/project.json", "project.json")
```

## Unspielbare Akkorde

Ab 1:36 folgen vier Warnfälle: sieben gleichzeitige Noten (mehr als Saiten),
zwei tiefe Noten, die beide die tiefe E-Saite benötigen, ein Ton über dem
Griffbrett und ein fixierter Griff mit zu großer Spreizung. Alle Noten des
betroffenen Akkords erhalten einen gemeinsamen Warnrahmen; auf dem Fretboard
erscheint ebenfalls ein Warnzeichen. Die Prüfung berücksichtigt Stimmung,
Kapodaster, Bundzahl und fixierte Positionen.
