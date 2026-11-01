require('../src/engine.js'); const E=globalThis.CPRSEngine;
const t=`LABORATORY RESULTS
Collected on 09/01/2026 08:00
Test   Result   Ref Range
SODIUM   139   (136-145) mmol/L
POTASSIUM   5.6 H   3.5-5.1 mmol/L
GLUCOSE   101   Normal: 70-99   mg/dL
HDL   38   L   >= 40   mg/dL
TSH   2.1   0.45 to 4.50   uIU/mL
LDL   130   H   mg/dL   <100
`;
(async()=>{ await E.importFile('r.txt', new TextEncoder().encode(t).buffer); for (const r of E.state.resources.filter(r=>E.meta(r).kind==='lab')) { const d=E.describe(r); console.log(d.name.padEnd(10), d.value, d.unit.padEnd(7), 'low',d.low,'high',d.high,'flag',d.flag||'-','|',d.range);} })();
