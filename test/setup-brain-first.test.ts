/**
 * The brain-first instruction block (src/core/setup/brain-first.ts): every
 * install lane writes one marked block into the harness's own instruction
 * file by default. Per writable harness this pins:
 *  - preservation: text outside the markers is byte-identical after install,
 *    upgrade and removal; the identity/persona text is never touched;
 *  - idempotence: a second run keeps the file byte-for-byte;
 *  - upgrade in place: a stale block is replaced, never duplicated;
 *  - opt-out: --no-instructions (or GBRAIN_AGENT_INSTRUCTIONS=0) removes the
 *    block and is remembered; --instructions opts back in;
 *  - removal: --remove strips the block and deletes only a file gbrain created;
 *  - dry-run writes nothing.
 * Spawns \`bun src/cli.ts setup\` against a temp HOME / GBRAIN_HOME.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';
import {
  BRAIN_FIRST_BEGIN,
  BRAIN_FIRST_END,
  renderBrainFirstBlock,
  renderBrainFirstSnippet,
} from '../src/core/setup/brain-first.ts';
import { harnessWiringCheck, instructionBlockViews, withInstructionBlocks, withSurfaceNote, type InstructionBlockView } from '../src/commands/doctor/checks/harness-wiring.ts';
import { installHarnessConnection } from '../src/core/harness/install.ts';
import type { HarnessCredentials } from '../src/core/harness/credentials.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Box { root: string; home: string; project: string; bin: string; env: Record<string, string | undefined> }

function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-brain-first-'));
  roots.push(root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const bin = join(root, 'bin', 'gbrain');
  mkdirSync(join(root, 'bin'));
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(bin, 0o755);
  return { root, home, project, bin, env: {
    HOME: home, GBRAIN_HOME: home, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, XDG_CONFIG_HOME: undefined,
    OPENCLAW_STATE_DIR: undefined, OPENCLAW_WORKSPACE_DIR: undefined, OPENCLAW_PROFILE: undefined, HERMES_HOME: undefined,
    GBRAIN_AGENT_INSTRUCTIONS: undefined, GBRAIN_SURFACE: undefined, GBRAIN_SOURCE: undefined, GBRAIN_HOOKS: undefined,
  } };
}

async function setup(b: Box, args: string[], env: Record<string, string | undefined> = {}) {
  const r = await runCli(['setup', ...args, '--json'], { env: { ...b.env, ...env }, cwd: b.project });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc };
}

const read = (p: string) => readFileSync(p, 'utf8');
const blocks = (text: string) => text.split('\n').filter((l) => l === BRAIN_FIRST_BEGIN).length;
const ledger = (b: Box) => JSON.parse(read(join(b.home, '.gbrain', 'agent-instructions.json'))).entries as any[];

/** refusesCreate: a missing file is never created (Hermes uses a non-empty SOUL.md instead of its default identity). */
interface Lane { harness: string; file: (b: Box) => string; args?: string[]; prepare?: (b: Box) => void; existing: string; refusesCreate?: boolean }

const LANES: Lane[] = [
  { harness: 'claude-code', file: (b) => join(b.home, '.claude', 'CLAUDE.md'), args: ['--instructions-only'], existing: '# My rules\n\nAlways answer in French.\n' },
  { harness: 'codex', file: (b) => join(b.home, '.codex', 'AGENTS.md'), args: ['--instructions-only'], existing: '# Codex house rules\n- run the tests\n' },
  { harness: 'opencode', file: (b) => join(b.home, '.config', 'opencode', 'AGENTS.md'), existing: 'Prefer small diffs.\n' },
  { harness: 'openclaw', file: (b) => join(b.home, '.openclaw', 'workspace', 'AGENTS.md'), existing: '# AGENTS.md\n\n## Tools\nUse the calendar skill.\n' },
  { harness: 'hermes', file: (b) => join(b.home, '.hermes', 'SOUL.md'), existing: 'You are Hermes, a careful assistant named alice-example.\n', refusesCreate: true },
  { harness: 'cursor', file: (b) => join(b.project, '.cursor', 'rules', 'gbrain-brain-first.mdc'), existing: '---\ndescription: team rule\nalwaysApply: true\n---\nUse tabs.\n' },
];

