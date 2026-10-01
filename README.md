# sa-skills-sync

Pulls the current South Australian VET subsidy documents and rates, prices training with an offline calculator, and optimises course seat allocations. Claude can drive the optimiser through a local MCP tool.

> Unofficial. Not published or endorsed by Skills SA / the Department for Education. Check results against the official Subsidy Calculator and your Funded Activities Agreement.

## Quick start

```bash
python3 fetch.py                 # download the latest docs, rebuild data/*.csv and data/rates.js
open calculator.html             # offline calculator: no server, nothing uploaded
bun install                      # solver + MCP SDK (for tests and the Claude tool)
bun test                         # calculator, optimiser and MCP tests
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
| STL course status: Demand Driven / Managed per list, and per-RTO limits from the Managed Course List | `data/stl_courses.csv`, `data/stl.js` |

Each run prints **NEW / CHANGED / unchanged** for every document, and `manifest.json` records sha256 hashes. Version numbers are scraped from the pages, not hard-coded, so new releases are picked up automatically.

## Calculator (`calculator.html`)

- **Estimate**: one course at one postcode for a list of units, including student fee and concession.
- **Bulk claims**: upload unit data and claim rows (CSV or XLSX) to get per-row pricing, an issues list, summaries by AQF level, location and course, and an XLSX export.
- **Budget & scenarios**: reprice the loaded rows under changed levers (indexation, volume, AQF reductions, completion payments, loadings, RPL %, concession limits, course adjustment overrides). Shows the change against baseline and a budget cap meter, and scenarios save and load as JSON.

- **Courses & optimiser**: every STL course with its status (demand-driven / managed / off-list), managed cap (**per-RTO limit × RTO count**), baseline seats, cost per seat and outcome rates. Edit any course, then **Optimise** to choose integer seats per course with [HiGHS](https://highs.dev):
  - *Best outcome for the budget*: maximise a weighted blend of places, completions, employment outcomes and priority places.
  - *Value for money*: the cheapest allocation that keeps chosen outcomes at ≥ X% of baseline.
  - Guardrails: max growth per course, a floor (% of baseline), AQF-mix shares, per-course min/max seats and budget caps, and shared limits for superseded/new course versions.
  - Reports the change against baseline, which constraints bind, and shadow prices (outcome per extra $1M, or marginal cost per extra completion).

### Uploads

| File | Required columns | Optional |
|---|---|---|
| Units | `unit_code`, `foe_code`, `payment_hours` | `unit_name` |
| Claims / forecast | `course_code`, `unit_code`, `postcode` | `student_id`, `provider_id` (RTO counts for managed caps), `suburb`, `result_code`, `hours`, `concession`, `fee_exempt`, `std_fee_per_hour`, `qualification_issued`, `volume`, `aqf_level` |

| Course profiles | `course_code`, `unit_code` | `hours`: costs courses with no claims history |
| Course outcomes | `course_code` | `completion_rate`, `employment_rate` (0–1 or %), `priority_weight` |

Headers are matched loosely (e.g. `Nominal Hours`, `USI`, `Outcome`), and anything unmatched can be mapped in the UI. Blank templates are in `templates/`. **Keep real unit and claims data out of this repo**: `*.xlsx` and `uploads/` are git-ignored.

`samples/` contains 2019 unit data (from the old public Subsidy Calculator) plus **synthetic** claims (454 students, 15 RTOs, four deliberately bad rows), course outcomes and course profiles. They're for trying the tools out, not for real pricing or decisions.

## Let Claude drive the optimiser (local MCP tool)

```bash
bun install
claude mcp add sa-sim -- bun "$PWD/mcp.js"          # Claude Code
```

For Claude Desktop, add this to `claude_desktop_config.json`:
```json
{ "mcpServers": { "sa-sim": { "command": "bun", "args": ["/path/to/sa-skills-sync/mcp.js"] } } }
```

**No npm / can't `bun install`?** Use the prebuilt bundle in `dist/mcp.js`. It has the MCP SDK, zod and HiGHS baked in, so a plain clone runs with `node` or `bun` and needs no `node_modules`:
```bash
claude mcp add sa-sim -- node "$PWD/dist/mcp.js"     # or: bun "$PWD/dist/mcp.js"
```
After you change `mcp.js`, `calc.js` or `sim.js`, run `bun run build` to regenerate it. `bun run test` also checks the bundle.

Then ask, for example: *"Load the samples, take CHC32015 off the list, keep every course at ≥ 50% of its current seats, and maximise completions and employment within the current budget. Save it as 'option-a' and compare it with a value-for-money plan that holds completions at 100%."*

The tools are `load_data`, `list_courses`, `update_courses`, `set_objective`, `optimise`, `simulate`, `save_plan`, `load_plan`, `list_plans`, `compare_plans` and `export_plan`. The server runs on your machine and reads the files you point it at. It returns **course-level aggregates only**, never student rows, and writes only to `plans/` and `exports/` (both git-ignored). Claude translates goals into constraints and explains the results, and the solver does the maths. Plans saved by Claude open in the browser's *Courses & optimiser* tab and vice versa.

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
- Optimiser cost per seat = unit cost (subsidy + concession, from priced claims or a profile) + completion payment × completion rate. Missing outcome rates use configurable defaults and are flagged.
- A course's status comes from the TPL first, then the STAL, then the VSS list. Claims don't distinguish training-contract enrolments yet.
- The AQF level is derived from the course name. Courses it can't classify are flagged and need an `aqf_level` column; the tool doesn't guess.

## Credits

Rates and documents © Government of South Australia (Skills SA). XLSX support by [SheetJS](https://sheetjs.com) Community Edition 0.20.3 (Apache-2.0) and optimisation by [HiGHS](https://highs.dev) 1.15.3 (MIT, [highs-js](https://github.com/lovasoa/highs-js)), both vendored in `vendor/`. The HiGHS wasm is base64-embedded (`vendor/highs-wasm.js`) and passed through Emscripten's `instantiateWasm` hook, so the page works from `file://`.
