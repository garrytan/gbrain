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
 * PR 2: a skill OpenClaw hides from the agent's model, or does not list, is
 * excluded and never suggested; a failed list or one naming none of the
 * catalog filters nothing.
 * Every skill source OpenClaw loads (extra dirs, bundled, workspace) is
 * indexed with OpenClaw's precedence, from the gateway's skills.status or the
 * CLI fallback; the state names roots, paths and the gbrain home; a read of a
 * SKILL.md path or a dispatched skills_read counts once with its source and
 * session class; workspaceOnly leads with skills_read for a skill outside the
 * workspace; doctor reads "listing off, resolver live".
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';
import { openclawAgentPolicy, openclawCatalogName } from '../src/core/setup/openclaw-skill-plugin.ts';
import { runOpenclawCli } from '../src/core/setup/openclaw-turn-plugin.ts';

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
  "gateway call") [ -n "$SKILLS_STATUS_JSON" ] && { cat "$SKILLS_STATUS_JSON"; exit 0; }; echo '{"ok":false,"error":{"type":"gateway_transport_error"}}'; exit 1;;
  "skills info") [ -n "$SKILLS_INFO_DIR" ] && [ -f "$SKILLS_INFO_DIR/$3.json" ] && { cat "$SKILLS_INFO_DIR/$3.json"; exit 0; }; exit 1;;
  "skills list") [ -n "$SKILLS_LIST_STDERR" ] && echo "$SKILLS_LIST_STDERR" >&2; [ -n "$SKILLS_LIST_JSON" ] && { echo "[plugins] loaded"; cat "$SKILLS_LIST_JSON"; [ -n "$SKILLS_LIST_STDERR" ] && echo "$SKILLS_LIST_STDERR" >&2; exit 0; }; exit 1;;
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

/** Assert a setup run's exit code; a mismatch prints the run's stdout and stderr, so the failure names its cause. */
function expectExit(r: { exitCode: number; stdout: string; stderr: string }, code: number): void {
  expect(r.exitCode, `setup exited ${r.exitCode}, expected ${code}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`).toBe(code);
}

const calls = (b: Box) => (existsSync(b.calls) ? readFileSync(b.calls, 'utf8').trim().split('\n').filter((l) => l.includes('gbrain-skill-resolver')) : []);
const gbrainHome = (b: Box) => join(b.home, '.gbrain');
const statePath = (b: Box) => join(gbrainHome(b), 'openclaw-skill-resolver.json');
const pluginDir = (b: Box) => join(b.state, 'gbrain', 'gbrain-skill-resolver');
const readState = (b: Box) => JSON.parse(readFileSync(statePath(b), 'utf8'));
/** The ctx field OpenClaw sets on a turn from the agent's owner (with a native memory provider). */
const OWNER = { memoryAudience: { kind: 'owner-private', agentId: 'main' } };
const CONVERSATION = (sessionKey: string) => ({ memoryAudience: { kind: 'conversation', agentId: 'main', sessionKey, sessionId: sessionKey + '-id' } });

/**
 * Drive the generated plugin under Node with a fake OpenClaw api; each step is [kind, args]. Every hook
 * gets the event and ctx shape a real gateway sends (test/fixtures/openclaw-hook-events.json, captured
 * on OpenClaw 2026.11.5 and 2026.10.33): the turn's text in event.prompt, the session's earlier
 * messages in event.messages (empty on its first turn), and assertActive under ctx.hookInvocation.
 */
function drive(b: Box, steps: unknown[], nodeOptions?: string, env: Record<string, string> = {}): any {
  const script = join(b.root, 'drive.mjs');
  writeFileSync(script, String.raw`
import { pathToFileURL } from 'node:url';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir, statePath, stepsJson, fixturePath] = process.argv.slice(2);
const real = JSON.parse(readFileSync(fixturePath, 'utf8'));
const m = (await import(pathToFileURL(dir + '/index.js').href)).default;
const history = new Map();
let assertActiveCalls = 0;
const h = {};
m.register({ on: (e, f) => { h[e] = f; } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(500);
const out = [];
const logLineCount = () => { try { return readdirSync(process.env.DRIVE_LOG_DIR).filter((f) => f.startsWith('openclaw-')).reduce((n, f) => n + readFileSync(join(process.env.DRIVE_LOG_DIR, f), 'utf8').split('\n').filter(Boolean).length, 0); } catch { return 0; } };
const waitForLogLines = async (n) => { const deadline = Date.now() + 30_000; while (logLineCount() < n && Date.now() < deadline) await sleep(20); };
for (const [kind, a] of JSON.parse(stepsJson)) {
  const sessionKey = a.session || 'agent:main:s1';
  const ctx = { ...real.first_turn.ctx, runId: a.run || 'drive-' + out.length, sessionKey, inputProvenance: { kind: a.provenance || 'external_user' }, ...(a.sender ? { senderId: a.sender } : {}), ...(a.ctx || {}),
    hookInvocation: { assertActive: () => { assertActiveCalls += 1; if (a.inactive) throw new Error('run is no longer active'); } } };
  if (kind === 'turn') {
    const messages = history.get(sessionKey) || [];
    const got = await h.before_prompt_build({ prompt: a.text, messages: [...messages] }, ctx) ?? null;
    out.push(got);
    const [user, runtime, assistant] = real.second_turn.event.messages;
    history.set(sessionKey, [...messages, { ...user, content: a.carry && got && got.appendContext ? a.text + '\n\n' + got.appendContext : a.text }, runtime, assistant]);
  }
  else if (kind === 'tool') { h.after_tool_call({ ...a.event }, { ...real.after_tool_call.ctx, sessionKey, toolCallId: a.event.toolCallId, runId: a.event.runId }); out.push('tool'); }
  else if (kind === 'read') { h.after_tool_call({ ...real.after_tool_call.event, params: { name: a.name } }, { ...real.after_tool_call.ctx, sessionKey }); out.push('read'); }
  else if (kind === 'asserts') out.push(assertActiveCalls);
  else if (kind === 'compact') { h.after_compaction({}, ctx); out.push('compact'); }
  else if (kind === 'reset') { h.before_reset({ reason: 'new' }, ctx); out.push('reset'); }
  else if (kind === 'changed') { h.skill_changed({}, ctx); out.push('changed'); }
  else if (kind === 'state') { const s = JSON.parse(readFileSync(statePath, 'utf8')); Object.assign(s.agents.main, a); writeFileSync(statePath, JSON.stringify(s)); await sleep(20); out.push('state'); }
  else if (kind === 'sleep') { await sleep(a.ms); out.push('slept'); }
  else if (kind === 'logs') { await waitForLogLines(a.lines); out.push('logs'); }
}
await waitForLogLines(Number(process.env.DRIVE_LOG_LINES || 0));
await sleep(300);
console.log(JSON.stringify(out));
process.exit(0);
`);
  const r = Bun.spawnSync([NODE!, script, pluginDir(b), statePath(b), JSON.stringify(steps), join(import.meta.dir, 'fixtures', 'openclaw-hook-events.json')], { env: { PATH: b.env.PATH!, HOME: b.home, ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}), GBRAIN_TEST_OPENCLAW_SKILL_DEADLINE_MS: '2000', DRIVE_LOG_DIR: join(gbrainHome(b), 'skill-index', 'logs'), ...env }, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  const text = r.stdout.toString().trim().split('\n').at(-1) ?? '';
  try { return JSON.parse(text); } catch { throw new Error('drive failed: ' + r.stderr.toString() + text); }
}

