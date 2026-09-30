#!/usr/bin/env bun
/* Local MCP server: lets Claude drive the course seat simulator / optimiser.
 *   claude mcp add sa-sim -- bun /path/to/sa-skills-sync/mcp.js
 * Reads files you point it at; returns course-level aggregates only (never student rows).
 * Writes only inside ./plans and ./exports.
 */
const fs = require("node:fs");
const path = require("node:path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const XLSX = require("./vendor/xlsx.full.min.js");
const C = require("./calc.js");
const S = require("./sim.js");

const ROOT = __dirname;
const readGlobal = (file, name) => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8").replace(new RegExp(`^window\\.${name} = `), "").replace(/;\s*$/, ""));
const RATES = readGlobal("data/rates.js", "SA_RATES");
const STL = readGlobal("data/stl.js", "SA_STL");
let highs = null;
const solver = async () => (highs = highs || (await require("highs")()));

const state = { units: {}, files: {}, priced: null, profiles: [], outcomes: [], table: null, plan: S.newPlan(), planName: "untitled", last: null };

// ---------- helpers ----------
function readTable(file) {
  const p = path.resolve(file);
  if (!fs.existsSync(p)) throw new Error(`file not found: ${p}`);
  const wb = XLSX.read(fs.readFileSync(p), { type: "buffer", raw: true }); // buffer: SheetJS can't detect fs under Bun
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
}
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
function pickCols(rows, want) { // {field: [synonyms]} -> rows with those field names
  if (!rows.length) return [];
  const headers = Object.keys(rows[0]), map = {};
  for (const [f, syn] of Object.entries(want)) { const h = headers.find((h) => [norm(f), ...syn].includes(norm(h))); if (h) map[f] = h; }
  return rows.map((r) => Object.fromEntries(Object.entries(map).map(([f, h]) => [f, r[h]])));
}
function rebuild() {
  state.table = S.buildCourseTable({ rates: RATES, stl: STL, units: state.units, priced: state.priced, profiles: state.profiles, outcomes: state.outcomes, cfg: state.plan.config });
}
const round = (v, d = 2) => (typeof v === "number" && isFinite(v) ? +v.toFixed(d) : v ?? null);
const roundObj = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, round(v)]));
const reply = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 1) }] });
const fail = (msg) => ({ content: [{ type: "text", text: "Error: " + msg }], isError: true });
const guard = (fn) => async (args) => { try { return await fn(args || {}); } catch (e) { if (e.solverDead) highs = null; return fail(e.message); } };
const safeName = (n) => { const s = String(n || "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60); if (!s) throw new Error("name required"); return s; };
const needTable = () => { if (!state.table) rebuild(); return state.table; };
function summarise(res, top = 20) {
  const moved = res.courses.filter((c) => c.seats != null && c.delta).sort((a, b) => Math.abs(b.delta * (b.cost_per_seat || 0)) - Math.abs(a.delta * (a.cost_per_seat || 0)));
  const binding = {};
  res.courses.forEach((c) => { if (c.binding) binding[c.binding] = (binding[c.binding] || 0) + 1; });
  return {
    status: res.status, message: res.message || undefined, plan: state.planName,
    mode: res.config.mode, budget: round(res.config.budget ?? res.baseline.spend),
    baseline: roundObj(res.baseline), optimised: res.optimised ? roundObj(res.optimised) : undefined,
    manual_plan: roundObj(res.planned), manual_plan_breaches: res.plannedViolations.slice(0, 20),
    shadow_prices: res.shadow ? roundObj(res.shadow) : undefined,
    binding_constraints: binding, courses_with_flags: res.flags,
    biggest_changes: moved.slice(0, top).map((c) => ({ course: c.course_code, title: c.title, status: c.status, from: c.baseline_seats, to: c.seats, cost_per_seat: round(c.cost_per_seat), spend_change: round(c.delta * (c.cost_per_seat || 0)), binding: c.binding || undefined })),
  };
}

// ---------- server ----------
const server = new McpServer({ name: "sa-course-sim", version: "1.0.0" });

server.registerTool("load_data", {
  description: "Load data files (CSV/XLSX paths). units: unit_code, foe_code, payment_hours. claims: one row per unit (course_code, unit_code, postcode, student_id, provider_id, qualification_issued, ...), repriced at the current Training Fee Framework to give baseline seats, cost per seat, completion rate and RTO counts per course. profiles: course_code, unit_code[, hours] for courses with no history. outcomes: course_code, completion_rate, employment_rate, priority_weight. Demo files are in samples/ (units_2019.csv, claims_demo.csv, course_profiles_demo.csv, course_outcomes_demo.csv).",
  inputSchema: { units: z.string().optional(), claims: z.string().optional(), profiles: z.string().optional(), outcomes: z.string().optional() },
}, guard(async ({ units, claims, profiles, outcomes }) => {
  const notes = [];
  if (units) {
    const rows = readTable(units), { map, missing } = C.mapHeaders(Object.keys(rows[0] || {}), "units");
    if (missing.length) throw new Error(`units file is missing ${missing.join(", ")}`);
    const b = C.buildUnits(rows, map); state.units = b.units; state.files.units = units;
    notes.push(`units: ${Object.keys(b.units).length}` + (b.errors.length ? ` (${b.errors.length} rows skipped)` : ""));
  }
  if (claims) {
    const rows = readTable(claims), { map, missing } = C.mapHeaders(Object.keys(rows[0] || {}), "claims");
    if (missing.length) throw new Error(`claims file is missing ${missing.join(", ")}`);
    state.priced = C.priceRows(C.makeContext(RATES), state.units, C.remap(rows, map)); state.files.claims = claims;
    notes.push(`claims: ${rows.length} rows, ${state.priced.errorCount} with issues` + (map.provider_id ? "" : "; no provider_id column, so RTO counts are unknown"));
  }
  if (profiles) { state.profiles = pickCols(readTable(profiles), { course_code: ["course", "qualificationcode"], unit_code: ["unit"], hours: ["paymenthours", "nominalhours"] }); state.files.profiles = profiles; notes.push(`profiles: ${state.profiles.length} rows`); }
  if (outcomes) { state.outcomes = pickCols(readTable(outcomes), { course_code: ["course", "qualificationcode"], completion_rate: ["completion", "completionrate"], employment_rate: ["employment", "employmentrate", "employed"], priority_weight: ["priority", "weight", "priorityweight"] }); state.files.outcomes = outcomes; notes.push(`outcomes: ${state.outcomes.length} courses`); }
  rebuild();
  const rows = S.resolve(state.table, state.plan.courses, state.plan.config);
  const count = (f) => rows.filter(f).length;
  return reply({ loaded: notes, framework: RATES.framework, stl: STL.version,
    courses: { total: rows.length, with_history: count((r) => r.source === "history"), from_profile: count((r) => r.source === "profile"),
      costed: count((r) => isFinite(r.cost_per_seat)), managed: count((r) => r.status === "managed"), off_list: count((r) => r.status === "off"), flagged: count((r) => r.flags.length) } });
}));

server.registerTool("list_courses", {
  description: "List courses in the current plan with status, managed limits, seats, cost per seat and outcome rates. Filter by status (demand|managed|off), list (TPL|STAL|VSS), aqf, search text, only_costed (has a cost per seat) or only_flagged.",
  inputSchema: { status: z.enum(["demand", "managed", "off"]).optional(), list: z.string().optional(), aqf: z.string().optional(), search: z.string().optional(),
    only_costed: z.boolean().optional(), only_flagged: z.boolean().optional(), sort_by: z.enum(["course_code", "cost_per_seat", "baseline_seats", "completion_rate", "employment_rate", "priority_weight"]).optional(),
    descending: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional() },
}, guard(async (a) => {
  let rows = S.resolve(needTable(), state.plan.courses, state.plan.config);
  if (a.status) rows = rows.filter((r) => r.status === a.status);
  if (a.list) rows = rows.filter((r) => r.lists.split("/").includes(a.list.toUpperCase()));
  if (a.aqf) rows = rows.filter((r) => r.aqf.toLowerCase() === a.aqf.toLowerCase());
  if (a.search) { const q = a.search.toLowerCase(); rows = rows.filter((r) => (r.course_code + " " + r.title).toLowerCase().includes(q)); }
  if (a.only_costed) rows = rows.filter((r) => isFinite(r.cost_per_seat));
  if (a.only_flagged) rows = rows.filter((r) => r.flags.length);
  const k = a.sort_by || "course_code", dir = a.descending ? -1 : 1;
  rows.sort((x, y) => (typeof x[k] === "string" ? x[k].localeCompare(y[k]) : ((isFinite(x[k]) ? x[k] : -Infinity) - (isFinite(y[k]) ? y[k] : -Infinity))) * dir);
  const off = a.offset || 0, lim = a.limit || 50;
  return reply({ total: rows.length, offset: off, courses: rows.slice(off, off + lim).map((r) => ({
    course: r.course_code, title: r.title, aqf: r.aqf, lists: r.lists, status: r.status, rto_limit: r.rto_limit, rto_count: r.rto_count,
    managed_cap: r.managed_cap, baseline_seats: r.baseline_seats, min: r.lb, max: r.ub, planned_seats: r.planned_seats,
    cost_per_seat: round(r.cost_per_seat), completion_rate: round(r.completion_rate), employment_rate: round(r.employment_rate),
    priority_weight: r.priority_weight, source: r.source || "none", flags: r.flags.length ? r.flags.join("; ") : undefined })) });
}));

const change = z.object({
  course_code: z.string(), status: z.enum(["demand", "managed", "off"]).optional(), rto_limit: z.number().optional(), rto_count: z.number().optional(),
  min_seats: z.number().optional(), max_seats: z.number().optional(), budget_cap: z.number().optional(), planned_seats: z.number().optional(),
  cost_per_seat: z.number().optional(), completion_rate: z.number().optional(), employment_rate: z.number().optional(), priority_weight: z.number().optional(),
  reset: z.boolean().optional().describe("drop all overrides for this course first"),
});
server.registerTool("update_courses", {
  description: "Change courses in the current plan: move between demand-driven / managed / off-list, set the per-RTO limit or RTO count (managed cap = limit × count), min/max seats, a course budget cap, manual planned_seats, or override cost per seat and outcome rates (rates as 0-1 or %). Changes are overrides; reset:true restores the published/historical values.",
  inputSchema: { changes: z.array(change).min(1).max(500) },
}, guard(async ({ changes }) => {
  const known = new Set(needTable().map((r) => r.course_code)), warnings = [];
  for (const ch of changes) {
    const c = ch.course_code.trim().toUpperCase();
    if (!known.has(c)) { warnings.push(`${c}: not on the STL or in loaded data, skipped`); continue; }
    const cur = ch.reset ? {} : Object.assign({}, state.plan.courses[c]);
    for (const k of S.EDITABLE) if (ch[k] !== undefined) cur[k] = ch[k];
    if (Object.keys(cur).length) state.plan.courses[c] = cur; else delete state.plan.courses[c];
  }
  return reply({ applied: changes.length - warnings.length, warnings, overridden_courses: Object.keys(state.plan.courses).length });
}));

server.registerTool("set_objective", {
  description: "Set what 'best outcome' means. mode 'maximise': maximise weighted outcomes within the budget (weights for places, completions, employment, priority; priority is scaled to 0-1). mode 'min_cost' (value for money): minimise spend while keeping each target metric at ≥ target % of baseline (e.g. {completions: 100}). Also: budget ($, default baseline spend), headroomPct (max seats = baseline × (1 + headroom)), floorPct (guardrail: no course below this % of its baseline seats unless set off-list), newCourseMaxSeats, defaultRtoCount, aqfShares ({\"Certificate III\": {min: 20, max: 60}} % of seats), defaults for missing rates.",
  inputSchema: { mode: z.enum(["maximise", "min_cost"]).optional(), budget: z.number().nullable().optional(),
    weights: z.object({ places: z.number(), completions: z.number(), employment: z.number(), priority: z.number() }).partial().optional(),
    targets: z.object({ places: z.number(), completions: z.number(), employment: z.number(), priority: z.number() }).partial().optional(),
    headroomPct: z.number().optional(), floorPct: z.number().min(0).max(100).optional(), newCourseMaxSeats: z.number().optional(), defaultRtoCount: z.number().optional(),
    aqfShares: z.record(z.string(), z.object({ min: z.number().optional(), max: z.number().optional() })).optional(),
    defaults: z.object({ completion_rate: z.number(), employment_rate: z.number(), priority_weight: z.number() }).partial().optional() },
}, guard(async (a) => {
  const cfg = state.plan.config;
  for (const k of ["mode", "budget", "headroomPct", "floorPct", "newCourseMaxSeats", "defaultRtoCount", "aqfShares", "targets"]) if (a[k] !== undefined) cfg[k] = a[k];
  if (a.weights) cfg.weights = Object.assign({}, cfg.weights, a.weights);
  if (a.defaults) cfg.defaults = Object.assign({}, cfg.defaults, a.defaults);
  return reply({ config: cfg });
}));

server.registerTool("optimise", {
  description: "Solve the current plan with HiGHS (integer seats per course) and return baseline vs optimised totals (seats, spend, completions, employment, priority places, cost per completion), shadow prices (value of an extra $1M, or marginal cost of an extra completion), which caps bind, and the biggest seat changes.",
  inputSchema: { top: z.number().int().min(1).max(200).optional() },
}, guard(async ({ top }) => {
  const res = S.optimise(needTable(), state.plan, await solver());
  state.last = res;
  return reply(summarise(res, top || 20));
}));

server.registerTool("simulate", {
  description: "Evaluate the manual plan (planned_seats overrides, baseline seats elsewhere) without optimising: totals and any managed-cap / max-seat breaches.",
  inputSchema: {},
}, guard(async () => {
  const rows = S.resolve(needTable(), state.plan.courses, state.plan.config);
  const maxPri = Math.max(0, ...rows.map((r) => r.priority_weight || 0));
  const base = S.evaluate(rows, (r) => r.baseline_seats, maxPri), man = S.evaluate(rows, (r) => (r.planned_seats != null && !isNaN(r.planned_seats) ? r.planned_seats : r.baseline_seats), maxPri);
  return reply({ baseline: roundObj(base.totals), manual_plan: roundObj(man.totals), breaches: man.violations });
}));

server.registerTool("save_plan", {
  description: "Save the current plan (config, course overrides and the last optimisation result) to plans/<name>.json. The browser calculator can open it on the 'Courses & optimiser' tab.",
  inputSchema: { name: z.string() },
}, guard(async ({ name }) => {
  const n = safeName(name), dir = path.join(ROOT, "plans");
  fs.mkdirSync(dir, { recursive: true });
  state.planName = n;
  const out = Object.assign({}, state.plan, { name: n, saved: new Date().toISOString(), files: state.files,
    result: state.last ? { status: state.last.status, baseline: state.last.baseline, optimised: state.last.optimised, shadow: state.last.shadow,
      seats: Object.fromEntries(state.last.courses.filter((c) => c.seats).map((c) => [c.course_code, c.seats])) } : null });
  fs.writeFileSync(path.join(dir, n + ".json"), JSON.stringify(out, null, 2));
  return reply({ saved: path.join("plans", n + ".json") });
}));

server.registerTool("load_plan", {
  description: "Load plans/<name>.json as the current plan (config + course overrides). Data files are not reloaded; use load_data for that.",
  inputSchema: { name: z.string() },
}, guard(async ({ name }) => {
  const p = path.join(ROOT, "plans", safeName(name) + ".json");
  const plan = JSON.parse(fs.readFileSync(p, "utf8"));
  state.plan = { version: 1, created: plan.created, config: Object.assign(S.newPlan().config, plan.config), courses: plan.courses || {} };
  state.planName = plan.name || name; state.last = null;
  return reply({ loaded: state.planName, overridden_courses: Object.keys(state.plan.courses).length, config: state.plan.config });
}));

server.registerTool("list_plans", { description: "List saved plans.", inputSchema: {} }, guard(async () => {
  const dir = path.join(ROOT, "plans");
  return reply({ plans: fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [] });
}));

server.registerTool("compare_plans", {
  description: "Optimise several saved plans against the currently loaded data and compare their totals side by side.",
  inputSchema: { names: z.array(z.string()).min(2).max(8) },
}, guard(async ({ names }) => {
  const rows = [];
  for (const name of names) {
    const plan = JSON.parse(fs.readFileSync(path.join(ROOT, "plans", safeName(name) + ".json"), "utf8"));
    const res = S.optimise(needTable(), { config: Object.assign(S.newPlan().config, plan.config), courses: plan.courses || {} }, await solver());
    rows.push({ plan: name, status: res.status, mode: res.config.mode, ...roundObj(res.optimised || {}), value_per_million: round(res.shadow && res.shadow.value_per_million) });
  }
  return reply({ comparison: rows });
}));

server.registerTool("export_plan", {
  description: "Write the last optimisation result per course to exports/<name>.xlsx (sheets: Courses, Totals, Config).",
  inputSchema: { name: z.string() },
}, guard(async ({ name }) => {
  if (!state.last) throw new Error("run optimise first");
  const dir = path.join(ROOT, "exports"); fs.mkdirSync(dir, { recursive: true });
  const wb = XLSX.utils.book_new(), r = state.last;
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(r.courses.map((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === "number" ? round(v, 4) : v])))), "Courses");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(["baseline", "planned", "optimised"].filter((k) => r[k]).map((k) => ({ scenario: k, ...roundObj(r[k]) }))), "Totals");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(Object.entries(r.config).map(([k, v]) => ({ setting: k, value: typeof v === "object" ? JSON.stringify(v) : v }))), "Config");
  const file = path.join(dir, safeName(name) + ".xlsx");
  fs.writeFileSync(file, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  return reply({ exported: path.relative(ROOT, file) });
}));

server.connect(new StdioServerTransport());
