'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../helpers');
const { E, section, cda } = H;
beforeEach(() => H.fresh());

const LN = 'codeSystem="2.16.840.1.113883.6.1"', SCT = 'codeSystem="2.16.840.1.113883.6.96"';
const obs = (code, name, value, extra) => `<observation classCode="OBS" moodCode="EVN"><code code="${code}" ${LN} displayName="${name}"/><statusCode code="completed"/>${extra && extra.time ? `<effectiveTime value="${extra.time}"/>` : ''}${value}${(extra && extra.after) || ''}</observation>`;
const pq = (v, u) => `<value xsi:type="PQ" value="${v}" unit="${u}"/>`;
const organizer = (time, ...obsList) => `<entry><organizer classCode="BATTERY" moodCode="EVN"><code code="24323-8" ${LN} displayName="CMP"/><statusCode code="completed"/>${time ? `<effectiveTime value="${time}"/>` : ''}${obsList.map(o => `<component>${o}</component>`).join('')}</organizer></entry>`;

test('a result without its own time takes the time of its panel (organizer)', async () => {
  await H.importText('c.xml', cda(section('results', organizer('20260105080000', obs('2951-2', 'Sodium', pq(140, 'mmol/L'))))));
  const lab = H.ofKind('lab')[0]; assert.equal(lab.d.date, '2026-01-05T08:00:00-05:00');
});

test('interval values keep their bound: "<3" is not read as "3"', async () => {
  const ivl = (inner) => `<value xsi:type="IVL_PQ">${inner}</value>`;
  await H.importText('c.xml', cda(section('results', organizer('20260105080000',
    obs('1751-7', 'Albumin', ivl('<high value="3" unit="g/dL" inclusive="false"/>')),
    obs('2345-7', 'Glucose', ivl('<low value="500" unit="mg/dL" inclusive="false"/>')),
    obs('2160-0', 'Creatinine', ivl('<high value="1.2" unit="mg/dL"/>')),
    obs('718-7', 'Hemoglobin', ivl('<low value="12" unit="g/dL"/><high value="16" unit="g/dL"/>'))))));
  const v = Object.fromEntries(H.ofKind('lab').map(x => [x.d.name, x.d.value]));
  assert.equal(v.Albumin, '<3'); assert.equal(v.Glucose, '>500'); assert.equal(v.Creatinine, '<=1.2'); assert.equal(v.Hemoglobin, '12-16');
});

test('titers (ratio values) are kept', async () => {
  await H.importText('c.xml', cda(section('results', organizer('20260105080000', obs('5195-3', 'HBsAg titer', '<value xsi:type="RTO"><numerator xsi:type="INT" value="1"/><denominator xsi:type="INT" value="64"/></value>')))));
  assert.equal(H.ofKind('lab')[0].d.value, '1:64');
});

test('result status codes: aborted/cancelled results are not shown as final', async () => {
  await H.importText('c.xml', cda(section('results', `<entry><organizer classCode="BATTERY" moodCode="EVN"><code code="24323-8" ${LN}/><statusCode code="completed"/><effectiveTime value="20260105080000"/>
    <component><observation classCode="OBS" moodCode="EVN"><code code="2951-2" ${LN} displayName="Sodium"/><statusCode code="aborted"/>${pq(140, 'mmol/L')}</observation></component>
    <component><observation classCode="OBS" moodCode="EVN"><code code="2823-3" ${LN} displayName="Potassium"/><statusCode code="completed"/>${pq(4.1, 'mmol/L')}</observation></component></organizer></entry>`)));
  const st = Object.fromEntries(H.ofKind('lab').map(x => [x.d.name, x.d.status])); assert.equal(st.Sodium, 'cancelled'); assert.equal(st.Potassium, 'final');
});

const problem = (valueCode, valueName, o) => `<entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.3"/><code code="CONC"/><statusCode code="${(o && o.actStatus) || 'active'}"/>
  <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN"${o && o.negated ? ' negationInd="true"' : ''}><templateId root="2.16.840.1.113883.10.20.22.4.4"/><code code="55607006"/><statusCode code="completed"/><effectiveTime><low value="20200101"/>${o && o.high ? `<high value="${o.high}"/>` : ''}</effectiveTime>
  <value xsi:type="CD" code="${valueCode}" ${SCT} displayName="${valueName}"/>${o && o.status ? `<entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN"><code code="33999-4" ${LN}/><statusCode code="completed"/><value xsi:type="CE" code="${o.status[0]}" ${SCT} displayName="${o.status[1]}"/></observation></entryRelationship>` : ''}</observation></entryRelationship></act></entry>`;

test('problem status: active / inactive / resolved are distinguished', async () => {
  await H.importText('c.xml', cda(section('problems', problem('44054006', 'Type 2 diabetes', { status: ['55561003', 'Active'] }) + problem('195967001', 'Asthma', { status: ['73425007', 'Inactive'] }) + problem('233604007', 'Pneumonia', { status: ['413322009', 'Resolved'] }) + problem('38341003', 'Hypertension', { high: '20240101' }))));
  const st = Object.fromEntries(H.ofKind('problem').map(x => [x.d.name, x.d.status]));
  assert.deepEqual(st, { 'Type 2 diabetes': 'active', Asthma: 'inactive', Pneumonia: 'resolved', Hypertension: 'resolved' });
});