function logLines(b: Box): any[] {
  const dir = join(gbrainHome(b), 'skill-index', 'logs');
  return readdirSync(dir).filter((f) => f.startsWith('openclaw-')).flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

describe.skipIf(!NODE)('gbrain setup openclaw --skill-loading', () => {
  test('a --skill-loading re-run that changes nothing runs none of the per-turn rule plugin\'s openclaw commands', async () => {
    const b = box();
    const turnCalls = () => (existsSync(b.calls) ? readFileSync(b.calls, 'utf8').trim().split('\n').filter((l) => l.includes('gbrain-turn-rule')) : []);
    expectExit(await setup(b, ['--skill-loading', 'resolve']), 0);
    const first = turnCalls();
    expect(first.slice(0, 3).map((l) => l.split(' ').slice(0, 2).join(' '))).toEqual(['plugins install', 'plugins enable', 'config set']);
    const all = readFileSync(b.calls, 'utf8');
    const again = await setup(b, ['--skill-loading', 'resolve']);
    expectExit(again, 0);
    expect(turnCalls()).toEqual(first);
    expect(again.doc.turn_hook).toMatchObject({ action: 'keep', unchanged: true });
    expect(again.doc.turn_hook_check).toBeUndefined();
    expect(readFileSync(b.calls, 'utf8').slice(all.length).split('\n').filter((l) => l && !l.startsWith('skills list') && !l.startsWith('gateway call skills.status'))).toEqual([]);
  });

  test('loading the entry file alone, as openclaw plugins inspect --runtime does from a copy without worker.js, logs no worker crash', async () => {
    const b = box();
    expectExit(await setup(b, ['--skill-loading', 'resolve']), 0);
    const copy = join(b.root, 'capture');
    mkdirSync(copy);
    writeFileSync(join(copy, 'index.js'), readFileSync(join(pluginDir(b), 'index.js'), 'utf8'));
    const script = "import(process.argv[1]).then((m) => { m.default.register({ on() {} }); setTimeout(() => process.exit(0), 1500) });";
    const r = Bun.spawnSync([NODE!, '--input-type', 'module', '-e', script, join(copy, 'index.js')], { env: { PATH: b.env.PATH!, HOME: b.home }, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    const dir = join(gbrainHome(b), 'skill-index', 'logs');
    expect(existsSync(dir) ? logLines(b).filter((l) => l.code === 'skill_resolver_worker_crash') : []).toEqual([]);
  });

  test('shadow installs once; a flip to live runs no OpenClaw command and keeps the plugin files', async () => {
    const b = box();
    const first = await setup(b, ['--skill-loading', 'shadow']);
    expectExit(first, 0);
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
    expectExit(flip, 0);
    expect(calls(b).length).toBe(before);
    expect(flip.resolver.steps.find((s: any) => s.step === 'install')).toMatchObject({ action: 'skip' });
    expect(readFileSync(join(pluginDir(b), 'index.js'), 'utf8')).toBe(index);
    expect(readState(b).agents.main).toMatchObject({ mode: 'live', live_fraction: 0.5 });
    expect((Bun.spawnSync(['stat', '-c', '%a', statePath(b)]).stdout.toString().trim())).toBe('600');
  });

  test('no openclaw on PATH: exit 3, skill_resolver_plugin_not_installed, the commands still to run', async () => {
    const b = box({ openclaw: false });
    const r = await setup(b, ['--skill-loading', 'resolve']);
    expectExit(r, 3);
    expect(r.resolver.error.code).toBe('skill_resolver_plugin_not_installed');
    expect(r.resolver.error.commands).toHaveLength(3);
    expect(r.resolver.error.recovery).toContain('0 of 3 commands ran');
    expect(existsSync(join(pluginDir(b), 'index.js'))).toBe(true);
    expect(existsSync(statePath(b))).toBe(true);
  });

  test('a failed openclaw step: exit 3 naming it, with only the remaining commands', async () => {
    const b = box();
    const r = await setup(b, ['--skill-loading', 'resolve'], { FAIL_STEP: 'plugins enable' });
    expectExit(r, 3);
    expect(r.resolver.error.code).toBe('skill_resolver_plugin_not_installed');
    expect(r.resolver.error.message).toContain('boom: plugins enable failed');
    expect(r.resolver.error.commands).toEqual(['openclaw plugins enable gbrain-skill-resolver', 'openclaw config set plugins.entries.gbrain-skill-resolver.hooks.allowConversationAccess true'].map((c) => join(b.root, 'bin') + '/' + c));
    expect(r.resolver.error.recovery).toContain('1 of 3 commands ran');
  });

  test('an openclaw call killed at its timeout says so, so the refusal names the stall', () => {
    const hung = runOpenclawCli(['sh', '-c', 'echo started; exec sleep 5'], 500);
    expect(hung).toMatchObject({ ok: false, stdout: 'started\n' });
    expect(hung.output.split('\n').at(-1)).toBe('timed out after 0.5 s');
    expect(runOpenclawCli(['sh', '-c', 'echo done'], 5_000)).toEqual({ ok: true, output: 'done', stdout: 'done\n' });
  });

  test('plugins inspect not showing it loaded: exit 3, never success', async () => {
    const b = box();
    const r = await setup(b, ['--skill-loading', 'resolve'], { INSPECT_BROKEN: '1' });
    expectExit(r, 3);
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
    expectExit(await setup(b, ['--skill-loading', 'resolve']), 0);
    expect(readState(b).agents.main).toMatchObject({ top_k: 2, min_match: 'description', exclude_ids: ['email-triage'] });
    const out = drive(b, [['turn', { text: 'deploy the service to production and triage the email inbox' }]]);
    expect(out[0].appendContext).toContain('deploy-service');
    expect(out[0].appendContext).not.toContain('email-triage');
  });

  test('skills.resolver.top_gate reaches the plugin: a gate of 100 empties the block, and a gate of 0 (the opt-out) is kept and shows a weak match the default gate hides', async () => {
    const b = box();
    mkdirSync(gbrainHome(b), { recursive: true });
    writeFileSync(join(gbrainHome(b), 'config.json'), JSON.stringify({ skills: { resolver: { per_harness: { openclaw: { top_gate: 100 } } } } }));
    expectExit(await setup(b, ['--skill-loading', 'resolve']), 0);
    expect(readState(b).agents.main).toMatchObject({ top_gate: 100 });
    const out = drive(b, [['turn', { text: 'deploy the service to production' }]]);
    expect(out[0]?.appendContext ?? '').not.toContain('deploy-service');

    const off = box();
    mkdirSync(gbrainHome(off), { recursive: true });
    writeFileSync(join(gbrainHome(off), 'config.json'), JSON.stringify({ skills: { resolver: { top_gate: 0 } } }));
    expectExit(await setup(off, ['--skill-loading', 'resolve']), 0);
    expect(readState(off).agents.main).toMatchObject({ top_gate: 0 });
    const weak = 'what runs in production today';
    const shown = drive(off, [['turn', { text: weak }]]);
    expect(shown[0]?.appendContext ?? '').toContain('deploy-service');

    const dflt = box();
    expectExit(await setup(dflt, ['--skill-loading', 'resolve']), 0);
    expect(readState(dflt).agents.main.top_gate).toBeUndefined();
    const gated = drive(dflt, [['turn', { text: weak }]]);
    expect(gated[0]?.appendContext ?? '').not.toContain('deploy-service');
  });

  test('the setup self-test checks that a turn resolves, not that it beats a live turn\'s deadline (a slow machine still installs)', async () => {
    const b = box();
    const r = await setup(b, ['--skill-loading', 'resolve'], { GBRAIN_TEST_OPENCLAW_SKILL_DEADLINE_MS: '1' });
    expectExit(r, 0);
    expect(r.resolver.steps.map((s: { step: string }) => s.step)).toContain('self-test');
  });

  test('--dry-run writes nothing', async () => {
    const b = box();
    const r = await setup(b, ['--skill-loading', 'resolve', '--dry-run']);
    expectExit(r, 0);
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

describe.skipIf(!NODE)('the OpenClaw eligibility filter', () => {
  const listed = (b: Box, skills: object[]) => { const f = join(b.root, 'skills-list.json'); writeFileSync(f, JSON.stringify({ workspaceDir: join(b.state, 'workspace'), skills })); return { SKILLS_LIST_JSON: f }; };

  test('a skill OpenClaw hides from the agent, or does not list, goes into exclude_ids and is never suggested', async () => {
    const b = box();
    const env = listed(b, [
      { name: 'deploy-service', eligible: true, disabled: false, blockedByAgentFilter: false },
      { name: 'email-triage', eligible: true, disabled: false, blockedByAgentFilter: true, modelVisible: false },
      { name: 'weather', eligible: false, modelVisible: false },
    ]);
    const r = await setup(b, ['--skill-loading', 'resolve'], env);
    expectExit(r, 0);
    expect([...readState(b).agents.main.exclude_ids].sort()).toEqual(['calendar-sync', 'email-triage']);
    expect(r.resolver.agents[0]).toMatchObject({ id: 'main', skills: 1 });
    const notes = r.resolver.notes.join('\n');
    expect(notes).toContain('hides from this agent' + "'" + 's model');
    expect(notes).toContain('email-triage');
    expect(notes).toMatch(/does not list 1 of openclaw-main's skills.*calendar-sync.*skill_resolver_host_load_cut/);
    const out = drive(b, [['turn', { text: 'deploy the service to production, triage the email inbox and sync the calendar' }]]);
    expect(out[0].appendContext).toContain('deploy-service');
    expect(out[0].appendContext).not.toContain('email-triage');
    expect(out[0].appendContext).not.toContain('calendar-sync');
  });

  test('OpenClaw writing to stderr does not turn a successful list into a failed one', async () => {
    const b = box();
    const env = { ...listed(b, [
      { name: 'deploy-service', eligible: true, modelVisible: true },
      { name: 'email-triage', eligible: true, modelVisible: false },
    ]), SKILLS_LIST_STDERR: '[openclaw] Compile cache unavailable; continuing without it.' };
    const r = await setup(b, ['--skill-loading', 'resolve'], env);
    expectExit(r, 0);
    expect([...readState(b).agents.main.exclude_ids].sort()).toEqual(['calendar-sync', 'email-triage']);
    const notes = r.resolver.notes.join('\n');
    expect(notes).not.toContain('failed, so skills OpenClaw hides');
    expect(notes).toContain('skill_resolver_host_load_cut');
  });

  test('a list naming none of the catalog' + "'" + 's skills filters nothing and says so', async () => {
    const b = box();
    const r = await setup(b, ['--skill-loading', 'resolve'], listed(b, [{ name: 'weather', eligible: true, modelVisible: true }]));
    expectExit(r, 0);
    expect(readState(b).agents.main.exclude_ids).toEqual([]);
    expect(r.resolver.agents[0].skills).toBe(3);
    expect(r.resolver.notes.join('\n')).toContain('lists none of openclaw-main' + "'" + 's skills for this agent, so the catalog was not filtered');
  });

  test('when OpenClaw does not answer, a refresh keeps the skills it hid last time out of suggestions and pins', async () => {
    const b = box();
    const env = listed(b, ['deploy-service', 'email-triage', 'calendar-sync'].map((name) => ({ name, eligible: true, modelVisible: name !== 'email-triage' })));
    expectExit(await setup(b, ['--skill-loading', 'resolve'], env), 0);
    expect(readState(b).agents.main.exclude_ids).toEqual(['email-triage']);
    expect((await runCli(['skills', 'pin', 'add', 'email-triage', '--catalog', 'openclaw-main'], { env: b.env })).exitCode).toBe(0);
    expect(readState(b).agents.main.pinned_ids).toEqual([]);
    const r = await setup(b, ['--skill-loading', 'resolve']);
    expectExit(r, 0);
    expect(readState(b).agents.main).toMatchObject({ exclude_ids: ['email-triage'], host_hidden: ['email-triage'], pinned_ids: [] });
    expect(r.resolver.notes.join('\n')).toContain('OpenClaw did not answer, so the 1 skill(s) it hid from this agent last time stay hidden: email-triage');
    expect((await runCli(['skills', 'pin', 'add', 'deploy-service', '--catalog', 'openclaw-main'], { env: b.env })).exitCode).toBe(0);
    expect(readState(b).agents.main.pinned_ids).toEqual(['deploy-service']);
    const out = drive(b, [['turn', { text: 'triage the email inbox' }]]);
    expect(JSON.stringify(out[0] ?? {})).not.toContain('email-triage');
  });

  test('a failed list, or no openclaw on PATH, filters nothing', async () => {
    const b = box();
    const r = await setup(b, ['--skill-loading', 'resolve']);
    expectExit(r, 0);
    expect(readState(b).agents.main.exclude_ids).toEqual([]);
    expect(r.resolver.notes.join('\n')).toContain('--agent main' + String.fromCharCode(96) + ' failed, so skills OpenClaw hides from this agent were not filtered');
    const none = box({ openclaw: false });
    expectExit(await setup(none, ['--skill-loading', 'resolve']), 3);
    expect(readState(none).agents.main.exclude_ids).toEqual([]);
  });
});

describe.skipIf(!NODE)('every skill source OpenClaw loads', () => {
  const ws = (b: Box) => join(b.state, 'workspace', 'skills');
  /** An extra dir (skills.load.extraDirs) holding a new skill and an older copy of a workspace skill, and a bundled root outside both. */
  function sources(b: Box, cfg: Record<string, unknown> = {}): { extra: string; bundled: string } {
    const extra = join(b.root, 'extra'), bundled = join(b.root, 'oc-pkg', 'skills');
    skill(extra, 'invoice-maker', 'Use when you create and send a customer invoice');
    skill(extra, 'deploy-service', 'An older extra copy of the deploy skill');
    skill(bundled, 'weather-report', 'Use when you check the weather forecast');
    writeFileSync(join(b.state, 'openclaw.json'), JSON.stringify({ skills: { load: { extraDirs: [extra] } }, ...cfg }));
    return { extra, bundled };
  }
  const entry = (name: string, source: string, filePath: string) => ({ name, source, filePath, baseDir: join(filePath, '..'), eligible: true, modelVisible: true });
  function status(b: Box, skills: object[]): Record<string, string> {
    const f = join(b.root, 'status.json');
    writeFileSync(f, JSON.stringify({ workspaceDir: join(b.state, 'workspace'), managedSkillsDir: join(b.state, 'skills'), agentId: 'main', skills }));
    return { SKILLS_STATUS_JSON: f };
  }
  const hostEntries = (b: Box, s: { extra: string; bundled: string }, deployFrom = ws(b)) => [
    entry('deploy-service', deployFrom === ws(b) ? 'openclaw-workspace' : 'openclaw-extra', join(deployFrom, 'deploy-service', 'SKILL.md')),
    ...['email-triage', 'calendar-sync'].map((n) => entry(n, 'openclaw-workspace', join(ws(b), n, 'SKILL.md'))),
    entry('invoice-maker', 'openclaw-extra', join(s.extra, 'invoice-maker', 'SKILL.md')),
    entry('weather-report', 'openclaw-bundled', join(s.bundled, 'weather-report', 'SKILL.md')),
  ];

  test("the gateway's skills.status: extra and bundled skills are indexed, OpenClaw's precedence keeps the workspace copy, and the state records roots, paths and the gbrain home", async () => {
    const b = box();
    const s = sources(b);
    const r = await setup(b, ['--skill-loading', 'resolve'], status(b, hostEntries(b, s)));
    expectExit(r, 0);
    const st = readState(b);
    expect(st.gbrain_home).toBe(gbrainHome(b));
    const a = st.agents.main;
    expect(a.skill_roots.map((x: any) => x.source)).toEqual(['openclaw-workspace', 'openclaw-bundled', 'openclaw-extra']);
    expect(a.skill_dirs).toEqual(a.skill_roots.map((x: any) => x.dir));
    expect(a.skill_files['deploy-service']).toBe(realpathSync(join(ws(b), 'deploy-service', 'SKILL.md')));
    expect(a.skill_files['invoice-maker']).toBe(realpathSync(join(s.extra, 'invoice-maker', 'SKILL.md')));
    expect(a.exclude_ids).toEqual([]);
    expect(r.resolver.agents[0]).toMatchObject({ skills: 5, sources: { 'openclaw-workspace': 3, 'openclaw-bundled': 1, 'openclaw-extra': 1 } });
    const made = readFileSync(b.calls, 'utf8');
    expect(made).toContain('gateway call skills.status --params {"agentId":"main"} --json');
    expect(made).not.toContain('skills info');
    expect(drive(b, [['turn', { text: 'create and send a customer invoice' }]])[0].appendContext).toContain('invoice-maker');
  });

  test('without a gateway: skills list, plus one skills info for a source whose folder is unknown; extraDirs need none', async () => {
    const b = box();
    const s = sources(b);
    skill(s.bundled, 'sun-dial', 'Use when you read a sundial');
    const listF = join(b.root, 'list.json');
    writeFileSync(listF, JSON.stringify({ workspaceDir: join(b.state, 'workspace'), managedSkillsDir: join(b.state, 'skills'), skills: [
      ...['deploy-service', 'email-triage', 'calendar-sync'].map((name) => ({ name, source: 'openclaw-workspace', modelVisible: true })),
      { name: 'invoice-maker', source: 'openclaw-extra', modelVisible: true }, { name: 'weather-report', source: 'openclaw-bundled', modelVisible: true }, { name: 'sun-dial', source: 'openclaw-bundled', modelVisible: true },
    ] }));
    const info = join(b.root, 'info');
    mkdirSync(info);
    writeFileSync(join(info, 'weather-report.json'), JSON.stringify({ name: 'weather-report', source: 'openclaw-bundled', filePath: join(s.bundled, 'weather-report', 'SKILL.md') }));
    const r = await setup(b, ['--skill-loading', 'resolve'], { SKILLS_LIST_JSON: listF, SKILLS_INFO_DIR: info });
    expectExit(r, 0);
    const a = readState(b).agents.main;
    expect(a.skill_roots.map((x: any) => x.source)).toEqual(['openclaw-workspace', 'openclaw-bundled', 'openclaw-extra']);
    expect(Object.keys(a.skill_files).sort()).toEqual(['calendar-sync', 'deploy-service', 'email-triage', 'invoice-maker', 'sun-dial', 'weather-report']);
    expect(readFileSync(b.calls, 'utf8').split('\n').filter((l) => l.startsWith('skills info'))).toEqual(['skills info weather-report --json --agent main']);
  });

  test('a skill folder symlinked into the workspace (gstack-style install) is the copy OpenClaw loads, so it stays suggestible', async () => {
    const b = box();
    const s = sources(b);
    const checkout = join(b.root, 'checkout');
    skill(checkout, 'notes-sync', 'Use when you sync meeting notes to the shared drive');
    symlinkSync(join(checkout, 'notes-sync'), join(ws(b), 'notes-sync'));
    const r = await setup(b, ['--skill-loading', 'resolve'], status(b, [...hostEntries(b, s), entry('notes-sync', 'openclaw-workspace', realpathSync(join(checkout, 'notes-sync', 'SKILL.md')))]));
    expectExit(r, 0);
    const a = readState(b).agents.main;
    expect(a.exclude_ids).toEqual([]);
    expect(drive(b, [['turn', { text: 'sync meeting notes to the shared drive' }]])[0].appendContext).toContain('notes-sync');
  });

  test('a skill whose loaded copy is not the one the catalog holds is never suggested, and setup says so', async () => {
    const b = box();
    const s = sources(b);
    const r = await setup(b, ['--skill-loading', 'resolve'], status(b, hostEntries(b, s, s.extra)));
    expectExit(r, 0);
    expect(readState(b).agents.main.exclude_ids).toEqual(['deploy-service']);
    expect(r.resolver.notes.join('\n')).toContain('OpenClaw loads a different copy than openclaw-main holds');
  });

  test('a read of a catalog SKILL.md path counts as a read of that skill, a dispatched call counts once, and every line names the session class and the source', async () => {
    const b = box();
    sources(b);
    expectExit(await setup(b, ['--skill-loading', 'resolve']), 0);
    const path = readState(b).agents.main.skill_files['invoice-maker'];
    drive(b, [
      ['turn', { text: 'create and send a customer invoice', session: 'agent:main:r1' }],
      ['tool', { session: 'agent:main:r1', event: { toolName: 'read', params: { path }, runId: 'r1', toolCallId: 'call_1' } }],
      ['tool', { session: 'agent:main:r1', event: { toolName: 'skills_read', params: { name: 'deploy-service' }, runId: 'r1', toolCallId: 'tool_call:call_2:skills_read:1' } }],
      ['tool', { session: 'agent:main:r1', event: { toolName: 'dispatch_action', params: { id: 'skills_read', args: { name: 'deploy-service' } }, runId: 'r1', toolCallId: 'call_2' } }],
      ['tool', { session: 'agent:main:r1', event: { toolName: 'dispatch_action', params: { id: 'read', args: { path: join(b.root, 'notes.md') } }, runId: 'r1', toolCallId: 'call_3' } }],
      ['turn', { text: 'triage the email inbox', session: 'agent:main:r2', ctx: { memoryAudience: { kind: 'owner-private', agentId: 'main' } } }],
      ['turn', { text: 'triage the email inbox', session: 'agent:main:r3', ctx: { memoryAudience: { kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:r3', sessionId: 's3' }, channelContext: { chat: { id: '1', type: 'supergroup' } } } }],
      ['turn', { text: 'triage the email inbox', session: 'agent:main:r4', provenance: 'inter_session' }],
      ['turn', { text: 'triage the email inbox', session: 'agent:main:r5', ctx: { trigger: 'event' } }],
    ], undefined, { DRIVE_LOG_LINES: '7' });
    const lines = logLines(b);
    expect(lines.find((l) => l.outcome === 'suggested')).toMatchObject({ suggested: ['invoice-maker'], sources: ['openclaw-extra'], session_class: 'unknown' });
    expect(lines.filter((l) => l.outcome === 'read').map((l) => [l.skill, l.tool, l.via, l.source, l.suggested, l.session_class])).toEqual([
      ['invoice-maker', 'read', 'direct', 'openclaw-extra', true, 'unknown'],
      ['deploy-service', 'skills_read', 'dispatch', 'openclaw-workspace', false, 'unknown'],
    ]);
    expect(lines.filter((l) => l.outcome !== 'read').slice(1).map((l) => l.session_class)).toEqual(['owner', 'group', 'relay', 'webhook']);
    expect(JSON.stringify(lines)).not.toContain('customer invoice');
  });

  test('an agent kept to its workspace (tools.fs.workspaceOnly) gets skills_read first for a skill outside it, and the path first for one inside', async () => {
    const b = box();
    sources(b, { tools: { fs: { workspaceOnly: true } } });
    expectExit(await setup(b, ['--skill-loading', 'resolve']), 0);
    expect(readState(b).agents.main).toMatchObject({ path_reads: 'workspace', workspace_dir: realpathSync(join(b.state, 'workspace')) });
    const out = drive(b, [['turn', { text: 'create and send a customer invoice', session: 'agent:main:w1' }], ['turn', { text: 'triage the email inbox', session: 'agent:main:w2' }]]);
    expect(out[0].appendContext).toContain('invoice-maker');
    expect(out[0].appendContext).toContain('To use one, load it with skills_read({name})');
    expect(out[1].appendContext).toContain('email-triage');
    expect(out[1].appendContext).toContain('To use one, read the SKILL.md at its path with read before acting');
    expect((await runCli(['skills', 'pin', 'add', 'invoice-maker', '--catalog', 'openclaw-main'], { env: b.env })).exitCode).toBe(0);
    const pinned = readState(b).agents.main.pinned_block;
    expect(pinned).toContain('To use one, load it with skills_read({name})');
    expect(pinned).not.toContain('read the SKILL.md at its path');
  });

  test('listing off (maxSkillsPromptChars 0) with the resolver live: doctor reads "listing off, resolver live", splits counts by session class and source, names the gbrain home, and a load cut a path read still reaches does not warn', async () => {
    const b = box();
    sources(b, { agents: { entries: { main: { skillsLimits: { maxSkillsPromptChars: 0 } } } } });
    expectExit(await setup(b, ['--skill-loading', 'resolve']), 0);
    const path = readState(b).agents.main.skill_files['invoice-maker'];
    drive(b, [['turn', { text: 'create and send a customer invoice', session: 'agent:main:d1' }], ['tool', { session: 'agent:main:d1', event: { toolName: 'read', params: { path }, runId: 'd1', toolCallId: 'call_1' } }]], undefined, { DRIVE_LOG_LINES: '2' });
    const listF = join(b.root, 'list.json');
    writeFileSync(listF, JSON.stringify({ workspaceDir: join(b.state, 'workspace'), skills: ['deploy-service', 'calendar-sync', 'invoice-maker'].map((name) => ({ name, modelVisible: true })) }));
    const r = await runCli(['doctor', '--only', 'skill_resolver', '--json'], { env: { ...b.env, SKILLS_LIST_JSON: listF } });
    const check = JSON.parse(r.stdout).checks.find((c: any) => c.name === 'skill_resolver');
    expect(check.status).toBe('ok');
    expect(check.message).toContain('listing off, resolver live');
    const oc = check.details.openclaw;
    expect(oc.gbrain_home).toBe(gbrainHome(b));
    expect(oc.agents[0]).toMatchObject({ id: 'main', listing: 'off', path_reads: 'any', verdict: 'listing off, resolver live', host: { cut: ['email-triage'] } });
    expect(oc.recent.by_source['openclaw-extra']).toEqual({ suggested: 1, would_suggest: 0, reads: 1, reads_of_suggested: 1 });
    expect(oc.recent.by_session_class.unknown).toMatchObject({ turns: 1, suggested: 1, reads: 1, reads_of_suggested: 1 });
    expect(oc.recent.by_audience).toEqual({ unknown: 1 });
  });

  test('when OpenClaw does not answer, a refresh keeps the skill roots it reported last time instead of dropping their skills', async () => {
    const b = box();
    const s = sources(b);
    expectExit(await setup(b, ['--skill-loading', 'resolve'], status(b, hostEntries(b, s))), 0);
    expect(readState(b).agents.main.skill_roots).toContainEqual({ dir: realpathSync(s.bundled), source: 'openclaw-bundled' });
    const r = await setup(b, ['--skill-loading', 'resolve']);
    expectExit(r, 0);
    const st = readState(b).agents.main;
    expect(st.skill_roots).toContainEqual({ dir: realpathSync(s.bundled), source: 'openclaw-bundled' });
    expect(Object.keys(st.skill_files)).toContain('weather-report');
    expect(r.resolver.notes.join('\n')).toContain('OpenClaw did not answer, so the 1 skill root(s) it reported last time (openclaw-bundled) were kept');
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
    expectExit(off, 0);
    expect(existsSync(statePath(b))).toBe(false);
    expect(existsSync(pluginDir(b))).toBe(false);
    expect(calls(b).at(-1)).toBe('plugins uninstall gbrain-skill-resolver --force');
    const list = await runCli(['skills', 'pin', 'list', '--catalog', 'openclaw-main', '--json'], { env: b.env });
    expect(JSON.parse(list.stdout).pins).toEqual([{ name: 'deploy-service', line: 'Before any production deploy' }]);
  });
});

describe.skipIf(!NODE)('session classes and the session-start brief', () => {
  const ownerSkill = (b: Box) => {
    mkdirSync(join(b.state, 'workspace', 'skills', 'private-ledger'), { recursive: true });
    writeFileSync(join(b.state, 'workspace', 'skills', 'private-ledger', 'SKILL.md'), '---\nname: private-ledger\ndescription: Use when you review the private household ledger\naudience: owner\n---\nSteps.\n');
  };
  const pin = async (b: Box, name: string, ...extra: string[]) => expect((await runCli(['skills', 'pin', 'add', name, '--catalog', 'openclaw-main', ...extra], { env: b.env })).exitCode).toBe(0);

  test('with no memory audience the session key decides: main and an owner sender\'s DM are the owner\'s, a stranger on the shared main session is not, a group gets only conversation pins and no owner-only skill, relay, webhook and cron get nothing', async () => {
    const b = box();
    ownerSkill(b);
    expectExit(await setup(b, ['--skill-loading', 'resolve', '--owner-sender', 'owner-1']), 0);
    await pin(b, 'deploy-service');
    await pin(b, 'calendar-sync', '--class', 'conversation');
    expect(readState(b).agents.main).toMatchObject({ pinned_ids: ['deploy-service'], conversation_pinned_ids: ['calendar-sync'] });
    const text = 'review the private household ledger';
    const out = drive(b, [
      ['turn', { text, sender: 'owner-1', session: 'agent:main:main' }],
      ['turn', { text, sender: 'owner-1', session: 'agent:main:telegram:direct:owner-1' }],
      ['turn', { text, sender: 'owner-1', session: 'agent:main:telegram:group:-100' }],
      ['turn', { text, sender: 'owner-1', session: 'agent:main:relay-alice-example' }],
      ['turn', { text, sender: 'owner-1', session: 'hook:inbox' }],
      ['turn', { text, sender: 'owner-1', session: 'agent:main:cron:nightly:run:1' }],
      ['turn', { text, sender: 'stranger', session: 'agent:main:telegram:direct:stranger' }],
      ['turn', { text, sender: 'stranger', session: 'agent:main:main' }],
    ], undefined, { DRIVE_LOG_LINES: '8' });
    for (const i of [0, 1]) {
      expect(out[i].appendSystemContext).toContain('"deploy-service"');
      expect(out[i].appendSystemContext).not.toContain('"calendar-sync"');
      expect(out[i].appendContext).toContain('private-ledger');
    }
    expect(out[2].appendSystemContext).toContain('"calendar-sync"');
    expect(out[2].appendSystemContext).not.toContain('"deploy-service"');
    expect(out[2]?.appendContext ?? '').not.toContain('private-ledger');
    expect(out.slice(3, 6)).toEqual([null, null, null]);
    expect(out[6]).toEqual({ appendSystemContext: out[2].appendSystemContext });
    expect(out[7]).toEqual({ appendSystemContext: out[2].appendSystemContext });
    const lines = logLines(b);
    expect(lines.map((l) => [l.session_class, l.outcome])).toEqual([
      ['main', 'suggested'], ['owner', 'suggested'], ['group', expect.any(String)], ['relay', 'skipped_class'], ['webhook', 'skipped_class'], ['cron', 'skipped_class'], ['direct', 'skipped_sender'], ['direct', 'skipped_sender'],
    ]);
    expect(lines.every((l) => l.audience === 'unknown')).toBe(true);
  });

  test('pin --class refuses an unknown class, a catalog that is not OpenClaw\'s and pin remove, and writes nothing', async () => {
    const b = box();
    expectExit(await setup(b, ['--skill-loading', 'resolve']), 0);
    await pin(b, 'deploy-service');
    const before = readFileSync(join(gbrainHome(b), 'config.json'), 'utf8');
    for (const args of [
      ['skills', 'pin', 'add', 'calendar-sync', '--catalog', 'openclaw-main', '--class', 'bogus'],
      ['skills', 'pin', 'add', 'calendar-sync', '--catalog', 'openclaw-main', '--class', ''],
      ['skills', 'pin', 'add', 'calendar-sync', '--catalog', 'claude-code-user', '--class', 'owner'],
      ['skills', 'pin', 'remove', 'deploy-service', '--catalog', 'openclaw-main', '--class', 'owner'],
    ]) expect((await runCli(args, { env: b.env })).exitCode).toBe(2);
    expect(readFileSync(join(gbrainHome(b), 'config.json'), 'utf8')).toBe(before);
    expect((await setup(b, ['--skill-loading', 'resolve', '--suggest-in', ''])).exitCode).toBe(2);
  });

  test('with a memory audience a conversation never gets owner pins or owner-only skills, even on the main session key; --suggest-in owner leaves conversations their pins and no suggestions', async () => {
    const b = box();
    ownerSkill(b);
    expectExit(await setup(b, ['--skill-loading', 'resolve']), 0);
    await pin(b, 'deploy-service');
    await pin(b, 'calendar-sync', '--class', 'owner,conversation');
    const text = 'review the private household ledger';
    const out = drive(b, [
      ['turn', { text, session: 'agent:main:main', ctx: CONVERSATION('agent:main:main') }],
      ['turn', { text, session: 'agent:main:x1', ctx: OWNER }],
    ], undefined, { DRIVE_LOG_LINES: '2' });
    expect(out[0].appendSystemContext).toContain('"calendar-sync"');
    expect(out[0].appendSystemContext).not.toContain('"deploy-service"');
    expect(out[0]?.appendContext ?? '').not.toContain('private-ledger');
    expect(out[1].appendSystemContext).toContain('"deploy-service"');
    expect(out[1].appendSystemContext).toContain('"calendar-sync"');
    expect(out[1].appendContext).toContain('private-ledger');
    expect(logLines(b).map((l) => [l.session_class, l.audience])).toEqual([['conversation', 'host'], ['owner', 'host']]);
    expectExit(await setup(b, ['--skill-loading', 'resolve', '--suggest-in', 'owner']), 0);
    expect(readState(b).agents.main.suggest_classes).toEqual(['owner']);
    expectExit(await setup(b, ['--skill-loading', 'resolve']), 0);
    expect(readState(b).agents.main.suggest_classes).toEqual(['owner']);
    const group = drive(b, [['turn', { text: 'triage the email inbox', session: 'agent:main:telegram:group:-7', ctx: CONVERSATION('agent:main:telegram:group:-7') }]], undefined, { DRIVE_LOG_LINES: '3' });
    expect(group[0]).toEqual({ appendSystemContext: out[0].appendSystemContext });
    expect(logLines(b).at(-1)).toMatchObject({ session_class: 'group', outcome: 'skipped_class' });
    expect((await setup(b, ['--skill-loading', 'resolve', '--suggest-in', 'everyone'])).exitCode).toBe(2);
  });

  test('the session-start brief comes once per durable session: a gateway restart never repeats it, a retried attempt gets the same brief back only when its transcript lacks it, a new session id or a /new reset gets its own, a conversation never gets one', async () => {
    const b = box();
    expectExit(await setup(b, ['--skill-loading', 'resolve', '--pins-route', 'first_turn']), 0);
    await pin(b, 'deploy-service');
    const owner = (sessionId: string) => ({ ...OWNER, sessionId });
    const first = drive(b, [
      ['turn', { text: 'triage the email inbox', run: 'r1', ctx: owner('sess-a') }],
      ['turn', { text: 'triage the email inbox', run: 'r1', ctx: owner('sess-a') }],
      ['turn', { text: 'sync the calendar', run: 'r2', ctx: owner('sess-a') }],
      ['turn', { text: 'sync the calendar', run: 'r7', session: 'agent:main:s7', ctx: owner('sess-z'), carry: true }],
      ['turn', { text: 'sync the calendar', run: 'r7', session: 'agent:main:s7', ctx: owner('sess-z') }],
    ], undefined, { DRIVE_LOG_LINES: '5' });
    expect(first[0].appendContext).toContain('<pinned_skills>');
    expect((first[1].appendContext.match(/<pinned_skills>/g) ?? []).length).toBe(1);
    expect(first[2]?.appendContext ?? '').not.toContain('<pinned_skills>');
    expect(first[3].appendContext).toContain('<pinned_skills>');
    expect(first[4]?.appendContext ?? '').not.toContain('<pinned_skills>');
    const restarted = drive(b, [
      ['turn', { text: 'sync the calendar', run: 'r3', ctx: owner('sess-a') }],
      ['turn', { text: 'sync the calendar', run: 'r4', session: 'agent:main:s2', ctx: owner('sess-b') }],
      ['turn', { text: 'sync the calendar', run: 'r5', session: 'agent:main:telegram:group:-9', ctx: { ...CONVERSATION('agent:main:telegram:group:-9'), sessionId: 'sess-c' } }],
    ], undefined, { DRIVE_LOG_LINES: '8' });
    expect(restarted[0]?.appendContext ?? '').not.toContain('<pinned_skills>');
    expect(restarted[1].appendContext).toContain('<pinned_skills>');
    expect(JSON.stringify(restarted[2] ?? {})).not.toContain('<pinned_skills>');
    expect(logLines(b).filter((l) => l.brief).length).toBe(3);
    const reset = drive(b, [
      ['reset', { ctx: owner('sess-a') }],
      ['turn', { text: 'sync the calendar', run: 'r8', ctx: owner('sess-a') }],
    ], undefined, { DRIVE_LOG_LINES: '9' });
    expect(reset[1].appendContext).toContain('<pinned_skills>');
    const again = drive(b, [['turn', { text: 'sync the calendar', run: 'r9', ctx: owner('sess-a') }]], undefined, { DRIVE_LOG_LINES: '10' });
    expect(again[0]?.appendContext ?? '').not.toContain('<pinned_skills>');
    expect(logLines(b).filter((l) => l.brief).length).toBe(4);
    const ledger = join(gbrainHome(b), 'openclaw-session-briefs.jsonl');
    expect(statSync(ledger).mode & 0o777).toBe(0o600);
    expect(readFileSync(ledger, 'utf8')).not.toContain('calendar');
  });

  test('with --owner-sender set, a turn on the shared main session that carries no sender id is a direct conversation: no owner pins, no owner-only skill', async () => {
    const b = box();
    ownerSkill(b);
    expectExit(await setup(b, ['--skill-loading', 'resolve', '--owner-sender', 'owner-1']), 0);
    await pin(b, 'deploy-service');
    const out = drive(b, [['turn', { text: 'review the private household ledger', session: 'agent:main:main' }]], undefined, { DRIVE_LOG_LINES: '1' });
    expect(JSON.stringify(out[0] ?? {})).not.toContain('deploy-service');
    expect(JSON.stringify(out[0] ?? {})).not.toContain('private-ledger');
    expect(logLines(b)[0]).toMatchObject({ session_class: 'direct', outcome: 'skipped_sender' });
  });

  test('a briefed first turn that times out is resolved on its retry, which carries the brief once', async () => {
    const b = box();
    expectExit(await setup(b, ['--skill-loading', 'resolve', '--pins-route', 'first_turn']), 0);
    await pin(b, 'deploy-service');
    const st = readState(b);
    const real = join(gbrainHome(b), 'lib', st.library_sha256 + '.mjs');
    const slow = 'import * as real from ' + JSON.stringify('file://' + real) + ';\nlet n = 0;\nexport const GBRAIN_VERSION = real.GBRAIN_VERSION;\nexport async function resolveSkills(input, opts) { if (n++ === 0) await new Promise((r) => setTimeout(r, 2600)); return real.resolveSkills(input, opts); }\nexport const commitSessionAsync = real.commitSessionAsync;\nexport const buildSkillIndex = real.buildSkillIndex;\n';
    const sha = createHash('sha256').update(slow).digest('hex');
    writeFileSync(join(gbrainHome(b), 'lib', sha + '.mjs'), slow, { mode: 0o644 });
    st.library_sha256 = sha;
    writeFileSync(statePath(b), JSON.stringify(st));
    const ctx = { ...OWNER, sessionId: 'sess-t' };
    const out = drive(b, [
      ['turn', { text: 'triage the email inbox', run: 'r1', ctx }],
      ['sleep', { ms: 1000 }],
      ['turn', { text: 'triage the email inbox', run: 'r1', ctx }],
    ], undefined, { DRIVE_LOG_LINES: '2' });
    expect(out[0].appendContext).toContain('<pinned_skills>');
    expect(out[0].appendContext).not.toContain('<relevant_skills>');
    expect(out[2].appendContext).toContain('email-triage');
    expect((out[2].appendContext.match(/<pinned_skills>/g) ?? []).length).toBe(1);
    const lines = logLines(b);
    expect(lines.map((l) => l.code ?? l.outcome)).toEqual(['skill_resolve_timeout', 'suggested']);
  });

  test('the brief ledger compacts across gateway restarts: lines from earlier runs count toward the rewrite', async () => {
    const b = box();
    expectExit(await setup(b, ['--skill-loading', 'resolve', '--pins-route', 'first_turn']), 0);
    await pin(b, 'deploy-service');
    const ledger = join(gbrainHome(b), 'openclaw-session-briefs.jsonl');
    writeFileSync(ledger, (JSON.stringify({ k: 'main\0old' }) + '\n').repeat(4999), { mode: 0o600 });
    const out = drive(b, [['turn', { text: 'sync the calendar', ctx: { ...OWNER, sessionId: 'sess-new' } }]], undefined, { DRIVE_LOG_LINES: '1' });
    expect(out[0].appendContext).toContain('<pinned_skills>');
    const keys = readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l).k);
    expect(keys).toEqual(['main\0old', 'main\0sess-new']);
  });

  test('pin add --line keeps the classes a pin already has; --class owner sets them back', async () => {
    const b = box();
    expectExit(await setup(b, ['--skill-loading', 'resolve']), 0);
    await pin(b, 'calendar-sync', '--class', 'conversation');
    await pin(b, 'calendar-sync', '--line', 'When the calendar drifts');
    expect(readState(b).agents.main).toMatchObject({ pinned_ids: [], conversation_pinned_ids: ['calendar-sync'] });
    const list = await runCli(['skills', 'pin', 'list', '--catalog', 'openclaw-main', '--json'], { env: b.env });
    expect(JSON.parse(list.stdout).pins).toEqual([{ name: 'calendar-sync', line: 'When the calendar drifts', classes: ['conversation'] }]);
    await pin(b, 'calendar-sync', '--class', 'owner');
    expect(readState(b).agents.main).toMatchObject({ pinned_ids: ['calendar-sync'], conversation_pinned_ids: [] });
  });

  test('after a catalog rebuild, conversation pins are withheld until a refresh renders them again, so a pin later marked audience: owner never reaches a group; a failed refresh is retried', async () => {
    const b = box();
    expectExit(await setup(b, ['--skill-loading', 'resolve']), 0);
    await pin(b, 'calendar-sync', '--class', 'conversation');
    await pin(b, 'email-triage', '--class', 'conversation');
    const group = { session: 'agent:main:telegram:group:-5', ctx: CONVERSATION('agent:main:telegram:group:-5') };
    const first = drive(b, [['turn', { text: 'deploy the service', ...group }]], undefined, { DRIVE_LOG_LINES: '1' });
    expect(first[0].appendSystemContext).toContain('"calendar-sync"');
    const dir = join(b.state, 'workspace', 'skills');
    writeFileSync(join(dir, 'calendar-sync', 'SKILL.md'), '---\nname: calendar-sync\ndescription: Use when you sync the calendar\naudience: owner\n---\nSteps.\n');
    expect((await runCli(['skills', 'index', 'build', '--catalog', 'openclaw-main', '--dir', dir, '--harness', 'openclaw'], { env: b.env })).exitCode).toBe(0);
    const bin = readFileSync(b.bin, 'utf8');
    writeFileSync(b.bin, '#!/bin/sh\nexit 1\n');
    const stale = drive(b, [
      ['turn', { text: 'deploy the service', ...group }],
      ['sleep', { ms: 1500 }],
      ['turn', { text: 'deploy the service now', ...group }],
    ], undefined, { GBRAIN_TEST_OPENCLAW_SKILL_REFRESH_MS: '1000', DRIVE_LOG_LINES: '5' });
    expect(JSON.stringify(stale[0] ?? {})).not.toContain('calendar-sync');
    expect(JSON.stringify(stale[2] ?? {})).not.toContain('calendar-sync');
    const lines = logLines(b).slice(1);
    expect(lines.filter((l) => l.pins_stale).length).toBe(2);
    expect(lines.filter((l) => l.outcome === 'refreshed').map((l) => l.code)).toEqual(['skill_resolver_refresh_failed', 'skill_resolver_refresh_failed']);
    writeFileSync(b.bin, bin);
    expectExit(await setup(b, ['--skill-loading', 'resolve']), 0);
    expect(readState(b).agents.main.conversation_pinned_ids).toEqual(['email-triage']);
    const after = drive(b, [['turn', { text: 'deploy the service', ...group }]], undefined, { DRIVE_LOG_LINES: '6' });
    expect(after[0].appendSystemContext).toContain('"email-triage"');
    expect(after[0].appendSystemContext).not.toContain('calendar-sync');
    expect(logLines(b).at(-1).pins_stale).toBeUndefined();
  });

  test('a pinned skill OpenClaw hides from the agent is left out of the block and setup names it', async () => {
    const b = box();
    expectExit(await setup(b, ['--skill-loading', 'resolve']), 0);
    await pin(b, 'email-triage');
    const f = join(b.root, 'list.json');
    writeFileSync(f, JSON.stringify({ workspaceDir: join(b.state, 'workspace'), skills: ['deploy-service', 'email-triage', 'calendar-sync'].map((name) => ({ name, modelVisible: name !== 'email-triage' })) }));
    const r = await setup(b, ['--skill-loading', 'resolve'], { SKILLS_LIST_JSON: f });
    expectExit(r, 0);
    expect(readState(b).agents.main).toMatchObject({ pinned_ids: [], pinned_block: '' });
    expect(r.resolver.notes.join('\n')).toContain('email-triage (skill_resolver_pin_withheld)');
  });

  test('a sandboxed agent (sandbox.mode) reads no host path: suggestions and pins lead with skills_read', async () => {
    const b = box();
    writeFileSync(join(b.state, 'openclaw.json'), JSON.stringify({ agents: { defaults: { sandbox: { mode: 'all' } } } }));
    expectExit(await setup(b, ['--skill-loading', 'resolve']), 0);
    expect(readState(b).agents.main.path_reads).toBe('none');
    await pin(b, 'deploy-service');
    expect(readState(b).agents.main.pinned_block).toContain('To use one, load it with skills_read({name})');
    const out = drive(b, [['turn', { text: 'triage the email inbox', ctx: OWNER }]]);
    expect(out[0].appendContext).toContain('To use one, load it with skills_read({name})');
    expect(out[0].appendContext).not.toContain('read the SKILL.md at its path');
  });

  test('a non-main agent kept to its workspace with no workspace entry reads only OpenClaw\'s default workspace for it, never any path', async () => {
    const b = box();
    writeFileSync(join(b.state, 'openclaw.json'), JSON.stringify({ agents: { list: [{ id: 'main', workspace: join(b.state, 'workspace') }, { id: 'ops' }] }, tools: { fs: { workspaceOnly: true } } }));
    await withEnv({ OPENCLAW_STATE_DIR: b.state, OPENCLAW_CONFIG_PATH: undefined, HOME: b.home }, () => {
      expect(openclawAgentPolicy('ops')).toMatchObject({ path_reads: 'workspace', workspace: join(b.state, 'workspace-ops') });
    });
  });

  test('after the worker rebuilds a catalog the plugin refreshes the state, so a skill OpenClaw now hides stops being suggested', async () => {
    const b = box();
    expectExit(await setup(b, ['--skill-loading', 'resolve']), 0);
    expect(readState(b).agents.main.exclude_ids).toEqual([]);
    const f = join(b.root, 'list.json');
    writeFileSync(f, JSON.stringify({ workspaceDir: join(b.state, 'workspace'), skills: ['deploy-service', 'email-triage', 'calendar-sync'].map((name) => ({ name, modelVisible: name !== 'calendar-sync' })) }));
    const env = { OPENCLAW_STATE_DIR: b.state, OPENCLAW_CALLS: b.calls, SKILLS_LIST_JSON: f, GBRAIN_HOME: b.home };
    drive(b, [['changed', {}], ['sleep', { ms: 200 }]], undefined, { ...env, DRIVE_LOG_LINES: '2' });
    const lines = logLines(b);
    expect(lines.map((l) => l.outcome)).toEqual(['rebuilt', 'refreshed']);
    expect(lines[1].code).toBeNull();
    expect(readState(b).agents.main.exclude_ids).toEqual(['calendar-sync']);
  });

  test('a second rebuild inside the refresh cooldown is not dropped: one trailing refresh runs after it', async () => {
    const b = box();
    expectExit(await setup(b, ['--skill-loading', 'resolve']), 0);
    const cooldownMs = 10_000;
    const env = { OPENCLAW_STATE_DIR: b.state, OPENCLAW_CALLS: b.calls, GBRAIN_HOME: b.home, GBRAIN_TEST_OPENCLAW_SKILL_REFRESH_MS: String(cooldownMs), GBRAIN_TEST_OPENCLAW_SKILL_REBUILD_MS: '1' };
    // The second rebuild waits for the first refresh to finish (its log line), not for a fixed sleep a slow refresh outlasts.
    drive(b, [['changed', {}], ['logs', { lines: 2 }], ['changed', {}]], undefined, { ...env, DRIVE_LOG_LINES: '4' });
    const lines = logLines(b);
    expect(lines.map((l) => l.outcome)).toEqual(['rebuilt', 'refreshed', 'rebuilt', 'refreshed']);
    const at = lines.map((l) => Date.parse(l.at));
    // The second rebuild landed inside the cooldown the first refresh started, and its refresh waited for the cooldown to end.
    expect(at[2]! - at[0]!).toBeLessThan(cooldownMs);
    expect(at[3]! - at[0]!).toBeGreaterThanOrEqual(cooldownMs);
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
  test('a retried attempt of the same run resolves nothing new: its own text gets the first block back, other text (OpenClaw\'s continuation) gets none', async () => {
    const b = box({ skills: 250 });
    await setup(b, ['--skill-loading', 'resolve']);
    const cont = 'Continue the current task from the existing transcript, preserving completed work and the user constraints.';
    const out = drive(b, [
      ['turn', { text: 'triage the email inbox', run: 'r1' }],
      ['turn', { text: cont, run: 'r1' }],
      ['turn', { text: 'filler task number 7 with nothing to match', run: 'r2', session: 'agent:main:s2' }],
      ['turn', { text: 'triage the email inbox', run: 'r2', session: 'agent:main:s2' }],
      ['turn', { text: 'triage the email inbox', run: 'r3', session: 'agent:main:s3' }],
    ], undefined, { DRIVE_LOG_LINES: '5' });
    expect(out[0].appendContext).toContain('email-triage');
    expect(out[1]?.appendContext ?? '').toBe('');
    expect(out[3]?.appendContext ?? '').toBe('');
    expect(out[4].appendContext).toContain('email-triage');
    expect(logLines(b).map((l) => l.outcome)).toEqual(['suggested', 'retry', out[2]?.appendContext ? 'suggested' : 'no_match', 'retry', 'suggested']);
  });

  test('a retried attempt whose transcript already carries the first attempt\'s block gets no second copy', async () => {
    const b = box({ skills: 250 });
    await setup(b, ['--skill-loading', 'resolve']);
    const out = drive(b, [
      ['turn', { text: 'triage the email inbox', run: 'r1', carry: true }],
      ['turn', { text: 'triage the email inbox', run: 'r1', carry: true }],
    ], undefined, { DRIVE_LOG_LINES: '2' });
    expect(out[0].appendContext).toContain('email-triage');
    expect(out[1]?.appendContext ?? '').toBe('');
    expect(logLines(b).map((l) => l.outcome)).toEqual(['suggested', 'retry']);
  });

  test('live: pins every owner turn, up to 3 suggestions, pinned never suggested, retry commits once; skips internal turns; shadow and off inject nothing', async () => {
    const b = box({ skills: 250 });
    await setup(b, ['--skill-loading', 'resolve']);
    await runCli(['skills', 'pin', 'add', 'deploy-service', '--catalog', 'openclaw-main'], { env: b.env });
    const out = drive(b, [
      ['turn', { text: 'deploy the service to production and triage the email inbox', run: 'r1', ctx: OWNER }],
      ['turn', { text: 'deploy the service to production and triage the email inbox', run: 'r1', ctx: OWNER }],
      ['turn', { text: 'sync the calendar', provenance: 'inter_session' }],
      ['turn', { text: 'filler task number 249', session: 'agent:main:s9' }],
      ['read', { name: 'email-triage' }],
      ['state', { mode: 'shadow' }],
      ['turn', { text: 'sync the calendar', session: 'agent:main:s2' }],
      ['state', { mode: 'off' }],
      ['turn', { text: 'sync the calendar', session: 'agent:main:s3' }],
    ], '--max-old-space-size=256', { DRIVE_LOG_LINES: '6' });
    expect(out[0].appendSystemContext).toContain('<pinned_skills>');
    expect(out[0].appendContext).toContain('<relevant_skills>');
    expect(out[0].appendContext).toContain('email-triage');
    expect(out[0].appendContext).not.toContain('"deploy-service"');
    expect((out[0].appendContext.match(/^- id:/gm) ?? []).length).toBeLessThanOrEqual(3);
    expect(out[1]).toEqual(out[0]);
    expect(out[2]).toBeNull();
    expect(out[3].appendContext).toContain('zz-filler-249');
    expect(out[3].appendSystemContext).toBeUndefined();
    expect(out[6]).toBeNull();
    expect(out[8]).toBeNull();
    const lines = logLines(b);
    expect(lines.map((l) => l.outcome)).toEqual(['suggested', 'retry', 'skipped_provenance', 'suggested', 'read', 'would_suggest']);
    expect(lines.find((l) => l.outcome === 'read')).toMatchObject({ skill: 'email-triage', suggested: true, pinned: false });
    expect(JSON.stringify(lines)).not.toContain('production');
    const sessions = readdirSync(join(gbrainHome(b), 'skill-index', 'sessions'));
    expect(sessions.length).toBeGreaterThan(0);
  });

  test('real OpenClaw event shape: the first turn is ranked, each later turn on its own message, in live and shadow', async () => {
    const b = box();
    await setup(b, ['--skill-loading', 'resolve']);
    const out = drive(b, [
      ['turn', { text: 'deploy the service to production' }],
      ['turn', { text: 'triage the email inbox' }],
      ['asserts', {}],
      ['state', { mode: 'shadow' }],
      ['turn', { text: 'sync the calendar', session: 'agent:main:s2' }],
      ['turn', { text: 'triage the email inbox', session: 'agent:main:s2' }],
    ], undefined, { DRIVE_LOG_LINES: '4' });
    expect(out[0].appendContext).toContain('"deploy-service"');
    expect(out[1].appendContext).toContain('"email-triage"');
    expect(out[1].appendContext).not.toContain('"deploy-service"');
    expect(out[2]).toBe(2);
    expect(out[4]).toBeNull();
    expect(out[5]).toBeNull();
    expect(logLines(b).map((l) => [l.outcome, l.suggested])).toEqual([
      ['suggested', ['deploy-service']], ['suggested', ['email-triage']], ['would_suggest', ['calendar-sync']], ['would_suggest', ['email-triage']],
    ]);
  });

  test('a turn whose run is no longer active (ctx.hookInvocation.assertActive throws) commits nothing to the session', async () => {
    const b = box();
    await setup(b, ['--skill-loading', 'resolve']);
    const sessions = () => { try { return readdirSync(join(gbrainHome(b), 'skill-index', 'sessions')).length; } catch { return 0; } };
    drive(b, [['turn', { text: 'triage the email inbox', inactive: true }]], undefined, { DRIVE_LOG_LINES: '1' });
    expect(sessions()).toBe(0);
    drive(b, [['turn', { text: 'triage the email inbox' }]], undefined, { DRIVE_LOG_LINES: '2' });
    expect(sessions()).toBe(1);
  });

  test('the daily log keeps event order when a skill read follows a turn at once', async () => {
    const b = box();
    await setup(b, ['--skill-loading', 'resolve']);
    const steps: unknown[] = [];
    const want: string[] = [];
    for (let i = 0; i < 4; i++) {
      steps.push(['turn', { text: 'triage the email inbox', session: 'agent:main:o' + i }]);
      want.push('suggested');
      for (let j = 0; j < 40; j++) { steps.push(['read', { name: 'skill-' + i + '-' + j }]); want.push('skill-' + i + '-' + j); }
    }
    drive(b, steps, undefined, { DRIVE_LOG_LINES: String(want.length) });
    expect(logLines(b).filter((l) => l.agent === 'main').map((l) => l.skill ?? l.outcome)).toEqual(want);
  });

  test('the description floor holds: body-only matches are never suggested', async () => {
    const b = box();
    const skills = join(b.state, 'workspace', 'skills');
    mkdirSync(join(skills, 'zeta-notes'), { recursive: true });
    writeFileSync(join(skills, 'zeta-notes', 'SKILL.md'), '---\nname: zeta-notes\ndescription: Use when you keep a journal\n---\nAlso covers quarterly xylophone tuning.\n');
    expectExit(await setup(b, ['--skill-loading', 'resolve']), 0);
    const out = drive(b, [
      ['turn', { text: 'xylophone tuning' }],
      ['turn', { text: 'triage the email inbox and the xylophone tuning', session: 'agent:main:s2' }],
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
      ['turn', { text: 'triage the email inbox', sender: 'owner-1', ctx: OWNER }],
      ['turn', { text: 'sync the calendar', sender: 'owner-1', ctx: OWNER }],
      ['turn', { text: 'sync the calendar', sender: 'stranger', session: 'agent:main:s5' }],
      ['compact', {}],
      ['turn', { text: 'sync the calendar please', sender: 'owner-1', ctx: OWNER }],
      ['state', { live_fraction: 0 }],
      ['turn', { text: 'triage the email inbox', sender: 'owner-1', session: 'agent:main:s6', ctx: OWNER }],
    ]);
    expect(out[0].appendSystemContext).toBeUndefined();
    expect(out[0].appendContext).toContain('<pinned_skills>');
    expect(out[0].appendContext).toContain('email-triage');
    expect(out[1].appendContext).not.toContain('<pinned_skills>');
    expect(out[2]).toBeNull();
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
      ['turn', { text: 'triage the email inbox' }],
      ['turn', { text: 'sync the calendar', sender: 'owner-1' }],
      ['state', { mode: 'shadow' }],
      ['turn', { text: 'sync the calendar', sender: 'owner-1' }],
      ['state', { mode: 'live', live_fraction: 0 }],
      ['turn', { text: 'sync the calendar', sender: 'owner-1' }],
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
    drive(b, [['turn', { text: 'triage the email inbox' }], ['sleep', { ms: 1500 }]], undefined, { GBRAIN_SKILL_LOADING: 'spring' });
    const lines = readFileSync(rec, 'utf8').trim().split('\n');
    expect(lines).toContain('skill_loading=[] setup openclaw --skills-index-only');
  });

  test('refuses a library writable by others, and survives a process-only NODE_OPTIONS flag', async () => {
    const b = box();
    await setup(b, ['--skill-loading', 'resolve']);
    const sha = readState(b).library_sha256;
    chmodSync(join(gbrainHome(b), 'lib', sha + '.mjs'), 0o666);
    const out = drive(b, [['turn', { text: 'triage the email inbox' }]], '--max-old-space-size=256 --title=gateway');
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
    drive(b, [1, 2, 3].map((i) => ['turn', { text: 'triage the email inbox ' + i }]), undefined, { GBRAIN_TEST_OPENCLAW_SKILL_DEADLINE_MS: '' });
    const outcomes = logLines(b).map((l) => l.code ?? l.outcome);
    expect(outcomes.filter((c) => c === 'skill_resolve_timeout').length).toBe(3);
    expect(outcomes).toContain('skill_resolver_worker_stuck');
    expect(logLines(b).filter((l) => l.outcome === 'timeout').every((l) => l.ms < 200)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(30_000);
  });
});

describe.skipIf(!NODE)('doctor skill_resolver: the OpenClaw plugin', () => {
  test('re-checks OpenClaw\'s skill list: a skill it no longer lists or now hides warns, its fix stops suggesting it without installing anything, and no OpenClaw config changes', async () => {
    const b = box();
    const list = (skills: object[]) => { const f = join(b.root, 'skills-list-' + Math.random().toString(36).slice(2) + '.json'); writeFileSync(f, JSON.stringify({ workspaceDir: join(b.state, 'workspace'), skills })); return { SKILLS_LIST_JSON: f }; };
    const all = ['deploy-service', 'email-triage', 'calendar-sync'].map((name) => ({ name, modelVisible: true }));
    expectExit(await setup(b, ['--skill-loading', 'resolve'], list(all)), 0);
    expect(readState(b).agents.main.exclude_ids).toEqual([]);
    const config = readFileSync(join(b.state, 'openclaw.json'), 'utf8');
    const before = readFileSync(b.calls, 'utf8');
    const doctor = async (env: Record<string, string>) => JSON.parse((await runCli(['doctor', '--only', 'skill_resolver', '--json'], { env: { ...b.env, ...env } })).stdout).checks.find((c: any) => c.name === 'skill_resolver');
    expect((await doctor(list(all))).status).toBe('ok');
    const cut = await doctor(list(all.filter((s) => s.name !== 'email-triage')));
    expect(cut).toMatchObject({ status: 'warn', details: { code: 'skill_resolver_host_load_cut' } });
    expect(cut.message).toContain('skills.limits.maxCandidatesPerRoot');
    expect(cut.message).toContain('skills.limits.maxSkillsLoadedPerSource');
    expect(cut.message).toContain('email-triage');
    expect(cut.fix.argv).toEqual(['gbrain', 'setup', 'openclaw', '--skills-index-only']);
    const hidden = await doctor(list(all.map((s) => (s.name === 'calendar-sync' ? { ...s, modelVisible: false } : s))));
    expect(hidden).toMatchObject({ status: 'warn', details: { code: 'skill_resolver_host_hidden' } });
    expect(hidden.message).toContain('calendar-sync');
    expect(hidden.fix.argv).toEqual(cut.fix.argv);
    const hiddenList = list(all.map((s) => (s.name === 'calendar-sync' ? { ...s, modelVisible: false } : s)));
    const turnRule = readFileSync(join(b.state, 'gbrain', 'gbrain-turn-rule', 'index.js'), 'utf8');
    const fixed = await runCli([...hidden.fix.argv.slice(1), '--gbrain-bin', b.bin], { env: { ...b.env, ...hiddenList } });
    expect(fixed.exitCode, fixed.stderr).toBe(0);
    expect(readState(b).agents.main.exclude_ids).toEqual(['calendar-sync']);
    expect((await doctor(hiddenList)).status).toBe('ok');
    expect(readFileSync(join(b.state, 'gbrain', 'gbrain-turn-rule', 'index.js'), 'utf8')).toBe(turnRule);
    expect(readFileSync(join(b.state, 'openclaw.json'), 'utf8')).toBe(config);
    expect(readFileSync(b.calls, 'utf8').slice(before.length).split('\n').filter((l) => l && !l.startsWith('skills list') && !l.startsWith('gateway call skills.status'))).toEqual([]);
  });

  test('reports the deadline-miss rate from the daily logs and warns above 5% once there are 20 turns', async () => {
    const b = box();
    expectExit(await setup(b, ['--skill-loading', 'shadow']), 0);
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

