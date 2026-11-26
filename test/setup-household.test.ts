/**
 * H2: `gbrain setup <harness> --shape household` (setup-brain-layout.ts, setup.ts, household-template.ts). Preview first
 * (nothing written without --yes); with --yes the brain gets the household template, the instructions get the
 * household block, every key lands in a 0600 file and none is printed; --status proves each key, --resume names its
 * receipt and refuses another target. Invented names only.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli, type CliResult } from './helpers/cli-spawn.ts';
import { applyBrainLayout, describeLayout, LAYOUT_BEGIN, layoutNotices, parseLayoutFlags, renderLayoutBlock } from '../src/commands/setup-brain-layout.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Box { root: string; home: string; bin: string }
function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-household-setup-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const bin = join(root, 'bin', 'gbrain');
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(bin, 0o755);
  return { root, home, bin };
}

const CLEAN = { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1', CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined, GBRAIN_HOOKS: undefined, GBRAIN_SETUP_ABORT_AFTER: undefined };
const envOf = (b: Box) => ({ ...CLEAN, HOME: b.home, GBRAIN_HOME: b.home });
async function setup(b: Box, args: string[]): Promise<CliResult & { doc: any }> {
  const r = await runCli(['setup', ...args, '--json', '--gbrain-bin', b.bin], { env: envOf(b) });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc };
}

describe('setup --shape household', () => {
  test('preview writes nothing; --yes applies the template, writes the household block, and never prints a key; --status proves every key', async () => {
    const b = box();
    const preview = await setup(b, ['claude-code', '--shape', 'household', '--owner', 'alice-example']);
    expect(preview.exitCode).toBe(0);
    expect(existsSync(join(b.home, '.claude', 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(b.home, '.gbrain', 'member-keys'))).toBe(false);

    const r = await setup(b, ['claude-code', '--shape', 'household', '--owner', 'alice-example', '--yes']);
    expect(r.exitCode).toBe(0);
    const hh = r.doc.brain_layout.household;
    expect(hh.result.applied).toBe(true);
    expect(hh.result.error).toBeUndefined();
    expect(hh.result.steps.every((s: any) => s.state === 'done')).toBe(true);
    expect(hh.result.key_dir).toBe(join(b.home, '.gbrain', 'member-keys'));
    expect(readFileSync(join(b.home, '.claude.json'), 'utf8')).toContain('"--stdio-member",\n        "alice-example"');
    const keys = readdirSync(join(b.home, '.gbrain', 'member-keys')).sort();
    expect(keys).toEqual(['adult-b.key', 'family-chat.key', 'helper.key']);
    for (const k of keys) {
      const path = join(hh.result.key_dir, k);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const token = readFileSync(path, 'utf8').trim();
      expect(r.stdout + r.stderr).not.toContain(token);
    }
    const md = readFileSync(join(b.home, '.claude', 'CLAUDE.md'), 'utf8');
    expect(md).toContain(LAYOUT_BEGIN);
    expect(md).toContain('call household_due');
    expect(md).toContain('household_mark');
    expect(md).toContain("without the user's yes");

    const status = await setup(b, ['claude-code', '--shape', 'household', '--status']);
    expect(status.exitCode).toBe(0);
    expect(status.doc.complete).toBe(true);
    expect(status.doc.proof.map((p: any) => [p.member, p.ok])).toEqual([['adult-b', true], ['helper', true], ['family-chat', true]]);
    expect(JSON.stringify(status.doc)).not.toMatch(/gbrain_[A-Za-z0-9]{8}/);

    const elsewhere = await setup(b, ['codex', '--shape', 'household', '--resume', hh.result.receipt_id, '--yes']);
    expect(elsewhere.exitCode).not.toBe(0);
    expect(elsewhere.stdout + elsewhere.stderr).toContain('setup_receipt_target_mismatch');
  }, 300_000);
});

describe('household setup units', () => {
  test('flags: household is a shape; its flags need it; --serves several does not go with it', async () => {
    expect(parseLayoutFlags((f) => (f === '--shape' ? 'household' : undefined), () => false, 'claude-code')).toEqual({ brain: 'household' });
    expect(parseLayoutFlags((f) => (f === '--shape' ? 'nope' : undefined), () => false, 'claude-code')).toContain('household');
    const b = box();
    for (const [args, says] of [
      [['claude-code', '--household-members', 'none'], '--household-members applies to --shape household'],
      [['claude-code', '--shape', 'personal', '--status'], '--status applies to --shape household'],
      [['claude-code', '--shape', 'household', '--serves', 'several', '--members', 'bob-example'], 'drop --serves several'],
      [['claude-code', '--shape', 'household', '--status', '--resume', 'x'], 'pass --status or --resume, not both'],
    ] as const) {
      const r = await setup(b, [...args]);
      expect({ args, code: r.exitCode, says: r.stderr.includes(says) }).toEqual({ args, code: 2, says: true });
    }
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
  }, 60_000);

  test('the household block tells the agent to call household_due, record with household_mark and never act without a yes', () => {
    const block = renderLayoutBlock('codex', 'user', null, 'household');
    expect(block).toContain('call household_due');
    expect(block).toContain('household_mark');
    expect(block).toContain("Never buy, pay, book, call, cancel or send anything for the household without the user's yes");
    expect(block).not.toContain('me/facts, me/voice');
    expect(renderLayoutBlock('codex', 'user', null, 'personal')).not.toContain('household_due');
  });

  test('a dry run previews the template (no --yes); an applied run passes --yes, the harness, the source, the roster and the owner', () => {
    const calls: string[][] = [];
    const result = { template: 'household', applied: false, receipt_id: null, harness: 'codex', source_id: 'home', owner: 'alice-example', roster: [], steps: [], keys: [], key_dir: '/k', unbound: [] };
    const run = (argv: string[]) => { calls.push(argv); return { code: 0, stdout: JSON.stringify(result), stderr: '' }; };
    const flags = { brain: 'household' as const, household: { members: 'adult:bob-example', owner: 'alice-example' } };
    const dry = applyBrainLayout({ harness: 'codex', source: 'home', launcher: '/bin/gbrain', instructionsPath: null, flags: { ...flags, dryRun: true }, run })!;
    expect(calls[0]).toEqual(['/bin/gbrain', 'household', 'template', '--harness', 'codex', '--source', 'home', '--household-members', 'adult:bob-example', '--owner', 'alice-example', '--json']);
    expect(dry.household!.result!.template).toBe('household');
    expect(describeLayout(dry, true).join('\n')).toContain('Nothing written. Add --yes to apply.');
    applyBrainLayout({ harness: 'codex', source: 'home', launcher: '/bin/gbrain', instructionsPath: null, flags: { ...flags, dryRun: false }, run });
    expect(calls[1]).toContain('--yes');
  });

  test('a template that stopped hands out the resume command for its receipt', () => {
    const result = { template: 'household', applied: true, receipt_id: 'household-20261125T000000Z-abcdef', harness: 'codex', source_id: 'default', owner: 'alice-example', roster: [], steps: [], keys: [], key_dir: '/k', unbound: [],
      error: { code: 'internal_error', message: 'disk full' } };
    const o = applyBrainLayout({ harness: 'codex', launcher: '/bin/gbrain', instructionsPath: null, flags: { brain: 'household', dryRun: false },
      run: () => ({ code: 1, stdout: JSON.stringify(result), stderr: '' }) })!;
    const notice = layoutNotices(o, 'codex').find((n) => n.code === 'household_template_pending')!;
    expect(notice.fix!.argv).toEqual(['gbrain', 'setup', 'codex', '--shape', 'household', '--resume', 'household-20261125T000000Z-abcdef', '--yes']);
  });
});
