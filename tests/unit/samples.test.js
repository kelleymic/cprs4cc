'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../helpers');
const { E } = H;
beforeEach(() => H.fresh());

const sig = ({ d }) => [d.kind, d.date || '', d.name, d.value ?? '', d.unit || '', d.flag || '', d.range || ''].join('|');
const structured = () => H.all().filter(x => !['unstructured', 'other'].includes(x.d.kind));
const countsOf = list => list.reduce((c, x) => (c[x.d.kind] = (c[x.d.kind] || 0) + 1, c), {});
const lines = list => list.map(sig).sort();

test('HL7 v2 sample: four labs with units, ranges, flags and times; ultrasound report; unknown segment kept', async () => {
  const [rep] = await H.importPath('samples/BVH_Lab_ORU_R01.hl7');
  assert.equal(rep.format, 'HL7 v2 message'); assert.equal(E.state.patients[0].key, 'HESSEL|L|1993-04-04');
  assert.deepEqual(lines(H.ofKind('lab')), [
    'lab|2026-10-19T07:30:00-04:00|Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma|58|U/L|H|7-56',
    'lab|2026-10-19T07:30:00-04:00|Creatinine [Mass/volume] in Serum or Plasma|1.29|mg/dL||0.70-1.30',
    'lab|2026-10-19T07:30:00-04:00|Glucose [Mass/volume] in Serum or Plasma|131|mg/dL|H|70-99',
    'lab|2026-10-19T07:30:00-04:00|Potassium [Moles/volume] in Serum or Plasma|4.6|mmol/L||3.5-5.1']);
  assert.match(E.docText(H.ofKind('radiology')[0].r), /hepatic steatosis/);
  assert.ok(H.ofKind('unstructured').some(x => /ZXT/.test(E.docText(x.r))));
  assert.match(H.byName('lab', /Glucose/)[0].d.comments, /Fasting status not documented/);
});

test('VA Blue Button text sample', async () => {
  await H.importPath('samples/VA_BlueButton_HESSEL.txt');
  assert.deepEqual(countsOf(structured()), { allergy: 1, problem: 2, med: 2, lab: 2, appt: 1 });
  assert.deepEqual(lines(H.ofKind('lab')), ['lab|2026-09-28T07:48:00-04:00|CREATININE|1.27|mg/dL||0.70-1.30', 'lab|2026-09-28T07:48:00-04:00|POTASSIUM|4.7|mmol/L||3.5-5.1']);
  assert.equal(H.ofKind('allergy')[0].d.reaction, 'HIVES'); assert.equal(H.ofKind('allergy')[0].d.date, '2018-03-11');
  const p = H.ofKind('problem').map(x => x.r.code.coding[0].code).sort(); assert.deepEqual(p, ['E11.9', 'I10']);
  assert.equal(H.ofKind('med')[0].d.sig.length > 10, true);
});

test('MyChart PDF sample', async () => {
  await H.importPath('samples/MyChart_Printout_Hessel_2026.pdf');
  assert.deepEqual(countsOf(structured()), { lab: 6, panel: 2, vital: 7, allergy: 2, med: 3, consult: 1 });
  const chol = H.byName('lab', /^Cholesterol, Total/)[0]; assert.deepEqual([chol.d.value, chol.d.unit, chol.d.flag, chol.d.date], ['212', 'mg/dL', 'H', '2026-07-21T07:32:00-04:00']); assert.equal(chol.r.code.coding[0].code, '2093-3');
  const bp = H.byName('vital', /Blood pressure/)[0]; assert.equal(bp.d.value, '138/86');
});

test('multi-page clinic PDF sample: labs continue across pages, note spans pages, patient from a table', async () => {
  const [rep] = await H.importPath('samples/Riverside_Multipage_GARCIA_2026.pdf');
  assert.match(rep.identity, /GARCIA,MARIA L +DOB 1958-11-02/); assert.deepEqual(countsOf(structured()), { lab: 8, note: 1, allergy: 2 });
  assert.equal(H.byName('lab', /POTASSIUM/)[0].d.flag, 'L'); assert.equal(H.byName('lab', /HEMOGLOBIN A1C/)[0].d.value, '8.4');
  const note = H.ofKind('note')[0]; assert.equal(note.r.extension.find(e => e.url === E.EXT_SRC).extension.find(x => x.url === 'pages').valueString, '2-3');
});

test('VA release-of-information PDF sample', async () => {
  await H.importPath('samples/VA_ROI_Printout_HESSEL_2026.pdf');
  assert.deepEqual(countsOf(structured()), { lab: 19, vital: 11, note: 1, radiology: 1, pathology: 1 });
  const k = H.byName('lab', /^POTASSIUM$/); assert.deepEqual(k.map(x => x.d.value + '@' + x.d.date.slice(0, 10)).sort(), ['4.9@2026-06-02', '5.4@2026-09-14']);
  assert.equal(E.state.patients.length, 1); assert.equal(E.state.patients[0].key, 'HESSEL|L|1993-04-04');
});

