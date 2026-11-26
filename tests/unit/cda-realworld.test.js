'use strict';
// Patterns seen in vendor-generated C-CDAs (jddamore/ccda-samples, HL7/C-CDA-Examples). Fixtures are small hand-written
// reproductions of the pattern, not copies of those files.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../helpers');
const { section, cdaSection, cda } = H;
beforeEach(() => H.fresh());
const LN = 'codeSystem="2.16.840.1.113883.6.1"', SCT = 'codeSystem="2.16.840.1.113883.6.96"', RX = 'codeSystem="2.16.840.1.113883.6.88"';
const imp = body => H.importText('c.xml', cda(body));

test('a literal displayName="null" falls back to the narrative text of the code', async () => {
  const text = '<text><table><tbody><tr><td ID="allergy-1">ampicillin</td></tr><tr><td ID="allergy-2">penicillin G</td></tr></tbody></table></text>';
  const alg = (id, code, ref) => `<entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.30"/><statusCode code="active"/><entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.7"/><statusCode code="completed"/><value xsi:type="CD" code="419199007" ${SCT}/><participant typeCode="CSM"><participantRole classCode="MANU"><playingEntity classCode="MMAT"><code code="${code}" ${RX} displayName="null"><originalText><reference value="#${ref}"/></originalText></code></playingEntity></participantRole></participant></observation></entryRelationship></act></entry>`;
  await imp(section('allergies', alg(1, '733', 'allergy-1') + alg(2, '7980', 'allergy-2'), text));
  assert.deepEqual(H.ofKind('allergy').map(x => x.d.name).sort(), ['ampicillin', 'penicillin G']);
});

test('"none" statements are not filed as real entries (no known problems / immunizations / procedures)', async () => {
  const text = '<text><content ID="p1">No known problems</content><content ID="pr1">No Information About Procedures</content></text>';
  const noProblem = `<entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.3"/><code code="CONC"/><statusCode code="active"/><entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN" negationInd="true"><templateId root="2.16.840.1.113883.10.20.22.4.4"/><code code="ASSERTION"/><text><reference value="#p1"/></text><statusCode code="completed"/><value xsi:type="CD" code="55607006" displayName="Problem" ${SCT}/></observation></entryRelationship></act></entry>`;
  const noImm = '<entry><substanceAdministration classCode="SBADM" moodCode="EVN" negationInd="true"><statusCode code="active"/><consumable><manufacturedProduct><manufacturedMaterial><code nullFlavor="OTH"><originalText>Vaccination</originalText><translation code="71181003" displayName="vaccine" codeSystem="2.16.840.1.113883.6.96"/></code></manufacturedMaterial></manufacturedProduct></consumable></substanceAdministration></entry>';
  const noProc = '<entry><procedure classCode="PROC" moodCode="EVN"><code nullFlavor="NI"><originalText><reference value="#pr1"/></originalText></code><statusCode code="completed"/></procedure></entry>';
  const rep = await imp(section('problems', noProblem, text) + section('imms', noImm, text) + section('procs', noProc, text));
  assert.equal(H.ofKind(['problem', 'imm', 'proc']).length, 0, JSON.stringify(H.counts()));
  assert.ok(rep.skipped && rep.skipped.noneStatements >= 3);
  assert.ok(H.ofKind('unstructured').length >= 1, 'the narrative text is still kept');
});

test('a problem that is explicitly negated but specific stays as a refuted condition', async () => {
  const neg = `<entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.3"/><statusCode code="active"/><entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN" negationInd="true"><templateId root="2.16.840.1.113883.10.20.22.4.4"/><statusCode code="completed"/><value xsi:type="CD" code="44054006" displayName="Diabetes mellitus type 2" ${SCT}/></observation></entryRelationship></act></entry>`;
  await imp(section('problems', neg));
  const p = H.ofKind('problem'); assert.equal(p.length, 1); assert.equal(p[0].d.status, 'refuted');
});

