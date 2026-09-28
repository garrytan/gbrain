/**
 * remember — graded confidence (additive v1 param, issue #5551).
 *
 * 1.0 remains the default (human-reviewed); a caller MAY pass a graded
 * confidence in [0,1] for machine-assessed facts. The value must reach BOTH
 * the facts row and the markdown facts-fence row (single writer, same
 * transaction), and out-of-range values fail with invalid_params + suggestion.
 * Absent param is byte-identical to the previous hardcoded-1 behavior, so
 * pre-existing clients and replayed write intents are unaffected.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { __setUsageLogPathForTests } from '../src/core/verbs/usage-log.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  home = mkdtempSync(join(tmpdir(), 'gbrain-remember-confidence-'));
  __setUsageLogPathForTests(join(home, 'usage.jsonl'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  __setUsageLogPathForTests(null);
  resetGateway();
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
});

async function callRemote(name: string, params: Record<string, unknown>) {
  const res = await dispatchToolCall(engine, name, params, {
    remote: true,
    takesHoldersAllowList: ['world'],
    sourceId: 'default',
  });
  return { isError: res.isError === true, body: JSON.parse(res.content[0].text) };
}

async function seedEntityPage(slug: string, title: string) {
  const res = await dispatchToolCall(engine, 'put_page', {
    slug,
    content: `---\ntitle: ${title}\ntype: person\n---\n\n# ${title}\n\nA synthetic test entity.\n`,
  }, { remote: false, sourceId: 'default' });
  if (res.isError) throw new Error(`seed put_page failed: ${res.content[0].text}`);
}

/** Fact rows for one exact fact text, straight from the store. */
async function factRow(factText: string): Promise<{ confidence: number; row_num: number | null } | undefined> {
  const rows = await engine.executeRaw<{ confidence: number; row_num: number | null }>(
    'SELECT confidence, row_num FROM facts WHERE fact = $1 ORDER BY id DESC LIMIT 1',
    [factText],
  );
  return rows[0];
}

describe('remember — graded confidence', () => {
  it('stores a graded confidence on the facts row and the fence row', async () => {
    await seedEntityPage('people/confidence-example', 'Confidence Example');
    const r = await callRemote('remember', {
      fact: 'graded claim at 0.5', provenance: 'machine-assessed, test', entity: 'people/confidence-example',
      confidence: 0.5,
    });
    expect(r.isError).toBe(false);

    const row = await factRow('graded claim at 0.5');
    expect(row).toBeDefined();
    expect(row!.confidence).toBe(0.5);
    // Fence row: the entity page's markdown fence carries the same value.
    const snap = await engine.readPageSnapshot('people/confidence-example', { sourceId: 'default', includeDeleted: true });
    expect(snap?.page.compiled_truth).toContain('0.5');
  });

  it('defaults to 1.0 when the param is absent (unchanged legacy behavior)', async () => {
    const r = await callRemote('remember', { fact: 'human-reviewed claim', provenance: 'test' });
    expect(r.isError).toBe(false);
    const row = await factRow('human-reviewed claim');
    expect(row).toBeDefined();
    expect(row!.confidence).toBe(1);
  });

  it('rejects out-of-range values with invalid_params + suggestion', async () => {
    // Numeric out-of-range passes schema validation and fails in the handler
    // with the specific remediation hint.
    for (const bad of [1.5, -0.1]) {
      const r = await callRemote('remember', { fact: `bad ${bad}`, provenance: 'test', confidence: bad });
      expect(r.isError).toBe(true);
      expect(r.body.error).toBe('invalid_params');
      expect(String(r.body.suggestion ?? '')).toContain('confidence');
    }
    // Wrong TYPE is rejected by the dispatcher's schema layer with the
    // generic check-the-schema suggestion.
    const str = await callRemote('remember', { fact: 'bad type', provenance: 'test', confidence: 'high' });
    expect(str.isError).toBe(true);
    expect(str.body.error).toBe('invalid_params');
    const row = await factRow('bad 1.5');
    expect(row).toBeUndefined();
  });

  it('accepts the [0,1] boundary values', async () => {
    const zero = await callRemote('remember', { fact: 'boundary zero', provenance: 'test', confidence: 0 });
    const one = await callRemote('remember', { fact: 'boundary one', provenance: 'test', confidence: 1 });
    expect(zero.isError).toBe(false);
    expect(one.isError).toBe(false);
    expect((await factRow('boundary zero'))!.confidence).toBe(0);
    expect((await factRow('boundary one'))!.confidence).toBe(1);
  });

  it('dry runs still validate the param without admitting intent', async () => {
    // dry_run rides on the params object (dispatch maps it onto ctx.dryRun).
    const res = await dispatchToolCall(engine, 'remember', {
      fact: 'dry run bad', provenance: 'test', confidence: 7, dry_run: true,
    }, { remote: true, takesHoldersAllowList: ['world'], sourceId: 'default' });
    expect(res.isError).toBe(true);
  });
});
