/**
 * Retrieval projection under the redaction policy
 * (src/core/credential-projection.ts retrievalTextProjection, the chunkers
 * that cut from it, and src/core/page-state/redaction-reseal.ts).
 *
 * Protects: (1) with no projection class the projection is byte-identical to
 * the private-key projection, so chunks of every existing brain are
 * unchanged; (2) with `identifier` set, no chunk, embedding input or
 * delivered evidence carries an identifier value — the token stands in and
 * the stored body is untouched; (3) switching the class list re-seals exactly
 * the pages that match under the old or the new list, records the sealed
 * list, and the doctor state reports pending in between. Regression it
 * catches: a chunker or evidence path that slices the raw body, or a re-seal
 * that skips pages whose tokens must be removed when a class is switched
 * off. Existing coverage (test/credential-projection.test.ts) pins only
 * private keys. Seams: __setRedactionPolicyForTests; real chunkers and
 * PGLite otherwise.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { credentialSafeProjection, retrievalTextProjection } from '../src/core/credential-projection.ts';
import { chunkText } from '../src/core/chunkers/recursive.ts';
import { prepareMarkdownChunks } from '../src/core/markdown-chunks.ts';
import { REDACTION_CONFIG_KEYS, __setRedactionPolicyForTests } from '../src/core/redaction-policy.ts';
import { redactionProjectionState, resealRedactionProjections } from '../src/core/page-state/redaction-reseal.ts';

const SSN = '078-05-1120';
const BODY = `# Intake note\n\nPatient alice-example came in on Tuesday.\nSSN ${SSN}, MRN: AB123456.\n\nPlan: follow up next week.\n`;
const page = (body: string) => `---\ntype: note\ntitle: Intake note\n---\n\n${body}`;

afterEach(() => __setRedactionPolicyForTests(null));

describe('retrievalTextProjection', () => {
  test('no projection class: byte-identical to the private-key projection', () => {
    expect(retrievalTextProjection(BODY)).toBe(credentialSafeProjection(BODY));
    expect(retrievalTextProjection(BODY)).toBe(BODY);
    expect(retrievalTextProjection('')).toBe('');
  });
  test('identifier class: tokens replace the values, line count is kept, idempotent', () => {
    __setRedactionPolicyForTests({ projection: ['identifier'] });
    const out = retrievalTextProjection(BODY);
    expect(out).not.toContain(SSN);
    expect(out).toContain('SSN <REDACTED:ssn>, MRN: <REDACTED:mrn>.');
    expect(out.split('\n').length).toBe(BODY.split('\n').length);
    expect(retrievalTextProjection(out)).toBe(out);
  });
  test('the recursive chunker and the markdown chunk preparer cut from the projection', async () => {
    __setRedactionPolicyForTests({ projection: ['identifier'] });
    const chunks = chunkText(BODY);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c.text).not.toContain(SSN);
    expect(chunks.map((c) => c.text).join('\n')).toContain('<REDACTED:ssn>');
    const prepared = await prepareMarkdownChunks({ compiled_truth: BODY, timeline: '' });
    expect(prepared.length).toBeGreaterThan(0);
    for (const c of prepared) expect(c.chunk_text).not.toContain(SSN);
  });
});

describe('re-seal on a policy change', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await resetPgliteState(engine);
  });
  afterAll(async () => { await engine.disconnect(); });

  const chunkTexts = async (slug: string) => (await engine.executeRaw<{ chunk_text: string }>(
    'SELECT c.chunk_text FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = $1 ORDER BY c.chunk_index', [slug])).map((r) => r.chunk_text);
  const body = async (slug: string) => (await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth;

  test('switching identifier on and off re-chunks only the matching page; stored bodies never change; the sealed list tracks the policy', async () => {
    expect(await importFromContent(engine, 'notes/intake', page(BODY), { sourceId: 'default', noEmbed: true })).toMatchObject({ status: 'imported' });
    expect(await importFromContent(engine, 'notes/plain', page('# Plain\n\nNothing identifying here, just a note about acme-example.\n'), { sourceId: 'default', noEmbed: true })).toMatchObject({ status: 'imported' });
    expect((await chunkTexts('notes/intake')).join('\n')).toContain(SSN);
    expect(await redactionProjectionState(engine)).toEqual({ sealed: [], wanted: [], pending: false });

    __setRedactionPolicyForTests({ projection: ['identifier'] });
    expect((await redactionProjectionState(engine)).pending).toBe(true);
    const on = await resealRedactionProjections(engine);
    expect(on).toMatchObject({ scanned: 2, resealed: 1, unchanged: 1, superseded: 0, failed: 0, classes: ['identifier'] });
    const sealedChunks = await chunkTexts('notes/intake');
    expect(sealedChunks.length).toBeGreaterThan(0);
    for (const c of sealedChunks) expect(c).not.toContain(SSN);
    expect(sealedChunks.join('\n')).toContain('<REDACTED:ssn>');
    expect(await body('notes/intake')).toContain(SSN);
    expect(await engine.getConfig(REDACTION_CONFIG_KEYS.sealedProjection)).toBe('identifier');
    expect((await redactionProjectionState(engine)).pending).toBe(false);

    __setRedactionPolicyForTests(null);
    expect((await redactionProjectionState(engine)).pending).toBe(true);
    const off = await resealRedactionProjections(engine);
    expect(off).toMatchObject({ scanned: 2, resealed: 1, unchanged: 1, failed: 0, classes: [] });
    expect((await chunkTexts('notes/intake')).join('\n')).toContain(SSN);
    expect(await engine.getConfig(REDACTION_CONFIG_KEYS.sealedProjection)).toBe('');
    expect((await redactionProjectionState(engine)).pending).toBe(false);
  });
});
