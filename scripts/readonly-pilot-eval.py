#!/usr/bin/env python3
"""Run a read-only, source-scoped GBrain pilot from a declarative JSON config.

This script is intentionally conservative:
- copies only explicit allowlisted files into a throwaway/staged corpus;
- supports synthetic canaries for public/restricted tiers;
- runs sync without embeddings by default;
- verifies FS extraction dry-run/apply parity;
- registers read-only OAuth clients;
- probes MCP search visibility and put_page denial;
- scans the staged corpus for blocked path/content terms.

It does not crawl arbitrary vault roots. Operators must provide a positive allowlist.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from typing import Any, Dict, List

SECRET_RE = re.compile(r"gbrain_(cl|cs|tok)_[A-Za-z0-9_\-]+")


def redact(text: str) -> str:
    return SECRET_RE.sub(r"gbrain_\1_[REDACTED]", text or "")


def repo_root() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parents[1]


def run_cli(gb: pathlib.Path, env: Dict[str, str], args: List[str], timeout: int = 240, input_text: str | None = None) -> Dict[str, Any]:
    proc = subprocess.run(
        ["bun", "src/cli.ts", *args],
        cwd=str(gb),
        env=env,
        text=True,
        input=input_text,
        capture_output=True,
        timeout=timeout,
    )
    return {"cmd": " ".join(args), "code": proc.returncode, "stdout": redact(proc.stdout), "stderr": redact(proc.stderr)}


def slugify_rel(rel: str) -> str:
    p = pathlib.Path(rel)
    s = str(p.with_suffix("")).replace(" ", "-").replace("|", "-")
    s = re.sub(r"[^A-Za-z0-9_./-]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s.lower()


def parse_frontmatter(text: str) -> Dict[str, str]:
    fm: Dict[str, str] = {}
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            for line in text[4:end].splitlines():
                if ":" in line and not line.startswith(" "):
                    key, val = line.split(":", 1)
                    fm[key.strip()] = val.strip().strip('"')
    return fm


def write_source_config(source_dir: pathlib.Path, source: Dict[str, Any]) -> None:
    source_dir.mkdir(parents=True, exist_ok=True)
    source_dir.joinpath("gbrain.yml").write_text(
        f"id: {source['id']}\n"
        f"name: {source.get('name', source['id'])}\n"
        f"federated: {str(source.get('federated', False)).lower()}\n",
        encoding="utf-8",
    )


def assert_allowlist_safe(vault: pathlib.Path, allowlist: List[Dict[str, Any]], blocked_terms: List[str]) -> List[Dict[str, str]]:
    problems: List[Dict[str, str]] = []
    for item in allowlist:
        rel = item["path"]
        rel_l = rel.lower()
        if any(term.lower() in rel_l for term in blocked_terms):
            problems.append({"path": rel, "reason": "blocked term in path"})
        path = vault / rel
        if not path.exists():
            problems.append({"path": rel, "reason": "missing"})
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        haystack = text.lower()
        for term in item.get("forbid_terms", []):
            if term.lower() in haystack:
                problems.append({"path": rel, "reason": f"per-file forbidden term: {term}"})
        fm = parse_frontmatter(text)
        sens = str(fm.get("sensitivity", "")).lower()
        if item.get("forbid_sensitive_frontmatter", True) and any(t in sens for t in ["ceo", "confidential", "borrower", "personnel"]):
            problems.append({"path": rel, "reason": f"blocked sensitivity: {sens}"})
    return problems


def build_subset(cfg: Dict[str, Any], root: pathlib.Path) -> Dict[str, Any]:
    vault = pathlib.Path(cfg["source_vault"]).expanduser().resolve()
    blocked_terms = [str(x).lower() for x in cfg.get("blocked_terms", [])]
    allowlist = cfg.get("allowlist", [])
    problems = assert_allowlist_safe(vault, allowlist, blocked_terms)
    if problems:
        raise RuntimeError("Unsafe allowlist: " + json.dumps(problems, indent=2))

    if root.exists():
        shutil.rmtree(root, onerror=lambda fn, p, exc: (os.chmod(p, 0o755), fn(p)))
    root.joinpath("home").mkdir(parents=True)
    root.joinpath("xdg").mkdir(parents=True)

    counts: Dict[str, int] = {}
    manifest: List[Dict[str, Any]] = []
    source_ids = [s["id"] for s in cfg["sources"]]
    for source in cfg["sources"]:
        sid = source["id"]
        counts[sid] = 0
        write_source_config(root / "vault" / sid, source)

    for doc in cfg.get("synthetic_docs", []):
        sid = doc["source"]
        out_rel = doc["path"]
        out = root / "vault" / sid / out_rel
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(doc["content"], encoding="utf-8")
        counts[sid] += 1
        manifest.append({"source": sid, "original_rel": "<synthetic>", "staged_rel": out_rel, "real_content": False})

    real_slugs: List[str] = []
    for item in allowlist:
        sid = item["source"]
        if sid not in source_ids:
            raise RuntimeError(f"Allowlist item {item['path']} uses unknown source {sid}")
        src = vault / item["path"]
        text = src.read_text(encoding="utf-8", errors="ignore")
        marker = item.get("append_marker")
        if marker:
            text = text.rstrip() + f"\n\n<!-- {marker} -->\n"
        out_rel = item.get("staged_path") or (slugify_rel(item["path"]) + ".md")
        out = root / "vault" / sid / out_rel
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        real_slugs.append(pathlib.Path(out_rel).with_suffix("").as_posix())
        fm = parse_frontmatter(src.read_text(encoding="utf-8", errors="ignore"))
        manifest.append({
            "source": sid,
            "original_rel": item["path"],
            "staged_rel": out_rel,
            "sha256": hashlib.sha256(src.read_bytes()).hexdigest(),
            "type": fm.get("type", ""),
            "sensitivity": fm.get("sensitivity", ""),
            "real_content": True,
        })
        counts[sid] += 1

    for hub in cfg.get("topology_hubs", []):
        sid = hub["source"]
        links = real_slugs[: int(hub.get("link_count", 6))]
        content = hub["content_template"].replace("{{links}}", ", ".join(f"[[{s}]]" for s in links))
        out_rel = hub["path"]
        out = root / "vault" / sid / out_rel
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(content, encoding="utf-8")
        counts[sid] += 1
        manifest.append({"source": sid, "original_rel": "<synthetic topology hub>", "staged_rel": out_rel, "real_content": False})

    root.joinpath("manifest.json").write_text(json.dumps({"counts": counts, "files": manifest}, indent=2), encoding="utf-8")
    root.joinpath("pilot-config-used.json").write_text(json.dumps(cfg, indent=2), encoding="utf-8")

    if cfg.get("git_init_sources", True):
        for sid in source_ids:
            d = root / "vault" / sid
            subprocess.run(["git", "init", "-q"], cwd=str(d), check=True)
            subprocess.run(["git", "config", "user.email", "readonly-pilot@example.invalid"], cwd=str(d), check=True)
            subprocess.run(["git", "config", "user.name", "Readonly Pilot"], cwd=str(d), check=True)
            subprocess.run(["git", "add", "."], cwd=str(d), check=True)
            subprocess.run(["git", "commit", "-q", "-m", "readonly pilot corpus"], cwd=str(d), check=True)
    return {"counts": counts, "allowlist_problems": problems, "real_docs": len(allowlist)}


def http_json(url: str, payload: Dict[str, Any], token: str | None = None) -> Dict[str, Any]:
    data = json.dumps(payload).encode()
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        txt = resp.read().decode()
    events = []
    for line in txt.splitlines():
        if line.startswith("data:"):
            try:
                events.append(json.loads(line[5:].strip()))
            except Exception:
                pass
    return events[-1] if events else json.loads(txt)


def register_client(gb: pathlib.Path, env: Dict[str, str], spec: Dict[str, Any]) -> Dict[str, Any]:
    args = ["auth", "register-client", spec["name"], "--grant-types", "client_credentials", "--scopes", spec.get("scopes", "read"), "--source", spec["source"]]
    if spec.get("federated_read"):
        args.extend(["--federated-read", ",".join(spec["federated_read"])])
    proc = subprocess.run(["bun", "src/cli.ts", *args], cwd=str(gb), env=env, text=True, capture_output=True, timeout=120)
    cid = re.search(r"Client ID:\s+(\S+)", proc.stdout)
    secret = re.search(r"Client Secret:\s+(\S+)", proc.stdout)
    result = {"cmd": " ".join(args), "code": proc.returncode, "stdout": redact(proc.stdout), "stderr": redact(proc.stderr)}
    return {"result": result, "client_id": cid.group(1) if cid else None, "client_secret": secret.group(1) if secret else None}


def token_for(port: int, client_id: str, client_secret: str) -> Dict[str, Any]:
    data = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": client_id, "client_secret": client_secret, "scope": "read"}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/token", data=data, headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())


def tool_call(port: int, token: str, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    return http_json(f"http://127.0.0.1:{port}/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}, token)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True, help="Path to readonly-pilot JSON config")
    ap.add_argument("--out", help="Override output/runtime root")
    args = ap.parse_args()

    cfg_path = pathlib.Path(args.config).expanduser().resolve()
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    gb = pathlib.Path(cfg.get("gbrain_repo") or repo_root()).expanduser().resolve()
    root = pathlib.Path(args.out or cfg["output_root"]).expanduser().resolve()
    port = int(cfg.get("port", 31339))

    env = os.environ.copy()
    env.update({"HOME": str(root / "home"), "XDG_CONFIG_HOME": str(root / "xdg"), "GBRAIN_HOME": str(root / "home" / ".gbrain")})
    for key in cfg.get("unset_env", ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ZEROENTROPY_API_KEY", "VOYAGE_API_KEY", "DATABASE_URL", "GBRAIN_DATABASE_URL"]):
        env.pop(key, None)

    report: Dict[str, Any] = {"config": str(cfg_path), "root": str(root), "generated_at": datetime.now().astimezone().isoformat(), "steps": {}}
    report["steps"]["subset"] = build_subset(cfg, root)
    report["steps"]["init"] = run_cli(gb, env, ["init", "--pglite", "--no-embedding"], timeout=240)
    report["steps"]["sources"] = {}
    for source in cfg["sources"]:
        sid = source["id"]
        report["steps"]["sources"][sid] = run_cli(gb, env, ["sources", "add", sid, "--path", str(root / "vault" / sid)], timeout=120)
    report["steps"]["sync"] = {}
    for source in cfg["sources"]:
        sid = source["id"]
        report["steps"]["sync"][sid] = run_cli(gb, env, ["sync", "--source", sid, "--no-embed"], timeout=300)

    report["steps"]["extract_fs_dry_run"] = {}
    report["steps"]["extract_fs"] = {}
    for source in cfg["sources"]:
        sid = source["id"]
        base = ["extract", "links", "--source", "fs", "--source-id", sid, "--dir", str(root / "vault" / sid), "--json"]
        report["steps"]["extract_fs_dry_run"][sid] = run_cli(gb, env, [*base, "--dry-run"], timeout=240)
        report["steps"]["extract_fs"][sid] = run_cli(gb, env, base, timeout=240)
    report["steps"]["stats"] = run_cli(gb, env, ["stats"], timeout=120)

    if cfg.get("chmod_readonly", True):
        for d in (root / "vault").glob("*"):
            if d.is_dir():
                for p in d.rglob("*"):
                    if p.is_file():
                        p.chmod(0o444)
                d.chmod(0o555)
        report["steps"]["chmod_readonly"] = "source files chmod 0444, source dirs chmod 0555 after sync/import"

    report["steps"]["clients"] = {spec["id"]: register_client(gb, env, spec) for spec in cfg.get("clients", [])}
    server = subprocess.Popen(["bun", "src/cli.ts", "serve", "--http", "--port", str(port), "--enable-dcr"], cwd=str(gb), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    report["server_pid"] = server.pid
    try:
        ready = False
        for _ in range(60):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/.well-known/oauth-authorization-server", timeout=2).read()
                ready = True
                break
            except Exception:
                time.sleep(0.5)
        report["steps"]["server_ready"] = ready
        if not ready:
            raise RuntimeError("MCP server not ready")
        mcp: Dict[str, Any] = {}
        for client_id, client in report["steps"]["clients"].items():
            token_response = token_for(port, client["client_id"], client["client_secret"])
            token = token_response["access_token"]
            entry: Dict[str, Any] = {"token": {k: ("[REDACTED]" if k == "access_token" else v) for k, v in token_response.items()}, "tool_calls": {}}
            for call in cfg.get("mcp_tool_calls", []):
                entry["tool_calls"][call["id"]] = tool_call(port, token, call["name"], call.get("arguments", {}))
            mcp[client_id] = entry
        report["steps"]["mcp"] = mcp
    except Exception as e:
        report["steps"]["mcp_error"] = str(e)
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
        out, err = server.communicate(timeout=5)
        report["server_stdout"] = redact(out)[-4000:]
        report["server_stderr"] = redact(err)[-4000:]

    report["steps"]["write_probe_files"] = [str(p) for p in (root / "vault").rglob("*should-not-write*")]
    leak_hits = []
    terms = [str(x).lower() for x in cfg.get("blocked_terms", [])]
    for p in (root / "vault").rglob("*.md"):
        rel = str(p.relative_to(root / "vault"))
        haystack = (rel + "\n" + p.read_text(encoding="utf-8", errors="ignore")).lower()
        for term in terms:
            if term and term in haystack:
                leak_hits.append({"path": rel, "term": term})
                break
    report["steps"]["staged_leak_hits"] = leak_hits
    report["steps"]["doctor_fast"] = run_cli(gb, env, ["doctor", "--fast", "--json"], timeout=240)

    failures: List[str] = []
    for step in ["init", "stats", "doctor_fast"]:
        if int(report["steps"][step]["code"]) != 0:
            failures.append(f"{step} exited {report['steps'][step]['code']}")
    for group in ["sources", "sync", "extract_fs_dry_run", "extract_fs"]:
        for sid, result in report["steps"][group].items():
            if int(result["code"]) != 0:
                failures.append(f"{group}.{sid} exited {result['code']}")
    for source in cfg["sources"]:
        sid = source["id"]
        try:
            dry = json.loads(report["steps"]["extract_fs_dry_run"][sid]["stdout"])
            applied = json.loads(report["steps"]["extract_fs"][sid]["stdout"])
            if dry != applied:
                failures.append(f"extract dry-run/apply mismatch for {sid}: {dry} != {applied}")
        except Exception as exc:
            failures.append(f"could not parse extract JSON for {sid}: {exc}")
    if not report["steps"].get("server_ready"):
        failures.append("MCP server was not ready")
    if report["steps"].get("mcp_error"):
        failures.append(f"MCP probe error: {report['steps']['mcp_error']}")
    if report["steps"].get("write_probe_files"):
        failures.append(f"write probe files landed: {report['steps']['write_probe_files']}")
    if report["steps"].get("staged_leak_hits"):
        failures.append(f"blocked staged leak terms found: {report['steps']['staged_leak_hits']}")

    for expectation in cfg.get("expectations", []):
        client = expectation["client"]
        call = expectation["call"]
        try:
            text_value = report["steps"]["mcp"][client]["tool_calls"][call]["result"]["content"][0].get("text", "")
        except Exception as exc:
            failures.append(f"missing MCP result for {client}.{call}: {exc}")
            continue
        if expectation.get("empty") is True and text_value.strip() != "[]":
            failures.append(f"expected {client}.{call} to be empty array")
        if expectation.get("empty") is False and text_value.strip() == "[]":
            failures.append(f"expected {client}.{call} to be non-empty")
        for needle in expectation.get("contains", []):
            if needle not in text_value:
                failures.append(f"expected {client}.{call} to contain {needle!r}")
        for needle in expectation.get("not_contains", []):
            if needle in text_value:
                failures.append(f"expected {client}.{call} not to contain {needle!r}")

    report["validation"] = {"passed": not failures, "failures": failures}
    text = redact(json.dumps(report, indent=2, default=str))
    root.joinpath("readonly_pilot_report.json").write_text(text, encoding="utf-8")
    print(text)
    print("REPORT_PATH=" + str(root / "readonly_pilot_report.json"))
    if failures:
        print("VALIDATION_FAILED=" + json.dumps(failures), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
