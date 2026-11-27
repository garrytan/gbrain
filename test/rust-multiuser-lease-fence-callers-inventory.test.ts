/**
 * Lease-fence caller inventory (lane L5; docs/designs/rust-engine/multi-user-server.md, "I-5, host fence table").
 *
 * A multi-user Rust store refuses a stale host only when the call carries the host's fence: it cannot tell a call
 * with no fence from a one-shot command that has no host registered, so it lets both through. A new caller of a
 * claim or lease member that forgets to send the fence would silently let a stale host write again. This census lists
 * every call of those members under src/ and fails when one sends no fence and is not on the allow-list with a
 * reason.
 *
 * A call sends the fence when its arguments read one of the fence sources (`fenceOpts`, `claimFenceOpts`,
 * `registrationOpts`, ...), or name a variable or parameter that does (its initializer reads a source, or its type is
 * `FenceOpts` / `LeaseToken`, or it is the `opts` a `fences.ending` callback receives). Calls through a MinionQueue
 * (`queue.completeJob`, ...) are its fenced wrappers: the wrappers' own engine calls are checked here instead. The
 * engine classes and the Rust store members only forward the options they are given, so they are not callers.
 *
 * The member list is persistence/fenced-members.ts, the one the Rust engine's dispatch refusal (rust-engine/fence-dispatch.ts)
 * reads, so the census and the runtime refusal can never cover different members.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { FENCED_CALL_ALIASES, FENCED_MEMBERS, type FencedFamily } from '../src/core/persistence/fenced-members.ts';

const ROOT = join(import.meta.dir, '..');

/** The members, by family, and the other names they are called through: one list with the Rust engine's dispatch. */
const MEMBERS = new Set(Object.values(FENCED_MEMBERS).flat() as string[]);
const QUALIFIED = new Map(Object.values(FENCED_CALL_ALIASES).flat().map(m => [m.split('.')[1]!, m.split('.')[0]!]));
const FAMILY_NAMES: Record<string, readonly string[]> = Object.fromEntries((Object.entries(FENCED_MEMBERS) as Array<[FencedFamily, readonly string[]]>)
  .map(([family, members]) => [family, [...members, ...(FENCED_CALL_ALIASES[family] ?? [])]]));

/** The census name of a member call, or null when the call is not one of the fenced members. */
function memberOf(call: ts.CallExpression, sf: ts.SourceFile): string | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const name = call.expression.name.text;
  if (MEMBERS.has(name)) return name;
  const receiver = QUALIFIED.get(name);
  return receiver && new RegExp(`(^|\\.)${receiver}$`).test(call.expression.expression.getText(sf)) ? `${receiver}.${name}` : null;
}

/** Files that only forward the options a caller gave them (engine classes, the Rust store members, SQL statements). */
const FORWARDERS: Record<string, string> = {
  'src/core/pglite-engine.ts': 'engine class: delegates each member to its SQL statement with the caller\'s options',
  'src/core/postgres-engine.ts': 'engine class: delegates each member to its SQL statement with the caller\'s options',
  'src/core/rust-engine/store-members/': 'Rust store members: pass the caller\'s fence to the addon unchanged',
  'src/core/engine-sql/': 'SQL statements: the SQL engines fence with their own row locks and tokens',
  'src/core/persistence/consumer-lane.ts': 'direct-lane engine proxy: forwards the caller\'s release, which carries its fence',
};

/** Files that forward only some members, by member: their other calls are checked. */
const MEMBER_FORWARDERS: Record<string, { members: readonly string[]; reason: string }> = {
  'src/core/notifier/store.ts': { members: ['writeNotifierState', 'writeNotifierCoverage'], reason: 'NotifierStore adapter: forwards the patch and coverage, which carry the notifier\'s lease' },
};

/** Call sites that send no fence on purpose, keyed `file:member`, with the reason. */
export const UNFENCED_ALLOWED: Record<string, string> = {};

/** The calls that read the registration (or a claim's own fence) at call time. */
const FENCE_SOURCES = /\b(fenceOpts|claimFenceOpts|boundFenceOpts|takenFenceOpts|withFence|fenceFor|registrationOpts|registration|optsFor|sweepArgs|heldLease)\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

interface CallSite { file: string; line: number; member: string; text: string; fenced: boolean }

