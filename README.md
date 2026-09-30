# sa-skills-sync

Pulls the current South Australian VET subsidy documents and rates, and prices training with an offline calculator.

> Unofficial. Not published or endorsed by Skills SA / the Department for Education. Check results against the official Subsidy Calculator and your Funded Activities Agreement.

## Quick start

```bash
python3 fetch.py                 # download the latest docs, rebuild data/*.csv and data/rates.js
open calculator.html             # offline calculator: no server, nothing uploaded
bun test calc.test.js            # calculation tests
python3 fetch.py --self-test     # parser tests (no network)
```

`fetch.py` needs Python 3.9+ and `pdftotext` (poppler: `brew install poppler`). There are no Python packages to install.

## What `fetch.py` gets

| Source | Output |
|---|---|
| [Training Fee Framework](https://providers.skills.sa.gov.au/tools/training-fee-framework): the latest version plus Attachments 1–3 | `docs/*.pdf`, `data/base_rates_v*.csv`, `data/course_adjustments_v*.csv`, `data/postcode_loading_v*.csv` |
| [Subsidised Training List](https://providers.skills.sa.gov.au/subsidised-training-list): the current version's TPL, VSS list, STAL, and Managed Course List | `docs/*.pdf` |
| [TAFE SA Fee Free courses](https://www.tafesa.edu.au/courses/fee-free-tafe-courses) | `data/tafe_fee_free.csv` (concession / subsidised / full-fee ranges) |
| Framework tables: indexation, AQF reduction, completion, concession | `data/rates.js` (used by the calculator) |

Each run prints **NEW / CHANGED / unchanged** for every document, and `manifest.json` records sha256 hashes. Version numbers are scraped from the pages, not hard-coded, so new releases are picked up automatically.

## Calculator (`calculator.html`)

- **Estimate**: one course at one postcode for a list of units, including student fee and concession.
- **Bulk claims**: upload unit data and claim rows (CSV or XLSX) to get per-row pricing, an issues list, summaries by AQF level, location and course, and an XLSX export.
- **Budget & scenarios**: reprice the loaded rows under changed levers (indexation, volume, AQF reductions, completion payments, loadings, RPL %, concession limits, course adjustment overrides). Shows the change against baseline and a budget cap meter, and scenarios save and load as JSON.

### Uploads

| File | Required columns | Optional |
|---|---|---|
| Units | `unit_code`, `foe_code`, `payment_hours` | `unit_name` |
| Claims / forecast | `course_code`, `unit_code`, `postcode` | `student_id`, `suburb`, `result_code`, `hours`, `concession`, `fee_exempt`, `std_fee_per_hour`, `qualification_issued`, `volume`, `aqf_level` |

Headers are matched loosely (e.g. `Nominal Hours`, `USI`, `Outcome`), and anything unmatched can be mapped in the UI. Blank templates are in `templates/`. **Keep real unit and claims data out of this repo**: `*.xlsx` and `uploads/` are git-ignored.

`samples/` contains 2019 unit data (from the old public Subsidy Calculator) and 1,000 synthetic claim rows with four deliberately bad ones. They're for trying the tool out, not for real pricing.

### Formula (Training Fee Framework v5.0 §2–11)

```
per hour = max(0, base[FOE] × indexation × (1 + location loading) − AQF reduction)
subsidy  = per hour × course adjustment % × payment hours × RPL factor × volume      (rounded to cents per row)
+ completion payment once per student + course when the qualification is issued
+ concession reimbursement = min(max(std fee − $0.50, 0), $1.35) × hours
```

RPL (result 51/52) pays 50% for Certificate III and above, and nothing for Certificate I/II, skill sets and bridging courses.

### Assumptions to confirm

- Fee-exempt (guardianship) students: the AQF reduction is not deducted, so government pays it.
- Indexation is one compounded factor with no rounding between years.
- A completion payment is course-level, so it's paid even if that student's unit rows fail to price. Those cases are flagged for review.
- The AQF level is derived from the course name. Courses it can't classify are flagged and need an `aqf_level` column; the tool doesn't guess.

## Credits

Rates and documents © Government of South Australia (Skills SA). XLSX support by [SheetJS](https://sheetjs.com) Community Edition 0.20.3 (Apache-2.0), vendored in `vendor/`.
