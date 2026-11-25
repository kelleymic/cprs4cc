// Syntax check for code node can't load directly: the inline <script> blocks of the built index.html.
// Usage: node lint.js [path/to/index.html]   (default ../index.html)
const fs = require('fs'), path = require('path'), vm = require('vm');
const file = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(file, 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, n = 0, bad = 0;
while ((m = re.exec(html))) {
  n++;
  const line = html.slice(0, m.index).split('\n').length;
  try { new vm.Script(m[1], { filename: `${path.basename(file)} (script ${n}, starts line ${line})` }); }
  catch (e) { bad++; console.error(`${path.basename(file)}: inline script ${n} (starts line ${line}): ${e.message}`); }
}
if (!n) { console.error('no inline scripts found in ' + file); process.exit(1); }
console.log(`${n} inline script(s) checked, ${bad} with syntax errors`);
process.exit(bad ? 1 : 0);
