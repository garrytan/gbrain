/**
 * checkpoint.ts — disk persistence so a killed / spend-capped sweep never
 * loses work. Two caches, both under ~/.cache/kos-jarvis/ (same root as the
 * sweep lock), keyed by resolved sourceId so different sources don't collide:
 *
 *   enrich-sweep-ner/<sourceId>.jsonl    — one line per page NER'd (Phase A)
 *   enrich-sweep-candidates/<sourceId>.json — full candidate set after Phase C
 *
 * Why this exists: Sweep #2 (2026-05-27) did all NER (~5h) before any write,
 * then every write failed on a Google embedding spend cap — losing the whole
 * in-memory candidate set. The NER cache makes Phase A resumable; the
 * candidates cache powers `--resume` (re-run Phase D only, no re-NER).
 */
import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Extraction, EntityKind } from "./ner.ts";
import type { Tier } from "./stub.ts";

const CACHE_ROOT = join(homedir(), ".cache", "kos-jarvis");

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
}

// ─────────────────────────── NER checkpoint (Phase A) ───────────────────────────

export type NerCacheEntry = { slug: string; updated: string; ex: Extraction[] };

export function nerCachePath(sourceId: string): string {
  return join(CACHE_ROOT, "enrich-sweep-ner", `${sanitize(sourceId)}.jsonl`);
}

/** Map slug → {updated, ex}. Corrupt lines are skipped, never fatal. */
export function loadNerCache(path: string): Map<string, { updated: string; ex: Extraction[] }> {
  const m = new Map<string, { updated: string; ex: Extraction[] }>();
  if (!existsSync(path)) return m;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as NerCacheEntry;
      if (e && e.slug) m.set(e.slug, { updated: e.updated ?? "", ex: Array.isArray(e.ex) ? e.ex : [] });
    } catch {
      /* skip corrupt line — checkpoint is best-effort */
    }
  }
  return m;
}

/** Append one page's NER result. Synchronous → durable even on hard kill. */
export function appendNer(path: string, entry: NerCacheEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
}

// ─────────────────────────── candidates cache (after Phase C) ───────────────────────────

export type CachedCandidate = {
  slug: string;
  name: string;
  aliases: string[];
  kind: EntityKind;
  tier: Tier;
  tier1_blocked: boolean;
  mentions: Array<{ source_slug: string; context: string }>;
};

export function candidatesCachePath(sourceId: string): string {
  return join(CACHE_ROOT, "enrich-sweep-candidates", `${sanitize(sourceId)}.json`);
}

export function saveCandidates(path: string, rows: CachedCandidate[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rows, null, 2), "utf-8");
}

export function loadCandidates(path: string): CachedCandidate[] | null {
  if (!existsSync(path)) return null;
  try {
    const arr = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(arr) ? (arr as CachedCandidate[]) : null;
  } catch {
    return null;
  }
}
