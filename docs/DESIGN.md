# CPRS4CC — design notes (v5)

## Standard format: HL7 FHIR R4 (US Core-aligned), used internally and for export
- FHIR is the API format US certified EHRs are required to support (ONC Cures Act / USCDI). Epic, Oracle Health and VA Lighthouse already expose it, so exports can be read back by them and by most health-data tools.
- Granular: every vital, lab result, problem, medication, allergy, immunization, procedure, visit and document is its own resource.
- Lab/vital = Observation: effectiveDateTime, valueQuantity (UCUM units), referenceRange low/high/text, interpretation (H/L/HH/LL/A), specimen, performer (performing lab), note (comments), status. Blood pressure = panel 85354-9 with systolic/diastolic components.
- Text documents (notes, consults, discharge summaries, radiology, pathology) = DocumentReference: date, author, custodian (source facility), title, base64 text body. LOINC types 11506-3, 11488-4, 18842-5, 18748-4, 11526-1.
- Lab panels = DiagnosticReport referencing the result Observations.

## Source traceability
- Extension `https://cprs4cc.example.org/fhir/StructureDefinition/source-reference` (placeholder canonical URL) on every resource: file, pages, locator (line / HL7 segment / CDA section+entry / Bundle entry), format, method (rules | claude-deidentified | claude-direct | rules (fallback)), system, originalId, importedAt.
- Identical items in several files are merged (key = code + minute + value, etc.) and keep all source references.
- Export: FHIR Bundle (type collection) plus one Provenance per source file with its SHA-256 hash. A flat CSV (one row per data element) is also offered.

## Unmapped content
- DocumentReference with category code `unstructured-import`: date if present, text, source reference. Shown on the Ext Data tab. Covers fax cover sheets, handouts, narrative-only C-CDA sections, unknown HL7 v2 segments, repeated page headers/footers, image-only PDF pages, and Claude results rejected by verification.

## Claude-based extraction for PDF/text printouts
- Why: rule-based PDF parsing was unreliable on real printouts (undated labs, non-problems on the Problem list). Claude extraction is an opt-in method in File › Import; the built-in rules remain the default and the fallback.
- Methods: Built-in rules (nothing leaves the browser) · Claude, identifiers removed · Claude, without substitution.
- Connections (Tools › Claude Extraction Settings):
  - Claude in this viewer: the claude.ai account of the person using the viewer (artifact `sample` capability; consent prompt on first use; counts toward their usage). Anthropic's BAA does not cover published artifacts, so identifiers are always removed on this route.
  - Organization's Claude API endpoint (Messages API format; URL, x-api-key or Bearer auth, model). The API key is kept in memory only. Works when `index.html` is hosted on the organization's network.
  - "Without substitution" is enabled only for an organization endpoint marked as approved for PHI (BAA-covered or inside the VA network), with a confirmation per file.
