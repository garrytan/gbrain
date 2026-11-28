/**
 * A remote run_doctor over the served wire (multi-user lane L3): an agent-facing (remote) admin caller of a served client
 * runs doctor; the reads doctor needs that are not open to a remote caller are refused by the served client before
 * anything is sent, so those checks cannot run.
 *
 * Mode: the owner opens with GBRAIN_RUST_MULTIUSER=1 set in-run (after the preload); the test asserts its store reports
 * `multiuser: true` and the client reports `served` and `multi_writer`.
 *
 * 1. Protects:
 *    - the report completes (no tool error) and every wave check that could not run for the remote caller says so:
 *      its host_action state is `unknown`, never `action_required`. The brain is fresh, so no wave check has a real
 *      finding; an `action_required` line here is a claim about the brain that nothing checked;
 *    - the four wave checks whose read failure has its own shape (connector_checkpoints, unbound_source,
 *      segmented_storage, fact_bulk_dates) are offered to the remote caller and report unknown;
 *    - no local-only data reaches the remote caller: a private page body, a config value and the brain's directory
 *      never appear in any report;
 *    - each row of test/fixtures/served-member-lists/local-only.tsv with the run_doctor reason is a member one of the
 *      three remote run_doctor reports (focused, tier ops, the page-class checks) calls and the served client refuses
 *      before sending, while every report still completes.
 * 2. Fails on: a remote doctor that reports a host action for a check whose read was refused, that returns local-only
 *    data, or a run_doctor-reason row that this run never refuses.
 * 3. Seam: none below the engine: a real owner, a real v3 listener, a real served client, the MCP dispatch.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAGE_CHECK_NAMES } from '../src/core/doctor-categories.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { listenServed, type ServedListener } from '../src/core/rust-engine/served/listener.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { loadRustArmAddon, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

const saved = process.env.GBRAIN_RUST_MULTIUSER;
const TOKEN = 'remote-doctor-owner-token';
const STDIO = { remote: true, admissionOrigin: 'interactive', transport: 'stdio', takesHoldersAllowList: ['world'], sourceId: 'default' } as const;
const SECRET_BODY = 'doctor-marker-private-body-7f3a';
const SECRET_CONFIG = 'doctor-marker-config-value-91c2';
const DOCTOR_REASON = 'reached remotely only through run_doctor (admin scope); skipped for a remote caller';
const OWN_SHAPES = ['connector_checkpoints', 'unbound_source', 'segmented_storage', 'fact_bulk_dates'];
type ReportCheck = { name: string; status: string; message: string; details?: { host_action?: { check_id: string; state: string } } };
type Report = { checks: ReportCheck[] };
let dir = '';
let owner: RustEngine;
let listener: ServedListener;
let client: RustEngine;
const refused = new Set<string>();
let text = '';
let report: Report;

/** The engine doctor runs on, recording each member the served client refused before sending (its refusal names the member). */
function recordRefusals(engine: RustEngine): RustEngine {
  const note = (error: unknown) => {
    const e = error as { code?: string; message?: string };
    const member = e?.code === 'engine_capability_missing' ? /^(\w+) cannot run from a second process on this brain:/.exec(e.message ?? '')?.[1] : undefined;
    if (member) refused.add(member);
  };
  return new Proxy(engine, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        try {
          const out = value.apply(target, args);
          return out instanceof Promise ? out.catch((error: unknown) => { note(error); throw error; }) : out;
        } catch (error) { note(error); throw error; }
      };
    },
  });
}

