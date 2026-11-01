process.env.TZ='America/New_York';
globalThis.pdfjsLib=require('pdfjs-dist/legacy/build/pdf.js'); require('../src/engine.js'); const E=globalThis.CPRSEngine; E.deps.pdfjs=pdfjsLib;
const fs=require('fs');
const L=(page,line,name,value,unit,ref,flag,extra)=>Object.assign({type:'lab',page,line,name,value,unit,refRange:ref,flag,specimen:'SERUM',performer:'RIVERSIDE REFERENCE LAB',date:'[D-2]',time:'07:40',comment:'',panel:''},extra||{});
const MOCK={patient:{},items:[
 L(1,10,'SODIUM','141','mmol/L','136 - 145',''), L(1,11,'POTASSIUM','3.3','mmol/L','3.5 - 5.1','L'), L(1,12,'CHLORIDE','101','mmol/L','98 - 107',''), L(1,13,'CO2','27','mmol/L','22 - 29',''),
 L(2,3,'UREA NITROGEN','18','mg/dL','7 - 20',''), L(2,4,'CREATININE','0.92','mg/dL','0.57 - 1.00',''), L(2,5,'GLUCOSE','212','mg/dL','70 - 99','H',{comment:'Patient reports eating breakfast before the draw.'}), L(2,7,'HEMOGLOBIN A1C','8.4','%','4.0 - 5.6','H'),
 L(2,4,'MAGNESIUM','999','mg/dL','1.7 - 2.2','H'),   // invented: must be rejected
 {type:'document',docType:'progress',title:'DIABETES FOLLOW-UP',author:'[PER-1]',date:'[D-4]',time:'10:05',startPage:2,startLine:10,endPage:3,endLine:7},
 {type:'allergy',page:3,line:10,endPage:3,endLine:12,substance:'SULFONAMIDE ANTIBIOTICS',reaction:'HIVES',severity:'',date:''},
 {type:'allergy',page:3,line:14,endPage:4,endLine:3,substance:'LATEX',reaction:'CONTACT DERMATITIS',severity:'',date:'[D-6]'},
 {type:'problem',page:2,line:15,text:'Peripheral neuropathy',status:'active',date:''}, // not on that line: must be rejected
],unmapped:[{startPage:1,startLine:1,endPage:1,endLine:4,kind:'content',reason:'chart header with patient identification'},{startPage:1,startLine:6,endPage:1,endLine:6,kind:'layout',reason:'section heading'},{startPage:4,startLine:5,endPage:4,endLine:5,reason:'fax routing line'}]};
(async()=>{ const f='Riverside_Multipage_GARCIA_2026.pdf'; const b=fs.readFileSync('../samples/'+f); const buf=b.buffer.slice(b.byteOffset,b.byteOffset+b.length);
 const prep=await E.prepareClaudeImport(f,buf,{mode:'deid'}); let prompts=[];
 const reps=await E.runClaudeImport(prep, async p=>{ prompts.push(p); return JSON.parse(JSON.stringify(MOCK)); }, {});
 const r=reps[0]; console.log('calls',prompts.length,'prompt chars',prompts[0].length,'| counts',JSON.stringify(r.counts),'| claude',JSON.stringify(r.claude)); console.log('identity',r.identity); console.log('warnings',r.warnings);
 // ensure the prompt held no identifiers
 for (const bad of ['GARCIA','MARIA','11/02/1958','08/11/2026','OYELARAN','Mensah','55-201-77']) if (prompts[0].includes(bad)) console.log('PROMPT LEAK:',bad);
 for (const x of E.state.resources){ const d=E.describe(x); const s=E.sources(x)[0]; console.log('['+d.kind+']', d.date||'-', '|', d.name.slice(0,40), '|', d.value||'', d.unit||'', d.range||'', d.flag||'', '|', (d.author||d.reaction||d.comments||''), '|', s.pages, s.locator, s.method); if(d.kind==='note') console.log('   BODY:', E.docText(x).split('\n').slice(0,4).join(' / '), '...', E.docText(x).split('\n').slice(-2).join(' / ')); }
 console.log(E.state.patients.map(p=>p.key));
})();
