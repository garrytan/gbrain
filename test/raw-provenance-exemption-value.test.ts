import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { rawProvenanceCheck } from '../src/commands/doctor/checks/core-health.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function store(frontmatter: Record<string, unknown>) {
  await engine.putPage('fixture-cobalt', {
    title: 'Fixture cobalt',
    type: 'synthesis',
    compiled_truth: 'Synthetic page without attached source material.',
    frontmatter,
    tags: [],
  });
}

test('a false exemption does not suppress the missing-provenance warning', async () => {
  await store({ raw_trace_exempt: false });
  expect((await rawProvenanceCheck(engine)).status).toBe('warn');
});

test('a true exemption satisfies the provenance check', async () => {
  await store({ raw_trace_exempt: true });
  expect((await rawProvenanceCheck(engine)).status).toBe('ok');
});

test('an absent exemption still requires provenance', async () => {
  await store({});
  expect((await rawProvenanceCheck(engine)).status).toBe('warn');
});

test('a source marker satisfies the check without an exemption', async () => {
  await store({ raw_source: 'fixture-source-material' });
  expect((await rawProvenanceCheck(engine)).status).toBe('ok');
});
