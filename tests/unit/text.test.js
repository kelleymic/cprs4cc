'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../helpers');
const { E } = H;
beforeEach(() => H.fresh());

const HDR = 'Patient Name: DOE, JANE   DOB: 01/02/1970\n';
const labs = () => H.ofKind('lab').map(x => ({ name: x.d.name, value: x.d.value, unit: x.d.unit || '', date: x.d.date, range: x.d.range || '', flag: x.d.flag || '', specimen: x.d.specimen || '' }));
const lab = n => labs().find(x => x.name === n);

test('Epic MyChart-style result table: values, units, ranges, flags and the collection time', async () => {
  await H.importText('t.txt', 'Patient: SMITH, JOHN Q    DOB: 03/12/1948\nTest Results\nBasic Metabolic Panel\nCollected on Sep 14, 2026 8:12 AM\nComponent              Your Value     Standard Range      Units     Flag\nSodium                 141            136 - 145           mmol/L\nPotassium              5.4            3.5 - 5.1           mmol/L    High\nCreatinine             <0.10          0.57 - 1.00         mg/dL     Low\n');
  assert.deepEqual(lab('Potassium'), { name: 'Potassium', value: '5.4', unit: 'mmol/L', date: '2026-09-14T08:12:00-04:00', range: '3.5 - 5.1', flag: 'H', specimen: '' });
  assert.equal(lab('Sodium').flag, ''); assert.equal(lab('Creatinine').flag, 'L');
  assert.equal(H.ofKind('panel')[0].d.name, 'Basic Metabolic Panel');
});

test('the printed precision of a result is kept (6.0, 1.020, <0.10)', async () => {
  await H.importText('t.txt', HDR + 'LABORATORY RESULTS\nCollection Date: 09/14/2026 08:12\nSpecific Gravity   1.020   1.005 - 1.030\npH   6.0   5.0 - 8.0\nCreatinine   <0.10   mg/dL\n');
  assert.equal(lab('Specific Gravity').value, '1.020'); assert.equal(lab('pH').value, '6.0'); assert.equal(lab('Creatinine').value, '<0.10');
  const r = H.byName('lab', /^pH$/)[0].r; assert.equal(r.valueQuantity.value, 6);       // the number itself is still numeric for graphs
});

test('qualitative results (Yellow, Clear, Trace, 1+, Not detected) are imported under the right panel and date', async () => {
  const rep = await H.importText('t.txt', HDR + 'LABORATORY RESULTS\nCollection Date: 09/14/2026 08:12\nUrinalysis\nColor            Yellow\nAppearance       Clear\nGlucose          Negative                      mg/dL\nProtein          Trace                         mg/dL\nKetones          1+\nBlood            Not Detected\nSpecific Gravity 1.020          1.005 - 1.030\n');
  const v = Object.fromEntries(labs().map(x => [x.name, x.value]));
  assert.deepEqual(v, { Color: 'Yellow', Appearance: 'Clear', Glucose: 'Negative', Protein: 'Trace', Ketones: '1+', Blood: 'Not Detected', 'Specific Gravity': '1.020' });
  assert.ok(labs().every(x => x.date === '2026-09-14T08:12:00-04:00'));
  assert.equal(H.ofKind('panel')[0].d.name, 'Urinalysis'); assert.equal(rep.warnings.filter(w => /no collection date/.test(w)).length, 0);
  assert.equal(H.ofKind('unstructured').length, 0, 'nothing in this block should fall through to Ext Data: ' + H.ofKind('unstructured').map(x => E.docText(x.r)));
});