test('a negated problem is not imported as an active diagnosis', async () => {
  await H.importText('c.xml', cda(section('problems', problem('38341003', 'Hypertension', { negated: true }))));
  const p = H.ofKind('problem')[0]; assert.ok(!p || p.d.status === 'refuted' || p.r.verificationStatus, 'negated problem must be flagged refuted');
  if (p) assert.equal(p.r.verificationStatus.coding[0].code, 'refuted');
});

test('every problem observation in a concern act becomes its own Condition', async () => {
  const two = `<entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.3"/><code code="CONC"/><statusCode code="active"/>
   <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.4"/><code code="55607006"/><effectiveTime><low value="20200101"/></effectiveTime><value xsi:type="CD" code="44054006" ${SCT} displayName="Type 2 diabetes"/></observation></entryRelationship>
   <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.4"/><code code="55607006"/><effectiveTime><low value="20210101"/></effectiveTime><value xsi:type="CD" code="38341003" ${SCT} displayName="Hypertension"/></observation></entryRelationship></act></entry>`;
  await H.importText('c.xml', cda(section('problems', two)));
  assert.deepEqual(H.ofKind('problem').map(x => x.d.name).sort(), ['Hypertension', 'Type 2 diabetes']);
});

const med = (code, name, o) => `<entry><substanceAdministration classCode="SBADM" moodCode="${(o && o.mood) || 'EVN'}"${o && o.negated ? ' negationInd="true"' : ''}>${(o && o.text) || ''}<statusCode code="${(o && o.status) || 'active'}"/>
  <effectiveTime xsi:type="IVL_TS"><low value="20260101"/>${o && o.high ? `<high value="${o.high}"/>` : ''}</effectiveTime>${(o && o.freq) || ''}${(o && o.dose) || ''}${(o && o.route) || ''}
  <consumable><manufacturedProduct><manufacturedMaterial>${code ? `<code code="${code}" codeSystem="2.16.840.1.113883.6.88" displayName="${name}"/>` : '<code nullFlavor="NA"/>'}</manufacturedMaterial></manufacturedProduct></consumable></substanceAdministration></entry>`;

test('medication sig is read from the narrative the entry points to', async () => {
  const text = '<text><table><tbody><tr><td ID="sig1">Take 1 tablet by mouth twice daily with meals</td></tr></tbody></table></text>';
  await H.importText('c.xml', cda(section('meds', med('197361', 'Metformin 500 MG', { text: '<text><reference value="#sig1"/></text>' }), text)));
  assert.equal(H.ofKind('med')[0].d.sig, 'Take 1 tablet by mouth twice daily with meals');
});

test('medication sig is built from dose, route and frequency when no text is given', async () => {
  await H.importText('c.xml', cda(section('meds', med('197361', 'Metformin 500 MG', { freq: '<effectiveTime xsi:type="PIVL_TS" institutionSpecified="true" operator="A"><period value="12" unit="h"/></effectiveTime>', dose: '<doseQuantity value="1" unit="tablet"/>', route: '<routeCode code="C38288" codeSystem="2.16.840.1.113883.3.26.1.1" displayName="Oral"/>' }))));
  const sig = H.ofKind('med')[0].d.sig; assert.match(sig, /1 tablet/); assert.match(sig, /Oral/i); assert.match(sig, /12 ?h/);
});

test('"no known medications" entries do not create a medication', async () => {
  await H.importText('c.xml', cda(section('meds', med(null, '', { negated: true }) + med('197361', 'Metformin 500 MG'))));
  assert.deepEqual(H.ofKind('med').map(x => x.d.name), ['Metformin 500 MG']);
});

test('medication status: discontinued and completed courses are not shown as active', async () => {
  await H.importText('c.xml', cda(section('meds', med('1', 'Drug A', { status: 'aborted' }) + med('2', 'Drug B', { status: 'completed', high: '20260201' }) + med('3', 'Drug C', { status: 'active' }) + med('4', 'Drug D', { mood: 'INT' }))));
  const st = Object.fromEntries(H.ofKind('med').map(x => [x.d.name, x.d.status]));
  assert.deepEqual(st, { 'Drug A': 'stopped', 'Drug B': 'completed', 'Drug C': 'active', 'Drug D': 'active' });
  assert.equal(H.ofKind('med').find(x => x.d.name === 'Drug D').r.resourceType, 'MedicationRequest');
});

