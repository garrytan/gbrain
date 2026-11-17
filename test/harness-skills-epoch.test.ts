/**
 * #5878: a bootstrap-managed shared-skills installation converges after the
 * same principal re-enrolls over MCP (leave_brain + join_brain moves the
 * server epoch on), against the real membership server behind the legacy
 * HTTP transport on PGLite (and on Postgres when DATABASE_URL is set).
 *
 * Protects: doctor's epoch comparison (`supersededEnrollments`) names the
 * stale receipt; `foresights bootstrap harness --refresh-skills`
 * (`refreshHarnessSkills`) makes the receipt and the native router adopt the
 * current epoch under the recorded credential; a local leave whose own epoch
 * was superseded completes instead of staying `remote_membership_pending`
 * forever (which blocked rotation from revoking the previous token).
 * Regression it catches: the pre-fix adapter, where only `join` rewrote the
 * receipt and `leave` treated `membership_inactive` as a pending retry.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { call, withTransportFixture } from './fixtures/shared-skills-transports.ts';
import { writeCredentials, type HarnessCredentials } from '../src/core/harness/credentials.ts';
import { installSharedSkillsConnection } from '../src/core/harness/shared-skills.ts';
import { writeHarnessReceipt, type HarnessReceipt } from '../src/core/bootstrap/format.ts';
import { localEnrollment, refreshHarnessSkills, supersededEnrollments } from '../src/core/bootstrap/harness-skills.ts';

test('re-enrollment over MCP is detected, refreshed in place and leaves converge', async () => {
  await withTransportFixture(async f => {
    await f.seed();
    const peer = f.peers.reader;
    const home = join(f.dir, 'gbrain-home');
    const root = join(home, 'bootstrap', 'shared-skills', 'codex', randomUUID());
    const nativeSkillsDir = join(f.dir, 'codex-skills');
    const credentials: HarnessCredentials = { version: 1, mcp_url: f.url, issuer_url: f.url.replace(/\/mcp$/, ''),
      client_id: peer.id, access_token: peer.token, shared_skills: { follow: true } };
    writeCredentials(join(root, 'credentials.json'), credentials);
    const installed = await installSharedSkillsConnection(credentials, { harness: 'codex', root, name: 'gbrain', nativeSkillsDir });
    expect(installed.status).toBe('restart_required');
    const first = localEnrollment(root)!;
    const receipt = { harness_receipt_version: 1, created_at: new Date().toISOString(), created_by: 'test', url: f.url, source_id: 'default',
      token: { name: 'bootstrap-harness', minted: false }, skills_policy: 'follow', harness_tokens: {}, targets: [],
      shared_skills: [{ host: 'codex', root, name: 'gbrain', url: f.url, status: installed.status }] } as HarnessReceipt;
    writeHarnessReceipt(home, receipt);
    expect(await supersededEnrollments(f.engine, receipt)).toEqual([]);

    await call(peer.client, 'leave_brain', { installation_id: first.installation_id, enrollment_epoch: first.enrollment_epoch });
    const rejoined = await call<{ enrollment_epoch: number }>(peer.client, 'join_brain', { adapter: 'codex', follow_policy: { approved: true } });
    expect(rejoined.enrollment_epoch).toBe(first.enrollment_epoch + 1);
    await expect(call(peer.client, 'sync_brain_skills', { installation_id: first.installation_id, enrollment_epoch: first.enrollment_epoch }))
      .rejects.toMatchObject({ code: 'membership_inactive' });
    expect(await supersededEnrollments(f.engine, receipt)).toEqual([{ host: 'codex', installation_id: first.installation_id,
      local_epoch: first.enrollment_epoch, server_epoch: rejoined.enrollment_epoch, active: true }]);

    const output: string[] = [];
    expect(await refreshHarnessSkills({ gbrainHome: home, runner: async () => ({ code: 0, stdout: '', stderr: '' }),
      nativeSkillsDir: () => nativeSkillsDir, log: line => output.push(line), logError: line => output.push(line) })).toBe(0);
    expect(output.join('\n')).toContain(`enrollment epoch ${first.enrollment_epoch} -> ${rejoined.enrollment_epoch}`);
    expect(localEnrollment(root)).toEqual({ installation_id: first.installation_id, enrollment_epoch: rejoined.enrollment_epoch });
    const adapterReceipt = JSON.parse(readFileSync(join(root, 'shared-skills', 'receipt.json'), 'utf8')) as { native_router_path: string };
    expect(readFileSync(adapterReceipt.native_router_path, 'utf8')).toContain(`enrollment_epoch ${rejoined.enrollment_epoch}`);
    expect(await supersededEnrollments(f.engine, receipt)).toEqual([]);
    expect(output.join('\n')).not.toContain(peer.token);

    await call(peer.client, 'leave_brain', { installation_id: first.installation_id, enrollment_epoch: rejoined.enrollment_epoch });
    await call(peer.client, 'join_brain', { adapter: 'codex', follow_policy: { approved: true } });
    const left = await installSharedSkillsConnection(credentials, { harness: 'codex', root, name: 'gbrain', nativeSkillsDir, remove: true }) as {
      status: string; remote_membership_pending?: boolean; remote_membership_reason?: string };
    expect(left.status).toBe('left');
    expect(left.remote_membership_pending).toBe(false);
    expect(left.remote_membership_reason).toBe('superseded');
  }, process.env.DATABASE_URL);
}, 180_000);
