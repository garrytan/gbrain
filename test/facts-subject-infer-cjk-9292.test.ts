/**
 * #9292: a registered CJK name opening a fact as its subject links in write mode.
 * Fails when weak CJK candidates are filtered before lookup (no_mention). Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { inferFactSubject } from '../src/core/facts/subject-infer.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({}); await engine.initSchema();
  await importFromContent(engine, 'people/subject-example', '---\ntitle: 陈某甲\naliases: [陈某甲]\ntype: person\nfacts_backstop: false\n---\n\n# 陈某甲\n', { noEmbed: true });
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

const infer = (fact: string) => inferFactSubject(engine, 'default', { fact, mode: 'write' });

describe('CJK exact-name subject', () => {
  test('links the registered name as subject', async () => {
    expect((await infer('陈某甲负责修改纪要。')).slug).toBe('people/subject-example');
  });
  test('longer name stays unlinked', async () => {
    expect((await infer('陈某甲乙负责修改纪要。')).slug).toBeNull();
  });
  test('incidental mention stays unlinked', async () => {
    expect((await infer('李某乙通知了陈某甲。')).slug).toBeNull();
  });
});
