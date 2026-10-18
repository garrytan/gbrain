/**
 * #6742: the pinned-question writer stamps `type: question`
 * (QUESTION_PAGE_TYPE), so the stock base pack (gbrain-base-v2, the init
 * default) and packs extending it (company-brain) must declare it.
 *
 * Protects: a pinned question on a default brain never trips doctor
 * `schema_pack_consistency` (`page_type_undeclared`), whose advice to retype
 * or declare the type is wrong because the writer restores `question`.
 * Regression: a pack edit that drops the `question` page type.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSchemaPackConsistency } from '../src/commands/doctor/schema-pack-checks.ts';
import { classifyStoredType } from '../src/core/schema-pack/type-usage.ts';
import { bundledPackPath } from '../src/core/schema-pack/bundled-assets.ts';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';
import { mergeInheritedManifest } from '../src/core/schema-pack/merge.ts';
import { QUESTION_PAGE_TYPE } from '../src/core/questions/identity.ts';
import { pinQuestion } from '../src/core/questions/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { ENTITY, MODEL, QUESTION, localCtx, seedBrain, stubChat } from './helpers/pinned-questions-fixture.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
  await engine.setConfig('models.standing_questions', MODEL);
}, 120_000);

afterAll(async () => {
  await engine?.disconnect();
}, 60_000);

describe('#6742 question page type in the stock base pack', () => {
  test('a pinned question on a gbrain-base-v2 brain is a declared type and the consistency check stays ok', async () => {
    const s = await seedBrain(engine);
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-pinned-questions' }, () =>
      pinQuestion(localCtx(engine, s.sourceId), { question: QUESTION, scope: { entity: ENTITY } }, { chat: stubChat().fn }));
    const rows = await engine.executeRaw<{ type: string }>(`SELECT type FROM pages WHERE source_id = $1 AND slug LIKE 'questions/%'`, [s.sourceId]);
    expect(rows.map(r => r.type)).toEqual([QUESTION_PAGE_TYPE]);
    const check = await checkSchemaPackConsistency(engine, { sourceIds: [s.sourceId] });
    expect(check.message).toBe('All pages match the active schema pack across every source.');
    expect(check.status).toBe('ok');
  }, 60_000);

  test('gbrain-base-v2 declares question as a non-extractable annotation, and company-brain inherits it', () => {
    const base = loadPackFromFile(bundledPackPath('gbrain-base-v2')!);
    expect(classifyStoredType(QUESTION_PAGE_TYPE, base)).toEqual({ kind: 'canonical' });
    expect(base.page_types.find(t => t.name === QUESTION_PAGE_TYPE)).toMatchObject({
      primitive: 'annotation', path_prefixes: [], extractable: false, expert_routing: false,
    });
    const company = mergeInheritedManifest([base], loadPackFromFile(bundledPackPath('company-brain')!), { page_types: [], link_types: [] });
    expect(classifyStoredType(QUESTION_PAGE_TYPE, company)).toEqual({ kind: 'canonical' });
  });
});
