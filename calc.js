/* SA Training Fee Framework calculator core. Pure functions, no DOM.
 * Browser: window.SACalc.  Bun/Node: require("./calc.js").
 *
 * Per unit (Framework v5.0 §2):
 *   perHour  = max(0, base[FOE] × indexFactor × (1 + loading) − aqfReduction)   (no AQF reduction if fee-exempt)
 *   subsidy  = perHour × courseAdj% × hours × rplFactor
 * Per (student, course) with qualification issued: completion payment.
 * Concession reimbursement/hr = min(max(stdFee − minFee, 0), maxReimb).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SACalc = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LEVELS = ["Bridging", "Skill Set", "Course", "Certificate I", "Certificate II",
                  "Certificate III", "Certificate IV", "Diploma", "Advanced Diploma"];
  const RPL_HALF = new Set(["Certificate III", "Certificate IV", "Diploma", "Advanced Diploma", "Course"]);

  // Column-name synonyms for uploads (lower-cased, non-alphanumerics stripped before matching).
  const SCHEMAS = {
    units: {
      unit_code: ["unitcode", "unit", "unitid", "code", "moduleid", "subjectid"],
      foe_code: ["foecode", "foe", "fieldofeducation", "fieldofeducationid", "asced", "ascedcode", "foeid"],
      payment_hours: ["paymenthours", "hours", "nominalhours", "sahours", "hrs"],
      unit_name: ["unitname", "name", "title", "unittitle", "description"],
    },
    claims: {
      course_code: ["coursecode", "course", "qualificationcode", "qualcode", "programid", "qualification", "courseid"],
      unit_code: ["unitcode", "unit", "unitid", "moduleid", "subjectid"],
      postcode: ["postcode", "deliverypostcode", "pcode", "deliverylocationpostcode"],
      suburb: ["suburb", "locality", "deliverysuburb", "town"],
      student_id: ["studentid", "student", "learnerid", "participantid", "clientid", "usi", "trainingaccountid", "accountid"],
      result_code: ["resultcode", "result", "outcome", "outcomeid", "outcomeidentifier"],
      hours: ["hours", "paymenthours", "hoursoverride"],
      concession: ["concession", "concessionflag", "isconcession"],
      fee_exempt: ["feeexempt", "exempt", "exemption", "guardianship"],
      std_fee_per_hour: ["stdfeeperhour", "standardfeeperhour", "feeperhour", "coursefeeperhour", "stdfee"],
      qualification_issued: ["qualificationissued", "completed", "completion", "qualissued", "issued"],
      volume: ["volume", "count", "weight", "multiplier", "students", "enrolments", "n"],
      aqf_level: ["aqflevel", "aqf", "level"],
      provider_id: ["providerid", "provider", "rto", "rtoid", "rtocode", "tradingname", "organisationid", "toid"],
    },
  };
  const REQUIRED = { units: ["unit_code", "foe_code", "payment_hours"], claims: ["course_code", "unit_code", "postcode"] };

  const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const code = (s) => String(s == null ? "" : s).trim().toUpperCase();
  const pc = (s) => { const t = String(s == null ? "" : s).trim().replace(/\.0+$/, ""); return /^\d{3}$/.test(t) ? "0" + t : t; };
  const num = (s) => { if (s == null || s === "") return NaN; return typeof s === "number" ? s : parseFloat(String(s).replace(/[$,%\s]/g, "")); };
  const cents = (v) => Math.round(v * 100) / 100; // claims are paid per unit, in cents
  const truthy = (s) => /^(y|yes|true|1|t|x)$/i.test(String(s == null ? "" : s).trim());

  /** Map each schema field to a column header. Returns {map, missing}. */
  function mapHeaders(headers, kind) {
    const schema = SCHEMAS[kind], map = {}, used = new Set();
    for (const field of Object.keys(schema)) {
      const want = [norm(field), ...schema[field]];
      const h = headers.find((h) => !used.has(h) && want.includes(norm(h)));
      if (h !== undefined) { map[field] = h; used.add(h); }
    }
    return { map, missing: REQUIRED[kind].filter((f) => !(f in map)) };
  }

  /** AQF level from course code + name; null when it can't be told (flag, never guess). */
  function classifyAqf(courseCode, name) {
    const n = String(name || ""), c = code(courseCode);
    if (/Advanced Diploma/i.test(n)) return "Advanced Diploma";
    if (/Graduate (Certificate|Diploma)/i.test(n)) return null; // not priced in v5.0 tables
    if (/Diploma/i.test(n)) return "Diploma";
    if (/Certificate IV\b/i.test(n)) return "Certificate IV";
    if (/Certificate III\b/i.test(n)) return "Certificate III";
    if (/Certificate II\b/i.test(n)) return "Certificate II";
    if (/Certificate I\b/i.test(n)) return "Certificate I";
    if (/skill\s*set/i.test(n) || /SS\d{5}$/.test(c) || /^SSDIS/.test(c)) return "Skill Set";
    if (/^Course in\b/i.test(n) || /Migrant Gap/i.test(n)) return "Course";
    if (/Bridging|Enabling|Skill Cluster/i.test(n)) return "Bridging";
    return null;
  }

  /** Merge published rates with scenario levers into one pricing context. */
  function makeContext(rates, scenario) {
    const s = scenario || {};
    const pick = (base, over) => Object.assign({}, base, over || {});
    const extra = num(s.indexExtraPct) || 0;
    return {
      rates,
      indexFactor: (s.indexFactor != null && s.indexFactor !== "" ? num(s.indexFactor) : rates.indexFactor) * (1 + extra / 100),
      aqfReduction: pick(rates.aqfReduction, s.aqfReduction),
      completion: pick(rates.completion, s.completion),
      locationLoading: s.locationLoading || {},          // {"Remote Regional": 30} overrides table %
      rplFactor: s.rplPct != null && s.rplPct !== "" ? num(s.rplPct) / 100 : 0.5,
      minFee: s.minFee != null && s.minFee !== "" ? num(s.minFee) : rates.concession.minFee,
      maxReimb: s.maxReimb != null && s.maxReimb !== "" ? num(s.maxReimb) : rates.concession.maxReimb,
      adjMultiplier: s.adjMultiplier != null && s.adjMultiplier !== "" ? num(s.adjMultiplier) : 1,
      courseAdj: s.courseAdj || {},                        // {code: pct}
      aqfOverride: s.aqfOverride || {},                    // {code: level}
      volumeFactor: 1 + (num(s.volumeGrowthPct) || 0) / 100,
    };
  }

  function courseInfo(ctx, courseCode, rowAqf) {
    const c = code(courseCode), rec = ctx.rates.courses[c];
    const aqf = (rowAqf && LEVELS.includes(rowAqf) && rowAqf) || ctx.aqfOverride[c] ||
                (rec ? classifyAqf(c, rec[0]) : null);
    const adj = c in ctx.courseAdj ? ctx.courseAdj[c] : rec ? rec[1] : null;
    return { code: c, name: rec ? rec[0] : "", aqf, adj: adj == null ? null : adj * ctx.adjMultiplier, known: !!rec };
  }

  /** {loading (fraction), location, error} for a postcode (+ optional suburb). */
  function loadingFor(ctx, postcode, suburb) {
    const list = ctx.rates.postcodes[pc(postcode)];
    if (!list) return { loading: null, location: "", error: "unknown postcode" };
    let hits = list;
    const sb = code(suburb);
    if (sb) {
      const exact = list.filter((r) => r[0] === sb);
      hits = exact.length ? exact : list.filter((r) => r[0].startsWith(sb + " ") || r[0].startsWith(sb + "("));
      if (!hits.length) return { loading: null, location: "", error: `suburb ${sb} not in postcode ${pc(postcode)}` };
    }
    // Ambiguous only if the suburbs' *loadings* differ (e.g. 5211 mixes Metro/Regional labels, both 0%).
    const pctOf = (r) => (r[2] in ctx.locationLoading ? num(ctx.locationLoading[r[2]]) : r[3]);
    const pcts = [...new Set(hits.map(pctOf))];
    if (pcts.length > 1) return { loading: null, location: "", error: `postcode ${pc(postcode)} has mixed loadings; give a suburb` };
    return { loading: pcts[0] / 100, location: [...new Set(hits.map((r) => r[2]))].join(" / "),
             region: [...new Set(hits.map((r) => r[1]))].join(" / "), error: null };
  }

  /** Price one unit-level row. Money values are per row × volume. */
  function priceRow(ctx, units, raw) {
    const errors = [];
    const u = units[code(raw.unit_code)];
    const course = courseInfo(ctx, raw.course_code, raw.aqf_level);
    const loc = loadingFor(ctx, raw.postcode, raw.suburb);
    const volume = (raw.volume === undefined || raw.volume === "" ? 1 : num(raw.volume)) * ctx.volumeFactor;

    if (!u) errors.push("unknown unit");
    if (!course.known && !(code(raw.course_code) in ctx.courseAdj)) errors.push("course not on Attachment 2");
    if (!course.aqf) errors.push("AQF level unknown");
    if (loc.error) errors.push(loc.error);
    if (!(volume >= 0)) errors.push("bad volume");

    const hoursOverride = num(raw.hours);
    const hours = !isNaN(hoursOverride) ? hoursOverride : u ? u.hours : NaN;
    const base = u ? ctx.rates.base[u.foe] : null;
    if (u && !base) errors.push(`FOE ${u.foe} not on Attachment 1`);
    if (!(hours >= 0)) errors.push("no payment hours");

    const exempt = truthy(raw.fee_exempt), concession = truthy(raw.concession);
    const aqfRed = course.aqf ? ctx.aqfReduction[course.aqf] : NaN;
    const result = code(raw.result_code);
    const rpl = result === "51" || result === "52";
    const rplFactor = rpl ? (RPL_HALF.has(course.aqf) ? ctx.rplFactor : 0) : 1;

    const out = {
      student_id: raw.student_id == null ? "" : String(raw.student_id), provider_id: raw.provider_id == null ? "" : String(raw.provider_id).trim(), course_code: course.code, course_name: course.name,
      aqf: course.aqf || "", unit_code: code(raw.unit_code), unit_name: u ? u.name : "", foe: u ? u.foe : "",
      postcode: pc(raw.postcode), location: loc.location, region: loc.region || "", loading_pct: loc.loading == null ? "" : loc.loading * 100,
      hours, volume, result_code: result, rpl, concession, exempt,
      rate: NaN, per_hour: NaN, course_adj_pct: course.adj, subsidy: 0, concession_reimb: 0, student_fee: 0,
      qualification_issued: truthy(raw.qualification_issued), errors, ok: false,
    };
    if (errors.length) return out;

    out.ok = true;
    out.rate = base[1] * ctx.indexFactor;
    const beforeReduction = out.rate * (1 + loc.loading);
    out.per_hour = Math.max(0, beforeReduction - (exempt ? 0 : aqfRed));
    if (beforeReduction - aqfRed < 0 && !exempt) errors.push("negative rate clamped to $0");
    out.subsidy = cents(out.per_hour * (course.adj / 100) * hours * rplFactor * volume);

    // Student fee: std fee defaults to the AQF reduction (the Framework's assumed course fee), floor = minFee.
    const stdIn = num(raw.std_fee_per_hour);
    const std = Math.max(isNaN(stdIn) ? aqfRed : stdIn, ctx.minFee);
    const reimb = concession && !exempt ? Math.min(Math.max(std - ctx.minFee, 0), ctx.maxReimb) : 0;
    out.std_fee_per_hour = std;
    out.concession_reimb = cents(reimb * hours * volume);
    out.student_fee = exempt ? 0 : cents((std - reimb) * hours * volume);
    return out;
  }

  /** Price many rows; completion paid once per (student, course) with qualification issued. */
  function priceRows(ctx, units, rows) {
    const results = rows.map((r) => priceRow(ctx, units, r));
    const completions = new Map(), pricedKeys = new Set();
    results.forEach((r, i) => { if (r.ok) pricedKeys.add((r.student_id || "#row" + i) + "|" + r.course_code); });
    results.forEach((r, i) => {
      if (!r.qualification_issued || !r.aqf) return;
      const key = (r.student_id || "#row" + i) + "|" + r.course_code;
      if (!completions.has(key)) completions.set(key, { course: r.course_code, aqf: r.aqf, region: r.region, location: r.location, amount: (ctx.completion[r.aqf] || 0) * r.volume });
    });

    const blank = () => ({ rows: 0, hours: 0, subsidy: 0, completion: 0, concession: 0, govt: 0, student: 0 });
    const totals = blank(), byCourse = {}, byAqf = {}, byRegion = {};
    const add = (bucket, key, f) => { f(bucket[key] || (bucket[key] = blank())); };
    for (const r of results) {
      const f = (t) => { t.rows += 1; if (r.ok) { t.hours += r.hours * r.volume; t.subsidy += r.subsidy; t.concession += r.concession_reimb; t.student += r.student_fee; } };
      f(totals); add(byCourse, r.course_code, f); add(byAqf, r.aqf || "(unknown)", f); add(byRegion, r.location || "(unknown)", f);
    }
    for (const c of completions.values()) {
      const f = (t) => { t.completion += c.amount; };
      f(totals); add(byCourse, c.course, f); add(byAqf, c.aqf, f); add(byRegion, c.location || "(unknown)", f);
    }
    for (const t of [totals, ...Object.values(byCourse), ...Object.values(byAqf), ...Object.values(byRegion)])
      t.govt = t.subsidy + t.completion + t.concession;
    const errorRows = results.filter((r) => !r.ok);
    // Completion is a course-level payment, so it is paid even if that student's unit rows failed; flag those for review.
    const completionsWithoutUnits = [...completions.keys()].filter((k) => !pricedKeys.has(k)).length;
    return { results, totals, byCourse, byAqf, byRegion, completions: completions.size, completionsWithoutUnits, errorCount: errorRows.length };
  }

  /** Build the units lookup from uploaded rows + header map. Returns {units, errors}. */
  function buildUnits(rows, map) {
    const units = {}, errors = [];
    rows.forEach((r, i) => {
      const c = code(r[map.unit_code]), foe = String(r[map.foe_code] == null ? "" : r[map.foe_code]).trim().replace(/\.0+$/, "").padStart(6, "0");
      const hours = num(r[map.payment_hours]);
      if (!c) return;
      if (!/^\d{6}$/.test(foe) || isNaN(hours)) { errors.push({ row: i + 2, unit: c, error: "bad FOE code or hours" }); return; }
      units[c] = { foe, hours, name: map.unit_name ? String(r[map.unit_name] || "") : "" };
    });
    return { units, errors };
  }

  /** Rename uploaded claim rows to schema field names. */
  function remap(rows, map) {
    return rows.map((r) => { const o = {}; for (const f in map) o[f] = r[map[f]]; return o; });
  }

  return { LEVELS, SCHEMAS, REQUIRED, mapHeaders, classifyAqf, makeContext, loadingFor, priceRow, priceRows, buildUnits, remap, courseInfo };
});
