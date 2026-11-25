'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../helpers');
const { E } = H;
beforeEach(() => H.fresh());

const OBSCAT = c => [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: c }] }];

test('resources marked entered-in-error are not imported, and the user is told', async () => {
  const rep = await H.importText('b.json', H.fhirBundle(H.PAT,
    H.labObs('o1', 'SODIUM', 999, { status: 'entered-in-error' }),
    H.labObs('o2', 'SODIUM', 140, { effectiveDateTime: '2026-01-02T10:00:00Z' }),
    { resourceType: 'Condition', id: 'c1', verificationStatus: { coding: [{ code: 'entered-in-error' }] }, code: { text: 'Wrong problem' }, subject: { reference: 'Patient/p1' } },
    { resourceType: 'AllergyIntolerance', id: 'a1', verificationStatus: { coding: [{ code: 'entered-in-error' }] }, code: { text: 'Wrong allergy' }, patient: { reference: 'Patient/p1' } },
    { resourceType: 'DocumentReference', id: 'd1', status: 'entered-in-error', type: { text: 'Note' }, content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('bad').toString('base64') } }], subject: { reference: 'Patient/p1' } }));
  assert.deepEqual(H.all().map(x => x.d.name + '=' + x.d.value), ['SODIUM=140']);
  assert.ok(rep.warnings.some(w => /4 .*entered-in-error/i.test(w)), 'warning should count the 4 skipped resources: ' + rep.warnings);
});

test('observations with non-quantity values keep their value and are not merged with each other', async () => {
  await H.importText('b.json', H.fhirBundle(H.PAT,
    H.labObs('o1', 'COUNT A', undefined, { valueQuantity: undefined, valueInteger: 5 }),
    H.labObs('o2', 'COUNT A', undefined, { valueQuantity: undefined, valueInteger: 7 }),
    H.labObs('o3', 'TITER', undefined, { valueQuantity: undefined, valueRatio: { numerator: { value: 1 }, denominator: { value: 64 } } }),
    H.labObs('o4', 'RANGE', undefined, { valueQuantity: undefined, valueRange: { low: { value: 3, unit: 'mg/dL' }, high: { value: 5, unit: 'mg/dL' } } }),
    H.labObs('o5', 'PREGNANT', undefined, { valueQuantity: undefined, valueBoolean: false }),
    H.labObs('o6', 'LESS THAN', 3, { valueQuantity: { value: 3, comparator: '<', unit: 'mg/dL' } }),
    H.labObs('o7', 'ABSENT', undefined, { valueQuantity: undefined, dataAbsentReason: { coding: [{ code: 'not-performed' }], text: 'Not performed' } })));
  const v = n => H.byName('lab', new RegExp('^' + n + '$')).map(x => x.d.value).sort();
  assert.deepEqual(v('COUNT A'), ['5', '7']);
  assert.deepEqual(v('TITER'), ['1:64']);
  assert.deepEqual(v('RANGE'), ['3-5']);
  assert.deepEqual(v('PREGNANT'), ['false']);
  assert.deepEqual(v('LESS THAN'), ['<3']);
  assert.deepEqual(v('ABSENT'), ['Not performed']);
});

test('MedicationRequest.medicationReference resolves to the Medication in the bundle, whatever the order', async () => {
  const mr = (id, ref) => ({ resourceType: 'MedicationRequest', id, status: 'active', intent: 'order', medicationReference: { reference: ref }, authoredOn: '2026-02-02', subject: { reference: 'Patient/p1' } });
  await H.importText('b.json', H.fhirBundle(H.PAT, mr('m1', 'Medication/med1'), mr('m2', 'Medication/med2'),
    { resourceType: 'Medication', id: 'med1', code: { text: 'Lisinopril 10 mg tablet' } }, { resourceType: 'Medication', id: 'med2', code: { text: 'Metformin 500 mg tablet' } }));
  assert.deepEqual(H.ofKind('med').map(x => x.d.name).sort(), ['Lisinopril 10 mg tablet', 'Metformin 500 mg tablet']);
});

