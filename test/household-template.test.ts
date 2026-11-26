/**
 * The household template's mechanics (agent platform plan, H2): preview writes nothing, --household-members changes
 * the shape, a re-run converges, and the receipt (d8) names its target and keeps key issuance apart from delivery, so a
 * resume never issues a second key on its own. PGLite, repo-less (the rules go to the database store). Invented names only.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { getMember, listMembers } from '../src/core/access/members.ts';
import { ownerMemberId } from '../src/core/access/owner.ts';
import { currentFolderRules, addFolderRules } from '../src/commands/access-rules.ts';
import { householdTemplate, householdTemplateStatus, parseHouseholdMembers, runHouseholdTemplate, templateLines, templateRules } from '../src/commands/household-template.ts';
import { loadReceipt } from '../src/commands/setup-template-receipt.ts';
import { mintToken } from '../src/commands/auth-mint.ts';
import { flushAccessReadLog } from '../src/core/access/read-log.ts';
import { withEnv } from './helpers/with-env.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const OWNER = 'alice-example';
let engine: PGLiteEngine;
let keyDir: string;
let receiptDir: string;

const run = (extra: Record<string, unknown> = {}) => householdTemplate(engine, { source: 'default', harness: 'codex', owner: OWNER, apply: true, keyDir, receiptDir, ...extra } as never);
const liveTokens = async () => (await engine.executeRaw<{ name: string }>('SELECT name FROM access_tokens WHERE revoked_at IS NULL ORDER BY name')).map(r => r.name);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  keyDir = mkdtempSync(join(tmpdir(), 'gbrain-hh-keys-'));
  receiptDir = mkdtempSync(join(tmpdir(), 'gbrain-hh-receipts-'));
});

afterEach(() => {
  rmSync(keyDir, { recursive: true, force: true });
  rmSync(receiptDir, { recursive: true, force: true });
});

describe('household template', () => {
  test('the preview lists the exact access and auth steps and writes nothing', async () => {
    const r = await run({ apply: false });
    expect(r.applied).toBe(false);
    expect(r.receipt_id).toBeNull();
    const commands = r.steps.flatMap(s => s.actions.map(a => a.command));
    expect(commands).toContain('gbrain access member add family-chat --kind audience');
    expect(commands).toContain('gbrain access member labelled-only helper on');
    expect(commands).toContain(`gbrain access group add household-adults --members ${OWNER},adult-b`);
    expect(commands).toContain('gbrain auth create member-adult-b --member adult-b --scopes read,write --sources default');
    expect(commands.some(c => c.startsWith('gbrain access rule add --id household-money-bill --prefix household/money/bill/ --readers ' + OWNER + ',group:household-adults'))).toBe(true);
    expect(templateLines(r).at(-1)).toBe('Nothing written. Add --yes to apply.');
    expect(await listMembers(engine)).toEqual([]);
    expect(await currentFolderRules(engine, 'default')).toEqual([]);
    expect(readdirSync(receiptDir)).toEqual([]);
    expect(readdirSync(keyDir)).toEqual([]);
  });

  test('--household-members changes the shape: a single parent, or three adults and no helper; a child is refused', async () => {
    expect(parseHouseholdMembers('none', OWNER).map(m => m.role)).toEqual(['owner']);
    expect(() => parseHouseholdMembers('child:robin-example', OWNER)).toThrow(/a child gets no member and no key/);
    expect(() => parseHouseholdMembers('adult:' + OWNER, OWNER)).toThrow(/twice/);
    const single = await run({ members: 'none' });
    expect(single.error).toBeUndefined();
    expect(single.keys).toEqual([]);
    expect(await engine.getConfig('access.serves')).toBeNull();
    expect(await ownerMemberId(engine)).toBe(OWNER);
    const three = await run({ members: 'adult:bob-example,adult:dana-example' });
    expect(three.error).toBeUndefined();
    expect(three.keys.map(k => [k.member, k.scopes.join(',')])).toEqual([['bob-example', 'read,write'], ['dana-example', 'read,write']]);
    expect(await engine.getConfig('access.serves')).toBe('several');
    expect((await getMember(engine, 'bob-example'))!.labelled_only).toBe(false);
  });

  test('a re-run converges: every step kept, no second key', async () => {
    const first = await run();
    expect(first.error).toBeUndefined();
    const tokens = await liveTokens();
    expect(tokens).toEqual(['member-adult-b', 'member-family-chat', 'member-helper']);
    const second = await run();
    expect(second.error).toBeUndefined();
    expect(second.steps.flatMap(s => s.actions.map(a => a.action)).filter(a => a !== 'keep' && a !== 'run')).toEqual([]);
    expect(await liveTokens()).toEqual(tokens);
    expect((await currentFolderRules(engine, 'default')).length).toBe(templateRules(OWNER).length);
  });

  test('a hand rule on a template folder is never overwritten: BLOCKED, and nothing is written', async () => {
    await addFolderRules(engine, 'default', [{ id: 'mine', prefix: 'household/money/bill/', readable_by: ['member:' + OWNER] }], { apply: true, json: true });
    const r = await run();
    expect(r.applied).toBe(false);
    const blocked = r.steps.find(s => s.id === 'rules')!.actions.find(a => a.action === 'blocked')!;
    expect(blocked.detail).toContain('rule "mine" already covers household/money/bill/');
    expect(await liveTokens()).toEqual([]);
    expect(readdirSync(receiptDir)).toEqual([]);
  });

  test('d8: a key issued but never delivered is not issued again on resume; after an explicit revoke the resume finishes', async () => {
    const stopped = await withEnv({ GBRAIN_SETUP_ABORT_AFTER: 'household-key-issued' }, () => run());
    expect(stopped.error?.message).toContain('household-key-issued');
    const id = stopped.receipt_id!;
    const receipt = loadReceipt(id, 'household', receiptDir);
    expect(receipt.steps.filter(s => s.state === 'done').map(s => s.id)).toEqual(['owner', 'members', 'labelled_only', 'groups', 'rules', 'config', 'replace']);
    expect(receipt.keys.map(k => [k.member, !!k.issued, !!k.delivered])).toEqual([['adult-b', true, false]]);
    expect(JSON.stringify(receipt)).not.toMatch(/gbrain_[A-Za-z0-9]/);

    const resumed = await run({ resume: id });
    const key = resumed.keys.find(k => k.member === 'adult-b')!;
    expect(resumed.applied).toBe(false);
    expect(key.action).toBe('blocked');
    expect(key.detail).toContain('was issued at');
    expect(key.detail).toContain('does not issue a second one on its own');
    expect(resumed.steps.filter(s => s.state === 'done').map(s => s.id)).toEqual(['owner', 'members', 'labelled_only', 'groups', 'rules', 'config', 'replace']);
    expect(await liveTokens()).toEqual(['member-adult-b']);

    await engine.executeRaw("UPDATE access_tokens SET revoked_at = now() WHERE name = 'member-adult-b'");
    const done = await run({ resume: id });
    expect(done.error).toBeUndefined();
    expect(done.receipt_id).toBe(id);
    expect(await liveTokens()).toEqual(['member-adult-b', 'member-family-chat', 'member-helper']);
    const after = loadReceipt(id, 'household', receiptDir);
    expect(after.steps.every(s => s.state === 'done')).toBe(true);
    expect(after.keys.every(k => k.issued && k.delivered && existsSync(k.path))).toBe(true);
    const status = await householdTemplateStatus(engine, { receipt: id, receiptDir });
    expect(status.complete).toBe(true);
    expect(status.proof.map(p => [p.member, p.key, p.ok])).toEqual([['adult-b', 'delivered', true], ['helper', 'delivered', true], ['family-chat', 'delivered', true]]);
  }, 120_000);

  test('d8: status and resume refuse a receipt written for another source or harness', async () => {
    const r = await run();
    await expect(householdTemplateStatus(engine, { receipt: r.receipt_id!, source: 'other', receiptDir })).rejects.toMatchObject({ code: 'setup_receipt_target_mismatch' });
    await expect(run({ resume: r.receipt_id!, harness: 'claude-code' })).rejects.toMatchObject({ code: 'setup_receipt_target_mismatch' });
    await expect(householdTemplateStatus(engine, { receipt: 'household-20260101T000000Z-abcdef', receiptDir })).rejects.toMatchObject({ code: 'setup_receipt_not_found' });
    expect(readFileSync(join(receiptDir, r.receipt_id + '.json'), 'utf8')).not.toContain(readFileSync(r.keys[0]!.path, 'utf8').trim());
  });

  test('with no owner configured and none named, the owner step is BLOCKED and nothing is written', async () => {
    const r = await householdTemplate(engine, { source: 'default', apply: true, keyDir, receiptDir });
    expect(r.applied).toBe(false);
    expect(r.steps[0]!.state).toBe('blocked');
    expect(await listMembers(engine)).toEqual([]);
  });
  test('gbrain household template --resume of a receipt for another source needs no --source: it takes the receipt\'s own', async () => {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', ['family-example']);
    const home = mkdtempSync(join(tmpdir(), 'gbrain-hh-home-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const stopped = await withEnv({ GBRAIN_SETUP_ABORT_AFTER: 'household-rules' }, () => householdTemplate(engine, { source: 'family-example', harness: 'codex', owner: OWNER, apply: true }));
        expect(stopped.error?.message).toContain('household-rules');
        const flags: Record<string, string> = { '--harness': 'codex', '--resume': stopped.receipt_id! };
        const log = console.log;
        console.log = () => {};
        try { await runHouseholdTemplate(engine, ['--yes'], true, f => flags[f]); } finally { console.log = log; }
        const after = loadReceipt(stopped.receipt_id!, 'household');
        expect(after.source_id).toBe('family-example');
        expect(after.steps.every(s => s.state === 'done')).toBe(true);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);

  test('a live member key with wider scopes or another grant than the template issues is BLOCKED, never kept as read-only', async () => {
    expect((await run()).error).toBeUndefined();
    const path = join(keyDir, 'helper.key');
    await engine.executeRaw("UPDATE access_tokens SET revoked_at = now() WHERE name = 'member-helper'");
    const wide = await mintToken(engine, 'member-helper', { scopes: ['read', 'write'], binding: { member: 'helper' }, sources: { kind: 'scalar', writeSource: 'default' } });
    writeFileSync(path, wide.token, { mode: 0o600 });
    const r = await run();
    const key = r.keys.find(k => k.member === 'helper')!;
    expect(key.action).toBe('blocked');
    expect(key.detail).toContain('grants read+write on source default, not read on source default only');
    expect(templateLines(r).some(l => l.startsWith('  key helper:'))).toBe(false);
  }, 120_000);

  test('a key file that cannot be written revokes the key it just issued, and a re-run issues a fresh one', async () => {
    const blocker = join(keyDir, 'not-a-dir');
    writeFileSync(blocker, '');
    const failed = await run({ keyDir: join(blocker, 'keys') });
    expect(failed.error).toBeDefined();
    expect(await liveTokens()).toEqual([]);
    const receipt = loadReceipt(failed.receipt_id!, 'household', receiptDir);
    expect(receipt.keys.every(k => k.issued === null && k.delivered === null)).toBe(true);
    const again = await run({ resume: failed.receipt_id!, keyDir: join(keyDir, 'keys') });
    expect(again.error).toBeUndefined();
    expect(await liveTokens()).toEqual(['member-adult-b', 'member-family-chat', 'member-helper']);
  }, 120_000);

  test('the --status proof leaves no read in the access log and keeps each key\'s last_used_at', async () => {
    const r = await run();
    expect(r.error).toBeUndefined();
    await flushAccessReadLog();
    await engine.executeRaw('DELETE FROM access_read_log');
    const status = await householdTemplateStatus(engine, { receipt: r.receipt_id!, receiptDir });
    expect(status.ok).toBe(true);
    await flushAccessReadLog();
    await Bun.sleep(50);
    expect(await engine.executeRaw('SELECT member FROM access_read_log')).toEqual([]);
    expect(await engine.executeRaw("SELECT name FROM access_tokens WHERE revoked_at IS NULL AND last_used_at IS NOT NULL")).toEqual([]);
  }, 120_000);
});
