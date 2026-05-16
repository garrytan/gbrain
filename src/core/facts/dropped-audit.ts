/**
 * v0.34.5 — facts.dropped.jsonl operator-recoverable audit trail.
 *
 * When the stub-guard backstop fallback fires (an unprefixed bare-name
 * entity reference like "Zoolander" that couldn't resolve to any
 * canonical people/companies/deals/topics page), we used to insert a
 * DB-only fact row via `engine.insertFact` to avoid silent data loss.
 * That created rows shaped like pre-v0.32.2 legacy migration rows
 * (`row_num IS NULL AND entity_slug IS NOT NULL`), which the v0.32.2
 * extract_facts cycle phase guard at `src/core/cycle/extract-facts.ts`
 * REFUSES to reconcile around. Net: one unknown bare entity reference
 * silently broke the autopilot reconciliation pass forever (codex P1
 * caught this in /codex review post-implementation).
 *
 * Fix: don't insert. Log to stderr (operator visibility) AND append a
 * structured entry to `~/.gbrain/facts.dropped.jsonl` so a follow-up
 * tool can re-process the dropped facts once the user creates the
 * canonical entity pages. The fact text is preserved verbatim — no
 * lossy summarization — so recovery is lossless.
 *
 * Schema (per line, JSON object):
 *   - ts: ISO 8601 timestamp
 *   - source_id: brain source
 *   - phantom_slug: the unresolved bare slug (e.g. 'zoolander')
 *   - reason: 'stub_guard_blocked' (only reason today; field is open
 *     for future operator-visibility surfaces)
 *   - fact: the verbatim fact text
 *   - kind: NewFact kind (fact / event / preference / commitment / belief)
 *   - notability: high / medium / low
 *   - visibility: private / world
 *   - source: provenance string (e.g. 'mcp:put_page', 'sync:import')
 *   - source_session: session id if present
 *
 * Best-effort: every write is wrapped in try/catch and never throws
 * back into the caller. The hot-path facts pipeline must not break
 * because the audit dir is read-only / disk full / etc.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { gbrainPath } from '../config.ts';

export interface DroppedFactEntry {
  source_id: string;
  phantom_slug: string;
  reason: 'stub_guard_blocked';
  fact: string;
  kind: string | null;
  notability: 'high' | 'medium' | 'low' | null;
  visibility: 'private' | 'world';
  source: string;
  source_session: string | null;
}

const AUDIT_PATH = (): string => gbrainPath('facts.dropped.jsonl');

export function appendDroppedFactAudit(entry: DroppedFactEntry): void {
  try {
    const path = AUDIT_PATH();
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    });
    appendFileSync(path, `${line}\n`, 'utf-8');
  } catch (err) {
    // Best-effort: log to stderr but never throw back into the facts
    // pipeline. The fact is already lost; the audit log is a recovery
    // aid, not a critical path.
    // eslint-disable-next-line no-console
    console.warn(
      `[facts.dropped] couldn't append audit entry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
