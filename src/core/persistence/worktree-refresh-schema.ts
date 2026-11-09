/**
 * `gbrain sources refresh` storage (F0): one row per coordinated fast-forward
 * of a managed worktree. The canonical DDL copy is used by the schema
 * migration and, through scripts/build-schema.ts FRAGMENTS, by fresh installs.
 * The partial unique index makes "one active refresh per worktree" a database
 * fact; its unique violation maps to `refresh_in_progress`.
 *
 * The predicate constants live here, beside the DDL and free of imports, so
 * journal.ts and effect-journal.ts can embed them without an import cycle.
 */

export const WORKTREE_REFRESH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS persistence_worktree_refreshes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worktree_id uuid NOT NULL REFERENCES persistence_worktrees(id),
  source_ids text[] NOT NULL,
  principal_id uuid NOT NULL,
  owner_epoch bigint NOT NULL,
  topology_generation bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('draining','fenced','merged','syncing','completed','aborted','recovery_required')),
  old_head text NOT NULL,
  target_head text NOT NULL,
  upstream_ref text NOT NULL,
  preserved_uncommitted text[] NOT NULL DEFAULT '{}',
  outcome jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS persistence_worktree_refreshes_active
  ON persistence_worktree_refreshes(worktree_id)
  WHERE state IN ('draining','fenced','merged','syncing','recovery_required');
CREATE INDEX IF NOT EXISTS persistence_worktree_refreshes_completed
  ON persistence_worktree_refreshes(worktree_id, completed_at DESC) WHERE state='completed';
`;

export const ACTIVE_REFRESH_STATES = ['draining', 'fenced', 'merged', 'syncing', 'recovery_required'] as const;
export type WorktreeRefreshState = typeof ACTIVE_REFRESH_STATES[number] | 'completed' | 'aborted';

/** SQL list of the active states, matching the partial unique index. */
export const ACTIVE_REFRESH_STATES_SQL = "('draining','fenced','merged','syncing','recovery_required')";

/**
 * Effect kinds that touch the checkout. Embedding and facts-backstop effects
 * read only the database, so a refresh neither waits for them nor stops them.
 */
export const CHECKOUT_EFFECT_KINDS_SQL = "('git','withdrawal-mirror')";

/**
 * PR B (docs/designs/REFRESH_WRITE_BARRIER.md): a `deferred` request whose holds are all released is waiting work like a
 * queued row; one whose refresh is still running, or (GST-1582) whose import has not landed (`sources.last_commit` still
 * the commit it was held at), is invisible to every claim, head and drain check.
 */
export const RELEASED_DEFERRED = (r: string) => `(${r}.state='deferred' AND (${r}.deferred_refresh_id IS NOT NULL OR ${r}.deferred_import_from IS NOT NULL)
        AND (${r}.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes released
          WHERE released.id=${r}.deferred_refresh_id AND released.released_at IS NOT NULL))
        AND (${r}.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources imported
          WHERE imported.id=${r}.source_id AND COALESCE(imported.last_commit,'')<>${r}.deferred_import_from)))`;

/**
 * Claim predicate for a row aliased `alias` whose `column` (default `worktree_id`) names the worktree: while
 * a refresh holds the checkout fence (`fenced`, `merged`) or its HEAD is
 * unverified (`recovery_required`), nothing on that worktree is claimed.
 * `draining` and `syncing` keep claiming, so queued work drains and the
 * refresh's own managed sync publishes.
 */
export function refreshFenceClear(alias: string, column = 'worktree_id'): string {
  return `NOT EXISTS (SELECT 1 FROM persistence_worktree_refreshes fence WHERE fence.worktree_id=${alias}.${column}
        AND fence.state IN ('fenced','merged','recovery_required'))`;
}
