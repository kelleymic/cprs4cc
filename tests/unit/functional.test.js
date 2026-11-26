'use strict';
// Functional status: ECOG, Karnofsky, Lansky and PPS scores are their own kind ("func"), numeric, and trendable.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../helpers');
const { cdaSection, section, cda, E } = H;
beforeEach(() => H.fresh());
const SURVEY = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'survey' }] }];
const scoreObs = (id, code, text, date, val) => Object.assign({ resourceType: 'Observation', id, status: 'final', category: SURVEY, subject: { reference: 'Patient/p1' }, effectiveDateTime: date, code: { coding: code ? [code] : [], text } }, val);
const LN = c => ({ system: 'http://loinc.org', code: c });
const fn = () => H.ofKind('func').sort((a, b) => (a.d.date + a.d.scale) < (b.d.date + b.d.scale) ? -1 : 1);

test('FHIR ECOG (valueInteger) and Karnofsky (valueQuantity %) become numeric scores with their meaning', async () => {
  await H.importText('b.json', H.fhirBundle(H.PAT,
    scoreObs('e1', LN('89247-1'), 'ECOG Performance Status score', '2025-01-10', { valueInteger: 1 }),
    scoreObs('e2', LN('89247-1'), 'ECOG Performance Status score', '2025-04-10', { valueInteger: 3 }),
    scoreObs('k1', LN('89243-0'), 'Karnofsky Performance Status score', '2025-04-10', { valueQuantity: { value: 60, unit: '%' } })));
  const x = fn(); assert.equal(x.length, 3);
  assert.deepEqual(x.map(i => i.d.scale + ':' + i.d.score), ['ecog:1', 'ecog:3', 'karnofsky:60']);
  assert.match(x[0].d.meaning, /light or sedentary work/);
  assert.match(x[2].d.meaning, /occasional assistance/);
  assert.ok(x.every(i => i.r.valueQuantity && typeof +i.r.valueQuantity.value === 'number'), 'stored as quantities so they can be graphed');
  assert.equal(H.ofKind('vital').length + H.ofKind('lab').length, 0);
});

test('mCODE-style ECOG answered with a LOINC answer code, and Lansky coded with the NCI code', async () => {
  await H.importText('b.json', H.fhirBundle(H.PAT,
    scoreObs('e1', LN('89247-1'), 'ECOG', '2025-02-01', { valueCodeableConcept: { coding: [{ system: 'http://loinc.org', code: 'LA9624-3', display: 'Ambulatory and capable of all selfcare but unable to carry out any work activities' }] } }),
    scoreObs('l1', { system: 'http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl', code: 'C38144' }, 'Lansky Play-Performance Status', '2025-02-01', { valueInteger: 80 })));
  const by = Object.fromEntries(fn().map(i => [i.d.scale, i.d]));
  assert.equal(by.ecog.score, 2);
  assert.equal(by.lansky.score, 80); assert.match(by.lansky.meaning, /tires more quickly/);
});

test('scales are recognized by name when no code is given, and out-of-range scores are not turned into scores', async () => {
  await H.importText('b.json', H.fhirBundle(H.PAT,
    scoreObs('a', null, 'Zubrod performance status', '2025-02-01', { valueString: '2' }),
    scoreObs('b', null, 'KPS', '2025-02-02', { valueString: '90%' }),
    scoreObs('c', null, 'ECOG', '2025-02-03', { valueInteger: 9 })));
  const x = fn(); assert.deepEqual(x.filter(i => i.d.score != null).map(i => i.d.scale + ':' + i.d.score), ['ecog:2', 'karnofsky:90']);
  assert.equal(x.find(i => i.d.date.startsWith('2025-02-03')).d.score, null, 'an ECOG of 9 is not a valid score');
});

test('printed text: scores in a Functional Status section, on a vitals line, and at the start of a line', async () => {
  await H.importText('a.txt', 'Patient: DOE, JANE\nDOB: 01/02/1960\n\nFUNCTIONAL STATUS\n03/01/2025  ECOG performance status: 1\n06/01/2025  ECOG 2   Karnofsky 70%\n\nVITAL SIGNS\n09/01/2025 BP 120/80 Pulse 70 KPS: 60\n');
  const got = fn().map(i => i.d.date + ' ' + i.d.scale + ' ' + i.d.score);
  assert.deepEqual(got, ['2025-03-01 ecog 1', '2025-06-01 ecog 2', '2025-06-01 karnofsky 70', '2025-09-01 karnofsky 60']);
  assert.equal(H.ofKind('vital').length, 2, 'the vitals on the same line are still read');
});

test('printed text: look-alike numbers are not read as scores', async () => {
  await H.importText('a.txt', 'Patient: DOE, JANE\nDOB: 01/02/1960\n\nFUNCTIONAL STATUS\nECOG 7\nKarnofsky 77%\nECOG 1/2 of the visit\n');
  assert.equal(fn().length, 0);
});

test('C-CDA: a Functional Status section holds func observations, and an ECOG inside Results is a func score', async () => {
  const funcObs = `<entry><observation classCode="OBS" moodCode="EVN"><code code="54522-8" codeSystem="2.16.840.1.113883.6.1" displayName="Functional status"/><statusCode code="completed"/><effectiveTime value="20250501"/><value xsi:type="CD" code="105504002" displayName="Dependence on Cane" codeSystem="2.16.840.1.113883.6.96"/></observation></entry>`;
  const ecog = `<entry><organizer classCode="BATTERY" moodCode="EVN"><code code="89246-3" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="completed"/><component><observation classCode="OBS" moodCode="EVN"><code code="89247-1" codeSystem="2.16.840.1.113883.6.1" displayName="ECOG Performance Status score"/><statusCode code="completed"/><effectiveTime value="20250601"/><value xsi:type="INT" value="2"/></observation></component></organizer></entry>`;
  await H.importText('c.xml', cda(cdaSection('2.16.840.1.113883.10.20.22.2.14', '47420-5', 'FUNCTIONAL STATUS', funcObs) + section('results', ecog)));
  const x = fn(); assert.equal(x.length, 2, JSON.stringify(H.counts()));
  const fnd = x.find(i => !i.d.scale), sc = x.find(i => i.d.scale);
  assert.equal(fnd.d.value, 'Dependence on Cane'); assert.equal(sc.d.scale, 'ecog'); assert.equal(sc.d.score, 2);
});

test('the same score from two files is stored once; different dates are kept', async () => {
  const b = H.fhirBundle(H.PAT, scoreObs('e1', LN('89247-1'), 'ECOG', '2025-01-10', { valueInteger: 1 }), scoreObs('e2', LN('89247-1'), 'ECOG', '2025-02-10', { valueInteger: 1 }));
  await H.importText('a.json', b); await H.importText('b.json', b);
  assert.equal(fn().length, 2);
});
