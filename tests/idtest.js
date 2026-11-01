process.env.TZ='America/New_York'; require('../src/engine.js'); const E=globalThis.CPRSEngine;
const cases={
 'labelled single line':'Patient Name: SMITH, JOHN Q    DOB: 03/12/1948    Sex: M\nLABS\nSODIUM  140  mmol/L  136 - 145',
 'labels inline single-spaced':'Name: Jane A. Doe DOB: 1971-05-30 Gender: Female MRN: 0012345\n',
 'label above value':'Patient:\nO\'Brien-Lee, Kathleen\nDate of Birth: Jan 5, 1980\n',
 'D.O.B. variant':'PATIENT: WASHINGTON, GEORGE\nD.O.B.: 02/22/1932\n',
 'Mr prefix, first-last':'RE: Mr. Robert T Nakamura   Birth Date: 7/4/1966\n',
 'veteran banner':'VETERAN NAME: ALVAREZ,RUBEN   SSN: XXX-XX-1111   DOB: 9/9/1949\n',
 'allergy name not a patient':'Allergy Name: PENICILLIN\nProvider Name: Dr. Lee Smith\nPatient Name: Chen, Wei\nDOB 12/01/1990\n',
 'cover sheet RE noise':'RE:    Records requested 10/20/2026 per VA Form\nPatient: Ortiz, Ana  DOB: 04/14/1977\n',
};
(async()=>{for(const [k,t] of Object.entries(cases)){ E.clear(); const r=(await E.importFile(k+'.txt', new TextEncoder().encode(t).buffer))[0];
 const p=E.state.patients.find(p=>p.key===r.patientKey).resource; console.log(k.padEnd(30), '→', p.name[0].family+','+(p.name[0].given||[]).join(' '), p.birthDate||'-', p.gender||'-', (p.identifier||[]).map(i=>i.value).join(''), '|', r.identity||r.warnings.join(';'));}})();
