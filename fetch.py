#!/usr/bin/env python3
"""Pull the current SA Skills subsidy docs + TAFE SA fee-free fees.

  python3 fetch.py              # download new docs, rebuild data/*.csv, report changes
  python3 fetch.py --self-test  # parser asserts only, no network
"""
import csv, datetime, gzip, hashlib, json, re, ssl, subprocess, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DOCS, DATA, MANIFEST = ROOT / "docs", ROOT / "data", ROOT / "manifest.json"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36"
FFW_PAGE = "https://providers.skills.sa.gov.au/tools/training-fee-framework"
STL_PAGE = "https://providers.skills.sa.gov.au/subsidised-training-list"
STL_BASE = "https://skills.sa.gov.au/assets/uploads/downloads/"
TAFE_PAGE = "https://www.tafesa.edu.au/courses/fee-free-tafe-courses"

# One row per line in `pdftotext -layout` output.
ROW = {
    "base_rates": (re.compile(r"^\s*(\d{6})\s{2,}(.+?)\s{2,}\$([\d,.]+)\s+(\d{1,2}/\d{1,2}/\d{4})\s*$"),
                   ["foe_code", "foe_name", "rate_per_hour", "effective_from"]),
    "course_adjustments": (re.compile(r"^\s*([A-Z0-9]{5,12})\s{2,}(.+?)\s{2,}(\d+(?:\.\d+)?)\s*$"),
                           ["course_code", "course_name", "adjustment_pct"]),
    "postcode_loading": (re.compile(r"^\s*(\d{4})\s{2,}(.+?)\s{2,}(Regional|Metro)\s{2,}(.+?)\s{2,}(\d+)%\s*$"),
                         ["postcode", "suburb", "regional_metro", "location", "loading_pct"]),
}
KIND = {"Base-Rates": "base_rates", "Course-Adjustments": "course_adjustments", "Post-Code-Mapping": "postcode_loading"}
FEE_TIERS = ("Concession", "Subsidised", "Full Fee")


def _ssl_context():
    """Python's default bundle (/etc/ssl/cert.pem) lacks newer roots such as Sectigo R46, which
    tafesa.edu.au chains to. Add the macOS system roots; verification stays on."""
    ctx = ssl.create_default_context()
    try:
        pem = subprocess.run(["security", "find-certificate", "-a", "-p",
                              "/System/Library/Keychains/SystemRootCertificates.keychain"],
                             capture_output=True, text=True).stdout
        if pem:
            ctx.load_verify_locations(cadata=pem)
    except FileNotFoundError:
        pass  # not macOS
    return ctx


SSL = _ssl_context()


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=60, context=SSL) as r:
        body = r.read()
        return gzip.decompress(body) if r.headers.get("Content-Encoding") == "gzip" else body


def html(url):
    return get(url).decode("utf-8", "replace")


def version(name):
    m = re.search(r"v(\d+)\.(\d+)", name)
    return (int(m[1]), int(m[2])) if m else (0, 0)


def framework_docs(page):
    """Latest version of each doc (highest vX.Y on the page)."""
    best = {}
    for url in set(re.findall(r'href="(https?://[^"]+\.pdf)"', page, re.I)):
        name = url.rsplit("/", 1)[1]
        if "Training-Fee-Framework" not in name:
            continue
        kind = next((k for key, k in KIND.items() if key in name), None)
        if kind is None:
            if "Attachment" in name:
                continue  # retired v1.x attachments (prescribed fees, concession list)
            kind = "framework"
        v = version(name)
        if v > best.get((kind, v[0]), ("", (-1, -1)))[1]:
            best[(kind, v[0])] = (url, v)
    majors = sorted({major for _, major in best}, reverse=True)[:1]
    return [(kind, url, v) for (kind, major), (url, v) in sorted(best.items()) if major in majors]


def stl_docs(page):
    m = re.search(r"Subsidised Training List (\d+\.\d+)", page)
    if not m:
        sys.exit("STL version not found on " + STL_PAGE)
    ver, out = m[1], []
    for part in ("TPL", "VSS-List", "STAL"):
        name = f"STL-{ver}-{part}.pdf"
        for url in (STL_BASE + "myTraining/" + name, STL_BASE + name):
            try:
                urllib.request.urlopen(urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA}), timeout=30, context=SSL)
                out.append((f"stl_{part.lower()}", url, ver))
                break
            except Exception:
                continue
        else:
            print(f"  ! {name} not found at either path")
    out.append(("managed_course_list", "https://providers.skills.sa.gov.au/file/tools/managed-course-list", ver))
    return out


