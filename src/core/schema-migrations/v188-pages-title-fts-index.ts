import type { Migration } from './types.ts';
import { getFtsLanguage } from '../fts-language.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

export const v188: Migration = {
  version: 188,
  name: 'pages_title_fts_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    // Match the search expression for the language configured at upgrade time.
    const language = getFtsLanguage();
    const indexName = `idx_pages_title_fts_${language}`;
    if (engine.kind === 'postgres') await dropInvalidConcurrentIndex(engine, 188, indexName);
    await engine.runMigration(188,
      `CREATE INDEX ${engine.kind === 'postgres' ? 'CONCURRENTLY ' : ''}IF NOT EXISTS ${indexName}
         ON pages USING gin (to_tsvector('${language}', COALESCE(title, '')));`);
  },
};
