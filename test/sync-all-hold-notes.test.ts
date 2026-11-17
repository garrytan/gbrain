/**
 * #5988 X8: every sync output mode prints new holds and the outstanding
 * total, including the `sync --all` parallel aggregate for a source whose
 * sync was otherwise green.
 */
import { expect, test } from 'bun:test';
import { dispatchSyncAll } from '../src/commands/sync/run.ts';
import type { SyncResult } from '../src/commands/sync.ts';
import { gitHoldItem } from '../src/core/persistence/sync-holds.ts';

const base: SyncResult = { status: 'synced', fromCommit: 'a'.repeat(40), toCommit: 'b'.repeat(40), added: 2, modified: 0, deleted: 0, renamed: 0,
  chunksCreated: 2, embedded: 0, pagesAffected: [] };
const item = gitHoldItem({ version: 1, source_id: 'notes-example', incarnation: 'i', path: 'notes/broken.md', source_path: 'notes/broken.md', slug: 'notes/broken',
  page_id: null, code: 'invalid_frontmatter', message: 'Invalid YAML frontmatter: key "title" at line 2 continues on unquoted lines.', upstream_version: 'x',
  observed_at: 't', held_at: 't', updated_at: 't', run_id: 'r', mode: 'managed', meta: { reason: 'needs_interpretation', key: 'title', line: 2, recovery_version: 1 } });

for (const fanOutEligible of [true, false]) {
  test(`sync --all ${fanOutEligible ? 'parallel aggregate' : 'serial'} prints holds of a green source`, async () => {
    const lines: string[] = [];
    const sink = { write: (text: string) => { lines.push(...text.split('\n').filter(Boolean)); return true; } } as NodeJS.WriteStream;
    const sources = [{ id: 'notes-example', name: 'notes-example', local_path: '/tmp/x', config: {}, last_commit: null, chunker_version: null },
      { id: 'clean-example', name: 'clean-example', local_path: '/tmp/y', config: {}, last_commit: null, chunker_version: null }];
    const held: SyncResult = { ...base, held: [item], held_count: 1, holds_outstanding: 3,
      holds_fix: { argv: ['gbrain', 'repair', 'frontmatter', '--source', 'notes-example'], consent: [], actor: 'agent', requires_exclusive: false,
        why: "1 file(s) held this run, 3 held in source notes-example; they do not block sync. Inspect them with 'foresights sources status notes-example'." } };
    const perSourceResults: Parameters<typeof dispatchSyncAll>[0]['perSourceResults'] = [];
    await dispatchSyncAll({ fanOutEligible, effectiveParallel: 2, concurrency: undefined, runnableSources: sources,
      runOne: async src => src.id === 'notes-example' ? held : base, writeHuman: line => sink.write(`${line}\n`), humanSink: sink, perSourceResults, onAllSigint: () => {} });
    const text = lines.join('\n');
    expect(text).toContain('Held notes/broken.md: invalid_frontmatter (needs_interpretation) at line 2, key "title"');
    expect(text).toContain('3 held in source notes-example');
    expect(text).toContain('foresights repair frontmatter --source notes-example');
    expect(perSourceResults.find(r => r.sourceId === 'notes-example')?.status).toBe('ok');
  });
}
