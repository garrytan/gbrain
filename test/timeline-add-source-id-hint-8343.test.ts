/**
 * #8343: `gbrain timeline-add --source-id <id>` is refused with a hint that names the real write-source route.
 *
 * Protects: an op whose own --source is a provenance ref (timeline-add) answers an unknown --source-id or
 * --all-sources with GBRAIN_SOURCE, the route that selects the source it writes to, instead of "did you mean
 * --source?", which would silently set the entry's provenance and write to the default source. append, whose
 * --source is the write source, keeps its did-you-mean.
 * Fails when: the hint points at --source for an op that owns a provenance --source.
 * Seam: the real CLI in a subprocess on a machine with no brain (the unknown-flag check runs before any engine).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { provenanceSourceFlagError } from '../src/cli/source-scope.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));

async function cli(args: string[]): Promise<{ code: number; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-8343-'));
  const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home, HOME: home };
  delete env.DATABASE_URL; delete env.GBRAIN_DATABASE_URL; delete env.GBRAIN_SOURCE;
  const proc = Bun.spawn(['bun', '--no-env-file', 'run', 'src/cli.ts', ...args], { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr };
}

describe('timeline-add --source-id hint (#8343)', () => {
  test('names GBRAIN_SOURCE, not the provenance --source', async () => {
    const r = await cli(['timeline-add', 'notes/alice-example', '2026-01-02', 'A summary', '--source-id', 'source-a']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown_flag');
    expect(r.stderr).not.toContain('did you mean --source?');
    expect(r.stderr).toContain('GBRAIN_SOURCE=source-a');
  }, 60_000);

  test('--all-sources gets the same route', async () => {
    const r = await cli(['timeline-add', 'notes/alice-example', '2026-01-02', 'A summary', '--all-sources']);
    expect(r.code).toBe(2);
    expect(r.stderr).not.toContain('did you mean --source?');
    expect(r.stderr).toContain('GBRAIN_SOURCE=<id>');
  }, 60_000);

  const source = { type: 'string' as const, description: 'x' };
  test('an op whose --source is a real filter (questions_list) keeps the generic error, so its did-you-mean survives', () => {
    expect(provenanceSourceFlagError({ name: 'questions_list', params: { source } }, 'questions-list', '--source-id', 'unknown flag', ['--source-id', 'a'], false)).toBeNull();
  });
  test('a thin client is pointed at its connection grant, not GBRAIN_SOURCE, which its router ignores for these ops', () => {
    const err = provenanceSourceFlagError({ name: 'add_timeline_entry', params: { source } }, 'timeline-add', '--source-id', 'unknown flag', ['--source-id', 'source-a'], true);
    expect(err?.message).toContain('gbrain whoami');
    expect(err?.message).not.toContain('GBRAIN_SOURCE');
  });
});