for (const lane of LANES) {
  describe(`brain-first block: ${lane.harness}`, () => {
    const run = (b: Box, extra: string[] = [], env: Record<string, string | undefined> = {}) => setup(b, [lane.harness, ...(lane.args ?? []), ...extra], env);

    test('default install appends the block after the existing text, which stays byte-identical; a re-run keeps the file', async () => {
      const b = box();
      const path = lane.file(b);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, lane.existing);
      const first = await run(b);
      expect(first.exitCode).toBe(0);
      expect(first.doc.instructions).toMatchObject({ action: 'write', path, decision: { value: 'accepted', source: 'default' } });
      const text = read(path);
      expect(text.startsWith(lane.existing)).toBe(true);
      expect(blocks(text)).toBe(1);
      expect(text).toContain('Before answering any turn, check GBrain first, before files, mail or other sources');
      expect(text).toContain('apply your own access rules');
      expect(text).toContain('finish the whole task');
      expect(ledger(b)).toEqual([expect.objectContaining({ harness: lane.harness, path, status: 'installed', created_file: false })]);

      const second = await run(b);
      expect(second.doc.instructions.action).toBe('keep');
      expect(read(path)).toBe(text);
    });

    test('a stale block is upgraded in place: one block, outside text untouched before and after it', async () => {
      const b = box();
      const path = lane.file(b);
      mkdirSync(dirname(path), { recursive: true });
      const tail = '\n## Notes after the block\nkeep me\n';
      writeFileSync(path, `${lane.existing}${BRAIN_FIRST_BEGIN}\n<!-- gbrain brain-first v0 -->\nold advice\n${BRAIN_FIRST_END}\n${tail}`);
      const r = await run(b);
      expect(r.doc.instructions).toMatchObject({ action: 'write', state_before: 'stale' });
      const text = read(path);
      expect(blocks(text)).toBe(1);
      expect(text).not.toContain('old advice');
      expect(text.startsWith(lane.existing)).toBe(true);
      expect(text.endsWith(tail)).toBe(true);
    });

    test('--no-instructions removes the block and is remembered; GBRAIN_AGENT_INSTRUCTIONS=0 never writes; --instructions opts back in', async () => {
      const b = box();
      const path = lane.file(b);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, lane.existing);
      await run(b);
      const out = await run(b, ['--no-instructions']);
      expect(out.doc.instructions).toMatchObject({ action: 'remove', decision: { value: 'declined', source: 'flag' } });
      expect(read(path)).toBe(lane.existing);
      expect(ledger(b)[0]).toMatchObject({ status: 'declined' });
      const again = await run(b);
      expect(again.doc.instructions).toMatchObject({ action: 'skip', decision: { value: 'declined', source: 'prior' } });
      expect(read(path)).toBe(lane.existing);
      const back = await run(b, ['--instructions']);
      expect(back.doc.instructions).toMatchObject({ action: 'write', decision: { value: 'accepted', source: 'flag' } });

      const fresh = box();
      const env = await run(fresh, [], { GBRAIN_AGENT_INSTRUCTIONS: '0' });
      expect(env.doc.instructions).toMatchObject({ action: 'skip', decision: { value: 'declined', source: 'opt_out' } });
      expect(existsSync(lane.file(fresh))).toBe(false);
    });

    test('--remove strips the block, leaves the user text exactly as it was, and deletes only a file gbrain created', async () => {
      const b = box();
      const path = lane.file(b);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, lane.existing);
      await run(b);
      const rm = await run(b, ['--remove']);
      expect(rm.doc.instructions.action).toBe('remove');
      expect(read(path)).toBe(lane.existing);

      const created = box();
      const write = await run(created);
      if (lane.refusesCreate) {
        expect(write.doc.instructions.action).toBe('skip');
        expect(existsSync(lane.file(created))).toBe(false);
        return;
      }
      expect(write.doc.instructions.detail).toContain('new file');
      expect(existsSync(lane.file(created))).toBe(true);
      await run(created, ['--remove']);
      expect(existsSync(lane.file(created))).toBe(false);
    });

    test('--dry-run reports the write and changes nothing', async () => {
      const b = box();
      const r = await run(b, ['--dry-run']);
      expect(r.exitCode).toBe(0);
      expect(r.doc.instructions).toMatchObject({ action: lane.refusesCreate ? 'skip' : 'write', state_before: 'no_file' });
      expect(existsSync(lane.file(b))).toBe(false);
      expect(existsSync(join(b.home, '.gbrain', 'agent-instructions.json'))).toBe(false);
    });
  });
}

