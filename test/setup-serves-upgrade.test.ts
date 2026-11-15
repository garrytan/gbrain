/**
 * GST-363: gbrain setup on upgrade paths and on a one-person brain, spawned against a temp HOME / GBRAIN_HOME (PGLite).
 * Split from test/setup-serves-several.test.ts; the box and readers are in test/helpers/setup-serves-box.ts.
 *
 * 1. Protects: post-upgrade rewrites, setup re-runs from the receipt and apply-migrations carry an entry's
 *    --stdio-member forward and never add one; --serves one on a one-person brain is the default install; a plain
 *    setup on a brain that serves several people refuses and writes nothing until the stdio server is bound.
 * 2. Fails when: an upgrade path adds or drops --stdio-member, --serves one changes the default document, or a plain
 *    setup writes an unbound connection on a several brain.
 * 3. Existing coverage: test/setup-serves-several.test.ts (labelling), test/setup-serves-stdio-member.test.ts.
 * 4. Real seams: `bun src/cli.ts setup` spawned against a temp HOME / GBRAIN_HOME, refreshHookLaunchers in process.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setupRerunArgv } from '../src/core/setup/launcher-lanes.ts';
import { refreshHookLaunchers } from '../src/core/setup/hook-launcher-refresh.ts';
import { renderBrainFirstBlock, SERVES_SEVERAL_LINE } from '../src/core/setup/brain-first.ts';
import { withEnv } from './helpers/with-env.ts';
import { brainWithPages, box, claudeMd, CLEAN, entry, entryArgs, gbrain, normalized, removeTempDirs, ROSTER, setup, setupReceipts, staleEntry, stdioKey, type Box } from './helpers/setup-serves-box.ts';

afterAll(removeTempDirs);

describe('gbrain setup --serves (spawned, PGLite)', () => {
  test('upgrade paths carry an entry\'s --stdio-member forward and never add one: post-upgrade rewrites, setup re-runs from the receipt, --no-stdio-member removes it', async () => {
    const b = box();
    await brainWithPages(b);
    expect((await setup(b, ['claude-code', '--serves', 'several', '--members', ROSTER.join(','), '--stdio-member', 'alice-example'])).exitCode).toBe(0);
    const refresh = async () => { const lines: string[] = []; await withEnv({ ...CLEAN, HOME: b.home, GBRAIN_HOME: b.home }, () => refreshHookLaunchers((l) => lines.push(l))); return lines; };
    staleEntry(b);
    expect((await refresh()).join('\n')).toContain('now start gbrain from its own directory');
    expect(entryArgs(b).slice(-2)).toEqual(['--stdio-member', 'alice-example']);
    expect(entry(b).command).not.toBe(b.bin);
    for (const r of setupReceipts(b)) {
      const argv = setupRerunArgv('claude-code', r);
      expect(argv).not.toContain('--stdio-member');
      const rerun = await gbrain(b, [...argv.slice(1), '--json']);
      expect(rerun.exitCode).toBe(0);
      expect(entryArgs(b).slice(-2)).toEqual(['--stdio-member', 'alice-example']);
    }
    expect((await gbrain(b, ['apply-migrations', '--yes', '--no-autopilot-install'])).exitCode).toBe(0);
    expect(entryArgs(b).slice(-2)).toEqual(['--stdio-member', 'alice-example']);
    const removed = await setup(b, ['claude-code', '--serves', 'several', '--members', ROSTER.join(','), '--no-stdio-member', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.doc.serves.stdio).toMatchObject({ member: null, action: 'remove' });
    expect(removed.doc.serves.stdio.detail).toContain('removed --stdio-member alice-example from this claude-code entry');
    expect(entryArgs(b)).not.toContain('--stdio-member');
    staleEntry(b);
    await refresh();
    expect(entryArgs(b)).not.toContain('--stdio-member');
    expect(entry(b).command).not.toBe(b.bin);
    expect(await stdioKey(b)).toBe('');
  }, 480_000);

  test('--serves one on a one-person brain is the default install: the same document, no serves key, the one-person block', async () => {
    const plain = box();
    const explicit = box();
    for (const b of [plain, explicit]) expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    const a = await setup(plain, ['claude-code', '--json']);
    const c = await setup(explicit, ['claude-code', '--serves', 'one', '--json']);
    expect(a.exitCode).toBe(0);
    expect(c.exitCode).toBe(0);
    expect(a.doc.serves).toBeUndefined();
    expect(normalized(c.doc).serves).toBeUndefined();
    const strip = (doc: any, b: Box) => JSON.parse(JSON.stringify(normalized(doc)).replaceAll(b.root, '<root>'));
    expect(strip(c.doc, explicit)).toEqual(strip(a.doc, plain));
    expect(claudeMd(plain)).toContain(renderBrainFirstBlock('claude-code', { kind: 'mcp', server: 'gbrain', surface: 'verbs' }).split('\n').slice(1).join('\n'));
  }, 240_000);

  test('a plain setup on a brain that serves several people refuses and writes nothing; once an owner is named it binds this harness to the owner', async () => {
    const b = box();
    expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    for (const m of ROSTER) expect((await gbrain(b, ['access', 'member', 'add', m])).exitCode).toBe(0);
    const refused = await setup(b, ['claude-code', '--json']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout).toContain('setup_serves_several');
    expect(refused.stdout).toContain('2 enabled members (alice-example, bob-example)');
    expect(refused.stdout).toContain('gbrain setup claude-code --serves several --members alice-example,bob-example');
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
    expect((await gbrain(b, ['access', 'owner', 'set', 'alice-example'])).exitCode).toBe(0);
    const owner = await setup(b, ['claude-code', '--json']);
    expect(owner.exitCode).not.toBe(0);
    expect(owner.stdout).toContain('setup_serves_several');
    expect(await stdioKey(b)).toBe('');
    expect((await gbrain(b, ['apply-migrations', '--yes', '--no-autopilot-install'])).exitCode).toBe(0);
    expect(await stdioKey(b)).toBe('');
    expect((await gbrain(b, ['config', 'set', 'mcp.stdio_member', 'alice-example'])).exitCode).toBe(0);
    const bound = await setup(b, ['claude-code', '--json']);
    expect(bound.exitCode).toBe(0);
    expect(bound.doc.serves).toMatchObject({ mode: 'one', brain_serves: 'several', stdio: { member: 'alice-example', action: 'keep' } });
    expect(claudeMd(b)).toContain(`- ${SERVES_SEVERAL_LINE}`);
  }, 300_000);
});
