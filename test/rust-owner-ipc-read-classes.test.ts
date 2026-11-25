/**
 * A member listed as a read on the owner socket (owner-ipc/typed-member-classes.ts OWNER_IPC_TYPED_READS) must not run
 * a statement that changes rows. A read is resent after an owner exit; a write that was classed as a read would be
 * applied twice or lose what it consumed (readJobInbox marks inbox messages read: a resend finds them already read).
 *
 * The test reads the source, never runs it, needs no addon and no database, and is deterministic:
 *
 *  1. SQL side. Each read member is resolved to every function of that name in src/core (the engine-sql module and the
 *     two engine classes), then to the functions and module-level SQL constants they use (calls resolved in the same
 *     file, else by name when at most two functions carry it; three levels deep). Only string and template literals
 *     are read, so a comment or an identifier never counts. It fails on INSERT INTO, UPDATE ... SET (also with a table
 *     alias or a computed table name), DELETE FROM, TRUNCATE, upserts (ON CONFLICT, MERGE INTO), nextval( and DDL
 *     (CREATE/ALTER/DROP, VACUUM, REINDEX, CREATE OR REPLACE, REFRESH MATERIALIZED, COPY .. FROM).
 *  2. Rust side, for each read the Rust store serves (STORE_MEMBERS): the store member (rust-engine/store-members/) ->
 *     the `brain.<method>` calls it makes, helpers followed -> the napi function of that name
 *     (rust/crates/gbrain-napi) -> the store function, and every store function that one calls (same file first, else
 *     by name when at most two carry it). It fails on a store function that has, in its own body, any of: `self.write(`
 *     or `.write(|` (a store write transaction), `begin_write*(`, the KvWrite calls `.put(` `.delete(` `.allocate(`
 *     `.add_i64(` `.raise_counter(`, `put_json(`, `write_page*(`, or a call to a function named `put_*`, `delete_*`,
 *     `upsert_*` or `save_*`.
 *
 * A failure names the member and the file:line of the statement. A member that cannot be resolved (no SQL function,
 * no store member, no napi function, or a store member that hands its brain handle on without a call this test can
 * follow) fails, unless it is in UNRESOLVED_OK below with a reason.
 *
 * Not failures, by design: advisory locks (`pg_advisory_*`) and row locks (`SELECT ... FOR UPDATE` / `FOR SHARE`)
 * change no row, so resending such a read repeats nothing. The reads that only take locks, as the scan finds them, are
 * LOCK_ONLY_READS below and this test checks the list is complete, so the header stays true:
 * getTrustProposal, listFenceFactRows, listGitEffectsCarryingReason, listGuardedTakeRows, listHeldRows,
 * listConnectorSources, listPageGitEffectsForStrip, lockBodyStagingState, lockLivePagesByKey, lockSegmentedGenerationPage, readConfigForUpdate, readFactSnapshots, readLoopFactState, readAccessTokenWriteGrant, readFactWithdrawalClaim, readForgetTarget,
 * readMentionGenerations, readMentionPageRevisions, readPageRevisionForShare,
 * readLiveStoredBody, readNoopEmbeddingCandidates, readOAuthClientWriteGrant, readPairFactRow, readReplacementTarget,
 * readSourceMembership, readSourceState, readWorktreeAdmission, readWriterAdminState, selectClaimableEffect,
 * selectClaimableWrite, listSecretHoldingPages (the batch 6c secret store), the credential, source and shared-skill row-lock reads the batch 10 lanes added
 * (the list below), and lockEffectRow.
 *
 * A constant that maps names to statements (`CREDENTIAL_SQL = { token_list: '...', client_token_ttl: '...' }`) is read per
 * statement: a function that names `CREDENTIAL_SQL.token_list` is charged with that statement, not with its siblings.
 *
 * Limits (no_claim): a write behind a call this scan cannot resolve (a function passed as an argument, three or more
 * same-named functions in other files) is not seen; names decide nothing, but resolution does.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { OWNER_IPC_TYPED_READS } from '../src/core/rust-engine/owner-ipc/typed-member-classes.ts';
import { STORE_MEMBERS } from '../src/core/rust-engine/store-members/index.ts';

const ROOT = join(import.meta.dir, '..');

/** Reads that only take row or advisory locks, found by the scan; the header names them too. */
const LOCK_ONLY_READS: readonly string[] = [
  'getTrustProposal', 'listFenceFactRows', 'listGitEffectsCarryingReason', 'listGuardedTakeRows', 'listHeldRows',
  'listConnectorSources', 'listPageGitEffectsForStrip', 'lockBodyStagingState', 'lockLivePagesByKey', 'lockSegmentedGenerationPage', 'readConfigForUpdate', 'readFactSnapshots', 'readLoopFactState', 'readAccessTokenWriteGrant', 'readFactWithdrawalClaim', 'readForgetTarget',
  'readMentionGenerations', 'readMentionPageRevisions', 'readPageRevisionForShare', 'readLiveStoredBody', 'readNoopEmbeddingCandidates', 'readOAuthClientWriteGrant', 'readPairFactRow', 'readReplacementTarget',
  'readSourceMembership', 'readSourceState', 'readWorktreeAdmission', 'readWriterAdminState', 'selectClaimableEffect',
  'selectClaimableWrite',
  // Added with the batch 6c secret store (it row-locks the pages it reads, FOR SHARE, and changes no row):
  'listSecretHoldingPages',
  // Added when the batch 10 lanes merged (credential, source and shared-skill reads that lock the row they read):
  'lockActiveAccessTokens', 'lockAllSourceRows', 'lockLegacyAccessTokens', 'lockSharedSkillBrainId', 'readAccessTokenMemberGrant', 'readAccessTokenReceiptGrant', 'readCredentialBindingForUpdate', 'readLocalWriterMemberGrant', 'readOAuthClientMemberGrant', 'readOAuthClientReceiptGrant', 'readOauthClientForUpdate', 'readOauthCodeForUpdate', 'readOauthRefreshTokenForUpdate', 'readScopeSourceConfigs', 'readSharedSkillDeliveryBatch', 'readSharedSkillMember', 'readSharedSkillPolicyRow', 'readSourceArchivedForShare',
  // Ours (the page purge port):
  'lockHeldConcept', 'lockLiveConceptMembers', 'lockSourceForUpdate',
  // Added by the persistence byte-order lane: the parked-effect retry's read of the effect row it then requeues.
  'lockEffectRow',
  // attest-rights-rust: the client attest read, whose `lock` form reads the row FOR UPDATE for the grant-write path.
  'readOauthClientAttest',
];

