/**
 * #8484: the brain-first ledger (agent-instructions.json) and the skills
 * ledger (skill-loading.json) are read, edited and rewritten by every install
 * lane. Two installs at once used to drop each other's entry: both read the
 * ledger, and the later rename wins. A sync now runs its whole transaction
 * under one shared lock (underInstructionLedgerLock), so an install that
 * starts while another holds the lock waits and reads the other's entry.
 *
 * The other install is a child process that takes the lock, reads the
 * ledger, waits, then writes it back with its own entry, the read-modify-write
 * every install lane does.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { brainFirstLedgerPath, brainFirstTargetAt, priorBrainFirst, removeBrainFirst, resolveBrainFirstDecision, syncBrainFirst } from '../src/core/setup/brain-first.ts';
import { priorSkillLoading, readSkillLoadingLedger, resolveSkillLoading, skillLoadingLedgerPath, syncSkillsBlock } from '../src/core/setup/skills-block.ts';
import { SKILL_INDEX_VERSION } from '../src/core/skills/spring-index.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const HOLDER = String.raw`
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { acquireNativeLockSync } from '__NATIVE_LOCK__';
const [lockPath, ledgerPath, marker, entry] = process.argv.slice(2);
const lock = acquireNativeLockSync(lockPath, { timeoutMs: 5000 });
if (!lock) process.exit(3);
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { version: 1, entries: [] };
writeFileSync(marker, 'held');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
const next = JSON.parse(entry);
ledger.entries = ledger.entries.filter((e) => !(e.harness === next.harness && e.path === next.path));
ledger.entries.push(next);
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
writeFileSync(marker + '.done', 'done');
lock.release();
`;

/** Start the other install; resolves once it holds the lock and has read the ledger. */
async function otherInstall(home: string, ledgerPath: string, entry: object): Promise<{ exited: Promise<number> }> {
  const script = join(home, 'holder.ts');
  writeFileSync(script, HOLDER.replace('__NATIVE_LOCK__', join(import.meta.dir, '..', 'src', 'core', 'persistence', 'native-lock.ts')));
  const marker = join(home, 'held');
  const child = Bun.spawn([process.execPath, '--no-env-file', script, join(home, '.gbrain', 'agent-instructions.lock'), ledgerPath, marker, JSON.stringify(entry)], { stdout: 'inherit', stderr: 'inherit' });
  for (let i = 0; i < 200 && !existsSync(marker); i++) await Bun.sleep(25);
  expect(existsSync(marker)).toBe(true);
  return { exited: child.exited };
}

function sandbox(): string {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-ledger-lock-'));
  roots.push(home);
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  return home;
}

const entries = (path: string) => (JSON.parse(readFileSync(path, 'utf8')) as { entries: { harness: string; path: string }[] }).entries.map((e) => `${e.harness} ${e.path}`).sort();

