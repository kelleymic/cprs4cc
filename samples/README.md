# Sample records

All files are synthetic or fictional. None contain real patient information.

| File | Format | Origin |
|---|---|---|
| `Synthea_FHIR_R4_Hessel.json` | FHIR R4 Bundle | Synthea synthetic patient, [synthetichealth/synthea-sample-data](https://github.com/synthetichealth/synthea-sample-data) |
| `Synthea_CCDA_Hessel.xml` | C-CDA R2.1 CCD | Same Synthea patient as C-CDA |
| `VA_ROI_Printout_HESSEL_2026.pdf` | PDF | Fictional CPRS/VistA-style release-of-information printout (`tools/make_samples.py`) |
| `MyChart_Printout_Hessel_2026.pdf` | PDF | Fictional MyChart-style printout (`tools/make_samples.py`) |
| `VA_BlueButton_HESSEL.txt` | Plain text | Fictional VA Blue Button-style report (`tools/make_samples.py`) |
| `BVH_Lab_ORU_R01.hl7` | HL7 v2.5.1 ORU^R01 | Fictional lab interface message (`tools/make_samples.py`) |
| `Riverside_Multipage_GARCIA_2026.pdf` | PDF | Fictional multi-page clinic printout (`tools/make_sample2.py`) |

Synthea data is distributed under the Apache License 2.0 by the Synthea project.

## HL7 C-CDA examples (not included)

The viewer also reads the official HL7 C-CDA example documents (CCD, discharge summary, progress note, diagnostic imaging report, and others). They are not redistributed here. Download them from [HL7/C-CDA-Examples](https://github.com/HL7/C-CDA-Examples), under `Documents/`, and import them with **File › Import External Records**.