test('contained Medication and contained Practitioner references resolve', async () => {
  await H.importText('b.json', H.fhirBundle(H.PAT, { resourceType: 'MedicationRequest', id: 'm1', status: 'active', intent: 'order', contained: [{ resourceType: 'Medication', id: 'c1', code: { text: 'Atorvastatin 20 mg tablet' } }, { resourceType: 'Practitioner', id: 'pr1', name: [{ family: 'Okafor', given: ['Ada'], prefix: ['Dr.'] }] }],
    medicationReference: { reference: '#c1' }, requester: { reference: '#pr1' }, authoredOn: '2026-02-02', subject: { reference: 'Patient/p1' } }));
  const m = H.ofKind('med')[0];
  assert.equal(m.d.name, 'Atorvastatin 20 mg tablet');
  assert.match(m.r.requester.display, /Okafor/);
});

test('DSTU2 / STU3 resources are converted to R4 shapes instead of losing fields', async () => {
  const rep = await H.importText('old.json', H.fhirBundle(H.PAT,
    { resourceType: 'Immunization', id: 'i1', status: 'completed', date: '2025-10-01', vaccineCode: { text: 'Influenza' }, patient: { reference: 'Patient/p1' } },
    { resourceType: 'Immunization', id: 'i2', status: 'completed', wasNotGiven: true, date: '2025-11-01', vaccineCode: { text: 'COVID' }, patient: { reference: 'Patient/p1' } },
    { resourceType: 'MedicationOrder', id: 'mo1', status: 'active', dateWritten: '2026-03-03', medicationCodeableConcept: { text: 'Amoxicillin 500 mg' }, patient: { reference: 'Patient/p1' }, dosageInstruction: [{ text: 'one capsule three times daily' }] },
    { resourceType: 'Condition', id: 'c1', clinicalStatus: 'resolved', verificationStatus: 'confirmed', dateRecorded: '2024-04-04', code: { text: 'Pneumonia' }, patient: { reference: 'Patient/p1' } },
    { resourceType: 'AllergyIntolerance', id: 'a1', status: 'active', substance: { text: 'Penicillin' }, onset: '2010-05-05', reaction: [{ manifestation: [{ text: 'Hives' }], severity: 'moderate' }], patient: { reference: 'Patient/p1' } },
    H.labObs('o1', 'POTASSIUM', 5.9, { interpretation: { coding: [{ system: 'http://hl7.org/fhir/v2/0078', code: 'H' }] } }),
    { resourceType: 'Encounter', id: 'e1', status: 'finished', class: 'inpatient', period: { start: '2026-05-01T08:00:00Z', end: '2026-05-04T12:00:00Z' }, reason: [{ text: 'Chest pain' }], patient: { reference: 'Patient/p1' } },
    { resourceType: 'DocumentReference', id: 'd1', status: 'current', type: { text: 'Progress note' }, created: '2026-06-06T09:00:00Z', content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('Patient is well.').toString('base64') } }], subject: { reference: 'Patient/p1' } }));
  const imm = H.ofKind('imm'); assert.deepEqual(imm.map(x => x.d.date + ' ' + x.d.status).sort(), ['2025-10-01 completed', '2025-11-01 not-done']);
  const med = H.ofKind('med')[0]; assert.equal(med.d.name, 'Amoxicillin 500 mg'); assert.equal(med.d.date, '2026-03-03'); assert.equal(med.d.sig, 'one capsule three times daily'); assert.equal(med.r.resourceType, 'MedicationRequest');
  const cond = H.ofKind('problem')[0]; assert.equal(cond.d.status, 'resolved'); assert.equal(cond.d.date, '2024-04-04');
  const al = H.ofKind('allergy')[0]; assert.equal(al.d.name, 'Penicillin'); assert.equal(al.d.date, '2010-05-05'); assert.equal(al.d.reaction, 'Hives'); assert.equal(al.d.status, 'active');
  assert.equal(H.ofKind('lab')[0].d.flag, 'H');
  const enc = H.ofKind('enc')[0]; assert.equal(enc.r.class.code, 'IMP'); assert.match(enc.d.reason, /Chest pain/);
  assert.equal(H.ofKind('note')[0].d.date, '2026-06-06T09:00:00Z');
  assert.ok(rep.warnings.some(w => /DSTU2|STU3/.test(w)), 'should say the file was converted');
});

test('two patients in one NDJSON file keep their own results', async () => {
  const nd = [{ resourceType: 'Patient', id: 'a', name: [{ family: 'Alpha', given: ['A'] }], birthDate: '1960-01-01' }, { resourceType: 'Patient', id: 'b', name: [{ family: 'Bravo', given: ['B'] }], birthDate: '1961-02-02' },
    H.labObs('x1', 'K', 4, { subject: { reference: 'Patient/a' } }), H.labObs('x2', 'K', 5, { subject: { reference: 'Patient/b' } })].map(x => JSON.stringify(x)).join('\n');
  await H.importText('multi.ndjson', nd);
  const by = Object.fromEntries(H.ofKind('lab').map(x => [H.patientOf(x.r).resource.name[0].family, x.d.value]));
  assert.deepEqual(by, { Alpha: '4', Bravo: '5' });
});