/**
 * Members the scan cannot follow to the end, each with the reason it is still a read. Empty unless a reason is written
 * here; a member added to this list must be read by hand first.
 */
const UNRESOLVED_OK: Readonly<Record<string, string>> = {
  // Only the Rust store implements it; the SQL engines answer the same rows with the one SELECT in search/dedup.ts
  // `segmentRegions`, so no engine-sql function of that name exists. The Rust store function is scanned by the test below.
  readSegmentRegions: 'a Rust-store-only member; the SQL engines run the caller\'s SELECT in search/dedup.ts, which writes nothing',
  // Store members that read through the Snapshot helper of store-members/managed-sync-orphans.ts (one read-only snapshot of the
  // source list and the checkpoint rows: brain.listSourceRecords, brain.readSourceIncarnation, the checkpoint row reads); hand-read.
  listArchivedSourceIds: 'reads the source list through the read-only Snapshot helper',
  listManagedSyncFailureKeys: 'reads checkpoint rows through the read-only Snapshot helper',
  listSourceManagedSyncFailures: 'reads checkpoint rows through the read-only Snapshot helper',
  listManagedSyncOrphanRows: 'reads the source list and checkpoint rows through the read-only Snapshot helper',
  // The napi function is list_source_oauth_clients; the test's snake-case rule splits `OAuth` into o_auth.
  listSourceOAuthClients: 'its napi function list_source_oauth_clients only lists the source\'s OAuth clients',
};

// ------------------------------------------------------------------------------------------------ source walking

function listFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(ext)) out.push(join(entry.parentPath ?? (entry as unknown as { path: string }).path, entry.name));
  }
  return out.sort();
}

const rel = (file: string) => file.slice(ROOT.length + 1);

/** Line of offset `at` in `text`, for evidence. */
function lineAt(text: string, at: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

// ------------------------------------------------------------------------------------------------ SQL side

const SQL_WRITE = new RegExp(
  '\\b(INSERT\\s+INTO|UPDATE\\b[^;`]{0,160}?\\bSET|DELETE\\s+FROM|TRUNCATE\\s|nextval\\s*\\(|MERGE\\s+INTO|ON\\s+CONFLICT|'
  + 'CREATE\\s+(?:TABLE|INDEX)|ALTER\\s+(?:TABLE|INDEX)|DROP\\s+(?:TABLE|INDEX|FUNCTION)|REFRESH\\s+MATERIALIZED|VACUUM|REINDEX|'
  + 'CREATE\\s+OR\\s+REPLACE|COPY\\s+\\w+\\s+FROM)', 'i');
const SQL_LOCK = /\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE)\b|pg_(?:try_)?advisory\w*lock\w*/i;

interface Literal { file: string; line: number; text: string }
interface FnDef { name: string; file: string; line: number; calls: Set<string>; idents: Set<string>; props: Map<string, Set<string>>; locals: Set<string>; literals: Literal[] }

/** Names that are the transport, not the statement: following them would reach every statement in the engine. */
const SQL_SKIP = new Set(['executeRaw', 'executeRawDirect', 'execute', 'runJitOffStatement', 'query', 'rawRead', 'rawWrite', 'run',
  'transaction', 'transactionDirect', 'withReservedConnection', 'rows', 'one', 'all', 'raw', 'sql', 'sqlFragment', 'trustedSql',
  'renderFragment', 'push', 'map', 'filter', 'join', 'slice', 'some', 'every', 'find', 'includes', 'indexOf', 'has', 'get', 'set',
  'add', 'delete', 'keys', 'values', 'entries', 'from', 'then', 'catch', 'finally', 'toString', 'sort', 'reduce', 'flat', 'flatMap',
  'trim', 'split', 'replace', 'test', 'exec', 'match', 'startsWith', 'endsWith', 'concat', 'reverse', 'fill', 'assign', 'freeze',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Map', 'Set', 'JSON', 'Error', 'Date', 'Promise', 'BigInt', 'require', 'super']);

/** A module-level constant's literals: all of them, and per key when it is an object literal (a map of named statements). */
interface ConstLits { all: Literal[]; props: Map<string, Literal[]> }
interface SqlIndex { defs: Map<string, FnDef[]>; consts: Map<string, Map<string, ConstLits>> }

function isStringLike(node: ts.Node): boolean {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
}

/** The outermost string and template literals under `node`, as text with their line. */
function literalsOf(sf: ts.SourceFile, file: string, node: ts.Node): Literal[] {
  const out: Literal[] = [];
  const walk = (n: ts.Node, inside: boolean): void => {
    const own = !inside && isStringLike(n);
    if (own) out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: n.getText(sf) });
    ts.forEachChild(n, c => walk(c, inside || own));
  };
  walk(node, false);
  return out;
}

function fnFrom(sf: ts.SourceFile, file: string, name: string, node: ts.Node, body: ts.Node): FnDef {
  const calls = new Set<string>();
  const idents = new Set<string>();
  // `ID.key` and `ID['key']` on an identifier: the function names one statement of a constant that maps names to
  // statements, so the scan reads that statement and not every other one in the map.
  const props = new Map<string, Set<string>>();
  // Names declared inside the function (a local `const plan = PLANS[variant]; plan(scope)` is not the class method `plan`).
  const locals = new Set<string>();
  const walk = (n: ts.Node): void => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n)) && ts.isIdentifier(n.name)) locals.add(n.name.text);
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (ts.isIdentifier(e)) calls.add(e.text);
      else if (ts.isPropertyAccessExpression(e)) calls.add(e.name.text);
    }
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
      const set = props.get(n.expression.text) ?? new Set<string>();
      set.add(n.name.text);
      props.set(n.expression.text, set);
      return;
    }
    if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && ts.isStringLiteralLike(n.argumentExpression)) {
      const set = props.get(n.expression.text) ?? new Set<string>();
      set.add(n.argumentExpression.text);
      props.set(n.expression.text, set);
      return;
    }
    if (ts.isIdentifier(n)) idents.add(n.text);
    ts.forEachChild(n, walk);
  };
  walk(body);
  return { name, file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, calls, idents, props, locals, literals: literalsOf(sf, file, body) };
}