describe('brain-first block: placement rules', () => {
  test('codex: AGENTS.override.md wins when it exists (Codex ignores AGENTS.md then)', async () => {
    const b = box();
    mkdirSync(join(b.home, '.codex'), { recursive: true });
    writeFileSync(join(b.home, '.codex', 'AGENTS.override.md'), 'override rules\n');
    const r = await setup(b, ['codex', '--instructions-only']);
    expect(r.doc.instructions.path).toBe(join(b.home, '.codex', 'AGENTS.override.md'));
    expect(existsSync(join(b.home, '.codex', 'AGENTS.md'))).toBe(false);
  });

  test('codex: an empty AGENTS.override.md is skipped, as Codex skips it, so the block lands in AGENTS.md', async () => {
    const b = box();
    mkdirSync(join(b.home, '.codex'), { recursive: true });
    writeFileSync(join(b.home, '.codex', 'AGENTS.override.md'), '\n');
    const r = await setup(b, ['codex', '--instructions-only']);
    expect(r.doc.instructions.path).toBe(join(b.home, '.codex', 'AGENTS.md'));
    expect(read(join(b.home, '.codex', 'AGENTS.override.md'))).toBe('\n');
  });

  test('openclaw: OPENCLAW_CONFIG_PATH is read, a sole agent\'s own workspace wins, single-quoted JSON5 parses', async () => {
    const b = box();
    const cfg = join(b.root, 'custom', 'openclaw.json');
    mkdirSync(dirname(cfg), { recursive: true });
    writeFileSync(cfg, "{ agents: { defaults: { workspace: '~/default-ws' }, list: [{ id: 'main', workspace: '~/main-ws' }] } }\n");
    const r = await setup(b, ['openclaw'], { OPENCLAW_CONFIG_PATH: cfg });
    expect(r.doc.instructions.path).toBe(join(b.home, 'main-ws', 'AGENTS.md'));
  });

  test('claude-code --scope project writes CLAUDE.local.md and keeps it out of git', async () => {
    const b = box();
    const git = Bun.spawnSync(['git', 'init', '-q', b.project]);
    expect(git.exitCode).toBe(0);
    const r = await setup(b, ['claude-code', '--instructions-only', '--scope', 'project']);
    expect(r.doc.instructions.path).toBe(join(b.project, 'CLAUDE.local.md'));
    expect(read(join(b.project, '.git', 'info', 'exclude'))).toContain('/CLAUDE.local.md');
  });

  test('openclaw: agents.defaults.workspace in JSON5 config is honored; a multi-agent roster needs --workspace', async () => {
    const b = box();
    mkdirSync(join(b.home, '.openclaw'), { recursive: true });
    writeFileSync(join(b.home, '.openclaw', 'openclaw.json'), '{ agents: { defaults: { workspace: "~/agent-ws" } } }\n');
    const r = await setup(b, ['openclaw']);
    expect(r.doc.instructions.path).toBe(join(b.home, 'agent-ws', 'AGENTS.md'));
    writeFileSync(join(b.home, '.openclaw', 'openclaw.json'), '{ agents: { list: [{ id: "a" }, { id: "b" }] } }\n');
    const multi = await setup(b, ['openclaw']);
    expect(multi.exitCode).toBe(2);
    expect(multi.doc.code).toBe('invalid_params');
    const named = await setup(b, ['openclaw', '--workspace', join(b.home, 'ws-b')]);
    expect(named.doc.instructions.path).toBe(join(b.home, 'ws-b', 'AGENTS.md'));
  });

  test('hermes: the identity text in SOUL.md stays first and unchanged', async () => {
    const b = box();
    mkdirSync(join(b.home, '.hermes'), { recursive: true });
    const soul = 'You are Hermes.\nTone: dry.\n';
    writeFileSync(join(b.home, '.hermes', 'SOUL.md'), soul);
    await setup(b, ['hermes']);
    expect(read(join(b.home, '.hermes', 'SOUL.md')).startsWith(soul)).toBe(true);
  });

  test('hermes: setup adds the pre_llm_call hook that carries the rule on every turn; the opt-out and --remove take it out', async () => {
    const b = box();
    mkdirSync(join(b.home, '.hermes'), { recursive: true });
    writeFileSync(join(b.home, '.hermes', 'SOUL.md'), 'You are Hermes.\n');
    writeFileSync(join(b.home, '.hermes', 'config.yaml'), 'model:\n  default: x\n');
    const config = () => read(join(b.home, '.hermes', 'config.yaml'));
    const first = await setup(b, ['hermes', '--gbrain-bin', b.bin]);
    expect(first.doc.turn_hook).toMatchObject({ action: 'write', path: join(b.home, '.hermes', 'config.yaml') });
    const hook = (load(config()) as any).hooks.pre_llm_call[0];
    expect(hook.command.startsWith("/bin/echo '")).toBe(true);
    expect(JSON.parse(hook.command.slice("/bin/echo '".length, -1)).context).toContain('check GBrain first');
    expect(read(join(b.home, '.hermes', 'SOUL.md'))).toContain(BRAIN_FIRST_BEGIN);
    const declined = await setup(b, ['hermes', '--no-instructions']);
    expect(declined.doc.turn_hook.action).toBe('remove');
    expect(config()).toBe('model:\n  default: x\n');
    await setup(b, ['hermes', '--instructions', '--gbrain-bin', b.bin]);
    expect(config()).toContain('pre_llm_call');
    expect((await setup(b, ['hermes', '--remove'])).doc.turn_hook.action).toBe('remove');
    expect(config()).toBe('model:\n  default: x\n');
  });

  test('openclaw: setup writes the before_prompt_build plugin and installs it with the openclaw CLI; the opt-out and --remove uninstall it', async () => {
    const b = box();
    mkdirSync(join(b.home, '.openclaw', 'workspace'), { recursive: true });
    const log = join(b.root, 'openclaw.log');
    writeFileSync(join(b.root, 'bin', 'openclaw'), `#!/bin/sh\necho "$*" >> '${log}'\n`);
    chmodSync(join(b.root, 'bin', 'openclaw'), 0o755);
    const path = { PATH: `${join(b.root, 'bin')}:${process.env.PATH ?? ''}` };
    const dir = join(b.home, '.openclaw', 'gbrain', 'gbrain-turn-rule');
    const first = await setup(b, ['openclaw'], path);
    expect(first.doc.turn_hook).toMatchObject({ action: 'write', path: dir });
    expect(read(join(dir, 'index.js'))).toContain('before_prompt_build');
    expect(read(log).trim().split('\n')).toEqual([
      `plugins install --link ${dir} --force --accept-capabilities`,
      'plugins enable gbrain-turn-rule',
      'config set plugins.entries.gbrain-turn-rule.hooks.allowConversationAccess true',
    ]);
    const declined = await setup(b, ['openclaw', '--no-instructions'], path);
    expect(declined.doc.turn_hook.action).toBe('remove');
    expect(existsSync(dir)).toBe(false);
    expect(read(log).trim().split('\n').at(-1)).toBe('plugins uninstall gbrain-turn-rule --force');
    await setup(b, ['openclaw', '--instructions'], path);
    expect(existsSync(dir)).toBe(true);
    expect((await setup(b, ['openclaw', '--remove'], path)).doc.turn_hook.action).toBe('remove');
    expect(existsSync(join(b.home, '.openclaw', 'gbrain'))).toBe(false);
  });

  test('a damaged block is preserved and reported, never guessed through', async () => {
    const b = box();
    const path = join(b.home, '.claude', 'CLAUDE.md');
    mkdirSync(dirname(path), { recursive: true });
    const damaged = `mine\n${BRAIN_FIRST_BEGIN}\nhalf a block\n`;
    writeFileSync(path, damaged);
    const r = await setup(b, ['claude-code', '--instructions-only']);
    expect(r.exitCode).toBe(1);
    expect(r.doc.instructions).toMatchObject({ action: 'preserve', state_before: 'damaged' });
    expect(read(path)).toBe(damaged);
  });

  test('a client with no writable instruction file gets the block printed to paste', async () => {
    const b = box();
    const r = await setup(b, ['chatgpt', '--instructions-only']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.instructions.action).toBe('print');
    // Nothing on disk to remove, so the opt-out is deleting the pasted block.
    expect(r.doc.instructions.snippet).toBe(renderBrainFirstSnippet('chatgpt', { kind: 'mcp', server: 'gbrain' }, 'delete this block'));
    // A thin-CLI client gets the CLI-flavored block with the launcher it calls.
    const bot = await setup(b, ['grok-bot', '--instructions-only', '--gbrain-bin', '/opt/example/bin/gbrain']);
    expect(bot.exitCode).toBe(0);
    expect(bot.doc.instructions.snippet).toBe(renderBrainFirstSnippet('grok-bot', { kind: 'cli', launcher: '/opt/example/bin/gbrain' }, 'delete this block'));
  });
});