test('a bulk-export ZIP routes Observation.ndjson to the patients listed in Patient.ndjson', async () => {
  const zip = new H.E.deps.JSZip();
  // Observation file is listed BEFORE the patient file on purpose
  zip.file('Observation.ndjson', [H.labObs('x1', 'K', 4, { subject: { reference: 'Patient/a' } }), H.labObs('x2', 'K', 5, { subject: { reference: 'Patient/b' } })].map(x => JSON.stringify(x)).join('\n'));
  zip.file('Patient.ndjson', [{ resourceType: 'Patient', id: 'a', name: [{ family: 'Alpha', given: ['A'] }], birthDate: '1960-01-01' }, { resourceType: 'Patient', id: 'b', name: [{ family: 'Bravo', given: ['B'] }], birthDate: '1961-02-02' }].map(x => JSON.stringify(x)).join('\n'));
  await E.importFile('export.zip', H.toBuf(await zip.generateAsync({ type: 'nodebuffer' })));
  assert.equal(E.state.patients.length, 2, 'no UNIDENTIFIED patient should be created: ' + E.state.patients.map(p => p.key));
  const by = Object.fromEntries(H.ofKind('lab').map(x => [H.patientOf(x.r).resource.name[0].family, x.d.value]));
  assert.deepEqual(by, { Alpha: '4', Bravo: '5' });
});

test('DocumentReference attachments that point at a Binary in the bundle are inlined', async () => {
  const html = '<html><body><p>Assessment: stable.</p><p>Plan: continue medications.</p></body></html>';
  await H.importText('epic.json', H.fhirBundle(H.PAT,
    { resourceType: 'DocumentReference', id: 'd1', status: 'current', type: { text: 'Progress Notes' }, date: '2026-06-06T09:00:00Z', content: [{ attachment: { contentType: 'text/html', url: 'https://fhir.example.org/r4/Binary/b1' } }], subject: { reference: 'Patient/p1' } },
    { resourceType: 'Binary', id: 'b1', contentType: 'text/html', data: Buffer.from(html).toString('base64') }));
  const note = H.ofKind('note')[0];
  assert.match(E.docText(note.r), /Assessment: stable\./);
  assert.match(E.docText(note.r), /Plan: continue medications\./);
  assert.ok(!E.state.resources.some(r => r.resourceType === 'Binary'), 'an inlined Binary should not also clutter Ext Data');
});

test('attached PDFs are labelled, not decoded as text', async () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3000, 7)]).toString('base64');
  await H.importText('b.json', H.fhirBundle(H.PAT, { resourceType: 'DocumentReference', id: 'd1', status: 'current', type: { text: 'Outside records' }, content: [{ attachment: { contentType: 'application/pdf', data: pdf } }], subject: { reference: 'Patient/p1' } }));
  const t = E.docText(H.ofKind(['note', 'unstructured'])[0].r);
  assert.match(t, /PDF/); assert.ok(t.length < 400, 'binary content must not be dumped as text');
});

test('OperationOutcome entries and unparsable NDJSON lines do not break the import', async () => {
  const nd = [JSON.stringify(H.PAT), '{"resourceType":"Observation", BROKEN', JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'warning', code: 'informational' }] }), JSON.stringify(H.labObs('o1', 'SODIUM', 140))].join('\n');
  const rep = await H.importText('x.ndjson', nd);
  assert.deepEqual(H.ofKind('lab').map(x => x.d.value), ['140']);
  assert.ok(rep.warnings.some(w => /line 2/.test(w)), 'bad line should be reported: ' + rep.warnings);
  assert.equal(H.ofKind('other').length, 0);
});

test('the official / usual name is used for matching, not a nickname listed first', async () => {
  await H.importText('a.json', H.fhirBundle({ resourceType: 'Patient', id: 'p1', name: [{ use: 'nickname', given: ['Bobby'] }, { use: 'official', family: 'Smith', given: ['Robert', 'J'] }], birthDate: '1950-05-05' }));
  assert.equal(E.state.patients[0].key, 'SMITH|R|1950-05-05');
  assert.equal(E.state.patients[0].resource.name[0].family, 'Smith');
});

