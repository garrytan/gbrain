#!/usr/bin/env python3
"""
Claude Code Stop hook → ambient signal capture into GBrain.

Mirrors OpenClaw's signal-detector skill pattern: extracts ORIGINAL THINKING +
ENTITY MENTIONS from the just-finished session and writes selective pages to
GBrain. Does NOT save the full transcript (that would be noise).

Auth modes (preferred order):
  1. `claude -p` (uses your Claude Pro/Max subscription, $0 extra)
  2. ANTHROPIC_API_KEY direct API call (~1-3¢ per session)

Recursion guard: if env GBRAIN_HOOK_RUNNING=1, exit immediately. The script
sets that var before invoking `claude -p` so the spawned child's Stop hook
short-circuits instead of looping.

Wire-up: ~/.claude/settings.json hooks.Stop entry running:
    python3 ~/.gbrain/hooks/signal-detector.py
"""

from __future__ import annotations
import json, os, sys, shutil, subprocess, time, urllib.request, urllib.error
from datetime import datetime, timezone
from pathlib import Path

# ─── Config ──────────────────────────────────────────────
HOME = Path.home()
GBRAIN_BIN = os.environ.get("GBRAIN_BIN", str(HOME / ".bun/bin/gbrain"))
ENV_FILE = Path(os.environ.get("GBRAIN_ENV_FILE", str(HOME / "gbrain/.env")))
LOG_FILE = HOME / ".gbrain/hooks/signal-detector.log"

def _detect_projects_dir() -> Path:
    base = HOME / ".claude/projects"
    if not base.is_dir(): return base
    cands = [p for p in base.iterdir() if p.is_dir()]
    if not cands: return base
    return max(cands, key=lambda p: max((j.stat().st_mtime for j in p.glob("*.jsonl")), default=0))

PROJECTS_DIR = _detect_projects_dir()
MIN_TRANSCRIPT_BYTES = 2000
MAX_TRANSCRIPT_CHARS = 30000
MODEL = "claude-haiku-4-5-20251001"

# ─── Logging ─────────────────────────────────────────────
def _ensure_secure(path: Path) -> None:
    """Ensure file exists with 600 perms (owner-only)."""
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
    try:
        path.chmod(0o600)
    except Exception:
        pass

def log(msg: str) -> None:
    _ensure_secure(LOG_FILE)
    with LOG_FILE.open("a") as f:
        f.write(f"{datetime.now(timezone.utc).isoformat(timespec='seconds')} {msg}\n")

