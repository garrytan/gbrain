/**
 * GBRA-435 PR 1: gbrain setup openclaw --skill-loading resolve|shadow|off and
 * the generated gbrain-skill-resolver plugin (src/core/setup/openclaw-skill-plugin.ts,
 * openclaw-skill-plugin-code.ts), plus gbrain skills pin (skill-pins.ts).
 *
 * Protects: a failed or partial OpenClaw install never exits 0
 * (skill_resolver_plugin_not_installed, exit 3, with the commands still to
 * run); a mode flip or a pin change runs no OpenClaw command (state file
 * only, so nothing reloads); pins are validated against the catalog, never
 * render an unknown name, are never also suggested, and survive --skill-loading
 * off; the plugin under Node injects the pinned block and up to 3 suggestions
 * on live turns, nothing on shadow, internal or off turns, commits a retried
 * turn once, refuses a library writable by others, gives up on a stuck worker
 * within the deadline and logs each miss; a brainless home stays brainless.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { openclawCatalogName } from '../src/core/setup/openclaw-skill-plugin.ts';

setDefaultTimeout(120_000);
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const NODE = Bun.which('node');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Box { root: string; home: string; state: string; bin: string; calls: string; env: Record<string, string | undefined> }

function skill(dir: string, name: string, description: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + description + '\n---\nSteps.\n');
}

/** A fake openclaw: records every call, edits openclaw.json like install/enable/config set do, and fails the step named in FAIL_STEP. */
const FAKE_OPENCLAW = String.raw`#!/bin/sh
echo "$*" >> "$OPENCLAW_CALLS"
[ -n "$FAIL_STEP" ] && [ "$1 $2" = "$FAIL_STEP" ] && { echo "boom: $FAIL_STEP failed" >&2; exit 1; }
cfg="$OPENCLAW_STATE_DIR/openclaw.json"
case "$1 $2" in
  "plugins install") node -e 'const f=require("fs"),p=process.argv[1],c=JSON.parse(f.readFileSync(p,"utf8"));c.plugins=c.plugins||{};c.plugins.load=c.plugins.load||{paths:[]};if(!c.plugins.load.paths.includes(process.argv[2]))c.plugins.load.paths.push(process.argv[2]);f.writeFileSync(p,JSON.stringify(c))' "$cfg" "$4";;
  "plugins enable") node -e 'const f=require("fs"),p=process.argv[1],c=JSON.parse(f.readFileSync(p,"utf8"));c.plugins.entries=c.plugins.entries||{};c.plugins.entries[process.argv[2]]={...(c.plugins.entries[process.argv[2]]||{}),enabled:true};f.writeFileSync(p,JSON.stringify(c))' "$cfg" "$3";;
  "config set") node -e 'const f=require("fs"),p=process.argv[1],c=JSON.parse(f.readFileSync(p,"utf8"));const id=process.argv[2].split(".")[2];c.plugins.entries[id].hooks={allowConversationAccess:true};f.writeFileSync(p,JSON.stringify(c))' "$cfg" "$3";;
  "plugins inspect") [ -n "$INSPECT_BROKEN" ] && { echo '{"status":"error"}'; exit 0; }; echo '{"status":"loaded","hooks":["before_prompt_build"]}';;
  "plugins uninstall") ;;
  "skills list") echo '[]' > /dev/null; exit 1;;
esac
`;

