/**
 * Process-wide Bun test isolation.
 *
 * This file must remain the first [test].preload entry in bunfig.toml. It uses
 * only node built-ins so GBRAIN_HOME and GBRAIN_AUDIT_DIR are replaced before
 * any GBrain application module can observe inherited production state.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
} from 'node:path';
import { randomUUID } from 'node:crypto';

const CHILD_PREFIX = 'gbrain-test-process-';
const OWNER_MARKER = '.gbrain-test-owner-v1';
const repoRoot = realpathSync(resolve(import.meta.dir, '..', '..'));

function normalized(path: string): string {
  const portable = resolve(path).replaceAll('\\', '/').replace(/\/$/, '');
  return process.platform === 'win32' ? portable.toLowerCase() : portable;
}

function samePath(left: string, right: string): boolean {
  return normalized(left) === normalized(right);
}

function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertPlainDirectory(path: string, label: string): string {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a plain directory`);
  }
  return realpathSync(path);
}

function hasGitBoundary(path: string): boolean {
  let cursor = path;
  for (;;) {
    if (existsSync(join(cursor, '.git'))) return true;
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function profileDefaults(): string[] {
  const homes = new Set<string>();
  for (const value of [homedir(), process.env.HOME, process.env.USERPROFILE]) {
    if (!value || !value.trim() || !isAbsolute(value.trim())) continue;
    homes.add(resolve(value.trim()));
  }
  return [...homes].flatMap((home) => [home, join(home, '.gbrain')]);
}

function validateParent(candidate: string, label: string, allowNonempty: boolean): string {
  if (!isAbsolute(candidate)) {
    throw new Error(`${label} must be absolute`);
  }
  const lexical = resolve(candidate);
  const canonical = assertPlainDirectory(lexical, label);
  if (!samePath(lexical, canonical)) {
    throw new Error(`${label} must not traverse a reparse or symlink boundary`);
  }
  if (samePath(canonical, parse(canonical).root)) {
    throw new Error(`${label} must not be a filesystem root`);
  }
  if (profileDefaults().some((profilePath) => samePath(canonical, profilePath))) {
    throw new Error(`${label} must not be a profile-default path`);
  }
  if (containsPath(repoRoot, canonical) || containsPath(canonical, repoRoot) || hasGitBoundary(canonical)) {
    throw new Error(`${label} must not be a repository, worktree, or source path`);
  }
  if (!allowNonempty && readdirSync(canonical).length !== 0) {
    throw new Error(`${label} must be empty`);
  }
  return canonical;
}

function resolveParent(): string {
  const raw = process.env.GBRAIN_TEST_HOME;
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) {
    // Bun's Windows os.tmpdir() may fall back to USERPROFILE when TEMP is
    // absent instead of consulting TMP. Preserve the explicit inherited
    // TEMP-then-TMP contract and use os.tmpdir() only as the platform fallback.
    const inheritedTemp = process.env.TEMP?.trim() || process.env.TMP?.trim() || tmpdir();
    // The shared OS temp may be nonempty, but it receives the same canonical
    // forbidden-boundary checks as an explicit parent.
    return validateParent(inheritedTemp, 'OS temporary parent', true);
  }
  return validateParent(trimmed, 'GBRAIN_TEST_HOME', false);
}

const parent = resolveParent();
const ownerNonce = randomUUID();
const child = join(parent, `${CHILD_PREFIX}${process.pid}-${ownerNonce}`);
const auditDir = join(child, '.gbrain', 'audit');

// Revalidate immediately before and after creation so a swapped explicit
// parent cannot redirect the owned child outside the accepted boundary.
const parentBefore = assertPlainDirectory(parent, 'test-home parent');
if (!samePath(parentBefore, parent)) {
  throw new Error('test-home parent changed before child creation');
}
mkdirSync(child, { recursive: false, mode: 0o700 });
const childReal = assertPlainDirectory(child, 'owned test child');
const parentAfter = assertPlainDirectory(parent, 'test-home parent');
if (!samePath(parentBefore, parentAfter) || !containsPath(parentAfter, childReal)) {
  throw new Error('owned test child escaped its validated parent');
}

writeFileSync(join(childReal, OWNER_MARKER), ownerNonce, {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o600,
});
mkdirSync(auditDir, { recursive: true, mode: 0o700 });

// Unconditional replacement is the contract: inherited values may point at
// production and must never survive until an application import.
process.env.GBRAIN_HOME = childReal;
process.env.GBRAIN_AUDIT_DIR = auditDir;

let cleanupAttempted = false;
const cleanupOwnedChild = () => {
  if (cleanupAttempted) return;
  cleanupAttempted = true;
  try {
    if (!existsSync(childReal)) return;
    const currentParent = assertPlainDirectory(parent, 'test-home parent');
    const currentChild = assertPlainDirectory(childReal, 'owned test child');
    if (!samePath(currentParent, parentAfter) || !samePath(currentChild, childReal)) {
      throw new Error('owned test path changed before cleanup');
    }
    if (!containsPath(currentParent, currentChild)) {
      throw new Error('owned test child escaped before cleanup');
    }
    const marker = readFileSync(join(currentChild, OWNER_MARKER), 'utf8');
    if (marker !== ownerNonce) {
      throw new Error('owned test marker mismatch');
    }
    rmSync(currentChild, { recursive: true, force: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown cleanup failure';
    process.stderr.write(`[home-isolation-preload] cleanup refused: ${message}\n`);
    process.exitCode = process.exitCode || 1;
  }
};

// EventEmitter runs exit listeners in registration order. Application/test
// modules load after this preload and may register a later listener that writes
// during shutdown. Keep the exact cleanup listener at the tail whenever a
// later exit listener is registered so that such a write cannot recreate the
// owned child after cleanup. No non-exit event behavior is changed.
type ProcessListener = (...args: unknown[]) => void;
type RegisterListener = (event: string | symbol, listener: ProcessListener) => NodeJS.Process;
const originalOn = process.on;
const originalOnce = process.once;
const originalAddListener = process.addListener;
const originalPrependListener = process.prependListener;
const originalPrependOnceListener = process.prependOnceListener;
const originalRemoveListener = process.removeListener;
let retailing = false;

function keepCleanupLast(register: RegisterListener): RegisterListener {
  return function registerWithCleanupLast(event, listener) {
    if (event !== 'exit' || listener === cleanupOwnedChild || retailing) {
      return register.call(process, event, listener);
    }
    retailing = true;
    originalRemoveListener.call(process, 'exit', cleanupOwnedChild);
    try {
      return register.call(process, event, listener);
    } finally {
      originalOn.call(process, 'exit', cleanupOwnedChild);
      retailing = false;
    }
  };
}

originalOn.call(process, 'exit', cleanupOwnedChild);
process.on = keepCleanupLast(originalOn as RegisterListener) as typeof process.on;
process.once = keepCleanupLast(originalOnce as RegisterListener) as typeof process.once;
process.addListener = keepCleanupLast(originalAddListener as RegisterListener) as typeof process.addListener;
process.prependListener = keepCleanupLast(originalPrependListener as RegisterListener) as typeof process.prependListener;
process.prependOnceListener = keepCleanupLast(originalPrependOnceListener as RegisterListener) as typeof process.prependOnceListener;

// Bun's test runner does not emit Node's process exit/beforeExit events. A
// preload-level afterAll hook is the runner-owned final lifecycle boundary and
// runs after test-file hooks, so ordinary successful `bun test` processes also
// retire their exact marked child. Direct `bun --preload` callers are not test
// runners; bun:test rejects hook registration there and the process-exit tail
// above remains their cleanup boundary.
try {
  const { afterAll } = await import('bun:test');
  afterAll(cleanupOwnedChild);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes('outside of the test runner')) throw error;
}
