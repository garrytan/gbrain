import type { Migration } from './types.ts';

export const v065: Migration = {
  version: 65,
  name: 'oauth_clients_federated_read_gin_index',
  // v0.34.1 (#876): GIN index for array-containment lookups
  // (`WHERE p.source_id = ANY(federated_read)` and similar). The five
  // read-side ops fall back to scalar sourceId when no auth is set, so
  // this index only matters under load on federated-scoped clients.
  idempotent: true,
  sql: `
      CREATE INDEX IF NOT EXISTS idx_oauth_clients_federated_read
        ON oauth_clients USING GIN (federated_read);
    `,
};
