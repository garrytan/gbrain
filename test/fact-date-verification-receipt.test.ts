import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factBulkDatesCheck } from '../src/commands/doctor/checks/fact-bulk-dates.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { readDateVerificationIncarnation, readFactDatePin, readOriginalDateExcerpt } from '../src/core/engine-sql/fact-date-verification.ts';
import { findBulkFactDays } from '../src/core/facts/bulk-days.ts';
import { matchesDatedExcerpt } from '../src/core/facts/fact-date-proof.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { operationsByName } from '../src/core/operations.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { publishFactDateVerification, revokeFactDateVerification } from '../src/core/persistence/fact-date-verification.ts';
import { readLocalWriter, registerLocalWriterValue, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { compactReceipt, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const source = 'default';
const day = '2025-04-10';
const factSlug = 'fixtures/fact';
const originalSlug = 'fixtures/original';
const quote = '记者于 2025-04-10 登记交接完成。\n收件人于 2025-04-10 签收。';
const reference = 'See [the earlier handover](records/2025-04-10) for context.';
const otherReferences = ['See <https://example.invalid/log/2025-04-10> for the record.',
  '[retained log]: archives/2025-04-10'];
const originalText = `Earlier note. 📄\n\n${quote}\n\n${[reference, ...otherReferences].join('\n\n')}`;
const content = (type: string, title: string, body: string) => `---\ntype: ${type}\ntitle: ${title}\n---\n${body}\n`;
const factPage = (claim: string) => content('note', 'Fact fixture', 'Original claim.\n\n## Facts\n\n' +
  renderFactsTable([{ rowNum: 1, claim, kind: 'fact', confidence: 1, visibility: 'private',
    notability: 'medium', validFrom: day, source: 'synthetic journal', active: true }]));

test('repeated event days in one excerpt still form one date', () => {
  const repeated = `${day} 13:05: the first file was delivered.\n${day} 13:06: the second file was delivered.`;
  const matches = (text: string, before = '', after = '') => matchesDatedExcerpt({
    source_incarnation: randomUUID(), fact_id: 1, fact_digest: '0'.repeat(64), utc_day: day,
    original_page_id: 2, original_revision: randomUUID(), excerpt_start: Array.from(before).length + 1,
    excerpt_length: Array.from(text).length, excerpt_sha256: sha256(text),
  }, { text, before, after });
  expect(matches(repeated)).toBe(true);
  expect(matches(repeated.replace(`${day} 13:06`, '2025-04-09 13:06'))).toBe(false);
  expect(matches(repeated.replace(`${day} 13:06`, '2025-04-11 13:06'))).toBe(false);
  expect(matches(`${repeated}\nEarlier entry: [source](logs/${day}).`)).toBe(false);
  expect(matches(`${day} 13:05: the first file was delivered.\nThe second file was delivered on ${day}`, '', '0')).toBe(false);
  expect(matches(`${repeated}\nThe ${day} “Message Archive” contains both files.`)).toBe(false);
});

async function verifyNativeReceipt(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    const put = async (slug: string, text: string) => {
      const before = await engine.readPageSnapshot(slug, { sourceId: source });
      await operationsByName.put_page.handler(ctx, { slug, source_id: source, content: text,
        ...(before ? { expected_revision: before.revision } : {}) });
    };
    await put(originalSlug, content('note', 'Original report', originalText));
    const original = (await engine.readPageSnapshot(originalSlug, { sourceId: source }))!;
    const [archived] = await engine.executeRaw<{ count: number }>(
      'SELECT count(*)::int AS count FROM page_versions WHERE page_id=$1', [original.page.id]);
    expect(archived?.count).toBe(0);
    await put(factSlug, factPage('A delivery handover was recorded.'));
    const [id] = await engine.executeRaw<{ id: number }>(
      'SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND expired_at IS NULL', [source, factSlug]);
    const pin = (await readFactDatePin(engine, source, Number(id!.id)))!;
    await engine.transaction(async tx => {
      await tx.executeRaw("SET LOCAL TIME ZONE 'America/Los_Angeles'");
      expect(await readFactDatePin(tx, source, Number(id!.id))).toEqual(pin);
    });
    const [s] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [source]);
    const body = original.page.compiled_truth;
    const quoteIndex = body.indexOf(quote);
    expect(quoteIndex).toBeGreaterThan(0);
    const proof = { source_incarnation: s!.incarnation, fact_id: Number(id!.id), fact_digest: pin.fact_digest, utc_day: day,
      original_page_id: original.page.id, original_revision: original.revision,
      excerpt_start: Array.from(body.slice(0, quoteIndex)).length + 1, excerpt_length: Array.from(quote).length, excerpt_sha256: sha256(quote) };
    const state = () => engine.executeRaw<{ row: unknown }>('SELECT to_jsonb(f) AS row FROM facts f WHERE id=$1', [proof.fact_id]);
    const before = await state();
    const file = readFileSync(join(root, factSlug + '.md'), 'utf8');
    const evidenceFile = readFileSync(join(root, originalSlug + '.md'), 'utf8');
    const receipts = () => engine.executeRaw<{ id: string; request_id: string; state: string; outcome: unknown; slug: string;
      principal_kind: 'local_cli'; principal_id: string; compacted: boolean; intent: unknown }>(
      "SELECT id,request_id,state,outcome,slug,principal_kind,principal_id,compacted,intent FROM persistence_requests WHERE operation='verify_fact_date' ORDER BY sequence");

    await expect(publishFactDateVerification({ ...ctx, remote: true }, source, randomUUID(), proof)).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(publishFactDateVerification({ ...ctx, dryRun: true }, source, randomUUID(), proof)).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(publishFactDateVerification({ ...ctx, sourceId: 'outside' }, source, randomUUID(), proof)).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(publishFactDateVerification(ctx, source, randomUUID(), { ...proof, source_incarnation: randomUUID() })).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(await receipts()).toEqual([]);
    const local = await readLocalWriter(engine, 'cli');
    const brainId = (await engine.readPersistenceBrainId())!;
    const narrowed = { id: randomUUID(), lane: 'cli' as const, credential: randomUUID() };
    await registerLocalWriterValue(engine, narrowed, { sourceIds: [source], operations: null,
      scopes: ['write'], slugPrefixes: ['repairs/fact-date-verification'] });
    await withVerifiedLocalRegistration(engine, narrowed, async () => {
      await expect(publishFactDateVerification(ctx, source, randomUUID(), proof))
        .rejects.toMatchObject({ code: 'permission_denied' });
    });
    await expect(publishFactDateVerification(ctx, source, randomUUID(), proof,
      { brainId, principal: { kind: 'local_cli', id: randomUUID() } })).rejects.toMatchObject({ code: 'revision_conflict' });
    await expect(publishFactDateVerification(ctx, source, randomUUID(), proof,
      { brainId: randomUUID(), principal: { kind: 'local_cli', id: local.id } })).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(await receipts()).toEqual([]);
    expect(await readOriginalDateExcerpt(engine, 'outside', proof.original_page_id, proof.original_revision,
      proof.excerpt_start, proof.excerpt_length)).toBeNull();
    await expect(publishFactDateVerification(ctx, source, randomUUID(), { ...proof, excerpt_sha256: '0'.repeat(64) }))
      .rejects.toMatchObject({ code: 'revision_conflict' });
    await expect(publishFactDateVerification(ctx, source, randomUUID(), { ...proof,
      excerpt_start: Array.from(body.slice(0, body.indexOf(reference))).length + 1,
      excerpt_length: Array.from(reference).length, excerpt_sha256: sha256(reference) }))
      .rejects.toMatchObject({ code: 'revision_conflict' });
    for (const clipped of [day, `records/${day}`, `log/${day}`, `archives/${day}`]) {
      const start = body.indexOf(clipped, body.indexOf(reference));
      expect(start).toBeGreaterThan(0);
      await expect(publishFactDateVerification(ctx, source, randomUUID(), { ...proof,
        excerpt_start: Array.from(body.slice(0, start)).length + 1, excerpt_length: clipped.length,
        excerpt_sha256: sha256(clipped) })).rejects.toMatchObject({ code: 'revision_conflict' });
    }
    expect((await receipts()).filter(r => r.state === 'committed')).toEqual([]);

    const request = randomUUID();
    const path = join(root, '..', 'reviewed-date.json');
    const argv = ['fact-date-verification', '--source', source, '--evidence-file', path, '--json'];
    const { source_incarnation, fact_digest, ...anchor } = proof;
    const checked = { ...anchor, claim_sha256: sha256('A delivery handover was recorded.') };
    const writeManifest = (value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    const run = async (extra: string[] = []) => {
      const lines: string[] = [];
      const log = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
      try { await runRepairCommand(engine, [...argv, ...extra]); }
      finally { log.mockRestore(); }
      return JSON.parse(lines.join('\n'));
    };
    const commandInput = { mode: 'verify', rows: [{ request_id: request, evidence: checked }] };
    writeManifest(commandInput);
    const justBeforePreview = await receipts();
    await expect(run(['--apply'])).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(run(['--limit', '1'])).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(run(['--source', 'outside'])).rejects.toMatchObject({ code: 'invalid_params' });
    const preview = await run();
    expect(preview).toMatchObject({ mode: 'preview', action: 'verify', rows: [{ request_id: request, proof }] });
    expect(await receipts()).toEqual(justBeforePreview);
    for (const line of quote.split('\n')) expect(JSON.stringify(preview)).not.toContain(line);
    await expect(run(['--apply', '--expect', '0'.repeat(64)])).rejects.toMatchObject({ code: 'preview_changed' });
    writeManifest({ ...commandInput, rows: [{ request_id: request, evidence: { ...checked, claim_sha256: '0'.repeat(64) } }] });
    await expect(run(['--apply', '--expect', preview.preview_hash])).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(await receipts()).toEqual(justBeforePreview);
    writeManifest(commandInput);
    const applied = await run(['--apply', '--expect', preview.preview_hash]);
    expect(applied).toMatchObject({ mode: 'apply', action: 'verify', complete: true, receipts: [{ request_id: request, state: 'committed' }] });
    expect(await run(['--apply', '--expect', preview.preview_hash])).toEqual(applied);
    const result = (await getWriteRequestById(engine, applied.receipts[0].receipt_id))!;
    expect(result).toMatchObject({ state: 'committed', request_id: request, outcome: { verified_event_date: day, proof } });
    const retry = await publishFactDateVerification(ctx, source, request, proof);
    expect(retry.id).toBe(result.id);
    await expect(publishFactDateVerification(ctx, source, request, { ...proof, excerpt_start: proof.excerpt_start + 1 }))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });
    const committed = (await receipts()).filter(r => r.state === 'committed');
    expect(committed).toHaveLength(1);
    expect(committed[0]!.outcome).toMatchObject({ verified_event_date: day, proof, write_through: { written: false } });
    expect(await engine.readPageSnapshot(committed[0]!.slug, { sourceId: source })).toBeNull();
    for (const line of quote.split('\n')) expect(JSON.stringify(committed[0])).not.toContain(line);
    expect(await state()).toEqual(before);
    expect(readFileSync(join(root, factSlug + '.md'), 'utf8')).toBe(file);
    expect(readFileSync(join(root, originalSlug + '.md'), 'utf8')).toBe(evidenceFile);

    await put(originalSlug, content('note', 'Updated report', 'A later revision omits the old observation.'));
    expect(await run()).toEqual(preview);
    expect(await run(['--apply', '--expect', preview.preview_hash])).toEqual(applied);

    expect(await compactReceipt(engine, committed[0]!)).toMatchObject({ freed_bytes: expect.any(Number) });
    expect((await receipts()).find(r => r.request_id === request)).toMatchObject({
      compacted: true, intent: null, outcome: { verified_event_date: day, proof },
    });
    await put(factSlug, factPage('A different handover was recorded.'));
    await expect(publishFactDateVerification(ctx, source, randomUUID(), proof)).rejects.toMatchObject({ code: 'revision_conflict' });
    expect((await receipts()).filter(r => r.state === 'committed')).toHaveLength(1);
    const revocation = randomUUID();
    writeManifest({ mode: 'revoke', rows: [{ request_id: revocation, receipt_id: result.id }] });
    const undo = await run();
    expect(undo).toMatchObject({ mode: 'preview', action: 'revoke', rows: [{ request_id: revocation, receipt_id: result.id }] });
    const withdrawal = await run(['--apply', '--expect', undo.preview_hash]);
    expect(withdrawal).toMatchObject({ mode: 'apply', action: 'revoke', complete: true,
      receipts: [{ request_id: revocation, state: 'committed' }] });
    expect(await getWriteRequestById(engine, withdrawal.receipts[0].receipt_id))
      .toMatchObject({ state: 'committed', operation: 'revoke_fact_date_verification', outcome: { revoked_receipt_id: result.id } });
  }, { databaseUrl });
}

