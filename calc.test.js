// bun test calc.test.js
import { test, expect } from "bun:test";
const C = require("./calc.js");

globalThis.window = {};
new Function(await Bun.file(import.meta.dir + "/data/rates.js").text())();
const R = window.SA_RATES;
const ctx = C.makeContext(R);
const units = { U1: { foe: "010101", hours: 20, name: "maths unit" } };
const row = (o) => ({ course_code: "CHC32015", unit_code: "U1", postcode: "5000", ...o });
const pc20 = Object.keys(R.postcodes).find((k) => R.postcodes[k].every((r) => r[3] === 20));
const base = R.base["010101"][1];

test("framework constants loaded from v5.0", () => {
  expect(R.aqfReduction["Certificate III"]).toBe(2.75);
  expect(R.completion.Diploma).toBe(400);
  expect(R.indexFactor).toBeCloseTo(1.022 * 1.021 * 1.019 * 1.0204, 12);
  // Framework Table 2 categories (guards the wrapped "Moderately Accessible" label in Att 3)
  const labels = new Set(Object.values(R.postcodes).flat().map((r) => r[2] + "=" + r[3]));
  expect([...labels].sort()).toEqual(["Accessible Regional=10", "Highly Accessible Metro=0", "Highly Accessible Regional=0",
    "Moderately Accessible Regional=20", "Remote Regional=30", "Very Remote Regional=40"]);
});

test("worked example: Cert III, FOE 010101, 20h, metro and 20% regional", () => {
  expect(base).toBe(10.9);
  const metro = C.priceRow(ctx, units, row());
  expect(metro.errors).toEqual([]);
  expect(metro.subsidy).toBeCloseTo((10.9 * R.indexFactor - 2.75) * 20, 2);
  expect(metro.subsidy.toFixed(2)).toBe("181.53");
  const reg = C.priceRow(ctx, units, row({ postcode: pc20 }));
  expect(reg.subsidy.toFixed(2)).toBe("228.83");
});

test("course adjustment, hours override and volume scale the subsidy", () => {
  const c = C.makeContext(R, { courseAdj: { CHC32015: 95 } });
  const r = C.priceRow(c, units, row({ hours: 10, volume: 3 }));
  expect(r.subsidy).toBeCloseTo((10.9 * R.indexFactor - 2.75) * 0.95 * 10 * 3, 2);
});

test("RPL: 50% for Cert III+, nothing for Cert II and skill sets", () => {
  const full = C.priceRow(ctx, units, row()).subsidy;
  expect(C.priceRow(ctx, units, row({ result_code: "51" })).subsidy).toBeCloseTo(full / 2, 2);
  const cert2 = Object.keys(R.courses).find((k) => C.classifyAqf(k, R.courses[k][0]) === "Certificate II");
  expect(C.priceRow(ctx, units, row({ course_code: cert2 })).subsidy).toBeGreaterThan(0);
  expect(C.priceRow(ctx, units, row({ course_code: cert2, result_code: "52" })).subsidy).toBe(0);
});

test("concession reimbursement matches Framework Table 5 examples A-E", () => {
  const perHour = (fee) => C.priceRow(ctx, units, row({ concession: "Y", std_fee_per_hour: fee })).concession_reimb / 20;
  expect(perHour(0.5)).toBeCloseTo(0, 2);
  expect(perHour(0.8)).toBeCloseTo(0.3, 2);
  expect(perHour(1.85)).toBeCloseTo(1.35, 2);
  expect(perHour(2.5)).toBeCloseTo(1.35, 2);
  expect(perHour(3.0)).toBeCloseTo(1.35, 2);
  // Student pays std fee minus the reimbursement passed on; never below the $0.50 minimum.
  expect(C.priceRow(ctx, units, row({ concession: "Y", std_fee_per_hour: 3 })).student_fee / 20).toBeCloseTo(1.65, 2);
  expect(C.priceRow(ctx, units, row({ std_fee_per_hour: 0.2 })).student_fee / 20).toBeCloseTo(0.5, 2);
});

test("fee exempt: no AQF reduction, student pays nothing", () => {
  const r = C.priceRow(ctx, units, row({ fee_exempt: "yes" }));
  expect(r.subsidy).toBeCloseTo(10.9 * R.indexFactor * 20, 2);
  expect(r.student_fee).toBe(0);
});

