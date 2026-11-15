/**
 * GST-2732 B (Garry, 2026-11-15: "Do it"): a source added with no --federated choice joins default search on a
 * single-user brain, and stays out with a notice everywhere else.
 *
 * 1. Protects: on a fresh personal brain (access.serves one, brain.audience personal by the heuristic) a plain
 *    `sources add` stores federated true, prints how to take it out, and prints no not-in-default-search notice;
 *    an explicit --no-federated still wins; a brain declared shared or serving several people keeps the old
 *    default and prints the notice; an existing source is not changed by a later add.
 * 2. Fails when: the default flips on a shared or several-people brain, the personal default stays unfederated,
 *    an explicit --no-federated is overridden, or an existing source's setting moves.
 * 3. No production seam: the real command on PGLite, console spies only.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';

let engine: PGLiteEngine;
const dirs: string[] = [];

async function add(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-sources-add-default-'));
  dirs.push(dir);
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  const warn = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  const raw = spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { err.push(String(chunk)); return true; }) as never);
  try {
    await runSources(engine, ['add', args[0]!, '--path', dir, '--force', ...args.slice(1)]);
  } finally {
    log.mockRestore();
    warn.mockRestore();
    raw.mockRestore();
  }
  return { stdout: out.join('\n'), stderr: err.join('\n') };
}

async function federated(id: string): Promise<unknown> {
  const rows = await engine.executeRaw<{ f: unknown }>(`SELECT config->'federated' AS f FROM sources WHERE id = $1`, [id]);
  return rows[0]?.f ?? null;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine?.disconnect();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('a new source on a single-user brain joins default search', () => {
  test('a plain add stores federated true, says how to take it out, and prints no notice', async () => {
    const { stdout, stderr } = await add(['personal-a']);
    expect(await federated('personal-a')).toBe(true);
    expect(stdout).toContain('federated: true');
    expect(stdout).toContain('gbrain sources unfederate personal-a');
    expect(stderr).not.toContain('source_not_in_default_search');
  });

  test('an explicit --no-federated is the stated choice and stays out', async () => {
    await add(['personal-b', '--no-federated']);
    expect(await federated('personal-b')).toBe(false);
  });

  test('--json reports federated true with no notices', async () => {
    const out = JSON.parse((await add(['personal-c', '--json'])).stdout);
    expect(out).toMatchObject({ id: 'personal-c', federated: true });
    expect(out.notices).toBeUndefined();
  });
});

describe('a brain that is shared or serves several people keeps new sources out, with the notice', () => {
  test('brain.audience shared: the add stays unfederated and prints the notice with the shared reason', async () => {
    await engine.setConfig('brain.audience', 'shared');
    try {
      const { stderr } = await add(['shared-a']);
      expect(await federated('shared-a')).not.toBe(true);
      expect(stderr).toContain('source_not_in_default_search');
      expect(stderr).toContain('serves several people or is not marked personal');
      expect(await federated('personal-a')).toBe(true);
    } finally {
      await engine.setConfig('brain.audience', 'personal');
    }
  });

  test('access.serves several: the add stays unfederated even on a brain declared personal', async () => {
    await engine.setConfig('access.serves', 'several');
    try {
      const out = JSON.parse((await add(['several-a', '--json'])).stdout);
      expect(out.federated).toBe(false);
      expect(out.notices?.[0]?.code).toBe('source_not_in_default_search');
    } finally {
      await engine.setConfig('access.serves', 'one');
    }
  });
});