/** Whether the identifier `name`, used at `at`, is bound in an enclosing scope to a fence. */
function boundToFence(name: string, at: ts.Node, sf: ts.SourceFile): boolean {
  for (let scope: ts.Node | undefined = at.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      for (const p of scope.parameters) {
        if (!ts.isIdentifier(p.name) || p.name.text !== name) continue;
        if (p.type && /\b(FenceOpts|LeaseToken)\b/.test(p.type.getText(sf))) return true;
        // `this.fences.ending(id, token, opts => engine.member(..., opts))`: the callback receives the claim's fence.
        const call = scope.parent;
        if (call && ts.isCallExpression(call) && /\bfences\.\w+$/.test(call.expression.getText(sf))) return true;
      }
    }
    let found = false;
    scope.forEachChild(function visit(n) {
      if (found) return;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.pos < at.pos) {
        const init = n.initializer?.getText(sf) ?? '';
        const type = n.type?.getText(sf) ?? '';
        if (FENCE_SOURCES.test(init) || /\b(FenceOpts|LeaseToken)\b/.test(type) || /\bhandle\.fence\b/.test(init)) found = true;
      }
      if (!ts.isFunctionLike(n)) n.forEachChild(visit);
    });
    if (found) return true;
  }
  return false;
}

/** The `none` branch of `fence.fence ? member(..., fence) : member(...)`: no host is registered, so nothing to send. */
function noRegistrationBranch(call: ts.CallExpression, sf: ts.SourceFile): boolean {
  for (let n: ts.Node = call; n.parent; n = n.parent) {
    const p = n.parent;
    if (ts.isConditionalExpression(p) && p.whenFalse === n) {
      const guard = /^(\w+)\.fence$/.exec(p.condition.getText(sf));
      return guard !== null && boundToFence(guard[1], call, sf);
    }
    if (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p) || ts.isPropertyAccessExpression(p) || ts.isCallExpression(p) && p.expression === n) continue;
    return false;
  }
  return false;
}

/** Whether the call's arguments carry a fence. */
function sendsFence(call: ts.CallExpression, sf: ts.SourceFile): boolean {
  if (noRegistrationBranch(call, sf)) return true;
  let fenced = false;
  for (const arg of call.arguments) {
    if (FENCE_SOURCES.test(arg.getText(sf))) return true;
    arg.forEachChild(function visit(n) {
      if (fenced) return;
      if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && boundToFence(n.text, call, sf)) fenced = true;
      n.forEachChild(visit);
    });
    if (ts.isIdentifier(arg) && boundToFence(arg.text, call, sf)) return true;
    if (fenced) return true;
  }
  return false;
}

/** A call through a MinionQueue: its fenced wrapper (the wrapper's engine call is checked in queue.ts). */
function throughQueue(call: ts.CallExpression, sf: ts.SourceFile, file: string): boolean {
  const receiver = (call.expression as ts.PropertyAccessExpression).expression.getText(sf);
  return /(^|\.)queue$/.test(receiver) || (file === 'src/core/minions/queue.ts' && receiver === 'this');
}

function census(): CallSite[] {
  const sites: CallSite[] = [];
  for (const path of walk(join(ROOT, 'src'))) {
    const file = relative(ROOT, path);
    if (Object.keys(FORWARDERS).some(f => f.endsWith('/') ? file.startsWith(f) : file === f)) continue;
    // test-reads-source-ok[structural]: the census is over call sites in the source; no runtime probe can list every caller.
    const text = readFileSync(path, 'utf8');
    if (![...MEMBERS, ...QUALIFIED.keys()].some(m => text.includes(`.${m}(`))) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      const member = ts.isCallExpression(n) ? memberOf(n, sf) : null;
      if (member && ts.isCallExpression(n) && !throughQueue(n, sf, file) && !MEMBER_FORWARDERS[file]?.members.includes(member)) {
        sites.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, member, text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 160), fenced: sendsFence(n, sf) });
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return sites;
}

describe('lease-fence caller inventory (I-5, host fence table)', () => {
  const sites = census();

  test('every call of a claim or lease member sends the host fence, or is allowed with a reason', () => {
    const unfenced = sites.filter(s => !s.fenced && !UNFENCED_ALLOWED[`${s.file}:${s.member}`]);
    const lines = unfenced.map(s => `${s.file}:${s.line} ${s.member} sends no fence: ${s.text}`);
    expect(lines, `Pass the registration (fenceOpts(engine), claimFenceOpts, the queue's fences) or add a reasoned UNFENCED_ALLOWED entry.\n${lines.join('\n')}`).toEqual([]);
  });

  test('every allow-list entry still names an unfenced call', () => {
    const stale = Object.keys(UNFENCED_ALLOWED).filter(key => !sites.some(s => `${s.file}:${s.member}` === key && !s.fenced));
    expect(stale).toEqual([]);
  });

  test('the census finds the callers of every lease family', () => {
    const found = new Set(sites.map(s => s.member));
    const families = Object.entries(FAMILY_NAMES).filter(([, members]) => !members.some(m => found.has(m))).map(([family]) => family);
    expect(families).toEqual([]);
    expect(sites.length).toBeGreaterThan(40);
  });
});