test("completion paid once per student+course, only when issued", () => {
  const out = C.priceRows(ctx, units, [
    row({ student_id: "S1", qualification_issued: "Y" }), row({ student_id: "S1", qualification_issued: "Y" }),
    row({ student_id: "S2" }), row({ student_id: "S3", qualification_issued: "Y", course_code: "BSB30120" }),
  ]);
  expect(out.completions).toBe(2);
  expect(out.totals.completion).toBe(400);
  expect(out.totals.govt).toBeCloseTo(out.totals.subsidy + 400 + out.totals.concession, 2);
  expect(out.byCourse.CHC32015.completion).toBe(200);
  expect(out.completionsWithoutUnits).toBe(0);
  const orphan = C.priceRows(ctx, units, [row({ student_id: "S9", unit_code: "NOPE", qualification_issued: "Y" })]);
  expect(orphan.totals.completion).toBe(200);          // still paid (course-level)...
  expect(orphan.completionsWithoutUnits).toBe(1);      // ...but flagged for review
});

test("errors are flagged, not guessed", () => {
  const out = C.priceRows(ctx, units, [
    row({ unit_code: "NOPE" }), row({ postcode: "9999" }), row({ course_code: "ZZZ99999" }),
    row({ postcode: "5710" }), row({ postcode: "5710", suburb: "Port Augusta" }), row({ postcode: "5211" }),
  ]);
  const e = out.results.map((r) => r.errors.join(";"));
  expect(e[0]).toContain("unknown unit");
  expect(e[1]).toContain("unknown postcode");
  expect(e[2]).toContain("course not on Attachment 2");
  expect(e[3]).toContain("mixed loadings");
  expect(e[4]).toBe("");               // suburb resolves it (10%)
  expect(out.results[4].loading_pct).toBe(10);
  expect(e[5]).toBe("");               // 5211: mixed labels, same 0% loading
  expect(out.errorCount).toBe(4);
});

test("AQF classification", () => {
  expect(C.classifyAqf("X", "Advanced Diploma of Nursing")).toBe("Advanced Diploma");
  expect(C.classifyAqf("X", "Diploma of Nursing")).toBe("Diploma");
  expect(C.classifyAqf("X", "Certificate IV in Cyber Security")).toBe("Certificate IV");
  expect(C.classifyAqf("X", "Certificate III in Plumbing")).toBe("Certificate III");
  expect(C.classifyAqf("X", "Certificate II in Retail")).toBe("Certificate II");
  expect(C.classifyAqf("X", "Certificate I in Animal Studies")).toBe("Certificate I");
  expect(C.classifyAqf("UETSS00032", "Refresher - Perform Tower Rescue")).toBe("Skill Set");
  expect(C.classifyAqf("X", "Something odd")).toBe(null);
  const unknown = Object.keys(R.courses).filter((k) => !C.classifyAqf(k, R.courses[k][0]));
  expect(unknown.length).toBeLessThan(10);
});

test("header mapping accepts common export names", () => {
  expect(C.mapHeaders(["Unit Code", "FOE", "Nominal Hours"], "units").missing).toEqual([]);
  const m = C.mapHeaders(["Qualification Code", "Unit ID", "Delivery Postcode", "Outcome", "USI"], "claims");
  expect(m.missing).toEqual([]);
  expect(m.map.result_code).toBe("Outcome");
  expect(C.mapHeaders(["foo"], "claims").missing).toEqual(["course_code", "unit_code", "postcode"]);
  const built = C.buildUnits([{ u: "abc1", f: 10101, h: "20" }], { unit_code: "u", foe_code: "f", payment_hours: "h" });
  expect(built.units.ABC1).toEqual({ foe: "010101", hours: 20, name: "" });
});

test("scenario levers", () => {
  const baseTotal = C.priceRows(ctx, units, [row()]).totals.subsidy;
  const up = C.priceRows(C.makeContext(R, { indexExtraPct: 1 }), units, [row()]).totals.subsidy;
  expect(up).toBeCloseTo((10.9 * R.indexFactor * 1.01 - 2.75) * 20, 2);
  const grow = C.priceRows(C.makeContext(R, { volumeGrowthPct: 10 }), units, [row()]).totals.subsidy;
  expect(grow).toBeCloseTo(baseTotal * 1.1, 2);
  const noLoad = C.makeContext(R, { locationLoading: { "Moderately Accessible Regional": 0 } });
  expect(C.priceRow(noLoad, units, row({ postcode: pc20 })).subsidy).toBeCloseTo(baseTotal, 2);
});