def parse_pdf(path, kind):
    rx, _ = ROW[kind]
    text = subprocess.run(["pdftotext", "-layout", str(path), "-"], capture_output=True, text=True, check=True).stdout
    rows, missed, prev = [], 0, ""
    for line in text.splitlines():
        m = rx.match(line)
        if m:
            row = [g.strip() for g in m.groups()]
            # Att 3 wraps "Moderately Accessible" onto the line above, leaving just "Regional" in the row.
            if kind == "postcode_loading" and re.fullmatch(r"\s{20,}(\S.*)", prev) and not rx.match(prev):
                row[3] = prev.strip() + " " + row[3]
            rows.append(row)
        elif rows and re.match(r"^\s*[A-Z0-9]{4,12}\s{2,}\S", line) and "Code" not in line:
            missed += 1  # looks like a data row but didn't parse (wrapped name etc.)
        prev = line
    return rows, missed


def indexation(text):
    """Framework Table 1: base rates include indexation to 2022-23; later years compound on top.
    Returns (latest_year, factor)."""
    years = re.findall(r"^\s*(20\d\d-\d\d)\s+(\d+\.\d+)%\s+\d{1,2}/\d{1,2}/\d{4}", text, re.M)
    factor = 1.0
    for _, pct in years:
        factor *= 1 + float(pct) / 100
    return (years[-1][0], factor) if years else (None, 1.0)


# Framework v5.0 values; used only if the tables can't be read from a future PDF (a warning is printed).
V5_AQF = {"Bridging": 0.50, "Skill Set": 3.25, "Course": 2.75, "Certificate I": 0.50, "Certificate II": 0.50,
          "Certificate III": 2.75, "Certificate IV": 2.75, "Diploma": 3.25, "Advanced Diploma": 3.25}
V5_COMPLETION = {"Bridging": 0, "Skill Set": 0, "Course": 200, "Certificate I": 0, "Certificate II": 0,
                 "Certificate III": 200, "Certificate IV": 200, "Diploma": 400, "Advanced Diploma": 400}


def _level(label):
    if label.startswith("Bridging"):
        return "Bridging"
    if "Skill Set" in label:
        return "Skill Set"
    if label.startswith("Course"):
        return "Course"
    return label if label in V5_AQF else None


def framework_tables(text):
    """AQF reduction (Table 3), completion payment (Table 4), concession min fee / max reimbursement (§11)."""
    def table(start, end, fallback, name):
        m = re.search(start + r"(.*?)" + end, text, re.S)
        found = {}
        for label, amount in re.findall(r"^\s*(\S.*?\S)\s{2,}\$([\d.]+)\s*$", m[1] if m else "", re.M):
            if (lvl := _level(label.strip())):
                found[lvl] = float(amount)
        if set(found) != set(fallback):
            print(f"  ! {name}: read {len(found)}/{len(fallback)} levels from the Framework, using v5.0 values for the rest")
        return {**fallback, **found}
    aqf = table(r"AQF Reduction \(Assumed", r"Table 3", V5_AQF, "AQF reduction")
    completion = table(r"Completion Payment\s*\n", r"Table 4", V5_COMPLETION, "completion payment")
    m = re.search(r"minus \$([\d.]+) per hour of training delivered to a maximum of\s+\$([\d.]+)", text)
    if not m:
        print("  ! concession rule not found in Framework, using v5.0 values ($0.50 min, $1.35 max)")
    return {"aqfReduction": aqf, "completion": completion,
            "concession": {"minFee": float(m[1]) if m else 0.50, "maxReimb": float(m[2]) if m else 1.35}}


STL_ROW = re.compile(r"^\s*([A-Z0-9]{5,12})\s{2,}(\S.*?)\s*$")
STL_SECTIONS = {"Demand Driven Courses": "demand", "Managed Courses": "managed",
                "VSS General": "general", "VSS Training Contract": "contract"}


def parse_stl_list(text, list_name):
    """TPL / STAL / VSS PDF text -> [[code, title, list, section]]. Wrapped titles are indented continuation lines."""
    rows, section = [], None
    for line in text.splitlines():
        s = line.strip()
        if s in STL_SECTIONS:
            section = STL_SECTIONS[s]
        elif section and (m := STL_ROW.match(line)):
            rows.append([m[1], m[2], list_name, section])
        elif section and rows and re.match(r"^\s{15,}\S", line):
            rows[-1][1] += " " + s
    return rows


