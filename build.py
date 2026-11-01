"""Build the single-file viewer: inlines src/engine.js (with the LOINC catalog) into src/ui.html -> index.html."""
from pathlib import Path
root = Path(__file__).parent
ui = (root / 'src/ui.html').read_text()
cat = (root / 'src/catalog.txt').read_text().replace('`', '').replace('\\', '\\\\')
eng = (root / 'src/engine.js').read_text().replace('/*CATALOG*/', cat)
assert '/*ENGINE*/' in ui
(root / 'index.html').write_text(ui.replace('/*ENGINE*/', eng))
print('wrote index.html', len(ui) + len(eng), 'bytes')