const allergy = (name, o) => `<entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.30"/><code code="CONC"/><statusCode code="${(o && o.actStatus) || 'active'}"/><entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN"${o && o.negated ? ' negationInd="true"' : ''}><templateId root="2.16.840.1.113883.10.20.22.4.7"/>
  <code code="ASSERTION" codeSystem="2.16.840.1.113883.5.4"/><statusCode code="completed"/><effectiveTime><low value="20100505"/></effectiveTime><value xsi:type="CD" code="${(o && o.type) || '416098002'}" ${SCT} displayName="${(o && o.typeName) || 'Drug allergy'}"/>
  <participant typeCode="CSM"><participantRole classCode="MANU"><playingEntity classCode="MMAT"><code code="7980" codeSystem="2.16.840.1.113883.6.88" displayName="${name}"/></playingEntity></participantRole></participant>
  ${o && o.reaction ? `<entryRelationship typeCode="MFST" inversionInd="true"><observation classCode="OBS" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.9"/><code code="ASSERTION" codeSystem="2.16.840.1.113883.5.4"/><value xsi:type="CD" code="247472004" ${SCT} displayName="${o.reaction}"/></observation></entryRelationship>` : ''}
  ${o && o.status ? `<entryRelationship typeCode="SUBJ" inversionInd="true"><observation classCode="OBS" moodCode="EVN"><code code="33999-4" ${LN}/><statusCode code="completed"/><value xsi:type="CE" code="${o.status[0]}" ${SCT} displayName="${o.status[1]}"/></observation></entryRelationship>` : ''}
  </observation></entryRelationship></act></entry>`;

test('allergy category, reaction and inactive status are kept', async () => {
  await H.importText('c.xml', cda(section('allergies', allergy('Penicillin', { reaction: 'Hives' }) + allergy('Peanut', { type: '414285001', typeName: 'Food allergy' }) + allergy('Sulfa', { status: ['73425007', 'Inactive'] }))));
  const a = Object.fromEntries(H.ofKind('allergy').map(x => [x.d.name, x.d]));
  assert.equal(a.Penicillin.reaction, 'Hives'); assert.equal(a.Penicillin.category, 'medication'); assert.equal(a.Penicillin.status, 'active');
  assert.equal(a.Peanut.category, 'food'); assert.equal(a.Sulfa.status, 'inactive');
});

test('note text that is stored by reference is resolved (Epic / Oracle Health style)', async () => {
  const ref = '<text><paragraph ID="n1">Patient seen for follow up. Stable.</paragraph></text>';
  const body = `<component><section><templateId root="2.16.840.1.113883.10.20.22.2.65"/><code code="34109-9" ${LN}/><title>Notes</title>${ref}<entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.202"/><code code="11506-3" ${LN} displayName="Progress note"/><text><reference value="#n1"/></text><effectiveTime value="20260105"/></act></entry></section></component>`;
  await H.importText('c.xml', cda(body));
  assert.match(E.docText(H.ofKind('note')[0].r), /Patient seen for follow up\. Stable\./);
});

test('immunizations keep status, lot and manufacturer', async () => {
  const imm = `<entry><substanceAdministration classCode="SBADM" moodCode="EVN"><statusCode code="completed"/><effectiveTime value="20251001"/><consumable><manufacturedProduct><manufacturedMaterial><code code="140" codeSystem="2.16.840.1.113883.12.292" displayName="Influenza, seasonal"/><lotNumberText>AB1234</lotNumberText></manufacturedMaterial><manufacturerOrganization><name>Sanofi Pasteur</name></manufacturerOrganization></manufacturedProduct></consumable></substanceAdministration></entry>`;
  await H.importText('c.xml', cda(section('imms', imm)));
  const i = H.ofKind('imm')[0]; assert.equal(i.d.date, '2025-10-01'); assert.equal(i.r.lotNumber, 'AB1234'); assert.equal(i.r.manufacturer.display, 'Sanofi Pasteur');
});

test('a namespace-prefixed ClinicalDocument is recognised', async () => {
  const x = cda(section('results', organizer('20260105080000', obs('2951-2', 'Sodium', pq(140, 'mmol/L'))))).replace(/<(\/?)([A-Za-z])/g, '<$1cda:$2').replace('xmlns=', 'xmlns:cda=').replace('xmlns:xsi', 'xmlns:xsi');
  const rep = await H.importText('c.xml', x);
  assert.equal(rep.format, 'HL7 C-CDA (XML)'); assert.equal(H.ofKind('lab').length, 1);
});

test('blood pressure systolic/diastolic are combined into one panel', async () => {
  const vit = `<entry><organizer classCode="CLUSTER" moodCode="EVN"><code code="46680005" ${SCT}/><statusCode code="completed"/><effectiveTime value="20260105080000"/>
    <component>${obs('8480-6', 'Systolic', pq(142, 'mm[Hg]'))}</component><component>${obs('8462-4', 'Diastolic', pq(88, 'mm[Hg]'))}</component><component>${obs('8867-4', 'Heart rate', pq(72, '/min'))}</component></organizer></entry>`;
  await H.importText('c.xml', cda(section('vitals', vit)));
  const v = Object.fromEntries(H.ofKind('vital').map(x => [x.d.name, x.d.value])); assert.equal(v['Blood pressure'], '142/88'); assert.equal(v['Heart rate'], '72');
});
