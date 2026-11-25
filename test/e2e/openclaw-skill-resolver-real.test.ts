/**
 * Tier 2 e2e: gbrain's skill-resolver plugin (gbrain-skill-resolver) inside a
 * REAL OpenClaw gateway. Setup, the gateway, every user turn and the CLI calls
 * are real; only the model is a loopback fake that records each request, so
 * the test reads exactly what OpenClaw sent the model (no key, no paid call).
 *
 * Protects, on the OpenClaw version in GBRAIN_TEST_OPENCLAW_SKILL_BIN (or
 * `openclaw` on PATH):
 *  - setup installs the plugin and OpenClaw loads it with before_prompt_build;
 *  - a live turn's request carries the suggestions block for that turn's own
 *    message, and the pinned block in the system prompt (appendSystemContext);
 *  - a message that needs no skill gets no block;
 *  - shadow injects nothing and logs would_suggest;
 *  - a mode flip and --live-fraction take effect on the next turn with no
 *    OpenClaw command for the resolver plugin and no gateway restart (setup
 *    still re-runs the brain-first turn-rule plugin's install commands);
 *  - a turn OpenClaw retries after a model error carries exactly one block,
 *    for the user's message, on every attempt;
 *  - real channel turns through OpenClaw's telegram plugin (a loopback fake
 *    Bot API): a DM and a group, the owner and another member, a mention,
 *    and --owner-sender giving another member the pins only;
 *  - a cron turn gets no suggestions (skipped_provenance);
 *  - a skills_read of a suggested skill logs a read marked suggested;
 *  - fail-open: a corrupted library or a stuck worker never fails or stalls a
 *    turn, injects nothing and logs the miss;
 *  - doctor reads healthy; off removes the plugin and keeps the pins;
 *  - a 750-skill directory: what OpenClaw loads, what setup excludes, what
 *    doctor says, and which settings lift OpenClaw's cut;
 *  - listing off (maxSkillsPromptChars 0, skills_read only through
 *    dispatch_action) with a skill in a configured extra dir outside the
 *    workspace: setup indexes it through the gateway's skills.status, the
 *    block leads with its path, a read of that path and a dispatched
 *    skills_read each log one read with its source, doctor reads
 *    "listing off, resolver live", and tools.fs.workspaceOnly makes the
 *    block lead with skills_read for it.
 *
 * Skips only when no OpenClaw CLI is found; with GBRAIN_TEST_REQUIRE_OPENCLAW=1
 * (CI) a missing CLI fails instead.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { RealOpenclaw, blockIds, openclawBin, promptText, systemText, type ModelRequest, type TelegramMessage, type TelegramUser } from '../helpers/openclaw-real-gateway.ts';

const BIN = openclawBin();
if (!BIN && process.env.GBRAIN_TEST_REQUIRE_OPENCLAW === '1') throw new Error('GBRAIN_TEST_REQUIRE_OPENCLAW=1 but no OpenClaw CLI was found (set GBRAIN_TEST_OPENCLAW_SKILL_BIN)');
const PLUGIN = 'gbrain-skill-resolver';
const TURN_MS = 60_000;

const suggested = (t: { request: ModelRequest; message: string }) => blockIds(promptText(t.request, t.message), 'relevant_skills');
const pinned = (t: { request: ModelRequest }) => blockIds(systemText(t.request), 'pinned_skills');
const turnLines = (oc: RealOpenclaw) => oc.logLines().filter((l) => l.agent === 'main' && l.outcome !== 'read' && l.outcome !== 'compaction');

async function expectTurn(oc: RealOpenclaw, session: string, message: string): Promise<{ request: ModelRequest; message: string }> {
  const t = await oc.turn(session, message);
  expect({ code: t.ran.code, stderr: t.ran.code === 0 ? '' : t.ran.stderr.slice(-2000) }).toEqual({ code: 0, stderr: '' });
  expect(t.ran.ms).toBeLessThan(TURN_MS);
  expect(t.requests.length).toBeGreaterThan(0);
  return { request: t.requests[0]!, message };
}

describe.skipIf(!BIN)('gbrain-skill-resolver in a real OpenClaw gateway', () => {
  let oc: RealOpenclaw;
  let version = '';

  beforeAll(async () => {
    oc = new RealOpenclaw(BIN!, 'skill');
    oc.skill('deploy-example', 'Deploy the web service to production with a rolling restart and health checks');
    oc.skill('invoice-example', 'Create and send a customer invoice as a PDF with line items and tax');
    oc.skill('translate-example', 'Translate a document between English and Spanish keeping its formatting');
    await oc.start();
    version = (await oc.openclaw(['--version'])).stdout.trim().split('\n').at(-1) ?? '';
    const want = process.env.GBRAIN_TEST_OPENCLAW_EXPECT_VERSION;
    if (want && !version.includes(want)) throw new Error('expected OpenClaw ' + want + ', found ' + version);
    console.log('[openclaw-skill-resolver-real] ' + version);
    expect((await oc.gbrain(['init', '--pglite', '--no-embedding'])).code).toBe(0);
  }, 300_000);

  afterAll(async () => { await oc?.close(); });

  test('setup installs the plugin for real and OpenClaw loads it with before_prompt_build', async () => {
    const r = await oc.gbrain(['setup', 'openclaw', '--skill-loading', 'resolve', '--agent', 'main', '--gbrain-bin', oc.gbrainBin, '--json']);
    expect({ code: r.code, stderr: r.code === 0 ? '' : r.stderr.slice(-3000), stdout: r.code === 0 ? '' : r.stdout.slice(-3000) }).toEqual({ code: 0, stderr: '', stdout: '' });
    const resolver = JSON.parse(r.stdout).skill_resolver;
    expect(resolver.error).toBeUndefined();
    expect(resolver.steps.map((s: { step: string }) => s.step)).toEqual(['catalog', 'library', 'state', 'plugin', 'install', 'verify', 'self-test']);
    expect(resolver.agents).toEqual([expect.objectContaining({ id: 'main', mode: 'live', sources: expect.objectContaining({ 'openclaw-workspace': 3 }) })]);
    expect(resolver.notes.join('\n')).not.toContain('failed, so skills OpenClaw hides');
    const inspect = await oc.openclaw(['plugins', 'inspect', PLUGIN, '--runtime', '--json']);
    expect(inspect.code).toBe(0);
    const doc = JSON.parse(inspect.stdout.slice(inspect.stdout.indexOf('{')));
    expect(doc.plugin).toMatchObject({ id: PLUGIN, status: 'loaded', imported: true });
    expect(inspect.stdout).toContain('before_prompt_build');
    await oc.startGateway();
  }, 300_000);

  test('a live turn carries the block for its own message; the next turn in the session for the next message', async () => {
    const first = await expectTurn(oc, 'live-1', 'Please deploy the web service to production with a rolling restart');
    expect(suggested(first)).toEqual(['deploy-example']);
    const second = await expectTurn(oc, 'live-1', 'Now create and send a customer invoice as a PDF with tax');
    expect(suggested(second)).toEqual(['invoice-example']);
    const lines = await oc.waitForLog(2);
    expect(turnLines(oc).slice(-2).map((l) => [l.arm, l.outcome, l.suggested])).toEqual([
      ['live', 'suggested', ['deploy-example']], ['live', 'suggested', ['invoice-example']],
    ]);
    expect(JSON.stringify(lines)).not.toContain('rolling restart');
  }, 180_000);

  test('a pin reaches the system prompt on the next turn and is never also suggested', async () => {
    const calls = oc.callLines().length;
    expect((await oc.gbrain(['skills', 'pin', 'add', 'translate-example', '--catalog', 'openclaw-main'])).code).toBe(0);
    const req = await expectTurn(oc, 'pin-1', 'Translate this document into Spanish and keep the formatting');
    expect(pinned(req)).toEqual(['translate-example']);
    expect(suggested(req) ?? []).not.toContain('translate-example');
    expect(oc.callLines().length).toBe(calls);
  }, 180_000);

  test('a message that needs no skill gets no suggestions block', async () => {
    const req = await expectTurn(oc, 'none-1', 'What is two plus two');
    expect(suggested(req)).toBeNull();
    await oc.waitForLog(1);
    expect(turnLines(oc).at(-1)).toMatchObject({ outcome: 'no_match', suggested: [] });
  }, 180_000);

  test('a turn OpenClaw retries after a model error carries one block, for the user message, on every attempt, and later attempts are logged as retries of the same run', async () => {
    const lines = turnLines(oc).length;
    const message = 'Create and send a customer invoice as a PDF with line items';
    oc.replies.push({ status: 529 }, { status: 529 });
    const t = await oc.turn('retry-1', message);
    expect(t.ran.code).toBe(0);
    expect(t.requests.length).toBe(3);
    expect(t.requests.map((r) => blockIds(promptText(r, message), 'relevant_skills'))).toEqual([['invoice-example'], ['invoice-example'], ['invoice-example']]);
    expect(t.requests.map((r) => JSON.stringify(r.body.messages).split('<relevant_skills>').length - 1)).toEqual([1, 1, 1]);
    await oc.waitForLog(lines + 3);
    const attempts = turnLines(oc).slice(lines);
    console.log('[openclaw-skill-resolver-real] retry attempts: ' + JSON.stringify(attempts.map((l) => l.outcome)));
    expect(attempts.map((l) => [l.outcome, l.suggested])[0]).toEqual(['suggested', ['invoice-example']]);
    expect(attempts.slice(1).map((l) => l.outcome)).toEqual(['retry', 'retry']);
  }, 180_000);

  test('a skills_read of a suggested skill logs a read marked suggested', async () => {
    const tools = (oc.requests.at(-1)!.body.tools ?? []).map((t) => t.function?.name);
    oc.replies.push(tools.includes('skills_read')
      ? { tool: 'skills_read', args: { name: 'invoice-example' } }
      : { tool: 'dispatch_action', args: { id: 'skills_read', args: { name: 'invoice-example' } } });
    oc.replies.push({ text: 'done' });
    const t = await oc.turn('read-1', 'Create and send a customer invoice as a PDF with line items');
    expect(t.ran.code).toBe(0);
    expect(suggested({ request: t.requests[0]!, message: 'Create and send a customer invoice as a PDF with line items' })).toEqual(['invoice-example']);
    expect(JSON.stringify(t.requests.at(-1)!.body.messages)).toContain('Skill location:');
    const deadline = Date.now() + 10_000;
    while (!oc.logLines().some((l) => l.outcome === 'read') && Date.now() < deadline) await Bun.sleep(100);
    expect(oc.logLines().filter((l) => l.outcome === 'read').at(-1)).toMatchObject({ agent: 'main', skill: 'invoice-example', suggested: true, pinned: false, arm: 'live' });
  }, 180_000);

  test('shadow, then --live-fraction 0, then live: each takes effect on the next turn with no command for the resolver plugin and no gateway restart', async () => {
    const pid = oc.gatewayPid;
    const calls = oc.callLines().length;
    const config = readFileSync(oc.env.OPENCLAW_CONFIG_PATH!, 'utf8');
    const logAt = oc.gatewayLog.length;
    const flip = async (args: string[]) => {
      const r = await oc.gbrain(['setup', 'openclaw', ...args, '--agent', 'main', '--gbrain-bin', oc.gbrainBin, '--json']);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).skill_resolver.steps.find((s: { step: string }) => s.step === 'install')).toMatchObject({ action: 'skip' });
    };
    await flip(['--skill-loading', 'shadow']);
    const shadow = await expectTurn(oc, 'shadow-1', 'Please deploy the web service to production with a rolling restart');
    expect(suggested(shadow)).toBeNull();
    expect(pinned(shadow)).toBeNull();
    await oc.waitForLog(1);
    expect(turnLines(oc).at(-1)).toMatchObject({ arm: 'shadow', outcome: 'would_suggest', suggested: ['deploy-example'] });

    await flip(['--skill-loading', 'resolve', '--live-fraction', '0']);
    const control = await expectTurn(oc, 'control-1', 'Now create and send a customer invoice as a PDF with tax');
    expect(suggested(control)).toBeNull();
    expect(pinned(control)).toEqual(['translate-example']);
    await oc.waitForLog(1);
    expect(turnLines(oc).at(-1)).toMatchObject({ arm: 'control', outcome: 'would_suggest', suggested: ['invoice-example'] });

    await flip(['--skill-loading', 'resolve', '--live-fraction', '1']);
    const live = await expectTurn(oc, 'live-2', 'Now create and send a customer invoice as a PDF with tax');
    expect(suggested(live)).toEqual(['invoice-example']);

    const made = oc.callLines().slice(calls);
    console.log('[openclaw-skill-resolver-real] flip calls: ' + JSON.stringify(made));
    console.log('[openclaw-skill-resolver-real] config changed: ' + (readFileSync(oc.env.OPENCLAW_CONFIG_PATH!, 'utf8') !== config));
    console.log('[openclaw-skill-resolver-real] gateway log after flips: ' + JSON.stringify(oc.gatewayLog.slice(logAt).split('\n').filter((l) => !l.includes('startup phase')).slice(-40)));
    expect(made.filter((l) => l.includes(PLUGIN))).toEqual([]);
    expect(oc.gatewayPid).toBe(pid);
  }, 300_000);

  test('doctor reads the plugin healthy', async () => {
    const r = await oc.gbrain(['doctor', '--only', 'skill_resolver', '--json']);
    const check = JSON.parse(r.stdout).checks.find((c: { name: string }) => c.name === 'skill_resolver');
    expect(check.status).toBe('ok');
    expect(check.details.openclaw).toMatchObject({ plugin: 'installed', library: 'ok' });
    expect(check.details.openclaw.recent.deadline_misses).toBe(0);
    expect(check.details.openclaw.agents).toEqual([expect.objectContaining({ id: 'main', mode: 'live', fresh: true, pins: 1 })]);
    expect(check.details.openclaw.recent.reads_of_suggested).toBeGreaterThanOrEqual(1);
    console.log('[openclaw-skill-resolver-real] doctor: ' + check.message);
  }, 120_000);

  test('fail-open: a corrupted library never fails a turn, injects nothing and logs the refusal', async () => {
    const state = JSON.parse(readFileSync(oc.statePath, 'utf8'));
    const lib = join(oc.gbrainHome, 'lib', state.library_sha256 + '.mjs');
    const good = readFileSync(lib);
    writeFileSync(lib, 'export const broken = ;\n');
    try {
      await oc.restartGateway();
      const req = await expectTurn(oc, 'corrupt-1', 'Please deploy the web service to production with a rolling restart');
      expect(suggested(req)).toBeNull();
      await oc.waitForLog(1);
      const codes = oc.logLines().slice(-3).map((l) => l.code);
      expect(codes).toContain('skill_resolver_library_mismatch');
    } finally {
      writeFileSync(lib, good);
      chmodSync(lib, 0o644);
      await oc.restartGateway();
    }
    expect(suggested(await expectTurn(oc, 'corrupt-2', 'Please deploy the web service to production with a rolling restart'))).toEqual(['deploy-example']);
  }, 300_000);

  test('fail-open: a stuck worker never stalls a turn; each miss is logged and the worker is restarted after three', async () => {
    const state = JSON.parse(readFileSync(oc.statePath, 'utf8'));
    const stuck = 'export const GBRAIN_VERSION = "0.0.0";\nexport async function resolveSkills() { for (;;) {} }\nexport async function buildSkillIndex() {}\nexport async function commitSessionAsync() {}\n';
    const sha = createHash('sha256').update(stuck).digest('hex');
    const path = join(oc.gbrainHome, 'lib', sha + '.mjs');
    writeFileSync(path, stuck);
    chmodSync(path, 0o644);
    writeFileSync(oc.statePath, JSON.stringify({ ...state, library_sha256: sha }, null, 2));
    try {
      for (let i = 1; i <= 3; i++) {
        const req = await expectTurn(oc, 'stuck-' + i, 'Please deploy the web service to production with a rolling restart');
        expect(suggested(req)).toBeNull();
      }
      await oc.waitForLog(4);
      const recent = oc.logLines().slice(-4);
      expect(recent.filter((l) => l.outcome === 'timeout' && l.code === 'skill_resolve_timeout')).toHaveLength(3);
      expect(recent.some((l) => l.code === 'skill_resolver_worker_stuck')).toBe(true);
      for (const l of recent.filter((x) => x.outcome === 'timeout')) expect(l.ms as number).toBeLessThan(1000);
    } finally {
      writeFileSync(oc.statePath, JSON.stringify(state, null, 2));
    }
  }, 300_000);

  test('off removes the plugin from OpenClaw and keeps the pins', async () => {
    const r = await oc.gbrain(['setup', 'openclaw', '--skill-loading', 'off', '--gbrain-bin', oc.gbrainBin, '--json']);
    expect(r.code).toBe(0);
    const inspect = await oc.openclaw(['plugins', 'inspect', PLUGIN, '--json']);
    expect(inspect.code === 0 && inspect.stdout.includes('"status": "loaded"')).toBe(false);
    const list = await oc.openclaw(['plugins', 'list', '--json']);
    expect(list.stdout).not.toContain(PLUGIN);
    const cfg = JSON.parse(readFileSync(join(oc.gbrainHome, 'config.json'), 'utf8'));
    expect(JSON.stringify(cfg)).toContain('translate-example');
  }, 180_000);
});

describe.skipIf(!BIN)('a 750-skill directory in a real OpenClaw', () => {
  let oc: RealOpenclaw;
  const targets = { 5: 'skill-0005-deploy-example', 250: 'skill-0250-invoice-example', 350: 'skill-0350-translate-example' } as Record<number, string>;
  const topics = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];

  beforeAll(async () => {
    oc = new RealOpenclaw(BIN!, 'big');
    for (let i = 1; i <= 750; i++) {
      const t = topics[i % topics.length];
      const name = targets[i] ?? 'skill-' + String(i).padStart(4, '0') + '-example';
      const description = i === 5 ? 'Deploy the web service to production with a rolling restart and health checks'
        : i === 250 ? 'Create and send a customer invoice as a PDF with line items and tax'
        : i === 350 ? 'Translate a document between English and Spanish keeping its formatting'
        : 'Synthetic filler skill ' + i + ' for the ' + t + ' workflow: format ' + t + ' reports and archive ' + t + ' records';
      oc.skill(name, description);
    }
    await oc.start();
    expect((await oc.gbrain(['init', '--pglite', '--no-embedding'])).code).toBe(0);
  }, 300_000);

  afterAll(async () => { await oc?.close(); });

  test('OpenClaw loads the first 200 by name and says so only on stderr; setup excludes the rest and names the cut; doctor does not', async () => {
    const list = await oc.openclaw(['skills', 'list', '--json', '--agent', 'main']);
    expect(list.code).toBe(0);
    const names = new Set((JSON.parse(list.stdout.slice(list.stdout.indexOf('{'))).skills as Array<{ name: string }>).map((s) => s.name).filter((n) => /^skill-\d{4}-/.test(n)));
    expect(names.size).toBe(200);
    expect(names.has(targets[5]!)).toBe(true);
    expect(names.has(targets[250]!)).toBe(false);
    expect(names.has(targets[350]!)).toBe(false);
    expect(list.stderr).toMatch(/truncating discovery.*childDirCount=750.*maxSkillsLoadedPerSource=200/);
    expect(list.stdout).not.toContain('truncating');

    const r = await oc.gbrain(['setup', 'openclaw', '--skill-loading', 'resolve', '--agent', 'main', '--gbrain-bin', oc.gbrainBin, '--json']);
    expect(r.code).toBe(0);
    const resolver = JSON.parse(r.stdout).skill_resolver;
    expect(resolver.agents).toEqual([expect.objectContaining({ id: 'main', sources: expect.objectContaining({ 'openclaw-workspace': 200 }) })]);
    expect(resolver.notes.join('\n')).toMatch(/does not list 550 of openclaw-main's skills.*skill_resolver_host_load_cut/);
    const state = JSON.parse(readFileSync(oc.statePath, 'utf8'));
    expect(state.agents.main.exclude_ids.filter((id: string) => /^skill-\d{4}-/.test(id))).toHaveLength(550);
    expect(state.agents.main.exclude_ids).toEqual(expect.arrayContaining([targets[250], targets[350]]));

    const doctor = await oc.gbrain(['doctor', '--only', 'skill_resolver', '--json']);
    expect(doctor.stdout).not.toContain('skill_resolver_host_load_cut');

    await oc.startGateway();
    expect(suggested(await expectTurn(oc, 'big-1', 'Please deploy the web service to production with a rolling restart'))).toEqual([targets[5]]);
    const invoice = await expectTurn(oc, 'big-2', 'Create and send a customer invoice as a PDF with line items and tax');
    expect(suggested(invoice) ?? []).not.toContain(targets[250]);
    expect(systemText(invoice.request)).not.toContain(targets[250]);
  }, 600_000);

  test('raising maxCandidatesPerRoot alone keeps the cut; raising maxSkillsLoadedPerSource too lifts it', async () => {
    expect((await oc.openclaw(['config', 'set', 'skills.limits.maxCandidatesPerRoot', '1000'])).code).toBe(0);
    const one = await oc.openclaw(['skills', 'list', '--json', '--agent', 'main']);
    const count = (out: string) => (JSON.parse(out.slice(out.indexOf('{'))).skills as Array<{ name: string }>).filter((s) => /^skill-\d{4}-/.test(s.name)).length;
    expect(count(one.stdout)).toBe(200);
    expect(one.stderr).not.toContain('truncating');
    expect((await oc.openclaw(['config', 'set', 'skills.limits.maxSkillsLoadedPerSource', '1000'])).code).toBe(0);
    const both = await oc.openclaw(['skills', 'list', '--json', '--agent', 'main']);
    expect(count(both.stdout)).toBe(750);
    const r = await oc.gbrain(['setup', 'openclaw', '--skill-loading', 'resolve', '--agent', 'main', '--gbrain-bin', oc.gbrainBin, '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).skill_resolver.notes.join('\n')).not.toContain('skill_resolver_host_load_cut');
    expect(JSON.parse(readFileSync(oc.statePath, 'utf8')).agents.main.exclude_ids.filter((id: string) => /^skill-\d{4}-/.test(id))).toEqual([]);
    await oc.restartGateway();
    expect(suggested(await expectTurn(oc, 'big-3', 'Create and send a customer invoice as a PDF with line items and tax'))).toEqual([targets[250]]);
  }, 600_000);
});

describe.skipIf(!BIN)('listing off with a skill outside the workspace in a real OpenClaw gateway', () => {
  let oc: RealOpenclaw;
  let invoicePath = '';
  const invoice = 'Create and send a customer invoice as a PDF with line items and tax';
  const reads = () => oc.logLines().filter((l) => l.outcome === 'read');
  const config = (edit: (cfg: Record<string, any>) => void) => {
    const cfg = JSON.parse(readFileSync(oc.env.OPENCLAW_CONFIG_PATH!, 'utf8'));
    edit(cfg);
    writeFileSync(oc.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(cfg, null, 2));
  };
  const setup = async (extra: string[] = []) => {
    const r = await oc.gbrain(['setup', 'openclaw', '--skill-loading', 'resolve', '--agent', 'main', '--gbrain-bin', oc.gbrainBin, '--json', ...extra]);
    expect({ code: r.code, stderr: r.code === 0 ? '' : r.stderr.slice(-3000), stdout: r.code === 0 ? '' : r.stdout.slice(-3000) }).toEqual({ code: 0, stderr: '', stdout: '' });
    return JSON.parse(r.stdout).skill_resolver;
  };

  beforeAll(async () => {
    oc = new RealOpenclaw(BIN!, 'listing-off');
    oc.skill('deploy-example', 'Deploy the web service to production with a rolling restart and health checks');
    oc.skill('clash-example', 'Rotate the TLS certificates of the load balancer before they expire');
    await oc.start();
    const extra = join(oc.dir, 'extra-skills');
    for (const [name, description] of [['invoice-example', invoice], ['clash-example', 'An older copy of the certificate rotation skill']]) {
      mkdirSync(join(extra, name!), { recursive: true });
      writeFileSync(join(extra, name!, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + JSON.stringify(description) + '\n---\n# ' + name + '\n' + description + '.\n');
    }
    invoicePath = realpathSync(join(extra, 'invoice-example', 'SKILL.md'));
    config((cfg) => {
      cfg.skills.load = { extraDirs: [extra] };
      cfg.agents.entries = { main: { skillsLimits: { maxSkillsPromptChars: 0 } } };
      cfg.tools = { toolSearch: { enabled: true, mode: 'tools' } };
    });
    expect((await oc.gbrain(['init', '--pglite', '--no-embedding'])).code).toBe(0);
  }, 300_000);

  afterAll(async () => { await oc?.close(); });

  test("setup reads the running gateway's skills.status: the extra dir is indexed, the workspace copy of a clash wins, and the state names the roots, the paths and the gbrain home", async () => {
    await oc.startGateway();
    const resolver = await setup();
    expect(resolver.agents).toEqual([expect.objectContaining({ id: 'main', mode: 'live', sources: expect.objectContaining({ 'openclaw-workspace': 2, 'openclaw-extra': 1 }) })]);
    const calls = oc.callLines();
    expect(calls).toContain('gateway call skills.status --params {"agentId":"main"} --json');
    expect(calls.some((l) => l.startsWith('skills info'))).toBe(false);
    const state = JSON.parse(readFileSync(oc.statePath, 'utf8'));
    expect(state.gbrain_home).toBe(oc.gbrainHome);
    const a = state.agents.main;
    expect(a.skill_roots.map((r: { source: string }) => r.source)).toEqual(expect.arrayContaining(['openclaw-workspace', 'openclaw-extra']));
    expect(a.skill_files['invoice-example']).toBe(invoicePath);
    expect(a.skill_files['clash-example']).toBe(realpathSync(join(oc.workspace, 'skills', 'clash-example', 'SKILL.md')));
    expect(a.exclude_ids).not.toContain('clash-example');
    expect(a.path_reads).toBe('any');
    const bundled = a.skill_roots.find((r: { source: string }) => r.source === 'openclaw-bundled')?.dir as string;
    const hidden = Object.entries(a.skill_files as Record<string, string>).filter(([, p]) => p.startsWith(bundled + '/')).map(([id]) => id);
    expect(hidden.length).toBeGreaterThan(0);
    expect(a.exclude_ids).toEqual(expect.arrayContaining(hidden));
    await oc.restartGateway();
  }, 300_000);

  test('a turn with listing off: no skills_read tool, no skill listed in the system prompt, and the block leads with the SKILL.md path; a read of that path logs one read with its source', async () => {
    oc.replies.push({ tool: 'read', args: { path: invoicePath } }, { text: 'done' });
    const before = reads().length;
    const t = await oc.turn('off-1', invoice);
    expect(t.ran.code).toBe(0);
    const tools = (t.requests[0]!.body.tools ?? []).map((x) => x.function?.name);
    expect(tools).not.toContain('skills_read');
    expect(tools).toEqual(expect.arrayContaining(['dispatch_action', 'read']));
    const system = systemText(t.requests[0]!);
    const section = system.slice(system.indexOf('## Skills')).split('\n## ')[0]!.split('\n').filter(Boolean);
    console.log('[openclaw-skill-resolver-real] listing-off skills section: ' + section.length + ' lines: ' + JSON.stringify(section));
    expect(system).not.toContain('invoice-example');
    expect(suggested({ request: t.requests[0]!, message: invoice })).toEqual(['invoice-example']);
    const prompt = promptText(t.requests[0]!, invoice);
    expect(prompt).toContain(JSON.stringify(invoicePath));
    expect(prompt).toContain('To use one, read the SKILL.md at its path with read before acting');
    expect(JSON.stringify(t.requests.at(-1)!.body.messages)).toContain('# invoice-example');
    const deadline = Date.now() + 10_000;
    while (reads().length <= before && Date.now() < deadline) await Bun.sleep(100);
    expect(reads().slice(before)).toEqual([expect.objectContaining({ agent: 'main', skill: 'invoice-example', tool: 'read', via: 'direct', source: 'openclaw-extra', suggested: true, arm: 'live' })]);
    expect(turnLines(oc).at(-1)).toMatchObject({ outcome: 'suggested', suggested: ['invoice-example'], sources: ['openclaw-extra'] });
  }, 180_000);

  test('a skills_read through dispatch_action logs one read, not two', async () => {
    oc.replies.push({ tool: 'dispatch_action', args: { id: 'skills_read', args: { name: 'invoice-example' } } }, { text: 'done' });
    const before = reads().length;
    const t = await oc.turn('off-2', invoice);
    expect(t.ran.code).toBe(0);
    expect(JSON.stringify(t.requests.at(-1)!.body.messages)).toContain('Skill location:');
    const deadline = Date.now() + 10_000;
    while (reads().length <= before && Date.now() < deadline) await Bun.sleep(100);
    await Bun.sleep(1000);
    expect(reads().slice(before)).toEqual([expect.objectContaining({ skill: 'invoice-example', tool: 'skills_read', via: 'dispatch', source: 'openclaw-extra', suggested: true })]);
  }, 180_000);

  test('doctor reads "listing off, resolver live", names the gbrain home and splits recent counts by source and session class', async () => {
    const r = await oc.gbrain(['doctor', '--only', 'skill_resolver', '--json']);
    const check = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))).checks.find((c: { name: string }) => c.name === 'skill_resolver');
    expect({ status: check.status, message: check.message }).toEqual({ status: 'ok', message: expect.stringContaining('listing off, resolver live') });
    const d = check.details.openclaw;
    expect(d.gbrain_home).toBe(oc.gbrainHome);
    expect(d.agents[0]).toMatchObject({ id: 'main', listing: 'off', path_reads: 'any', verdict: 'listing off, resolver live' });
    expect(d.recent.by_source['openclaw-extra']).toMatchObject({ suggested: 2, reads: 2, reads_of_suggested: 2 });
    console.log('[openclaw-skill-resolver-real] session classes on openclaw agent turns: ' + JSON.stringify(d.recent.by_session_class));
  }, 180_000);

  test('tools.fs.workspaceOnly: the block leads with skills_read for the skill outside the workspace and with the path for one inside', async () => {
    await oc.stopGateway();
    config((cfg) => { cfg.tools.fs = { workspaceOnly: true }; });
    await oc.startGateway();
    await setup(['--skills-index-only']);
    expect(JSON.parse(readFileSync(oc.statePath, 'utf8')).agents.main).toMatchObject({ path_reads: 'workspace', workspace_dir: oc.workspace });
    oc.replies.push({ tool: 'read', args: { path: invoicePath } }, { text: 'done' });
    const t = await oc.turn('ws-1', invoice);
    expect(t.ran.code).toBe(0);
    const prompt = promptText(t.requests[0]!, invoice);
    expect(suggested({ request: t.requests[0]!, message: invoice })).toEqual(['invoice-example']);
    expect(prompt).toContain('To use one, load it with skills_read({name}) using its name (through dispatch_action when skills_read is not listed) before acting');
    const result = JSON.stringify(t.requests.at(-1)!.body.messages.at(-1));
    console.log('[openclaw-skill-resolver-real] workspaceOnly read of a skill outside the workspace: ' + result.slice(0, 300));
    const deploy = 'Please deploy the web service to production with a rolling restart';
    const inside = await expectTurn(oc, 'ws-2', deploy);
    expect(suggested(inside)).toEqual(['deploy-example']);
    expect(promptText(inside.request, deploy)).toContain('To use one, read the SKILL.md at its path with read before acting');
  }, 300_000);
});

describe.skipIf(!BIN)('channel turns, internal turns and retries in a real OpenClaw gateway', () => {
  let oc: RealOpenclaw;
  const GROUP = { id: -1001234567890, type: 'supergroup' as const, title: 'Example Group' };
  const OWNER: TelegramUser = { id: 424242, is_bot: false, first_name: 'Alice', username: 'alice_example' };
  const MEMBER: TelegramUser = { id: 515151, is_bot: false, first_name: 'Bob', username: 'bob_example' };
  const DEPLOY = 'Please deploy the web service to production with a rolling restart';
  const INVOICE = 'Create and send a customer invoice as a PDF with tax';

  async function channelTurn(message: TelegramMessage): Promise<{ request: ModelRequest; message: string; line: Record<string, unknown> }> {
    const requests = oc.requests.length;
    const lines = turnLines(oc).length;
    oc.telegramSend(message);
    const deadline = Date.now() + TURN_MS;
    let request: ModelRequest | undefined;
    while (Date.now() < deadline) {
      request = oc.requests.slice(requests).find((r) => promptText(r, message.text) !== '');
      if (request && turnLines(oc).length > lines) break;
      await Bun.sleep(200);
    }
    expect({ request: Boolean(request), lines: turnLines(oc).length > lines }).toEqual({ request: true, lines: true });
    return { request: request!, message: message.text, line: turnLines(oc).at(-1)! };
  }

  beforeAll(async () => {
    oc = new RealOpenclaw(BIN!, 'chan');
    oc.skill('deploy-example', 'Deploy the web service to production with a rolling restart and health checks');
    oc.skill('invoice-example', 'Create and send a customer invoice as a PDF with line items and tax');
    oc.skill('translate-example', 'Translate a document between English and Spanish keeping its formatting');
    oc.skill('album-example', 'Archive old photos into a compressed album folder by year');
    await oc.start();
    await oc.startTelegram({ allowFrom: [String(OWNER.id)], groupAllowFrom: [String(OWNER.id), String(MEMBER.id)], groups: [String(GROUP.id)] });
    expect((await oc.gbrain(['init', '--pglite', '--no-embedding'])).code).toBe(0);
    const r = await oc.gbrain(['setup', 'openclaw', '--skill-loading', 'resolve', '--agent', 'main', '--gbrain-bin', oc.gbrainBin, '--json']);
    expect({ code: r.code, stderr: r.code === 0 ? '' : r.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    expect((await oc.gbrain(['skills', 'pin', 'add', 'translate-example', '--catalog', 'openclaw-main'])).code).toBe(0);
    await oc.startGateway();
  }, 300_000);

  afterAll(async () => { await oc?.close(); });

  test('a Telegram DM: the suggestions block follows the bare user text', async () => {
    const t = await channelTurn({ chat: { id: OWNER.id, type: 'private', first_name: OWNER.first_name }, from: OWNER, text: DEPLOY });
    expect(suggested(t)).toEqual(['deploy-example']);
    expect(pinned(t)).toEqual(['translate-example']);
    expect(t.line).toMatchObject({ arm: 'live', outcome: 'suggested', suggested: ['deploy-example'] });
    const deadline = Date.now() + 30_000;
    const replied = () => oc.telegramCalls.some((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(OWNER.id));
    while (!replied() && Date.now() < deadline) await Bun.sleep(200);
    expect(replied()).toBe(true);
  }, 120_000);

  test('a Telegram group: any allowed member gets suggestions, and a mention stays in the text', async () => {
    const member = await channelTurn({ chat: GROUP, from: MEMBER, text: INVOICE });
    expect(suggested(member)).toEqual(['invoice-example']);
    const mention = '@fixture_bot please deploy the web service to production';
    const mentioned = await channelTurn({ chat: GROUP, from: MEMBER, text: mention, entities: [{ type: 'mention', offset: 0, length: 12 }] });
    expect(suggested(mentioned)).toEqual(['deploy-example']);
  }, 180_000);

  test('--owner-sender: the owner gets suggestions in the group, another member gets the pins only', async () => {
    const r = await oc.gbrain(['setup', 'openclaw', '--skill-loading', 'resolve', '--owner-sender', String(OWNER.id), '--agent', 'main', '--gbrain-bin', oc.gbrainBin, '--json']);
    expect(r.code).toBe(0);
    const owner = await channelTurn({ chat: GROUP, from: OWNER, text: 'Archive my old photos into a compressed album folder by year' });
    expect(suggested(owner)).toEqual(['album-example']);
    expect(pinned(owner)).toEqual(['translate-example']);
    const member = await channelTurn({ chat: GROUP, from: MEMBER, text: INVOICE });
    expect(suggested(member)).toBeNull();
    expect(pinned(member)).toEqual(['translate-example']);
    expect(member.line).toMatchObject({ outcome: 'skipped_sender', pins: 1 });
    const cli = await expectTurn(oc, 'no-sender-1', DEPLOY);
    expect(suggested(cli)).toBeNull();
    expect(turnLines(oc).at(-1)).toMatchObject({ outcome: 'skipped_sender' });
  }, 240_000);

  test('a cron turn gets no suggestions and logs skipped_provenance', async () => {
    const add = await oc.openclaw(['cron', 'add', '--name', 'deploy-check', '--agent', 'main', '--every', '6h', '--message', DEPLOY, '--no-deliver', '--json']);
    expect(add.code).toBe(0);
    const doc = JSON.parse(add.stdout.slice(add.stdout.indexOf('{')));
    const id = String(doc.id ?? doc.job?.id ?? '');
    expect(id).not.toBe('');
    const requests = oc.requests.length;
    const lines = turnLines(oc).length;
    expect((await oc.openclaw(['cron', 'run', id, '--json'])).code).toBe(0);
    const deadline = Date.now() + TURN_MS;
    while ((turnLines(oc).length === lines || oc.requests.length === requests) && Date.now() < deadline) await Bun.sleep(200);
    expect(turnLines(oc).at(-1)).toMatchObject({ outcome: 'skipped_provenance', provenance: 'cron' });
    const request = oc.requests.slice(requests).find((r) => promptText(r, DEPLOY) !== '')!;
    expect(promptText(request, DEPLOY)).toContain('[cron:' + id);
    expect(suggested({ request, message: DEPLOY })).toBeNull();
  }, 180_000);
});