function box(opts: { openclaw?: boolean; skills?: number } = {}): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-openclaw-skill-'));
  roots.push(root);
  const home = join(root, 'home'), state = join(root, 'state'), binDir = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(state, 'workspace', 'skills'), { recursive: true });
  mkdirSync(binDir);
  writeFileSync(join(state, 'openclaw.json'), '{}');
  const skills = join(state, 'workspace', 'skills');
  skill(skills, 'deploy-service', 'Use when you deploy a service to production');
  skill(skills, 'email-triage', 'Use when you triage the email inbox');
  skill(skills, 'calendar-sync', 'Use when you sync the calendar');
  for (let i = 0; i < (opts.skills ?? 0); i++) skill(skills, 'zz-filler-' + String(i).padStart(3, '0'), 'Use when you need filler task number ' + i);
  const bin = join(binDir, 'gbrain');
  writeFileSync(bin, '#!/bin/sh\nexec \'' + process.execPath + '\' --no-env-file \'' + CLI + '\' "$@"\n');
  chmodSync(bin, 0o755);
  if (opts.openclaw !== false) { writeFileSync(join(binDir, 'openclaw'), FAKE_OPENCLAW); chmodSync(join(binDir, 'openclaw'), 0o755); }
  const calls = join(root, 'openclaw-calls.log');
  const path = [binDir, NODE ? join(NODE, '..') : '', '/usr/bin', '/bin'].filter(Boolean).join(':');
  return { root, home, state, bin, calls, env: { HOME: home, GBRAIN_HOME: home, OPENCLAW_STATE_DIR: state, OPENCLAW_CALLS: calls, PATH: path, OPENCLAW_PROFILE: undefined, OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_WORKSPACE_DIR: undefined, GBRAIN_SKILL_LOADING: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined } };
}

async function setup(b: Box, extra: string[], env: Record<string, string | undefined> = {}) {
  const r = await runCli(['setup', 'openclaw', '--instructions-only', '--gbrain-bin', b.bin, '--json', ...extra], { env: { ...b.env, ...env }, timeoutMs: 110_000 });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc, resolver: doc?.skill_resolver };
}

const calls = (b: Box) => (existsSync(b.calls) ? readFileSync(b.calls, 'utf8').trim().split('\n').filter((l) => l.includes('gbrain-skill-resolver')) : []);
const gbrainHome = (b: Box) => join(b.home, '.gbrain');
const statePath = (b: Box) => join(gbrainHome(b), 'openclaw-skill-resolver.json');
const pluginDir = (b: Box) => join(b.state, 'gbrain', 'gbrain-skill-resolver');
const readState = (b: Box) => JSON.parse(readFileSync(statePath(b), 'utf8'));

/** Drive the generated plugin under Node with a fake OpenClaw api; each step is [kind, args]. */
function drive(b: Box, steps: unknown[], nodeOptions?: string, env: Record<string, string> = {}): any {
  const script = join(b.root, 'drive.mjs');
  writeFileSync(script, String.raw`
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
const [dir, statePath, stepsJson] = process.argv.slice(2);
const m = (await import(pathToFileURL(dir + '/index.js').href)).default;
const h = {};
m.register({ on: (e, f) => { h[e] = f; } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(500);
const out = [];
for (const [kind, a] of JSON.parse(stepsJson)) {
  const ctx = { agentId: 'main', sessionKey: a.session || 'agent:main:s1', inputProvenance: { kind: a.provenance || 'external_user' }, ...(a.sender ? { senderId: a.sender } : {}) };
  if (kind === 'turn') out.push(await h.before_prompt_build({ currentUserMessage: a.text, currentUserMessageId: a.id }, ctx) ?? null);
  else if (kind === 'read') { h.after_tool_call({ toolName: 'skills_read', params: { name: a.name } }, ctx); out.push('read'); }
  else if (kind === 'compact') { h.after_compaction({}, ctx); out.push('compact'); }
  else if (kind === 'state') { const s = JSON.parse(readFileSync(statePath, 'utf8')); Object.assign(s.agents.main, a); writeFileSync(statePath, JSON.stringify(s)); await sleep(20); out.push('state'); }
  else if (kind === 'sleep') { await sleep(a.ms); out.push('slept'); }
}
await sleep(300);
console.log(JSON.stringify(out));
process.exit(0);
`);
  const r = Bun.spawnSync([NODE!, script, pluginDir(b), statePath(b), JSON.stringify(steps)], { env: { PATH: b.env.PATH!, HOME: b.home, ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}), GBRAIN_TEST_OPENCLAW_SKILL_DEADLINE_MS: '2000', ...env }, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  const text = r.stdout.toString().trim().split('\n').at(-1) ?? '';
  try { return JSON.parse(text); } catch { throw new Error('drive failed: ' + r.stderr.toString() + text); }
}

