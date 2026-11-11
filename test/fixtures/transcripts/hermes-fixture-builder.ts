/**
 * hermes-fixture-builder.ts — builds a SYNTHETIC hermes state.db matching the
 * schema verified from the installed hermes-agent v0.20.0 source
 * (hermes_state_common.py SCHEMA_SQL, columns subset). Synthetic by
 * declaration: the adapter's SPEC_TARGET stays provisional and this builder
 * never claims to be a production sample. Content uses the repo's generic
 * placeholder names only.
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';

export const HERMES_FIXTURE_DB = 'state.db';

/** Create `<dir>/state.db` with two text sessions + skip-worthy noise. */
export function buildHermesFixture(dir: string): string {
  const path = join(dir, HERMES_FIXTURE_DB);
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        display_name TEXT,
        model TEXT,
        started_at REAL NOT NULL,
        ended_at REAL,
        cwd TEXT,
        title TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL,
        content TEXT,
        timestamp REAL NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        compacted INTEGER NOT NULL DEFAULT 0
      );
    `);
    const insSession = db.prepare(
      'INSERT INTO sessions (id, source, display_name, model, started_at, cwd, title) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insMsg = db.prepare(
      'INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
    );

    // Session 1: plain-text contents. 1785916800 = 2026-08-05T08:00:00Z.
    insSession.run('hermes-fixture-1', 'cli', 'widget planning', 'model-example', 1785916800, '/home/alice-example/agent-workspace', 'widget planning');
    insMsg.run('hermes-fixture-1', 'user', 'Draft the widget-co launch checklist.', 1785916805);
    insMsg.run('hermes-fixture-1', 'tool', 'TOOL-ONLY-TEXT: never imported', 1785916806);
    insMsg.run('hermes-fixture-1', 'assistant', 'Launch checklist drafted: pricing page, demo, fund-a update.', 1785916810);

    // Session 2: JSON block-array contents (the unwrap path) + an empty row.
    insSession.run('hermes-fixture-2', 'gateway', null, null, 1786003200, null, null);
    insMsg.run('hermes-fixture-2', 'user', '[{"type":"text","text":"When is the acme-seed close?"}]', 1786003205);
    insMsg.run('hermes-fixture-2', 'assistant', '[{"type":"text","text":"acme-seed closes at the end of the month."}]', 1786003210);
    insMsg.run('hermes-fixture-2', 'assistant', '', 1786003211);

    // Session 3: tool-only rows — yields no messages, session skipped.
    insSession.run('hermes-fixture-3', 'cli', null, null, 1786089600, null, null);
    insMsg.run('hermes-fixture-3', 'tool', 'TOOL-ONLY-TEXT: never imported', 1786089605);
  } finally {
    db.close();
  }
  return path;
}

export const HERMES_AUTOMATION_FIXTURE_DB = 'automation-state.db';

/**
 * #8901: ONE session per Hermes session kind the import filter must tell apart,
 * in a store that carries the `model_config` and `parent_session_id` columns
 * of hermes-agent v0.23.0. Every session has one user and one assistant text
 * message, so the only thing that keeps a session out of the archive is the
 * filter. Ids double as the expected classification:
 *
 *   desktop-root              desktop, no parent                       → conversation
 *   cron-report               cron                                     → automation (cron)
 *   subagent-run              subagent + `_delegate_from`              → delegate child
 *   delegate-under-desktop    desktop + `_delegate_from` (inherited)   → delegate child
 *   continuation-of-root      desktop, parent_session_id only          → conversation (compression continuation)
 *   branch-of-root            desktop, parent + `_branched_from`       → conversation (branch)
 *   hook-run                  hook-example (a custom source)           → automation only when named
 *   kanban-worker             kanban                                   → hidden by Hermes
 *   tool-integration          tool                                     → hidden by Hermes
 *   garbled-config            desktop, model_config is not JSON        → conversation (never guessed excluded)
 *   local-routed-desktop      source local, created_source desktop     → conversation (Hermes rewrote the routing label)
 *   kanban-retagged           source local, created_source kanban      → hidden by Hermes (creation label survives the flip)
 *
 * Start times are one hour apart in that order; messages one and two seconds
 * after each start. 1786100000 = 2026-08-03T10:13:20Z.
 */
export const HERMES_AUTOMATION_SESSIONS: ReadonlyArray<{
  id: string; source: string; createdSource?: string; modelConfig: string | null; parent: string | null; title: string | null; startedAt: number;
}> = [
  { id: 'desktop-root', source: 'desktop', modelConfig: null, parent: null, title: 'widget-co launch plan', startedAt: 1786100000 },
  { id: 'cron-report', source: 'cron', modelConfig: null, parent: null, title: 'daily digest', startedAt: 1786103600 },
  { id: 'subagent-run', source: 'subagent', modelConfig: JSON.stringify({ _delegate_from: 'desktop-root' }), parent: 'desktop-root', title: 'Subagent: research', startedAt: 1786107200 },
  { id: 'delegate-under-desktop', source: 'desktop', modelConfig: JSON.stringify({ model: 'model-example', _delegate_from: 'desktop-root' }), parent: 'desktop-root', title: 'Subagent: summarize', startedAt: 1786110800 },
  { id: 'continuation-of-root', source: 'desktop', modelConfig: JSON.stringify({ model: 'model-example' }), parent: 'desktop-root', title: 'widget-co launch plan', startedAt: 1786114400 },
  { id: 'branch-of-root', source: 'desktop', modelConfig: JSON.stringify({ _branched_from: 'desktop-root' }), parent: 'desktop-root', title: 'widget-co launch plan (branch)', startedAt: 1786118000 },
  { id: 'hook-run', source: 'hook-example', modelConfig: null, parent: null, title: 'hook output', startedAt: 1786121600 },
  { id: 'kanban-worker', source: 'kanban', modelConfig: null, parent: null, title: null, startedAt: 1786125200 },
  { id: 'tool-integration', source: 'tool', modelConfig: null, parent: null, title: null, startedAt: 1786128800 },
  { id: 'garbled-config', source: 'desktop', modelConfig: '{not json', parent: null, title: 'notes', startedAt: 1786132400 },
  { id: 'local-routed-desktop', source: 'local', createdSource: 'desktop', modelConfig: null, parent: null, title: 'fund-a update', startedAt: 1786136000 },
  { id: 'kanban-retagged', source: 'local', createdSource: 'kanban', modelConfig: null, parent: null, title: null, startedAt: 1786139600 },
];

/** Create `<dir>/automation-state.db` holding HERMES_AUTOMATION_SESSIONS. */
export function buildHermesAutomationFixture(dir: string): string {
  const path = join(dir, HERMES_AUTOMATION_FIXTURE_DB);
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        created_source TEXT,
        display_name TEXT,
        model TEXT,
        model_config TEXT,
        parent_session_id TEXT,
        started_at REAL NOT NULL,
        ended_at REAL,
        cwd TEXT,
        title TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL,
        content TEXT,
        timestamp REAL NOT NULL
      );
    `);
    const insSession = db.prepare(
      'INSERT INTO sessions (id, source, created_source, model_config, parent_session_id, started_at, title) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insMsg = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)');
    for (const s of HERMES_AUTOMATION_SESSIONS) {
      insSession.run(s.id, s.source, s.createdSource ?? s.source, s.modelConfig, s.parent, s.startedAt, s.title);
      insMsg.run(s.id, 'user', `Question from ${s.id} for alice-example.`, s.startedAt + 1);
      insMsg.run(s.id, 'assistant', `Answer from ${s.id} about acme-example.`, s.startedAt + 2);
    }
  } finally {
    db.close();
  }
  return path;
}
