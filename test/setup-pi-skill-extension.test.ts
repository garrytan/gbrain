/**
 * GBRA-435 PR 2: gbrain setup pi --skill-loading resolve|off and the generated
 * Pi extension gbrain-skill-resolver (src/core/setup/pi-skill-extension.ts,
 * pi-skill-extension-code.ts), plus its half of doctor's skill_resolver check.
 *
 * Protects: setup builds pi-user from $PI_CODING_AGENT_DIR/skills, writes the
 * library, state and extension, self-tests it under Node and, with pi on
 * PATH, proves Pi loads it (pi --help lists --gbrain-skill-resolver), or
 * exits 3; under Node the extension sends suggestions as one hidden message
 * with skill paths, puts the pins in a system prompt section on every run,
 * suggests nothing on custom runs, never suggests a pinned skill or one Pi
 * hides from the model, dedupes within a session until session_compact;
 * off removes it; a brainless home stays brainless.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

setDefaultTimeout(120_000);
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const NODE = Bun.which('node');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Box { root: string; home: string; agent: string; skills: string; bin: string; env: Record<string, string | undefined> }

function skill(dir: string, name: string, description: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + description + '\n---\nSteps.\n');
}

/** A fake pi: --help lists the extension's flag only when the extension file is where Pi loads it (and PI_NO_LOAD is unset). */
const FAKE_PI = '#!/bin/sh\necho "$*" >> "$PI_CALLS"\nif [ "$1" = "--help" ]; then echo "Usage: pi [options]"; [ -z "$PI_NO_LOAD" ] && [ -f "$PI_CODING_AGENT_DIR/extensions/gbrain-skill-resolver/index.js" ] && printf "Extension CLI Flags:\\n  --gbrain-skill-resolver   gbrain\\n"; fi\nexit 0\n';

function box(opts: { pi?: boolean; skills?: boolean } = {}): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-pi-skill-'));
  roots.push(root);
  const home = join(root, 'home'), agent = join(root, 'pi-agent'), binDir = join(root, 'bin');
  const skills = join(agent, 'skills');
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir);
  if (opts.skills !== false) {
    skill(skills, 'deploy-service', 'Use when you deploy a service to production');
    skill(skills, 'email-triage', 'Use when you triage the email inbox');
    skill(skills, 'calendar-sync', 'Use when you sync the calendar');
  } else mkdirSync(agent, { recursive: true });
  const bin = join(binDir, 'gbrain');
  writeFileSync(bin, '#!/bin/sh\nexec \'' + process.execPath + '\' --no-env-file \'' + CLI + '\' "$@"\n');
  chmodSync(bin, 0o755);
  if (opts.pi !== false) { writeFileSync(join(binDir, 'pi'), FAKE_PI); chmodSync(join(binDir, 'pi'), 0o755); }
  const path = [binDir, NODE ? join(NODE, '..') : '', '/usr/bin', '/bin'].filter(Boolean).join(':');
  return { root, home, agent, skills, bin, env: { HOME: home, GBRAIN_HOME: home, PI_CODING_AGENT_DIR: agent, PI_CALLS: join(root, 'pi-calls.log'), PATH: path, GBRAIN_SKILL_LOADING: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined } };
}

async function setup(b: Box, extra: string[], env: Record<string, string | undefined> = {}) {
  const r = await runCli(['setup', 'pi', '--gbrain-bin', b.bin, '--json', ...extra], { env: { ...b.env, ...env }, timeoutMs: 110_000 });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc, resolver: doc?.skill_resolver };
}

const gbrainHome = (b: Box) => join(b.home, '.gbrain');
const statePath = (b: Box) => join(gbrainHome(b), 'pi-skill-resolver.json');
const extDir = (b: Box) => join(b.agent, 'extensions', 'gbrain-skill-resolver');
const readState = (b: Box) => JSON.parse(readFileSync(statePath(b), 'utf8'));

