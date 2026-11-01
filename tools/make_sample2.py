"""Fictional multi-page clinic printout: patient identity in a table (page 1 only); lab table,
progress note and allergy record that each continue onto the next page."""
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
import sys
out = sys.argv[1]
c = canvas.Canvas(out, pagesize=letter); W, H = letter
pages = [
 ["**RIVERSIDE FAMILY MEDICINE (FICTIONAL) - CHART COPY",
  "",
  "Patient Name          Date of Birth     Sex       MRN",
  "GARCIA, MARIA L       11/02/1958        Female    55-201-77",
  "",
  "**LABORATORY RESULTS",
  "Collection DT: 08/11/2026 07:40   Specimen: SERUM",
  "Performing Lab: RIVERSIDE REFERENCE LAB",
  "Test name                Result    units        Ref. range",
  "SODIUM                   141       mmol/L       136 - 145",
  "POTASSIUM                3.3  L    mmol/L       3.5 - 5.1",
  "CHLORIDE                 101       mmol/L       98 - 107",
  "CO2                      27        mmol/L       22 - 29",
  "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
  "Continued on next page"],
 ["**LABORATORY RESULTS (continued)",
  "Test name                Result    units        Ref. range",
  "UREA NITROGEN            18        mg/dL        7 - 20",
  "CREATININE               0.92      mg/dL        0.57 - 1.00",
  "GLUCOSE                  212  H    mg/dL        70 - 99",
  "  Comment: Patient reports eating breakfast before the draw.",
  "HEMOGLOBIN A1C           8.4  H    %            4.0 - 5.6",
  "",
  "**PROGRESS NOTES",
  "LOCAL TITLE: DIABETES FOLLOW-UP",
  "STANDARD TITLE: PRIMARY CARE NOTE",
  "DATE OF NOTE: AUG 18, 2026@10:05",
  "      AUTHOR: OYELARAN,PATRICK J",
  "",
  "S: 67 yo woman with type 2 diabetes for 12 years. Home glucose readings",
  "160-240 fasting. Missing evening glipizide doses about twice weekly.",
  "Reports tingling in both feet at night for 3 months.",
  "",
  "O: BP 148/90, P 76, Wt 182 lb. Decreased monofilament sensation at",
  "both great toes. No foot ulcers. Fundi not examined.",
  "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
  "(continued)"],
 ["A/P:",
  "1. Type 2 diabetes, uncontrolled (A1c 8.4) - add empagliflozin 10 mg daily.",
  "2. Hypokalemia, mild (K 3.3) - stop hydrochlorothiazide, recheck BMP 2 weeks.",
  "3. Peripheral neuropathy - podiatry referral, B12 level.",
  "",
  "/es/ PATRICK J OYELARAN, MD",
  "Signed: 08/18/2026 11:12",
  "",
  "**ALLERGIES",
  "Allergy Name: SULFONAMIDE ANTIBIOTICS",
  "Reaction: HIVES",
  "Allergy Type: DRUG",
  "",
  "Allergy Name: LATEX",
  "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
 ["Reaction: CONTACT DERMATITIS",
  "Allergy Type: ENVIRONMENTAL",
  "Date Entered: 05/02/2019",
  "",
  "Faxed to: Dr. K. Mensah, Endocrinology, 10/29/2026"],
]
for i, ls in enumerate(pages, 1):
    y = H - 40
    for ln in ls:
        bold = ln.startswith("**"); c.setFont("Courier-Bold" if bold else "Courier", 9)
        if ln: c.drawString(36, y, ln[2:] if bold else ln)
        y -= 12
    c.setFont("Courier", 7); c.drawString(36, 24, f"Riverside Family Medicine - printed 10/29/2026   Page {i} of {len(pages)}")
    c.showPage()
c.save()
