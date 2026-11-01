process.env.TZ='America/New_York';
globalThis.pdfjsLib=require('pdfjs-dist/legacy/build/pdf.js'); require('../src/engine.js'); const E=globalThis.CPRSEngine; E.deps.pdfjs=pdfjsLib;
const fs=require('fs');
(async()=>{ for (const f of process.argv.slice(2)) { const b=fs.readFileSync('../samples/'+f); const buf=b.buffer.slice(b.byteOffset,b.byteOffset+b.length);
  const prep=await E.prepareClaudeImport(f, buf, {mode:'deid'});
  const txt=prep.deid.pages.map(p=>'=== PAGE '+p.page+'\n'+p.lines.join('\n')).join('\n');
  console.log('##### '+f+'  identity:', prep.ident && prep.ident.name ? prep.ident.name.family+','+prep.ident.name.given.join(' ')+' '+prep.ident.dob : 'none', ' counts:', JSON.stringify(prep.deid.counts));
  if (process.env.SHOW) console.log(txt);
  // leak checks: any date pattern, patient name, SSN/phone left?
  const leaks=[]; const name=prep.ident&&prep.ident.name; 
  const pats=[[/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,'date m/d/y'],[/\b\d{4}-\d{2}-\d{2}\b/g,'iso date'],[/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\.?\s+\d{1,2},?\s*\d{4}/gi,'month date'],[/\b\d{3}[ .-]\d{3}[ .-]\d{4}\b|\(\d{3}\)\s?\d{3}-\d{4}/g,'phone'],[/\b\d{3}-\d{2}-\d{4}\b/g,'ssn']];
  if (name) pats.push([new RegExp('\\b('+[name.family,...name.given].filter(x=>x.length>1).join('|')+')\\b','gi'),'patient name']);
  for (const [re,l] of pats) { const m=txt.match(re); if (m) leaks.push(l+': '+[...new Set(m)].slice(0,5).join(' | ')); }
  console.log(leaks.length? 'LEAKS → '+leaks.join(' ;; ') : 'no leaks detected');
  console.log('date tokens:', [...prep.deid.map.entries()].filter(([t,e])=>e.kind==='D').slice(0,6).map(([t,e])=>t+'='+e.orig+'→'+e.iso).join('  '));
  console.log('people:', [...prep.deid.map.entries()].filter(([t,e])=>e.kind==='PER').map(([t,e])=>t+'='+e.orig).join(' | '));
}})();