test('a table with one column per collection date gives every value its own date', async () => {
  await H.importText('t.txt', HDR + 'Results\nTest            09/14/2026 08:12   06/03/2026 09:00   Units    Ref Range\nSodium          141                139                mmol/L   136 - 145\nPotassium       5.4 H              4.8                mmol/L   3.5 - 5.1\nHemoglobin A1c  8.4 H              7.9 H              %        4.0 - 5.6\n');
  const rows = labs().map(x => `${x.name}|${x.date}|${x.value}|${x.unit}|${x.range}|${x.flag}`).sort();
  assert.deepEqual(rows, [
    'Hemoglobin A1c|2026-06-03T09:00:00-04:00|7.9|%|4.0 - 5.6|H', 'Hemoglobin A1c|2026-09-14T08:12:00-04:00|8.4|%|4.0 - 5.6|H',
    'Potassium|2026-06-03T09:00:00-04:00|4.8|mmol/L|3.5 - 5.1|', 'Potassium|2026-09-14T08:12:00-04:00|5.4|mmol/L|3.5 - 5.1|H',
    'Sodium|2026-06-03T09:00:00-04:00|139|mmol/L|136 - 145|', 'Sodium|2026-09-14T08:12:00-04:00|141|mmol/L|136 - 145|']);
});

test('a column-per-date table with a blank cell keeps values under the right date', async () => {
  await H.importText('t.txt', HDR + 'Results\nTest            09/14/2026   06/03/2026   03/01/2026   Units\nSodium          141                       138          mmol/L\nPotassium       5.4          4.8                       mmol/L\n');
  const rows = labs().map(x => `${x.name}|${x.date.slice(0, 10)}|${x.value}`).sort();
  assert.deepEqual(rows, ['Potassium|2026-06-03|4.8', 'Potassium|2026-09-14|5.4', 'Sodium|2026-03-01|138', 'Sodium|2026-09-14|141']);
});

test('single-space rows with value, unit, flag in parentheses and a bracketed range', async () => {
  await H.importText('t.txt', HDR + 'Laboratory\nCollected: 09/14/2026 08:12\nGlucose, Random  212 mg/dL (H)  [70-99]\nSodium  141 mmol/L  [136-145]\nWBC  11.2 x10E3/uL  H  4.0-10.5\n');
  assert.deepEqual(lab('Glucose, Random'), { name: 'Glucose, Random', value: '212', unit: 'mg/dL', date: '2026-09-14T08:12:00-04:00', range: '70-99', flag: 'H', specimen: '' });
  assert.equal(lab('Sodium').range, '136-145'); const w = lab('WBC'); assert.equal(w.value, '11.2'); assert.equal(w.flag, 'H'); assert.equal(w.range, '4.0-10.5'); assert.match(w.unit, /10E3\/uL/i);
});

test('key/value lab blocks: Test / Result / Units / Ref range, as in VA and Blue Button reports', async () => {
  await H.importText('t.txt', 'Name: HESSEL, LENARD F   DOB: 04/04/1993\n==== LAB RESULTS ====\nCollection date: Sep 14, 2026@08:12\nTest: POTASSIUM\nResult: 5.4 H\nUnits: mmol/L\nRef range: 3.5 - 5.1\nSpecimen: SERUM\n\nTest: SODIUM\nResult: 141\nUnits: mmol/L\nRef range: 136 - 145\n');
  assert.deepEqual(lab('POTASSIUM'), { name: 'POTASSIUM', value: '5.4', unit: 'mmol/L', date: '2026-09-14T08:12:00-04:00', range: '3.5 - 5.1', flag: 'H', specimen: 'SERUM' });
  assert.equal(lab('SODIUM').value, '141');
});

test('rows with single spaces between name, value, unit, flag and range are read; prose is not', async () => {
  await H.importText('t.txt', HDR + 'Laboratory Results\nCollected: 09/14/2026 08:12\nSodium 141 mmol/L 136-145\nPotassium 5.4 mmol/L H 3.5-5.1\nVitamin B12 450 pg/mL (200-900)\nThe patient was seen today and feels well\nWeight 70 kg today\nHemoglobin A1c 8.4 % H 4.0 - 5.6\n');
  assert.deepEqual(lab('Potassium'), { name: 'Potassium', value: '5.4', unit: 'mmol/L', date: '2026-09-14T08:12:00-04:00', range: '3.5-5.1', flag: 'H', specimen: '' });
  assert.equal(lab('Vitamin B12').value, '450'); assert.equal(lab('Vitamin B12').range, '200-900'); assert.equal(lab('Hemoglobin A1c').flag, 'H');
  assert.deepEqual(labs().map(x => x.name).sort(), ['Hemoglobin A1c', 'Potassium', 'Sodium', 'Vitamin B12']);
  assert.ok(!H.ofKind('panel').some(p => /patient was seen/.test(p.d.name)), 'a sentence must not become a panel title');
});

