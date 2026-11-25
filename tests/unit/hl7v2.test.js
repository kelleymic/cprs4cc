'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../helpers');
const { E, hl7 } = H;
beforeEach(() => H.fresh());

const MSH = 'MSH|^~\\&|LAB|FAC|||20260105083000||ORU^R01|1|P|2.5';
const PID = 'PID|1||MRN1^^^FAC^MR||Test^Ann||19700101|F';
const OBR = 'OBR|1|||24323-8^CMP^LN|||20260105073000';

test('alternate coding triplet (local code + LOINC) keeps both codings, even outside the catalog', async () => {
  await H.importText('o.hl7', hl7(MSH, PID, OBR, 'OBX|1|NM|L77^Zorbazole level^L^99999-9^Zorbazole^LN||4.2|ng/mL|1-5|N|||F'));
  const codes = H.ofKind('lab')[0].r.code.coding.map(c => c.system + '|' + c.code);
  assert.ok(codes.includes('http://loinc.org|99999-9'), codes.join(' ; '));
  assert.ok(codes.includes('urn:hl7v2:L|L77'));
});

test('structured numeric (SN) comparators become a quantity with a comparator', async () => {
  await H.importText('o.hl7', hl7(MSH, PID, OBR, 'OBX|1|SN|1751-7^Albumin^LN||<^3|g/dL|3.5-5.0|L|||F', 'OBX|2|SN|2345-7^Glucose^LN||>^500|mg/dL|70-99|HH|||F', 'OBX|3|SN|X^Ratio^L||^1^:^64||||||F'));
  const v = Object.fromEntries(H.ofKind('lab').map(x => [x.d.name, x.d.value]));
  assert.equal(v.Albumin, '<3'); assert.equal(v.Glucose, '>500'); assert.equal(v.Ratio, '1:64');
});

test('coded results keep their code and system', async () => {
  await H.importText('o.hl7', hl7(MSH, PID, OBR, 'OBX|1|CWE|600-7^Blood culture^LN||112283007^Escherichia coli^SCT||||A|||F'));
  const c = H.ofKind('lab')[0].r.valueCodeableConcept; assert.equal(c.text, 'Escherichia coli'); assert.equal(c.coding[0].code, '112283007'); assert.equal(c.coding[0].system, 'http://snomed.info/sct');
});

test('an embedded PDF report (OBX ED) becomes a labelled document, not a base64 lab value', async () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(900, 3)]).toString('base64');
  await H.importText('o.hl7', hl7(MSH, PID, OBR, 'OBX|1|ED|PDF^Report^L||^application^pdf^Base64^' + pdf + '||||||F'));
  assert.equal(H.ofKind('lab').length, 0);
  const doc = H.ofKind(['note', 'radiology', 'pathology', 'unstructured'])[0]; assert.ok(doc, 'document expected');
  assert.match(E.docText(doc.r), /PDF/); assert.ok(E.docText(doc.r).length < 400);
});

test('an embedded plain-text report (OBX ED, base64 text) is decoded', async () => {
  const txt = Buffer.from('FINDINGS: No acute disease.\nIMPRESSION: Normal chest.').toString('base64');
  await H.importText('o.hl7', hl7(MSH, PID, 'OBR|1|||71046^Chest 2 views^CPT|||20260105073000', 'OBX|1|ED|RPT^Report^L||^text^plain^Base64^' + txt + '||||||F'));
  const doc = H.ofKind(['radiology', 'note'])[0]; assert.match(E.docText(doc.r), /IMPRESSION: Normal chest\./);
});

test('results flagged deleted (D) or wrong patient (W) are not imported', async () => {
  const rep = await H.importText('o.hl7', hl7(MSH, PID, OBR, 'OBX|1|NM|2951-2^Sodium^LN||140|mmol/L|136-145|N|||F', 'OBX|2|NM|2823-3^Potassium^LN||9.9|mmol/L|3.5-5.1|HH|||D', 'OBX|3|NM|2075-0^Chloride^LN||1|mmol/L|98-107|LL|||W'));
  assert.deepEqual(H.ofKind('lab').map(x => x.d.name), ['Sodium']); assert.ok(rep.warnings.some(w => /2 .*(deleted|wrong|entered-in-error)/i.test(w)), rep.warnings.join('|'));
});

test('MLLP framing characters and a batch of several messages are handled', async () => {
  const m = (name, id, v) => hl7(MSH, `PID|1||${id}^^^FAC^MR||${name}^Pat||19700101|F`, OBR, `OBX|1|NM|2951-2^Sodium^LN||${v}|mmol/L|136-145|N|||F`);
  const rep = await H.importText('batch.hl7', '\x0b' + m('Alpha', 'A1', 140) + '\x1c\r\x0b' + m('Bravo', 'B1', 150) + '\x1c\r');
  assert.equal(rep.format, 'HL7 v2 message');
  const by = Object.fromEntries(H.ofKind('lab').map(x => [H.patientOf(x.r).resource.name[0].family, x.d.value])); assert.deepEqual(by, { Alpha: '140', Bravo: '150' });
});

test('result status mapping and notes', async () => {
  await H.importText('o.hl7', hl7(MSH, PID, OBR, 'OBX|1|NM|2951-2^Sodium^LN||140|mmol/L|136-145|N|||P', 'NTE|1||Specimen slightly hemolyzed', 'OBX|2|NM|2823-3^Potassium^LN||4.1|mmol/L|3.5-5.1|N|||C'));
  const s = Object.fromEntries(H.ofKind('lab').map(x => [x.d.name, x.d])); assert.equal(s.Sodium.status, 'preliminary'); assert.equal(s.Potassium.status, 'corrected'); assert.match(s.Sodium.comments, /hemolyzed/);
});

test('text reports (TX) are grouped into one document with title, date and author', async () => {
  await H.importText('o.hl7', hl7(MSH, PID, 'OBR|1|||71046^Chest 2 views^CPT|||20260105073000|||||||||1234^Okafor^Ada', 'OBX|1|TX|RPT^Report^L||FINDINGS: Clear lungs.||||||F', 'OBX|2|TX|RPT^Report^L||IMPRESSION: Normal.||||||F'));
  const d = H.ofKind('radiology')[0]; assert.match(E.docText(d.r), /FINDINGS: Clear lungs\.\nIMPRESSION: Normal\./); assert.match(d.d.author, /Okafor/);
});