function buildSqlIndex(): SqlIndex {
  const defs = new Map<string, FnDef[]>();
  const consts = new Map<string, Map<string, ConstLits>>();
  const add = (d: FnDef) => { const l = defs.get(d.name); if (l) l.push(d); else defs.set(d.name, [d]); };
  const files = listFiles(join(ROOT, 'src/core'), '.ts').filter(f => !f.includes('/rust-engine/') && !f.endsWith('/rust-engine.ts'));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const r = rel(file);
    const fileConsts = new Map<string, ConstLits>();
    consts.set(r, fileConsts);
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && st.body) add(fnFrom(sf, r, st.name.text, st, st.body));
      else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer) continue;
          const init = d.initializer;
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) add(fnFrom(sf, r, d.name.text, d, init.body));
          else {
            const lits = literalsOf(sf, r, init);
            if (!lits.length) continue;
            const props = new Map<string, Literal[]>();
            const obj = ts.isAsExpression(init) ? init.expression : init;
            if (ts.isObjectLiteralExpression(obj)) {
              for (const p of obj.properties) {
                if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))) props.set(p.name.text, literalsOf(sf, r, p.initializer));
              }
            }
            fileConsts.set(d.name.text, { all: lits, props });
          }
        }
      } else if (ts.isClassDeclaration(st)) {
        for (const m of st.members) {
          if (ts.isMethodDeclaration(m) && m.body && ts.isIdentifier(m.name)) add(fnFrom(sf, r, m.name.text, m, m.body));
        }
      }
    }
  }
  return { defs, consts };
}

interface Hit { member: string; sql: string; at: string; chain: string[] }

/** Write statements (and, apart, lock statements) a member's SQL implementation reaches. */
function scanSql(ix: SqlIndex, member: string): { writes: Hit[]; locks: Hit[]; resolved: boolean } {
  const writes: Hit[] = [];
  const locks: Hit[] = [];
  const seen = new Set<FnDef>();
  const scan = (lits: Literal[], chain: string[]) => {
    for (const l of lits) {
      for (const [re, into] of [[SQL_WRITE, writes], [SQL_LOCK, locks]] as const) {
        const m = re.exec(l.text);
        if (m) into.push({ member, sql: m[0].replace(/\s+/g, ' '), at: `${l.file}:${l.line + lineAt(l.text, m.index) - 1}`, chain });
      }
    }
  };
  const visit = (d: FnDef, chain: string[], depth: number): void => {
    if (seen.has(d)) return;
    seen.add(d);
    scan(d.literals, chain);
    const fileConsts = ix.consts.get(d.file);
    const scanConst = (c: ConstLits, id: string): void => {
      // A constant that maps names to statements: only the statements this function names, when it names any and does
      // not use the constant whole.
      const named = d.props.get(id);
      if (named && !d.idents.has(id) && c.props.size) {
        for (const key of named) scan(c.props.get(key) ?? c.all, [...chain, `${id}.${key}`]);
      } else scan(c.all, [...chain, id]);
    };
    for (const id of new Set([...d.idents, ...d.props.keys()])) {
      const own = fileConsts?.get(id);
      if (own) scanConst(own, id);
      else if (/^[A-Z][A-Z0-9_]{3,}$/.test(id)) for (const m of ix.consts.values()) { const c = m.get(id); if (c) scanConst(c, id); }
    }
    if (depth >= 3) return;
    for (const c of d.calls) {
      if (SQL_SKIP.has(c) || c === d.name || d.locals.has(c)) continue;
      const all = ix.defs.get(c);
      if (!all) continue;
      const same = all.filter(x => x.file === d.file);
      const next = same.length ? same : all.length <= 2 ? all : [];
      for (const n of next) visit(n, [...chain, c], depth + 1);
    }
  };
  const roots = ix.defs.get(member) ?? [];
  for (const d of roots) visit(d, [member], 0);
  return { writes, locks, resolved: roots.length > 0 };
}

