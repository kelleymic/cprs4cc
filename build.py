"""Build the single-file viewer: inlines src/engine.js (with the LOINC catalog) into src/ui.html -> index.html."""
from pathlib import Path
root = Path(__file__).parent
ui = (root / 'src/ui.html').read_text()
cat = (root / 'src/catalog.txt').read_text().replace('`', '').replace('\\', '\\\\')
eng = (root / 'src/engine.js').read_text().replace('/*CATALOG*/', cat)
assert '/*ENGINE*/' in ui
# charset + viewport for when index.html is served on its own (GitHub Pages, local file); harmless inside claude.ai
head = '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
(root / 'index.html').write_text(head + ui.replace('/*ENGINE*/', eng), encoding='utf-8')
print('wrote index.html', len(ui) + len(eng), 'bytes')
