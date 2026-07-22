#!/usr/bin/env python3
"""
Read-only semantic clustering spike for a GBrain Postgres brain.

This is a sidecar experiment, not a production GBrain command. It reads a bounded
sample of existing embeddings, asks Postgres/pgvector for nearest neighbors, and
writes local Markdown/JSON reports. It never writes to GBrain tables.

Requirements:
  python3 -m pip install psycopg2-binary

Usage:
  GBRAIN_SPIKE_SOURCE=default \
  GBRAIN_SPIKE_LIMIT=300 \
  GBRAIN_SPIKE_K=10 \
  GBRAIN_SPIKE_MAX_DISTANCE=0.18 \
  python3 scripts/spike-semantic-clusters.py

Privacy:
  Do not commit generated reports from real private brains to a public repo.
"""
from __future__ import annotations

import collections
import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

try:
    import psycopg2  # type: ignore
except ImportError as exc:  # pragma: no cover - operator setup path
    raise SystemExit(
        "Missing dependency: psycopg2. Install with `python3 -m pip install psycopg2-binary`."
    ) from exc


def load_config() -> dict[str, Any]:
    cfg_path = Path(os.environ.get("GBRAIN_CONFIG", "~/.gbrain/config.json")).expanduser()
    with cfg_path.open() as f:
        cfg = json.load(f)
    if not cfg.get("database_url"):
        raise SystemExit(f"No database_url found in {cfg_path}")
    return cfg


def gbrain_version() -> str:
    try:
        return subprocess.check_output(["gbrain", "--version"], text=True).strip()
    except Exception:
        return "unknown"


def find(parent: dict[str, str], node: str) -> str:
    parent.setdefault(node, node)
    while parent[node] != node:
        parent[node] = parent[parent[node]]
        node = parent[node]
    return node


def union(parent: dict[str, str], a: str, b: str) -> None:
    root_a = find(parent, a)
    root_b = find(parent, b)
    if root_a != root_b:
        parent[root_b] = root_a


