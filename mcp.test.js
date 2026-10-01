// bun test mcp.test.js — drives mcp.js over stdio like Claude would, then checks against sim.js directly.
import { test, expect, afterAll } from "bun:test";
const fs = require("node:fs");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const C = require("./calc.js"), S = require("./sim.js");
const XLSX = require("./vendor/xlsx.full.min.js");

const dir = import.meta.dir;
const client = new Client({ name: "smoke", version: "1" });
await client.connect(new StdioClientTransport({ command: "bun", args: [dir + "/" + (process.env.MCP_SERVER || "mcp.js")], cwd: dir }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};
afterAll(async () => { await client.close(); fs.rmSync(dir + "/plans/smoke-test.json", { force: true }); fs.rmSync(dir + "/exports/smoke-test.xlsx", { force: true }); fs.rmSync(dir + "/scenarios/smoke-test.json", { force: true }); fs.rmSync(dir + "/exports/whatif-smoke.xlsx", { force: true }); });

test("tools are listed", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(names).toEqual(["compare_plans", "export_plan", "list_courses", "list_plans", "load_data", "load_plan", "optimise", "save_plan", "set_objective", "simulate", "update_courses", "whatif_export", "whatif_list", "whatif_load", "whatif_run", "whatif_save", "whatif_sensitivity", "whatif_set_scenario"]);
});

test("load → edit → optimise → save matches sim.js run directly", async () => {
  const s = dir + "/samples/";
  const loaded = await call("load_data", { units: s + "units_2019.csv", claims: s + "claims_demo.csv", profiles: s + "course_profiles_demo.csv", outcomes: s + "course_outcomes_demo.csv" });
  expect(loaded.courses.with_history).toBe(61);                    // 60 real + the injected ZZZ99999 row
  expect(loaded.courses.costed).toBeLessThan(loaded.courses.total); // ...which has no cost (never $0)
  expect(loaded.courses.from_profile).toBe(15);

  const managed = await call("list_courses", { status: "managed", only_costed: true, limit: 5 });
  expect(managed.courses.length).toBeGreaterThan(0);
  const target = managed.courses[0].course;
  await call("update_courses", { changes: [{ course_code: target, rto_limit: 1, rto_count: 1 }, { course_code: "NOTACOURSE", status: "off" }] });
  const cfg = await call("set_objective", { mode: "maximise", weights: { places: 0, completions: 1, employment: 1, priority: 0.5 } });
  expect(cfg.config.weights.priority).toBe(0.5);

  const res = await call("optimise", { top: 5 });
  expect(res.status).toBe("Optimal");
  expect(res.optimised.spend).toBeLessThanOrEqual(res.budget + 0.01);
  expect(res.biggest_changes.length).toBeLessThanOrEqual(5);
  expect(JSON.stringify(res)).not.toContain("S0001");                     // no student ids leak out

  // Same inputs through sim.js directly
  const read = (f) => { const wb = XLSX.read(fs.readFileSync(s + f), { type: "buffer", raw: true }); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false }); };
  const glob = (f, n) => JSON.parse(fs.readFileSync(dir + "/data/" + f, "utf8").replace(`window.${n} = `, "").replace(/;\s*$/, ""));
  const R = glob("rates.js", "SA_RATES"), STL = glob("stl.js", "SA_STL");
  const ur = read("units_2019.csv"), units = C.buildUnits(ur, C.mapHeaders(Object.keys(ur[0]), "units").map).units;
  const cr = read("claims_demo.csv"), priced = C.priceRows(C.makeContext(R), units, C.remap(cr, C.mapHeaders(Object.keys(cr[0]), "claims").map));
  const table = S.buildCourseTable({ rates: R, stl: STL, units, priced, profiles: read("course_profiles_demo.csv"), outcomes: read("course_outcomes_demo.csv") });
  const direct = S.optimise(table, { config: { mode: "maximise", weights: { places: 0, completions: 1, employment: 1, priority: 0.5 } }, courses: { [target]: { rto_limit: 1, rto_count: 1 } } }, await require("highs")());
  expect(res.optimised.completions).toBeCloseTo(direct.optimised.completions, 1);
  expect(res.optimised.spend).toBeCloseTo(direct.optimised.spend, 1);

  const saved = await call("save_plan", { name: "smoke-test" });
  const plan = JSON.parse(fs.readFileSync(dir + "/" + saved.saved, "utf8"));
  expect(plan.courses[target]).toEqual({ rto_limit: 1, rto_count: 1 });
  expect(Object.values(plan.result.seats).reduce((a, b) => a + b, 0)).toBe(res.optimised.seats);
  expect((await call("export_plan", { name: "smoke-test" })).exported).toBe("exports/smoke-test.xlsx");
});

