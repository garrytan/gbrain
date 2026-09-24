import { expect, test } from 'bun:test';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { preparePersistedMutation } from '../src/core/persistence/service.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';

test('public page parameters cannot opt into trusted managed import or reconciliation', async () => {
  for (const remote of [false, true]) {
    for (const kind of ['managed_file_import', 'canonical_reconcile', 'managed_grandfather']) {
      const ctx = { remote } as OperationContext;
      await expect(submitPageMutation(ctx, { operation: 'put_page',
        params: { kind, slug: 'notes/fixture', content: 'Synthetic fixture', managedFileImport: true } }))
        .rejects.toMatchObject({ code: 'invalid_params' });
    }
  }
});

test('the internal import admission option cannot authorize remote or reconciliation payloads', async () => {
  for (const input of [
    { remote: true, params: { kind: 'managed_file_import' } },
    { remote: false, params: { kind: 'canonical_reconcile' } },
    { remote: false, params: { kind: 'managed_file_import', preview: {} } },
    { remote: false, params: { kind: 'managed_file_import', backup_reference: 'synthetic' } },
  ]) {
    await expect(submitPageMutation({ remote: input.remote } as OperationContext,
      { operation: 'put_page', params: input.params, managedFileImport: true })).rejects.toMatchObject({ code: 'invalid_params' });
  }
});

test('a skill-bundle request cannot fall through into canonical page reconciliation', async () => {
  await expect(preparePersistedMutation({} as BrainEngine, { operation: 'put_page', target_kind: 'skill_bundle', protocol_version: 2,
    intent: { kind: 'canonical_reconcile' } } as unknown as WriteRequest, { engine: 'pglite' }))
    .rejects.toMatchObject({ code: 'unsupported_mutation_protocol' });
});
