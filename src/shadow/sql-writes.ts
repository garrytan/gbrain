/**
 * Finds the tables a raw SQL string writes (shadow follow, plan PR 1). The wrapper runs this on every `executeRaw`
 * call so a raw write the engine members do not cover still reaches the follower as a relation-level invalidation.
 *
 * One lexer pass drops comments and turns string literals (quoted, E'..', dollar-quoted) into plain tokens, so a keyword
 * inside text never counts and a `--` inside a string does not hide the statement after it. Every statement is then
 * scanned for the write forms INSERT INTO, UPDATE, DELETE FROM, MERGE INTO and TRUNCATE, at any depth, so a data-modifying CTE is found. `FOR UPDATE`, `DO UPDATE` and `THEN UPDATE/DELETE` are
 * not writes to a table of their own. Names may be quoted and schema-qualified; unquoted names fold to lower case and
 * `public.` is dropped. DDL, a `SELECT ... INTO`, `TRUNCATE ... CASCADE`, and a statement whose leading keyword is
 * not known to be read-only (EXECUTE, CALL, DO, COPY ...) are `invalid`: the follower cannot know what they changed.
 * A write hidden inside a called function is not visible to any parser.
 */
export type SqlWrite = { kind: 'relation'; relation: string } | { kind: 'invalid'; reason: string };

interface Token { text: string; quoted: boolean }

const NO_WRITE_LEAD = new Set([
  'SELECT', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN', 'SET', 'RESET', 'BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT',
  'RELEASE', 'LOCK', 'LISTEN', 'NOTIFY', 'UNLISTEN', 'DISCARD', 'DECLARE', 'FETCH', 'CLOSE', 'MOVE', 'DEALLOCATE', 'ANALYZE', 'WITH',
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'PREPARE',
]);
const DDL_LEAD = new Set(['CREATE', 'ALTER', 'DROP', 'COMMENT', 'GRANT', 'REVOKE', 'REINDEX', 'VACUUM', 'CLUSTER', 'REFRESH', 'SECURITY', 'IMPORT']);

const WORD_START = /[A-Za-z_\u0080-\uffff]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-\uffff]/;
const LITERAL: Token = { text: "'", quoted: false };

/**
 * One left-to-right pass over the SQL, so what is inside a string, a comment or a quoted name is never mistaken for
 * anything else. A string, an `E'..'` string (backslash escapes) and a dollar-quoted string each become one literal token
 * that is not a name; comments vanish; `;` ends a statement. Anything left open (a string, a quoted name, a comment or a
 * dollar quote with no end) throws, which the caller reports as unparsable.
 */
function tokenize(sql: string): Token[][] {
  const statements: Token[][] = [[]];
  const push = (t: Token): void => { statements[statements.length - 1]!.push(t); };
  const end = (index: number): number => { if (index < 0) throw new Error('unterminated'); return index; };
  /** The index after the closing `quote` of a string or name that starts after `from`; `''` and `""` are escaped quotes. */
  const closing = (from: number, quote: string, backslash: boolean): number => {
    for (let i = from; ; i++) {
      if (i >= sql.length) throw new Error('unterminated');
      if (backslash && sql[i] === '\\') i++;
      else if (sql[i] === quote) { if (sql[i + 1] !== quote) return i + 1; i++; }
    }
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) i++;
    else if (c === '-' && sql[i + 1] === '-') { const nl = sql.indexOf('\n', i); i = nl < 0 ? sql.length : nl + 1; }
    else if (c === '/' && sql[i + 1] === '*') {
      for (let depth = 1, at = i + 2; depth > 0;) {
        const open = sql.indexOf('/*', at);
        const close = end(sql.indexOf('*/', at));
        if (open >= 0 && open < close) { depth++; at = open + 2; } else { depth--; at = close + 2; }
        i = at;
      }
    } else if (c === "'") { i = closing(i + 1, "'", false); push(LITERAL); }
    else if (c === '"') { const stop = closing(i + 1, '"', false); push({ text: sql.slice(i + 1, stop - 1).replace(/""/g, '"'), quoted: true }); i = stop; }
    else if (c === '$' && /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i, i + 130))) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 130))![0];
      i = end(sql.indexOf(tag, i + tag.length)) + tag.length;
      push(LITERAL);
    } else if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < sql.length && WORD_PART.test(sql[j]!)) j++;
      const word = sql.slice(i, j);
      if (sql[j] === "'" && word.toLowerCase() === 'e') { i = closing(j + 1, "'", true); push(LITERAL); } else { push({ text: word, quoted: false }); i = j; }
    } else {
      if (c === ';') statements.push([]); else push({ text: c, quoted: false });
      i++;
    }
  }
  return statements.filter((s) => s.length > 0);
}

