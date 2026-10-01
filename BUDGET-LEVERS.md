# Training Fee Framework v5.0: budget levers and gaps

A review of what the [Training Fee Framework v5.0](https://skills.sa.gov.au/assets/uploads/downloads/supportingSkilledCareers/Training-Fee-Framework-v5.0.pdf) (training accounts created from 1 July 2026) gives you for keeping subsidy spend inside a budget, and what it leaves out. Unofficial; check against the Funded Activities Agreement.

**Short answer:** the Framework sets the unit price. It has one volume control (Managed Course Limits). Most of what drives total spend sits in other documents.

The Framework PDF itself is 9 pages. Base rates, course adjustments and postcode loadings are in Attachments 1–3, which `fetch.py` downloads separately.

## Levers in the Framework

| Lever | How it works | When the rate locks | Budget effect |
|---|---|---|---|
| Base rate + indexation (Item 3) | Hourly rate by field of education, indexed yearly (2.04% for 2026-27) | **When the claim is paid** | Broad, affects everything |
| Location loading (Item 4) | 0–40% by delivery-location remoteness | Each unit | Regional mix |
| AQF reduction (Item 5) | Deducts an assumed student fee, $0.50–$3.25/hr | Account creation | Moderate |
| **Course adjustment (Item 6)** | Minister sets a % per course | Account creation | **Most targeted price lever**; changed 6 times in v4.1–4.6 |
| RPL adjustment (Item 7) | Unfunded for Cert I/II, skill sets, bridging; 50% for Cert III+ | Each unit | Limits RPL-heavy delivery |
| Completion payment (Item 8) | $0 / $200 / $400 by course level | On completion | Small |
| Student fee settings (Items 9–11) | $0.50/hr minimum fee, fee exemptions, concession reimbursement capped at $1.35/hr | Account creation | Small, open-ended |
| Payment caps (Items 12–14) | Max 3 attempts per unit, 5 bridging units; nothing for employer-delivered or on-job training | — | Stops leakage |
| **Managed Course Limits (Item 16)** | Caps training accounts per provider per course. Can be cut mid-year, or the course removed, "subject to budget availability" | — | **The only volume control** |

## Gaps and risks

1. **Price locks at different times.** Base rate and indexation apply at claim; AQF reduction and course adjustment lock at account creation.
   - Accounts opened in earlier years are paid at today's indexed rate, so budget needs an accrual for the uplift.
   - Cutting a course adjustment only affects new accounts; existing enrolments keep the old rate until they finish.
2. **Volume control is headcount only, and only for listed courses.** No dollar envelope per provider or course, no overall ceiling. Courses off the Managed Course List are uncapped.
3. **No trigger rules.** "Subject to budget availability" is discretionary: no thresholds (e.g. "at 80% committed, apply limits"). Notice periods are left to the provider agreement.
4. **The biggest drivers are set elsewhere:** eligibility for a training account, which courses are funded (Subsidised Training List), nominal/payment hours per course (these multiply every rate), provider allocations, compliance/audit/clawback, data-quality rejection rules, Commonwealth co-funding split. See the Skills Agreement, STL, Managed Course List and contract guidelines.
5. **No commitment tracking.** Nothing ties the liability created when an account opens to a forecast of what it costs when claims arrive.

## For a complete lever set

Use the Framework alongside Attachments 1–3, the STL (for hours), the Managed Course List, the Skills Agreement clauses on notice, variation and recovery, and a liability model that costs each open account at its locked course adjustment with future-year indexation.

The most useful missing rule: tie Managed Course Limit and course adjustment changes to budget-consumption thresholds. Today both are applied case by case with no stated triggers.

The calculator's **Budget & scenarios** and **Courses & optimiser** tabs model most of the levers above (indexation, AQF reductions, completion payments, loadings, RPL %, concession limits, course adjustment overrides, managed caps). The **What-if** tab (and the MCP `whatif_*` tools) covers gaps 1, 3 and 5 as a model: it prices each claim by when its rate locks, tracks commitments against cash and the indexation uplift over several years, simulates budget-consumption triggers with notice periods, and adds Monte Carlo ranges. It's a forecast, not a rule. The Framework still has no stated triggers.
