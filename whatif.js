/* What-if simulator: multi-year liability, in-year budget triggers, scenario comparison, sensitivity, Monte Carlo.
 * Browser: window.SAWhatIf (needs window.SACalc + window.SASim).  Bun/Node: require("./whatif.js").
 * Pure functions; optimiser seats are passed in.
 *
 * Lock timing (Framework v5.0): course adjustment and AQF reduction lock when the account opens; base rate,
 * indexation, loading, RPL and completion payment apply when the claim is paid. A claim in FY y from a cohort
 * that opened in FY c is priced at
 *     y < effectiveFy ? B (baseline)  :  c < effectiveFy ? H (new claim-time levers, old locked ones)  :  S (scenario)
 * Months run Jul..Jun from forecast.startFy. "Committed" = expected cost of accounts opened, at prices when opened;
 * cash = claims as paid, at the index of the year they're paid. The difference on the indexed share is the uplift.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./calc.js"), require("./sim.js"));
  else root.SAWhatIf = factory(root.SACalc, root.SASim);
})(typeof self !== "undefined" ? self : this, function (C, S) {
  "use strict";

  const MONTHS = ["Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun"];
  const LOCKED = ["adjMultiplier", "courseAdj", "aqfReduction"]; // fixed when the account opens
  const DEFAULTS = {
    name: "scenario", levers: {}, effectiveFy: 0, seats: "baseline", // seats: baseline | planned | optimised
    forecast: {
      startFy: "2026-27", years: 4,
      indexPct: 2.04,            // future yearly indexation (number, or array for FY+1, FY+2, ...)
      pastIndexPct: 2.04,        // for pricing in-flight cohorts that opened before the horizon
      growthPct: 0,              // yearly intake growth
      intakePct: 0,              // one-off intake shift from year 0
      durationMonths: { Bridging: 6, "Skill Set": 6, Course: 6, "Certificate I": 9, "Certificate II": 9, "Certificate III": 15, "Certificate IV": 15, Diploma: 24, "Advanced Diploma": 30 },
      defaultDuration: 12,
      seasonality: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], // Jul..Jun commencement weights
      inFlight: true,            // accounts opened in the prior years still claiming
    },
    budget: null,                // FY commitment budget; null = baseline year-0 commitments
    budgetGrowthPct: 0,
    triggers: [],                // [{name, atPct, action: scale_intake|cut_price|pause, scope: managed|demand|all, amountPct, noticeMonths}]
    uncertainty: { runs: 500, seed: 1, volumeSd: 10, courseVolumeSd: 15, completionSd: 5, indexSd: 0.5 }, // sd in % / % points
  };
  const TRIGGER = { name: "", atPct: 80, action: "scale_intake", scope: "managed", amountPct: 20, noticeMonths: 1 };

  const num = (v, d) => { const n = typeof v === "number" ? v : parseFloat(v); return isFinite(n) ? n : d; };
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function normalise(s = {}) {
    const f = Object.assign({}, DEFAULTS.forecast, s.forecast);
    f.durationMonths = Object.assign({}, DEFAULTS.forecast.durationMonths, s.forecast && s.forecast.durationMonths);
    f.years = Math.max(1, Math.min(10, Math.round(num(f.years, 4))));
    return Object.assign({}, DEFAULTS, s, {
      levers: Object.assign({}, s.levers), forecast: f, effectiveFy: Math.max(0, Math.round(num(s.effectiveFy, 0))),
      triggers: (s.triggers || []).map((t, i) => Object.assign({}, TRIGGER, { name: "trigger " + (i + 1) }, t)),
      uncertainty: Object.assign({}, DEFAULTS.uncertainty, s.uncertainty),
    });
  }

  // ---------- labels ----------
  const startYear = (f) => parseInt(String(f.startFy), 10) || 2026;
  const fyLabel = (f, y) => { const a = startYear(f) + y; return `${a}-${String(a + 1).slice(2)}`; };
  const monthLabel = (f, m) => `${MONTHS[((m % 12) + 12) % 12]} ${startYear(f) + Math.floor((m + 6) / 12)}`;
  const fyOf = (m) => Math.floor(m / 12);

  // ---------- pricing ----------
  /** Per course under one set of levers: unit cost per seat, indexed share of it, completion payment, resolved row. */
  function costs(data, levers) {
    const plan = data.plan || {};
    const priced = data.claims && data.claims.length ? C.priceRows(C.makeContext(data.rates, levers), data.units || {}, data.claims) : null;
    const table = S.buildCourseTable({ rates: data.rates, stl: data.stl, units: data.units || {}, priced, profiles: data.profiles || [], outcomes: data.outcomes || [], cfg: plan.config, scenario: levers });
    const rows = S.resolve(table, plan.courses, plan.config);
    // Indexed part of a unit's subsidy = subsidy × rate×(1+loading) / per_hour (the AQF reduction and concession aren't indexed).
    const idx = {}, tot = {};
    if (priced) for (const r of priced.results) {
      if (!r.ok) continue;
      const before = r.rate * (1 + (r.loading_pct || 0) / 100);
      idx[r.course_code] = (idx[r.course_code] || 0) + (r.per_hour > 0 ? r.subsidy * before / r.per_hour : 0);
      tot[r.course_code] = (tot[r.course_code] || 0) + r.subsidy + r.concession_reimb;
    }
    let a = 0, b = 0;
    for (const c in tot) { a += idx[c]; b += tot[c]; }
    const fallback = b ? a / b : 1; // ponytail: profile-only courses take the portfolio-average indexed share
    const out = {};
    for (const r of rows) {
      const override = isFinite(r.cost_override);
      out[r.course_code] = { row: r, unit: override ? r.cost_override : r.unit_cost, comp: override ? 0 : r.completion_payment,
                             share: tot[r.course_code] ? Math.min(1, idx[r.course_code] / tot[r.course_code]) : fallback };
    }
    return out;
  }

  /** Course list with B/H/S costs and intake. Expensive part (reprices claims 3×); everything after is cheap. */
  function prepare(data, scenario, opts = {}) {
    const scn = normalise(scenario), f = scn.forecast;
    const levers = Object.assign({}, scn.levers), shift = num(levers.volumeGrowthPct, 0);
    delete levers.volumeGrowthPct; // volume is an intake setting here, not a price
    const fix = levers.aqfOverride ? { aqfOverride: levers.aqfOverride } : {};
    const hybrid = Object.assign({}, levers);
    LOCKED.forEach((k) => delete hybrid[k]);
    const P = { B: costs(data, fix), H: costs(data, hybrid), S: costs(data, levers) };
    const mult = 1 + shift / 100;
    const courses = [];
    let uncosted = 0;
    for (const code of Object.keys(P.S)) {
      const s = P.S[code], r = s.row, base = P.B[code].row.baseline_seats || 0;
      let seats;
      if (scn.seats === "planned") seats = r.planned_seats != null && !isNaN(r.planned_seats) ? r.planned_seats : base;
      else if (scn.seats === "optimised") {
        if (!opts.seats) throw new Error(`${scn.name}: seat source "optimised" needs the optimiser's seats per course`);
        seats = num(opts.seats[code], 0);
      } else seats = base;
      if (!seats && !base) continue;
      const p = { B: P.B[code], H: P.H[code], S: s };
      if (!["B", "H", "S"].every((k) => isFinite(p[k].unit))) { uncosted += seats; continue; }
      const cost = {};
      for (const k of ["B", "H", "S"]) cost[k] = { idx: p[k].unit * p[k].share, fix: p[k].unit * (1 - p[k].share), comp: p[k].comp };
      const dur = Math.max(1, Math.round(num(f.durationMonths[r.aqf], f.defaultDuration)));
      courses.push({ code, title: r.title, status: r.status, aqf: r.aqf || "", dur, cr: clamp01(num(r.completion_rate, 0.5)), seats: seats * mult, inflight: base, cost });
    }
    return { scn, courses, uncosted };
  }

  /** Aggregate courses into (status × duration) groups; noise = {courseVol(code), crShift}. */
  function groups(courses, noise) {
    const g = {};
    for (const c of courses) {
      const v = noise ? noise.courseVol(c.code) : 1, cr = noise ? clamp01(c.cr + noise.crShift) : c.cr;
      const k = c.status + "|" + c.dur;
      const G = g[k] || (g[k] = { status: c.status, dur: c.dur, seats: 0, inflight: 0, cr: 0, crIn: 0, B: z(), H: z(), S: z(), inB: z(), inH: z() });
      const n = c.seats * v, m = c.inflight;
      G.seats += n; G.inflight += m; G.cr += n * cr; G.crIn += m * cr;
      for (const p of ["B", "H", "S"]) add(G[p], c.cost[p], n, cr);
      add(G.inB, c.cost.B, m, cr); add(G.inH, c.cost.H, m, cr);
    }
    // to per-seat averages
    return Object.values(g).map((G) => {
      const per = (o, n) => (n ? { idx: o.idx / n, fix: o.fix / n, comp: o.comp / n } : z());
      return { status: G.status, dur: G.dur, seats: G.seats, inflight: G.inflight, cr: G.seats ? G.cr / G.seats : 0, crIn: G.inflight ? G.crIn / G.inflight : 0,
               B: per(G.B, G.seats), H: per(G.H, G.seats), S: per(G.S, G.seats), inB: per(G.inB, G.inflight), inH: per(G.inH, G.inflight) };
    });
    function z() { return { idx: 0, fix: 0, comp: 0 }; }
    function add(t, c, n, cr) { t.idx += n * c.idx; t.fix += n * c.fix; t.comp += n * c.comp * cr; } // comp = expected completion $ per seat
  }

  /** Index level of FY y relative to year 0. shocks[y] adds % points to that year's indexation. */
  function indexer(f, shocks) {
    const pct = (k) => (Array.isArray(f.indexPct) ? num(f.indexPct[Math.min(k - 1, f.indexPct.length - 1)], 0) : num(f.indexPct, 0)) + ((shocks && shocks[k]) || 0);
    const cache = { 0: 1 };
    return function I(y) {
      if (y in cache) return cache[y];
      return (cache[y] = y < 0 ? Math.pow(1 + num(f.pastIndexPct, 0) / 100, y) : I(y - 1) * (1 + pct(y) / 100));
    };
  }

  /** The monthly engine. Returns per-FY and per-month figures. */
  function engine(G, scn, budget, opt = {}) {
    const f = scn.forecast, Y = f.years, H = Y * 12, eff = scn.effectiveFy, I = indexer(f, opt.indexShocks);
    const w = f.seasonality.map((x) => Math.max(0, num(x, 0))), ws = w.reduce((a, b) => a + b, 0) || 1;
    const share = (m) => w[((m % 12) + 12) % 12] / ws;
    const growth = (y) => (1 + num(f.intakePct, 0) / 100) * Math.pow(1 + num(f.growthPct, 0) / 100, y) * ((opt.yearVol && opt.yearVol[y]) || 1);
    const triggers = opt.triggers || scn.triggers;
    const budgetOf = (y) => budget * Math.pow(1 + num(scn.budgetGrowthPct, 0) / 100, y);
    const years = [...Array(Y)].map((_, y) => ({ fy: fyLabel(f, y), budget: budgetOf(y), intake: 0, new_commitments: 0, expected_completions: 0, cash: 0, cash_inflight: 0, index_uplift: 0, completions_paid: 0, exhaust_month: null }));
    const months = [...Array(H)].map((_, m) => ({ month: monthLabel(f, m), fy: fyLabel(f, fyOf(m)), intake: 0, committed: 0, committed_ytd: 0, cash: 0 }));
    const fired = [], active = [];
    let endLiability = 0;
    const ctxFor = (k, c, inflight) => (fyOf(k) < eff ? (inflight ? "inB" : "B") : c < eff ? (inflight ? "inH" : "H") : "S");
    // Spread one cohort's claims over its duration; completion payment lands at the end.
    const book = (g, m, n, pf, inflight) => {
      const c = fyOf(m), cr = inflight ? g.crIn : g.cr;
      for (let k = m; k <= m + g.dur; k++) {
        if (k < 0) continue;
        const p = g[ctxFor(k, c, inflight)], y = fyOf(k);
        const unit = k < m + g.dur ? (n * pf * (p.idx * I(y) + p.fix)) / g.dur : 0;
        const comp = k === m + g.dur ? n * p.comp : 0, amt = unit + comp;
        if (k >= H) { endLiability += amt; continue; }
        years[y].cash += amt; months[k].cash += amt;
        if (inflight) years[y].cash_inflight += amt;
        if (k < m + g.dur) years[y].index_uplift += (n * pf * p.idx * (I(y) - I(c))) / g.dur;
        else years[y].completions_paid += n * cr;
      }
    };
    if (f.inFlight) {
      const back = Math.max(0, ...G.map((g) => g.dur));
      for (let m = -back; m < 0; m++) for (const g of G) if (g.inflight) book(g, m, g.inflight * share(m), 1, true);
    }
    let ytd = 0;
    for (let m = 0; m < H; m++) {
      const y = fyOf(m);
      if (m % 12 === 0) ytd = 0;
      for (const g of G) {
        if (!g.seats) continue;
        let fi = 1, pf = 1;
        for (const a of active) {
          if (m < a.from || m > a.to || !(a.t.scope === "all" || a.t.scope === g.status)) continue;
          const amt = clamp01(num(a.t.amountPct, 0) / 100);
          if (a.t.action === "pause") fi = 0;
          else if (a.t.action === "cut_price") pf *= 1 - amt; // ponytail: scales the whole unit cost, though course adjustment doesn't touch concession
          else fi *= 1 - amt;
        }
        const n = g.seats * growth(y) * share(m) * fi;
        if (!n) continue;
        const p = g[y < eff ? "B" : "S"];
        const commit = n * (pf * (p.idx * I(y) + p.fix) + p.comp);
        months[m].intake += n; months[m].committed += commit;
        years[y].intake += n; years[y].new_commitments += commit; years[y].expected_completions += n * g.cr;
        book(g, m, n, pf, false);
      }
      ytd += months[m].committed; months[m].committed_ytd = ytd;
      const bud = budgetOf(y);
      if (years[y].exhaust_month == null && ytd > bud + 1e-6) years[y].exhaust_month = months[m].month;
      triggers.forEach((t, i) => {
        if (fired.some((x) => x.i === i && x.y === y) || !(ytd >= (num(t.atPct, 100) / 100) * bud)) return;
        const from = m + 1 + Math.max(0, Math.round(num(t.noticeMonths, 0)));
        fired.push({ i, y, name: t.name, fy: years[y].fy, month: months[m].month, effective: from < (y + 1) * 12 ? monthLabel(f, from) : "after FY end" });
        active.push({ t, from, to: (y + 1) * 12 - 1 });
      });
    }
    for (const r of years) r.cost_per_completion = r.expected_completions ? r.new_commitments / r.expected_completions : null;
    const sum = (k) => years.reduce((s, r) => s + r[k], 0);
    return {
      years, months, triggers_fired: fired.map(({ i, y, ...x }) => x),
      totals: { cash: sum("cash"), new_commitments: sum("new_commitments"), index_uplift: sum("index_uplift"), intake: sum("intake"), expected_completions: sum("expected_completions"), end_liability: endLiability },
    };
  }

  /** Year-0 commitments for baseline seats at baseline prices: the default budget. */
  const baselineBudget = (courses) => courses.reduce((s, c) => s + c.inflight * (c.cost.B.idx + c.cost.B.fix + c.cost.B.comp * c.cr), 0);

  // ---------- public API ----------
  /** Run one scenario. opts.seats = {course: seats} for seat source "optimised"; opts.prepared skips repricing. */
  function run(data, scenario, opts = {}) {
    const prep = opts.prepared || prepare(data, scenario, opts), { scn, courses } = prep;
    const budget = scn.budget != null && scn.budget !== "" ? num(scn.budget, 0) : baselineBudget(courses);
    const G = groups(courses), res = engine(G, scn, budget, opts);
    let trigger_savings = null;
    if (scn.triggers.length && opts.attribution !== false) {
      const none = engine(G, scn, budget, { triggers: [] }).totals.new_commitments;
      trigger_savings = { all: none - res.totals.new_commitments, each: scn.triggers.map((t, i) => ({ name: t.name, saved: engine(G, scn, budget, { triggers: scn.triggers.filter((_, j) => j !== i) }).totals.new_commitments - res.totals.new_commitments })) };
    }
    return Object.assign({ name: scn.name, budget, courses: courses.length, uncosted_seats: prep.uncosted, trigger_savings }, res);
  }

  function rng(seed) { // mulberry32 + Box-Muller
    let a = (num(seed, 1) >>> 0) || 1;
    const u = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    return { u, normal: () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u()) };
  }
  const pct = (xs, p) => { const s = xs.slice().sort((a, b) => a - b), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
  const band = (xs) => ({ p10: pct(xs, 0.1), p50: pct(xs, 0.5), p90: pct(xs, 0.9) });

  /** Monte Carlo over intake volume (yearly + per course), completion rate and future indexation. */
  function monteCarlo(data, scenario, opts = {}) {
    const prep = opts.prepared || prepare(data, scenario, opts), { scn, courses } = prep, u = scn.uncertainty, Y = scn.forecast.years;
    const budget = scn.budget != null && scn.budget !== "" ? num(scn.budget, 0) : baselineBudget(courses);
    const R = rng(u.seed), runs = Math.max(10, Math.min(5000, Math.round(num(opts.runs != null ? opts.runs : u.runs, 500))));
    const pos = (x) => Math.max(0, x);
    const out = { cash: [], commit: [], over: new Array(Y).fill(0), totalCash: [], totalCommit: [], end: [], exhaust: [] };
    for (let r = 0; r < runs; r++) {
      const cv = {};
      courses.forEach((c) => { cv[c.code] = pos(1 + (R.normal() * num(u.courseVolumeSd, 0)) / 100); });
      const noise = { courseVol: (code) => cv[code], crShift: (R.normal() * num(u.completionSd, 0)) / 100 };
      const yearVol = [...Array(Y)].map(() => pos(1 + (R.normal() * num(u.volumeSd, 0)) / 100));
      const indexShocks = [...Array(Y)].map((_, k) => (k ? R.normal() * num(u.indexSd, 0) : 0));
      const res = engine(groups(courses, noise), scn, budget, { yearVol, indexShocks });
      res.years.forEach((y, i) => {
        (out.cash[i] = out.cash[i] || []).push(y.cash); (out.commit[i] = out.commit[i] || []).push(y.new_commitments);
        if (y.new_commitments > y.budget) out.over[i]++;
      });
      out.totalCash.push(res.totals.cash); out.totalCommit.push(res.totals.new_commitments); out.end.push(res.totals.end_liability);
    }
    return {
      name: scn.name, runs, seed: u.seed,
      years: out.cash.map((xs, i) => ({ fy: fyLabel(scn.forecast, i), cash: band(xs), new_commitments: band(out.commit[i]), p_over_budget: out.over[i] / runs })),
      totals: { cash: band(out.totalCash), new_commitments: band(out.totalCommit), end_liability: band(out.end) },
    };
  }

  const METRICS = {
    cash: (r) => r.totals.cash, new_commitments: (r) => r.totals.new_commitments, end_liability: (r) => r.totals.end_liability,
    fy1_cash: (r) => r.years[0].cash, fy1_commitments: (r) => r.years[0].new_commitments,
  };
  /** One lever at a time, low and high; returns tornado rows sorted by swing. */
  function sensitivity(data, scenario, opts = {}) {
    const scn = normalise(scenario), metric = METRICS[opts.metric || "cash"];
    if (!metric) throw new Error(`metric must be one of ${Object.keys(METRICS).join(", ")}`);
    const lv = scn.levers, f = scn.forecast, mul = num(lv.adjMultiplier, 1), idx = (d) => (Array.isArray(f.indexPct) ? f.indexPct.map((x) => num(x, 0) + d) : num(f.indexPct, 0) + d);
    const ramp = (up) => [...Array(12)].map((_, i) => (up ? i + 1 : 12 - i));
    const V = [ // [lever, low label, high label, (scn, side) => mutate; side = -1 | +1, repricing?]
      ["Indexation this year (extra)", "−1 pt", "+1 pt", (s, d) => { s.levers.indexExtraPct = num(lv.indexExtraPct, 0) + d; }, true],
      ["Future indexation", "−1 pt/yr", "+1 pt/yr", (s, d) => { s.forecast.indexPct = idx(d); }],
      ["Intake volume", "−10%", "+10%", (s, d) => { s.forecast.intakePct = num(f.intakePct, 0) + 10 * d; }],
      ["Intake growth", "−5 pt/yr", "+5 pt/yr", (s, d) => { s.forecast.growthPct = num(f.growthPct, 0) + 5 * d; }],
      ["Course adjustments", "−10%", "+10%", (s, d) => { s.levers.adjMultiplier = mul * (1 + 0.1 * d); }, true],
      ["Completion rate", "−10 pt", "+10 pt", (s, d) => { s._cr = 0.1 * d; }],
      ["RPL payment (Cert III+)", "0%", "100%", (s, d) => { s.levers.rplPct = d < 0 ? 0 : 100; }, true],
      ["Course duration", "−25%", "+25%", (s, d) => { s.forecast.durationMonths = Object.fromEntries(Object.entries(f.durationMonths).map(([k, v]) => [k, Math.max(1, Math.round(v * (1 + 0.25 * d)))])); }, true],
      ["Seasonality", "back-loaded", "front-loaded", (s, d) => { s.forecast.seasonality = ramp(d < 0); }],
    ];
    const base = opts.prepared || prepare(data, scn, opts);
    const evalScn = (s, reprice) => {
      const prep = reprice ? prepare(data, s, opts) : Object.assign({}, base, { scn: normalise(s) });
      if (s._cr) prep.courses = prep.courses.map((c) => Object.assign({}, c, { cr: clamp01(c.cr + s._cr) }));
      return metric(run(data, s, Object.assign({}, opts, { prepared: prep, attribution: false })));
    };
    const b = metric(run(data, scn, Object.assign({}, opts, { prepared: base, attribution: false })));
    const rows = V.map(([lever, lowLabel, highLabel, fn, reprice]) => {
      const vals = [-1, 1].map((d) => { const s = clone(scn); fn(s, d); return evalScn(s, reprice); });
      return { lever, low_label: lowLabel, high_label: highLabel, low: vals[0], high: vals[1], delta_low: vals[0] - b, delta_high: vals[1] - b };
    });
    rows.sort((x, y) => Math.max(Math.abs(y.delta_low), Math.abs(y.delta_high)) - Math.max(Math.abs(x.delta_low), Math.abs(x.delta_high)));
    return { name: scn.name, metric: opts.metric || "cash", base: b, rows };
  }

  /** Several scenarios side by side. opts.seats = {scenarioName: {course: seats}}; opts.mc = true adds P10/P50/P90. */
  function compare(data, scenarios, opts = {}) {
    return scenarios.map((s) => {
      const scn = normalise(s), prep = prepare(data, scn, { seats: opts.seats && opts.seats[scn.name] });
      const r = run(data, scn, { prepared: prep });
      const mc = opts.mc ? monteCarlo(data, scn, { prepared: prep, runs: opts.runs }) : null;
      return { name: scn.name, result: r, mc };
    });
  }

  /** Flat rows for export (XLSX in the browser and MCP). compared = compare() output. */
  function exportRows(compared, sens) {
    const r2 = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v * 100) / 100 : v);
    const flat = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r2(v)]));
    const out = { Compare: [], Years: [], Months: [], Triggers: [], Ranges: [], Sensitivity: [] };
    for (const { name, result: r, mc } of compared) {
      const t = r.totals;
      out.Compare.push(flat({ scenario: name, budget: r.budget, cash: t.cash, new_commitments: t.new_commitments, index_uplift: t.index_uplift, end_liability: t.end_liability,
        intake: t.intake, expected_completions: t.expected_completions, cost_per_completion: t.expected_completions ? t.new_commitments / t.expected_completions : null,
        first_budget_exhausted: (r.years.find((y) => y.exhaust_month) || {}).exhaust_month || "", triggers_fired: r.triggers_fired.length,
        trigger_savings: r.trigger_savings ? r.trigger_savings.all : 0, cash_p10: mc ? mc.totals.cash.p10 : "", cash_p50: mc ? mc.totals.cash.p50 : "", cash_p90: mc ? mc.totals.cash.p90 : "" }));
      r.years.forEach((y) => out.Years.push(flat(Object.assign({ scenario: name }, y))));
      r.months.forEach((m) => out.Months.push(flat(Object.assign({ scenario: name }, m))));
      r.triggers_fired.forEach((x) => out.Triggers.push(Object.assign({ scenario: name }, x)));
      if (mc) mc.years.forEach((y) => out.Ranges.push(flat({ scenario: name, fy: y.fy, cash_p10: y.cash.p10, cash_p50: y.cash.p50, cash_p90: y.cash.p90,
        commitments_p10: y.new_commitments.p10, commitments_p50: y.new_commitments.p50, commitments_p90: y.new_commitments.p90, p_over_budget: y.p_over_budget })));
    }
    if (sens) sens.rows.forEach((x) => out.Sensitivity.push(flat({ scenario: sens.name, metric: sens.metric, lever: x.lever, low: x.low_label, high: x.high_label, change_low: x.delta_low, change_high: x.delta_high })));
    return out;
  }
  function workbook(XLSX, compared, sens) {
    const wb = XLSX.utils.book_new();
    for (const [sheet, rows] of Object.entries(exportRows(compared, sens))) if (rows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheet);
    return wb;
  }

  return { DEFAULTS, MONTHS, METRICS, normalise, prepare, run, monteCarlo, sensitivity, compare, exportRows, workbook, fyLabel, monthLabel };
});