test("value-for-money mode and errors come back as tool errors, not crashes", async () => {
  await call("set_objective", { mode: "min_cost", targets: { completions: 100 } });
  const r = await call("optimise");
  expect(r.status).toBe("Optimal");
  expect(r.optimised.completions).toBeGreaterThanOrEqual(r.baseline.completions - 1e-6);
  expect(r.optimised.spend).toBeLessThanOrEqual(r.baseline.spend + 0.01);
  expect(r.shadow_prices.cost_per_extra_completions).toBeGreaterThan(0);
  await expect(call("load_data", { units: "/nope.csv" })).rejects.toThrow("file not found");
  await expect(call("save_plan", { name: "../../etc" })).resolves.toEqual({ saved: "plans/------etc.json" });
  fs.rmSync(dir + "/plans/------etc.json", { force: true });
});

test("what-if: scenarios run through the tool match whatif.js run directly", async () => {
  const W = require("./whatif.js");
  await call("whatif_set_scenario", { name: "base" });
  await call("whatif_set_scenario", { name: "cut", copy_from: "base", levers: { adjMultiplier: 0.9 }, effective_fy: 1 });
  await call("whatif_set_scenario", { name: "opt", seats: "optimised", triggers: [{ name: "cap", atPct: 50, action: "pause", scope: "all", noticeMonths: 0 }] });
  expect((await call("whatif_list")).scenarios.map((s) => s.name)).toEqual(["base", "cut", "opt"]);

  const r = await call("whatif_run", { runs: 50 });
  const [base, cut, opt] = r.scenarios;
  expect(cut.years[0].new_commitments).toBe(base.years[0].new_commitments);   // cut starts in FY+1
  expect(cut.years[1].new_commitments).toBeLessThan(base.years[1].new_commitments);
  expect(base.ranges.years[0].cash.p10).toBeLessThanOrEqual(base.ranges.years[0].cash.p90);
  expect(opt.totals.intake).toBeGreaterThan(0);
  expect(opt.triggers_fired[0]).toMatchObject({ name: "cap", fy: "2026-27" });
  expect(opt.trigger_savings.all).toBeGreaterThan(0);

  const s = dir + "/samples/", read = (f) => { const wb = XLSX.read(fs.readFileSync(s + f), { type: "buffer", raw: true }); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false }); };
  const glob = (f, n) => JSON.parse(fs.readFileSync(dir + "/data/" + f, "utf8").replace(`window.${n} = `, "").replace(/;\s*$/, ""));
  const ur = read("units_2019.csv"), cr = read("claims_demo.csv");
  const saved = JSON.parse(fs.readFileSync(dir + "/plans/smoke-test.json", "utf8"));
  const direct = W.run({ rates: glob("rates.js", "SA_RATES"), stl: glob("stl.js", "SA_STL"), units: C.buildUnits(ur, C.mapHeaders(Object.keys(ur[0]), "units").map).units,
    claims: C.remap(cr, C.mapHeaders(Object.keys(cr[0]), "claims").map), profiles: read("course_profiles_demo.csv"), outcomes: read("course_outcomes_demo.csv"),
    plan: { courses: saved.courses } }, { name: "base" });
  expect(base.totals.cash).toBeCloseTo(direct.totals.cash, 0);

  const sens = await call("whatif_sensitivity", { name: "cut", metric: "fy1_commitments" });
  expect(sens.rows.find((x) => x.lever === "Intake volume").change_high).toBeGreaterThan(0);
  expect((await call("whatif_save", { name: "smoke-test" })).saved).toBe("scenarios/smoke-test.json");
  await call("whatif_set_scenario", { name: "opt", delete: true });
  expect((await call("whatif_load", { name: "smoke-test" })).loaded).toEqual(["base", "cut", "opt"]);
  expect((await call("whatif_export", { name: "whatif-smoke" })).exported).toBe("exports/whatif-smoke.xlsx");
  const wb = XLSX.read(fs.readFileSync(dir + "/exports/whatif-smoke.xlsx"), { type: "buffer" });
  expect(wb.SheetNames).toEqual(["Compare", "Years", "Months", "Triggers", "Ranges", "Sensitivity"]);
});