test('functional status goes to the Function section; goals, plans and family history are not filed as laboratory results', async () => {
  const funcObs = `<entry><organizer classCode="CLUSTER" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.66"/><code code="d5" displayName="Self-Care"/><statusCode code="completed"/><component><observation classCode="OBS" moodCode="EVN"><code code="54522-8" ${LN} displayName="Functional Status"/><statusCode code="completed"/><effectiveTime value="20050501"/><value xsi:type="CD" code="105504002" displayName="Dependence on Cane" ${SCT}/></observation></component></organizer></entry>`;
  const planObs = `<entry><observation classCode="OBS" moodCode="RQO"><code code="24323-8" ${LN} displayName="Comprehensive metabolic panel"/><statusCode code="active"/></observation></entry>`;
  const famObs = `<entry><organizer classCode="CLUSTER" moodCode="EVN"><component><observation classCode="OBS" moodCode="EVN"><code code="55561003" displayName="Active" ${SCT}/><statusCode code="completed"/><value xsi:type="CD" code="38341003" displayName="Hypertension" ${SCT}/></observation></component></organizer></entry>`;
  await imp(cdaSection('2.16.840.1.113883.10.20.22.2.14', '47420-5', 'FUNCTIONAL STATUS', funcObs) + cdaSection('2.16.840.1.113883.10.20.22.2.10', '18776-5', 'PLAN OF TREATMENT', planObs, '<text>Order: CMP</text>') + cdaSection('2.16.840.1.113883.10.20.22.2.15', '10157-6', 'FAMILY HISTORY', famObs, '<text>Father: hypertension</text>'));
  assert.equal(H.ofKind('lab').length, 0, 'nothing here is a lab');
  const s = H.ofKind('func'); assert.equal(s.length, 1); assert.equal(s[0].d.value, 'Dependence on Cane');
  const kept = H.ofKind('unstructured').map(x => Buffer.from(x.r.content[0].attachment.data, 'base64').toString('utf8')).join('\n');
  assert.match(kept, /Father: hypertension/); assert.match(kept, /Order: CMP/);
});

test('a result given only as narrative (empty <value xsi:type="ED">) keeps the narrative text', async () => {
  const text = '<text><content ID="result9">Two views of the chest show no acute disease.</content></text>';
  const o = `<entry><organizer classCode="BATTERY" moodCode="EVN"><code code="30746-2" ${LN}/><statusCode code="completed"/><component><observation classCode="OBS" moodCode="EVN"><code code="36643-5" ${LN} displayName="Chest X-ray 2 Views"/><text><reference value="#result9"/></text><statusCode code="completed"/><effectiveTime value="20150622"/><value xsi:type="ED"></value></observation></component></organizer></entry>`;
  await imp(section('results', o, text));
  const x = H.ofKind('lab')[0]; assert.match(x.d.value, /no acute disease/);
});

test('an empty "results not available" placeholder is not imported', async () => {
  const o = '<entry><organizer classCode="BATTERY" moodCode="EVN"><code nullFlavor="NI"/><statusCode code="completed"/><component><observation classCode="OBS" moodCode="EVN" negationInd="true"><code nullFlavor="NI"/><text>Results excluded/not available</text><statusCode code="completed"/><value xsi:type="ST" nullFlavor="NI"/></observation></component></organizer></entry>';
  await imp(section('results', o));
  assert.equal(H.ofKind(['lab', 'panel']).length, 0);
});

test('medications: organizer-wrapped doses, a refused drug, and a free-text entry', async () => {
  const sa = (code, name, extra, mood) => `<substanceAdministration classCode="SBADM" moodCode="${mood || 'EVN'}"${(extra && extra.neg) ? ' negationInd="true"' : ''}><statusCode code="${(extra && extra.status) || 'active'}"/><effectiveTime xsi:type="IVL_TS"><low value="20180315"/></effectiveTime><consumable><manufacturedProduct><manufacturedMaterial><code ${code ? `code="${code}" ${RX} displayName="${name}"` : 'nullFlavor="UNK"'}/></manufacturedMaterial></manufacturedProduct></consumable>${(extra && extra.inner) || ''}</substanceAdministration>`;
  const wrapped = `<entry><organizer classCode="CLUSTER" moodCode="EVN"><statusCode code="active"/><component>${sa('204892', 'azithromycin 250 MG Oral Tablet', null, 'INT')}</component><component>${sa('204892', 'azithromycin 250 MG Oral Tablet', { status: 'completed' })}</component></organizer></entry>`;
  const refused = `<entry>${sa('314076', 'lisinopril 10 MG Oral Tablet', { neg: true })}</entry>`;
  const free = `<entry>${sa(null, '', { inner: '<entryRelationship typeCode="COMP"><substanceAdministration classCode="SBADM" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.147"/><text><reference value="#sig1"/></text></substanceAdministration></entryRelationship>' })}</entry>`;
  await imp(section('meds', wrapped + refused + free, '<text><content ID="sig1">Experimental cure-all, one tab by mouth every morning</content></text>'));
  const m = H.ofKind('med'); const by = re => m.find(x => re.test(x.d.name));
  assert.ok(by(/azithromycin/), 'doses inside an organizer are imported');
  assert.equal(by(/lisinopril/).d.status, 'not-taken');
  assert.match(by(/Experimental/).d.name, /every morning/);
});