test('FHIR XML is recognised as unsupported rather than read as an HTML export', async () => {
  const xml = '<?xml version="1.0"?><Bundle xmlns="http://hl7.org/fhir"><type value="searchset"/><entry><resource><Patient><id value="1"/><text><div xmlns="http://www.w3.org/1999/xhtml"><p>Ann Test</p></div></text></Patient></resource></entry></Bundle>';
  const rep = await H.importText('b.xml', xml);
  assert.ok(rep.warnings.some(w => /FHIR XML/i.test(w)), rep.warnings.join('|'));
  assert.notEqual(rep.format, 'HTML export');
});

test('reference ranges given only as text are parsed into low/high', async () => {
  await H.importText('b.json', H.fhirBundle(H.PAT, H.labObs('o1', 'POTASSIUM', 5.4, { referenceRange: [{ text: '3.5 - 5.1 mmol/L' }] })));
  const d = H.ofKind('lab')[0].d; assert.equal(d.low, 3.5); assert.equal(d.high, 5.1);
});

test('effectiveInstant and issued are used when effectiveDateTime is absent', async () => {
  await H.importText('b.json', H.fhirBundle(H.PAT, H.labObs('o1', 'A', 1, { effectiveDateTime: undefined, effectiveInstant: '2026-04-04T04:04:04Z' }), H.labObs('o2', 'B', 2, { effectiveDateTime: undefined, issued: '2026-05-05T05:05:05Z' })));
  assert.deepEqual(H.ofKind('lab').map(x => x.d.date).sort(), ['2026-04-04T04:04:04Z', '2026-05-05T05:05:05Z']);
});

test('vital signs and labs are classified from category or LOINC', async () => {
  await H.importText('b.json', H.fhirBundle(H.PAT,
    { resourceType: 'Observation', id: 'v1', status: 'final', category: OBSCAT('vital-signs'), code: { coding: [{ system: 'http://loinc.org', code: '29463-7' }], text: 'Weight' }, valueQuantity: { value: 80, unit: 'kg' }, effectiveDateTime: '2026-01-01T10:00:00Z', subject: { reference: 'Patient/p1' } },
    { resourceType: 'Observation', id: 'v2', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] }, valueQuantity: { value: 70, unit: '/min' }, effectiveDateTime: '2026-01-01T10:00:00Z', subject: { reference: 'Patient/p1' } },
    H.labObs('l1', 'GLUCOSE', 90)));
  assert.deepEqual(H.counts(), { vital: 2, lab: 1 });
});

test('blood pressure is shown systolic/diastolic whatever order the components are listed in', async () => {
  const bp = (id, comps, t) => ({ resourceType: 'Observation', id, status: 'final', category: OBSCAT('vital-signs'), code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }], text: 'Blood pressure' }, effectiveDateTime: t, subject: { reference: 'Patient/p1' }, component: comps });
  const sys = v => ({ code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic blood pressure' }] }, valueQuantity: { value: v, unit: 'mm[Hg]' } });
  const dia = v => ({ code: { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastolic blood pressure' }] }, valueQuantity: { value: v, unit: 'mm[Hg]' } });
  await H.importText('b.json', H.fhirBundle(H.PAT, bp('b1', [dia(83), sys(129)], '2026-01-01T10:00:00Z'), bp('b2', [sys(142), dia(88)], '2026-01-02T10:00:00Z')));
  assert.deepEqual(H.ofKind('vital').map(x => x.d.value).sort(), ['129/83', '142/88']);
});

test('the same blood pressure from two sources merges even when the components are in a different order', async () => {
  const mk = (id, comps) => ({ resourceType: 'Observation', id, status: 'final', category: OBSCAT('vital-signs'), code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }] }, effectiveDateTime: '2026-01-01T10:00:00Z', subject: { reference: 'Patient/p1' }, component: comps });
  const c = (code, v) => ({ code: { coding: [{ system: 'http://loinc.org', code }] }, valueQuantity: { value: v, unit: 'mm[Hg]' } });
  await H.importText('a.json', H.fhirBundle(H.PAT, mk('b1', [c('8480-6', 129), c('8462-4', 83)])));
  const rep = await H.importText('b.json', H.fhirBundle(H.PAT, mk('b2', [c('8462-4', 83), c('8480-6', 129)])));
  assert.equal(H.ofKind('vital').length, 1); assert.equal(rep.merged, 1);
});
