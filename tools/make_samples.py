"""Generate synthetic (fictional) printed-record samples for patient Lenard Hessel
(the same synthetic Synthea patient used in the FHIR and C-CDA samples).
All content is invented test data; no real patient information."""
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
import os, sys

OUT = sys.argv[1] if len(sys.argv) > 1 else 'samples'
os.makedirs(OUT, exist_ok=True)

PT = "HESSEL,LENARD F"
SSN = "XXX-XX-0417"
DOB = "04/04/1993"


def mono_pdf(path, pages, header_fn=None, font="Courier", size=9):
    c = canvas.Canvas(path, pagesize=letter)
    w, h = letter
    total = len(pages)
    for i, lines in enumerate(pages, 1):
        y = h - 40
        if header_fn:
            for hl in header_fn(i, total):
                c.setFont(font + "-Bold", size)
                c.drawString(36, y, hl)
                y -= size + 3
            y -= 4
        c.setFont(font, size)
        for ln in lines:
            if ln.startswith("**"):
                c.setFont(font + "-Bold", size)
                c.drawString(36, y, ln[2:])
                c.setFont(font, size)
            else:
                c.drawString(36, y, ln)
            y -= size + 3
        c.setFont(font, 7)
        c.drawString(36, 24, f"Printed 10/27/2026 14:02 by ROI OFFICE   Page {i} of {total}   CONFIDENTIAL - 38 USC 7332")
        c.showPage()
    c.save()


# ---------------- VA CPRS / VistA printout (Release of Information) ----------------
def va_hdr(i, n):
    return [f"{PT}   {SSN}   DOB: {DOB}", "VA BERKSHIRE COUNTY HEALTH CARE SYSTEM (FICTIONAL)  -  MEDICAL RECORD COPY"]