test('a lab with a qualitative result and an inherited collection date', async () => {
  await H.importText('t.txt', HDR + 'Laboratory Results\nCollected: 01/02/2026\nWBC   <0.5   x10E3/uL   L   4.0-10.5\nHIV Ab   Non-reactive\n');
  assert.equal(lab('WBC').value, '<0.5'); assert.equal(lab('WBC').flag, 'L'); assert.equal(lab('HIV Ab').value, 'Non-reactive'); assert.equal(lab('HIV Ab').date.slice(0, 10), '2026-01-02');
});

test('list items split on hyphen, en dash and em dash without losing the rest of the line', async () => {
  await H.importText('t.txt', HDR + 'ALLERGIES\nPenicillin – rash – hives\nMEDICATIONS\nLisinopril 10 mg – Take 1 tablet daily – with food\n');
  assert.equal(H.ofKind('med')[0].d.sig, 'Take 1 tablet daily – with food'); assert.match(H.ofKind('allergy')[0].d.reaction, /rash/);
});

test('medication list items keep their directions', async () => {
  await H.importText('t.txt', HDR + 'CURRENT MEDICATIONS\nMetformin 500 mg tablet - Take 1 tablet by mouth twice daily\nMedication: ATORVASTATIN 20MG TAB\nSig: TAKE ONE TABLET BY MOUTH EVERY EVENING\nStatus: ACTIVE\n');
  const m = Object.fromEntries(H.ofKind('med').map(x => [x.d.name, x.d.sig]));
  assert.equal(m['Metformin 500 mg tablet'], 'Take 1 tablet by mouth twice daily'); assert.equal(m['ATORVASTATIN 20MG TAB'], 'TAKE ONE TABLET BY MOUTH EVERY EVENING');
});

test('vital signs on one line or on separate lines', async () => {
  await H.importText('t.txt', HDR + 'VITAL SIGNS\n09/14/2026 08:40  BP 142/88  Pulse 76  Temp 98.6 F  Resp 16  SpO2 97%  Wt 214.6 lb  Ht 70 in\nVitals taken Sep 15, 2026\nBlood pressure: 138/84 mmHg\nWeight: 97.3 kg\n');
  const v = H.ofKind('vital').map(x => `${x.d.date.slice(0, 10)} ${x.d.name} ${x.d.value}${x.d.unit}`);
  assert.ok(v.includes('2026-09-14 Blood pressure panel with all children optional 142/88mmHg')); assert.ok(v.includes('2026-09-15 Body weight 97.3kg')); assert.equal(H.ofKind('vital').length, 9);
});

/* ---------------- HTML and encodings ---------------- */
test('HTML export: scripts, styles, comments and head are not imported as text; entities are decoded', async () => {
  await H.importText('p.html', '<!DOCTYPE html><html><head><title>Record</title><style>.a{color:red}</style><script>var secret=1;</script></head><body><!-- hidden comment --><h2>Patient Name: Doe, John   DOB: 01/01/1970</h2><h3>Allergies</h3><ul><li>Penicillin &ndash; rash</li><li>Latex &#8217;s contact dermatitis</li></ul><table><tr><th>Test</th><th>Result</th></tr><tr><td>Sodium</td><td>140 mmol/L</td></tr></table></body></html>');
  const text = E.state.resources.map(r => E.docText(r) + ' ' + E.describe(r).name).join('\n');
  for (const bad of ['var secret', 'color:red', 'hidden comment', '&ndash;', '&#8217;']) assert.ok(!text.includes(bad), 'leaked: ' + bad);
  assert.ok(H.ofKind('allergy').some(x => /Penicillin/.test(x.d.name)));
  assert.ok(/Latex ’s|Latex ’s contact/.test(text) || /Latex/.test(text));
});

