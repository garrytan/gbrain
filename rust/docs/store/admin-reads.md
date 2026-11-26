# Admin reads

The page read of the admin operations (`src/core/ops/admin.ts`), SQL in
`src/core/engine-sql/admin-reads.ts`, served by `gbrain_store::cli_reads::admin_reads`
(`readPagesForVersionHistory` is `tail_reads.rs`, `tail_reads.md`; TypeScript member in `src/core/rust-engine/store-members/admin-reads.ts`).

| Member | Answer | SQL |
|---|---|---|
| `brain.listVisiblePageSlugs(slugs, sourceIds, policy)` | `string[]`: the distinct slugs among `slugs` that name a live page (no `deleted_at`) in one of `sourceIds` (every source when null) that `policy` does not hide (`page_hidden`; a null policy hides nothing). Byte order; the SQL `SELECT DISTINCT` names no order | `listVisiblePageSlugs` |

The TypeScript member turns the policy part into the store page policy the way the retirement hop does
(`retirementHopPolicy` in `private-provenance.ts`): `read` is the caller's page policy
(`privatePagesFilterForCaller`, caller readers included), `access` the caller's member-access part
(`callerAccessAllowedSql`). A caller whose rendered policy is neither the no-caller text nor the canonical one for
its readers refuses before the read.
