import { expect, test } from 'bun:test';
import type { OperationContext } from '../src/core/operations.ts';
import { verbError } from '../src/core/ops/contract.ts';
import { runRememberBatch } from '../src/core/remember-batch.ts';

// Protect batch entity defaults at the single-item handler boundary, in both
// validation and admission. Omitting entity from shared defaults breaks this.
// Existing batch tests cover shared provenance but never a shared entity.
// The handler callback is an existing production seam; no new seam is needed.
test('batch entity reaches validation and admission while item entities take precedence', async () => {
  const validated: unknown[] = [];
  const admitted: unknown[] = [];
  const ctx = { remote: false } as OperationContext;
  const out = await runRememberBatch(ctx, {
    entity: 'people/subject-example',
    provenance: 'synthetic session',
    items: [
      { fact: 'Prefers tea' },
      'Ships weekly',
      { fact: 'Prefers coffee', entity: 'people/other-example' },
      { fact: 'An unscoped note', entity: null },
    ],
  }, async (context, item) => {
    (context.dryRun ? validated : admitted).push(item.entity);
    return { status: 'saved' };
  }, (code, message, suggestion) => verbError(code as never, message, suggestion));

  const expected = ['people/subject-example', 'people/subject-example', 'people/other-example', null];
  expect(validated).toEqual(expected);
  expect(admitted).toEqual(expected);
  expect(out.saved).toBe(4);
});
