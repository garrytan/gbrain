/**
 * progress-tail — parses gbrain's --progress-json events out of child stderr.
 *
 * The actual contract (verified post-Codex):
 *   - `gbrain --progress-json <subcommand>` writes JSONL events to STDERR
 *   - Stable phase names are dotted snake_case: `import.files`, `extract.links_fs`,
 *     `embed.pages`, `doctor.db_checks`, etc.
 *   - Each event line is a JSON object; non-progress stderr lines (warnings,
 *     debug output, errors) interleave with progress events. We tolerate them.
 *
 * Used by the verify phase to assert that each `expected_phases` entry from
 * scenario.json saw at least one event from the corresponding command.
 */

export interface ProgressEvent {
  phase: string;
  event?: string;       // 'start' | 'tick' | 'finish' | etc per docs/progress-events.md
  ts?: string;
  [key: string]: unknown;
}

/** Parse a single stderr buffer into the progress events it contains. */
export function parseProgressEvents(stderr: string): ProgressEvent[] {
  const out: ProgressEvent[] = [];
  for (const line of stderr.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && typeof (parsed as any).phase === 'string') {
      out.push(parsed as ProgressEvent);
    }
  }
  return out;
}

/** Group events by phase name. */
export function eventsByPhase(events: ProgressEvent[]): Map<string, ProgressEvent[]> {
  const m = new Map<string, ProgressEvent[]>();
  for (const e of events) {
    if (!m.has(e.phase)) m.set(e.phase, []);
    m.get(e.phase)!.push(e);
  }
  return m;
}

/**
 * Verify that every `expected` phase appears at least once in `events`.
 * Returns the missing phase names (empty array on full coverage).
 */
export function verifyExpectedPhases(events: ProgressEvent[], expected: string[]): string[] {
  const seen = new Set(events.map(e => e.phase));
  return expected.filter(p => !seen.has(p));
}