va_pages = []
va_pages.append([
    "**FACSIMILE / RELEASE OF INFORMATION COVER SHEET",
    "",
    "TO:    Dr. Amira Patel, Pittsfield Community Clinic   FAX: (413) 555-0182",
    "FROM:  Release of Information Unit, VA Berkshire HCS",
    "DATE:  10/27/2026        PAGES (incl. cover): 6",
    "RE:    Records requested 10/20/2026 per VA Form 10-5345 on file",
    "",
    "The information contained in this transmission is confidential and",
    "intended only for the named recipient. If you received this in error,",
    "notify the sender immediately and destroy all copies.",
    "",
    "Requested: labs 2026, vital signs, progress notes, imaging, pathology.",
    "Handwritten note on original: 'pt prefers AM appts - call cell'",
])
va_pages.append([
    "**LABORATORY RESULTS",
    "Collection DT: 09/14/2026 08:12   Specimen: SERUM",
    "Performing Lab: VA BERKSHIRE HCS LAB, 1 MEDICAL CTR DR, PITTSFIELD MA",
    "Test name                Result    units        Ref. range",
    "SODIUM                   139       mmol/L       136 - 145",
    "POTASSIUM                5.4  H    mmol/L       3.5 - 5.1",
    "CHLORIDE                 104       mmol/L       98 - 107",
    "CO2                      25        mmol/L       22 - 29",
    "UREA NITROGEN            21   H    mg/dL        7 - 20",
    "CREATININE               1.31 H    mg/dL        0.70 - 1.30",
    "GLUCOSE                  128  H    mg/dL        70 - 99",
    "  Comment: Non-fasting specimen per collection note.",
    "CALCIUM                  9.4       mg/dL        8.6 - 10.3",
    "HEMOGLOBIN A1C           6.6  H    %            4.0 - 5.6",
    "",
    "Collection DT: 09/14/2026 08:12   Specimen: BLOOD",
    "Performing Lab: VA BERKSHIRE HCS LAB, 1 MEDICAL CTR DR, PITTSFIELD MA",
    "Test name                Result    units        Ref. range",
    "WBC                      6.8       K/cmm        4.5 - 11.0",
    "HGB                      12.9 L    g/dL         13.5 - 17.5",
    "  Comment: Repeat in 3 months suggested.",
    "HCT                      38.7 L    %            41.0 - 53.0",
    "PLT                      231       K/cmm        150 - 400",
    "MCV                      88        fL           80 - 100",
    "",
    "Collection DT: 09/14/2026 08:12   Specimen: URINE",
    "Performing Lab: VA BERKSHIRE HCS LAB, 1 MEDICAL CTR DR, PITTSFIELD MA",
    "Test name                Result    units        Ref. range",
    "MICROALBUMIN/CREAT RATIO 41   H    mg/g         0 - 30",
    "",
    "Collection DT: 06/02/2026 07:55   Specimen: SERUM",
    "Performing Lab: VA BERKSHIRE HCS LAB, 1 MEDICAL CTR DR, PITTSFIELD MA",
    "Test name                Result    units        Ref. range",
    "POTASSIUM                4.9       mmol/L       3.5 - 5.1",
    "CREATININE               1.22      mg/dL        0.70 - 1.30",
    "HEMOGLOBIN A1C           6.9  H    %            4.0 - 5.6",
    "LDL CHOLESTEROL (CALC)   118  H    mg/dL        0 - 99",
])
va_pages.append([
    "**VITAL SIGNS",
    "Date/Time           Measurement",
    "09/14/2026 08:40    BP: 142/88 mmHg",
    "09/14/2026 08:40    Pulse: 84 /min",
    "09/14/2026 08:40    Resp: 16 /min",
    "09/14/2026 08:40    Temp: 98.2 F",
    "09/14/2026 08:40    Pulse Ox: 97 %",
    "09/14/2026 08:40    Wt: 214.6 lb",
    "09/14/2026 08:40    Pain: 3",
    "06/02/2026 08:21    BP: 136/84 mmHg",
    "06/02/2026 08:21    Pulse: 78 /min",
    "06/02/2026 08:21    Wt: 218.2 lb",
    "06/02/2026 08:21    Ht: 70 in",
    "",
    "**PROGRESS NOTES",
    "LOCAL TITLE: PRIMARY CARE NOTE",
    "STANDARD TITLE: PRIMARY CARE NOTE",
    "DATE OF NOTE: SEP 14, 2026@08:55     ENTRY DATE: SEP 14, 2026@09:31:12",
    "      AUTHOR: NGUYEN,ROSALIND M      EXP COSIGNER:",
    "     URGENCY:                              STATUS: COMPLETED",
    "",
    "CHIEF COMPLAINT: Follow-up prediabetes/early diabetes, elevated BP.",
    "",
    "S: 33 yo male Veteran seen for routine follow-up. Reports increased",
    "fatigue over the past 2 months, no chest pain, no dyspnea. Sleeping",
    "6 hours nightly. Walking 20 minutes three times weekly.",
    "",
    "O: BP 142/88, P 84, Wt 214.6 lb. Lungs clear. Heart RRR, no murmur.",
    "No pedal edema. Monofilament intact bilaterally.",
    "",
    "A/P:",
    "1. Type 2 diabetes, new by A1c 6.6 and 6.9 - start metformin 500 mg",
    "   daily with evening meal, titrate in 2 weeks. Diabetes education.",
    "2. Hypertension, stage 2 reading today - start lisinopril 10 mg daily.",
    "   Recheck BMP in 2 weeks given K 5.4 and Cr 1.31.",
    "3. Mild anemia, Hgb 12.9 - iron studies and B12 ordered.",
]
)
va_pages.append([
    "4. Albuminuria (UACR 41) - consistent with early diabetic kidney",
    "   disease; ACE inhibitor as above. Repeat UACR in 3 months.",
    "5. Chest x-ray ordered for chronic cough reported at last visit.",
    "",
    "RTC 3 months. Patient verbalized understanding of plan.",
    "",
    "/es/ ROSALIND M NGUYEN, MD",
    "PRIMARY CARE PHYSICIAN",
    "Signed: 09/14/2026 09:31",
    "",
    "**RADIOLOGY REPORTS",
    "Exm Date: SEP 18, 2026@10:12",
    "Procedure: CHEST 2 VIEWS PA&LAT          (RAD  Detailed) CPT:71046",
    "Req Phys: NGUYEN,ROSALIND M        Pat Loc: PITTSFIELD PC",
    "Status: VERIFIED",
    "",
    "Clinical History:",
    "  Chronic cough x 3 months. Former smoker.",
    "",
    "Report:",
    "  PA and lateral views of the chest. The lungs are clear without focal",
    "  consolidation, effusion, or pneumothorax. Cardiomediastinal silhouette",
    "  is within normal limits. Mild degenerative change thoracic spine.",
    "",
    "Impression:",
    "  1. No acute cardiopulmonary process.",
    "",
    "Primary Interpreting Staff:",
    "  OKAFOR,DANIEL T, Radiologist",
    "/ESIGNED BY: OKAFOR,DANIEL T  09/18/2026 13:47",
])
va_pages.append([
    "**SURGICAL PATHOLOGY",
    "Date Spec taken: AUG 03, 2026 14:20     Accession #: SP 26 1187",
    "Pathologist: LINDQVIST,MARTA E           Resident:",
    "Submitted by: DERMATOLOGY CLINIC         Date completed: AUG 06, 2026",
    "Specimen: SKIN, LEFT UPPER BACK, SHAVE BIOPSY",
    "",
    "Brief Clinical History:",
    "  6 mm irregular pigmented lesion, rule out dysplastic nevus.",
    "",
    "Gross Description:",
    "  Received in formalin labeled with patient name, a tan-brown shave",
    "  of skin 0.7 x 0.6 x 0.1 cm. Inked, trisected, entirely submitted.",
    "",
    "Microscopic exam/diagnosis:",
    "  SKIN, LEFT UPPER BACK, SHAVE BIOPSY:",
    "  - COMPOUND NEVUS WITH MILD ARCHITECTURAL DISORDER.",
    "  - Margins free of lesion.",
    "",
    "/es/ MARTA E LINDQVIST, MD  08/06/2026",
    "",
    "**PATIENT EDUCATION HANDOUT (ATTACHED)",
    "Eating well with diabetes: fill half your plate with non-starchy",
    "vegetables, one quarter with lean protein, one quarter with whole",
    "grains. Choose water instead of sugary drinks.",
    "",
    "Scanned signature block - illegible - received 10/2026",
])
mono_pdf(os.path.join(OUT, "VA_ROI_Printout_HESSEL_2026.pdf"), va_pages, va_hdr)


