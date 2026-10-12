/**
 * Redact-on-write (src/core/redaction-on-write.ts via settleContentDisposition
 * in src/core/import-screen.ts, surfaced on ImportResult.redacted).
 *
 * Protects: with `redaction.on_write` off every write is stored raw; with it
 * on, a write declared at an untrusted tier stores the token in place of each
 * claimed identifier, its chash and chunks follow the stored text, and the
 * receipt names pattern + fingerprint only; owner-tier writes and writes with
 * no declared tier stay raw; `facts` scope touches only facts-fence rows.
 * Regression it catches: the splice moving after the hash (a hash-match skip
 * would then keep raw text), or the tier routing dropping. Existing coverage
 * has no on-write path. Seams: __setRedactionPolicyForTests; real import on
 * PGLite otherwise.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { REDACTION_CONFIG_KEYS, __setRedactionPolicyForTests } from '../src/core/redaction-policy.ts';
import { applyOnWriteRedaction, onWriteRedactionApplies } from '../src/core/redaction-on-write.ts';

const SSN = '078-05-1120';
const BODY = `# Intake note\n\nPatient alice-example, SSN ${SSN}, MRN: AB123456.\n`;
const page = (body: string, title = 'Intake note') => `---\ntype: note\ntitle: ${title}\n---\n\n${body}`;
const ON = { onWrite: 'all' as const, onWriteClasses: ['identifier' as const] };
/** The import re-reads the brain's config snapshot, so the policy under test lives in config rows, as it does for an operator. */
async function setPolicy(rows: Partial<Record<'onWrite' | 'onWriteClasses', string>>): Promise<void> {
  for (const [field, key] of [['onWrite', REDACTION_CONFIG_KEYS.onWrite], ['onWriteClasses', REDACTION_CONFIG_KEYS.onWriteClasses]] as const) {
    const value = rows[field];
    if (value === undefined) await engine.unsetConfig(key); else await engine.setConfig(key, value);
  }
}

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await resetPgliteState(engine);
});
afterAll(async () => { await engine.disconnect(); });
afterEach(async () => { await setPolicy({}); __setRedactionPolicyForTests(null); });

const stored = async (slug: string) => {
  const p = (await engine.getPage(slug, { sourceId: 'default' }))!;
  const chunks = (await engine.executeRaw<{ chunk_text: string }>('SELECT c.chunk_text FROM content_chunks c WHERE c.page_id = $1', [p.id])).map((r) => r.chunk_text);
  return { body: p.compiled_truth, title: p.title, hash: p.content_hash, chunks };
};