function logLines(b: Box): any[] {
  const dir = join(gbrainHome(b), 'skill-index', 'logs');
  return readdirSync(dir).filter((f) => f.startsWith('openclaw-')).flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

describe.skipIf(!NODE)('gbrain setup openclaw --skill-loading', () => {
  test('shadow installs once; a flip to live runs no OpenClaw command and keeps the plugin files', async () => {
    const b = box();
    const first = await setup(b, ['--skill-loading', 'shadow']);
    expect(first.exitCode).toBe(0);
    expect(first.resolver.error).toBeUndefined();
    expect(first.resolver.steps.map((s: any) => s.step)).toEqual(['catalog', 'library', 'state', 'plugin', 'install', 'verify', 'self-test']);
    expect(calls(b)).toEqual([
      'plugins install --link ' + pluginDir(b) + ' --force --accept-capabilities',
      'plugins enable gbrain-skill-resolver',
      'config set plugins.entries.gbrain-skill-resolver.hooks.allowConversationAccess true',
      'plugins inspect gbrain-skill-resolver --runtime --json',
    ]);
    expect(readState(b).agents.main).toMatchObject({ mode: 'shadow', catalog: 'openclaw-main', top_k: 3, min_match: 'description', live_fraction: 1, pins_route: 'system' });
    expect(readFileSync(statePath(b), 'utf8')).not.toContain('.mjs');
    const index = readFileSync(join(pluginDir(b), 'index.js'), 'utf8');
    const before = calls(b).length;
    const flip = await setup(b, ['--skill-loading', 'resolve', '--live-fraction', '0.5']);
    expect(flip.exitCode).toBe(0);
    expect(calls(b).length).toBe(before);
    expect(flip.resolver.steps.find((s: any) => s.step === 'install')).toMatchObject({ action: 'skip' });
    expect(readFileSync(join(pluginDir(b), 'index.js'), 'utf8')).toBe(index);
    expect(readState(b).agents.main).toMatchObject({ mode: 'live', live_fraction: 0.5 });
    expect((Bun.spawnSync(['stat', '-c', '%a', statePath(b)]).stdout.toString().trim())).toBe('600');
  });

  test('no openclaw on PATH: exit 3, skill_resolver_plugin_not_installed, the commands still to run', async () => {
    const b = box({ openclaw: false });
    const r = await setup(b, ['--skill-loading', 'resolve']);
    expect(r.exitCode).toBe(3);
    expect(r.resolver.error.code).toBe('skill_resolver_plugin_not_installed');
    expect(r.resolver.error.commands).toHaveLength(3);
    expect(r.resolver.error.recovery).toContain('0 of 3 commands ran');
    expect(existsSync(join(pluginDir(b), 'index.js'))).toBe(true);
    expect(existsSync(statePath(b))).toBe(true);
  });

  test('a failed openclaw step: exit 3 naming it, with only the remaining commands', async () => {
    const b = box();
    const r = await setup(b, ['--skill-loading', 'resolve'], { FAIL_STEP: 'plugins enable' });
    expect(r.exitCode).toBe(3);
    expect(r.resolver.error.code).toBe('skill_resolver_plugin_not_installed');
    expect(r.resolver.error.message).toContain('boom: plugins enable failed');
    expect(r.resolver.error.commands).toEqual(['openclaw plugins enable gbrain-skill-resolver', 'openclaw config set plugins.entries.gbrain-skill-resolver.hooks.allowConversationAccess true'].map((c) => join(b.root, 'bin') + '/' + c));
    expect(r.resolver.error.recovery).toContain('1 of 3 commands ran');
  });

  test('plugins inspect not showing it loaded: exit 3, never success', async () => {
    const b = box();
    const r = await setup(b, ['--skill-loading', 'resolve'], { INSPECT_BROKEN: '1' });
    expect(r.exitCode).toBe(3);
    expect(r.resolver.error.code).toBe('skill_resolver_plugin_not_installed');
  });

  test('lane settings come from core: a min_match only the plugin accepted refuses setup, and skills.resolver.pinned is never suggested', async () => {
    const bad = box();
    mkdirSync(gbrainHome(bad), { recursive: true });
    writeFileSync(join(gbrainHome(bad), 'config.json'), JSON.stringify({ skills: { resolver: { per_harness: { openclaw: { min_match: 'none' } } } } }));
    const refused = await setup(bad, ['--skill-loading', 'resolve']);
    expect(refused.resolver.error.code).toBe('skill_resolver_config_invalid');
    expect(refused.exitCode).not.toBe(0);
    expect(existsSync(statePath(bad))).toBe(false);
    expect(calls(bad)).toEqual([]);

    const b = box();
    mkdirSync(gbrainHome(b), { recursive: true });
    writeFileSync(join(gbrainHome(b), 'config.json'), JSON.stringify({ skills: { resolver: { pinned: ['email-triage'], per_harness: { openclaw: { top_k: 2 } } } } }));
    expect((await setup(b, ['--skill-loading', 'resolve'])).exitCode).toBe(0);
    expect(readState(b).agents.main).toMatchObject({ top_k: 2, min_match: 'description', exclude_ids: ['email-triage'] });
    const out = drive(b, [['turn', { text: 'deploy the service to production and triage the email inbox', id: 'm1' }]]);
    expect(out[0].appendContext).toContain('deploy-service');
    expect(out[0].appendContext).not.toContain('email-triage');
  });

  test('--dry-run writes nothing', async () => {
    const b = box();
    const r = await setup(b, ['--skill-loading', 'resolve', '--dry-run']);
    expect(r.exitCode).toBe(0);
    expect(existsSync(statePath(b))).toBe(false);
    expect(existsSync(pluginDir(b))).toBe(false);
    expect(calls(b)).toEqual([]);
  });

  test('a brainless home stays brainless', async () => {
    const b = box();
    await setup(b, ['--skill-loading', 'resolve']);
    const cfg = existsSync(join(gbrainHome(b), 'config.json')) ? JSON.parse(readFileSync(join(gbrainHome(b), 'config.json'), 'utf8')) : {};
    expect(cfg.engine).toBeUndefined();
    expect(cfg.database_url).toBeUndefined();
  });
});

describe.skipIf(!NODE)('gbrain skills pin', () => {
  test('validates against the catalog, updates the plugin state hot, and survives --skill-loading off', async () => {
    const b = box();
    await setup(b, ['--skill-loading', 'resolve']);
    const before = calls(b).length;
    const bad = await runCli(['skills', 'pin', 'add', 'not-a-skill', '--catalog', 'openclaw-main', '--json'], { env: b.env });
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stdout + bad.stderr).toContain('skill_resolver_pin_unknown');
    const long = await runCli(['skills', 'pin', 'add', 'deploy-service', '--catalog', 'openclaw-main', '--line', 'x'.repeat(101)], { env: b.env });
    expect(long.exitCode).toBe(2);
    const ok = await runCli(['skills', 'pin', 'add', 'deploy-service', '--catalog', 'openclaw-main', '--line', 'Before any production deploy', '--json'], { env: b.env });
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ rendered: ['deploy-service'], openclaw_agents_updated: ['main'] });
    expect(calls(b).length).toBe(before);
    const st = readState(b).agents.main;
    expect(st.pinned_ids).toEqual(['deploy-service']);
    expect(st.pinned_block).toContain('id: "deploy-service" when: "Before any production deploy"');
    expect(st.pinned_block).toContain('skills_read({name})');
    const off = await setup(b, ['--skill-loading', 'off']);
    expect(off.exitCode).toBe(0);
    expect(existsSync(statePath(b))).toBe(false);
    expect(existsSync(pluginDir(b))).toBe(false);
    expect(calls(b).at(-1)).toBe('plugins uninstall gbrain-skill-resolver --force');
    const list = await runCli(['skills', 'pin', 'list', '--catalog', 'openclaw-main', '--json'], { env: b.env });
    expect(JSON.parse(list.stdout).pins).toEqual([{ name: 'deploy-service', line: 'Before any production deploy' }]);
  });
});

