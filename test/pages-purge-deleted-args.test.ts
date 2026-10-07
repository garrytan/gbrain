/**
 * `gbrain pages purge-deleted` argument safety (#6114, D6).
 *
 * The purge is a brain-wide hard delete. Before this fix the handler read
 * only the flags it knew and ignored everything else: a positional `help`,
 * `--source <id>`, a bare `--older-than` and `--older-than=N` all ran the
 * default 72h purge. Now help never acts, any token the purge would ignore
 * refuses with `invalid_params` before the engine is touched, and the real
 * purge asks first (TTY prompt, `--yes`, or exit 3 with the consent payload).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parsePurgeArgs, runPages } from '../src/commands/pages.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { operations } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

async function slugs(): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages ORDER BY slug');
  return rows.map(r => r.slug);
}

async function seed(): Promise<void> {
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, deleted_at) VALUES
    ('default', 'notes/old-deleted', 'note', 'old', now() - INTERVAL '200 hours'),
    ('default', 'notes/live', 'note', 'live', NULL)`);
}

/** Runs `pages <args>` with stdout captured; returns what it printed. */
async function run(args: string[], eng: PGLiteEngine | null = engine): Promise<string> {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { lines.push(String(chunk)); return true; }) as never);
  const err = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await withEnv({ GBRAIN_NON_INTERACTIVE: '1' }, () => runPages(eng as never, args));
  } finally {
    log.mockRestore(); write.mockRestore(); err.mockRestore();
  }
  return lines.join('\n');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  _resetCliExitVerdictForTests();
  await seed();
});

