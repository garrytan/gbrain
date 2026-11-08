/**
 * The resolver's one error type. Engine-free: it carries a stable code, a
 * message without turn text, safe context and a recovery (a suggestion and, when
 * one exists, the exact command). The CLI maps it onto the agent-operator
 * envelope (src/commands/skill-resolver.ts); every code has a row in
 * src/core/error-registry.ts and a section in docs/guides/skill-resolver.md.
 */
export type ResolverErrorCode =
  | 'skill_index_missing'
  | 'skill_index_incompatible'
  | 'skill_catalog_mismatch'
  | 'skill_index_locked'
  | 'skill_resolve_timeout'
  | 'skill_index_removed'
  | 'skill_catalog_too_large'
  | 'skill_source_unreadable'
  | 'skill_source_invalid'
  | 'skill_resolver_config_invalid'
  | 'skill_resolver_internal'
  | 'skill_catalog_unknown'
  | 'skill_resolve_no_input'
  | 'skill_resolve_invalid_input';

/** Caller mistakes: the CLI exits 2 with the agent-protocol refusal. */
export const USAGE_CODES: ReadonlySet<ResolverErrorCode> = new Set(['skill_catalog_unknown', 'skill_resolve_no_input', 'skill_resolve_invalid_input', 'skill_source_invalid']);

export interface ResolverFix {
  /** What to do, one sentence. */
  suggestion: string;
  /** The exact command, when one exists. */
  argv?: string[];
}

export class ResolverError extends Error {
  readonly code: ResolverErrorCode;
  readonly fix: ResolverFix;
  readonly context: Record<string, string | number | boolean>;
  constructor(code: ResolverErrorCode, message: string, fix: ResolverFix, context: Record<string, string | number | boolean> = {}) {
    super(message);
    this.name = 'ResolverError';
    this.code = code;
    this.fix = fix;
    this.context = context;
  }
  get usage(): boolean { return USAGE_CODES.has(this.code); }
  /** The `error` object of the turn output contract. */
  toJSON(): { code: ResolverErrorCode; message: string; fix: { suggestion: string; command?: string } } {
    return { code: this.code, message: this.message, fix: { suggestion: this.fix.suggestion, ...(this.fix.argv ? { command: this.fix.argv.map(shellQuote).join(' ') } : {}) } };
  }
}

export function shellQuote(a: string): string {
  return /^[A-Za-z0-9_\-./:=@,+]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}
