#!/usr/bin/env python3
"""Generate the self-contained HTML viewer for an expo-skill-eval run.

Usage: generate_viewer.py <workspace-root> [--artifact]
  <workspace-root>  Run root, e.g. /private/tmp/expo-skill-eval-expo-ui.
                    Iteration dirs (iteration-*) and trigger-evals/ live under it;
                    viewer.html is written there and opened in the browser.
  --artifact        Emit viewer_artifact.html (page-content only, no
                    <!DOCTYPE>/<html>/<head>/<body>) for the Artifact tool, and
                    do NOT open a browser. The standalone viewer.html is still
                    written on a normal (non-artifact) run.

Reads, per iteration, <iter>/evals.json plus each eval's
eval-<id>/<config>/{grading.json,static.json,outputs/<platform>.png}. Screenshots
are embedded as base64 data: URIs so the file is fully self-contained (and
satisfies the Artifact CSP). Self-paced by argv so it can be a checked-in script
rather than regenerated each run.
"""

import base64
import json
import sys
import webbrowser
from pathlib import Path


def b64_img(path):
    if not path:
        return None
    p = Path(path)
    if not p.exists() or not p.is_file():
        return None
    with open(p, "rb") as f:
        data = base64.b64encode(f.read()).decode()
    ext = p.suffix.lower().lstrip(".")
    mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg"}.get(ext, "image/png")
    return f"data:{mime};base64,{data}"


def score_color(score, max_score):
    if not max_score:
        return "#888"
    pct = score / max_score
    if pct >= 0.85:
        return "#4ade80"
    elif pct >= 0.65:
        return "#fbbf24"
    else:
        return "#f87171"


def load_json(path, default=None):
    p = Path(path)
    if not p.exists():
        return default
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return default


def render_expectations(expectations):
    if not expectations:
        return ""
    html = '<ul class="exp-list">'
    for exp in expectations:
        if isinstance(exp, dict):
            passed = exp.get("passed", None)
            text = exp.get("text", str(exp))
            evidence = exp.get("evidence", "")
            if passed is True:
                badge = '<span class="badge pass">PASS</span>'
            elif passed is False:
                badge = '<span class="badge fail">FAIL</span>'
            else:
                badge = '<span class="badge unknown">?</span>'
            ev_html = f'<div class="evidence">{evidence}</div>' if evidence else ""
            html += f'<li>{badge} {text}{ev_html}</li>'
        else:
            html += f'<li><span class="badge unknown">?</span> {exp}</li>'
    html += "</ul>"
    return html


def render_quality(quality):
    if not quality:
        return ""
    dims = quality.get("dimensions", [])
    subtotal = quality.get("subtotal", 0)
    max_total = quality.get("max", 0)
    summary = quality.get("summary", "")
    html = '<div class="quality-block">'
    html += f'<div class="quality-header">Design Quality: <b>{subtotal}/{max_total}</b></div>'
    for d in dims:
        name = d.get("name", "")
        score = d.get("score", 0)
        mx = d.get("max", 3)
        evidence = d.get("evidence", "")
        pct = (score / mx * 100) if mx else 0
        color = score_color(score, mx)
        html += f'''<div class="quality-dim">
  <div class="dim-label">{name} <span style="color:{color}">{score}/{mx}</span></div>
  <div class="dim-bar-wrap"><div class="dim-bar" style="width:{pct:.0f}%;background:{color}"></div></div>
  {f'<div class="dim-evidence">{evidence}</div>' if evidence else ""}
</div>'''
    if summary:
        html += f'<div class="quality-summary">{summary}</div>'
    html += "</div>"
    return html