# ─── Env file loader ─────────────────────────────────────
def load_env_file(path: Path) -> dict:
    env = {}
    if not path.exists(): return env
    for line in path.read_text(errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env

# ─── Transcript handling ─────────────────────────────────
def find_transcript(event: dict) -> Path | None:
    p = event.get("transcript_path") or ""
    if p and Path(p).is_file(): return Path(p)
    candidates = sorted(PROJECTS_DIR.glob("*.jsonl"), key=lambda x: x.stat().st_mtime, reverse=True)
    return candidates[0] if candidates else None

def extract_turns(transcript: Path, max_turns: int = 200) -> str:
    turns = []
    for line in transcript.read_text(errors="ignore").splitlines():
        line = line.strip()
        if not line: continue
        try: ev = json.loads(line)
        except: continue
        msg = ev.get("message") or {}
        role = msg.get("role")
        content = msg.get("content")
        if not (role and content): continue
        if isinstance(content, list):
            text = "\n".join(c.get("text","") for c in content if isinstance(c,dict) and c.get("type")=="text").strip()
        elif isinstance(content, str):
            text = content
        else:
            text = ""
        if text:
            turns.append(f"[{role}]\n{text}\n")
    return ("\n---\n".join(turns[-max_turns:]))[:MAX_TRANSCRIPT_CHARS]

# ─── Prompts ─────────────────────────────────────────────
SYSTEM_PROMPT = """You are signal-detector. Your ONLY job is to output a JSON object.
You output NOTHING else. No prose. No greeting. No analysis. No markdown.
Your output MUST start with { and end with }. Anything else is failure."""

EXTRACTION_PROMPT = """Extract structured signals from this Claude Code session transcript.

Schema (output ONLY this JSON object):
{
  "decisions":   [{"slug":"decisions/<kebab>","title":"...","summary":"<2-4 sentences>"}],
  "insights":    [{"slug":"originals/<kebab>","title":"...","summary":"<user's exact phrasing>"}],
  "entities":    [{"slug":"people/<kebab>|companies/<kebab>","title":"...","summary":"..."}],
  "concepts":    [{"slug":"concepts/<kebab>","title":"...","summary":"..."}],
  "skip_reason": null
}

Rules:
- If session is purely operational (only commands, no decisions/insights), return all empty arrays and skip_reason="operational".
- Capture USER'S exact phrasing in insights — do not paraphrase.
- Only emit signals worth keeping forever. Skip noise.
- Slugs MUST be kebab-case, max 60 chars, alphanumeric + hyphens only.
- Total signals across all categories: at most 8.

Transcript follows after the marker. Output ONLY the JSON object.

=== TRANSCRIPT START ===
"""

# ─── JSON extraction ─────────────────────────────────────
def _extract_first_json_object(text: str) -> str | None:
    start = text.find("{")
    if start < 0: return None
    depth = 0; in_string = False; escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape: escape = False
            elif ch == "\\": escape = True
            elif ch == '"': in_string = False
        else:
            if ch == '"': in_string = True
            elif ch == "{": depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0: return text[start:i+1]
    return None

def _parse_extraction(raw_text: str) -> dict:
    json_text = _extract_first_json_object(raw_text)
    if not json_text:
        _p = HOME / ".gbrain/hooks/last-extraction-raw.txt"; _ensure_secure(_p); _p.write_text(raw_text[:8000]); _p.chmod(0o600)
        return {"skip_reason": "no_json_object_found", "decisions":[], "insights":[], "entities":[], "concepts":[]}
    try:
        return json.loads(json_text)
    except Exception as e:
        _p = HOME / ".gbrain/hooks/last-extraction-raw.txt"; _ensure_secure(_p); _p.write_text(raw_text[:8000]); _p.chmod(0o600)
        return {"skip_reason": f"parse_error: {e}", "decisions":[], "insights":[], "entities":[], "concepts":[]}

# ─── Auth mode 1: claude CLI (subscription) ──────────────
def call_via_claude_cli(transcript: str) -> dict:
    claude_bin = shutil.which("claude")
    if not claude_bin:
        return {"skip_reason": "claude_cli_not_found"}
    full_prompt = f"{SYSTEM_PROMPT}\n\n{EXTRACTION_PROMPT}{transcript}\n=== TRANSCRIPT END ===\n\nNow output the JSON object:"
    child_env = {**os.environ, "GBRAIN_HOOK_RUNNING": "1"}
    try:
        r = subprocess.run(
            [claude_bin, "-p", "--model", MODEL, full_prompt],
            env=child_env, capture_output=True, text=True, timeout=180
        )
    except subprocess.TimeoutExpired:
        return {"skip_reason": "claude_cli_timeout"}
    except Exception as e:
        return {"skip_reason": f"claude_cli_error: {e}"}
    if r.returncode != 0:
        return {"skip_reason": f"claude_cli_exit_{r.returncode}: {(r.stderr or '')[:200]}"}
    return _parse_extraction(r.stdout)

# ─── Auth mode 2: direct API (fallback) ──────────────────
def call_via_api(api_key: str, transcript: str) -> dict:
    body = json.dumps({
        "model": MODEL, "max_tokens": 2000,
        "system": SYSTEM_PROMPT,
        "messages": [{"role":"user","content": EXTRACTION_PROMPT + transcript + "\n=== TRANSCRIPT END ===\n\nNow output the JSON object:"}]
    }).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body,
        headers={"Content-Type":"application/json","x-api-key":api_key,"anthropic-version":"2023-06-01"})
    try:
        resp = urllib.request.urlopen(req, timeout=90).read().decode()
    except urllib.error.HTTPError as e:
        return {"skip_reason": f"api_http_{e.code}"}
    except Exception as e:
        return {"skip_reason": f"api_net_error: {e}"}
    text = json.loads(resp)["content"][0]["text"]
    return _parse_extraction(text)

# ─── Routing: prefer subscription, fall back to API ─────
def call_extraction(transcript: str, api_key: str | None) -> tuple[dict, str]:
    """Returns (signals_dict, auth_mode_used)."""
    cli_result = call_via_claude_cli(transcript)
    if not cli_result.get("skip_reason"):
        return cli_result, "claude_cli"
    cli_skip = cli_result.get("skip_reason", "")
    if api_key:
        api_result = call_via_api(api_key, transcript)
        if not api_result.get("skip_reason"):
            return api_result, "api"
        return api_result, "api"
    return {"skip_reason": f"no_auth ({cli_skip})", "decisions":[], "insights":[], "entities":[], "concepts":[]}, "none"

# ─── GBrain page write ───────────────────────────────────
SLUG_RE = __import__("re").compile(r"^[a-z0-9][a-z0-9-]*(?:/[a-z0-9][a-z0-9-]*)*$")

WRITE_FAILURES_LOG = HOME / ".gbrain/hooks/write-failures.log"

def _log_write_failure(slug: str, reason: str, stderr: str = "") -> None:
    try:
        _ensure_secure(WRITE_FAILURES_LOG)
        with WRITE_FAILURES_LOG.open("a") as f:
            ts = datetime.now(timezone.utc).isoformat(timespec='seconds')
            f.write(f"{ts}\tslug={slug}\treason={reason}\tstderr={stderr[:300]}\n")
    except Exception:
        pass

