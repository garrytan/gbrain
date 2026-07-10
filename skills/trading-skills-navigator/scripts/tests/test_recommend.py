"""Trading Skills Navigator — golden + behavioral tests.

The 10-Question Contract (PROJECT_VISION.md §12 DoD made executable) is the
hard gate: each row asserts exact primary_workflow.id / secondary set /
skillset.id / honest_gap against the REAL repo SSoT.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import build_snapshot  # noqa: E402
from recommend import (  # noqa: E402
    PERSONAS,
    dumps,
    main,
    recommend,
    render_text,
    resolve_metadata,
    workflow_paid_api_reason,
)

# ---------------------------------------------------------------------------
# The 10-Question Contract
#   (num, query, primary, secondary_set, skillset, honest_gap, no_api_path,
#    manifest_status)
# no_api_path = the WHOLE recommended path works without paid API keys
# (PROJECT_VISION.md §12 / intent_routing.md "no-API" column). None on a
# honest gap (no path → contract column "—").
# manifest_status (PR-N2): "active" iff a skillsets/<skillset>.yaml manifest
# ships (market-regime / core-portfolio / swing-opportunity / trade-memory);
# honest-gap categories (advanced-satellite / strategy-research) stay
# "deferred". The PR-N2 diff vs PR-N1 is EXACTLY this column — every other
# value is byte-unchanged (proves manifests didn't perturb routing).
# ---------------------------------------------------------------------------

CONTRACT: list[tuple[int, str, str | None, set[str], str, bool, bool | None, str]] = [
    (
        1,
        "I want to invest long term but swing trade only when the market is favorable",
        "market-regime-daily",
        {"swing-opportunity-daily"},
        "market-regime",
        False,
        False,  # path includes fmp-required swing-opportunity-daily
        "active",
    ),
    (
        2,
        "I have 15 minutes each morning and want to know whether I can take risk today",
        "market-regime-daily",
        set(),
        "market-regime",
        False,
        True,
        "active",
    ),
    (
        3,
        "I want to separate long-term holdings from short-term trading risk",
        "market-regime-daily",
        {"core-portfolio-weekly"},
        "market-regime",
        False,
        False,  # path includes alpaca-required core-portfolio-weekly
        "active",
    ),
    (
        4,
        "I want to review my holdings and dividend candidates this week",
        "core-portfolio-weekly",
        set(),
        "core-portfolio",
        False,
        False,  # core-portfolio-weekly → portfolio-manager needs Alpaca
        "active",
    ),
    (
        5,
        "I want to do swing trading",
        "swing-opportunity-daily",
        set(),
        "swing-opportunity",
        False,
        False,  # swing-opportunity-daily is fmp-required
        "active",
    ),
    (
        6,
        "I want to find dividend stocks",
        "core-portfolio-weekly",
        set(),
        "core-portfolio",
        False,
        False,
        "active",
    ),
    (
        7,
        "I want to use short strategies",
        None,
        set(),
        "advanced-satellite",
        True,
        None,
        "deferred",  # honest gap — no manifest
    ),
    (
        8,
        "I want to know what works without API keys",
        "market-regime-daily",
        {"trade-memory-loop", "monthly-performance-review"},
        "market-regime",
        False,
        True,  # MR + TM + MP are all no-api-basic
        "active",
    ),
    (
        9,
        "I want a beginner-friendly starting path",
        "market-regime-daily",
        set(),
        "market-regime",
        False,
        True,
        "active",
    ),
    (
        10,
        "I want to research and backtest new strategy ideas",
        None,
        set(),
        "strategy-research",
        True,
        None,
        "deferred",  # honest gap — no manifest
    ),
]


@pytest.mark.parametrize(
    "num,query,exp_primary,exp_secondary,exp_skillset,exp_gap,exp_no_api_path,exp_manifest_status",
    CONTRACT,
    ids=[f"Q{row[0]}" for row in CONTRACT],
)
def test_ten_question_contract(
    repo_metadata: dict[str, Any],
    num: int,
    query: str,
    exp_primary: str | None,
    exp_secondary: set[str],
    exp_skillset: str,
    exp_gap: bool,
    exp_no_api_path: bool | None,
    exp_manifest_status: str,
) -> None:
    r = recommend(query, repo_metadata)
    primary_id = r["primary_workflow"]["id"] if r["primary_workflow"] else None
    secondary_ids = {w["id"] for w in r["secondary_workflows"]}
    assert primary_id == exp_primary, f"Q{num} primary"
    assert secondary_ids == exp_secondary, f"Q{num} secondary"
    assert r["skillset"]["id"] == exp_skillset, f"Q{num} skillset"
    assert r["honest_gap"] is exp_gap, f"Q{num} honest_gap"
    assert r["no_api_path"] == exp_no_api_path, f"Q{num} no_api_path"
    assert r["skillset"]["manifest_status"] == exp_manifest_status, f"Q{num} manifest_status"
    assert r["skillset"]["source"] == "skills-index.category"
    # PR-N3: active rows surface the on-disk manifest; deferred → null.
    manifest = r["skillset"]["manifest"]
    if exp_manifest_status == "active":
        ss = {s["id"]: s for s in repo_metadata["skillsets"]}[exp_skillset]
        assert manifest is not None, f"Q{num} manifest present"
        assert manifest["required_skills"] == ss["required_skills"], f"Q{num} manifest req"
    else:
        assert manifest is None, f"Q{num} manifest null on deferred"


@pytest.mark.parametrize(
    "query",
    [
        "post-trade coaching",
        "post-trade coach",
        "trade coach",
        "trade coaching",
        "performance coach",
        "トレードコーチ",
        "取引後レビュー",
    ],
    ids=[
        "en-post-trade-coaching",
        "en-post-trade-coach",
        "en-trade-coach",
        "en-trade-coaching",
        "en-performance-coach",
        "ja-トレードコーチ",
        "ja-取引後レビュー",
    ],
)
def test_post_trade_coaching_routes_to_trade_memory_loop(
    repo_metadata: dict[str, Any], query: str
) -> None:
    """Regression (2026-05-25 PR-G review):
    post-trade coaching entry terms must route to trade-memory-loop with
    trade-performance-coach surfaced in the setup_bundle.recommended list.
    Before PR-G's recommend.py update, these queries fell back to the
    beginner persona (market-regime-daily).
    """
    r = recommend(query, repo_metadata)
    assert r["primary_workflow"] is not None
    assert r["primary_workflow"]["id"] == "trade-memory-loop", (
        f"query {query!r} should route to trade-memory-loop, got {r['primary_workflow']['id']!r}"
    )
    bundle = r["setup_bundle"]
    # trade-performance-coach is in the workflow's optional_skills and the
    # skillset's recommended_skills; it must appear in the setup bundle.
    bundle_skills = set(bundle.get("recommended", []))
    bundle_skills.update(bundle.get("required", []))
    bundle_skills.update(bundle.get("optional", []))
    assert "trade-performance-coach" in bundle_skills, (
        f"query {query!r} setup_bundle missing trade-performance-coach; "
        f"bundle keys = {sorted(bundle.keys())}, recommended = "
        f"{bundle.get('recommended')}"
    )


def test_honest_gap_returns_suggested_skills(repo_metadata: dict[str, Any]) -> None:
    for query, cat in [
        ("I want to use short strategies", "advanced-satellite"),
        ("I want to research and backtest new strategy ideas", "strategy-research"),
    ]:
        r = recommend(query, repo_metadata)
        assert r["honest_gap"] is True
        assert r["primary_workflow"] is None
        assert r["secondary_workflows"] == []
        assert r["skillset"]["id"] == cat
        assert r["suggested_skills"], f"{cat}: suggested_skills must be non-empty"
        ids = [s["id"] for s in r["suggested_skills"]]
        assert ids == sorted(ids), "suggested_skills must be id-sorted (stable)"
        for s in r["suggested_skills"]:
            assert s["category"] == cat
        assert r["note"] and "deferred" in r["note"]


# ---------------------------------------------------------------------------
# Credential-aware --no-api filter
# ---------------------------------------------------------------------------


def test_no_api_excludes_fmp_required_swing(repo_metadata: dict[str, Any]) -> None:
    r = recommend("I want to find swing candidates", repo_metadata, no_api=True)
    assert r["primary_workflow"]["id"] == "market-regime-daily"
    assert r["no_api"] is True
    assert any("swing-opportunity-daily" in x and "excluded" in x for x in r["rationale"])


def test_no_api_excludes_alpaca_required_core_portfolio(
    repo_metadata: dict[str, Any],
) -> None:
    # core-portfolio-weekly is api_profile: mixed, but its required
    # portfolio-manager needs Alpaca (required) -> must be excluded.
    r = recommend("I want to review holdings this week", repo_metadata, no_api=True)
    assert r["primary_workflow"]["id"] == "market-regime-daily"
    assert any(
        "core-portfolio-weekly" in x and "portfolio-manager" in x and "alpaca" in x
        for x in r["rationale"]
    )


def test_no_api_keeps_no_api_basic_workflow(repo_metadata: dict[str, Any]) -> None:
    wf = {w["id"]: w for w in repo_metadata["workflows"]}
    skills = {s["id"]: s for s in repo_metadata["skills"]}
    # market-regime-daily: no-api-basic + public_csv "required" (NOT paid).
    assert workflow_paid_api_reason(wf["market-regime-daily"], skills) is None
    # swing-opportunity-daily: api_profile fmp-required.
    assert workflow_paid_api_reason(wf["swing-opportunity-daily"], skills) is not None


def test_credential_rule_isolated(write_index, write_workflow) -> None:
    """public_csv 'required' must NOT count as paid; fmp 'required' must."""
    from recommend import normalize_skill, normalize_workflow

    skills = {
        "csv-skill": normalize_skill(
            {
                "id": "csv-skill",
                "display_name": "CSV Skill",
                "category": "market-regime",
                "status": "production",
                "summary": "x",
                "integrations": [
                    {"id": "public_csv", "type": "local_file", "requirement": "required"}
                ],
            }
        ),
        "fmp-skill": normalize_skill(
            {
                "id": "fmp-skill",
                "display_name": "FMP Skill",
                "category": "swing-opportunity",
                "status": "production",
                "summary": "x",
                "integrations": [{"id": "fmp", "type": "market_data", "requirement": "required"}],
            }
        ),
    }
    free_wf = normalize_workflow(
        {"id": "free-wf", "api_profile": "no-api-basic", "required_skills": ["csv-skill"]}
    )
    paid_wf = normalize_workflow(
        {"id": "paid-wf", "api_profile": "mixed", "required_skills": ["fmp-skill"]}
    )
    assert workflow_paid_api_reason(free_wf, skills) is None
    assert workflow_paid_api_reason(paid_wf, skills) is not None


# ---------------------------------------------------------------------------
# experience / time-budget tie-break
# ---------------------------------------------------------------------------


def test_time_budget_filters_long_secondary(repo_metadata: dict[str, Any]) -> None:
    # Q8 secondary: trade-memory-loop (30m) + monthly-performance-review (90m).
    full = recommend("what works without API keys", repo_metadata)
    assert {w["id"] for w in full["secondary_workflows"]} == {
        "trade-memory-loop",
        "monthly-performance-review",
    }
    budget = recommend("what works without API keys", repo_metadata, time_budget="30m")
    assert [w["id"] for w in budget["secondary_workflows"]] == ["trade-memory-loop"]


def test_secondary_ordering_is_deterministic(repo_metadata: dict[str, Any]) -> None:
    r = recommend("what works without API keys", repo_metadata)
    ids = [w["id"] for w in r["secondary_workflows"]]
    # Sorted by estimated_minutes asc: trade-memory-loop(30) < mpr(90).
    assert ids == ["trade-memory-loop", "monthly-performance-review"]


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_empty_query_exits_one(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["--query", "   "]) == 1
    assert "must not be empty" in capsys.readouterr().err


def test_gibberish_graceful_beginner_default(repo_metadata: dict[str, Any]) -> None:
    r = recommend("asdf qwer zxcv 12345", repo_metadata)
    assert r["primary_workflow"]["id"] == "market-regime-daily"
    assert r["honest_gap"] is False
    assert r["suggested_skills"] == []
    assert r["note"] and "did not match" in r["note"]


def test_json_schema_keys_present(repo_metadata: dict[str, Any]) -> None:
    r = recommend("I want to do swing trading", repo_metadata)
    assert set(r) == {
        "query",
        "primary_workflow",
        "secondary_workflows",
        "skillset",
        "setup_bundle",
        "suggested_skills",
        "no_api",
        "no_api_path",
        "honest_gap",
        "note",
        "rationale",
        "setup_path_ref",
    }
    pw = r["primary_workflow"]
    assert set(pw) >= {
        "id",
        "display_name",
        "cadence",
        "estimated_minutes",
        "api_profile",
        "difficulty",
        "required_skills",
        "optional_skills",
        "prerequisite_workflows",
    }
    assert set(r["skillset"]) == {"id", "source", "manifest_status", "manifest"}
    assert set(r["skillset"]["manifest"]) == {
        "display_name",
        "required_skills",
        "recommended_skills",
        "optional_skills",
        "related_workflows",
    }  # swing query → active manifest
    assert set(r["setup_bundle"]) == {
        "required",
        "recommended",
        "optional",
        "sources",
    }
    assert r["setup_path_ref"] == "references/setup_paths.md"


def test_json_output_is_idempotent(repo_metadata: dict[str, Any]) -> None:
    q = "I want to invest long term but swing trade only when the market is favorable"
    assert dumps(recommend(q, repo_metadata)) == dumps(recommend(q, repo_metadata))


# ---------------------------------------------------------------------------
# no_api_path (the contract "no-API" column — distinct from request `no_api`)
# ---------------------------------------------------------------------------


def test_no_api_path_true_for_pure_no_api_recommendation(
    repo_metadata: dict[str, Any],
) -> None:
    # Q2 / Q9: recommend market-regime-daily only, no --no-api flag passed.
    for q in (
        "I have 15 minutes each morning, can I take risk today",
        "I want a beginner-friendly starting path",
    ):
        r = recommend(q, repo_metadata)
        assert r["primary_workflow"]["id"] == "market-regime-daily"
        assert r["no_api"] is False, "no flag passed → request mode stays False"
        assert r["no_api_path"] is True, "but the recommended path IS no-API"


def test_no_api_path_false_when_path_needs_paid_api(
    repo_metadata: dict[str, Any],
) -> None:
    r = recommend("I want to do swing trading", repo_metadata)
    assert r["primary_workflow"]["id"] == "swing-opportunity-daily"
    assert r["no_api_path"] is False  # fmp-required


def test_no_api_path_none_on_honest_gap(repo_metadata: dict[str, Any]) -> None:
    r = recommend("I want to use short strategies", repo_metadata)
    assert r["honest_gap"] is True
    assert r["no_api_path"] is None


# ---------------------------------------------------------------------------
# PR-N2: skillset manifest consumption (manifest_status active/deferred)
# ---------------------------------------------------------------------------

SHIPPED_SKILLSETS = {
    "market-regime",
    "core-portfolio",
    "swing-opportunity",
    "trade-memory",
}


def _skill_md_advertised_counts(repo_root: Path) -> tuple[int, int]:
    text = (repo_root / "skills" / "trading-skills-navigator" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    match = re.search(r"A new user faces (\d+) skills \+ (\d+) workflows", text)
    assert match, "SKILL.md must advertise the current skill/workflow counts"
    return int(match.group(1)), int(match.group(2))


def test_skill_md_advertised_counts_match_metadata(
    repo_root: Path, repo_metadata: dict[str, Any], bundled_metadata: dict[str, Any]
) -> None:
    advertised = _skill_md_advertised_counts(repo_root)
    repo_counts = (len(repo_metadata["skills"]), len(repo_metadata["workflows"]))
    snapshot_counts = (
        len(bundled_metadata["skills"]),
        len(bundled_metadata["workflows"]),
    )
    assert advertised == repo_counts
    assert snapshot_counts == repo_counts


def test_metadata_carries_skillsets(
    repo_metadata: dict[str, Any], bundled_metadata: dict[str, Any]
) -> None:
    ssot_ids = {s["id"] for s in repo_metadata["skillsets"]}
    snap_ids = {s["id"] for s in bundled_metadata["skillsets"]}
    assert ssot_ids == SHIPPED_SKILLSETS
    assert snap_ids == SHIPPED_SKILLSETS  # snapshot mirrors the SSoT


@pytest.mark.parametrize(
    "query,exp_skillset",
    [
        ("I want to do swing trading", "swing-opportunity"),
        ("I want to find dividend stocks", "core-portfolio"),
        ("I have 15 minutes each morning can I take risk today", "market-regime"),
    ],
    ids=["swing", "dividend", "regime"],
)
def test_skillset_manifest_active_for_shipped_categories(
    repo_metadata: dict[str, Any], query: str, exp_skillset: str
) -> None:
    r = recommend(query, repo_metadata)
    assert r["skillset"]["id"] == exp_skillset
    assert r["skillset"]["manifest_status"] == "active"


@pytest.mark.parametrize(
    "query,exp_skillset",
    [
        ("I want to use short strategies", "advanced-satellite"),
        ("I want to research and backtest new strategy ideas", "strategy-research"),
    ],
    ids=["short-gap", "research-gap"],
)
def test_skillset_deferred_without_manifest(
    repo_metadata: dict[str, Any], query: str, exp_skillset: str
) -> None:
    r = recommend(query, repo_metadata)
    assert r["skillset"]["id"] == exp_skillset
    assert r["honest_gap"] is True
    assert r["skillset"]["manifest_status"] == "deferred"


def test_skillset_deferred_when_no_skillsets_in_metadata(
    repo_metadata: dict[str, Any],
) -> None:
    # Strip skillsets → every recommendation must fall back to "deferred"
    # (proves manifest_status is driven by metadata, not hardcoded active).
    stripped = {**repo_metadata, "skillsets": []}
    r = recommend("I want to do swing trading", stripped)
    assert r["skillset"]["id"] == "swing-opportunity"
    assert r["skillset"]["manifest_status"] == "deferred"


# ---------------------------------------------------------------------------
# PR-N3: skillset.manifest surface + setup_bundle (manifest-driven setup)
# ---------------------------------------------------------------------------

# (query, expected primary skillset, secondary workflow ids, their required skills)
_SECONDARY_DROP_CASES = [
    (
        "I want to invest long term but swing trade only when the market is favorable",
        "market-regime",
        {"swing-opportunity-daily"},
    ),
    (
        "I want to separate long-term holdings from short-term trading risk",
        "market-regime",
        {"core-portfolio-weekly"},
    ),
    (
        "I want to know what works without API keys",
        "market-regime",
        {"trade-memory-loop", "monthly-performance-review"},
    ),
]


@pytest.mark.parametrize(
    "query,exp_skillset,exp_secondary",
    _SECONDARY_DROP_CASES,
    ids=["Q1", "Q3", "Q8"],
)
def test_setup_bundle_does_not_drop_secondary_skills(
    repo_metadata: dict[str, Any],
    query: str,
    exp_skillset: str,
    exp_secondary: set[str],
) -> None:
    """The High-finding gate: setup_bundle.required must include the primary
    skillset's required skills AND every secondary workflow's required skills
    (e.g. Q1 must keep vcp-screener from swing-opportunity-daily)."""
    wf = {w["id"]: w for w in repo_metadata["workflows"]}
    ss = {s["id"]: s for s in repo_metadata["skillsets"]}
    r = recommend(query, repo_metadata)
    sb = r["setup_bundle"]
    req = set(sb["required"])

    assert set(ss[exp_skillset]["required_skills"]) <= req
    sec_ids = {w["id"] for w in r["secondary_workflows"]}
    assert sec_ids == exp_secondary
    for wid in sec_ids:
        assert set(wf[wid]["required_skills"]) <= req, f"{wid} required dropped"

    # No skill appears in two tiers.
    assert not (set(sb["required"]) & set(sb["recommended"]))
    assert not (set(sb["required"]) & set(sb["optional"]))
    assert not (set(sb["recommended"]) & set(sb["optional"]))

    # sources: primary skillset first, then each secondary workflow.
    assert sb["sources"][0] == f"skillset:{exp_skillset}"
    assert set(sb["sources"][1:]) == {f"workflow:{w}" for w in exp_secondary}


def test_setup_bundle_deterministic_and_ordered(repo_metadata: dict[str, Any]) -> None:
    q = "I want to invest long term but swing trade only when the market is favorable"
    a = recommend(q, repo_metadata)["setup_bundle"]
    b = recommend(q, repo_metadata)["setup_bundle"]
    assert a == b  # deterministic
    # Primary skillset's required skills come before the secondary's.
    req = a["required"]
    assert req.index("market-breadth-analyzer") < req.index("vcp-screener")


def test_skillset_manifest_contents_match_yaml(
    repo_metadata: dict[str, Any], repo_root: Path
) -> None:
    y = yaml.safe_load((repo_root / "skillsets" / "swing-opportunity.yaml").read_text())
    m = recommend("I want to do swing trading", repo_metadata)["skillset"]["manifest"]
    assert m is not None
    assert m["display_name"] == y["display_name"]
    assert m["required_skills"] == y["required_skills"]
    assert m["recommended_skills"] == y["recommended_skills"]
    assert m["optional_skills"] == y["optional_skills"]
    assert m["related_workflows"] == y["related_workflows"]


@pytest.mark.parametrize(
    "query",
    [
        "I want to use short strategies",
        "I want to research and backtest new strategy ideas",
    ],
    ids=["short-gap", "research-gap"],
)
def test_setup_bundle_empty_on_honest_gap(repo_metadata: dict[str, Any], query: str) -> None:
    r = recommend(query, repo_metadata)
    assert r["honest_gap"] is True
    assert r["skillset"]["manifest"] is None
    assert r["setup_bundle"] == {
        "required": [],
        "recommended": [],
        "optional": [],
        "sources": [],
    }
    assert r["suggested_skills"], "suggested_skills is the gap install list"


def test_manifest_null_when_no_skillsets_falls_back_to_workflows(
    repo_metadata: dict[str, Any],
) -> None:
    # No skillsets → manifest None; setup_bundle must still be built from the
    # primary + secondary workflows (metadata-driven, not hardcoded).
    stripped = {**repo_metadata, "skillsets": []}
    r = recommend(
        "I want to invest long term but swing trade only when the market is favorable",
        stripped,
    )
    assert r["skillset"]["manifest"] is None
    sb = r["setup_bundle"]
    assert "market-breadth-analyzer" in sb["required"]  # primary workflow
    assert "vcp-screener" in sb["required"]  # secondary workflow
    assert sb["sources"][0] == "workflow:market-regime-daily"


def test_render_text_active_lists_manifest_and_bundle(
    repo_metadata: dict[str, Any],
) -> None:
    txt = render_text(
        recommend(
            "I want to invest long term but swing trade only when the market is favorable",
            repo_metadata,
        )
    )
    assert "Skillset manifest: Market Regime" in txt
    assert "Setup bundle:" in txt
    assert "vcp-screener" in txt  # secondary skill surfaced
    assert "Sources:" in txt
    assert "skillset:market-regime" in txt


def test_render_text_honest_gap_no_bundle(repo_metadata: dict[str, Any]) -> None:
    txt = render_text(recommend("I want to use short strategies", repo_metadata))
    assert "Suggested skills:" in txt
    assert "Setup bundle: (use suggested skills above)" in txt
    assert "Skillset manifest:" not in txt


# ---------------------------------------------------------------------------
# Bilingual (Japanese) routing — SKILL.md advertises JA triggers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "query,exp_primary,exp_gap,exp_skillset",
    [
        # reviewer's three regression examples
        ("API キー無しで使えるものを教えて", "market-regime-daily", False, "market-regime"),
        ("スイングトレードをしたい", "swing-opportunity-daily", False, "swing-opportunity"),
        ("配当株を探したい", "core-portfolio-weekly", False, "core-portfolio"),
        # a few more JA personas
        ("初心者だけどどこから始めればいい", "market-regime-daily", False, "market-regime"),
        ("ショート戦略を使いたい", None, True, "advanced-satellite"),
        ("新しい戦略をバックテストしたい", None, True, "strategy-research"),
        ("毎朝15分で今日リスクを取れるか知りたい", "market-regime-daily", False, "market-regime"),
    ],
    ids=[
        "ja-no-api",
        "ja-swing",
        "ja-dividend",
        "ja-beginner",
        "ja-short-gap",
        "ja-research-gap",
        "ja-morning",
    ],
)
def test_japanese_queries_route(
    repo_metadata: dict[str, Any],
    query: str,
    exp_primary: str | None,
    exp_gap: bool,
    exp_skillset: str,
) -> None:
    r = recommend(query, repo_metadata)
    primary_id = r["primary_workflow"]["id"] if r["primary_workflow"] else None
    assert primary_id == exp_primary, f"JA route: {query}"
    assert r["honest_gap"] is exp_gap
    assert r["skillset"]["id"] == exp_skillset
    # JA queries must NOT fall through to the unmapped beginner default note.
    assert not (r["note"] and "did not match" in r["note"]), (
        f"JA query fell through to unmapped default: {query}"
    )


# ---------------------------------------------------------------------------
# Snapshot parity (Web App fallback must be byte-identical to the SSoT path)
# ---------------------------------------------------------------------------

PARITY_QUERIES = [row[1] for row in CONTRACT] + ["asdf qwer zxcv"]


@pytest.mark.parametrize("query", PARITY_QUERIES)
def test_ssot_snapshot_parity(
    repo_metadata: dict[str, Any], bundled_metadata: dict[str, Any], query: str
) -> None:
    assert dumps(recommend(query, repo_metadata)) == dumps(recommend(query, bundled_metadata))


def test_snapshot_not_drifted_from_ssot(repo_root: Path) -> None:
    rc = build_snapshot.main(["--project-root", str(repo_root), "--check"])
    assert rc == 0, "metadata_snapshot.json is out of sync — run build_snapshot.py"


def test_resolve_metadata_prefers_ssot(repo_root: Path) -> None:
    md, source = resolve_metadata(repo_root)
    assert source == "ssot"
    # Expect at least 5 workflows; new workflows can be added without churning this test.
    assert len(md["workflows"]) >= 5


def test_resolve_metadata_falls_back_to_snapshot(tmp_path: Path) -> None:
    # tmp_path has no skills-index.yaml/workflows -> must use bundled snapshot.
    md, source = resolve_metadata(tmp_path)
    assert source == "snapshot"
    assert len(md["workflows"]) >= 5


# ---------------------------------------------------------------------------
# Persona table sanity
# ---------------------------------------------------------------------------


def test_persona_targets_resolve(repo_metadata: dict[str, Any]) -> None:
    wf_ids = {w["id"] for w in repo_metadata["workflows"]}
    cats = {s["category"] for s in repo_metadata["skills"]}
    for p in PERSONAS:
        if p.gap_category is not None:
            assert p.gap_category in cats, p.name
        else:
            assert p.primary in wf_ids, p.name
            for sid in p.secondary:
                assert sid in wf_ids, f"{p.name}:{sid}"