describeAddon('a remote run_doctor over the served wire', () => {
  beforeAll(async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    dir = mkdtempSync(join(tmpdir(), 'gbrain-remote-doctor-'));
    owner = openRustEngine({ addon: await loadRustArmAddon(), databasePath: dir, servedOptions: {
      verify: {
        verify: async (_engine, t) => { if (t !== TOKEN) throw new Error('Invalid token'); return { principal: { kind: 'legacy_token', id: 'owner' }, scopes: ['read', 'write', 'admin'], sourceId: 'default', hasSourceGrant: false, member: null, mayActFor: null, attest: null }; },
        ownerIds: async () => new Set(['owner']),
      },
    } });
    await owner.connect({ engine: 'rust', database_path: dir } as never);
    await owner.putPage('notes/secret', { type: 'note', title: 'Secret', compiled_truth: SECRET_BODY, timeline: '', frontmatter: { visibility: 'private' } } as never);
    await owner.setConfig('doctor.test_marker', SECRET_CONFIG);
    listener = await listenServed(owner.ownerServer()!, { host: '127.0.0.1', port: 0 });
    client = openRustEngine({ addon: await loadRustArmAddon(), databasePath: dir, served: { url: `gbrain+tcp://127.0.0.1:${listener.port}`, token: TOKEN } });
    await client.connect({ engine: 'rust', database_path: dir } as never);
    // The focused report, the ops tier and the page-class checks are the three remote run_doctor reports; each reaches
    // members the others do not.
    const texts: string[] = [];
    for (const params of [{}, { tier: 'ops' }, { only: [...PAGE_CHECK_NAMES] }]) {
      const out = await dispatchToolCall(recordRefusals(client), 'run_doctor', params, STDIO as never);
      expect({ params, error: out.isError === true }).toEqual({ params, error: false });
      texts.push((out.content as Array<{ text: string }>).map(c => c.text).join('\n'));
    }
    report = JSON.parse(texts[0]!) as Report;
    text = texts.join('\n');
  }, 300_000);

  afterAll(async () => {
    await client?.disconnect().catch(() => undefined);
    await listener?.close().catch(() => undefined);
    await owner?.disconnect().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = saved;
  });

  test('the owner runs multi-user and the client is a served multi-writer client', () => {
    expect({ multiuser: owner.openStore('remote-doctor').multiuser, served: client.capabilities.has('served'), mw: client.capabilities.has('multi_writer') })
      .toEqual({ multiuser: true, served: true, mw: true });
  });

  // Value: protects=a remote doctor names a check it could not run as unknown; fails_when=a refused read reports action_required; why_new=no test ran run_doctor through a served client
  test('every wave check the remote caller could not run reports unknown, never a host action', () => {
    const waves = report.checks.filter(c => c.details?.host_action);
    expect(waves.length).toBeGreaterThan(0);
    expect(waves.filter(c => c.details!.host_action!.state === 'action_required').map(c => c.name)).toEqual([]);
    const own = Object.fromEntries(OWN_SHAPES.map(id => {
      const c = waves.find(w => w.name === id);
      return [id, c ? { state: c.details!.host_action!.state, unknown: c.message.startsWith('Unknown: this check could not run for the remote caller') } : null];
    }));
    expect(own).toEqual(Object.fromEntries(OWN_SHAPES.map(id => [id, { state: 'unknown', unknown: true }])));
  });

  // Value: protects=each local-only row given the run_doctor reason is one a remote run_doctor reaches and the served client refuses; fails_when=a row gets that reason but doctor no longer calls it, or the client sends it; why_new=the reason was a claim no run checked
  test('every member listed as reached only through run_doctor is refused for the remote caller, and the report still completes', () => {
    const listed = readFileSync(join(import.meta.dir, 'fixtures/served-member-lists/local-only.tsv'), 'utf8').split('\n')
      .map(line => line.split('\t')).filter(row => row[1] === DOCTOR_REASON).map(row => row[0]!);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.filter(member => !refused.has(member))).toEqual([]);
  });

  test('no local-only data reaches the remote caller', () => {
    expect({ body: text.includes(SECRET_BODY), config: text.includes(SECRET_CONFIG), dir: text.includes(dir) })
      .toEqual({ body: false, config: false, dir: false });
  });
});
