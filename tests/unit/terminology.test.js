'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../helpers');
const { E } = H;

test('every catalog LOINC code has a valid mod-10 check digit and is unique', () => {
  const chk = c => { const [n, d] = c.split('-'); const r = n.split('').reverse(); let odd = '', even = ''; r.forEach((x, i) => i % 2 === 0 ? odd = x + odd : even = x + even); const s = (even + String(Number(odd) * 2)).split('').reduce((a, b) => a + +b, 0); return String((10 - s % 10) % 10) === d; };
  const seen = new Set();
  for (const e of E.LAB_CAT) { assert.ok(chk(e.code), 'bad check digit ' + e.code + ' ' + e.display); assert.ok(!seen.has(e.code), 'duplicate ' + e.code); seen.add(e.code); }
  assert.equal(E.LAB_CAT.length, 207);
});

/* printed name (+ specimen) -> LOINC. Expected codes were checked against the LOINC table. */
const MAP = [
  ['CA 19-9', '', '24108-3'], ['CA-125', '', '10334-1'], ['CEA', '', '2039-6'], ['PSA, TOTAL', '', '2857-1'], ['PSA, FREE', '', '10886-0'], ['AFP, TUMOR MARKER', '', '1834-1'], ['LDH', '', '2532-0'],
  ['CREATININE', 'URINE', '2161-8'], ['CREATININE', 'SERUM', '2160-0'], ['PH', 'URINE', '5803-2'], ['PH', 'ARTERIAL BLOOD', '2744-1'], ['WBC', '', '6690-2'], ['GLUCOSE, FASTING', '', '1558-6'], ['HEMOGLOBIN A1C', '', '4548-4'],
  ['NEUTROPHILS %', '', '770-8'], ['ABSOLUTE NEUTROPHILS', '', '751-8'], ['NEUT #', '', '751-8'], ['ALK PHOS', '', '6768-6'], ['TSH, 3RD GENERATION', '', '3016-3'], ['K+', '', '2823-3'], ['Cholesterol, Total', '', '2093-3'],
  ['INR', '', '6301-6'], ['FERRITIN', '', '2276-4'], ['NT-proBNP', '', '33762-6'],
];
for (const [name, spec, code] of MAP) test(`LOINC mapping: ${name}${spec ? ' [' + spec + ']' : ''} -> ${code}`, () => { const e = E.lookupLab(name, spec, true); assert.ok(e, 'not mapped'); assert.equal(e.code, code); });

test('ambiguous or unknown names are left unmapped rather than guessed', () => {
  assert.equal(E.lookupLab('PH', '', true), null);       // blood, urine or other? unknown
  assert.equal(E.lookupLab('UNKNOWN THING', '', true), null);
});

test('urine protein maps to the presence code for qualitative values and to mass/volume for numbers', () => {
  assert.equal(E.lookupLab('PROTEIN', 'URINE', false).code, '20454-5'); assert.equal(E.lookupLab('PROTEIN', 'URINE', true).code, '2888-6');
});

/* reference-range text -> low / high */
const RANGES = [
  ['(136-145) mmol/L', 136, 145], ['3.5-5.1 mmol/L', 3.5, 5.1], ['Normal: 70-99', 70, 99], ['>= 40', 40, undefined], ['0.45 to 4.50', 0.45, 4.5], ['<100', undefined, 100], ['≤ 5.0', undefined, 5], ['[70-99]', 70, 99], ['-5 - 5', -5, 5],
];
for (const [text, low, high] of RANGES) test(`reference range "${text}"`, async () => {
  H.fresh(); await H.importText('b.json', H.fhirBundle(H.PAT, H.labObs('o1', 'X', 1, { referenceRange: [{ text }] })));
  const d = H.ofKind('lab')[0].d; assert.equal(d.low === '' ? undefined : d.low, low); assert.equal(d.high === '' ? undefined : d.high, high);
});

test('abnormal flags are normalised to v3 interpretation codes', async () => {
  H.fresh();
  await H.importText('o.hl7', H.hl7('MSH|^~\\&|LAB|FAC|||20260105083000||ORU^R01|1|P|2.5', 'PID|1||MRN1^^^FAC^MR||Test^Ann||19700101|F', 'OBR|1|||24323-8^CMP^LN|||20260105073000',
    'OBX|1|NM|1^A^L||1|u|0-2|H|||F', 'OBX|2|NM|2^B^L||1|u|0-2|L|||F', 'OBX|3|NM|3^C^L||1|u|0-2|HH|||F', 'OBX|4|NM|4^D^L||1|u|0-2|LL|||F', 'OBX|5|NM|5^E^L||1|u|0-2|A|||F', 'OBX|6|NM|6^F^L||1|u|0-2|N|||F'));
  const f = Object.fromEntries(H.ofKind('lab').map(x => [x.d.name, x.d.flag])); assert.deepEqual(f, { A: 'H', B: 'L', C: 'HH', D: 'LL', E: 'A', F: '' });
});
