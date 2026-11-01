process.env.TZ='America/New_York';
globalThis.pdfjsLib=require('pdfjs-dist/legacy/build/pdf.js'); require('../src/engine.js'); const E=globalThis.CPRSEngine; E.deps.pdfjs=pdfjsLib; const fs=require('fs');
const f='VA_ROI_Printout_HESSEL_2026.pdf'; const b=fs.readFileSync('../samples/'+f); const buf=()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.length);
(async()=>{
 // 1) failure on pages containing "PAGE 2" -> fallback to rules for that page; small batches to force several calls
 let prep=await E.prepareClaudeImport(f,buf(),{mode:'deid'});
 let r=(await E.runClaudeImport(prep, async p=>{ if(/=== PAGE 2 ===/.test(p)) throw {code:'invalid_json',message:'bad'}; return {items:[],unmapped:[]}; }, {maxChars:3000}))[0];
 console.log('fallback:', JSON.stringify(r.claude.fallbackPages), r.warnings[0], '| labs from rules:', E.state.resources.filter(x=>E.meta(x).kind==='lab').length, '| method:', E.sources(E.state.resources.find(x=>E.meta(x).kind==='lab')).map(s=>s.method).join());
 E.clear();
 // 2) direct mode: literal dates and patient from Claude
 prep=await E.prepareClaudeImport(f,buf(),{mode:'direct'});
 const sent=[]; r=(await E.runClaudeImport(prep, async p=>{ sent.push(p); return {patient:{family:'HESSEL',given:'LENARD F',dob:'1993-04-04',sex:'male'},items:[{type:'lab',page:2,line:6,name:'POTASSIUM',value:'5.4',unit:'mmol/L',refRange:'3.5 - 5.1',flag:'H',specimen:'SERUM',date:'09/14/2026',time:'08:12'},{type:'vital',page:3,line:4,vital:'BP',value:'142/88',unit:'mmHg',date:'09/14/2026',time:'08:40'},{type:'vital',page:3,line:9,vital:'WEIGHT',value:'214.6',unit:'lb',date:'09/14/2026',time:'08:40'}],unmapped:[]}; }, {}))[0];
 console.log('direct: prompt has real name/date:', sent[0].includes('HESSEL'), sent[0].includes('09/14/2026'), '| mentions placeholders:', sent[0].includes('[D-n]'));
 for (const x of E.state.resources.filter(x=>['lab','vital'].includes(E.meta(x).kind))) { const d=E.describe(x); console.log('  ',d.kind,d.date,d.name,d.value,d.unit,E.sources(x)[0].method); }
})();