describe('brain-first block: hardening', () => {
  test('a CRLF or BOM file keeps one block: upgraded in place, then removed by the opt-out', async () => {
    const b = box();
    const path = join(b.home, '.claude', 'CLAUDE.md');
    mkdirSync(dirname(path), { recursive: true });
    const stale = renderBrainFirstSnippet('claude-code', { kind: 'mcp', server: 'gbrain' }).replace('finish the whole task', 'stop');
    writeFileSync(path, `\uFEFFrules\r\n${stale.replace(/\n/g, '\r\n')}tail\r\n`);
    const up = await setup(b, ['claude-code', '--instructions-only']);
    expect(up.doc.instructions).toMatchObject({ action: 'write', state_before: 'stale' });
    expect(read(path).split('\n').filter((l) => l.replace(/\r$/, '') === BRAIN_FIRST_BEGIN)).toHaveLength(1);
    expect(read(path).startsWith('\uFEFFrules\r\n')).toBe(true);
    expect(read(path).endsWith('tail\r\n')).toBe(true);
    const off = await setup(b, ['claude-code', '--instructions-only', '--no-instructions']);
    expect(off.doc.instructions.action).toBe('remove');
    expect(read(path)).toBe('\uFEFFrules\r\ntail\r\n');
  });

  test('a dangling symlink is followed and never deleted on removal', async () => {
    const b = box();
    const real = join(b.root, 'dotfiles', 'CLAUDE.md');
    mkdirSync(dirname(real), { recursive: true });
    mkdirSync(join(b.home, '.claude'), { recursive: true });
    symlinkSync(real, join(b.home, '.claude', 'CLAUDE.md'));
    await setup(b, ['claude-code', '--instructions-only']);
    expect(blocks(read(real))).toBe(1);
    expect(ledger(b)[0].created_file).toBe(false);
    await setup(b, ['claude-code', '--instructions-only', '--remove']);
    expect(lstatSync(join(b.home, '.claude', 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(read(real)).toBe('');
  });

  test('an opt-out survives the Codex target moving to a non-empty AGENTS.override.md; doctor follows the move', async () => {
    const b = box();
    await setup(b, ['codex', '--instructions-only']);
    writeFileSync(join(b.home, '.codex', 'AGENTS.override.md'), 'override rules\n');
    await withEnv({ ...b.env, CODEX_HOME: join(b.home, '.codex') }, async () => {
      expect(instructionBlockViews([])).toEqual([expect.objectContaining({ harness: 'codex', path: join(b.home, '.codex', 'AGENTS.override.md'), state: 'missing' })]);
    });
    await setup(b, ['codex', '--instructions-only', '--no-instructions']);
    writeFileSync(join(b.home, '.codex', 'AGENTS.override.md'), 'new override\n');
    rmSync(join(b.home, '.codex', 'AGENTS.md'), { force: true });
    writeFileSync(join(b.home, '.codex', 'AGENTS.override.md'), 'newer override\n');
    const again = await setup(b, ['codex', '--instructions-only']);
    expect(again.doc.instructions.decision.value).toBe('declined');
    expect(read(join(b.home, '.codex', 'AGENTS.override.md'))).toBe('newer override\n');
  });

  test('doctor\'s repair names the recorded connection and surface; a project file is the user\'s to run in place', () => {
    const views: InstructionBlockView[] = [{ harness: 'codex', path: '/x/.codex/AGENTS.md', state: 'stale', from: 'ledger', access: { kind: 'mcp', server: 'work-brain', surface: 'verbs' } }];
    const c = withInstructionBlocks({ name: 'harness_wiring', status: 'ok', message: 'wired.' }, views);
    expect(c.fix?.argv).toEqual(['gbrain', 'setup', 'codex', '--instructions-only', '--name', 'work-brain', '--surface', 'verbs']);
    const project = withInstructionBlocks({ name: 'harness_wiring', status: 'ok', message: 'wired.' }, [{ harness: 'cursor', path: '/repo/.cursor/rules/gbrain-brain-first.mdc', state: 'missing', from: 'ledger' }]);
    expect(project.fix?.argv).toBeUndefined();
    expect(project.fix?.user_message).toContain('From /repo, run: gbrain setup cursor --instructions-only');
  });
});

describe('doctor harness_wiring: a full registration is information only', () => {
  test('a stdio registration pinned to --surface full gets a note; status and fix are unchanged; starter or a GBRAIN_SURFACE override gets none', () => {
    const ok = { name: 'harness_wiring', status: 'ok' as const, message: 'wired.' };
    const full = withSurfaceNote(ok, [{ harness: 'codex', source: '/x/config.toml', kind: 'stdio', command: '/bin/gbrain', args: ['serve', '--surface', 'full'] }]);
    expect(full.status).toBe('ok');
    expect(full.fix).toBeUndefined();
    expect(String(full.details?.surface_note)).toContain('Codex registered with --surface full, which stays supported');
    expect(withSurfaceNote(ok, [{ harness: 'codex', source: '/x', kind: 'stdio', args: ['serve', '--surface', 'starter'] }])).toEqual(ok);
    expect(withSurfaceNote(ok, [{ harness: 'codex', source: '/x', kind: 'stdio', args: ['serve', '--surface', 'full'], env: { GBRAIN_SURFACE: 'starter' } }])).toEqual(ok);
  });
});

describe('brain-first block: text', () => {
  test('names the tools the surface lists: search/query/get_page, recall/entity on verbs, the CLI on a thin client', () => {
    const full = renderBrainFirstBlock('codex', { kind: 'mcp', server: 'gbrain', surface: 'full' });
    expect(full).toContain('`search`');
    expect(full).toContain('`get_page`');
    const verbs = renderBrainFirstBlock('codex', { kind: 'mcp', server: 'gbrain', surface: 'verbs' });
    expect(verbs).toContain('`recall`');
    expect(verbs).not.toContain('get_page');
    const cli = renderBrainFirstBlock('openclaw', { kind: 'cli', launcher: '/opt/agent/bin/gbrain' });
    expect(cli).toContain('`/opt/agent/bin/gbrain search');
    expect(cli).toContain('`/opt/agent/bin/gbrain get <slug>`');
  });

  test('stays short: it loads into every turn', () => {
    const words = renderBrainFirstBlock('claude-code', { kind: 'mcp', server: 'gbrain', surface: 'full' }).split(/\s+/).length;
    expect(words).toBeLessThan(160);
  });
});

describe('brain-first block: full setup and the installer lanes', () => {
  test('gbrain setup claude-code writes the block by default; --remove takes it out with the MCP entry', async () => {
    const b = box();
    const first = await runCli(['setup', 'claude-code', '--json', '--gbrain-bin', b.bin], { env: b.env });
    expect(first.exitCode).toBe(0);
    const doc = JSON.parse(first.stdout);
    expect(doc.instructions).toMatchObject({ action: 'write', path: join(b.home, '.claude', 'CLAUDE.md') });
    expect(read(join(b.home, '.claude', 'CLAUDE.md'))).toContain('the `gbrain` MCP server');
    expect(read(join(b.home, '.claude', 'CLAUDE.md'))).toContain('`recall` for what was said or decided');
    const second = JSON.parse((await runCli(['setup', 'claude-code', '--json', '--gbrain-bin', b.bin], { env: b.env })).stdout);
    expect(second.steps.map((s: any) => s.action)).toEqual(['keep', 'keep', 'keep']);
    expect(second.instructions.action).toBe('keep');
    const rm = JSON.parse((await runCli(['setup', 'claude-code', '--remove', '--json', '--gbrain-bin', b.bin], { env: b.env })).stdout);
    expect(rm.instructions.action).toBe('remove');
    expect(existsSync(join(b.home, '.claude', 'CLAUDE.md'))).toBe(false);
  });

  test('the block names the tools the registration lists: recall on the default verbs listing, search on an explicit --surface full', async () => {
    const b = box();
    expect((await runCli(['setup', 'codex', '--json', '--gbrain-bin', b.bin], { env: b.env })).exitCode).toBe(0);
    expect(read(join(b.home, '.codex', 'AGENTS.md'))).toContain('`recall` for what was said or decided');
    const c = box();
    expect((await runCli(['setup', 'codex', '--surface', 'full', '--json', '--gbrain-bin', c.bin], { env: c.env })).exitCode).toBe(0);
    expect(read(join(c.home, '.codex', 'AGENTS.md'))).toContain('`search` for names and phrases');
  });

  test('gbrain setup codex --no-instructions wires MCP and hooks but no block', async () => {
    const b = box();
    const r = await runCli(['setup', 'codex', '--no-instructions', '--json', '--gbrain-bin', b.bin], { env: b.env });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).instructions).toMatchObject({ action: 'skip', decision: { value: 'declined' } });
    expect(existsSync(join(b.home, '.codex', 'AGENTS.md'))).toBe(false);
  });

  const credentials: HarnessCredentials = { version: 1, mcp_url: 'https://brain.example.com/mcp', issuer_url: 'https://brain.example.com', client_id: 'gbrain_cl_fixture', client_secret: 'fixture-secret-not-real', access_token: 'fixture-token-not-real' };

  for (const [harness, config, instructions] of [
    ['claude-code', '.claude.json', join('.claude', 'CLAUDE.md')],
    ['codex', join('.codex', 'config.toml'), join('.codex', 'AGENTS.md')],
    ['opencode', join('.config', 'opencode', 'opencode.jsonc'), join('.config', 'opencode', 'AGENTS.md')],
  ] as const) {
    test(`connect --install (${harness}) writes the block beside its config; --remove and instructions:false take it out`, async () => {
      const b = box();
      await withEnv(b.env, async () => {
        const configPath = join(b.home, config);
        const instructionPath = join(b.home, instructions);
        mkdirSync(dirname(instructionPath), { recursive: true });
        writeFileSync(instructionPath, 'house rules\n');
        const installed = await installHarnessConnection(credentials, { harness, configPath });
        expect((installed as any).instructions).toMatchObject({ action: 'write', path: instructionPath });
        expect(blocks(read(instructionPath))).toBe(1);
        const again = await installHarnessConnection(credentials, { harness, configPath });
        expect((again as any).instructions.action).toBe('keep');
        const optedOut = await installHarnessConnection(credentials, { harness, configPath, instructions: false });
        expect((optedOut as any).instructions.action).toBe('remove');
        expect(read(instructionPath)).toBe('house rules\n');
        await installHarnessConnection(credentials, { harness, configPath, instructions: true });
        const removed = await installHarnessConnection(credentials, { harness, configPath, remove: true });
        expect((removed as any).instructions.action).toBe('remove');
        expect(read(instructionPath)).toBe('house rules\n');
      });
    });
  }

  test('removing one connection leaves the block another connection last wrote', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      const configPath = join(b.home, '.claude.json');
      const instructionPath = join(b.home, '.claude', 'CLAUDE.md');
      await installHarnessConnection(credentials, { harness: 'claude-code', configPath, name: 'alpha' });
      await installHarnessConnection({ ...credentials, client_id: 'client-beta' }, { harness: 'claude-code', configPath, name: 'beta' });
      expect(read(instructionPath)).toContain('`beta` MCP server');
      const removed = await installHarnessConnection(credentials, { harness: 'claude-code', configPath, name: 'alpha', remove: true });
      expect((removed as any).instructions.action).toBe('skip');
      expect(read(instructionPath)).toContain('`beta` MCP server');
    });
  });

  test('thin-client opt-out: GBRAIN_AGENT_INSTRUCTIONS=0 writes no block, and --no-instructions is kept on the next install', async () => {
    const b = box();
    const envRoot = join(b.root, 'thin-env');
    await withEnv({ ...b.env, GBRAIN_AGENT_INSTRUCTIONS: '0' }, async () => {
      await installHarnessConnection(credentials, { harness: 'openclaw', root: envRoot });
    });
    expect(read(join(envRoot, 'GBRAIN-INSTRUCTIONS.md'))).not.toContain(BRAIN_FIRST_BEGIN);
    const root = join(b.root, 'thin-flag');
    await withEnv(b.env, async () => {
      await installHarnessConnection(credentials, { harness: 'openclaw', root, instructions: false });
      await installHarnessConnection(credentials, { harness: 'openclaw', root });
    });
    expect(read(join(root, 'GBRAIN-INSTRUCTIONS.md'))).not.toContain(BRAIN_FIRST_BEGIN);
  });

  test('thin-client install (OpenClaw) puts the CLI-flavored block first in GBRAIN-INSTRUCTIONS.md', async () => {
    const b = box();
    const root = join(b.root, 'thin');
    await withEnv(b.env, async () => {
      await installHarnessConnection(credentials, { harness: 'openclaw', root });
    });
    const text = read(join(root, 'GBRAIN-INSTRUCTIONS.md'));
    expect(text.startsWith(BRAIN_FIRST_BEGIN)).toBe(true);
    expect(text).toContain(`\`${join(root, 'bin', 'gbrain')} search`);
  });
});

