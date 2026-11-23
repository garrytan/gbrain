/**
 * The PGLite restore repairs a restored brain with SQL (`restorePgliteBackup`, `quarantineSharedSkillRestore`,
 * `quarantineRestoredExecution`, `trueUpRequests`); a Rust store takes no raw SQL. This guard lists every table those
 * statements write and requires each one to have a Rust disposition: a typed step or a named refusal, and the test that
 * checks its outcome, found by title in that file. A new SQL write in the PGLite restore with no Rust disposition fails
 * here, and so does a disposition whose test was renamed or removed.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const text = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** The source of `restorePgliteBackup` alone (the file also holds the create path, which is not a restore step). */
const restoreBody = (): string => { const source = text('src/core/backup/snapshot.ts'); return source.slice(source.indexOf('export async function restorePgliteBackup')); };
const WRITES = /\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+([a-z_]+)/g;
const tablesIn = (source: string): string[] => [...new Set([...source.matchAll(WRITES)].map(m => m[1]!))].sort();

const SAFETY = 'test/rust-engine-restore-safety.test.ts';
const ROUNDTRIP = 'test/backup-rust-roundtrip.test.ts';
const SCENARIO = { file: SAFETY, title: 'Rust: the typed restore ends in the same state' };
const TOKENS = { file: SAFETY, title: 'a mode or mirror the Rust restore cannot serve is refused first; a blocker is named; a clean census passes' };
const PENDING = { file: ROUNDTRIP, title: 'an unfinished request refuses by name, publishes nothing' };
const BRAIN_ID = { file: 'test/backup-restore-brain-id.test.ts', title: 'Rust: the restore rotates the store brain id' };

const DISPOSITIONS: Record<string, { how: string; outcome: { file: string; title: string } }> = {
  config: { how: 'restoreQuarantine: settings switched off or rebased, the inventory row written', outcome: SCENARIO },
  sources: { how: 'restoreQuarantine: external sources detached, managed sources rebased', outcome: SCENARIO },
  pages: { how: 'restoreQuarantine: managed page origins rebased', outcome: SCENARIO },
  minion_jobs: { how: 'restoreQuarantine: unfinished jobs cancelled, previous status kept', outcome: SCENARIO },
  oauth_clients: { how: 'restoreQuarantine: archived OAuth clients revoked and named', outcome: SCENARIO },
  persistence_local_writers: { how: 'restoreQuarantine: archived local writers revoked and named', outcome: SCENARIO },
  access_tokens: { how: 'refused: unclassified_state naming access tokens (not revoked by this restore)', outcome: TOKENS },
  oauth_tokens: { how: 'refused: unclassified_state (OAuth token records)', outcome: TOKENS },
  oauth_codes: { how: 'refused: unclassified_state (OAuth code records)', outcome: TOKENS },
  persistence_requests: { how: 'refused: pending_requests / recovery_required; the restore never cancels a request', outcome: PENDING },
  persistence_effects: { how: 'refused: pending_requests (live effects); the restore never fails an effect', outcome: PENDING },
  persistence_counters: { how: 'nothing to return: a request that is not cancelled gives no reservation back', outcome: PENDING },
  persistence_brain: { how: 'restoreQuarantine: a fresh brain id in meta:format (rotated_from kept), FORMAT rewritten, both ids reported', outcome: BRAIN_ID },
  persistence_worktrees: { how: 'a Rust store keeps no shared-skill state; any such record kind is refused unclassified_state', outcome: TOKENS },
  persistence_host_bindings: { how: 'a Rust store keeps no shared-skill state; any such record kind is refused unclassified_state', outcome: TOKENS },
  persistence_source_bindings: { how: 'a Rust store keeps no shared-skill state; any such record kind is refused unclassified_state', outcome: TOKENS },
  persistence_writer_protocols: { how: 'a Rust store keeps no shared-skill state; any such record kind is refused unclassified_state', outcome: TOKENS },
  shared_skill_members: { how: 'a Rust store keeps no shared-skill state; any such record kind is refused unclassified_state', outcome: TOKENS },
  shared_skill_policies: { how: 'a Rust store keeps no shared-skill state; any such record kind is refused unclassified_state', outcome: TOKENS },
  shared_skill_revision_leases: { how: 'a Rust store keeps no shared-skill state; any such record kind is refused unclassified_state', outcome: TOKENS },
  shared_skill_state: { how: 'a Rust store keeps no shared-skill state; any such record kind is refused unclassified_state', outcome: TOKENS },
};

describe('every SQL write of the PGLite restore has a Rust disposition', () => {
  const written = tablesIn(restoreBody() + text('src/core/shared-skills/restore.ts') + text('src/core/backup/quarantine.ts') + text('src/core/persistence/receipt-true-up.ts'));

  test('no table is written without a disposition, and none is listed that the restore no longer writes', () => {
    expect(written).toEqual(Object.keys(DISPOSITIONS).sort());
  });

  test('each disposition names an outcome test that exists', () => {
    for (const [table, { outcome }] of Object.entries(DISPOSITIONS)) {
      expect(text(outcome.file), `${table}: ${outcome.file}`).toContain(outcome.title);
    }
  });

  test('purges are checked by request id, not by archive time: the Rust restore never calls replayPurgesInRestore', () => {
    expect(text('src/core/backup/rust-snapshot.ts')).not.toContain('replayPurgesInRestore');
    expect(text(ROUNDTRIP)).toContain('a committed purge the snapshot lacks refuses purge_replay, whatever its time');
  });
});