# ---------------- Epic MyChart-style printout (proportional font, tabular) ----------------
def epic_pdf(path):
    c = canvas.Canvas(path, pagesize=letter)
    w, h = letter

    def footer(n, t):
        c.setFont("Helvetica", 7)
        c.drawString(40, 22, f"MyChart (sample) - Berkshire Valley Health (fictional) - printed 10/26/2026 7:44 PM   Page {n} of {t}")

    # page 1: lab results
    y = h - 50
    c.setFont("Helvetica-Bold", 14); c.drawString(40, y, "Test Results"); y -= 18
    c.setFont("Helvetica", 9); c.drawString(40, y, "Lenard F Hessel   |   MRN: E4471902   |   DOB: 4/4/1993"); y -= 26
    c.setFont("Helvetica-Bold", 11); c.drawString(40, y, "LIPID PANEL"); y -= 14
    c.setFont("Helvetica", 9)
    c.drawString(40, y, "Collected on Jul 21, 2026 7:32 AM   Specimen: Blood   Resulted: Jul 21, 2026 1:05 PM"); y -= 16
    cols = [40, 210, 300, 420, 490]
    c.setFont("Helvetica-Bold", 9)
    for x, t in zip(cols, ["Component", "Your Value", "Standard Range", "Flag", "Units"]):
        c.drawString(x, y, t)
    y -= 13
    c.setFont("Helvetica", 9)
    rows = [("Cholesterol, Total", "212", "<200", "High", "mg/dL"),
            ("Triglycerides", "176", "<150", "High", "mg/dL"),
            ("HDL Cholesterol", "38", ">=40", "Low", "mg/dL"),
            ("LDL Cholesterol Calc", "139", "<100", "High", "mg/dL"),
            ("Non-HDL Cholesterol", "174", "<130", "High", "mg/dL")]
    for r in rows:
        for x, t in zip(cols, r):
            c.drawString(x, y, t)
        y -= 13
    c.drawString(40, y, "Performed by: BERKSHIRE VALLEY HEALTH CORE LAB"); y -= 26

    c.setFont("Helvetica-Bold", 11); c.drawString(40, y, "THYROID STIMULATING HORMONE"); y -= 14
    c.setFont("Helvetica", 9)
    c.drawString(40, y, "Collected on Jul 21, 2026 7:32 AM   Specimen: Blood"); y -= 16
    c.setFont("Helvetica-Bold", 9)
    for x, t in zip(cols, ["Component", "Your Value", "Standard Range", "Flag", "Units"]):
        c.drawString(x, y, t)
    y -= 13
    c.setFont("Helvetica", 9)
    for x, t in zip(cols, ("TSH", "2.14", "0.45 - 4.50", "", "uIU/mL")):
        c.drawString(x, y, t)
    y -= 13
    c.drawString(40, y, "Performed by: BERKSHIRE VALLEY HEALTH CORE LAB"); y -= 30

    c.setFont("Helvetica-Bold", 11); c.drawString(40, y, "Vitals from this visit (Jul 21, 2026 7:20 AM)"); y -= 15
    c.setFont("Helvetica", 9)
    for t in ["Blood Pressure 138/86", "Pulse 76", "Temperature 97.9 °F", "Respiratory Rate 14", "SpO2 98%", "Weight 99.3 kg", "BMI 31.4"]:
        c.drawString(52, y, t); y -= 12
    y -= 18
    c.setFont("Helvetica-Bold", 11); c.drawString(40, y, "Allergies as of 10/26/2026"); y -= 14
    c.setFont("Helvetica", 9)
    for t in ["Penicillins - Hives (Moderate)", "Shellfish - Swelling (Severe)"]:
        c.drawString(52, y, t); y -= 12
    y -= 14
    c.setFont("Helvetica-Bold", 11); c.drawString(40, y, "Current Medications"); y -= 14
    c.setFont("Helvetica", 9)
    for t in ["metFORMIN 500 MG tablet - Take 1 tablet by mouth daily with dinner",
              "lisinopril 10 MG tablet - Take 1 tablet by mouth daily",
              "atorvastatin 20 MG tablet - Take 1 tablet by mouth at bedtime"]:
        c.drawString(52, y, t); y -= 12
    footer(1, 2); c.showPage()

    # page 2: consult note
    y = h - 50
    c.setFont("Helvetica-Bold", 14); c.drawString(40, y, "Visit Notes"); y -= 24
    c.setFont("Helvetica-Bold", 10); c.drawString(40, y, "Consult Note - Cardiology"); y -= 14
    c.setFont("Helvetica", 9)
    for t in ["Author: Theodore Brandt, MD   Service: Cardiology", "Date of Service: 10/02/2026 10:15 AM", ""]:
        c.drawString(40, y, t); y -= 12
    body = ["Reason for consult: Elevated blood pressure and dyslipidemia in a 33 year old",
            "with new type 2 diabetes. Referred by Dr. Nguyen (VA primary care).",
            "",
            "History: Intermittent palpitations with exertion for 6 weeks, lasting seconds.",
            "No syncope. Father with myocardial infarction at age 52.",
            "",
            "Exam: BP 134/84 right arm. Regular rhythm. No murmurs, rubs or gallops.",
            "",
            "ECG today: normal sinus rhythm 74, normal intervals, no ST changes.",
            "",
            "Assessment and plan:",
            "1. Hypertension - continue lisinopril; home BP log, goal <130/80.",
            "2. Mixed dyslipidemia with diabetes - start atorvastatin 20 mg nightly.",
            "3. Palpitations - 14-day ambulatory monitor ordered.",
            "Follow up in 3 months.",
            "",
            "Electronically signed by Theodore Brandt, MD on 10/02/2026 at 4:41 PM"]
    for t in body:
        c.drawString(40, y, t); y -= 12
    y -= 20
    c.setFont("Helvetica-Oblique", 8)
    c.drawString(40, y, "MyChart is a registered trademark of its owner. This printout is for personal use.")
    y -= 11
    c.drawString(40, y, "Questions? Message your care team or call the clinic 413-555-0140 Mon-Fri.")
    footer(2, 2); c.showPage()
    c.save()