def parse_managed_limits(text):
    """Managed Course List -> {(list, code): (limit, group)}. A limit printed on its own line between two
    codes (e.g. CUA51120 / 10 / CUA51125) is one limit shared by both: same group."""
    lines = [l for l in text.splitlines() if l.strip()]
    out, section, pending, shared = {}, None, None, None
    for i, line in enumerate(lines):
        if "Training Priority List" in line and "Managed" in line:
            section, pending, shared = "TPL", None, None
            continue
        if "Traineeship and Apprenticeship List" in line and "Managed" in line:
            section, pending, shared = "STAL", None, None
            continue
        if not section:
            continue
        if (m := re.fullmatch(r"\s{20,}(\d+)\s*", line)) and pending:
            out[(section, pending)] = (int(m[1]), pending)
            shared, pending = (int(m[1]), pending), None
            continue
        m = re.match(r"^\s*([A-Z0-9]{5,12})\s{2,}(.+?)(?:\s{2,}(\d+))?\s*$", line)
        if m and m[1] != "Course":
            nxt = lines[i + 1] if i + 1 < len(lines) else ""
            if m[3]:
                out[(section, m[1])], pending = (int(m[3]), m[1]), None
            elif shared and not re.fullmatch(r"\s{20,}\d+\s*", nxt) and STL_ROW.match(lines[i - 1]) is None:
                out[(section, m[1])], pending = shared, None   # second code of a shared pair
            else:
                pending = m[1]
            shared = None
        elif not re.fullmatch(r"\s{20,}\d+\s*", line):
            shared = None if not line.startswith(" " * 15) else shared
    return out


