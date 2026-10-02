import type { Migration } from './types.ts';

// Security wave ENG-2: chunks built before the credential-safe projection
// (src/core/credential-projection.ts) can hold private-key fragments with no
// fence, which no output scan can recognize. Only pages whose canonical body
// carries a private-key marker are affected, so only they are unsealed here:
// every retrieval path, local and remote, reads chunks through the current
// text-projection seal, so their old chunks are withheld from this statement
// on. Each page is queued for the keyless projection rebuild (reason
// 'credential_projection'); the v0.60.31 orchestrated migration re-chunks them
// with no provider calls. The chunker and safe-fence versions do not change.
// The marker literal is frozen as shipped; see page-state/credential-reseal.ts.
export const v189: Migration = {
  version: 189,
  name: 'pages_credential_projection_pending',
  idempotent: true,
  sql: `
    WITH marked AS (
      UPDATE pages p SET text_projection_revision = NULL
       WHERE p.deleted_at IS NULL AND p.page_kind IN ('markdown', 'code')
         AND (p.compiled_truth ~ '-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----'
           OR COALESCE(p.timeline, '') ~ '-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----')
      RETURNING p.source_id, p.slug, p.knowledge_revision
    )
    INSERT INTO page_projection_jobs(source_incarnation, slug, revision, reason)
      SELECT s.incarnation, marked.slug, marked.knowledge_revision, 'credential_projection'
        FROM marked JOIN sources s ON s.id = marked.source_id
      ON CONFLICT(source_incarnation, slug) DO UPDATE
        SET revision = EXCLUDED.revision, reason = EXCLUDED.reason, updated_at = now();
  `,
};
