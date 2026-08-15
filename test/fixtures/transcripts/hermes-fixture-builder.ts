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