epic_pdf(os.path.join(OUT, "MyChart_Printout_Hessel_2026.pdf"))


# ---------------- VA Blue Button (text) report ----------------
bb = """------------------------------------------------------------
               MY HEALTHEVET PERSONAL INFORMATION REPORT
                       ** SAMPLE - FICTIONAL DATA **
------------------------------------------------------------
Name: HESSEL, LENARD F
Date of Birth: 04/04/1993
Report Date: 10/28/2026

============================================================
 VA ALLERGIES
============================================================
Allergy Name: PENICILLIN
Date Entered: 03/11/2018
Reaction: HIVES
Allergy Type: DRUG
Location: VA BERKSHIRE HCS
Observed/Historical: HISTORICAL

============================================================
 VA PROBLEM LIST
============================================================
Problem: Type 2 diabetes mellitus without complications (ICD-10-CM E11.9)
Status: ACTIVE
Date Entered: 09/14/2026
Provider: NGUYEN, ROSALIND M

Problem: Essential (primary) hypertension (ICD-10-CM I10)
Status: ACTIVE
Date Entered: 09/14/2026
Provider: NGUYEN, ROSALIND M

============================================================
 VA MEDICATION HISTORY
============================================================
Medication: METFORMIN HCL 500MG TAB
Instructions: TAKE ONE TABLET BY MOUTH DAILY WITH EVENING MEAL
Status: ACTIVE
Last Filled On: 10/12/2026
Rx #: 2810455

Medication: LISINOPRIL 10MG TAB
Instructions: TAKE ONE TABLET BY MOUTH DAILY
Status: ACTIVE
Last Filled On: 10/12/2026
Rx #: 2810456

============================================================
 VA CHEMISTRY/HEMATOLOGY
============================================================
Lab Test: POTASSIUM
Collected Date/Time: 09/28/2026 07:48
Specimen: SERUM
Result: 4.7
Units: mmol/L
Reference Range: 3.5-5.1
Performing Lab: VA BERKSHIRE HCS LAB

Lab Test: CREATININE
Collected Date/Time: 09/28/2026 07:48
Specimen: SERUM
Result: 1.27
Units: mg/dL
Reference Range: 0.70-1.30
Performing Lab: VA BERKSHIRE HCS LAB

============================================================
 VA APPOINTMENTS (FUTURE)
============================================================
Date/Time: 12/15/2026 08:30
Clinic: PITTSFIELD PRIMARY CARE
Status: SCHEDULED

------------------------------------------------------------
Note: My HealtheVet self-entered information is not shown.
------------------------------------------------------------
"""
open(os.path.join(OUT, "VA_BlueButton_HESSEL.txt"), "w").write(bb)

