/**
 * Hermetic source-resolver and `sources` stubs fake `executeRaw` by matching SQL text. The source resolver and
 * `sources list` now read through two typed engine members, `getStats` and `listAllSources`. This helper adds both
 * members to such a stub and answers them through the stub's own `executeRaw`, with the statements those call sites
 * ran before the switch, so each stub's existing row fakes keep driving the same branches.
 *
 * It covers only the two call shapes those sites use: a page count for one source, and the sole-non-default
 * candidate listing (`listAllSources({ localPathOnly: true })`). The real members are pinned by the engine parity
 * suite, not here.
 */
type RawStub = { executeRaw: (sql: string, params?: unknown[]) => Promise<unknown[]> };

export function withTypedSourceReads<E>(engine: E): E {
  const raw = (engine as unknown as RawStub).executeRaw;
  return Object.assign(engine as object, {
    getStats: async (opts: { sourceId?: string; sourceIds?: string[] } = {}) => {
      const id = opts.sourceIds?.[0] ?? opts.sourceId ?? 'default';
      // The id is inlined so stubs that match the old emptiness probe's literal text still match.
      const rows = (await raw(
        `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = '${id}' AND deleted_at IS NULL`,
        [id],
      )) as Array<{ n?: number }>;
      return { page_count: rows[0]?.n ?? rows.length };
    },
    listAllSources: async () =>
      raw(
        `SELECT id, config FROM sources WHERE local_path IS NOT NULL AND id != 'default' AND archived = false AND config->>'role' IS DISTINCT FROM 'storage_manifest'`,
      ),
  }) as E;
}