def render_config_card(iter_dir, eval_id, config, eval_case, grading, static_result):
    screenshots = []
    for plat in eval_case.get("runtime", {}).get("platforms", ["ios"]):
        img_path = iter_dir / f"eval-{eval_id}" / config / "outputs" / f"{plat}.png"
        screenshots.append((plat, b64_img(img_path)))

    static_pass = static_result and static_result.get("exit_code") == 0
    static_badge = '<span class="badge pass">BUILD OK</span>' if static_pass else '<span class="badge fail">BUILD FAIL</span>'

    score = grading.get("score", 0) if grading else None
    max_score = grading.get("max_score", 1) if grading else 1
    score_html = ""
    if score is not None:
        color = score_color(score, max_score)
        score_html = f'<div class="score" style="color:{color}">{score}/{max_score}</div>'

    label = "With Skill" if config == "with_skill" else "Without Skill"
    html = '<div class="config-card">'
    html += f'<div class="config-header"><span class="config-label {"with" if config == "with_skill" else "without"}">{label}</span>{static_badge}{score_html}</div>'

    for plat, img_b64 in screenshots:
        if img_b64:
            html += f'<div class="screenshot-wrap"><div class="plat-label">{plat}</div>'
            html += f'<img src="{img_b64}" class="screenshot" onclick="this.classList.toggle(\'zoomed\')" />'
            html += '</div>'
        else:
            html += f'<div class="screenshot-wrap"><div class="plat-label">{plat}</div><div class="no-screenshot">No screenshot</div></div>'

    if grading:
        html += render_expectations(grading.get("expectations", []))

        ref_match = grading.get("reference_match")
        if ref_match:
            rm_score = ref_match.get("score", 0)
            rm_max = ref_match.get("max", 10)
            rm_color = score_color(rm_score, rm_max)
            html += f'<div class="ref-match"><b>Reference Match:</b> <span style="color:{rm_color}">{rm_score}/{rm_max}</span>'
            if ref_match.get("evidence"):
                html += f'<div class="evidence">{ref_match["evidence"]}</div>'
            html += '</div>'

        html += render_quality(grading.get("quality"))

        notes = grading.get("user_notes_summary", {})
        if notes and notes.get("notes"):
            html += f'<div class="reviewer-notes"><b>Notes:</b> {notes["notes"]}</div>'

    html += '</div>'
    return html


def render_iteration(iter_dir):
    evals = load_json(iter_dir / "evals.json")
    if not evals:
        return f"<p>No evals.json found in {iter_dir}</p>"

    html = ""
    total_with = total_without = 0
    scored_with = scored_without = 0
    qual_with = qual_without = 0
    total_evals = 0

    for ev in evals:
        eid = ev["id"]
        ref_img_b64 = b64_img(ev.get("reference_image", ""))

        with_grading = load_json(iter_dir / f"eval-{eid}" / "with_skill" / "grading.json")
        without_grading = load_json(iter_dir / f"eval-{eid}" / "without_skill" / "grading.json")
        with_static = load_json(iter_dir / f"eval-{eid}" / "with_skill" / "static.json")
        without_static = load_json(iter_dir / f"eval-{eid}" / "without_skill" / "static.json")

        total_evals += 1

        if with_grading and with_grading.get("max_score"):
            scored_with += with_grading.get("score", 0)
            total_with += with_grading.get("max_score", 0)
        if without_grading and without_grading.get("max_score"):
            scored_without += without_grading.get("score", 0)
            total_without += without_grading.get("max_score", 0)
        if with_grading and with_grading.get("quality"):
            qual_with += with_grading["quality"].get("subtotal", 0)
        if without_grading and without_grading.get("quality"):
            qual_without += without_grading["quality"].get("subtotal", 0)

        html += '<div class="eval-case">'
        html += f'<div class="eval-header">Eval #{eid}</div>'
        html += f'<div class="eval-prompt">{ev.get("prompt", "")[:200]}</div>'

        if ref_img_b64:
            html += '<div class="ref-image-wrap"><div class="ref-label">Target Reference</div>'
            html += f'<img src="{ref_img_b64}" class="ref-image" onclick="this.classList.toggle(\'zoomed\')" />'
            html += '</div>'

        html += '<div class="configs-row">'
        html += render_config_card(iter_dir, eid, "with_skill", ev, with_grading, with_static)
        html += render_config_card(iter_dir, eid, "without_skill", ev, without_grading, without_static)
        html += '</div>'
        html += '</div>'

    with_pct = (scored_with / total_with * 100) if total_with else 0
    without_pct = (scored_without / total_without * 100) if total_without else 0
    delta = with_pct - without_pct
    delta_color = "#4ade80" if delta > 0 else "#f87171" if delta < 0 else "#888"

    qual_html = ""
    if qual_with or qual_without:
        qdelta = qual_with - qual_without
        qcolor = "#4ade80" if qdelta > 0 else "#f87171" if qdelta < 0 else "#888"
        qual_html = f'  <div class="summary-item">Quality Δ: <span style="color:{qcolor}">{qdelta:+d}</span></div>\n'

    summary = f'''<div class="summary-bar">
  <div class="summary-item">With Skill: <span style="color:{score_color(scored_with, total_with) if total_with else "#888"}">{with_pct:.0f}%</span></div>
  <div class="summary-item">Without Skill: <span style="color:{score_color(scored_without, total_without) if total_without else "#888"}">{without_pct:.0f}%</span></div>
  <div class="summary-item">Delta: <span style="color:{delta_color}">{delta:+.0f}pp</span></div>
{qual_html}  <div class="summary-item">Evals: {total_evals}</div>
</div>'''

    return summary + html