// ------------------------------------------------------------------------------------------------ Rust side

/** Blanks comments, strings and character literals, keeping the length and every newline. */
function stripRust(t: string): string {
  const out = t.split('');
  const n = t.length;
  const blank = (a: number, b: number) => { for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < n) {
    const c = t[i]!;
    if (c === '/' && t[i + 1] === '/') { const j = t.indexOf('\n', i); const e = j < 0 ? n : j; blank(i, e); i = e; }
    else if (c === '/' && t[i + 1] === '*') {
      let d = 1; let j = i + 2;
      while (j < n && d) {
        if (t.startsWith('/*', j)) { d++; j += 2; } else if (t.startsWith('*/', j)) { d--; j += 2; } else j++;
      }
      blank(i, j); i = j;
    } else if (c === 'r' && /^r#*"/.test(t.slice(i, i + 12)) && (i === 0 || !/[A-Za-z0-9_]/.test(t[i - 1]!))) {
      const h = /^r(#*)"/.exec(t.slice(i, i + 12))![1]!;
      const open = i + 2 + h.length;
      const close = t.indexOf('"' + h, open);
      const e = close < 0 ? n : close + 1 + h.length;
      blank(i, e); i = e;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && t[j] !== '"') j += t[j] === '\\' ? 2 : 1;
      blank(i, j + 1); i = j + 1;
    } else if (c === "'") {
      const m = /^'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|.)|[^'\\\n])'/.exec(t.slice(i, i + 14));
      if (m) { blank(i, i + m[0].length); i += m[0].length; } else i++;
    } else i++;
  }
  return out.join('');
}

function matchBrace(t: string, open: number): number {
  let d = 0;
  for (let j = open; j < t.length; j++) {
    if (t[j] === '{') d++;
    else if (t[j] === '}') { d--; if (d === 0) return j; }
  }
  return t.length - 1;
}

interface RustFn { name: string; file: string; line: number; body: string; bodyAt: number; text: string; napi: boolean }

/**
 * The files of the modules a `#[cfg(test)] mod name;` line declares (`dir/name.rs` and everything under `dir/name/`,
 * where `dir` is the declaring file's module directory): test-only code, skipped like an inline `#[cfg(test)] mod`.
 */
