/* Course seat simulator + optimiser. Pure functions; the solver is passed in.
 * Browser: window.SASim (needs window.SACalc).  Bun/Node: require("./sim.js").
 *
 * One row per course: status (demand | managed | off), managed cap = RTO limit × RTO count,
 * cost per seat = unit cost + completion payment × completion rate, and per-seat outcomes.
 * optimise() picks integer seats per course with HiGHS:
 *   mode "maximise": max Σ seats × value  s.t. spend ≤ budget        (best outcome for the money)
 *   mode "min_cost": min spend             s.t. outcomes ≥ targets     (value for money)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./calc.js"));
  else root.SASim = factory(root.SACalc);
})(typeof self !== "undefined" ? self : this, function (C) {
  "use strict";

  const METRICS = ["places", "completions", "employment", "priority"];
  const DEFAULT_CONFIG = {
    mode: "maximise",
    budget: null,                       // $; null = baseline spend
    weights: { places: 1, completions: 1, employment: 1, priority: 1 },
    targets: { completions: 100 },      // min_cost mode: % of baseline per metric
    headroomPct: 20,                    // max seats default = baseline × (1 + headroom)
    floorPct: 0,                        // guardrail: min seats = baseline × floor% (unless off-list)
    newCourseMaxSeats: 50,              // max seats for a course with no history
    defaultRtoCount: 1,                 // managed courses with no provider data
    defaults: { completion_rate: 0.5, employment_rate: 0.5, priority_weight: 1 },
    aqfShares: {},                      // {"Certificate III": {min: 20, max: 60}} as % of seats
    profilePostcode: "5000",
    timeLimit: 30,
  };
  const EDITABLE = ["status", "rto_limit", "rto_count", "min_seats", "max_seats", "budget_cap", "planned_seats",
                    "cost_per_seat", "completion_rate", "employment_rate", "priority_weight"];

  const num = (v) => (v === "" || v == null ? NaN : typeof v === "number" ? v : parseFloat(String(v).replace(/[$,%\s]/g, "")));
  const code = (s) => String(s == null ? "" : s).trim().toUpperCase();
  const rate01 = (v) => { const n = num(v); return isNaN(n) ? NaN : n > 1 ? n / 100 : n; }; // 65 or 0.65 -> 0.65
  const merge = (a, b) => Object.assign({}, a, b || {});
  const config = (c) => {
    const x = merge(DEFAULT_CONFIG, c);
    x.weights = merge(DEFAULT_CONFIG.weights, c && c.weights);
    x.defaults = merge(DEFAULT_CONFIG.defaults, c && c.defaults);
    x.targets = (c && c.targets) || DEFAULT_CONFIG.targets;
    return x;
  };

  /** Default status from STL: TPL section first (non-contract), then STAL, then VSS; off if not listed. */
  function stlStatus(stl, c) {
    const rec = stl && stl.courses[c];
    if (!rec) return { status: "off", lists: "", limit: null, group: null };
    const pick = rec.lists.TPL || rec.lists.STAL || rec.lists.VSS;
    return { status: pick.section === "managed" ? "managed" : "demand", lists: Object.keys(rec.lists).join("/"),
             limit: pick.limit || null, group: pick.group || null, title: rec.title };
  }

  /**
   * Build the course table.
   *  priced:   SACalc.priceRows output for historical claims (optional)
   *  profiles: [{course_code, unit_code, hours?}] typical packaging per course (optional)
   *  outcomes: [{course_code, completion_rate?, employment_rate?, priority_weight?}] (optional)
   */
  function buildCourseTable({ rates, stl, units = {}, priced = null, profiles = [], outcomes = [], cfg = {} }) {
    const cf = config(cfg), rows = {};
    const row = (c) => rows[c] || (rows[c] = blank(c));
    const blank = (c) => {
      const s = stlStatus(stl, c), info = C.courseInfo(C.makeContext(rates), c);
      return { course_code: c, title: s.title || info.name, aqf: info.aqf || "", lists: s.lists, status: s.status,
               stl_status: s.status, rto_limit: s.limit, limit_group: s.group, rto_count: null,
               baseline_seats: 0, unit_cost: NaN, completion_payment: info.aqf ? rates.completion[info.aqf] || 0 : 0,
               completion_rate: NaN, employment_rate: NaN, priority_weight: NaN,
               min_seats: 0, max_seats: null, budget_cap: null, planned_seats: null, cost_override: NaN, source: "", flags: [] };
    };

    // 1. History: seats = distinct students (× volume), unit cost = (subsidy + concession) / seats.
    if (priced) {
      const acc = {};
      priced.results.forEach((r, i) => {
        if (!r.course_code) return;
        const a = acc[r.course_code] || (acc[r.course_code] = { students: new Map(), priced: new Set(), providers: new Set(), cost: 0, completed: new Set(), failed: 0 });
        const sid = r.student_id || "#row" + i;
        if (!a.students.has(sid)) a.students.set(sid, r.volume || 1);
        if (r.provider_id) a.providers.add(r.provider_id);
        if (r.ok) { a.cost += r.subsidy + r.concession_reimb; a.priced.add(sid); } else a.failed++;
        if (r.qualification_issued) a.completed.add(sid);
      });
      const vol = (a, ids) => [...ids].reduce((s, sid) => s + (a.students.get(sid) || 0), 0);
      for (const [c, a] of Object.entries(acc)) {
        const r = row(c), seats = vol(a, a.students.keys()), pricedSeats = vol(a, a.priced);
        r.baseline_seats = seats;
        // Cost per seat only from students whose units priced; a course with none has no cost (never $0).
        r.unit_cost = pricedSeats ? a.cost / pricedSeats : NaN;
        r.completion_rate = seats ? vol(a, a.completed) / seats : NaN;
        r.rto_count = a.providers.size || null;
        r.source = "history";
        if (a.failed) r.flags.push(`${a.failed} claim row(s) not priced; cost from priced students only`);
        if (!rates.courses[c] && !(stl && stl.courses[c])) r.flags.push("course not on Attachment 2 or the STL");
      }
    }
    // 2. Profiles fill courses with no history: one synthetic student priced by calc.js.
    const byCourse = {};
    profiles.forEach((p) => { const c = code(p.course_code); if (c) (byCourse[c] = byCourse[c] || []).push(p); });
    for (const [c, list] of Object.entries(byCourse)) {
      const r = row(c);
      if (r.source === "history" && isFinite(r.unit_cost)) continue;
      const out = C.priceRows(C.makeContext(rates), units, list.map((p) => ({ course_code: c, unit_code: p.unit_code, hours: p.hours, postcode: cf.profilePostcode, student_id: "PROFILE" })));
      r.unit_cost = out.totals.subsidy + out.totals.concession;
      r.source = "profile";
      if (out.errorCount) r.flags.push(`profile: ${out.errorCount} unit(s) not priced`);
    }
    // 3. Outcomes upload overrides rates / weights.
    outcomes.forEach((o) => {
      const c = code(o.course_code); if (!c) return;
      const r = row(c);
      if (!isNaN(rate01(o.completion_rate))) r.completion_rate = rate01(o.completion_rate);
      if (!isNaN(rate01(o.employment_rate))) r.employment_rate = rate01(o.employment_rate);
      if (!isNaN(num(o.priority_weight))) r.priority_weight = num(o.priority_weight);
    });
    // 4. Every STL course appears, even with no data (so it can be switched on / given a cost).
    if (stl) Object.keys(stl.courses).forEach(row);
    return Object.values(rows).sort((a, b) => a.course_code.localeCompare(b.course_code));
  }

  /** Apply plan overrides ({code: {field: value}}) and derive the numbers the model uses. */
  function resolve(table, overrides = {}, cfg = {}) {
    const cf = config(cfg);
    return table.map((base) => {
      const r = Object.assign({}, base, { flags: base.flags.slice() });
      const o = overrides[r.course_code] || {};
      for (const k of EDITABLE) {
        if (o[k] === undefined || o[k] === "" || o[k] === null) continue;
        if (k === "status") {
          if (!["demand", "managed", "off"].includes(o[k])) throw new Error(`${r.course_code}: status must be demand, managed or off`);
          r.status = o[k];
        } else if (k === "cost_per_seat") r.cost_override = num(o[k]);
        else if (k === "completion_rate" || k === "employment_rate") r[k] = rate01(o[k]);
        else r[k] = num(o[k]);
      }
      for (const key of ["completion_rate", "employment_rate", "priority_weight"]) {
        if (isNaN(r[key])) { r[key] = cf.defaults[key]; r.flags.push(`${key.replace("_", " ")}: default used`); }
      }
      r.cost_per_seat = !isNaN(r.cost_override) ? r.cost_override
        : isFinite(r.unit_cost) ? r.unit_cost + r.completion_payment * r.completion_rate : NaN;
      if (!isFinite(r.cost_per_seat)) r.flags.push("no cost: upload history, a profile, or set cost_per_seat");
      if (r.status === "managed") {
        if (!r.rto_limit) r.flags.push("managed with no RTO limit");
        if (!r.rto_count) { r.rto_count_used = cf.defaultRtoCount; r.flags.push("RTO count unknown: default used"); }
        else r.rto_count_used = r.rto_count;
        r.managed_cap = r.rto_limit ? r.rto_limit * r.rto_count_used : null;
      } else r.managed_cap = null;
      r.max_used = r.max_seats != null && !isNaN(r.max_seats) ? r.max_seats
        : r.baseline_seats ? Math.ceil(r.baseline_seats * (1 + cf.headroomPct / 100)) : cf.newCourseMaxSeats;
      const caps = [r.max_used];
      if (r.status === "off" || !isFinite(r.cost_per_seat)) caps.push(0);
      if (r.managed_cap != null) caps.push(r.managed_cap);
      if (r.budget_cap && isFinite(r.cost_per_seat) && r.cost_per_seat > 0) caps.push(Math.floor(r.budget_cap / r.cost_per_seat));
      r.ub = Math.max(0, Math.min(...caps));
      r.lb = r.status === "off" ? 0 : Math.max(0, r.min_seats || 0, Math.min(r.ub, Math.ceil(r.baseline_seats * (cf.floorPct || 0) / 100)));
      r.value = null; // filled per config in valuePerSeat
      return r;
    });
  }

  function valuePerSeat(r, w, maxPri) {
    return w.places + w.completions * r.completion_rate + w.employment * r.employment_rate + w.priority * (maxPri ? r.priority_weight / maxPri : 0);
  }
  const outcomesOf = (r, seats, maxPri) => ({ places: seats, completions: seats * r.completion_rate, employment: seats * r.employment_rate, priority: seats * (maxPri ? r.priority_weight / maxPri : 0) });

  /** Totals for a set of seats (baseline, a manual plan, or an optimised plan). */
  function evaluate(rows, seatsOf, maxPri) {
    const t = { seats: 0, spend: 0, places: 0, completions: 0, employment: 0, priority: 0 }, violations = [];
    for (const r of rows) {
      const s = seatsOf(r) || 0;
      if (!s) continue;
      const cost = isFinite(r.cost_per_seat) ? r.cost_per_seat : 0, o = outcomesOf(r, s, maxPri);
      t.seats += s; t.spend += s * cost;
      for (const m of METRICS) t[m] += o[m];
      if (s > r.ub) violations.push(`${r.course_code}: ${s} seats > limit ${r.ub}${r.status === "off" ? " (off-list)" : r.managed_cap != null && s > r.managed_cap ? " (managed cap)" : ""}`);
    }
    t.cost_per_completion = t.completions ? t.spend / t.completions : NaN;
    return { totals: t, violations };
  }

  /** CPLEX-LP text. Variables are x0..xn (course codes can start with digits, which LP names can't). */
  function buildModel(rows, cfg, baselineTotals, maxPri, relax = false) {
    const cf = config(cfg), live = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.ub > 0 || r.lb > 0);
    const v = (i) => "x" + i, lines = [];
    const sum = (terms) => { // wrap long rows (LP line limit)
      const out = []; let cur = "";
      terms.forEach((t, k) => { const s = (k && !t.startsWith("-") ? " + " : " ") + t; if (cur.length + s.length > 200) { out.push(cur); cur = ""; } cur += s; });
      out.push(cur); return out.join("\n  ");
    };
    const coef = (c, name) => `${+c.toFixed(8)} ${name}`;
    const rowsOut = [], names = [];
    if (cf.mode === "min_cost") {
      lines.push("Minimize", " obj: " + sum(live.map(({ r, i }) => coef(r.cost_per_seat, v(i)))));
      for (const m of METRICS) {
        const pct = num(cf.targets[m]);
        if (isNaN(pct)) continue;
        const target = baselineTotals[m] * pct / 100;
        rowsOut.push(` t_${m}: ` + sum(live.map(({ r, i }) => coef(outcomesOf(r, 1, maxPri)[m], v(i)))) + ` >= ${+target.toFixed(6)}`);
        names.push("t_" + m);
      }
      if (!names.length) throw new Error("min_cost mode needs at least one target (e.g. completions: 100)");
    } else {
      lines.push("Maximize", " obj: " + sum(live.map(({ r, i }) => coef(valuePerSeat(r, cf.weights, maxPri), v(i)))));
      const budget = num(cf.budget);
      rowsOut.push(" budget: " + sum(live.map(({ r, i }) => coef(r.cost_per_seat, v(i)))) + ` <= ${+(isNaN(budget) ? baselineTotals.spend : budget).toFixed(2)}`);
      names.push("budget");
    }
    // Shared managed limits (e.g. superseded + new version of a course share one RTO limit).
    const groups = {};
    live.forEach(({ r, i }) => { if (r.status === "managed" && r.limit_group && r.managed_cap != null) (groups[r.limit_group] = groups[r.limit_group] || []).push({ r, i }); });
    for (const [g, members] of Object.entries(groups)) {
      if (members.length < 2) continue;
      const cap = Math.max(...members.map(({ r }) => r.managed_cap));
      rowsOut.push(` g_${g.replace(/[^A-Za-z0-9]/g, "")}: ` + sum(members.map(({ i }) => v(i))) + ` <= ${cap}`);
    }
    // AQF mix: seats at a level between min% and max% of all seats.
    for (const [aqf, { min, max } = {}] of Object.entries(cf.aqfShares || {})) {
      const inL = new Set(live.filter(({ r }) => r.aqf === aqf).map(({ i }) => i));
      const tag = aqf.replace(/[^A-Za-z]/g, "");
      for (const [bound, op, name] of [[num(min), ">=", "min"], [num(max), "<=", "max"]]) {
        if (isNaN(bound)) continue;
        const f = bound / 100;
        rowsOut.push(` aqf_${name}_${tag}: ` + sum(live.map(({ i }) => coef((inL.has(i) ? 1 : 0) - f, v(i)))) + ` ${op} 0`);
      }
    }
    lines.push("Subject To", ...rowsOut, "Bounds");
    live.forEach(({ r, i }) => lines.push(` ${r.lb} <= ${v(i)} <= ${r.ub}`));
    if (!relax && live.length) { // integer seats; space-separated names, wrapped
      const names = live.map(({ i }) => v(i));
      for (let k = 0; k < names.length; k += 20) lines.push((k ? "" : "General\n") + " " + names.slice(k, k + 20).join(" "));
    }
    lines.push("End");
    return { lp: lines.join("\n"), live };
  }

  /** Pre-solve checks that name the reason a model can't be solved. */
  function feasibility(rows, cf, baseline, maxPri) {
    const msgs = [];
    rows.forEach((r) => { if (r.lb > r.ub) msgs.push(`${r.course_code}: min seats ${r.lb} > max ${r.ub}${r.managed_cap != null ? " (managed cap " + r.managed_cap + ")" : ""}${r.status === "off" ? " (off-list)" : ""}`); });
    if (cf.mode === "maximise") {
      const floor = rows.reduce((s, r) => s + r.lb * (isFinite(r.cost_per_seat) ? r.cost_per_seat : 0), 0), b = num(cf.budget);
      const budget = isNaN(b) ? baseline.spend : b;
      if (floor > budget) msgs.push(`minimum seats cost ${Math.round(floor).toLocaleString()} > budget ${Math.round(budget).toLocaleString()}`);
    } else {
      for (const m of METRICS) {
        const pct = num(cf.targets[m]); if (isNaN(pct)) continue;
        const most = rows.reduce((s, r) => s + outcomesOf(r, r.ub, maxPri)[m], 0), want = baseline[m] * pct / 100;
        if (most + 1e-9 < want) msgs.push(`${m} target ${want.toFixed(1)} > the most achievable ${most.toFixed(1)} under current caps`);
      }
    }
    return msgs;
  }

  /**
   * Optimise. Returns {status, message, totals:{baseline, plan, optimised}, courses:[...], shadow, lp}.
   * highs = the object returned by the `highs` package factory.
   */
  function optimise(table, plan, highs) {
    const cf = config(plan && plan.config), rows = resolve(table, plan && plan.courses, cf);
    const maxPri = Math.max(0, ...rows.map((r) => r.priority_weight || 0));
    const baseline = evaluate(rows, (r) => r.baseline_seats, maxPri);
    const manual = evaluate(rows, (r) => (r.planned_seats != null && !isNaN(r.planned_seats) ? r.planned_seats : r.baseline_seats), maxPri);
    const problems = feasibility(rows, cf, baseline.totals, maxPri);
    const base = { config: cf, baseline: baseline.totals, planned: manual.totals, plannedViolations: manual.violations, flags: rows.filter((r) => r.flags.length).length };
    if (problems.length) return Object.assign(base, { status: "Infeasible", message: problems.join("; "), courses: rows.map((r) => shape(r, null, maxPri)) });

    const { lp, live } = buildModel(rows, cf, baseline.totals, maxPri);
    if (!live.length) return Object.assign(base, { status: "Empty", message: "no course can take seats: every course is off-list, capped at 0, or has no cost", courses: rows.map((r) => shape(r, null, maxPri)) });
    const solve = (text, opts) => {
      try { return highs.solve(text, opts); }
      catch (e) { const err = new Error("solver crashed (" + e.message + "); create a new HiGHS instance before solving again"); err.solverDead = true; throw err; }
    };
    const res = solve(lp, { time_limit: cf.timeLimit, mip_rel_gap: 1e-6 });
    if (res.Status !== "Optimal" && !(res.Status === "Time limit reached" && res.Columns)) {
      return Object.assign(base, { status: res.Status, message: `solver: ${res.Status}`, courses: rows.map((r) => shape(r, null, maxPri)), lp });
    }
    const seats = new Array(rows.length).fill(0);
    live.forEach(({ i }) => { seats[i] = Math.round(res.Columns["x" + i].Primal); });
    const opt = evaluate(rows, (r) => seats[rows.indexOf(r)], maxPri);

    // Shadow prices from the LP relaxation: objective change per unit of each constraint's RHS.
    const rel = solve(buildModel(rows, cf, baseline.totals, maxPri, true).lp, { time_limit: cf.timeLimit });
    const shadow = {};
    if (rel.Status === "Optimal") rel.Rows.forEach((row) => {
      if (row.Name === "budget") shadow.value_per_million = row.Dual * 1e6;
      else if (row.Name.startsWith("t_")) shadow["cost_per_extra_" + row.Name.slice(2)] = row.Dual;
    });
    return Object.assign(base, {
      status: res.Status === "Optimal" ? "Optimal" : "Time limit (best found)", message: "",
      optimised: opt.totals, objective: res.ObjectiveValue, shadow,
      courses: rows.map((r, i) => shape(r, seats[i], maxPri)), lp,
    });
  }

  function shape(r, seats, maxPri) {
    const binding = seats == null ? "" : seats >= r.ub && r.ub > 0
      ? (r.managed_cap != null && r.ub === r.managed_cap ? "managed cap" : r.budget_cap && r.ub < r.max_used ? "course budget" : "max seats")
      : seats > 0 && seats === r.lb ? "min seats" : "";
    const o = seats == null ? null : outcomesOf(r, seats, maxPri);
    return {
      course_code: r.course_code, title: r.title, aqf: r.aqf, lists: r.lists, status: r.status, rto_limit: r.rto_limit, rto_count: r.rto_count,
      managed_cap: r.managed_cap, baseline_seats: r.baseline_seats, planned_seats: r.planned_seats, min_seats: r.lb, max_seats: r.ub,
      seats, delta: seats == null ? null : seats - r.baseline_seats, cost_per_seat: r.cost_per_seat,
      spend: seats == null ? null : seats * (isFinite(r.cost_per_seat) ? r.cost_per_seat : 0),
      completion_rate: r.completion_rate, employment_rate: r.employment_rate, priority_weight: r.priority_weight,
      completions: o && o.completions, employment: o && o.employment, binding, source: r.source, flags: r.flags.join("; "),
    };
  }

  const newPlan = (cfg) => ({ version: 1, created: new Date().toISOString(), config: config(cfg), courses: {} });

  return { DEFAULT_CONFIG, EDITABLE, METRICS, buildCourseTable, resolve, evaluate, buildModel, optimise, newPlan, stlStatus };
});