describe('#8484: concurrent installs keep every ledger entry', () => {
  test('brain-first: a sync that starts while another install holds the ledger waits and keeps its entry', async () => {
    const home = sandbox();
    await withEnv({ GBRAIN_HOME: home, HOME: home }, async () => {
      const ledger = brainFirstLedgerPath();
      const otherPath = join(home, 'other', 'AGENTS.md');
      const { exited } = await otherInstall(home, ledger, { harness: 'codex', path: otherPath, status: 'installed', block_version: 2, access: { kind: 'mcp', server: 'gbrain' }, writer: 'gbrain setup codex', created_file: false, updated_at: '2026-11-03T00:00:00.000Z' });
      const file = join(home, '.claude', 'CLAUDE.md');
      const out = syncBrainFirst({ target: brainFirstTargetAt('claude-code', file), access: { kind: 'mcp', server: 'gbrain' }, decision: { value: 'accepted', source: 'flag' }, writer: 'gbrain setup claude-code', dryRun: false });
      expect(await exited).toBe(0);
      expect(out.action).toBe('write');
      expect(entries(ledger)).toEqual([`claude-code ${file}`, `codex ${otherPath}`].sort());
    });
  });

  test('skills: a sync that starts while another install holds the ledger waits and keeps its entry', async () => {
    const home = sandbox();
    await withEnv({ GBRAIN_HOME: home, HOME: home }, async () => {
      const ledger = skillLoadingLedgerPath();
      const otherPath = join(home, 'other', 'AGENTS.md');
      const { exited } = await otherInstall(home, ledger, { harness: 'codex', path: otherPath, mode: 'off', block_version: SKILL_INDEX_VERSION, writer: 'gbrain setup codex', created_file: false, updated_at: '2026-11-03T00:00:00.000Z' });
      const file = join(home, '.claude', 'CLAUDE.md');
      const out = syncSkillsBlock({ target: brainFirstTargetAt('claude-code', file), launcher: '/usr/local/bin/gbrain', decision: { value: 'off', source: 'flag' }, writer: 'gbrain setup claude-code', dryRun: false, settingsPath: join(home, '.claude', 'settings.json') });
      expect(await exited).toBe(0);
      expect(out.action).toBe('skip');
      expect(entries(ledger)).toEqual([`claude-code ${file}`, `codex ${otherPath}`].sort());
    });
  });

  test.skipIf(process.getuid?.() === 0)('a config dir the lock cannot be created in changes nothing (ledger_locked)', async () => {
    const home = sandbox();
    await withEnv({ GBRAIN_HOME: home, HOME: home }, async () => {
      const dir = join(home, '.gbrain');
      const file = join(home, '.claude', 'CLAUDE.md');
      chmodSync(dir, 0o500);
      let skills, brainFirst;
      try {
        skills = syncSkillsBlock({ target: brainFirstTargetAt('claude-code', file), launcher: '/usr/local/bin/gbrain', decision: { value: 'off', source: 'flag' }, writer: 'test', dryRun: false });
        brainFirst = syncBrainFirst({ target: brainFirstTargetAt('claude-code', file), access: { kind: 'mcp', server: 'gbrain' }, decision: { value: 'accepted', source: 'flag' }, writer: 'test', dryRun: false });
      } finally {
        chmodSync(dir, 0o755);
      }
      expect(skills).toMatchObject({ action: 'preserve', reason: 'ledger_locked' });
      expect(brainFirst).toMatchObject({ action: 'preserve' });
      expect(brainFirst.detail).toContain('agent-instructions.lock');
      expect(existsSync(file)).toBe(false);
      expect(existsSync(skillLoadingLedgerPath())).toBe(false);
      expect(existsSync(brainFirstLedgerPath())).toBe(false);
    });
  });
});