function testModuleFiles(files: readonly string[], read: (file: string) => string = file => readFileSync(file, 'utf8')): Set<string> {
  const out = new Set<string>();
  for (const file of files) {
    // Comments and strings blanked first, so a commented-out declaration hides nothing.
    const text = stripRust(read(file));
    const base = file.replace(/\.rs$/, '');
    const dir = /\/(?:lib|main|mod)\.rs$/.test(file) ? file.replace(/\/[^/]+$/, '') : base;
    for (const m of text.matchAll(/#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/g)) {
      const mod = join(dir, m[1]!);
      for (const candidate of files) if (candidate === `${mod}.rs` || candidate === join(mod, 'mod.rs') || candidate.startsWith(`${mod}/`)) out.add(candidate);
    }
  }
  return out;
}

function buildRustIndex(): Map<string, RustFn[]> {
  const fns = new Map<string, RustFn[]>();
  for (const crate of ['gbrain-store', 'gbrain-napi']) {
    const files = listFiles(join(ROOT, 'rust/crates', crate, 'src'), '.rs');
    const testOnly = testModuleFiles(files);
    for (const file of files) {
      if (testOnly.has(file)) continue;
      let t = stripRust(readFileSync(file, 'utf8'));
      const test = /#\[cfg\(test\)\]\s*mod\s+\w+\s*\{/g;
      for (let m = test.exec(t); m; m = test.exec(t)) {
        const e = matchBrace(t, m.index + m[0].length - 1);
        t = t.slice(0, m.index) + t.slice(m.index, e + 1).replace(/[^\n]/g, ' ') + t.slice(e + 1);
      }
      const re = /\bfn\s+(\w+)\s*(?:<[^{;]*?>)?\s*\(/g;
      for (let m = re.exec(t); m; m = re.exec(t)) {
        let i = m.index + m[0].length; let depth = 1;
        while (i < t.length && depth) { if (t[i] === '(') depth++; else if (t[i] === ')') depth--; i++; }
        let k = i;
        while (k < t.length && t[k] !== '{' && t[k] !== ';') k++;
        if (k >= t.length || t[k] === ';') continue;
        const e = matchBrace(t, k);
        const def: RustFn = { name: m[1]!, file: rel(file), line: lineAt(t, m.index), body: t.slice(k, e + 1), bodyAt: k, text: t, napi: crate === 'gbrain-napi' };
        const l = fns.get(def.name);
        if (l) l.push(def); else fns.set(def.name, [def]);
      }
    }
  }
  return fns;
}

/**
 * The statements the Rust store changes data with: a store write transaction (`self.write(`, `.write(|`), the key-value
 * write handle (`.put(`, `.delete(`, `.allocate(`, `.add_i64(`, `.raise_counter(`, `begin_write*(`), the record writers
 * (`put_json(`, `write_page*(`) and any call to a function named `put_*`, `delete_*`, `upsert_*` or `save_*`.
 */
const RUST_WRITE = new RegExp(
  '\\bself\\s*\\.\\s*write\\s*\\(|\\.\\s*write\\s*\\(\\s*(?:move\\s*)?\\||\\bbegin_write\\w*\\s*\\(|\\.\\s*put\\s*\\(|\\.\\s*delete\\s*\\('
  + '|\\.\\s*allocate\\s*\\(|\\.\\s*add_i64\\s*\\(|\\.\\s*raise_counter\\s*\\(|\\bput_json\\s*\\(|\\bwrite_page\\w*\\s*\\('
  + '|(?<![\\w.])(?:put|delete|upsert|save)_\\w+\\s*\\(', 'g');
const RUST_BARE = /(?<![\w.:])([a-z_][a-z0-9_]*)\s*(?:::<[^>]*>)?\s*\(/g;
const RUST_SELF = /\b(?:self|s|store|brain)\s*\.\s*([a-z_][a-z0-9_]*)\s*(?:::<[^>]*>)?\s*\(/g;
const RUST_PATH = /\b(?:Self|crate|super|[a-z_][a-z0-9_]*)::(?:[a-z_][a-z0-9_]*::)*([a-z_][a-z0-9_]*)\s*(?:::<[^>]*>)?\s*\(/g;
const RUST_STOP = new Set(('new get read run from into default len is_empty iter map collect clone unwrap expect ok err some none push insert contains '
  + 'extend to_string as_str as_ref min max abs filter any all find first last take skip rev zip next entry or_insert or_default sort sort_by dedup '
  + 'join split trim parse format vec lock map_err ok_or and_then unwrap_or unwrap_or_else is_some is_none cloned copied remove drain values keys '
  + 'retain cmp eq ne partial_cmp hash fmt drop if while for match fn return loop let').split(' '));

function callsOf(body: string): Set<string> {
  const out = new Set<string>();
  for (const re of [RUST_BARE, RUST_SELF, RUST_PATH]) for (const m of body.matchAll(re)) out.add(m[1]!);
  return out;
}

function rustWrites(fns: Map<string, RustFn[]>, start: string, member: string): Hit[] {
  const hits: Hit[] = [];
  const seen = new Set<RustFn>();
  const stack: Array<{ name: string; from: string | null; chain: string[] }> = [{ name: start, from: null, chain: [start] }];
  while (stack.length) {
    const { name, from, chain } = stack.pop()!;
    const all = fns.get(name) ?? [];
    let defs = all;
    if (from !== null) { const same = all.filter(d => d.file === from); defs = same.length ? same : all.length <= 2 ? all : []; }
    for (const d of defs) {
      if (seen.has(d)) continue;
      seen.add(d);
      for (const m of d.body.matchAll(RUST_WRITE)) {
        hits.push({ member, sql: m[0].replace(/\s+/g, ' ').trim(), at: `${d.file}:${lineAt(d.text, d.bodyAt + m.index!)}`, chain });
        break;
      }
      for (const c of callsOf(d.body)) if (fns.has(c) && !RUST_STOP.has(c)) stack.push({ name: c, from: d.file, chain: [...chain, c] });
    }
  }
  return hits;
}

// ------------------------------------------------------------------------------------------------ store members (TS)

interface Decl { calls: Set<string>; brainMethods: Set<string>; usesBrain: boolean }

function buildStoreDecls(): Map<string, Decl[]> {
  const decls = new Map<string, Decl[]>();
  for (const file of listFiles(join(ROOT, 'src/core/rust-engine/store-members'), '.ts')) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const add = (name: string, body: ts.Node) => {
      const d: Decl = { calls: new Set(), brainMethods: new Set(), usesBrain: false };
      const isBrain = (e: ts.Expression) => (ts.isIdentifier(e) && (e.text === 'brain' || e.text === '_brain'))
        || (ts.isPropertyAccessExpression(e) && e.name.text === 'brain');
      const walk = (n: ts.Node): void => {
        // `assertStoreSerializedTransactions(brain, site)` only reads a getter of the handle (no store call, no write).
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'assertStoreSerializedTransactions') return;
        if (ts.isCallExpression(n)) {
          const e = n.expression;
          if (ts.isIdentifier(e)) d.calls.add(e.text);
          else if (ts.isPropertyAccessExpression(e)) {
            if (isBrain(e.expression)) d.brainMethods.add(e.name.text);
            // `helper.call(this, brain, ...)` calls `helper`.
            if (['call', 'apply', 'bind'].includes(e.name.text) && ts.isIdentifier(e.expression)) d.calls.add(e.expression.text);
            d.calls.add(e.name.text);
          }
        }
        if (isBrain(n as ts.Expression) && ts.isExpression(n)) {
          const p = n.parent;
          // `brain.method(...)` is a call this test follows; any other use hands the handle on.
          const memberCall = p && ts.isPropertyAccessExpression(p) && p.expression === n && p.parent && ts.isCallExpression(p.parent) && p.parent.expression === p;
          if (!memberCall && !(p && ts.isPropertyAccessExpression(p) && p.name === n)) d.usesBrain = true;
        }
        ts.forEachChild(n, walk);
      };
      walk(body);
      const l = decls.get(name);
      if (l) l.push(d); else decls.set(name, [d]);
    };
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && st.body) add(st.name.text, st.body);
      else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer) continue;
          const init = d.initializer;
          add(d.name.text, ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? init.body : init);
        }
      }
    }
  }
  return decls;
}

