#!/usr/bin/env python3
"""Crawl Omada FAQ (omadanetworks.com) → markdown files in ~/omada-kb/faq/.

Enumerate via the JSON search API (sort=latest, paginate, stop at <CUTOFF),
download each FAQ detail page (server-rendered), extract the <article class=article>
body, convert to markdown, write with frontmatter for `gbrain put` into source omada.

Usage:
  python3 crawl_faq.py --test            # convert the pre-downloaded sample only
  python3 crawl_faq.py --limit 5         # crawl first 5 (≥cutoff) for smoke
  python3 crawl_faq.py                    # full crawl (all ≥2025-01-01)
"""
import sys, os, re, json, time, urllib.request, urllib.error
from lxml import html as LH

CUTOFF = os.environ.get("FAQ_CUTOFF", "2025-01-01")  # FAQ_CUTOFF=2000-01-01 → all
OUT = os.path.expanduser("~/omada-kb/faq")
API = ("https://www.omadanetworks.com/us/search/?t=FAQ&mode=searchResult&format=json"
       "&type=smb&sort=latest&q=&productTypeIds=&faqSearchTypeId=&initFaq=true&pageSize=10&p={p}")
DETAIL = "https://www.omadanetworks.com/us/support/faq/{sid}/"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36"
# API needs the XHR header; the detail HTML page 500s if sent X-Requested-With.
API_HDRS = {"User-Agent": UA, "Accept": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": "https://www.omadanetworks.com/us/support/faq/"}
PAGE_HDRS = {"User-Agent": UA, "Accept": "text/html,application/xhtml+xml",
             "Referer": "https://www.omadanetworks.com/us/support/faq/"}
os.makedirs(OUT, exist_ok=True)

def fetch(url, api=False, tries=4):
    last = None
    for a in range(tries):
        try:
            req = urllib.request.Request(url, headers=(API_HDRS if api else PAGE_HDRS))
            return urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
        except Exception as e:
            last = e; time.sleep(1.5 * (a + 1))
    raise last

def kebab(s):
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return re.sub(r"-+", "-", s)[:70]

INLINE = {"strong": "**", "b": "**", "em": "*", "i": "*"}

def md_inline(el):
    """Inline text with light emphasis + links."""
    parts = []
    if el.text: parts.append(el.text)
    for c in el:
        if not isinstance(c.tag, str):
            if c.tail: parts.append(c.tail)
            continue
        t = c.tag.lower()
        inner = md_inline(c)
        if t in INLINE and inner.strip():
            parts.append(f"{INLINE[t]}{inner.strip()}{INLINE[t]}")
        elif t in ("code",):
            parts.append(f"`{inner.strip()}`")
        elif t == "a":
            href = c.get("href", "")
            parts.append(f"[{inner.strip()}]({href})" if href.startswith("http") else inner)
        elif t == "br":
            parts.append("\n")
        else:
            parts.append(inner)
        if c.tail: parts.append(c.tail)
    return re.sub(r"[ \t]+", " ", "".join(parts))

def md_block(el, out, depth=0):
    """Recursively emit block-level markdown."""
    for c in el:
        if not isinstance(c.tag, str):
            continue
        t = c.tag.lower()
        if t in ("script", "style", "noscript"):
            continue
        if re.fullmatch(r"h[1-6]", t):
            lvl = int(t[1])
            txt = md_inline(c).strip()
            if txt: out.append("\n" + "#" * min(lvl + 1, 6) + " " + txt + "\n")
        elif t == "p":
            txt = md_inline(c).strip()
            if txt: out.append(txt + "\n")
        elif t in ("ul", "ol"):
            i = 1
            for li in c.findall("li"):
                bullet = f"{i}. " if t == "ol" else "- "
                txt = md_inline(li).strip()
                if txt: out.append("  " * depth + bullet + txt)
                i += 1
                md_block(li, out, depth + 1)  # nested lists
            out.append("")
        elif t == "table":
            rows = c.xpath(".//tr")
            for ri, tr in enumerate(rows):
                cells = [md_inline(td).strip().replace("\n", " ") for td in tr.xpath("./th|./td")]
                if cells:
                    out.append("| " + " | ".join(cells) + " |")
                    if ri == 0:
                        out.append("| " + " | ".join("---" for _ in cells) + " |")
            out.append("")
        elif t in ("pre",):
            txt = c.text_content().strip()
            if txt: out.append("\n```\n" + txt + "\n```\n")
        elif t in ("div", "section", "article", "span", "tbody", "thead"):
            md_block(c, out, depth)
        else:
            txt = md_inline(c).strip()
            if txt and t not in ("a",): out.append(txt + "\n")

def extract(html_str):
    root = LH.fromstring(html_str)
    for bad in root.xpath('//script|//style|//nav|//header|//footer|//noscript|//*[contains(@class,"article-related")]|//*[contains(@class,"breadcrumb")]|//*[contains(@class,"table-of-content")]|//*[contains(@class,"feedback")]'):
        p = bad.getparent()
        if p is not None: p.remove(bad)
    body = root.xpath('//div[@class="content"]') or root.xpath('//article[contains(@class,"article") and not(contains(@class,"article-related"))]') or root.xpath('//*[contains(@class,"article-main")]')
    if not body:
        return None
    out = []
    md_block(body[0], out)
    md = "\n".join(out)
    md = re.sub(r"\n{3,}", "\n\n", md).strip()
    return md

def write_faq(it, md):
    sid = it["showId"]; fid = it.get("faqId", "")
    title = (it.get("title") or f"faq-{sid}").strip()
    date = (it.get("lastUpdateDate") or "")[:10]
    kw = it.get("keywords", "") or ""
    cats = it.get("faqCategories", "") or ""
    slug = f"faq/{sid}-{kebab(title)}"
    fm = ("---\n" "type: source\n" "kind: source\n"
          f"title: {json.dumps(title)}\n" "product: omada\n" "source_kind: faq\n"
          f"faq_show_id: \"{sid}\"\n" f"faq_id: \"{fid}\"\n"
          f"url: \"https://www.omadanetworks.com/us/support/faq/{sid}/\"\n"
          f"keywords: {json.dumps(kw)}\n" f"categories: {json.dumps(cats)}\n"
          f"last_update: \"{date}\"\n" f"ingested_at: \"2026-06-02\"\n" "---\n\n")
    doc = fm + f"# {title}\n\n{md}\n"
    path = os.path.join(OUT, os.path.basename(slug) + ".md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(doc)
    return slug, len(md), path

def main():
    args = sys.argv[1:]
    if "--test" in args:
        md = extract(open("/tmp/faq5111.html", encoding="utf-8").read())
        print("=== extracted markdown (sample showId=5111) ===")
        print(md[:1600] if md else "EXTRACT FAILED")
        print(f"\n[md chars: {len(md) if md else 0}]")
        return
    limit = None
    if "--limit" in args: limit = int(args[args.index("--limit") + 1])

    # Phase 1 — enumerate ≥ cutoff
    items, p, total = [], 1, None
    while True:
        data = json.loads(fetch(API.format(p=p), api=True))
        total = data.get("total")
        res = data.get("result") or []
        if not res: break
        stop = False
        for it in res:
            d = (it.get("lastUpdateDate") or "")[:10]
            if d and d < CUTOFF:
                stop = True; break
            items.append(it)
        if stop or (total and p * 10 >= total): break
        p += 1; time.sleep(0.25)
    print(f"enumerated {len(items)} FAQs ≥ {CUTOFF} (of {total} total)")
    if limit: items = items[:limit]

    # Phase 2 — download + extract + write (skip showIds already on disk)
    existing = {f.split("-", 1)[0] for f in os.listdir(OUT) if f.endswith(".md")}
    ok = fail = skip = 0; manifest = []
    for i, it in enumerate(items, 1):
        sid = it["showId"]
        if str(sid) in existing:
            skip += 1; continue
        try:
            doc = fetch(DETAIL.format(sid=sid))
            md = extract(doc)
            if not md or len(md) < 80:
                fail += 1; print(f"  [{i}/{len(items)}] {sid} ✗ empty/short extract"); continue
            slug, n, path = write_faq(it, md)
            ok += 1; manifest.append({"slug": slug, "showId": sid, "chars": n, "date": (it.get('lastUpdateDate') or '')[:10]})
            if i <= 3 or i % 25 == 0: print(f"  [{i}/{len(items)}] {slug} ({n} chars)")
        except Exception as e:
            fail += 1; print(f"  [{i}/{len(items)}] {sid} ✗ {str(e)[:80]}")
        time.sleep(0.2)
    with open(os.path.expanduser("~/omada-kb/faq-manifest.jsonl"), "w") as f:
        for m in manifest: f.write(json.dumps(m) + "\n")
    print(f"\n=== FAQ crawl done: ok={ok} fail={fail} skip(existing)={skip} → {OUT} ===")

main()