describe('#8484: an install that waited acts on what the other one recorded', () => {
  const BIN = mkdtempSync(join(tmpdir(), 'gbrain-ledger-lock-bin-'));
  roots.push(BIN);
  const LAUNCHER = join(BIN, 'gbrain');
  writeFileSync(LAUNCHER, '#!/bin/sh\nexec \'' + process.execPath + '\' --no-env-file \'' + join(import.meta.dir, '..', 'src', 'cli.ts') + '\' "$@"\n');
  chmodSync(LAUNCHER, 0o755);

  test('skills: an opt-out recorded while this install waited is kept, and the index is not written back', async () => {
    const home = sandbox();
    await withEnv({ GBRAIN_HOME: home, HOME: home, GBRAIN_SKILL_LOADING: undefined }, async () => {
      const file = join(home, '.codex', 'AGENTS.md');
      const target = brainFirstTargetAt('codex', file);
      const first = syncSkillsBlock({ target, launcher: LAUNCHER, decision: { value: 'spring', source: 'flag' }, writer: 'gbrain setup codex', dryRun: false });
      expect(first.action).toBe('write');
      const stale = resolveSkillLoading(undefined, priorSkillLoading('codex', file));
      expect(stale).toEqual({ value: 'spring', source: 'prior' });
      const ledger = skillLoadingLedgerPath();
      const optOut = { ...readSkillLoadingLedger()[0], mode: 'off', writer: 'gbrain setup codex --skill-loading off' };
      const { exited } = await otherInstall(home, ledger, optOut);
      const out = syncSkillsBlock({ target, launcher: LAUNCHER, decision: stale, writer: 'gbrain setup codex', dryRun: false });
      expect(await exited).toBe(0);
      expect(out.decision).toEqual({ value: 'off', source: 'prior' });
      expect(readSkillLoadingLedger()[0]!.mode).toBe('off');
    });
  }, 60_000);

  test('brain-first: a decline recorded while this install waited is kept, and the block is not written back', async () => {
    const home = sandbox();
    await withEnv({ GBRAIN_HOME: home, HOME: home, GBRAIN_AGENT_INSTRUCTIONS: undefined }, async () => {
      const file = join(home, '.claude', 'CLAUDE.md');
      const target = brainFirstTargetAt('claude-code', file);
      const access = { kind: 'mcp' as const, server: 'gbrain' };
      expect(syncBrainFirst({ target, access, decision: { value: 'accepted', source: 'flag' }, writer: 'gbrain setup claude-code', dryRun: false }).action).toBe('write');
      const stale = resolveBrainFirstDecision(undefined, priorBrainFirst('claude-code', file));
      expect(stale).toEqual({ value: 'accepted', source: 'prior' });
      writeFileSync(file, '# My rules\n');
      const declined = { harness: 'claude-code', path: file, status: 'declined', block_version: 2, access, writer: 'gbrain setup claude-code --no-instructions', created_file: false, updated_at: '2026-11-03T00:00:00.000Z' };
      const { exited } = await otherInstall(home, brainFirstLedgerPath(), declined);
      const out = syncBrainFirst({ target, access, decision: stale, writer: 'gbrain setup claude-code', dryRun: false });
      expect(await exited).toBe(0);
      expect(out.decision).toEqual({ value: 'declined', source: 'prior' });
      expect(readFileSync(file, 'utf8')).toBe('# My rules\n');
      expect(priorBrainFirst('claude-code', file)?.status).toBe('declined');
    });
  }, 60_000);

  test('skills: an off decision that turns into spring while this install waited asks the launcher before taking the lock', async () => {
    const home = sandbox();
    await withEnv({ GBRAIN_HOME: home, HOME: home, GBRAIN_SKILL_LOADING: undefined }, async () => {
      const file = join(home, '.codex', 'AGENTS.md');
      const target = brainFirstTargetAt('codex', file);
      expect(syncSkillsBlock({ target, launcher: LAUNCHER, decision: { value: 'spring', source: 'flag' }, writer: 'gbrain setup codex --skill-loading spring', dryRun: false }).action).toBe('write');
      const springEntry = readSkillLoadingLedger()[0];
      rmSync(skillLoadingLedgerPath());
      rmSync(file);
      const probe = join(BIN, 'gbrain-probe');
      const asked = join(home, 'asked');
      writeFileSync(probe, `#!/bin/sh\nif [ -f '${join(home, 'held.done')}' ]; then echo under-lock >> '${asked}'; else echo before-lock >> '${asked}'; fi\nexec '${LAUNCHER}' "$@"\n`);
      chmodSync(probe, 0o755);
      const { exited } = await otherInstall(home, skillLoadingLedgerPath(), springEntry);
      const out = syncSkillsBlock({ target, launcher: probe, decision: { value: 'off', source: 'default' }, writer: 'gbrain setup codex', dryRun: false });
      expect(await exited).toBe(0);
      expect(out.decision).toEqual({ value: 'spring', source: 'prior' });
      expect(out.action).toBe('write');
      expect(readFileSync(asked, 'utf8').trim().split('\n')).toEqual(['before-lock']);
    });
  }, 60_000);
});

describe('#8484: a lock refusal on an unreadable instruction file reports preserve', () => {
  test('syncBrainFirst and removeBrainFirst return preserve instead of throwing', async () => {
    const home = sandbox();
    await withEnv({ GBRAIN_HOME: home, HOME: home, GBRAIN_AGENT_INSTRUCTIONS: undefined }, async () => {
      mkdirSync(join(home, '.gbrain', 'agent-instructions.lock'));
      const file = join(home, '.claude', 'CLAUDE.md');
      mkdirSync(file, { recursive: true });
      const access = { kind: 'mcp' as const, server: 'gbrain' };
      const sync = syncBrainFirst({ target: brainFirstTargetAt('claude-code', file), access, decision: { value: 'accepted', source: 'flag' }, writer: 'gbrain setup claude-code', dryRun: false });
      expect(sync).toMatchObject({ action: 'preserve', state_before: 'damaged' });
      expect(sync.detail).toContain('could not be locked');
      const removed = removeBrainFirst({ harness: 'claude-code', path: file, dryRun: false });
      expect(removed).toMatchObject({ action: 'preserve', state_before: 'damaged' });
    });
  });
});