async function verifyDoctor(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    const put = async (slug: string, text: string) => {
      const before = await engine.readPageSnapshot(slug, { sourceId: source });
      await operationsByName.put_page.handler(ctx, { slug, source_id: source, content: text,
        ...(before ? { expected_revision: before.revision } : {}) });
    };
    const data = Array.from({ length: 200 }, (_, i) => ({
      claim: `Handover number ${i + 1} completed.`, quote: `Handover number ${i + 1} completed on ${day}.`,
    }));
    data.at(-1)!.quote += `\nThe closing receipt also dates that handover to ${day}.`;
    const entitySlug = (i: number) => `fixtures/entity-${i}`;
    const entityPage = (claims: string[]) => content('note', 'Entity fixture', 'Managed facts.\n\n## Facts\n\n' +
      renderFactsTable(claims.map((claim, i) => ({ rowNum: i + 1, claim, kind: 'fact', confidence: 1,
        visibility: 'private', notability: 'medium', validFrom: day, source: 'synthetic journal', active: true }))));
    await put(originalSlug, content('note', 'Original handover log', data.map(item => item.quote).join('\n')));
    const original = (await engine.readPageSnapshot(originalSlug, { sourceId: source }))!;
    for (let i = 0; i < 20; i++) await put(entitySlug(i), entityPage(data.slice(i * 10, i * 10 + 10).map(item => item.claim)));
    const raw = await findBulkFactDays(engine, [source]);
    expect(raw).toMatchObject([{ source_id: source, day, facts: 200, entities: 20, dated_claims: 0 }]);
    const check = async (status: 'ok' | 'warn', verified_facts: number, dated_claims = 0) => {
      const finding = await factBulkDatesCheck(engine, [source]);
      if (!Array.isArray(finding.details?.days)) throw new Error(finding.message);
      expect(finding.status).toBe(status);
      expect(finding.details!.days).toMatchObject([{ ...raw[0], dated_claims, verified_facts,
        evidence_status: status === 'ok' ? 'confirmed_same_day' : 'review_required' }]);
    };
    await check('warn', 0);
    const facts = await engine.executeRaw<{ id: number; fact: string }>(
      'SELECT id, fact FROM facts WHERE source_id=$1 AND expired_at IS NULL ORDER BY id', [source]);
    expect(facts).toHaveLength(200);
    const incarnation = (await readDateVerificationIncarnation(engine, source))!;
    const claims = new Map(data.map(item => [item.claim, item.quote]));
    const proofs = [];
    for (const f of facts) {
      const exact = claims.get(f.fact)!;
      const before = original.page.compiled_truth.slice(0, original.page.compiled_truth.indexOf(exact));
      const pin = (await readFactDatePin(engine, source, Number(f.id)))!;
      proofs.push({ ...pin, source_incarnation: incarnation, fact_id: Number(f.id),
        original_page_id: original.page.id, original_revision: original.revision,
        excerpt_start: Array.from(before).length + 1, excerpt_length: Array.from(exact).length, excerpt_sha256: sha256(exact) });
    }
    for (const proof of proofs.slice(0, -1)) await publishFactDateVerification(ctx, source, randomUUID(), proof);
    await check('warn', 199);
    const last = await publishFactDateVerification(ctx, source, randomUUID(), proofs.at(-1)!);
    await check('ok', 200);
    expect((await factBulkDatesCheck(engine, [])).details!.days).toEqual([]);
    await put(originalSlug, content('note', 'Latest handover log', 'Another revision of the current log.'));
    await check('ok', 200);

    await expect(revokeFactDateVerification(ctx, source, randomUUID(), incarnation, randomUUID()))
      .rejects.toMatchObject({ code: 'revision_conflict' });
    await expect(revokeFactDateVerification({ ...ctx, remote: true }, source, randomUUID(), incarnation, last.id))
      .rejects.toMatchObject({ code: 'permission_denied' });
    const request = randomUUID();
    const reversal = await revokeFactDateVerification(ctx, source, request, incarnation, last.id);
    expect(reversal).toMatchObject({ state: 'committed', outcome: { revoked_receipt_id: last.id } });
    expect((await revokeFactDateVerification(ctx, source, request, incarnation, last.id)).id).toBe(reversal.id);
    expect(await compactReceipt(engine, reversal)).toMatchObject({ freed_bytes: expect.any(Number) });
    expect(await getWriteRequestById(engine, reversal.id)).toMatchObject({ state: 'committed', compacted: true,
      intent: null, outcome: { revoked_receipt_id: last.id } });
    await check('warn', 199);
    expect(await findBulkFactDays(engine, [source])).toEqual(raw);
    await publishFactDateVerification(ctx, source, randomUUID(), proofs.at(-1)!);
    await check('ok', 200);
    await put(entitySlug(0), entityPage(['Handover wording changed.', ...data.slice(1, 10).map(item => item.claim)]));
    await check('warn', 199);
    const current = (await engine.readPageSnapshot(originalSlug, { sourceId: source }))!;
    await operationsByName.delete_page.handler(ctx, { slug: originalSlug, source_id: source, expected_revision: current.revision });
    await check('warn', 0);
    await put(entitySlug(0), entityPage(['Handover was on 2025-04-09.', ...data.slice(1, 10).map(item => item.claim)]));
    await check('warn', 0, 1);
  }, { databaseUrl });
}

for (const backend of testBackends()) {
  test(`local proof journals a retained original without changing the fact or files (${backend})`,
    () => verifyNativeReceipt(backend === 'postgres' ? requirePostgresTestDatabase() : undefined), 180_000);
  test(`Doctor retains raw counts and requires current evidence for all 200 facts (${backend})`,
    () => verifyDoctor(backend === 'postgres' ? requirePostgresTestDatabase() : undefined), 180_000);
}