def write_stl(paths, ver):
    """data/stl_courses.csv + data/stl.js from the STL PDFs (course status and managed limits)."""
    text = lambda k: subprocess.run(["pdftotext", "-layout", str(paths[k]), "-"], capture_output=True, text=True, check=True).stdout
    rows = parse_stl_list(text("stl_tpl"), "TPL") + parse_stl_list(text("stl_stal"), "STAL") + parse_stl_list(text("stl_vss-list"), "VSS")
    limits = parse_managed_limits(text("managed_course_list"))
    for r in rows:
        limit, group = limits.get((r[2], r[0]), ("", ""))
        r += [limit, group]
    managed = {(r[2], r[0]) for r in rows if r[3] == "managed"}
    for key in managed ^ set(limits):
        print(f"  ! managed list mismatch: {key[0]} {key[1]} " + ("has no RTO limit" if key in managed else "has a limit but isn't in the list's Managed section"))
    write_csv(DATA / "stl_courses.csv", ["course_code", "title", "list", "section", "rto_limit", "limit_group"], rows)
    courses = {}
    for code, title, lst, section, limit, group in rows:
        c = courses.setdefault(code, {"title": title, "lists": {}})
        c["lists"][lst] = {"section": section, **({"limit": limit, "group": group} if limit != "" else {})}
    (DATA / "stl.js").write_text("window.SA_STL = " + json.dumps({"version": ver, "courses": courses}, separators=(",", ":")) + ";\n")
    counts = {}
    for r in rows:
        counts[f"{r[2]} {r[3]}"] = counts.get(f"{r[2]} {r[3]}", 0) + 1
    print(f"  -> stl_courses.csv / stl.js: {len(courses)} courses; " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    return rows


def write_rates_js(parsed, framework_ver, index_year, index_factor, tables):
    """data/rates.js for calculator.html (a <script>, so it loads from file:// with no server)."""
    base = {r[0]: [r[1], float(r[2].replace(",", ""))] for r in parsed["base_rates"]}
    courses = {r[0]: [r[1], float(r[2])] for r in parsed["course_adjustments"]}
    postcodes = {}
    for pcode, suburb, region, loc, pct in parsed["postcode_loading"]:
        postcodes.setdefault(pcode, []).append([suburb, region, loc, float(pct)])
    rates = {"framework": framework_ver, "indexYear": index_year, "indexFactor": index_factor,
             "generated": datetime.date.today().isoformat(), **tables,
             "base": base, "courses": courses, "postcodes": postcodes}
    out = DATA / "rates.js"
    out.write_text("window.SA_RATES = " + json.dumps(rates, separators=(",", ":")) + ";\n")
    print(f"  -> {out.name}: {len(base)} FOE rates, {len(courses)} courses, {len(postcodes)} postcodes")


def fee_range(s):
    """'$1,125-\\n  $1,349' -> (1125, 1349); 'Free' -> (0, 0)."""
    nums = [int(n.replace(",", "")) for n in re.findall(r"\$([\d,]+)", s)]
    if not nums:
        return (0, 0) if "Free" in s else (None, None)
    return min(nums), max(nums)


def tafe_course(url):
    page = html(url)
    title = re.search(r'class="cp_title"[^>]*>([^<]+)', page)
    code = re.search(r"National Code:?\s*(?:<[^>]+>\s*)*([A-Z0-9]{5,12})", page)
    text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", page))
    row = {"course": title[1].strip() if title else "", "national_code": code[1] if code else "", "url": url}
    for tier in FEE_TIERS:
        m = re.search(re.escape(tier) + r"[^$]{0,120}?(\$[\d,]+\s*-\s*\$[\d,]+|\$[\d,]+)", text)
        lo, hi = fee_range(m[1]) if m else (None, None)
        key = tier.lower().replace(" ", "_")
        row[f"{key}_min"], row[f"{key}_max"] = lo, hi
    # Skill set pages have no fee table: "SSDIS01008 - ... the full fee cost of $3432 will apply"
    if row["full_fee_min"] is None and (m := re.search(r"full fee cost of (\$[\d,]+)", text)):
        row["full_fee_min"], row["full_fee_max"] = fee_range(m[1])
    if not row["national_code"] and (m := re.match(r"([A-Z0-9]{5,12}) - ", row["course"])):
        row["national_code"] = m[1]
    return row


def write_csv(path, header, rows):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def main():
    DOCS.mkdir(exist_ok=True)
    DATA.mkdir(exist_ok=True)
    old = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    now = datetime.datetime.now().isoformat(timespec="seconds")
    manifest = {}

    print("Discovering documents...")
    docs = [(k, u, "v%d.%d" % v) for k, u, v in framework_docs(html(FFW_PAGE))] + stl_docs(html(STL_PAGE))

    docs.sort(key=lambda d: d[0] != "framework")  # framework first: base rates need its indexation table
    index_year, index_factor, tables, framework_ver, parsed, stl_paths, stl_ver = None, 1.0, None, None, {}, {}, None
    for kind, url, ver in docs:
        body = get(url)
        name = url.rsplit("/", 1)[1]
        if not name.lower().endswith(".pdf"):
            name = f"{name}-STL-{ver}.pdf"
        path = DOCS / name
        sha = hashlib.sha256(body).hexdigest()
        prev = old.get(name, {}).get("sha256")
        status = "unchanged" if prev == sha else ("CHANGED" if prev else "NEW")
        if not path.exists() or path.read_bytes() != body:
            path.write_bytes(body)
        manifest[name] = {"kind": kind, "version": ver, "url": url, "sha256": sha, "fetched_at": now}
        print(f"  {status:9} {kind:20} {ver:6} {name}")

        if kind.startswith("stl_") or kind == "managed_course_list":
            stl_paths[kind], stl_ver = path, ver
        if kind == "framework":
            text = subprocess.run(["pdftotext", "-layout", str(path), "-"], capture_output=True, text=True, check=True).stdout
            index_year, index_factor = indexation(text)
            tables, framework_ver = framework_tables(text), ver
            print(f"            -> base-rate indexation to {index_year}: x{index_factor:.4f}")
        if kind in ROW:
            rows, missed = parse_pdf(path, kind)
            parsed[kind] = rows
            header = ROW[kind][1]
            if kind == "base_rates" and index_year:
                header = header + [f"rate_{index_year}_indexed"]
                rows = [r + [f"{float(r[2].replace(',', '')) * index_factor:.2f}"] for r in rows]
            out = DATA / f"{kind}_{ver}.csv"
            write_csv(out, header, rows)
            warn = f"  ! {missed} unparsed rows, check the PDF" if missed else ""
            print(f"            -> {out.name}: {len(rows)} rows{warn}")

    if tables and all(k in parsed for k in ("base_rates", "course_adjustments", "postcode_loading")):
        write_rates_js(parsed, framework_ver, index_year, index_factor, tables)
    if len(stl_paths) == 4:
        write_stl(stl_paths, stl_ver)

    print("TAFE SA Fee Free courses...")
    links = sorted(set(u.replace("&amp;", "&").split("#")[0]
                       for u in re.findall(r'href="(https://www\.tafesa\.edu\.au/xml/course/[^"]+)"', html(TAFE_PAGE))))
    rows = []
    for u in links:
        try:
            rows.append(tafe_course(u))
        except Exception as e:
            print(f"  ! {u}: {e}")
        time.sleep(0.5)  # be polite to tafesa.edu.au
    if rows:
        write_csv(DATA / "tafe_fee_free.csv", list(rows[0]), [list(r.values()) for r in rows])
    print(f"  -> tafe_fee_free.csv: {len(rows)}/{len(links)} courses")

    for name in old.keys() - manifest.keys():
        print(f"  superseded: {name} (kept in docs/)")
    MANIFEST.write_text(json.dumps(manifest, indent=2))


def self_test():
    def row(kind, line):
        m = ROW[kind][0].match(line)
        return m and [g.strip() for g in m.groups()]
    assert row("base_rates", " 010101   ASCED6 - Mathematics                                                     $10.90   9/09/2022") == \
        ["010101", "ASCED6 - Mathematics", "10.90", "9/09/2022"]
    assert row("course_adjustments", " ACM10110       Certificate I in Animal Studies (ACM10110)                                      90") == \
        ["ACM10110", "Certificate I in Animal Studies (ACM10110)", "90"]
    assert row("postcode_loading", "0872    AMATA                               Regional    Very Remote Regional         40%") == \
        ["0872", "AMATA", "Regional", "Very Remote Regional", "40"]
    assert not row("base_rates", " FOE Code   FOE Name   Per Hr Rate From")
    assert fee_range("$1,125-\n\t\t$1,349") == (1125, 1349)
    assert fee_range("Free") == (0, 0)
    table1 = ("   Financial    Base Rate      Effective\n"
              "   2023-24            2.20%     1/07/2023\n   2024-25            2.10%     1/07/2024\n"
              "   2025-26            1.90%     1/07/2025\n   2026-27            2.04%     1/07/2026\n")
    yr, f = indexation(table1)
    v5 = DOCS / "Training-Fee-Framework-v5.0.pdf"
    if v5.exists():  # table parser against the real PDF
        t = framework_tables(subprocess.run(["pdftotext", "-layout", str(v5), "-"], capture_output=True, text=True).stdout)
        assert t["aqfReduction"] == V5_AQF and t["completion"] == V5_COMPLETION, t
        assert t["concession"] == {"minFee": 0.5, "maxReimb": 1.35}, t["concession"]
    assert yr == "2026-27" and abs(f - 1.022 * 1.021 * 1.019 * 1.0204) < 1e-9, (yr, f)
    assert version("Training-Fee-Framework-Attachment-1-Base-Rates-v4.1_2026-02-19-045722_fkty.pdf") == (4, 1)
    page = "".join(f'<a href="https://x/{n}">' for n in [
        "Training-Fee-Framework-v4.6.pdf", "Training-Fee-Framework-v5.0.pdf", "Training-Fee-Framework-v4.10.pdf",
        "Training-Fee-Framework-2024-v3.0.pdf", "Training-Fee-Framework-Attachment-3-Post-Code-Mapping-v5.0.pdf",
        "Training-Fee-Framework-Attachment-5-Concession-Eligible-Courses-v1.5.pdf"])
    got = {(k, v) for k, _, v in framework_docs(page)}
    assert got == {("framework", (5, 0)), ("postcode_loading", (5, 0))}, got
    mcl = (DOCS / "managed-course-list-STL-12.0.pdf")
    if mcl.exists():  # managed limits against the real STL 12.0 list
        lim = parse_managed_limits(subprocess.run(["pdftotext", "-layout", str(mcl), "-"], capture_output=True, text=True).stdout)
        assert lim[("TPL", "CHC32015")] == (50, "CHC32015"), lim.get(("TPL", "CHC32015"))
        assert lim[("TPL", "CUA51120")] == lim[("TPL", "CUA51125")] == (10, "CUA51120")
        assert lim[("TPL", "HLTSS00061")] == (100, "HLTSS00061") and lim[("TPL", "MAR10224")] == (50, "MAR10224")
        assert lim[("STAL", "AHC42021")] == (20, "AHC42021") and lim[("TPL", "AHC42021")] == (5, "AHC42021")
        assert lim[("STAL", "CUA41220")] == lim[("STAL", "CUA41225")] == (15, "CUA41220")
    sample = "Demand Driven Courses\n    AHC30122   Certificate III in Agriculture\n    MAR10224   Certificate I in Maritime (Near\n                        Coastal)\nManaged Courses\n    CHC32015   Cert III\n"
    assert parse_stl_list(sample, "TPL") == [["AHC30122", "Certificate III in Agriculture", "TPL", "demand"],
                                             ["MAR10224", "Certificate I in Maritime (Near Coastal)", "TPL", "demand"],
                                             ["CHC32015", "Cert III", "TPL", "managed"]]
    print("self-test ok")


if __name__ == "__main__":
    self_test() if "--self-test" in sys.argv else main()