def _yaml_escape(s: str) -> str:
    """Quote a string for safe YAML inclusion. Always double-quoted to handle
    colons, hashes, brackets, leading/trailing whitespace, etc."""
    s = s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ").replace("\r", "")
    return f'"{s}"'

def write_to_gbrain(slug: str, title: str, body: str, session_id: str) -> bool:
    # Pre-validate slug to avoid wasted gbrain CLI invocations
    if not slug or len(slug) > 120 or "//" in slug or slug.startswith("/") or slug.endswith("/"):
        _log_write_failure(slug, "slug_invalid_shape")
        return False
    if not SLUG_RE.match(slug):
        _log_write_failure(slug, "slug_invalid_chars")
        return False
    if not title or not body:
        _log_write_failure(slug, "empty_title_or_body")
        return False
    page = (
        f"---\n"
        f"type: {slug.split('/',1)[0]}\n"
        f"title: {_yaml_escape(title)}\n"
        f"source_session: {_yaml_escape(session_id)}\n"
        f"captured_at: {datetime.now(timezone.utc).isoformat(timespec='seconds')}\n"
        f"---\n\n{body}\n"
    )
    try:
        r = subprocess.run([GBRAIN_BIN, "put", slug], input=page,
                           capture_output=True, text=True, timeout=30)
        if r.returncode == 0:
            return True
        _log_write_failure(slug, f"exit_{r.returncode}", r.stderr or r.stdout)
        return False
    except subprocess.TimeoutExpired:
        _log_write_failure(slug, "timeout")
        return False
    except Exception as e:
        _log_write_failure(slug, f"exception: {e}")
        return False

# ─── Main ────────────────────────────────────────────────
def main():
    # Recursion guard: if a child claude -p invocation triggered this hook, bail.
    if os.environ.get("GBRAIN_HOOK_RUNNING") == "1":
        return 0

    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

    try:
        event = json.loads(sys.stdin.read() or "{}")
    except Exception:
        event = {}
    session_id = event.get("session_id", "unknown")[:36]

    transcript = find_transcript(event)
    if not transcript:
        log(f"[skip:{session_id}] no transcript found")
        return 0

    bytes_size = transcript.stat().st_size
    if bytes_size < MIN_TRANSCRIPT_BYTES:
        log(f"[skip:{session_id}] transcript too small ({bytes_size}b)")
        return 0

    transcript_txt = extract_turns(transcript)
    if not transcript_txt:
        log(f"[skip:{session_id}] empty extraction")
        return 0

    env = load_env_file(ENV_FILE)
    api_key = os.environ.get("ANTHROPIC_API_KEY") or env.get("ANTHROPIC_API_KEY")

    t0 = time.monotonic()
    signals, auth_mode = call_extraction(transcript_txt, api_key)
    extraction_secs = round(time.monotonic() - t0, 1)
    if signals.get("skip_reason"):
        log(f"[skip:{session_id}] auth={auth_mode} reason={signals['skip_reason']} ({extraction_secs}s)")
        return 0

    # Count what Haiku PROPOSED vs what ACTUALLY got written
    proposed = {cat: len(signals.get(cat) or []) for cat in ("decisions","insights","entities","concepts")}
    counts = {"decisions":0, "insights":0, "entities":0, "concepts":0}
    write_failures = 0
    for cat in ("decisions","insights","entities","concepts"):
        for item in (signals.get(cat) or []):
            slug = (item.get("slug") or "").strip()
            title = (item.get("title") or "").strip()
            body = (item.get("summary") or "").strip()
            if not (slug and title and body):
                continue
            if write_to_gbrain(slug, title, body, session_id):
                counts[cat] += 1
            else:
                write_failures += 1

    total_proposed = sum(proposed.values())
    total_written = sum(counts.values())

    # Distinguish: empty extraction (signals=0) vs operational (Haiku said skip) vs error
    if total_proposed == 0:
        log(f"[empty:{session_id}] auth={auth_mode} Haiku returned 0 signals ({extraction_secs}s, transcript {bytes_size}b) — likely operational session, or prompt needs tuning. Saved raw to last-extraction-raw.txt")
        # Save the raw signals we got for debugging
        try:
            _p = HOME / ".gbrain/hooks/last-extraction-raw.txt"; _ensure_secure(_p); _p.write_text(json.dumps(signals, indent=2)[:8000]); _p.chmod(0o600)
        except Exception:
            pass
        return 0

    extra = ""
    if write_failures:
        extra = f", {write_failures} write_failures"
    if total_written < total_proposed:
        extra += f", proposed={total_proposed}/written={total_written}"
    log(f"[ok:{session_id}] auth={auth_mode} captured: {counts['decisions']} decisions, {counts['insights']} insights, {counts['entities']} entities, {counts['concepts']} concepts ({extraction_secs}s, transcript {bytes_size}b{extra})")
    return 0

if __name__ == "__main__":
    sys.exit(main())
