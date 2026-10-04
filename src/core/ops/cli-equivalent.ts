/**
 * The `gbrain` CLI command that does what an MCP tool does (agent operator
 * contract v1, F6): named when a tool is outside the caller's surface (the
 * owner's stdio hint) and in the plugin tree's per-skill surface notes.
 * Derived from the op's `cliHints.name` (generated or CLI-only command of that
 * name); a few ops have a better command; anything else is `gbrain call`.
 */
import type { Operation } from './contract.ts';

const OVERRIDES: Readonly<Record<string, readonly string[]>> = {
  get_health: ['gbrain', 'doctor', '--json'],
  sync_brain: ['gbrain', 'sync'],
  submit_job: ['gbrain', 'jobs', 'submit'],
  get_job: ['gbrain', 'jobs', 'get'],
  list_jobs: ['gbrain', 'jobs', 'list'],
  open_loops: ['gbrain', 'loops', 'list'],
  loops_close: ['gbrain', 'loops', 'done'],
  loops_mute: ['gbrain', 'loops', 'mute'],
  get_active_schema_pack: ['gbrain', 'schema', 'active'],
  list_schema_packs: ['gbrain', 'schema', 'list'],
  schema_stats: ['gbrain', 'schema', 'stats'],
  schema_lint: ['gbrain', 'schema', 'lint'],
  schema_graph: ['gbrain', 'schema', 'graph'],
  schema_explain_type: ['gbrain', 'schema', 'explain'],
  schema_review_orphans: ['gbrain', 'schema', 'review-orphans'],
};

export function cliEquivalent(op: Pick<Operation, 'name' | 'cliHints' | 'cliOnly'>): string[] {
  if (op.cliOnly) return [...op.cliOnly.argv];
  const override = OVERRIDES[op.name];
  if (override) return [...override];
  if (op.cliHints?.name) return ['gbrain', op.cliHints.name];
  return ['gbrain', 'call', op.name, '<params_json>'];
}
