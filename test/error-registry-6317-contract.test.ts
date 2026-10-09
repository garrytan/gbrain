/**
 * #6317 (T-06): the managed sync reliability contract's codes carry the full
 * agent-operator envelope. One contract case per code (`drain_stalled` with
 * its new `owner_wedged_here` cause, `two_consumers_on_host`,
 * `consumers_without_heartbeat`, `host_identity_mismatch`,
 * `managed_sync_not_moving`): registered with class, exit code and
 * `retryable`; `why` and a `fix` whose `next` derives per the v1 decision
 * table and whose `verify` is read-only; a docs anchor that resolves; and the
 * rendered CLI envelope an agent reads (`fix.argv` filled from the receipt's
 * `source_id`). The scanner case proves `sources writer status|movement` are
 * legal `fix.verify` commands while `sources writer claim` is not.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODES, codeEntry, codeRetryable, exitCodeForCode, type CodeEntry } from '../src/core/error-catalogue.ts';
import { errorCodeRow } from '../src/core/error-docs.ts';
import { cliRenderContext, deriveNext, renderAction, type RenderContext } from '../src/core/agent-output.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { envelopeFor } from './helpers/agent-envelope.ts';
import { scan } from '../scripts/check-agent-contract.ts';

const ROOT = join(import.meta.dir, '..');
const CONTRACT_CODES: string[] = ['drain_stalled', 'two_consumers_on_host', 'consumers_without_heartbeat', 'host_identity_mismatch', 'managed_sync_not_moving'];
const DOCTOR_CODES: string[] = ['two_consumers_on_host', 'consumers_without_heartbeat', 'host_identity_mismatch', 'managed_sync_not_moving'];

function headingAnchor(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}
function anchorsOf(path: string): Set<string> {
  const text = readFileSync(join(ROOT, path), 'utf8').replace(/^```[\s\S]*?^```/gm, '');
  const anchors = new Set<string>();
  for (const [, heading] of text.matchAll(/^#{1,6}\s+(.+)$/gm)) anchors.add(headingAnchor(heading!));
  for (const [, id] of text.matchAll(/<a id="([^"]+)"><\/a>/g)) anchors.add(id!);
  return anchors;
}
const stdio: RenderContext = { transport: 'stdio', isCallable: () => false, preapproved: () => false };

describe('#6317 codes are registered with a full envelope', () => {
  test.each(CONTRACT_CODES)('%s: class, exit 1, not retryable, why, actor, fix with read-only verify, resolving docs anchor', (code: string) => {
    const entry = codeEntry(code);
    expect(entry, `${code} is not in src/core/error-registry.ts`).toBeDefined();
    expect(['server', 'host_only']).toContain(entry!.class);
    expect(exitCodeForCode(code)).toBe(1);
    expect(codeRetryable(code)).toBe(false);
    expect(entry!.why?.length ?? 0).toBeGreaterThan(80);
    expect(entry!.summary.endsWith('.')).toBe(true);
    expect(entry!.fix).toBeDefined();
    expect(entry!.fix!.argv?.[0]).toBe('gbrain');
    expect(entry!.fix!.consent).toEqual([]);
    expect(entry!.fix!.verify?.argv?.[0]).toBe('gbrain');
    expect(entry!.fix!.why.length).toBeGreaterThan(20);
    const [path, anchor] = entry!.docs.split('#');
    expect(path).toMatch(/^docs\/guides\/(write-refusals|troubleshooting)\.md$/);
    expect(anchorsOf(path!).has(anchor!), `${code}: ${entry!.docs} does not resolve`).toBe(true);
    const row = errorCodeRow(code)!;
    expect(['agent', 'host_admin']).toContain(row.actor);
    expect(row.verify).toStartWith('gbrain ');
    expect(row.effects).toEqual([]);
  });

  test('the generated catalogue (docs/guides/error-codes.md) has a section per code', () => {
    const doc = readFileSync(join(ROOT, 'docs/guides/error-codes.md'), 'utf8');
    for (const code of CONTRACT_CODES) expect(doc).toContain(`<a id="${code}"></a>`);
  });

  test('every doctor-check code points its fix.verify at its own doctor check, so an agent closes the loop with one read', () => {
    for (const code of DOCTOR_CODES) {
      const entry = (CODES as Record<string, CodeEntry>)[code]!;
      expect(entry.fix!.verify!.argv).toEqual(['gbrain', 'doctor', '--only', code, '--json']);
      const rendered = renderAction(entry.fix!, cliRenderContext());
      expect(rendered.verify?.argv).toEqual(['gbrain', 'doctor', '--only', code, '--json']);
      expect(rendered.command).toStartWith('gbrain ');
    }
  });

  test('fix.next follows the v1 decision table: agent fixes run on the CLI and relay over stdio; the host_admin fix relays everywhere', () => {
    const agentCodes = CONTRACT_CODES.filter(code => (CODES as Record<string, CodeEntry>)[code]!.fix!.actor === 'agent');
    expect(agentCodes.length).toBeGreaterThanOrEqual(4);
    for (const code of agentCodes) {
      const fix = (CODES as Record<string, CodeEntry>)[code]!.fix!;
      expect(deriveNext(fix, cliRenderContext())).toBe('run');
      expect(deriveNext(fix, stdio)).toBe('tell_user_to_run');
    }
    const host = (CODES.host_identity_mismatch as CodeEntry).fix!;
    expect(host.actor).toBe('host_admin');
    expect(deriveNext(host, cliRenderContext())).toBe('tell_user_to_run');
    // `wait` is reachable only through actor `provider` (agent-output.ts deriveNext row 2): a wedged owner on this host is not a
    // provider, so a registry default can never say `wait`; the drain's own stop envelope carries `retry_after_ms` instead.
    expect(deriveNext({ ...host, actor: 'provider' }, cliRenderContext())).toBe('wait');
  });
});

describe('drain_stalled: the same-host stop has a cause vocabulary and a filled writer-status fix', () => {
  test('owner_wedged_here is a registered reason beside the earlier causes, and the row says what changed', () => {
    const entry = CODES.drain_stalled as CodeEntry;
    expect(entry.reasons).toEqual(['owner_wedged_here', 'owner_missing', 'preparation_overdue', 'publication_overdue', 'no_progress']);
    expect(entry.why).toContain('owner_wedged_here');
    expect(entry.why).toContain('retry_after_ms');
    expect(entry.why).not.toContain('nothing here can claim it');
    expect(entry.docs).toBe('docs/guides/write-refusals.md#drain-stalled');
  });

  test('the rendered CLI envelope fills --source from the receipt and names the owner in why', () => {
    const error = new OperationError('drain_stalled', 'Managed sync of source default stopped: the head write is held by gbrain serve (pid 4121) past the preparation ceiling.');
    error.reason = 'owner_wedged_here';
    error.why = 'gbrain serve (pid 4121, nonce 7f3a) on this host has held request 01J9 at step import_screen for 660 s; the ceiling has passed, so only a restart of that process frees the root.';
    error.receiptFields = { operation: 'managed_sync_import', source_id: 'default', slug: null, principal_kind: 'cli', principal_id: 'local_cli' };
    const env = envelopeFor(error, 'cli');
    expect(env).toMatchObject({ code: 'drain_stalled', reason: 'owner_wedged_here', class: 'server', retryable: false, contract_version: 1 });
    expect(env.why).toContain('pid 4121');
    expect(env.fix?.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', 'default', '--json']);
    expect(env.fix?.next).toBe('run');
    expect(env.fix?.verify?.argv).toEqual(['gbrain', 'doctor', '--only', 'managed_sync_not_moving', '--json']);
    expect(env.docs).toContain('docs/guides/write-refusals.md#drain-stalled');
    expect(env.docs_cmd).toEqual(['gbrain', 'errors', 'drain_stalled']);
    expect(env.suggestion).toContain('gbrain sources writer status --source default --json');
  });

  test('the write-refusals row and the live-sync outcome table carry the new meaning, not the old one', () => {
    const refusals = readFileSync(join(ROOT, 'docs/guides/write-refusals.md'), 'utf8');
    const row = refusals.split('\n').find(line => line.includes('<a id="drain-stalled"></a>'))!;
    expect(row).toContain('owner_wedged_here');
    expect(row).toContain('retry_after_ms');
    expect(row).toContain('safe_to_loop: true');
    expect(row).not.toContain('nothing on this host can claim it');
    const liveSync = readFileSync(join(ROOT, 'docs/guides/live-sync.md'), 'utf8');
    expect(liveSync).toContain('| `blocked` / `drain_stalled` | 1 |');
    expect(liveSync).toContain('### One consumer per host');
    expect(liveSync).toContain('persistence.single_consumer');
    expect(liveSync).toContain('--no-delegate');
  });
});

describe('the doctor codes each have a troubleshooting symptom row that names who acts, consent and a verify step', () => {
  const doc = readFileSync(join(ROOT, 'docs/guides/troubleshooting.md'), 'utf8');
  const rows = doc.split('\n').filter(line => line.startsWith('| [') || line.startsWith('| `') || line.startsWith('| A ') || line.startsWith('| The '));
  test.each([...DOCTOR_CODES, 'owner_wedged_here'])('%s', (code: string) => {
    const row = rows.find(line => line.includes(code) && line.split(' | ').length >= 5);
    expect(row, `no symptom row names ${code}`).toBeDefined();
    const cells = row!.split(' | ');
    expect(cells[2]!.length).toBeGreaterThan(10);
    expect(cells[3]!.length).toBeGreaterThan(3);
    expect(cells[4]!).toContain('gbrain ');
  });

  test('the parked-catch-up section is a two-call journey and the transcript names each step', () => {
    expect(doc).toContain('<a id="managed-sync-not-moving"></a>');
    expect(doc).toContain('<a id="managed-sync-wedge-transcript"></a>');
    for (const step of ['gbrain sources status default --json', 'gbrain doctor --only managed_sync_not_moving --json', 'gbrain sources writer status --source default --json', 'gbrain sources retry-held default', 'gbrain sources writer movement default']) {
      expect(doc, `transcript lacks ${step}`).toContain(step);
    }
    expect(doc).toContain('"next": { "code": "claim_overdue"');
    expect(doc).toContain('cause=owner_wedged_here');
    expect(doc).not.toContain('budget times its attempts');
  });
});

describe('the contract scanner accepts writer status and movement as read-only verify steps', () => {
  test('sources writer status|movement pass; sources writer claim is still flagged', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-6317-scanner-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, 'baselines'), { recursive: true });
      writeFileSync(join(root, 'src', 'fixes.ts'), [
        "export const ok1 = { fix: { argv: ['gbrain', 'doctor'], consent: [], actor: 'agent', why: 'w', requires_exclusive: false, verify: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', 'default', '--json'] } } };",
        "export const ok2 = { fix: { argv: ['gbrain', 'doctor'], consent: [], actor: 'agent', why: 'w', requires_exclusive: false, verify: { argv: ['gbrain', 'sources', 'writer', 'movement', 'default'] } } };",
        "export const ok3 = { fix: { argv: ['gbrain', 'doctor'], consent: [], actor: 'agent', why: 'w', requires_exclusive: false, verify: { argv: ['gbrain', 'sources', 'status', 'default', '--json'] } } };",
        "export const bad = { fix: { argv: ['gbrain', 'doctor'], consent: [], actor: 'agent', why: 'w', requires_exclusive: false, verify: { argv: ['gbrain', 'sources', 'writer', 'claim', 'default'] } } };",
        '',
      ].join('\n'));
      const hits = scan(root).filter(h => h.rule === 'verify-not-read-only');
      expect(hits.map(h => h.line)).toEqual([4]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
