// bun test whatif.test.js — hand-checked cases on synthetic courses, then sanity checks on the samples.
import { test, expect } from "bun:test";
const fs = require("node:fs");
const C = require("./calc.js"), W = require("./whatif.js");
const XLSX = require("./vendor/xlsx.full.min.js");

// One synthetic course; costs per seat by pricing context (B baseline, H hybrid, S scenario).
const course = (o = {}) => Object.assign({ code: "X1", title: "", status: "demand", aqf: "Certificate III", dur: 12, cr: 1, seats: 12, inflight: 0,
  cost: { B: { idx: 0, fix: 1200, comp: 0 }, H: { idx: 0, fix: 1200, comp: 0 }, S: { idx: 0, fix: 1200, comp: 0 } } }, o);
const prep = (courses, s = {}) => ({ scn: W.normalise(Object.assign({}, s, { forecast: Object.assign({ years: 2, indexPct: 0, inFlight: false }, s.forecast) })), courses, uncosted: 0 });
const go = (courses, s) => W.run(null, null, { prepared: prep(courses, s) });

test("claims spread evenly over the course; tail past the horizon is end liability", () => {
  const r = go([course()]); // 1 seat/month, $1,200 over 12 months
  expect(r.years[0].new_commitments).toBeCloseTo(14400);
  expect(r.years[0].cash).toBeCloseTo(100 * 78);        // Σ (12 − m) months × $100
  expect(r.totals.end_liability).toBeCloseTo(100 * 66);
  expect(r.years[1].cash).toBeCloseTo(14400 * 2 - 7800 - 6600);
});

test("a course-adjustment cut only reprices accounts opened after it takes effect", () => {
  const cost = { B: { idx: 100, fix: 0, comp: 0 }, H: { idx: 100, fix: 0, comp: 0 }, S: { idx: 90, fix: 0, comp: 0 } };
  const r = go([course({ dur: 24, cost })], { effectiveFy: 1 });
  expect(r.years[0].new_commitments).toBeCloseTo(1200);
  expect(r.years[1].new_commitments).toBeCloseTo(1080);
  // year 1: year-0 cohorts keep $100 (600), year-1 cohorts pay $90 for Σ(24 − m) = 78 months
  expect(r.years[1].cash).toBeCloseTo(600 + 78 * 90 / 24);
});

test("claim-time indexation is the uplift on accounts opened earlier", () => {
  const cost = { B: { idx: 100, fix: 0, comp: 0 }, H: { idx: 100, fix: 0, comp: 0 }, S: { idx: 100, fix: 0, comp: 0 } };
  const r = go([course({ dur: 24, cost })], { forecast: { indexPct: 10 } });
  expect(r.years[1].new_commitments).toBeCloseTo(1320);
  expect(r.years[1].index_uplift).toBeCloseTo(60);
  expect(r.years[0].index_uplift).toBeCloseTo(0);
});

test("completion payment is committed up front and paid at the end", () => {
  const cost = { B: { idx: 0, fix: 0, comp: 400 }, H: { idx: 0, fix: 0, comp: 400 }, S: { idx: 0, fix: 0, comp: 400 } };
  const r = go([course({ dur: 6, cr: 0.5, cost })]); // $400 payment × 50% completion = $200 expected per seat
  expect(r.years[0].new_commitments).toBeCloseTo(12 * 200);
  expect(r.years[0].cash).toBeCloseTo(6 * 200);       // cohorts Jul..Dec finish inside the year
  expect(r.years[0].completions_paid).toBeCloseTo(3);
});

test("a trigger fires when committed crosses the threshold and cuts intake after the notice", () => {
  const c = course({ dur: 1, seats: 120, cost: { B: { idx: 0, fix: 100, comp: 0 }, H: { idx: 0, fix: 100, comp: 0 }, S: { idx: 0, fix: 100, comp: 0 } } });
  const trig = { name: "half", atPct: 50, action: "scale_intake", scope: "all", amountPct: 50, noticeMonths: 1 };
  const r = go([c], { budget: 12000, triggers: [trig] });
  expect(r.triggers_fired[0]).toMatchObject({ name: "half", fy: "2026-27", month: "Dec 2026", effective: "Feb 2027" });
  expect(r.years[0].new_commitments).toBeCloseTo(7 * 1000 + 5 * 500);
  expect(r.trigger_savings.all).toBeCloseTo(2 * 2500);   // fires again in year 2 (resets each FY)
  expect(go([c], { budget: 12000, triggers: [Object.assign({}, trig, { scope: "managed" })] }).years[0].new_commitments).toBeCloseTo(12000);
  expect(go([c], { budget: 12000, triggers: [Object.assign({}, trig, { action: "pause" })] }).years[0].new_commitments).toBeCloseTo(7000);
  expect(go([c], { budget: 10000 }).years[0].exhaust_month).toBe("May 2027"); // 11th month takes it past $10,000
});

