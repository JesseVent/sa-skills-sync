// bun test sim.test.js
import { test, expect } from "bun:test";
const S = require("./sim.js");
const C = require("./calc.js");
const highs = await require("highs")();

// A course row as buildCourseTable makes it; unit_cost is the full seat cost when completion_payment = 0.
const mk = (code, o = {}) => ({
  course_code: code, title: code, aqf: "Certificate III", lists: "TPL", status: "demand", stl_status: "demand",
  rto_limit: null, limit_group: null, rto_count: null, baseline_seats: 0, unit_cost: 100, completion_payment: 0,
  completion_rate: 0.5, employment_rate: 0.5, priority_weight: 1, min_seats: 0, max_seats: null, budget_cap: null,
  planned_seats: null, cost_override: NaN, source: "test", flags: [], ...o,
});
const onlyCompletions = { places: 0, completions: 1, employment: 0, priority: 0 };
const plan = (config, courses = {}) => ({ config, courses });

// A: 0.5 completions per $100 (best), C: 0.9 per $200, B: 0.2 per $50 (worst)
const knap = [
  mk("A", { unit_cost: 100, completion_rate: 0.5, max_seats: 5 }),
  mk("B", { unit_cost: 50, completion_rate: 0.2, max_seats: 5 }),
  mk("C", { unit_cost: 200, completion_rate: 0.9, max_seats: 5 }),
];

test("knapsack: best completions for a fixed budget", () => {
  const r = S.optimise(knap, plan({ budget: 1000, weights: onlyCompletions }), highs);
  expect(r.status).toBe("Optimal");
  expect(r.optimised.completions).toBeCloseTo(4.7, 9);   // e.g. A5 + C2 + B2 = $1,000
  expect(r.optimised.spend).toBeLessThanOrEqual(1000);
  expect(r.courses.find((c) => c.course_code === "A").seats).toBeGreaterThanOrEqual(4);
});

test("budget shadow price = value per $ of the marginal course (LP relaxation)", () => {
  const r = S.optimise(knap, plan({ budget: 1000, weights: onlyCompletions }), highs);
  // Relaxation: A 5 seats ($500), then C fractional ($500) -> marginal 0.9 / 200 per $
  expect(r.shadow.value_per_million).toBeCloseTo((0.9 / 200) * 1e6, 4);
});

test("managed cap = RTO limit × RTO count, and it binds", () => {
  const t = [mk("M", { status: "managed", rto_limit: 10, rto_count: 3, max_seats: 100, unit_cost: 10 })];
  const r = S.optimise(t, plan({ budget: 1e6 }), highs);
  expect(r.courses[0].seats).toBe(30);
  expect(r.courses[0].binding).toBe("managed cap");
});

test("managed with unknown RTO count uses the default and is flagged", () => {
  const t = [mk("M", { status: "managed", rto_limit: 10, max_seats: 100, unit_cost: 10 })];
  const r = S.optimise(t, plan({ budget: 1e6, defaultRtoCount: 2 }), highs);
  expect(r.courses[0].seats).toBe(20);
  expect(r.courses[0].flags).toContain("RTO count unknown");
});

test("off-list courses get no seats; status override switches them on", () => {
  const t = [mk("X", { status: "off", max_seats: 10 }), mk("Y", { max_seats: 10 })];
  expect(S.optimise(t, plan({ budget: 1e6 }), highs).courses[0].seats).toBe(0);
  expect(S.optimise(t, plan({ budget: 1e6 }, { X: { status: "demand" } }), highs).courses[0].seats).toBe(10);
  expect(() => S.optimise(t, plan({}, { X: { status: "maybe" } }), highs)).toThrow("status must be");
});