describe('importFromContent', () => {
  test('policy off: an agent_written page is stored raw with no receipt', async () => {
    const r = await importFromContent(engine, 'notes/raw', page(BODY), { sourceId: 'default', noEmbed: true, writeGate: { tier: 'agent_written' } });
    expect(r).toMatchObject({ status: 'imported' });
    expect(r.redacted).toBeUndefined();
    expect((await stored('notes/raw')).body).toContain(SSN);
  });
  test('on_write=all, identifier: agent_written stores tokens; the receipt carries pattern + fingerprint, never the value', async () => {
    await setPolicy({ onWrite: 'all', onWriteClasses: 'identifier' });
    const r = await importFromContent(engine, 'notes/agent', page(BODY), { sourceId: 'default', noEmbed: true, writeGate: { tier: 'agent_written' } });
    expect(r).toMatchObject({ status: 'imported' });
    expect(r.redacted?.map((x) => [x.field, x.pattern])).toEqual([['body', 'ssn'], ['body', 'mrn']]);
    for (const x of r.redacted ?? []) expect(x.fingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(JSON.stringify(r.redacted)).not.toContain(SSN);
    const s = await stored('notes/agent');
    expect(s.body).not.toContain(SSN);
    expect(s.body).toContain('SSN <REDACTED:ssn>, MRN: <REDACTED:mrn>.');
    for (const c of s.chunks) expect(c).not.toContain(SSN);
    // The hash covers the stored (redacted) body: the same raw write again is a no-op, not a re-store of raw text.
    const again = await importFromContent(engine, 'notes/agent', page(BODY), { sourceId: 'default', noEmbed: true, writeGate: { tier: 'agent_written' } });
    expect(again.status).toBe('skipped');
    expect((await stored('notes/agent')).hash).toBe(s.hash);
  });
  test('owner tiers and undeclared writes stay raw under the same policy', async () => {
    await setPolicy({ onWrite: 'all', onWriteClasses: 'identifier' });
    for (const [slug, opts] of [['notes/curated', { writeGate: { tier: 'operator_curated' as const } }], ['notes/owner', {}]] as const) {
      const r = await importFromContent(engine, slug, page(BODY), { sourceId: 'default', noEmbed: true, ...opts });
      expect(r.redacted).toBeUndefined();
      expect((await stored(slug)).body).toContain(SSN);
    }
  });
  test('on_write=all redacts the title too; a policy whose class list is empty writes raw', async () => {
    await setPolicy({ onWrite: 'all', onWriteClasses: 'identifier' });
    const r = await importFromContent(engine, 'notes/titled', page(BODY, `Visit for SSN ${SSN}`), { sourceId: 'default', noEmbed: true, writeGate: { tier: 'external_untrusted' } });
    expect(r.redacted?.some((x) => x.field === 'title' && x.pattern === 'ssn')).toBe(true);
    expect((await stored('notes/titled')).title).toBe('Visit for SSN <REDACTED:ssn>');
    await setPolicy({ onWrite: 'all', onWriteClasses: 'none' });
    const r2 = await importFromContent(engine, 'notes/empty-classes', page(BODY), { sourceId: 'default', noEmbed: true, writeGate: { tier: 'agent_written' } });
    expect(r2.redacted).toBeUndefined();
    expect((await stored('notes/empty-classes')).body).toContain(SSN);
  });
});

describe('applyOnWriteRedaction (unit)', () => {
  test('tier routing: untrusted tiers only, and only with a mode and a class', () => {
    expect(onWriteRedactionApplies('agent_written', { ...ON, projection: [], egress: [] })).toBe(true);
    expect(onWriteRedactionApplies('unknown', { ...ON, projection: [], egress: [] })).toBe(true);
    expect(onWriteRedactionApplies('tool_observed', { ...ON, projection: [], egress: [] })).toBe(false);
    expect(onWriteRedactionApplies(undefined, { ...ON, projection: [], egress: [] })).toBe(false);
    expect(onWriteRedactionApplies('agent_written', { onWrite: 'off', onWriteClasses: ['identifier'], projection: [], egress: [] })).toBe(false);
  });
  test('facts scope: rows inside ```facts fences are redacted, prose outside is kept', () => {
    const parsed = { title: `SSN ${SSN}`, compiled_truth: `Prose SSN ${SSN} stays.\n\n\`\`\`facts\n| alice-example | ssn | ${SSN} |\n\`\`\`\n\nMore prose.\n`, timeline: `SSN ${SSN}` };
    const receipts = applyOnWriteRedaction(parsed, 'agent_written', { onWrite: 'facts', onWriteClasses: ['identifier'], projection: [], egress: [] });
    expect(receipts).toEqual([{ field: 'body', pattern: 'ssn', fingerprint: expect.stringMatching(/^sha256:/) }]);
    expect(parsed.compiled_truth).toBe(`Prose SSN ${SSN} stays.\n\n\`\`\`facts\n| alice-example | ssn | <REDACTED:ssn> |\n\`\`\`\n\nMore prose.\n`);
    expect(parsed.title).toBe(`SSN ${SSN}`);
    expect(parsed.timeline).toBe(`SSN ${SSN}`);
  });
});
