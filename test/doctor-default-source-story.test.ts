import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkDefaultSourceStory } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`DELETE FROM sources WHERE id <> 'default'`);
  await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
});

describe('default_source_story doctor check', () => {
  test('warns when db-only default has pages while named sources exist', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('sawyer-brain', 'sawyer-brain', '/tmp/brain', '{}'::jsonb)`,
    );
    await engine.putPage('dream-cycle-summaries/2026-05-29', {
      type: 'note',
      title: 'Dream cycle',
      compiled_truth: 'summary',
      timeline: '',
      frontmatter: {},
    });

    const check = await checkDefaultSourceStory(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('default is DB-only');
    expect(check.message).toContain('1 page');
  });

  test('ok when default has no pages in a multi-source brain', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('sawyer-brain', 'sawyer-brain', '/tmp/brain', '{}'::jsonb)`,
    );

    const check = await checkDefaultSourceStory(engine);
    expect(check.status).toBe('ok');
  });
});