/** The brain methods a store member calls, helpers in store-members/ followed; `handedOn` when the handle goes elsewhere. */
function brainMethodsOf(decls: Map<string, Decl[]>, member: string): { methods: Set<string>; found: boolean; handedOn: boolean } {
  const methods = new Set<string>();
  const seen = new Set<string>();
  let handedOn = false;
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const d of decls.get(name) ?? []) {
      for (const m of d.brainMethods) methods.add(m);
      if (d.usesBrain) handedOn = true;
      for (const c of d.calls) if (decls.has(c)) visit(c);
    }
  };
  visit(member);
  return { methods, found: decls.has(member), handedOn };
}

const snake = (s: string) => s.replace(/(?<!^)([A-Z])/g, (_, c: string) => '_' + c.toLowerCase()).toLowerCase();

// ------------------------------------------------------------------------------------------------ the tests

describe('the Rust scan skips only test-only modules', () => {
  // Value: protects=a commented-out `#[cfg(test)] mod x;` does not hide production module x from the write scan;
  // fails_when=the declaration scan reads raw text; why_new=the file-level test-module skip is new; seam=in-memory files
  test('a #[cfg(test)] mod declaration inside a comment hides nothing', () => {
    const files = ['/r/src/lib.rs', '/r/src/hidden.rs', '/r/src/tests.rs', '/r/src/tests/helpers.rs'];
    const text: Record<string, string> = {
      '/r/src/lib.rs': '// #[cfg(test)] mod hidden;\n/* #[cfg(test)]\nmod hidden; */\n#[cfg(test)]\nmod tests;\n',
      '/r/src/hidden.rs': 'pub fn hidden() {}\n', '/r/src/tests.rs': 'mod helpers;\n', '/r/src/tests/helpers.rs': 'fn h() {}\n',
    };
    expect([...testModuleFiles(files, file => text[file]!)].sort()).toEqual(['/r/src/tests.rs', '/r/src/tests/helpers.rs']);
  });
});