# ---------------- HL7 v2.5.1 ORU^R01 ----------------
hl7 = "\r".join([
    "MSH|^~\\&|LAB|BERKSHIRE_VALLEY_LAB|CPRS4CC|VA|20261020114500||ORU^R01^ORU_R01|MSG000771|P|2.5.1",
    "PID|1||E4471902^^^BVH^MR||HESSEL^LENARD^F||19930404|M",
    "OBR|1|ORD5521|LAB88213|24323-8^Comprehensive metabolic 2000 panel^LN|||20261019073000|||||||||NGUYEN^ROSALIND^M||||||20261019113000|||F",
    "OBX|1|NM|2345-7^Glucose [Mass/volume] in Serum or Plasma^LN||131|mg/dL|70-99|H|||F|||20261019073000||||||||BERKSHIRE VALLEY HEALTH CORE LAB",
    "NTE|1||Fasting status not documented.",
    "OBX|2|NM|2160-0^Creatinine [Mass/volume] in Serum or Plasma^LN||1.29|mg/dL|0.70-1.30|N|||F|||20261019073000||||||||BERKSHIRE VALLEY HEALTH CORE LAB",
    "OBX|3|NM|2823-3^Potassium [Moles/volume] in Serum or Plasma^LN||4.6|mmol/L|3.5-5.1|N|||F|||20261019073000||||||||BERKSHIRE VALLEY HEALTH CORE LAB",
    "OBX|4|NM|1742-6^Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma^LN||58|U/L|7-56|H|||F|||20261019073000||||||||BERKSHIRE VALLEY HEALTH CORE LAB",
    "OBR|2|ORD5530|RAD4410|30704-1^US Abdomen^LN|||20261019093000|||||||||NGUYEN^ROSALIND^M||||||20261019150000|||F",
    "OBX|1|TX|18782-3^Radiology Study observation (narrative)^LN||ULTRASOUND ABDOMEN COMPLETE~Indication: elevated ALT.~Findings: Liver is mildly echogenic consistent with hepatic steatosis. No focal lesion. Gallbladder normal. CBD 3 mm.~IMPRESSION: Mild hepatic steatosis.||||||F|||20261019093000||||||||BERKSHIRE VALLEY IMAGING",
    "ZXT|1|internal routing code 44-B|do not display",
    "",
])
open(os.path.join(OUT, "BVH_Lab_ORU_R01.hl7"), "w").write(hl7)
print("ok")