def render_trigger_table(results_path):
    data = load_json(results_path)
    if not data:
        return ""

    html = '<div class="trigger-section"><h2>Trigger Accuracy</h2>'
    recall = data.get("recall", 0)
    color = score_color(recall, 1)
    passed_count = data.get("passed", data.get("triggered", 0))
    html += f'<div class="trigger-summary">Recall: <span style="color:{color}">{100*recall:.0f}%</span> ({passed_count}/{data.get("total")} passed)</div>'
    html += '<table class="trigger-table"><tr><th>#</th><th>Prompt</th><th>Should Trigger</th><th>Triggered</th><th>Result</th><th>Time</th></tr>'
    for i, r in enumerate(data.get("results", []), 1):
        # Support both schema variants: {id, prompt, should_trigger, pass} and {query, triggered, duration}
        rid = r.get("id", i)
        prompt = r.get("prompt", r.get("query", ""))
        should_trigger = r.get("should_trigger", True)  # default True for recall-only runs
        triggered = r.get("triggered", False)
        passed = r.get("pass", triggered if should_trigger else not triggered)
        result_badge = '<span class="badge pass">PASS</span>' if passed else '<span class="badge fail">FAIL</span>'
        should = "Yes" if should_trigger else "No"
        triggered_str = "Yes" if triggered else "No"
        elapsed = r.get("elapsed_s", r.get("duration", "?"))
        html += f'<tr><td>{rid}</td><td class="prompt-cell">{prompt[:80]}</td><td>{should}</td><td>{triggered_str}</td><td>{result_badge}</td><td>{elapsed}s</td></tr>'
    html += '</table></div>'
    return html