test('HTML tables keep their cells apart so lab rows can be read', async () => {
  await H.importText('p.html', '<html><body><p>Patient Name: Doe, John DOB: 01/01/1970</p><h3>Laboratory Results</h3><p>Collected: 09/14/2026 08:12</p><table><tr><th>Test</th><th>Result</th><th>Units</th><th>Reference Range</th><th>Flag</th></tr><tr><td>Potassium</td><td>5.4</td><td>mmol/L</td><td>3.5 - 5.1</td><td>H</td></tr></table></body></html>');
  assert.deepEqual(lab('Potassium'), { name: 'Potassium', value: '5.4', unit: 'mmol/L', date: '2026-09-14T08:12:00-04:00', range: '3.5 - 5.1', flag: 'H', specimen: '' });
});

test('a Windows-1252 text file (not valid UTF-8) is decoded, not shown with replacement characters', async () => {
  const bytes = Buffer.concat([Buffer.from('Patient Name: MU'), Buffer.from([0xD1]), Buffer.from('OZ, JOS'), Buffer.from([0xC9]), Buffer.from('   DOB: 01/01/1970\nALLERGIES\nPenicillin - rash (caf'), Buffer.from([0xE9]), Buffer.from(')\n')]);
  await E.importFile('w.txt', H.toBuf(bytes));
  assert.equal(E.state.patients[0].resource.name[0].family, 'MUÑOZ'); assert.ok(!JSON.stringify(E.state.resources.map(r => E.docText(r) + E.describe(r).name)).includes('�'));
});

test('patient identity: labelled, banner and table forms', async () => {
  const cases = [
    ['Patient Name: SMITH, JOHN Q    DOB: 03/12/1948    Sex: M\nLABS\n', 'SMITH', '1948-03-12', 'male'],
    ['Name: Jane A. Doe DOB: 1971-05-30 Gender: Female MRN: 0012345\n', 'Doe', '1971-05-30', 'female'],
    ['PATIENT: WASHINGTON, GEORGE\nD.O.B.: 02/22/1932\n', 'WASHINGTON', '1932-02-22', undefined],
    ['VETERAN NAME: ALVAREZ,RUBEN   SSN: XXX-XX-1111   DOB: 9/9/1949\n', 'ALVAREZ', '1949-09-09', undefined],
    ['Allergy Name: PENICILLIN\nProvider Name: Dr. Lee Smith\nPatient Name: Chen, Wei\nDOB 12/01/1990\n', 'Chen', '1990-12-01', undefined],
    ['RE:    Records requested 10/20/2026 per VA Form\nPatient: Ortiz, Ana  DOB: 04/14/1977\n', 'Ortiz', '1977-04-14', undefined],
  ];
  for (const [text, fam, dob, sex] of cases) { H.fresh(); const rep = await H.importText('i.txt', text); const p = E.state.patients.find(x => x.key === rep.patientKey).resource; assert.equal(p.name[0].family, fam, text); assert.equal(p.birthDate, dob, text); assert.equal(p.gender, sex, text); }
});

test('ZIP archives are limited so a zip bomb cannot exhaust memory', async () => {
  const zip = new E.deps.JSZip(); for (let i = 0; i < 5; i++) zip.file('f' + i + '.txt', 'Patient Name: DOE, JANE DOB: 01/02/1970\nALLERGIES\nPenicillin - rash\n');
  const reps = await E.importFile('ok.zip', H.toBuf(await zip.generateAsync({ type: 'nodebuffer' }))); assert.equal(reps.length, 5);
  const big = new E.deps.JSZip(); big.file('huge.txt', Buffer.alloc(3 * 1024 * 1024, 65));
  const r2 = await E.importFile('big.zip', H.toBuf(await big.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })), { maxZipBytes: 1024 * 1024 });
  assert.ok(r2[0].warnings.some(w => /too large|limit/i.test(w)), JSON.stringify(r2.map(r => r.warnings)));
});