test("a shared managed limit caps both versions of a course together", () => {
  const t = [
    mk("CUA51120", { status: "managed", rto_limit: 10, rto_count: 1, limit_group: "CUA51120", max_seats: 50, unit_cost: 10 }),
    mk("CUA51125", { status: "managed", rto_limit: 10, rto_count: 1, limit_group: "CUA51120", max_seats: 50, unit_cost: 10 }),
  ];
  const r = S.optimise(t, plan({ budget: 1e6 }), highs);
  expect(r.courses[0].seats + r.courses[1].seats).toBe(10);
});

test("min_cost (value for money): keep baseline completions for less", () => {
  const t = [
    mk("CHEAP", { unit_cost: 100, completion_rate: 0.8, baseline_seats: 10, max_seats: 40 }),
    mk("DEAR", { unit_cost: 300, completion_rate: 0.4, baseline_seats: 10 }),
  ];
  const r = S.optimise(t, plan({ mode: "min_cost", targets: { completions: 100 } }), highs);
  expect(r.status).toBe("Optimal");
  expect(r.optimised.completions).toBeGreaterThanOrEqual(r.baseline.completions - 1e-9);   // 12 completions
  expect(r.optimised.spend).toBeLessThan(r.baseline.spend);                                // $4,000 -> $1,500
  expect(r.optimised.spend).toBe(1500);
  expect(r.shadow.cost_per_extra_completions).toBeCloseTo(125, 6);                          // $100 / 0.8
});

test("AQF share constraint", () => {
  const t = [mk("D1", { aqf: "Diploma", unit_cost: 50, max_seats: 100 }), mk("C3", { unit_cost: 100, max_seats: 100 })];
  const r = S.optimise(t, plan({ budget: 5000, weights: { places: 1, completions: 0, employment: 0, priority: 0 }, aqfShares: { "Certificate III": { min: 50 } } }), highs);
  const [d, c] = r.courses.map((x) => x.seats);
  expect(c).toBeGreaterThanOrEqual(d);          // at least half the seats are Cert III
  expect(d + c).toBe(66);                       // 33 × $50 + 33 × $100 = $4,950
});

test("infeasible models say why", () => {
  const t = [mk("A", { max_seats: 5, min_seats: 10 })];
  const r = S.optimise(t, plan({ budget: 1e6 }), highs);
  expect(r.status).toBe("Infeasible");
  expect(r.message).toContain("A: min seats 10 > max 5");
  const r2 = S.optimise([mk("A", { min_seats: 10, max_seats: 20 })], plan({ budget: 500 }), highs);
  expect(r2.message).toContain("> budget");
});

test("nothing to optimise returns Empty instead of an invalid model", () => {
  const r = S.optimise([mk("X", { status: "off" })], plan({ budget: 1e6 }), highs);
  expect(r.status).toBe("Empty");
});

test("scales: 2,000 courses solve quickly", () => {
  const t = Array.from({ length: 2000 }, (_, i) => mk("C" + i, { unit_cost: 500 + (i * 37) % 3000, completion_rate: 0.3 + ((i * 13) % 60) / 100,
    baseline_seats: 20 + (i % 50), status: i % 10 === 0 ? "managed" : "demand", rto_limit: 15, rto_count: 1 + (i % 4) }));
  const t0 = performance.now();
  const r = S.optimise(t, plan({ weights: onlyCompletions }), highs);   // budget defaults to baseline spend
  expect(r.status).toBe("Optimal");
  expect(r.optimised.spend).toBeLessThanOrEqual(r.baseline.spend + 1e-6);
  expect(r.optimised.completions).toBeGreaterThan(r.baseline.completions);
  expect(performance.now() - t0).toBeLessThan(15000);
});

test("manual plan: planned seats are evaluated and cap breaches listed", () => {
  const t = [mk("M", { status: "managed", rto_limit: 10, rto_count: 2, unit_cost: 100, baseline_seats: 5 })];
  const r = S.optimise(t, plan({ budget: 1e6 }, { M: { planned_seats: 25 } }), highs);
  expect(r.planned.spend).toBe(2500);
  expect(r.plannedViolations[0]).toContain("managed cap");
});

