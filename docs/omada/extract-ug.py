#!/usr/bin/env python3
"""Extract Omada SDN Controller User Guide (507p) into 114 per-L2-section
markdown pages with frontmatter, written to ~/omada-kb/ug/<slug>.md for
`gbrain import` / `gbrain put` into the isolated `omada` source.

Granularity = L2 TOC sections. type=source (so docs are enrich/synthesis
neighbors); kind = protocol (procedures) | concept (overview/intro).
"""
import fitz, re, os, json, datetime

PDF = "/Users/chenyuanquan/Projects/jarvis-knowledge-os-v2/docs/omada/1900002482_Omada SDN Controller_V6.2_User Guide.pdf"
OUT = os.path.expanduser("~/omada-kb/ug")
DOC = "Omada SDN Controller V6.2 User Guide"
TODAY = "2026-06-02"
os.makedirs(OUT, exist_ok=True)

doc = fitz.open(PDF)
N = doc.page_count
toc = doc.get_toc()
anchors = sorted([(pg, lvl, t) for lvl, t, pg in toc if lvl <= 2], key=lambda x: x[0])

def end_page(start):
    nxts = [a[0] for a in anchors if a[0] > start]
    return (min(nxts) - 1) if nxts else N

def kebab(s):
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return re.sub(r"-+", "-", s)

def clean(raw):
    out = []
    for l in raw.split("\n"):
        s = l.strip()
        if not s:
            out.append("")  # keep paragraph breaks
            continue
        if re.fullmatch(r"\d{1,3}", s):           # bare page number
            continue
        if re.search(r"Omada SDN Controller.*User Guide", s, re.I):  # running header
            continue
        out.append(l.rstrip())
    # collapse 3+ blank lines → 1
    txt = "\n".join(out)
    return re.sub(r"\n{3,}", "\n\n", txt).strip()

CONCEPT_STARTS = ("overview", "introduction", "about")
records = []
for lvl, title, pg in toc:
    if lvl != 2:
        continue
    title = re.sub(r"\s+", " ", title).strip()
    m = re.match(r"^(\d+)\.\s*(\d+)\s+(.*)$", title)
    if not m:
        continue
    ch, sec, name = m.group(1), m.group(2), m.group(3).strip()
    e = end_page(pg)
    body_raw = "\n".join(doc[p].get_text() for p in range(pg - 1, e))
    body = clean(body_raw)
    kind = "concept" if name.lower().startswith(CONCEPT_STARTS) else "protocol"
    slug = f"ug/{int(ch):02d}-{int(sec):02d}-{kebab(name)}"
    fm = (
        "---\n"
        f"type: source\n"
        f"kind: {kind}\n"
        f"title: {json.dumps(name)}\n"
        f"doc: {json.dumps(DOC)}\n"
        f"chapter: {ch}\n"
        f'section: "{ch}.{sec}"\n'
        f'pages: "{pg}-{e}"\n'
        f"product: omada\n"
        f"source_kind: product-doc\n"
        f"ingested_at: {TODAY}\n"
        "---\n\n"
    )
    md = fm + f"# {ch}.{sec} {name}\n\n{body}\n"
    path = os.path.join(OUT, os.path.basename(slug) + ".md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(md)
    records.append({"slug": slug, "kind": kind, "pages": f"{pg}-{e}", "chars": len(body), "path": path})

# summary
import collections
kc = collections.Counter(r["kind"] for r in records)
print(f"wrote {len(records)} section files → {OUT}")
print(f"kinds: {dict(kc)}")
print(f"total body chars: {sum(r['chars'] for r in records)}  (~{sum(r['chars'] for r in records)//1500}k tok)")
print("biggest:", sorted(records, key=lambda r: -r["chars"])[:3] and [(r["slug"], r["chars"]) for r in sorted(records, key=lambda r: -r["chars"])[:3]])
# write a manifest for the ingest loop
with open(os.path.expanduser("~/omada-kb/ug-manifest.jsonl"), "w") as f:
    for r in records:
        f.write(json.dumps(r) + "\n")
print("manifest: ~/omada-kb/ug-manifest.jsonl")
