/**
 * Reads src/core/postgres-engine.ts (never runs it) and says, for each typed member that writes, which executor the
 * member's statements go through and whether that executor survives a server whose default is read-only (#7183).
 *
 * A pooled server connection whose `default_transaction_read_only` is on refuses every autocommit write with 25006.
 * Only three paths recover: `executeRaw` / `executeRawDirect` / `retryReadOnlyAutocommit` (the statement runs once more
 * in BEGIN READ WRITE), the `autocommitSql` executor (the same retry around engineSql), and a transaction the engine
 * opens (`transaction()` always declares BEGIN READ WRITE). `engineSql` and a bare `this.sql` have no retry.
 *
 * Resolution, per member of the PostgresEngine class:
 *  - the `this.<name>` references in its text, plus a bare `this` (the engine handed on as an executor);
 *  - a `this.<getter>` is replaced by what that getter's own text references (cliReads, linkTemporal, writeMiscReads and
 *    the like are `unscopedExecutor(this.engineSql, ...)`), recursively;
 *  - a `this.<member>` that is itself in the write list is followed (insertReasonPurgeTombstones -> writeReasonPurgeTombstones).
 *
 * Verdicts:
 *  - 'unguarded': it references an executor with no read-only retry and nothing that gives it one in the same member (no
 *    engine transaction, no `_pageTransaction` branch, no retryReadOnlyAutocommit). This is the gap.
 *  - 'guarded': everything else (autocommitSql, executeRaw, a transaction, a pipelined branch ...).
 *
 * Limits (no_claim): the check is on the member's own text. A guarded member can still call a helper that writes through
 * an unguarded executor of its own; a member that mixes an unguarded executor with `transaction` is read as guarded. A
 * write inside a transaction clone (`(tx as PostgresEngine).engineSql`) is not a top-level executor reference and never counts.
 */
import ts from 'typescript';

/** Executors whose statements run once, as the server defaults them. */
export const UNGUARDED_EXECUTORS: readonly string[] = ['engineSql', 'sql', 'engineSqlRead', 'engineSqlOn'];
/**
 * References that give a member's statements the read-only retry: the retrying executors and helpers, and an engine
 * transaction (BEGIN READ WRITE). directRawSql and directEngineSql wrap executeRawDirect (retrying) on the one channel
 * their impls use (`executeRaw` and `query`).
 */
export const RETRYING_REFERENCES: readonly string[] = [
  'autocommitSql', 'executeRaw', 'executeRawDirect', 'retryReadOnlyAutocommit', 'preparationRead', 'lockingPreparationRead',
  'ownRawRead', 'transaction', 'transactionDirect', 'transactionOn', '_pageTransaction', 'directRawSql', 'directEngineSql',
];

/** Names this audit never expands into: the executors above and the helpers that carry the retry. */
const PRIMITIVES = new Set<string>([...UNGUARDED_EXECUTORS, ...RETRYING_REFERENCES]);

export interface WriteAudit {
  member: string;
  /** 1-based line of the member's declaration in the engine source. */
  line: number;
  /** Executor references after getters and delegation are expanded. */
  references: string[];
  verdict: 'guarded' | 'unguarded';
  /** The unguarded executors the verdict rests on. */
  unguarded: string[];
}

interface Declared { kind: 'method' | 'getter' | 'property'; line: number; text: string }

export function declaredMembers(source: string, className = 'PostgresEngine'): Map<string, Declared> {
  const sf = ts.createSourceFile('postgres-engine.ts', source, ts.ScriptTarget.Latest, true);
  const out = new Map<string, Declared>();
  sf.forEachChild(node => {
    if (!ts.isClassDeclaration(node) || node.name?.text !== className) return;
    for (const m of node.members) {
      const named = m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text : undefined;
      if (!named) continue;
      const kind = ts.isGetAccessor(m) ? 'getter' : ts.isMethodDeclaration(m) ? 'method' : 'property';
      if (!out.has(named)) out.set(named, { kind, line: sf.getLineAndCharacterOfPosition(m.getStart()).line + 1, text: m.getText() });
    }
  });
  return out;
}

function rawReferences(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(/\bthis\.(\w+)/g)) refs.add(m[1]!);
  if (/\bthis\b(?!\.)/.test(text)) refs.add('this');
  if (/\bretryReadOnlyAutocommit\b/.test(text)) refs.add('retryReadOnlyAutocommit');
  return [...refs];
}

/** Every executor reference the member makes once getters and delegation to other write members are expanded. */
export function executorReferences(member: string, declared: Map<string, Declared>, writes: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const out = new Set<string>();
  const walk = (name: string, isRoot: boolean): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const d = declared.get(name);
    if (!d) return;
    for (const ref of rawReferences(d.text)) {
      if (PRIMITIVES.has(ref) || ref === 'this') { out.add(ref); continue; }
      const target = declared.get(ref);
      if (!target) continue;
      if (target.kind === 'getter' || (writes.has(ref) && ref !== name && isRoot)) walk(ref, false);
    }
  };
  walk(member, true);
  return [...out].sort();
}

export function auditWrites(source: string, writes: readonly string[]): { audits: WriteAudit[]; missing: string[] } {
  const declared = declaredMembers(source);
  const writeSet = new Set(writes);
  const audits: WriteAudit[] = [];
  const missing: string[] = [];
  for (const member of writes) {
    const d = declared.get(member);
    if (!d) { missing.push(member); continue; }
    const references = executorReferences(member, declared, writeSet);
    const unguarded = references.filter(r => UNGUARDED_EXECUTORS.includes(r));
    const retrying = references.some(r => r === 'retryReadOnlyAutocommit' || r === 'transaction' || r === 'transactionDirect' || r === 'transactionOn' || r === '_pageTransaction');
    audits.push({ member, line: d.line, references, unguarded, verdict: unguarded.length > 0 && !retrying ? 'unguarded' : 'guarded' });
  }
  return { audits, missing };
}