CSS = """\
:root {
  --ground: #090C14;
  --surface: #0E1320;
  --surface-hi: #131929;
  --border: #1A2238;
  --text: #D9E2F5;
  --text-muted: #6B7A9E;
  --text-dim: #3A4560;
  --accent: #7B6FD3;
  --accent-glow: rgba(123,111,211,0.12);
  --pass: #4DB87C;
  --pass-bg: rgba(77,184,124,0.10);
  --fail: #E05555;
  --fail-bg: rgba(224,85,85,0.10);
  --score-with: #9B8EE8;
  --score-without: #5A6480;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--ground); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.5; padding: 20px 24px; }
h1 { font-size: 15px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 20px; }
h2 { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); margin: 24px 0 10px; }

/* Tabs */
.tabs { display: flex; gap: 6px; margin-bottom: 20px; }
.tab { background: var(--surface); border: 1px solid var(--border); color: var(--text-muted); padding: 5px 14px; border-radius: 5px; cursor: pointer; font-size: 12px; font-weight: 500; transition: color .15s, border-color .15s; }
.tab:hover { color: var(--text); border-color: #2A3558; }
.tab.active { background: var(--surface-hi); border-color: var(--accent); color: var(--text); }

/* Summary strip */
.summary-bar { display: flex; gap: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 20px; }
.summary-item { flex: 1; padding: 12px 16px; border-right: 1px solid var(--border); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-muted); }
.summary-item:last-child { border-right: none; }
.summary-item span { display: block; font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; color: var(--text); margin-top: 2px; }

/* Eval card */
.eval-case { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 24px; overflow: hidden; }
.eval-header { padding: 10px 16px; font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--text-muted); border-bottom: 1px solid var(--border); }
.eval-prompt { padding: 12px 16px; font-size: 13px; color: var(--text); border-bottom: 1px solid var(--border); line-height: 1.55; }

/* Reference image */
.ref-image-wrap { padding: 16px; background: #07090F; border-bottom: 1px solid var(--border); }
.ref-label { font-size: 10px; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; color: var(--text-dim); margin-bottom: 8px; }
.ref-image { max-height: 260px; width: auto; border-radius: 10px; border: 1px solid #1E2840; cursor: zoom-in; display: block; }
.ref-image.zoomed { max-height: none; cursor: zoom-out; }

/* Side-by-side config columns */
.configs-row { display: grid; grid-template-columns: 1fr 1fr; }
.config-card { padding: 16px; border-right: 1px solid var(--border); position: relative; }
.config-card:last-child { border-right: none; }

/* The aesthetic risk: the with_skill card gets a faint violet radial glow from its header edge */
.config-card:first-child::before {
  content: "";
  position: absolute;
  top: 0; left: 0; right: 0; height: 180px;
  background: radial-gradient(ellipse 80% 120px at 50% 0, var(--accent-glow), transparent 70%);
  pointer-events: none;
}

.config-header { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
.config-label { font-size: 10px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; padding: 3px 8px; border-radius: 4px; }
.config-label.with { background: rgba(123,111,211,0.15); color: var(--accent); border: 1px solid rgba(123,111,211,0.25); }
.config-label.without { background: var(--surface-hi); color: var(--text-muted); border: 1px solid var(--border); }
.score { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; margin-left: auto; }
.config-card:first-child .score { color: var(--score-with); }
.config-card:last-child .score { color: var(--score-without); }

/* Badges */
.badge { display: inline-flex; align-items: center; font-size: 9px; font-weight: 700; padding: 2px 7px; border-radius: 3px; letter-spacing: 0.05em; text-transform: uppercase; }
.badge.pass { background: var(--pass-bg); color: var(--pass); border: 1px solid rgba(77,184,124,0.2); }
.badge.fail { background: var(--fail-bg); color: var(--fail); border: 1px solid rgba(224,85,85,0.2); }
.badge.unknown { background: var(--surface-hi); color: var(--text-dim); border: 1px solid var(--border); }

/* Screenshots */
.screenshot-wrap { margin-bottom: 14px; }
.plat-label { font-size: 9px; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; color: var(--text-dim); margin-bottom: 6px; }
.screenshot { max-width: 100%; max-height: 380px; width: auto; border-radius: 14px; border: 1px solid #1A2540; cursor: zoom-in; display: block; box-shadow: 0 4px 24px rgba(0,0,0,0.5); }
.screenshot.zoomed { max-height: none; cursor: zoom-out; }
.no-screenshot { color: var(--text-dim); font-size: 11px; padding: 16px; background: var(--surface-hi); border-radius: 6px; text-align: center; border: 1px dashed var(--border); }

/* Expectations */
.exp-list { list-style: none; margin-top: 12px; }
.exp-list li { padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-start; }
.exp-list li:last-child { border-bottom: none; }
.evidence { font-size: 10px; color: var(--text-dim); width: 100%; line-height: 1.5; margin-top: 2px; }

/* Reference match block */
.ref-match { margin-top: 12px; font-size: 12px; color: var(--text-muted); background: var(--surface-hi); padding: 10px 12px; border-radius: 6px; border-left: 2px solid var(--accent); }
.ref-match b { color: var(--text); }

/* Quality rubric */
.quality-block { margin-top: 12px; background: var(--surface-hi); border: 1px solid var(--border); border-radius: 6px; padding: 12px; }
.quality-header { font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 10px; }
.quality-dim { margin-bottom: 10px; }
.quality-dim:last-of-type { margin-bottom: 0; }
.dim-label { font-size: 10px; color: var(--text-muted); margin-bottom: 4px; display: flex; justify-content: space-between; }
.dim-label span { font-variant-numeric: tabular-nums; }
.dim-bar-wrap { height: 3px; background: var(--border); border-radius: 2px; overflow: hidden; }
.dim-bar { height: 100%; border-radius: 2px; }
.dim-evidence { font-size: 10px; color: var(--text-dim); margin-top: 3px; line-height: 1.45; }
.quality-summary { font-size: 11px; color: var(--text-dim); margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
.reviewer-notes { margin-top: 10px; font-size: 11px; color: var(--text-dim); background: var(--ground); padding: 8px 10px; border-radius: 4px; }

/* Trigger table */
.trigger-section { margin-top: 32px; }
.trigger-summary { font-size: 13px; margin-bottom: 12px; color: var(--text-muted); }
.trigger-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.trigger-table th { background: var(--surface); padding: 9px 10px; text-align: left; font-size: 10px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--text-muted); border-bottom: 1px solid var(--border); }
.trigger-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); color: var(--text-muted); vertical-align: top; }
.trigger-table tr:last-child td { border-bottom: none; }
.trigger-table tr:hover td { background: var(--surface-hi); }
.prompt-cell { max-width: 320px; word-break: break-word; color: var(--text); }
@media (prefers-reduced-motion: reduce) { .dim-bar { transition: none; } }
"""