describe('parsePurgeArgs', () => {
  test('accepts the documented forms', () => {
    expect(parsePurgeArgs([])).toEqual({ olderThanHours: 72, dryRun: false, json: false });
    expect(parsePurgeArgs(['--older-than', '720'])).toMatchObject({ olderThanHours: 720 });
    expect(parsePurgeArgs(['--older-than=720'])).toMatchObject({ olderThanHours: 720 });
    expect(parsePurgeArgs(['--older-than', '3d', '--dry-run', '--json'])).toEqual({ olderThanHours: 72, dryRun: true, json: true });
    expect(parsePurgeArgs(['--older-than=0h', '--yes'])).toMatchObject({ olderThanHours: 0 });
  });

  test.each([
    [['help'], 'help'],
    [['--source', 'x'], '--source'],
    [['--source=x'], '--source=x'],
    [['--older-than'], '--older-than'],
    [['--older-than', 'help'], 'help'],
    [['--older-than='], '--older-than='],
    [['--older-than', '1', '--older-than', '2'], '--older-than'],
    [['--dry-run=yes'], '--dry-run=yes'],
    [['--force'], '--force'],
  ])('refuses %p naming %p, with a read-only fix', (args, token) => {
    let caught: unknown;
    try { parsePurgeArgs(args as string[]); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(OperationError);
    const e = caught as OperationError;
    expect(e.code).toBe('invalid_params');
    expect(e.message).toContain(`\`${token}\``);
    expect(e.why).toContain('Nothing was changed');
    expect(e.fix?.argv).toEqual(['gbrain', 'pages', 'purge-deleted', '--dry-run', '--json']);
    expect(parsePurgeArgs(e.fix!.argv!.slice(3))).toMatchObject({ dryRun: true });
  });

  test('--source names the brain-wide scope', () => {
    expect(() => parsePurgeArgs(['--source', 'default'])).toThrow(OperationError);
    try { parsePurgeArgs(['--source', 'default']); } catch (e) {
      expect((e as OperationError).why).toContain('per-source purge is not supported');
    }
  });
});

describe('runPages', () => {
  test.each([[['--help']], [['-h']], [['help']], [['purge-deleted', '--help']], [['purge-deleted', '-h']],
    [['purge-deleted', 'help']], [['purge-deleted', '--older-than', '--help']], [['purge-deleted', '--source', 'x', '-h']]])(
    '%p prints usage without an engine and purges nothing', async (args) => {
      expect(await run(args as string[], null)).toContain('purge-deleted [--older-than');
      expect(await slugs()).toEqual(['notes/live', 'notes/old-deleted']);
    });

  test('refused arguments leave every page in place', async () => {
    for (const args of [['purge-deleted', 'extra', '--yes'], ['purge-deleted', '--source', 'x', '--yes'], ['purge-deleted', '--older-than', '--yes'], ['purge-deleted', '--older-than', 'help', '--yes']]) {
      await expect(run(args)).rejects.toBeInstanceOf(OperationError);
    }
    expect(await slugs()).toEqual(['notes/live', 'notes/old-deleted']);
  });

  test('--older-than=N narrows the purge instead of falling back to 72h', async () => {
    await run(['purge-deleted', '--older-than=9999', '--yes']);
    expect(await slugs()).toEqual(['notes/live', 'notes/old-deleted']);
  });

  test('D6: without --yes and no TTY it exits 3 with the consent payload and purges nothing', async () => {
    const out = await run(['purge-deleted', '--json']);
    expect(currentExitCode()).toBe(3);
    const doc = JSON.parse(out.slice(out.indexOf('{'))) as { code: string; user_message: string; fix: { next: string; argv: string[] }; preview: { argv: string[] } };
    expect(doc.code).toBe('confirmation_required');
    expect(doc.fix.next).toBe('ask_user');
    expect(doc.user_message).toContain('1 page(s)');
    expect(doc.user_message).toContain('every source');
    expect(doc.fix.argv).toEqual(['gbrain', 'pages', 'purge-deleted', '--older-than', '72h', '--json', '--yes']);
    expect(doc.preview.argv).toEqual(['gbrain', 'pages', 'purge-deleted', '--older-than', '72h', '--dry-run', '--json']);
    expect(await slugs()).toEqual(['notes/live', 'notes/old-deleted']);
  });

  test('with --yes it purges; --dry-run never needs it', async () => {
    expect(await run(['purge-deleted', '--dry-run'])).toContain('Would purge 1 page(s)');
    expect(currentExitCode()).toBe(0);
    expect(await run(['purge-deleted', '--yes'])).toContain('Purged 1 page(s)');
    expect(await slugs()).toEqual(['notes/live']);
  });

  test('nothing to purge needs no confirmation', async () => {
    expect(await run(['purge-deleted', '--older-than', '9999'])).toContain('No pages to purge');
    expect(currentExitCode()).toBe(0);
  });
});

describe('the purge_deleted_pages op is not a consent-free side door (security review)', () => {
  const op = operations.find(o => o.name === 'purge_deleted_pages')!;
  const local = (p: Record<string, unknown>) => withEnv({ GBRAIN_NON_INTERACTIVE: '1' }, () =>
    op.handler({ engine, config: { engine: 'pglite' }, remote: false, dryRun: false, sourceId: 'default',
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext, p));

  test('gbrain call without yes refuses with the D6 consent payload and purges nothing', async () => {
    const refused = await local({ older_than_hours: 72 }).then(() => null, (e: unknown) => e as OperationError);
    expect(refused?.code).toBe('confirmation_required');
    expect(await slugs()).toEqual(['notes/live', 'notes/old-deleted']);
  });

  test('yes: true is the consent, and an empty purge set needs none', async () => {
    expect(await local({ older_than_hours: 99999 })).toMatchObject({ count: 0 });
    expect(await local({ older_than_hours: 72, yes: true })).toMatchObject({ status: 'purged', count: 1 });
    expect(await slugs()).toEqual(['notes/live']);
  });

  test('no top-level `gbrain purge-deleted`, and the stdio MCP pipe gets the trusted-CLI refusal', async () => {
    expect(op.cliHints?.hidden).toBe(true);
    const res = await dispatchToolCall(engine, 'purge_deleted_pages', { older_than_hours: 72, yes: true }, { remote: true, transport: 'stdio', sourceId: 'default' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('trusted_local_only');
    expect(await slugs()).toEqual(['notes/live', 'notes/old-deleted']);
  });
});