describe('every member listed as an owner-socket read runs no write', () => {
  const sql = buildSqlIndex();
  const decls = buildStoreDecls();
  const rust = buildRustIndex();
  const reads = [...OWNER_IPC_TYPED_READS];

  const fmt = (h: Hit) => `${h.member}: ${h.sql} at ${h.at} (via ${h.chain.join(' > ')})`;

  // Value: protects=a write listed as a read is never resent as a read after an owner exit, in the SQL engines or in the Rust
  // store; fails_when=a read member's engine-sql function, a helper or SQL constant it uses has INSERT/UPDATE/DELETE/TRUNCATE/an
  // upsert (readJobInbox: UPDATE minion_inbox SET read_at); why_new=the typed members were first classed by name, and two
  // writes were found by hand; seam=none, static source scan; no_claim=a write behind a call the scan cannot resolve
  test('SQL: no read member reaches INSERT, UPDATE, DELETE, TRUNCATE or an upsert', () => {
    const problems: string[] = [];
    for (const member of reads) {
      const found = scanSql(sql, member);
      if (!found.resolved && !(member in UNRESOLVED_OK)) problems.push(`${member}: no engine-sql or engine function of that name was found`);
      for (const h of found.writes) problems.push(fmt(h));
    }
    expect(problems.join('\n')).toBe('');
  }, 120_000);

  // Value: protects=the same for the Rust store, which is what the owner runs; fails_when=the store function behind a served read
  // calls self.write, a KvWrite call, put_json, write_page or a put_/delete_/upsert_/save_ function
  // (read_job_inbox: self.write + put_json); why_new=as above; seam=none, static source scan, no addon; no_claim=members the
  // Rust store does not serve (it refuses them, nothing runs), and a call the scan cannot resolve
  test('Rust: no served read reaches a store write', () => {
    const problems: string[] = [];
    let served = 0;
    for (const member of reads) {
      if (!(member in STORE_MEMBERS)) continue;
      served++;
      const { methods, found, handedOn } = brainMethodsOf(decls, member);
      if (!found && !(member in UNRESOLVED_OK)) { problems.push(`${member}: served, but no declaration of it was found in rust-engine/store-members/`); continue; }
      if (methods.size === 0 && handedOn && !(member in UNRESOLVED_OK)) {
        problems.push(`${member}: its store member hands the brain handle to code this test does not follow`);
        continue;
      }
      for (const method of methods) {
        const fn = snake(method);
        const defs = rust.get(fn) ?? [];
        if (!defs.some(d => d.napi) && !(member in UNRESOLVED_OK)) { problems.push(`${member}: brain.${method} has no napi function ${fn}`); continue; }
        for (const h of rustWrites(rust, fn, member)) problems.push(fmt(h));
      }
    }
    expect(served).toBeGreaterThan(300);
    expect(problems.join('\n')).toBe('');
  }, 120_000);

  test('the reads that only take locks are the ones the header lists', () => {
    const lockOnly = reads.filter(member => {
      const found = scanSql(sql, member);
      return found.writes.length === 0 && found.locks.length > 0;
    }).sort();
    expect(lockOnly).toEqual([...LOCK_ONLY_READS].sort());
  }, 120_000);

  test('the allow-list names only listed reads and gives a reason for each', () => {
    for (const [member, reason] of Object.entries(UNRESOLVED_OK)) {
      expect(reads).toContain(member);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