/** Load the generated extension under Node with a fake Pi api and run the steps. */
function drive(b: Box, steps: unknown[]): any {
  const script = join(b.root, 'drive.mjs');
  writeFileSync(script, String.raw`
import { pathToFileURL } from 'node:url';
const [dir, stepsJson] = process.argv.slice(2);
const m = await import(pathToFileURL(dir + '/index.js').href);
const h = {};
const flags = [];
m.default({ on: (e, f) => { h[e] = f; }, registerFlag: (n) => flags.push(n) });
const out = [{ flags, events: Object.keys(h).sort() }];
for (const [kind, a] of JSON.parse(stepsJson)) {
  const ctx = { sessionManager: { getSessionId: () => a.session || 's1' } };
  if (kind === 'start') { await h.session_start({ type: 'session_start' }, ctx); out.push('started'); }
  else if (kind === 'run') {
    const event = { type: 'before_agent_start', messageType: a.custom ? 'custom' : 'user', ...(a.custom ? { message: { role: 'custom' } } : { prompt: a.prompt }), systemPromptOptions: { sections: {}, ...(a.skills ? { skills: a.skills } : {}) } };
    const r = await h.before_agent_start(event, ctx);
    out.push({ result: r ?? null, sections: event.systemPromptOptions.sections });
  }
  else if (kind === 'compact') { h.session_compact({ type: 'session_compact', reason: 'manual' }, ctx); out.push('compacted'); }
  else if (kind === 'flush') { await h.session_shutdown({ type: 'session_shutdown' }, ctx); out.push('flushed'); }
}
console.log(JSON.stringify(out));
process.exit(0);
`);
  const r = Bun.spawnSync([NODE!, script, extDir(b), JSON.stringify(steps)], { env: { PATH: b.env.PATH!, HOME: b.home, GBRAIN_TEST_PI_SKILL_DEADLINE_MS: '3000' }, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  const text = r.stdout.toString().trim().split('\n').at(-1) ?? '';
  try { return JSON.parse(text); } catch { throw new Error('drive failed: ' + r.stderr.toString() + text); }
}

describe.skipIf(!NODE)('gbrain setup pi --skill-loading', () => {
  test('resolve: catalog, library, state and extension, a self-test under Node and pi --help proving Pi loads it; a brainless home stays brainless', async () => {
    const b = box();
    const r = await setup(b, ['--skill-loading', 'resolve']);
    expect(r.exitCode).toBe(0);
    expect(r.resolver.error).toBeUndefined();
    expect(r.resolver.steps.map((s: any) => s.step)).toEqual(['catalog', 'library', 'state', 'extension', 'self-test', 'verify']);
    expect(r.resolver).toMatchObject({ mode: 'live', catalog: 'pi-user', skills: 3, pins: 0 });
    expect(r.resolver.notes.join('\n')).toContain('extensions off');
    const st = readState(b);
    expect(st).toMatchObject({ v: 1, mode: 'live', catalog: 'pi-user', skill_dirs: [b.skills], top_k: 3, min_match: 'description' });
    expect([...st.catalog_ids].sort()).toEqual(['calendar-sync', 'deploy-service', 'email-triage']);
    expect(existsSync(join(gbrainHome(b), 'lib', st.library_sha256 + '.mjs'))).toBe(true);
    for (const f of ['package.json', 'index.js', 'worker.js']) expect(existsSync(join(extDir(b), f))).toBe(true);
    expect(JSON.parse(readFileSync(join(extDir(b), 'package.json'), 'utf8'))).toMatchObject({ type: 'module', pi: { extensions: ['./index.js'] } });
    expect(readFileSync(join(extDir(b), 'worker.js'), 'utf8')).toContain("harness: 'pi' }");
    expect(readFileSync(join(b.root, 'pi-calls.log'), 'utf8')).toContain('--help');
    const cfg = existsSync(join(gbrainHome(b), 'config.json')) ? JSON.parse(readFileSync(join(gbrainHome(b), 'config.json'), 'utf8')) : {};
    expect(cfg.engine).toBeUndefined();
    expect(cfg.database_url).toBeUndefined();
    const again = await setup(b, []);
    expect(again.exitCode).toBe(0);
    expect(again.resolver.steps.find((s: any) => s.step === 'extension')).toMatchObject({ action: 'keep' });
  });

  test('the extension: one hidden message with paths, pins as a system section every run, nothing on custom runs, never a pinned or hidden skill, dedupe until session_compact', async () => {
    const b = box();
    expect((await setup(b, ['--skill-loading', 'resolve'])).exitCode).toBe(0);
    const pin = await runCli(['skills', 'pin', 'add', 'calendar-sync', '--catalog', 'pi-user', '--json'], { env: b.env });
    expect(pin.exitCode).toBe(0);
    expect(JSON.parse(pin.stdout)).toMatchObject({ rendered: ['calendar-sync'], pi_state_updated: true });
    expect(readState(b).pinned_ids).toEqual(['calendar-sync']);
    const loaded = [
      { name: 'deploy-service', disableModelInvocation: false },
      { name: 'email-triage', disableModelInvocation: true },
      { name: 'calendar-sync', disableModelInvocation: false },
    ];
    const prompt = 'deploy the service to production, triage the email inbox and sync the calendar';
    const out = drive(b, [['start', {}], ['run', { prompt, skills: loaded }], ['flush', {}], ['run', { prompt, skills: loaded }], ['run', { custom: true }], ['compact', {}], ['run', { prompt, skills: loaded }], ['flush', {}]]);
    expect(out[0].flags).toEqual(['gbrain-skill-resolver']);
    expect(out[0].events).toEqual(['before_agent_start', 'session_compact', 'session_shutdown', 'session_start']);
    const first = out[2];
    expect(first.result.message).toMatchObject({ customType: 'gbrain-skill-suggestions', display: false });
    expect(first.result.message.content).toContain('deploy-service');
    expect(first.result.message.content).toContain(join('deploy-service', 'SKILL.md'));
    expect(first.result.message.content).not.toContain('email-triage');
    expect(first.result.message.content).not.toContain('calendar-sync');
    expect(first.sections.gbrain_pinned_skills).toContain('calendar-sync');
    expect(out[4].result).toBeNull();
    expect(out[4].sections.gbrain_pinned_skills).toBe(first.sections.gbrain_pinned_skills);
    expect(out[5].result).toBeNull();
    expect(out[5].sections.gbrain_pinned_skills).toBe(first.sections.gbrain_pinned_skills);
    expect(out[7].result.message.content).toContain('deploy-service');
    const logs = readFileSync(join(gbrainHome(b), 'skill-index', 'logs', 'pi-' + new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(logs.map((l) => l.outcome)).toEqual(['suggested', 'deduped', 'skipped_custom', 'compaction', 'suggested']);
    expect(logs[0]).toMatchObject({ hidden: 1, pins: 1 });
    expect(JSON.stringify(logs)).not.toContain('production');
  });

  test('off removes the extension and the state; --dry-run writes nothing; a bare run with nothing on refuses', async () => {
    const b = box();
    const bare = await setup(b, []);
    expect(bare.exitCode).not.toBe(0);
    const dry = await setup(b, ['--skill-loading', 'resolve', '--dry-run']);
    expect(dry.exitCode).toBe(0);
    expect(existsSync(statePath(b))).toBe(false);
    expect(existsSync(extDir(b))).toBe(false);
    expect((await setup(b, ['--skill-loading', 'resolve'])).exitCode).toBe(0);
    const off = await setup(b, ['--skill-loading', 'off']);
    expect(off.exitCode).toBe(0);
    expect(off.resolver.steps.map((s: any) => [s.step, s.action])).toEqual([['extension', 'remove'], ['state', 'remove']]);
    expect(existsSync(statePath(b))).toBe(false);
    expect(existsSync(extDir(b))).toBe(false);
  });

  test('no pi on PATH: on, with a note; a pi that does not load it: exit 3, skill_resolver_plugin_not_installed; no skill directory: refuses and writes nothing', async () => {
    const none = box({ pi: false });
    const r = await setup(none, ['--skill-loading', 'resolve']);
    expect(r.exitCode).toBe(0);
    expect(r.resolver.notes.join('\n')).toContain('no pi on PATH');
    const b = box();
    const broken = await setup(b, ['--skill-loading', 'resolve'], { PI_NO_LOAD: '1' });
    expect(broken.exitCode).toBe(3);
    expect(broken.resolver.error.code).toBe('skill_resolver_plugin_not_installed');
    const empty = box({ skills: false });
    const refused = await setup(empty, ['--skill-loading', 'resolve']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.resolver.error.code).toBe('skill_resolver_setup_incomplete');
    expect(existsSync(statePath(empty))).toBe(false);
    expect(existsSync(extDir(empty))).toBe(false);
  });
});

describe.skipIf(!NODE)('doctor skill_resolver: the Pi extension', () => {
  test('reports the extension, library and catalog as partial coverage, and warns when the extension is gone', async () => {
    const b = box();
    expect((await setup(b, ['--skill-loading', 'resolve'])).exitCode).toBe(0);
    const doctor = async () => JSON.parse((await runCli(['doctor', '--only', 'skill_resolver', '--json'], { env: b.env })).stdout).checks.find((c: any) => c.name === 'skill_resolver');
    const ok = await doctor();
    expect(ok.status).toBe('ok');
    expect(ok.details.pi).toMatchObject({ extension: 'present', library: 'ok', coverage: 'partial', catalog: { name: 'pi-user', fresh: true, skills: 3 } });
    expect(ok.message).toContain('pi extension present');
    rmSync(extDir(b), { recursive: true, force: true });
    const warn = await doctor();
    expect(warn).toMatchObject({ status: 'warn', details: { code: 'skill_resolver_plugin_not_installed' } });
    expect(warn.fix.argv).toEqual(['gbrain', 'setup', 'pi', '--skill-loading', 'resolve']);
  });
});