const kw = (t: Token | undefined): string => (t && !t.quoted ? t.text.toUpperCase() : '');
const isName = (t: Token | undefined): boolean => !!t && (t.quoted || /^[A-Za-z_]/.test(t.text));

/** Reads `[schema.]name` at `i`; returns the relation and the next index, or null. */
function readName(toks: Token[], i: number): { relation: string; next: number } | null {
  const parts: string[] = [];
  let at = i;
  for (;;) {
    const t = toks[at];
    if (!isName(t)) return null;
    parts.push(t!.quoted ? t!.text : t!.text.toLowerCase());
    at++;
    if (toks[at]?.text === '.' && !toks[at]!.quoted) { at++; continue; }
    break;
  }
  if (parts.length > 2) return null;
  const relation = parts.length === 2 && parts[0] !== 'public' ? `${parts[0]}.${parts[1]}` : parts[parts.length - 1]!;
  return { relation, next: at };
}

function scanStatement(toks: Token[], out: SqlWrite[]): void {
  const lead = kw(toks[0]);
  if (toks[0]?.text !== '(' && !NO_WRITE_LEAD.has(lead)) {
    out.push({ kind: 'invalid', reason: DDL_LEAD.has(lead) ? `ddl:${lead.toLowerCase()}` : `unparsable:${lead.toLowerCase() || 'unknown'}` });
    return;
  }
  const target = (from: number, op: string): number => {
    let i = from;
    if (kw(toks[i]) === 'TABLE' && op === 'truncate') i++;
    if (kw(toks[i]) === 'ONLY') i++;
    const name = readName(toks, i);
    if (!name) { out.push({ kind: 'invalid', reason: `unparsable_target:${op}` }); return i; }
    out.push({ kind: 'relation', relation: name.relation });
    return name.next;
  };
  for (let i = 0; i < toks.length; i++) {
    const word = kw(toks[i]);
    const prev = kw(toks[i - 1]);
    if (word === 'INSERT' && kw(toks[i + 1]) === 'INTO') i = target(i + 2, 'insert') - 1;
    else if (word === 'MERGE' && kw(toks[i + 1]) === 'INTO') i = target(i + 2, 'merge') - 1;
    else if (word === 'DELETE' && kw(toks[i + 1]) === 'FROM' && prev !== 'THEN') i = target(i + 2, 'delete') - 1;
    else if (word === 'UPDATE' && !['DO', 'THEN', 'FOR', 'KEY', 'NO', 'ON'].includes(prev) && isName(toks[i + 1])) i = target(i + 1, 'update') - 1;
    else if (word === 'TRUNCATE') {
      let j = i + 1;
      for (;;) {
        j = target(j, 'truncate');
        if (toks[j]?.text === ',') { j++; continue; }
        break;
      }
      if (toks.slice(j).some((t) => kw(t) === 'CASCADE')) out.push({ kind: 'invalid', reason: 'truncate_cascade' });
      i = j - 1;
    } else if (word === 'INTO' && prev !== 'INSERT' && prev !== 'MERGE') out.push({ kind: 'invalid', reason: 'select_into' });
  }
}

/** Every write the SQL performs, one entry per target (duplicates possible); empty for a read. */
export function sqlWrites(sql: string): SqlWrite[] {
  const out: SqlWrite[] = [];
  try {
    for (const statement of tokenize(sql)) scanStatement(statement, out);
  } catch {
    return [{ kind: 'invalid', reason: 'unparsable:error' }];
  }
  return out;
}