describe('doctor harness_wiring reports the block', () => {
  function stdioRegistration(b: Box): void {
    writeFileSync(join(b.home, '.claude.json'), JSON.stringify({ mcpServers: { gbrain: { type: 'stdio', command: b.bin, args: ['serve'] } } }));
  }
  const env = (b: Box) => ({ ...b.env, CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CODEX_SANDBOX: undefined, CODEX_CI: undefined, OPENCODE: undefined, OPENCODE_PID: undefined });

  test('a registration without the block warns, with a fix that writes only the block; current reads ok', async () => {
    const b = box();
    stdioRegistration(b);
    await withEnv(env(b), async () => {
      const missing = await harnessWiringCheck({ smoke: false });
      expect(missing.status).toBe('warn');
      expect(missing.details?.instructions).toEqual([{ harness: 'claude-code', path: join(b.home, '.claude', 'CLAUDE.md'), state: 'missing', from: 'default_path' }]);
      expect(missing.fix?.argv).toEqual(['gbrain', 'setup', 'claude-code', '--instructions-only']);
    });
    await setup(b, ['claude-code', '--instructions-only', '--gbrain-bin', b.bin]);
    await withEnv(env(b), async () => {
      const current = await harnessWiringCheck({ smoke: false });
      expect(current.status).toBe('ok');
      expect(current.message).toContain('Brain-first instructions current for claude-code.');
      expect(current.details?.instructions).toEqual([expect.objectContaining({ state: 'current', from: 'ledger' })]);
    });
  });

  test('a recorded block whose per-turn hook is missing warns turn_hook_not_loaded, naming the native check; the re-run clears it', async () => {
    const b = box();
    stdioRegistration(b);
    await setup(b, ['claude-code', '--instructions-only']);
    await withEnv(env(b), async () => {
      const c = await harnessWiringCheck({ smoke: false });
      expect(c.status).toBe('warn');
      expect(c.details).toMatchObject({ code: 'turn_hook_not_loaded', turn_hook_reason: 'missing' });
      expect(c.message).toContain('/hooks (inside a Claude Code session)');
      expect(c.fix?.argv).toEqual(['gbrain', 'setup', 'claude-code', '--instructions-only']);
      expect(c.fix?.verify).toEqual({ argv: ['gbrain', 'doctor', '--only', 'harness_wiring', '--json'] });
    });
    await setup(b, ['claude-code', '--instructions-only', '--gbrain-bin', b.bin]);
    await withEnv(env(b), async () => {
      const c = await harnessWiringCheck({ smoke: false });
      expect(c.status).toBe('ok');
      expect(c.details?.turn_hooks).toEqual([expect.objectContaining({ harness: 'claude-code', state: 'wired', via: 'turn-rule' })]);
    });
  });

  test('a hand-edited (stale) block warns; an opt-out is reported, never warned on', async () => {
    const b = box();
    stdioRegistration(b);
    await setup(b, ['claude-code', '--instructions-only']);
    const path = join(b.home, '.claude', 'CLAUDE.md');
    writeFileSync(path, read(path).replace('finish the whole task', 'stop after the lookup'));
    await withEnv(env(b), async () => {
      const stale = await harnessWiringCheck({ smoke: false });
      expect(stale.status).toBe('warn');
      expect(stale.message).toContain('is out of date');
    });
    await setup(b, ['claude-code', '--instructions-only', '--no-instructions']);
    await withEnv(env(b), async () => {
      const opted = await harnessWiringCheck({ smoke: false });
      expect(opted.status).toBe('ok');
      expect(opted.details?.instructions).toEqual([expect.objectContaining({ state: 'opted_out' })]);
    });
  });
});