test('Synthea C-CDA sample: complete and consistent', async () => {
  const [rep] = await H.importPath('samples/Synthea_CCDA_Hessel.xml');
  assert.equal(rep.warnings.length, 0);
  assert.deepEqual(countsOf(structured()), { allergy: 7, med: 15, lab: 128, panel: 32, problem: 33, proc: 86, enc: 28, vital: 60, imm: 13, social: 1 });
});

test('Synthea FHIR sample: every clinical resource in the bundle is imported (ground truth = the bundle itself)', async () => {
  const raw = JSON.parse(H.fs.readFileSync(H.path.join(H.ROOT, 'samples/Synthea_FHIR_R4_Hessel.json'), 'utf8'));
  const gt = {}; raw.entry.forEach(e => gt[e.resource.resourceType] = (gt[e.resource.resourceType] || 0) + 1);
  const [rep] = await H.importPath('samples/Synthea_FHIR_R4_Hessel.json'); assert.equal(rep.warnings.length, 0, rep.warnings.join('|'));
  const stored = {}; E.state.resources.forEach(r => stored[r.resourceType] = (stored[r.resourceType] || 0) + 1);
  for (const t of ['Encounter', 'Condition', 'AllergyIntolerance', 'MedicationRequest', 'Immunization', 'Procedure', 'Observation', 'DiagnosticReport']) assert.equal(stored[t], gt[t], t);
  // Synthea writes each note both as a DocumentReference and as a DiagnosticReport; identical text is stored once, keeping both sources
  assert.equal(stored.DocumentReference || 0, 0); assert.equal(rep.merged, gt.DocumentReference);
  assert.equal(E.state.patients.length, 1);
});

const OBS = ['lab', 'vital', 'survey', 'social', 'obs-other'];
const roundNums = v => String(v).replace(/-?\d+(?:\.\d+)?/g, m => String(+(+m).toPrecision(3)));      // Synthea prints 3.810192413693307 in one format and 3.81 in the other
const obsKey = ({ d }) => [(d.code && d.code.code) || String(d.name).toLowerCase(), (d.date || '').slice(0, 10), roundNums(d.value)].join('|');
const takeObs = async f => { H.fresh(); await H.importPath('samples/' + f); return H.all().filter(x => OBS.includes(x.d.kind)); };

test('the same patient read from FHIR and from C-CDA gives the same results (cross-format parity)', async () => {
  const A = await takeObs('Synthea_CCDA_Hessel.xml'), B = await takeObs('Synthea_FHIR_R4_Hessel.json');
  const kA = new Map(A.map(x => [obsKey(x), x])), kB = new Map(B.map(x => [obsKey(x), x]));
  const onlyA = [...kA.keys()].filter(k => !kB.has(k)), onlyB = [...kB.keys()].filter(k => !kA.has(k));
  assert.deepEqual(onlyA, [], 'every result in the C-CDA must also be found in the FHIR file with the same code, day and value');
  // the sample C-CDA simply does not contain these four kinds of observation (checked against the XML)
  const absentFromCcda = new Set(['4548-4', '85354-9', '72166-2', '93025-5']);
  assert.deepEqual(onlyB.filter(k => !absentFromCcda.has(k.split('|')[0])), []);
  for (const kind of ['problem', 'med', 'allergy', 'imm', 'proc', 'enc']) { H.fresh(); await H.importPath('samples/Synthea_CCDA_Hessel.xml'); const a = H.ofKind(kind).length; H.fresh(); await H.importPath('samples/Synthea_FHIR_R4_Hessel.json'); assert.equal(H.ofKind(kind).length, a, kind + ' counts differ'); }
});

test('units agree between the C-CDA and FHIR readings of the same result', async () => {
  const A = await takeObs('Synthea_CCDA_Hessel.xml'), B = new Map((await takeObs('Synthea_FHIR_R4_Hessel.json')).map(x => [obsKey(x), x])); let both = 0;
  for (const a of A) { const b = B.get(obsKey(a)); if (!b) continue; both++; assert.equal(a.d.unit || '', b.d.unit || '', obsKey(a)); }
  assert.equal(both, A.length);
});

/* Export -> re-import must reproduce the same record. This checks the exporter and the FHIR importer against each other. */
for (const f of ['BVH_Lab_ORU_R01.hl7', 'VA_BlueButton_HESSEL.txt', 'MyChart_Printout_Hessel_2026.pdf', 'Riverside_Multipage_GARCIA_2026.pdf', 'VA_ROI_Printout_HESSEL_2026.pdf', 'Synthea_CCDA_Hessel.xml']) {
  test('export and re-import round trip: ' + f, async () => {
    await H.importPath('samples/' + f);
    const before = lines(structured()); const bundle = E.exportBundle(E.state.patients[0].key);
    H.fresh(); const [rep] = await E.importFile('roundtrip.json', H.toBuf(JSON.stringify(bundle)));
    assert.deepEqual(lines(structured()), before); assert.equal(E.state.patients.length, 1, rep.warnings.join('|'));
    assert.equal(bundle.entry.filter(e => e.resource.resourceType === 'Provenance').length > 0, true);
  });
}
