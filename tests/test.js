const fs=require('fs'),path=require('path');
process.env.TZ='America/New_York';
globalThis.DOMParser=require('@xmldom/xmldom').DOMParser;
globalThis.pdfjsLib=require('pdfjs-dist/legacy/build/pdf.js');
globalThis.JSZip=require('jszip');
require('../src/engine.js');
const E=globalThis.CPRSEngine; E.deps.DOMParser=globalThis.DOMParser; E.deps.pdfjs=globalThis.pdfjsLib; E.deps.JSZip=globalThis.JSZip;
(async()=>{
 const dir='../samples'; const files=process.argv.slice(2).length?process.argv.slice(2):fs.readdirSync(dir);
 for(const f of files){ const b=fs.readFileSync(path.join(dir,f)); const ab=b.buffer.slice(b.byteOffset,b.byteOffset+b.length);
   const t0=Date.now(); const reps=await E.importFile(f,ab); for(const r of reps) console.log(f.padEnd(40), (Date.now()-t0)+'ms', r.format, JSON.stringify(r.counts),'merged',r.merged, r.identity?'\n     ID: '+r.identity:'', r.warnings.length?('WARN '+r.warnings.slice(0,3).join(' || ')):''); }
 console.log('patients', E.state.patients.map(p=>p.key));
 globalThis.E=E;
 if(process.env.DUMP){ for(const r of E.state.resources.filter(r=>E.meta(r).fileIds.size && [...E.meta(r).fileIds].some(id=>E.state.files.find(f=>f.id===id&&f.name.includes(process.env.DUMP))))){ const d=E.describe(r); const s=E.sources(r).map(s=>s.file.slice(0,12)+':'+(s.pages||'')+':'+(s.locator||'')).join(' ; ');
   if(['note','consult','dcsumm','radiology','pathology','unstructured'].includes(d.kind)) console.log('['+d.kind+']',d.date,'|',d.name,'|',d.author||'','|',s,'\n   ',E.docText(r).slice(0,process.env.FULL?5000:160).replace(/\n/g,'\n    '));
   else console.log('['+d.kind+']',d.date,'|',d.name,'|',d.value,d.unit,'|',d.range||'',d.flag||'','|',d.specimen||'',d.performer||'',d.comments||d.sig||d.reaction||'','|',s);}}
})().catch(e=>{console.error(e);process.exit(1)});
setTimeout(()=>{ if(!process.env.EXPORT) return; const E=globalThis.E; const k=E.state.patients[0].key; const b=E.exportBundle(k);
 const c={}; b.entry.forEach(e=>c[e.resource.resourceType]=(c[e.resource.resourceType]||0)+1); console.log('bundle entries',b.entry.length,JSON.stringify(c), (JSON.stringify(b).length/1e6).toFixed(2)+'MB');
 const ob=b.entry.find(e=>e.resource.resourceType==='Observation'&&e.resource.referenceRange&&e.resource.interpretation&&e.resource.note); console.log(JSON.stringify(ob.resource,null,1));
 console.log(E.exportCSV(k).split('\n').slice(0,3).join('\n'));
 console.log(JSON.stringify(b.entry.find(e=>e.resource.resourceType==='Provenance').resource).slice(0,500));
},3000);