def main() -> int:
    cfg = load_config()
    source_id = os.environ.get("GBRAIN_SPIKE_SOURCE", "default")
    anchor_limit = int(os.environ.get("GBRAIN_SPIKE_LIMIT", "300"))
    k = int(os.environ.get("GBRAIN_SPIKE_K", "10"))
    max_distance = float(os.environ.get("GBRAIN_SPIKE_MAX_DISTANCE", "0.18"))
    out_dir = Path(os.environ.get("GBRAIN_SPIKE_OUT", "/tmp/gbrain-semantic-cluster-spike"))
    out_dir.mkdir(parents=True, exist_ok=True)

    included_types = tuple(
        os.environ.get(
            "GBRAIN_SPIKE_TYPES",
            "person,company,organization,entity,concept,operation,project,case,decision,workflow,policy,idea,original,note",
        ).split(",")
    )

    conn = psycopg2.connect(cfg["database_url"])
    conn.autocommit = True
    cur = conn.cursor()

    cur.execute(
        """
        SELECT c.id, p.slug, p.type, COALESCE(p.title,p.slug) AS title,
               left(regexp_replace(c.chunk_text, '\\s+', ' ', 'g'), 220) AS snippet,
               c.embedding::text AS embedding
        FROM content_chunks c
        JOIN pages p ON p.id = c.page_id
        WHERE c.embedding IS NOT NULL
          AND p.deleted_at IS NULL
          AND COALESCE(p.source_id,'default') = %s
          AND c.chunk_index = 0
          AND (p.type = ANY(%s) OR p.type IS NULL)
        ORDER BY p.updated_at DESC NULLS LAST, p.slug
        LIMIT %s
        """,
        (source_id, list(included_types), anchor_limit),
    )
    anchors = [
        {
            "id": row[0],
            "slug": row[1],
            "type": row[2],
            "title": row[3],
            "snippet": row[4],
            "embedding": row[5],
        }
        for row in cur.fetchall()
    ]

    neighbor_sql = """
        SELECT c.id, p.slug, p.type, COALESCE(p.title,p.slug) AS title,
               (c.embedding <=> %s::vector) AS distance
        FROM content_chunks c
        JOIN pages p ON p.id = c.page_id
        WHERE c.embedding IS NOT NULL
          AND p.deleted_at IS NULL
          AND COALESCE(p.source_id,'default') = %s
          AND c.chunk_index = 0
          AND c.id <> %s
          AND (p.type = ANY(%s) OR p.type IS NULL)
        ORDER BY c.embedding <=> %s::vector
        LIMIT %s
    """

    edges: list[dict[str, Any]] = []
    meta: dict[str, dict[str, Any]] = {anchor["slug"]: anchor for anchor in anchors}

    for anchor in anchors:
        cur.execute(neighbor_sql, (anchor["embedding"], source_id, anchor["id"], list(included_types), anchor["embedding"], k))
        for _chunk_id, slug, page_type, title, distance in cur.fetchall():
            distance = float(distance)
            if distance > max_distance:
                continue
            edges.append(
                {
                    "from_slug": anchor["slug"],
                    "to_slug": slug,
                    "distance": distance,
                    "similarity": 1.0 - distance,
                    "from_type": anchor["type"],
                    "to_type": page_type,
                    "from_title": anchor["title"],
                    "to_title": title,
                }
            )
            meta.setdefault(slug, {"slug": slug, "type": page_type, "title": title, "snippet": ""})

    parent: dict[str, str] = {}
    for edge in edges:
        union(parent, edge["from_slug"], edge["to_slug"])

    components: dict[str, list[str]] = collections.defaultdict(list)
    for slug in meta:
        if slug in parent:
            components[find(parent, slug)].append(slug)

    clusters: list[dict[str, Any]] = []
    for slugs in components.values():
        if len(slugs) < 3:
            continue
        internal_edges = [e for e in edges if e["from_slug"] in slugs and e["to_slug"] in slugs]
        avg_similarity = sum(e["similarity"] for e in internal_edges) / len(internal_edges) if internal_edges else 0.0
        clusters.append(
            {
                "size": len(slugs),
                "avg_similarity": round(avg_similarity, 4),
                "types": dict(collections.Counter(meta[s].get("type") for s in slugs)),
                "members": [
                    {"slug": s, "type": meta[s].get("type"), "title": meta[s].get("title")}
                    for s in sorted(slugs)[:20]
                ],
                "edge_count": len(internal_edges),
            }
        )
    clusters.sort(key=lambda c: (c["size"], c["avg_similarity"]), reverse=True)

    result = {
        "run_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source_id": source_id,
        "gbrain_version": gbrain_version(),
        "anchor_limit": anchor_limit,
        "anchors_loaded": len(anchors),
        "k": k,
        "max_distance": max_distance,
        "min_similarity": 1.0 - max_distance,
        "edges": len(edges),
        "clusters_found_size_ge_3": len(clusters),
        "clusters": clusters[:50],
    }

    (out_dir / "result.json").write_text(json.dumps(result, indent=2, ensure_ascii=False))

    lines = [
        "# GBrain semantic clustering sidecar spike",
        "",
        f"Run: {result['run_at']}",
        f"Source: `{source_id}`",
        f"GBrain: `{result['gbrain_version']}`",
        f"Anchors loaded: {len(anchors)} / limit {anchor_limit}",
        f"kNN: k={k}, max_distance={max_distance}, min cosine similarity={1.0 - max_distance:.2f}",
        f"Edges accepted: {len(edges)}",
        f"Clusters size>=3: {len(clusters)}",
        "",
    ]
    for idx, cluster in enumerate(clusters[:20], 1):
        lines.append(
            f"## Cluster {idx}: size={cluster['size']} avg_similarity={cluster['avg_similarity']} types={cluster['types']}"
        )
        for member in cluster["members"][:12]:
            lines.append(f"- `{member['slug']}` [{member['type']}] — {member['title']}")
        lines.append("")

    (out_dir / "report.md").write_text("\n".join(lines))
    print(out_dir / "report.md")
    print(json.dumps({k: result[k] for k in ["source_id", "anchors_loaded", "edges", "clusters_found_size_ge_3", "max_distance"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