test("course table from real STL + rates + priced claims", async () => {
  globalThis.window = {};
  new Function(await Bun.file(import.meta.dir + "/data/rates.js").text())();
  new Function(await Bun.file(import.meta.dir + "/data/stl.js").text())();
  const R = window.SA_RATES, STL = window.SA_STL;
  const units = { U1: { foe: "010101", hours: 20 }, U2: { foe: "010101", hours: 10 } };
  const claims = [
    { student_id: "S1", provider_id: "RTO1", course_code: "CHC32015", unit_code: "U1", postcode: "5000", qualification_issued: "Y" },
    { student_id: "S1", provider_id: "RTO1", course_code: "CHC32015", unit_code: "U2", postcode: "5000", qualification_issued: "Y" },
    { student_id: "S2", provider_id: "RTO2", course_code: "CHC32015", unit_code: "U1", postcode: "5000" },
  ];
  const priced = C.priceRows(C.makeContext(R), units, claims);
  const table = S.buildCourseTable({ rates: R, stl: STL, units, priced,
    profiles: [{ course_code: "AHC30122", unit_code: "U1" }], outcomes: [{ course_code: "CHC32015", employment_rate: "70%" }] });
  const chc = table.find((r) => r.course_code === "CHC32015");
  expect(chc.status).toBe("managed");
  expect(chc.rto_limit).toBe(50);
  expect(chc.rto_count).toBe(2);
  expect(chc.baseline_seats).toBe(2);
  expect(chc.completion_rate).toBe(0.5);
  expect(chc.employment_rate).toBe(0.7);
  expect(chc.unit_cost).toBeCloseTo(priced.totals.subsidy / 2, 6);
  const [row] = S.resolve([chc], {}, {});
  expect(row.cost_per_seat).toBeCloseTo(priced.totals.subsidy / 2 + 200 * 0.5, 6);   // + completion × rate
  expect(row.managed_cap).toBe(100);                                                 // 50 × 2 RTOs
  const ahc = table.find((r) => r.course_code === "AHC30122");
  expect(ahc.source).toBe("profile");
  expect(ahc.unit_cost).toBeCloseTo((10.9 * R.indexFactor - 2.75) * 20, 2);
  expect(table.find((r) => r.course_code === "SIT40521").status).toBe("managed");     // every STL course is present
  expect(table.length).toBeGreaterThanOrEqual(Object.keys(STL.courses).length);
});

test("a course whose claim rows all fail gets no cost (never $0) and can't take seats", async () => {
  const priced = { results: [{ course_code: "ZZZ1", student_id: "S1", volume: 1, ok: false, subsidy: 0, concession_reimb: 0 }] };
  const R = { courses: {}, completion: {}, aqfReduction: {}, indexFactor: 1, concession: { minFee: 0.5, maxReimb: 1.35 } };
  const [row] = S.buildCourseTable({ rates: R, stl: null, priced });
  expect(row.unit_cost).toBeNaN();
  expect(row.flags.join()).toContain("not priced");
  const r = S.optimise([row], { config: { budget: 1e6 } }, highs);
  expect(r.status).toBe("Empty");
});

test("floorPct guardrail keeps every course at ≥ X% of baseline (capped by its max)", () => {
  const t = [mk("GOOD", { unit_cost: 100, completion_rate: 0.9, baseline_seats: 10 }), mk("POOR", { unit_cost: 100, completion_rate: 0.1, baseline_seats: 10 })];
  const free = S.optimise(t, plan({ weights: onlyCompletions }), highs);
  expect(free.courses[1].seats).toBe(8);                  // budget = 20 seats; GOOD capped at 12 (20% headroom)
  const kept = S.optimise(t, plan({ weights: onlyCompletions, floorPct: 90, headroomPct: 100 }), highs);
  expect(kept.courses[1].seats).toBe(9);                   // POOR can't drop below 90% of 10
  expect(kept.courses[0].seats).toBe(11);
});