- De-identification in the browser, before anything is sent: `[PATIENT]` (all printed forms of the patient's name), `[D-n]` for every date of any kind (labs, vitals, medications, allergies, notes, imaging, pathology, print and fax dates, month-year, YYYYMMDD; the year alone is kept), `[ID-n]` (SSN incl. masked, MRN/ICN/EDIPI/account/accession/Rx/claim/order numbers, long numbers), `[PH-n]`, `[EMAIL-n]`, `[URL-n]`, `[IP-n]`, `[ADDR-n]` (street, city+state, ZIP), `[PER-n]` (clinicians, relatives), `[AGE 90+]`, `[TERM-n]` (user-added). The key (placeholder → original, date → ISO date) never leaves the browser.
- Review step: the exact text to be sent is shown with color-coded placeholders (hover shows the original). The user can remove selected text or add terms, then Send / Use built-in rules / Skip. Image-only pages are never sent.
- Prompt: page- and line-numbered text. Claude returns JSON items (lab, vital, problem, medication, allergy, immunization, procedure, encounter, document) with page/line pointers and dates as placeholders, plus unmapped ranges marked layout or content. The end of the previous page is sent as context so continued tables keep their dates. Batches of about 12,000 characters; a failed batch is retried page by page, and pages that still fail are imported with the built-in rules.
- Verification and restoration: each value and name must appear on (or within two lines of) the cited line, otherwise the item is rejected and kept as unmapped text with the reason. Document bodies are copied from the original page text; Claude never returns note text. Placeholders are restored to the originals; date placeholders become real dates (plus time if printed). Lines not accounted for become "Not classified" unmapped records; headings, column headers and page headers/footers are consolidated into one layout record per file.
- Testing so far: no identifiers leaked into prompts for the sample PDFs; mock replies verified mapping, dates across page breaks, multi-page documents and allergies, rejection of an invented value, fallback to rules, direct mode with literal dates, endpoint authentication and key handling. Not yet tested against real Claude responses or real-world PDFs.
- Compliance: whether de-identified text meets HIPAA Safe Harbor or VA policy is for the facility Privacy Officer / ISSO. Automated removal can miss identifiers in narrative text; the review step mitigates this.

## LOINC mapping of lab results
- 207 LOINC codes in `src/catalog.txt` (injected into the page by `build.py`): metabolic panel, liver/pancreas, cardiac, lipids, diabetes, iron/vitamins, thyroid/endocrine, inflammation, coagulation, CBC with differential, blood gases, urinalysis, urine chemistry, serology/infectious disease, drug levels/toxicology, immunoglobulins/free light chains/M-protein, and serum tumor markers.
- Serum tumor markers: PSA total, ultrasensitive PSA, free PSA, % free PSA, CEA, CA 19-9, CA-125, CA 15-3, CA 27.29, CA 72-4, AFP, AFP-L3%, beta-hCG, total hCG, beta-2 microglobulin, chromogranin A, calcitonin, thyroglobulin, NSE, HE4, SCC antigen, CYFRA 21-1, inhibin B, HER2 (serum), 5-HIAA (serum), gastrin; LDH and kappa/lambda free light chains are also included.
- Verification: tumor-marker codes checked against the HL7 mCODE tumor-marker value set; uncertain codes looked up individually; all 207 pass the LOINC mod-10 check digit (`tests/catcheck.js`).
- Matching: printed name normalized; specimen-aware (serum vs urine vs arterial/venous). Applied to printed/text imports, Claude-extracted labs, and any lab Observation arriving without a LOINC code. Help › LOINC Mapping Table lists the catalog.

## Patients
- File › Add New Patient…: last name, first name, date of birth, sex.
- Matching across files and manual entries: family name + first initial + DOB.
- Identity in PDF/text imports: labelled fields anywhere on a line, label above value, table header rows, banner lines with a DOB; candidates are scored and the result is shown in the import log. The found name is also used for de-identification.

## PDF layout handling (built-in rules)
- Page gaps, repeated headers/footers and "continued" markers are removed so tables, notes and key/value blocks flow across pages; page ranges are recorded.
- Reference ranges: "3.5 - 5.1", "3.5-5.1 mmol/L", "(136-145)", "Normal: 70-99", "0.45 to 4.50", "<200", ">= 40". Text-only ranges from C-CDA and FHIR are parsed into low/high as well.

## Trend graphs
- Click a lab or vital value to graph all values of the same item. Periods of 3 months to All, or a custom range; the default ends at the last value. Reference range shown as dotted red lines; unit conversion (kg/lb, cm/in, °C/°F); blood pressure as two series.

## Known limits
- No OCR: scanned pages are flagged and never sent to Claude.
- Printed times carry no time zone; the viewer's local zone is assumed.
- FHIR STU3/DSTU2 are read as R4 with a warning.
- Synthea sample labs carry no reference ranges.
- LOINC mapping is name-based; tests outside the catalog keep only their printed name.