test("Monte Carlo is reproducible from its seed and ordered", () => {
  const p = prep([course({ inflight: 12 }), course({ code: "X2", status: "managed", inflight: 12 })], { uncertainty: { runs: 200, seed: 7 } });
  const a = W.monteCarlo(null, null, { prepared: p }), b = W.monteCarlo(null, null, { prepared: p });
  expect(a).toEqual(b);
  for (const y of a.years) { expect(y.cash.p10).toBeLessThanOrEqual(y.cash.p50); expect(y.cash.p50).toBeLessThanOrEqual(y.cash.p90); }
  expect(a.years[0].p_over_budget).toBeGreaterThan(0.2);
  expect(a.years[0].p_over_budget).toBeLessThan(0.8);
});

// ---------- samples ----------
const dir = import.meta.dir;
const read = (f) => { const wb = XLSX.read(fs.readFileSync(dir + "/samples/" + f), { type: "buffer", raw: true }); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false }); };
const glob = (f, n) => JSON.parse(fs.readFileSync(dir + "/data/" + f, "utf8").replace(`window.${n} = `, "").replace(/;\s*$/, ""));
const ur = read("units_2019.csv"), cr = read("claims_demo.csv");
const data = { rates: glob("rates.js", "SA_RATES"), stl: glob("stl.js", "SA_STL"), units: C.buildUnits(ur, C.mapHeaders(Object.keys(ur[0]), "units").map).units,
  claims: C.remap(cr, C.mapHeaders(Object.keys(cr[0]), "claims").map), profiles: read("course_profiles_demo.csv"), outcomes: read("course_outcomes_demo.csv") };

test("samples: baseline year 0 commitments equal the default budget and today's spend", () => {
  const r = W.run(data, { name: "base" });
  const priced = C.priceRows(C.makeContext(data.rates), data.units, data.claims).totals;
  expect(r.budget).toBeCloseTo(r.years[0].new_commitments, 0);
  expect(r.years[0].cash_inflight).toBeGreaterThan(0);
  expect(Math.abs(r.budget - priced.govt) / priced.govt).toBeLessThan(0.02); // same claims, history-costed seats
});

test("samples: a cut from FY+1 leaves year 0 alone; sensitivity points the right way", () => {
  const base = W.run(data, {}), cut = W.run(data, { levers: { adjMultiplier: 0.9 }, effectiveFy: 1 });
  expect(cut.years[0].new_commitments).toBeCloseTo(base.years[0].new_commitments, 2);
  expect(cut.years[1].new_commitments).toBeLessThan(base.years[1].new_commitments);
  const s = W.sensitivity(data, {});
  const row = (n) => s.rows.find((r) => r.lever === n);
  for (const n of ["Course adjustments", "Intake volume", "Future indexation", "Indexation this year (extra)", "RPL payment (Cert III+)"]) {
    expect(row(n).delta_high).toBeGreaterThan(0);
    expect(row(n).delta_low).toBeLessThan(0);
  }
});

test("compare runs each scenario; optimised seat source needs seats", () => {
  const out = W.compare(data, [{ name: "a" }, { name: "b", forecast: { growthPct: 5 } }], { mc: true, runs: 50 });
  expect(out.map((o) => o.name)).toEqual(["a", "b"]);
  expect(out[1].result.totals.cash).toBeGreaterThan(out[0].result.totals.cash);
  expect(out[0].mc.totals.cash.p50).toBeGreaterThan(0);
  expect(() => W.run(data, { name: "o", seats: "optimised" })).toThrow(/optimiser/);
});