test('catalog names: distinct agent ids never share a catalog, and plain ids keep their plain name', () => {
  const long = 'a'.repeat(60);
  const names = ['main', 'work', 'Work', 'a-b', 'a.b', long + 'x', long + 'y'].map(openclawCatalogName);
  expect(names[0]).toBe('openclaw-main');
  expect(names[1]).toBe('openclaw-work');
  expect(new Set(names).size).toBe(names.length);
  for (const n of names) expect(n).toMatch(/^openclaw-[a-z0-9][a-z0-9_-]{0,53}$/);
});

describe.skipIf(!NODE)('the gbrain-skill-resolver plugin under Node', () => {
  test('live: pins every turn, up to 3 suggestions, pinned never suggested, retry commits once; skips internal turns; shadow and off inject nothing', async () => {
    const b = box({ skills: 250 });
    await setup(b, ['--skill-loading', 'resolve']);
    await runCli(['skills', 'pin', 'add', 'deploy-service', '--catalog', 'openclaw-main'], { env: b.env });
    const out = drive(b, [
      ['turn', { text: 'deploy the service to production and triage the email inbox', id: 'm1' }],
      ['turn', { text: 'deploy the service to production and triage the email inbox', id: 'm1' }],
      ['turn', { text: 'sync the calendar', id: 'm2', provenance: 'inter_session' }],
      ['turn', { text: 'filler task number 249', id: 'm3', session: 'agent:main:s9' }],
      ['read', { name: 'email-triage' }],
      ['state', { mode: 'shadow' }],
      ['turn', { text: 'sync the calendar', id: 'm4', session: 'agent:main:s2' }],
      ['state', { mode: 'off' }],
      ['turn', { text: 'sync the calendar', id: 'm5', session: 'agent:main:s3' }],
    ], '--max-old-space-size=256');
    expect(out[0].appendSystemContext).toContain('<pinned_skills>');
    expect(out[0].appendContext).toContain('<relevant_skills>');
    expect(out[0].appendContext).toContain('email-triage');
    expect(out[0].appendContext).not.toContain('"deploy-service"');
    expect((out[0].appendContext.match(/^- id:/gm) ?? []).length).toBeLessThanOrEqual(3);
    expect(out[1]).toEqual(out[0]);
    expect(out[2]).toEqual({ appendSystemContext: out[0].appendSystemContext });
    expect(out[3].appendContext).toContain('zz-filler-249');
    expect(out[6]).toBeNull();
    expect(out[8]).toBeNull();
    const lines = logLines(b);
    expect(lines.map((l) => l.outcome)).toEqual(['suggested', 'retry', 'skipped_provenance', 'suggested', 'read', 'would_suggest']);
    expect(lines.find((l) => l.outcome === 'read')).toMatchObject({ skill: 'email-triage', suggested: true, pinned: false });
    expect(JSON.stringify(lines)).not.toContain('production');
    const sessions = readdirSync(join(gbrainHome(b), 'skill-index', 'sessions'));
    expect(sessions.length).toBeGreaterThan(0);
  });

  test('the daily log keeps event order when a skill read follows a turn at once', async () => {
    const b = box();
    await setup(b, ['--skill-loading', 'resolve']);
    const steps: unknown[] = [];
    const want: string[] = [];
    for (let i = 0; i < 4; i++) {
      steps.push(['turn', { text: 'triage the email inbox', id: 'm' + i, session: 'agent:main:o' + i }]);
      want.push('suggested');
      for (let j = 0; j < 40; j++) { steps.push(['read', { name: 'skill-' + i + '-' + j }]); want.push('skill-' + i + '-' + j); }
    }
    drive(b, steps);
    expect(logLines(b).filter((l) => l.agent === 'main').map((l) => l.skill ?? l.outcome)).toEqual(want);
  });

  test('the description floor holds: body-only matches are never suggested', async () => {
    const b = box();
    const skills = join(b.state, 'workspace', 'skills');
    mkdirSync(join(skills, 'zeta-notes'), { recursive: true });
    writeFileSync(join(skills, 'zeta-notes', 'SKILL.md'), '---\nname: zeta-notes\ndescription: Use when you keep a journal\n---\nAlso covers quarterly xylophone tuning.\n');
    expect((await setup(b, ['--skill-loading', 'resolve'])).exitCode).toBe(0);
    const out = drive(b, [
      ['turn', { text: 'xylophone tuning', id: 'm1' }],
      ['turn', { text: 'triage the email inbox and the xylophone tuning', id: 'm2', session: 'agent:main:s2' }],
    ]);
    expect(out[0]).toBeNull();
    expect(out[1].appendContext).toContain('email-triage');
    expect(out[1].appendContext).not.toContain('zeta-notes');
    const lines = logLines(b).filter((l) => l.agent === 'main');
    expect(lines[0]).toMatchObject({ outcome: 'no_match', suggested: [] });
    expect(lines[1].strengths.every((s: string) => ['named', 'name', 'triggers', 'routing', 'description'].includes(s))).toBe(true);
  });

  test('rollout knobs: control arm, owner senders, first-turn pins and compaction', async () => {
    const b = box();
    await setup(b, ['--skill-loading', 'resolve', '--pins-route', 'first_turn', '--owner-sender', 'owner-1']);
    await runCli(['skills', 'pin', 'add', 'deploy-service', '--catalog', 'openclaw-main'], { env: b.env });
    const out = drive(b, [
      ['turn', { text: 'triage the email inbox', id: 'm1', sender: 'owner-1' }],
      ['turn', { text: 'sync the calendar', id: 'm2', sender: 'owner-1' }],
      ['turn', { text: 'sync the calendar', id: 'm3', sender: 'stranger', session: 'agent:main:s5' }],
      ['compact', {}],
      ['turn', { text: 'sync the calendar please', id: 'm4', sender: 'owner-1' }],
      ['state', { live_fraction: 0 }],
      ['turn', { text: 'triage the email inbox', id: 'm5', sender: 'owner-1', session: 'agent:main:s6' }],
    ]);
    expect(out[0].appendSystemContext).toBeUndefined();
    expect(out[0].appendContext).toContain('<pinned_skills>');
    expect(out[0].appendContext).toContain('email-triage');
    expect(out[1].appendContext).not.toContain('<pinned_skills>');
    expect(out[2]).toEqual({ appendContext: expect.stringContaining('<pinned_skills>') });
    expect(out[4].appendContext).toContain('<pinned_skills>');
    expect(out[6]?.appendContext ?? '').not.toContain('<relevant_skills>');
    const lines = logLines(b);
    expect(lines.find((l) => l.outcome === 'skipped_sender')).toBeTruthy();
    expect(lines.at(-1)).toMatchObject({ arm: 'control', outcome: 'would_suggest' });
  });

  test('fails closed: a turn with no sender under an owner allowlist, and a remembered block once the arm is no longer live', async () => {
    const b = box();
    await setup(b, ['--skill-loading', 'resolve', '--owner-sender', 'owner-1']);
    const out = drive(b, [
      ['turn', { text: 'triage the email inbox', id: 'm1' }],
      ['turn', { text: 'sync the calendar', id: 'm2', sender: 'owner-1' }],
      ['state', { mode: 'shadow' }],
      ['turn', { text: 'sync the calendar', id: 'm2', sender: 'owner-1' }],
      ['state', { mode: 'live', live_fraction: 0 }],
      ['turn', { text: 'sync the calendar', id: 'm2', sender: 'owner-1' }],
    ]);
    expect(out[0]?.appendContext ?? '').not.toContain('<relevant_skills>');
    expect(out[1].appendContext).toContain('calendar-sync');
    expect(out[3]?.appendContext ?? '').not.toContain('<relevant_skills>');
    expect(out[5]?.appendContext ?? '').not.toContain('<relevant_skills>');
    expect(logLines(b)[0]).toMatchObject({ outcome: 'skipped_sender' });
  });

  test('the version-skew refresh never inherits GBRAIN_SKILL_LOADING, so a gateway env cannot turn the plugin off', async () => {
    const b = box();
    await setup(b, ['--skill-loading', 'resolve']);
    const rec = join(b.root, 'gbrain-calls.log');
    writeFileSync(b.bin, '#!/bin/sh\necho "skill_loading=[$GBRAIN_SKILL_LOADING] $*" >> \'' + rec + '\'\n[ "$1" = "--version" ] && echo "gbrain 99.0.0"\nexit 0\n');
    drive(b, [['turn', { text: 'triage the email inbox', id: 'm1' }], ['sleep', { ms: 1500 }]], undefined, { GBRAIN_SKILL_LOADING: 'spring' });
    const lines = readFileSync(rec, 'utf8').trim().split('\n');
    expect(lines).toContain('skill_loading=[] setup openclaw --skills-index-only');
  });

  test('refuses a library writable by others, and survives a process-only NODE_OPTIONS flag', async () => {
    const b = box();
    await setup(b, ['--skill-loading', 'resolve']);
    const sha = readState(b).library_sha256;
    chmodSync(join(gbrainHome(b), 'lib', sha + '.mjs'), 0o666);
    const out = drive(b, [['turn', { text: 'triage the email inbox', id: 'm1' }]], '--max-old-space-size=256 --title=gateway');
    expect(out[0]).toBeNull();
    expect(logLines(b).map((l) => l.code)).toContain('skill_resolver_library_mismatch');
  });

  test('a stuck worker: every turn returns within the deadline, misses are logged, the worker is restarted', async () => {
    const b = box();
    await setup(b, ['--skill-loading', 'resolve']);
    const slow = 'export const GBRAIN_VERSION = "test"; export async function resolveSkills() { const end = Date.now() + 400; while (Date.now() < end) {} return { output: { block: "", suggestions: [], deduped: [], meta: {} } }; } export async function commitSessionAsync() {} export async function buildSkillIndex() {}\n';
    const sha = createHash('sha256').update(slow).digest('hex');
    writeFileSync(join(gbrainHome(b), 'lib', sha + '.mjs'), slow, { mode: 0o644 });
    const st = readState(b);
    st.library_sha256 = sha;
    writeFileSync(statePath(b), JSON.stringify(st));
    const t0 = Date.now();
    drive(b, [1, 2, 3].map((i) => ['turn', { text: 'triage the email inbox ' + i, id: 'm' + i }]), undefined, { GBRAIN_TEST_OPENCLAW_SKILL_DEADLINE_MS: '' });
    const outcomes = logLines(b).map((l) => l.code ?? l.outcome);
    expect(outcomes.filter((c) => c === 'skill_resolve_timeout').length).toBe(3);
    expect(outcomes).toContain('skill_resolver_worker_stuck');
    expect(logLines(b).filter((l) => l.outcome === 'timeout').every((l) => l.ms < 200)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(30_000);
  });
});

describe.skipIf(!NODE)('doctor skill_resolver: the OpenClaw plugin', () => {
  test('reports the deadline-miss rate from the daily logs and warns above 5% once there are 20 turns', async () => {
    const b = box();
    expect((await setup(b, ['--skill-loading', 'shadow'])).exitCode).toBe(0);
    const dir = join(gbrainHome(b), 'skill-index', 'logs');
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    const file = join(dir, 'openclaw-' + at.slice(0, 10) + '.jsonl');
    const write = (n: number, outcome: string, extra = {}) => { for (let i = 0; i < n; i++) writeFileSync(file, JSON.stringify({ at, outcome, ...extra }) + '\n', { flag: 'a' }); };
    const old = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    writeFileSync(file, JSON.stringify({ at: old, outcome: 'timeout', code: 'skill_resolve_timeout' }) + '\n');
    write(20, 'would_suggest');
    write(3, 'skipped_provenance');
    write(1, 'timeout', { code: 'skill_resolve_timeout' });
    const doctor = async () => JSON.parse((await runCli(['doctor', '--only', 'skill_resolver', '--json'], { env: b.env })).stdout).checks.find((c: any) => c.name === 'skill_resolver');
    const ok = await doctor();
    expect(ok.status).toBe('ok');
    expect(ok.details.openclaw.recent).toMatchObject({ turns: 24, deadline_misses: 1, miss_rate: 1 / 21 });
    expect(ok.message).toContain('deadline misses 4.8%');
    write(1, 'timeout', { code: 'skill_resolve_timeout' });
    const warn = await doctor();
    expect(warn).toMatchObject({ status: 'warn', details: { code: 'skill_resolve_timeout' } });
    expect(warn.details.openclaw.recent.miss_rate).toBeCloseTo(2 / 22);
  });
});