JS = """\
function showTab(i) {
  document.querySelectorAll('.panel').forEach((p, idx) => { p.style.display = idx === i ? 'block' : 'none'; });
  document.querySelectorAll('.tab').forEach((t, idx) => { t.classList.toggle('active', idx === i); });
  localStorage.setItem('expo-eval-tab', i);
}
(function() {
  const saved = parseInt(localStorage.getItem('expo-eval-tab') || '0', 10);
  if (saved > 0) showTab(saved);
})();
"""


def build_page(ws, title, artifact=False):
    iterations = sorted(p for p in ws.glob("iteration-*") if p.is_dir())
    if not iterations:
        return f"<p>No iteration directories found under {ws}.</p>"

    tabs_html = ""
    panels_html = ""
    for i, it in enumerate(iterations):
        active = "active" if i == 0 else ""
        tabs_html += f'<button class="tab {active}" onclick="showTab({i})" id="tab-{i}">{it.name}</button>'
        content = render_iteration(it)
        panels_html += f'<div class="panel" id="panel-{i}" style="display:{"block" if i == 0 else "none"}">{content}</div>'

    trigger_html = render_trigger_table(ws / "trigger-evals" / "trigger_results.json")
    body_content = f'<h1>{title}</h1>\n<div class="tabs">{tabs_html}</div>\n{panels_html}\n{trigger_html}'

    if artifact:
        return f'<title>{title}</title>\n<style>\n{CSS}</style>\n{body_content}\n<script>\n{JS}</script>'
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{title}</title>
<style>
{CSS}
</style>
</head>
<body>
{body_content}
<script>
{JS}
</script>
</body>
</html>'''


def main():
    args = [a for a in sys.argv[1:] if a != "--artifact"]
    artifact = "--artifact" in sys.argv
    if not args:
        print("usage: generate_viewer.py <workspace-root> [--artifact]", file=sys.stderr)
        sys.exit(1)

    ws = Path(args[0]).resolve()
    skill = ws.name.replace("expo-skill-eval-", "")
    title = f"{skill} Skill Eval"
    html = build_page(ws, title, artifact=artifact)

    if artifact:
        out = ws / "viewer_artifact.html"
        out.write_text(html)
        print(f"Artifact viewer written: {out}")
    else:
        out = ws / "viewer.html"
        out.write_text(html)
        print(f"Viewer written: {out}")
        webbrowser.open("file://" + str(out))


if __name__ == "__main__":
    main()
