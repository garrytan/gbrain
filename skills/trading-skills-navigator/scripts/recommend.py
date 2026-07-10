#!/usr/bin/env python3
"""Trading Skills Navigator — deterministic workflow / skillset recommender.

Turns a natural-language trading goal into a concrete recommendation:
which workflow to run, which skillset (skills-index category) it belongs to,
the API requirement, and a pointer to the setup path.

Design contract: see ../references/intent_routing.md and the 10-question
golden suite in tests/test_recommend.py. The routing logic here is the
single source of truth; the reference doc explains it.

Metadata resolution order (same deterministic engine in both):
  1. repo-root SSoT  — skills-index.yaml + workflows/*.yaml (Claude Code)
  2. bundled snapshot — assets/metadata_snapshot.json        (Claude Web App)

Output JSON is stable and idempotent (json.dumps sort_keys=True). The
snapshot is generated from the SSoT by build_snapshot.py using the SAME
normalize_* functions, so repo-root and snapshot paths are byte-identical
(the parity invariant — golden-tested).
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Paid-API integration ids. A workflow is "needs a paid key" if its
# api_profile says so OR any required skill has one of these integrations
# at requirement == "required". (public_csv "required" is NOT paid.)
PAID_INTEGRATION_IDS = frozenset({"fmp", "finviz", "alpaca"})
API_REQUIRED_PROFILES = frozenset({"fmp-required", "finviz-required", "alpaca-required"})

SKILL_ROOT = Path(__file__).resolve().parents[1]
BUNDLED_SNAPSHOT = SKILL_ROOT / "assets" / "metadata_snapshot.json"
SETUP_PATH_REF = "references/setup_paths.md"

SCHEMA_VERSION = 1


# ---------------------------------------------------------------------------
# Normalization — the parity contract.
#
# Both the SSoT loader and build_snapshot.py call these. Whatever fields the
# JSON output can surface MUST be carried here so repo-root and snapshot
# produce byte-identical recommendations.
# ---------------------------------------------------------------------------


def normalize_skill(raw: dict[str, Any]) -> dict[str, Any]:
    integrations = []
    for ig in raw.get("integrations") or []:
        if not isinstance(ig, dict):
            continue
        integrations.append(
            {
                "id": str(ig.get("id") or "unknown"),
                "type": str(ig.get("type") or "unknown"),
                "requirement": str(ig.get("requirement") or "unknown"),
            }
        )
    return {
        "id": str(raw.get("id") or "").strip(),
        "display_name": str(raw.get("display_name") or raw.get("id") or "").strip(),
        "category": str(raw.get("category") or "meta"),
        "status": str(raw.get("status") or "unknown"),
        "summary": str(raw.get("summary") or "").strip(),
        "timeframe": str(raw.get("timeframe") or "unknown"),
        "difficulty": str(raw.get("difficulty") or "unknown"),
        "integrations": integrations,
    }


def _normalize_prerequisites(raw: Any) -> list[str]:
    out: list[str] = []
    for item in raw or []:
        if isinstance(item, dict):
            pid = item.get("id")
            if pid:
                out.append(str(pid))
        elif item:
            out.append(str(item))
    return out


def normalize_workflow(raw: dict[str, Any]) -> dict[str, Any]:
    est = raw.get("estimated_minutes")
    try:
        est_val: int | None = int(est) if est is not None else None
    except (TypeError, ValueError):
        est_val = None
    return {
        "id": str(raw.get("id") or "").strip(),
        "display_name": str(raw.get("display_name") or raw.get("id") or "").strip(),
        "cadence": str(raw.get("cadence") or "unknown"),
        "estimated_minutes": est_val,
        "api_profile": str(raw.get("api_profile") or "unknown"),
        "difficulty": str(raw.get("difficulty") or "unknown"),
        "target_users": [str(u) for u in (raw.get("target_users") or [])],
        "required_skills": [str(s) for s in (raw.get("required_skills") or [])],
        "optional_skills": [str(s) for s in (raw.get("optional_skills") or [])],
        "prerequisite_workflows": _normalize_prerequisites(raw.get("prerequisite_workflows")),
    }


def normalize_skillset(raw: dict[str, Any]) -> dict[str, Any]:
    """Minimal skillset digest (mirrors normalize_workflow). Carries every
    field the snapshot needs so SSoT↔snapshot stays byte-identical."""
    return {
        "id": str(raw.get("id") or "").strip(),
        "display_name": str(raw.get("display_name") or raw.get("id") or "").strip(),
        "category": str(raw.get("category") or raw.get("id") or "").strip(),
        "timeframe": str(raw.get("timeframe") or "unknown"),
        "difficulty": str(raw.get("difficulty") or "unknown"),
        "api_profile": str(raw.get("api_profile") or "unknown"),
        "target_users": [str(u) for u in (raw.get("target_users") or [])],
        "required_skills": [str(s) for s in (raw.get("required_skills") or [])],
        "recommended_skills": [str(s) for s in (raw.get("recommended_skills") or [])],
        "optional_skills": [str(s) for s in (raw.get("optional_skills") or [])],
        "related_workflows": [str(w) for w in (raw.get("related_workflows") or [])],
    }


# ---------------------------------------------------------------------------
# Metadata loading — SSoT first, bundled snapshot fallback.
# ---------------------------------------------------------------------------


class MetadataError(RuntimeError):
    """Raised when neither the SSoT nor the bundled snapshot can be loaded."""


def load_ssot(project_root: Path) -> dict[str, Any]:
    """Load + normalize skills-index.yaml and workflows/*.yaml from a repo root."""
    import yaml  # lazy: pure-snapshot mode (Web App) never needs pyyaml

    index_path = project_root / "skills-index.yaml"
    workflows_dir = project_root / "workflows"
    with index_path.open("r", encoding="utf-8") as f:
        index = yaml.safe_load(f)
    skills = [
        normalize_skill(s)
        for s in (index.get("skills") or [])
        if isinstance(s, dict) and s.get("id")
    ]
    workflows = []
    for wf_path in sorted(workflows_dir.glob("*.yaml")):
        with wf_path.open("r", encoding="utf-8") as f:
            wf = yaml.safe_load(f)
        if isinstance(wf, dict) and wf.get("id"):
            workflows.append(normalize_workflow(wf))
    skillsets = []
    skillsets_dir = project_root / "skillsets"
    if skillsets_dir.is_dir():
        for ss_path in sorted(skillsets_dir.glob("*.yaml")):
            with ss_path.open("r", encoding="utf-8") as f:
                ss = yaml.safe_load(f)
            if isinstance(ss, dict) and ss.get("id"):
                skillsets.append(normalize_skillset(ss))
    return _finalize_metadata(skills, workflows, skillsets)


def load_snapshot(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        snap = json.load(f)
    # Snapshot is already normalized; re-finalize to guarantee identical
    # ordering regardless of how it was written. `skillsets` is tolerated
    # absent for backward compatibility with a pre-PR-N2 snapshot.
    return _finalize_metadata(
        list(snap.get("skills") or []),
        list(snap.get("workflows") or []),
        list(snap.get("skillsets") or []),
    )


def _finalize_metadata(
    skills: list[dict[str, Any]],
    workflows: list[dict[str, Any]],
    skillsets: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    skills_sorted = sorted(skills, key=lambda s: s["id"])
    workflows_sorted = sorted(workflows, key=lambda w: w["id"])
    skillsets_sorted = sorted(skillsets or [], key=lambda s: s["id"])
    return {
        "schema_version": SCHEMA_VERSION,
        "skills": skills_sorted,
        "workflows": workflows_sorted,
        "skillsets": skillsets_sorted,
    }


def resolve_metadata(
    project_root: Path, *, snapshot_path: Path | None = None
) -> tuple[dict[str, Any], str]:
    """Return (metadata, source) where source is 'ssot' or 'snapshot'."""
    index_path = project_root / "skills-index.yaml"
    workflows_dir = project_root / "workflows"
    if index_path.is_file() and workflows_dir.is_dir():
        try:
            return load_ssot(project_root), "ssot"
        except Exception as exc:  # noqa: BLE001 — fall back, then surface below
            ssot_error: Exception | None = exc
        else:
            ssot_error = None
    else:
        ssot_error = None

    snap = snapshot_path or BUNDLED_SNAPSHOT
    if snap.is_file():
        return load_snapshot(snap), "snapshot"
    if ssot_error is not None:
        raise MetadataError(f"SSoT load failed and no snapshot available: {ssot_error}")
    raise MetadataError(
        f"No metadata found: missing skills-index.yaml/workflows/ and no bundled snapshot at {snap}"
    )


# ---------------------------------------------------------------------------
# Personas — ordered; first match wins. Encodes the 10-question contract
# (test_recommend.py) + PROJECT_VISION.md §7 target users.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Persona:
    name: str
    any_terms: tuple[str, ...]
    primary: str | None = None
    secondary: tuple[str, ...] = ()
    gap_category: str | None = None
    no_api: bool = False
    rationale: str = ""
    require_groups: tuple[tuple[str, ...], ...] = ()
    exclude_terms: tuple[str, ...] = ()

    def matches(self, q: str) -> bool:
        if not any(term in q for term in self.any_terms):
            return False
        for group in self.require_groups:
            if not any(term in q for term in group):
                return False
        if any(term in q for term in self.exclude_terms):
            return False
        return True


PERSONAS: tuple[Persona, ...] = (
    # Q7 — honest gap: short / advanced-satellite strategies.
    Persona(
        name="short-strategy-trader",
        any_terms=(
            "short strateg",
            "short selling",
            "short-selling",
            "shorting",
            "go short",
            "short the ",
            "short position",
            "short candidate",
            "short setup",
            "bearish short",
            "short squeeze",
            "parabolic short",
            # JA
            "ショート戦略",
            "ショートポジション",
            "空売り",
            "売り戦略",
            "売り建て",
            "ショートしたい",
            "ショート狙い",
        ),
        gap_category="advanced-satellite",
        rationale=(
            "short-strategy trader — short/event strategies are Advanced "
            "Satellite; no dedicated workflow shipped yet"
        ),
    ),
    # Q10 — honest gap: strategy research / backtesting.
    Persona(
        name="strategy-researcher",
        any_terms=(
            "backtest",
            "back-test",
            "back test",
            "hypothes",
            "research strateg",
            "research and backtest",
            "strategy idea",
            "develop strateg",
            "develop a strateg",
            "new strateg",
            "edge research",
            "strategy research",
            "validate strateg",
            "test a strateg",
            "test my strateg",
            "build a strateg",
            # JA
            "バックテスト",
            "戦略を検証",
            "戦略の検証",
            "戦略アイデア",
            "戦略研究",
            "新しい戦略",
            "仮説を検証",
            "仮説検証",
            "戦略を開発",
            "リサーチして",
        ),
        gap_category="strategy-research",
        rationale=(
            "strategy researcher/developer — research & backtesting is the "
            "Strategy Research area; no dedicated workflow shipped yet"
        ),
    ),
    # Q8 — no-API path.
    Persona(
        name="no-api-path",
        any_terms=(
            "without api",
            "without an api",
            "without any api",
            "no api",
            "no-api",
            "api key",
            "api keys",
            "without paid",
            "without a subscription",
            "no subscription",
            "free only",
            "no paid",
            # JA — note: normalize_query lowercases, so "API" -> "api"
            "api キー",
            "apiキー",
            "api無し",
            "api 無し",
            "apiなし",
            "api なし",
            "api不要",
            "api 不要",
            "キー無し",
            "キーなし",
            "課金なし",
            "課金無し",
            "無料で使える",
            "無料のもの",
            "サブスクなし",
            "サブスク無し",
            "サブスクリプション無し",
        ),
        primary="market-regime-daily",
        secondary=("trade-memory-loop", "monthly-performance-review"),
        no_api=True,
        rationale="no-API path — only workflows that work without paid API keys",
    ),
    # Q1 — swing trade gated on market regime (swing AND regime-conditional).
    Persona(
        name="part-time-swing-trader-regime-gated",
        any_terms=("swing", "スイング"),
        require_groups=(
            (
                "only when",
                "favorable",
                "when the market",
                "when conditions",
                "if the market",
                "market allows",
                "market is good",
                "market permitting",
                "market environment",
                "when it's safe",
                "when its safe",
                "market is favorable",
                # JA regime-conditional
                "相場が良い",
                "相場が良い時",
                "相場次第",
                "地合いが良い",
                "市場が良い",
                "市場環境が良い",
                "環境が良い時",
                "良い時だけ",
                "条件が良い",
            ),
        ),
        primary="market-regime-daily",
        secondary=("swing-opportunity-daily",),
        rationale=(
            "part-time swing trader who only takes swing risk when the market "
            "regime is favorable — regime check first, then swing candidates"
        ),
    ),
    # Q2 — time-boxed morning risk check.
    Persona(
        name="morning-risk-check",
        any_terms=(
            "each morning",
            "every morning",
            "this morning",
            "in the morning",
            "15 min",
            "minutes each",
            "minutes every",
            "minutes before",
            "quick check",
            "take risk today",
            "risk today",
            "can i take risk",
            "is it safe to trade",
            "should i take risk",
            "take on risk today",
            "risk on today",
            # JA
            "毎朝",
            "朝の15分",
            "15分",
            "今日リスク",
            "今日はリスク",
            "リスクを取れる",
            "リスクを取って",
            "リスクオン",
            "今日エントリー",
            "今日トレードして",
            "相場に入れる",
        ),
        primary="market-regime-daily",
        rationale=(
            "time-constrained daily risk check — market regime / exposure posture for today"
        ),
    ),
    # Q3 — separate long-term holdings from short-term risk.
    Persona(
        name="separate-core-satellite",
        any_terms=(
            "separate",
            "core and satellite",
            "core vs satellite",
            "core-satellite",
            "long-term holdings from",
            "long term holdings from",
            "offense from defense",
            "keep long-term separate",
            "split",
            "isolate short-term",
            "short-term risk from",
            "short term risk from",
            # JA
            "分けたい",
            "分離",
            "切り分け",
            "区別したい",
            "コアとサテライト",
            "長期と短期を分け",
            "長期保有と短期",
        ),
        require_groups=(
            (
                "hold",
                "risk",
                "invest",
                "portfolio",
                "long-term",
                "long term",
                "trad",
                # JA
                "保有",
                "リスク",
                "投資",
                "ポートフォリオ",
                "長期",
                "短期",
                "トレード",
            ),
        ),
        exclude_terms=("dividend", "配当"),
        primary="market-regime-daily",
        secondary=("core-portfolio-weekly",),
        rationale=(
            "growth investor separating long-term core holdings from "
            "short-term trading risk — regime layer governs the satellite sleeve"
        ),
    ),
    # Q4 + Q6 — dividend / long-term core portfolio.
    Persona(
        name="dividend-long-term-investor",
        any_terms=(
            "dividend",
            "holdings",
            "my portfolio",
            "review my holdings",
            "rebalance",
            "allocation",
            "portfolio review",
            "portfolio structure",
            "income stock",
            "long-term investor",
            "long term investor",
            "buy and hold",
            "yield",
            # JA
            "配当",
            "配当株",
            "高配当",
            "増配",
            "インカム",
            "利回り",
            "保有銘柄",
            "保有を見直",
            "ポートフォリオを見直",
            "長期投資",
            "長期保有",
            "リバランス",
        ),
        primary="core-portfolio-weekly",
        rationale=(
            "dividend / long-term investor — weekly core-portfolio review and dividend candidates"
        ),
    ),
    # Q5 — generic swing trading (no regime gate; AFTER Q1 persona).
    Persona(
        name="swing-trader",
        any_terms=(
            "swing",
            "breakout",
            "momentum trade",
            "trade candidate",
            "trade setups",
            # JA
            "スイング",
            "スイングトレード",
            "ブレイクアウト",
            "押し目",
            "モメンタム",
            "短期売買",
        ),
        primary="swing-opportunity-daily",
        rationale=(
            "part-time swing trader — daily swing candidate generation and "
            "trade planning (run the market-regime check first)"
        ),
    ),
    # Q9 — beginner / starting path.
    Persona(
        name="beginner-onramp",
        any_terms=(
            "beginner",
            "starting path",
            "where do i start",
            "where should i start",
            "get started",
            "getting started",
            "new to",
            "just starting",
            "first time",
            "first skill",
            "onboard",
            "what should i start",
            "i'm new",
            "im new",
            "not sure where to start",
            "help me start",
            # JA
            "初心者",
            "初心者向け",
            "どこから始め",
            "何から始め",
            "始め方",
            "入門",
            "初めて",
            "最初に何",
            "使い方がわからない",
            "おすすめのスキル",
            "どれを使えば",
        ),
        primary="market-regime-daily",
        rationale=("beginner-friendly on-ramp — start with the no-API daily market-regime routine"),
    ),
    # Trade journaling / postmortem loop (PROJECT_VISION §7 shared layer).
    Persona(
        name="trade-journaler",
        any_terms=(
            "journal",
            "postmortem",
            "post-mortem",
            "record my trade",
            "closed trade",
            "review a closed",
            "lessons learned",
            "what went wrong with",
            "log my trade",
            "trade review after",
            # Post-trade coaching entry terms (added 2026-05-25 alongside the
            # trade-performance-coach skill integration in PR-G); without these,
            # natural-language queries like "post-trade coaching" fall back to
            # the beginner persona instead of trade-memory-loop.
            "post-trade coach",
            "post-trade coaching",
            "trade coach",
            "trade coaching",
            "performance coach",
            "trade-performance-coach",
            # JA
            "ジャーナル",
            "トレード記録",
            "売買記録",
            "振り返り",
            "ポストモーテム",
            "決済済み",
            "決済したトレード",
            "損切り後",
            "反省",
            "教訓",
            "トレードコーチ",
            "売買コーチ",
            "取引後レビュー",
            "トレード後レビュー",
        ),
        primary="trade-memory-loop",
        rationale="trade journaling / postmortem / post-trade coaching loop after a closed position",
    ),
    # Monthly performance review.
    Persona(
        name="monthly-reviewer",
        any_terms=(
            "monthly review",
            "monthly performance",
            "review the month",
            "end of month",
            "month-end review",
            "monthly retrospective",
            "review last month",
            "performance review",
            # JA
            "月次レビュー",
            "月次",
            "月末レビュー",
            "月間パフォーマンス",
            "今月の振り返り",
            "先月の振り返り",
            "月次の振り返り",
        ),
        primary="monthly-performance-review",
        rationale=(
            "monthly performance review — close the Plan->Trade->Record->Review->Improve loop"
        ),
    ),
)


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


@dataclass
class Recommendation:
    query: str
    rationale: list[str] = field(default_factory=list)


def normalize_query(query: str) -> str:
    return " ".join(query.lower().split())


def workflow_paid_api_reason(
    workflow: dict[str, Any], skills_by_id: dict[str, dict[str, Any]]
) -> str | None:
    """Return a human reason if the workflow needs a paid API, else None.

    'mixed' api_profile is NEVER trusted on its own — required-skill
    credentials are always inspected.
    """
    if workflow.get("api_profile") in API_REQUIRED_PROFILES:
        return f"api_profile is {workflow['api_profile']}"
    for sid in workflow.get("required_skills") or []:
        skill = skills_by_id.get(sid)
        if not skill:
            continue
        for ig in skill.get("integrations") or []:
            if ig.get("id") in PAID_INTEGRATION_IDS and ig.get("requirement") == "required":
                return f"required skill '{sid}' needs {ig['id']} (required)"
    return None


def dominant_category(workflow: dict[str, Any], skills_by_id: dict[str, dict[str, Any]]) -> str:
    """Skillset = the skills-index category of the workflow's FIRST required skill.

    First-required-skill (not most-common) is the contract rule: e.g.
    swing-opportunity-daily's required skills span swing-opportunity /
    trade-planning / trade-memory; only the first (vcp-screener →
    swing-opportunity) yields the contract-correct skillset.
    """
    for sid in workflow.get("required_skills") or []:
        skill = skills_by_id.get(sid)
        if skill:
            return skill.get("category", "meta")
    return "meta"


def _workflow_public_view(workflow: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": workflow["id"],
        "display_name": workflow["display_name"],
        "cadence": workflow["cadence"],
        "estimated_minutes": workflow["estimated_minutes"],
        "api_profile": workflow["api_profile"],
        "difficulty": workflow["difficulty"],
        "required_skills": list(workflow["required_skills"]),
        "optional_skills": list(workflow["optional_skills"]),
        "prerequisite_workflows": list(workflow["prerequisite_workflows"]),
    }


def _skillset_manifest_view(ss: dict[str, Any]) -> dict[str, Any]:
    # PR-N3: 5-key public view of a skillset manifest (no `id` — the id lives
    # on the outer skillset object). Mirrors _workflow_public_view. List order
    # is preserved from the manifest YAML (meaningful authored order).
    return {
        "display_name": ss["display_name"],
        "required_skills": list(ss["required_skills"]),
        "recommended_skills": list(ss["recommended_skills"]),
        "optional_skills": list(ss["optional_skills"]),
        "related_workflows": list(ss["related_workflows"]),
    }


def _skillset(
    category: str,
    skillset_ids: frozenset[str],
    skillsets_by_id: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    # PR-N2: "active" iff a skillsets/<category>.yaml manifest exists (its id
    # == the skills-index category). Honest-gap categories have no manifest
    # → "deferred". PR-N3: `manifest` is ALWAYS present (symmetric schema) —
    # the 5-key view when active, else None.
    active = category in skillset_ids
    return {
        "id": category,
        "source": "skills-index.category",
        "manifest_status": "active" if active else "deferred",
        "manifest": (
            _skillset_manifest_view(skillsets_by_id[category])
            if active and category in skillsets_by_id
            else None
        ),
    }


def _ordered_unique(items: list[str]) -> list[str]:
    return list(dict.fromkeys(items))


def _setup_bundle(
    skillset_id: str,
    skillset_manifest: dict[str, Any] | None,
    primary_wf: dict[str, Any] | None,
    secondary_wfs: list[dict[str, Any]],
) -> dict[str, Any]:
    """Deterministic install union over the primary skillset/workflow + every
    secondary workflow. `skillset_id` is threaded explicitly because the 5-key
    manifest view has no `id`. Tier precedence: required > recommended >
    optional (a skill never appears in two tiers). Order: primary first, then
    secondaries in order. Pure function of metadata → parity-safe."""
    required: list[str] = []
    recommended: list[str] = []
    optional: list[str] = []
    sources: list[str] = []

    if skillset_manifest is not None:
        required += skillset_manifest["required_skills"]
        recommended += skillset_manifest["recommended_skills"]
        optional += skillset_manifest["optional_skills"]
        sources.append(f"skillset:{skillset_id}")
    elif primary_wf is not None:
        required += primary_wf["required_skills"]
        optional += primary_wf["optional_skills"]
        sources.append(f"workflow:{primary_wf['id']}")

    for wf in secondary_wfs:
        required += wf["required_skills"]
        optional += wf["optional_skills"]
        sources.append(f"workflow:{wf['id']}")

    required = _ordered_unique(required)
    req_set = set(required)
    recommended = [s for s in _ordered_unique(recommended) if s not in req_set]
    rec_set = set(recommended)
    optional = [s for s in _ordered_unique(optional) if s not in req_set and s not in rec_set]
    return {
        "required": required,
        "recommended": recommended,
        "optional": optional,
        "sources": sources,
    }


def _parse_time_budget(value: str | None) -> int | None:
    if not value or value == "any":
        return None
    digits = value.rstrip("m").strip()
    try:
        return int(digits)
    except ValueError:
        return None


def _order_secondary(
    ids: list[str],
    workflows_by_id: dict[str, dict[str, Any]],
    *,
    experience: str | None,
    time_budget: int | None,
) -> list[str]:
    """Deterministic secondary ordering + soft time-budget filter."""

    def sort_key(wid: str) -> tuple[Any, ...]:
        wf = workflows_by_id.get(wid, {})
        est = wf.get("estimated_minutes")
        est_key = est if isinstance(est, int) else 9999
        beginner_first = 0
        if experience == "beginner":
            beginner_first = 0 if wf.get("difficulty") == "beginner" else 1
        return (beginner_first, est_key, wid)

    ordered = sorted(dict.fromkeys(ids), key=sort_key)
    if time_budget is not None:
        ordered = [
            wid
            for wid in ordered
            if not isinstance(workflows_by_id.get(wid, {}).get("estimated_minutes"), int)
            or workflows_by_id[wid]["estimated_minutes"] <= time_budget
        ]
    return ordered


def recommend(
    query: str,
    metadata: dict[str, Any],
    *,
    no_api: bool = False,
    time_budget: str | None = None,
    experience: str | None = None,
) -> dict[str, Any]:
    """Pure function: (query, metadata, constraints) -> stable result dict."""
    norm = normalize_query(query)
    skills_by_id = {s["id"]: s for s in metadata["skills"]}
    workflows_by_id = {w["id"]: w for w in metadata["workflows"]}
    skillsets_by_id = {s["id"]: s for s in (metadata.get("skillsets") or [])}
    skillset_ids = frozenset(skillsets_by_id)

    rationale: list[str] = []
    note: str | None = None
    honest_gap = False
    gap_category: str | None = None
    primary_id: str | None = None
    secondary_ids: list[str] = []

    matched = next((p for p in PERSONAS if p.matches(norm)), None)

    if matched is not None:
        rationale.append(f"matched persona: {matched.name} — {matched.rationale}")
        if matched.no_api:
            no_api = True
        if matched.gap_category is not None:
            honest_gap = True
            gap_category = matched.gap_category
        else:
            primary_id = matched.primary
            secondary_ids = list(matched.secondary)
    else:
        # Truly unmapped input: graceful beginner default (NOT honest-gap).
        primary_id = "market-regime-daily"
        rationale.append(
            "no specific intent matched — defaulting to the beginner-friendly market-regime on-ramp"
        )
        note = (
            "Query did not match a known persona; showing the universal "
            "beginner starting point. Rephrase with your goal (e.g. 'swing "
            "trading', 'dividend stocks', 'no API path') for a targeted "
            "recommendation."
        )

    time_budget_min = _parse_time_budget(time_budget)

    # ---- honest-gap branch -------------------------------------------------
    if honest_gap and gap_category is not None:
        suggested = sorted(
            (
                {
                    "id": s["id"],
                    "display_name": s["display_name"],
                    "category": s["category"],
                }
                for s in metadata["skills"]
                if s["category"] == gap_category and s["status"] != "deprecated"
            ),
            key=lambda s: s["id"],
        )
        note = (
            f"No dedicated workflow shipped yet for this intent. Suggested "
            f"individual skills from the '{gap_category}' category; a workflow "
            f"manifest is deferred to a later phase."
        )
        gap_skillset = _skillset(gap_category, skillset_ids, skillsets_by_id)
        return _finalize_result(
            query=query,
            primary=None,
            secondary=[],
            skillset=gap_skillset,
            # Honest gap: no manifest, no primary, no secondary → empty bundle.
            # The actionable install list for a gap is `suggested_skills`.
            setup_bundle=_setup_bundle(gap_skillset["id"], gap_skillset["manifest"], None, []),
            suggested_skills=suggested,
            no_api=no_api,
            no_api_path=None,  # honest gap has no path — contract column "—"
            honest_gap=True,
            note=note,
            rationale=rationale,
        )

    # ---- workflow branch ---------------------------------------------------
    assert primary_id is not None  # set in every non-gap path above

    if no_api:
        reason = workflow_paid_api_reason(workflows_by_id.get(primary_id, {}), skills_by_id)
        if reason is not None:
            rationale.append(
                f"--no-api: '{primary_id}' excluded ({reason}); defaulting to "
                f"the no-API on-ramp 'market-regime-daily'"
            )
            primary_id = "market-regime-daily"
        secondary_ids = [
            wid
            for wid in secondary_ids
            if workflow_paid_api_reason(workflows_by_id.get(wid, {}), skills_by_id) is None
        ]

    primary_wf = workflows_by_id.get(primary_id)
    if primary_wf is None:
        raise MetadataError(f"recommended workflow '{primary_id}' not in metadata")

    secondary_ids = [wid for wid in secondary_ids if wid != primary_id]
    secondary_ids = _order_secondary(
        secondary_ids,
        workflows_by_id,
        experience=experience,
        time_budget=time_budget_min,
    )

    skillset = _skillset(dominant_category(primary_wf, skills_by_id), skillset_ids, skillsets_by_id)
    rationale.append(
        f"skillset '{skillset['id']}' = category of "
        f"'{primary_wf['required_skills'][0]}' "
        f"(first required skill of {primary_wf['id']})"
        if primary_wf["required_skills"]
        else f"skillset '{skillset['id']}'"
    )
    if (
        time_budget_min is not None
        and isinstance(primary_wf["estimated_minutes"], int)
        and primary_wf["estimated_minutes"] > time_budget_min
    ):
        rationale.append(
            f"note: primary needs ~{primary_wf['estimated_minutes']}m, over "
            f"your {time_budget_min}m budget — it stays primary as the best "
            f"intent match"
        )

    # no_api_path = the WHOLE recommended path (primary + every secondary)
    # works without paid API keys. This is the contract's "no-API" column
    # (distinct from `no_api`, which is the request-side constraint flag):
    # e.g. Q1/Q2 both recommend market-regime-daily, but Q1 also pulls in
    # fmp-required swing-opportunity-daily so its path is NOT no-API.
    no_api_path = workflow_paid_api_reason(primary_wf, skills_by_id) is None and all(
        workflow_paid_api_reason(workflows_by_id[wid], skills_by_id) is None
        for wid in secondary_ids
    )

    primary_view = _workflow_public_view(primary_wf)
    secondary_views = [_workflow_public_view(workflows_by_id[wid]) for wid in secondary_ids]

    return _finalize_result(
        query=query,
        primary=primary_view,
        secondary=secondary_views,
        skillset=skillset,
        # Actionable install union: primary skillset (or primary workflow if no
        # manifest) + EVERY secondary workflow — so a multi-workflow rec never
        # drops a secondary's skills (e.g. Q1 keeps vcp-screener).
        setup_bundle=_setup_bundle(
            skillset["id"], skillset["manifest"], primary_view, secondary_views
        ),
        suggested_skills=[],
        no_api=no_api,
        no_api_path=no_api_path,
        honest_gap=False,
        note=note,
        rationale=rationale,
    )


def _finalize_result(
    *,
    query: str,
    primary: dict[str, Any] | None,
    secondary: list[dict[str, Any]],
    skillset: dict[str, Any],
    setup_bundle: dict[str, Any],
    suggested_skills: list[dict[str, str]],
    no_api: bool,
    no_api_path: bool | None,
    honest_gap: bool,
    note: str | None,
    rationale: list[str],
) -> dict[str, Any]:
    return {
        "query": query,
        "primary_workflow": primary,
        "secondary_workflows": secondary,
        "skillset": skillset,
        "setup_bundle": setup_bundle,
        "suggested_skills": suggested_skills,
        "no_api": no_api,
        "no_api_path": no_api_path,
        "honest_gap": honest_gap,
        "note": note,
        "rationale": rationale,
        "setup_path_ref": SETUP_PATH_REF,
    }


def dumps(result: dict[str, Any]) -> str:
    """Canonical, idempotent JSON string (stable bytes for golden tests)."""
    return json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


# ---------------------------------------------------------------------------
# Text rendering (for SKILL.md narration; tests use --format json)
# ---------------------------------------------------------------------------


def render_text(result: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append(f"Query: {result['query']}")
    if result["honest_gap"]:
        lines.append(f"Recommended workflow: (none yet — {result['skillset']['id']})")
        lines.append("Suggested skills:")
        for s in result["suggested_skills"]:
            lines.append(f"  - {s['display_name']} ({s['id']})")
    else:
        pw = result["primary_workflow"]
        lines.append(
            f"Primary workflow: {pw['display_name']} ({pw['id']}) — "
            f"{pw['cadence']}, ~{pw['estimated_minutes']}m, "
            f"api_profile={pw['api_profile']}"
        )
        for sw in result["secondary_workflows"]:
            lines.append(f"Secondary: {sw['display_name']} ({sw['id']})")
        lines.append(
            f"Skillset: {result['skillset']['id']} "
            f"(manifest_status={result['skillset']['manifest_status']})"
        )
        man = result["skillset"]["manifest"]
        if man is not None:
            lines.append(f"  Skillset manifest: {man['display_name']}")
            lines.append(f"    Required:    {', '.join(man['required_skills']) or '—'}")
            lines.append(f"    Recommended: {', '.join(man['recommended_skills']) or '—'}")
            lines.append(f"    Optional:    {', '.join(man['optional_skills']) or '—'}")
            lines.append(f"    Related workflows: {', '.join(man['related_workflows']) or '—'}")
    sb = result["setup_bundle"]
    if result["honest_gap"]:
        lines.append("Setup bundle: (use suggested skills above)")
    else:
        lines.append("Setup bundle:")
        lines.append(f"  Required:    {', '.join(sb['required']) or '—'}")
        lines.append(f"  Recommended: {', '.join(sb['recommended']) or '—'}")
        lines.append(f"  Optional:    {', '.join(sb['optional']) or '—'}")
        lines.append(f"  Sources:     {', '.join(sb['sources']) or '—'}")
    if result["no_api_path"] is None:
        lines.append("No-API path: n/a (no workflow shipped)")
    else:
        lines.append(
            f"No-API path: {'yes' if result['no_api_path'] else 'no'} (works without paid API keys)"
        )
    lines.append(f"No-API mode requested: {result['no_api']}")
    if result["note"]:
        lines.append(f"Note: {result['note']}")
    lines.append("Why:")
    for r in result["rationale"]:
        lines.append(f"  - {r}")
    lines.append(f"Setup path: {result['setup_path_ref']}")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Recommend a trading workflow / skillset / setup path from a natural-language goal."
        )
    )
    parser.add_argument("--query", required=True, help="Natural-language trading goal")
    parser.add_argument(
        "--no-api",
        action="store_true",
        help="Only recommend workflows that work without paid API keys",
    )
    parser.add_argument(
        "--time-budget",
        choices=["15m", "30m", "60m", "90m", "any"],
        default="any",
        help="Daily time budget (soft tie-break / secondary filter)",
    )
    parser.add_argument(
        "--experience",
        choices=["beginner", "intermediate", "advanced"],
        default=None,
        help="Experience level (soft tie-break)",
    )
    parser.add_argument("--format", choices=["text", "json"], default="text", help="Output format")
    parser.add_argument(
        "--project-root",
        type=Path,
        default=Path.cwd(),
        help="Repository root for the SSoT (default: cwd). Falls back to the "
        "bundled snapshot when the SSoT is absent (Claude Web App).",
    )
    args = parser.parse_args(argv)

    if not args.query or not args.query.strip():
        print("ERROR: --query must not be empty", file=sys.stderr)
        return 1

    try:
        metadata, source = resolve_metadata(args.project_root)
    except MetadataError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    result = recommend(
        args.query,
        metadata,
        no_api=args.no_api,
        time_budget=args.time_budget,
        experience=args.experience,
    )
    # Source is environment info, NOT part of the recommendation — keep it off
    # stdout so SSoT vs snapshot output stays byte-identical (parity invariant).
    print(f"metadata source: {source}", file=sys.stderr)

    if args.format == "json":
        sys.stdout.write(dumps(result))
    else:
        sys.stdout.write(render_text(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
