/**
 * #5984 G3: the parameter types a pool has described, shared by every pool in
 * this process that talks to the same database and kept in a file under the
 * gbrain home so the next process skips those describe round trips too.
 *
 * Safety rules (docs/eval/managed-sync-catchup.md, "Statement descriptions"):
 * - the driver stores only built-in parameter types and drops a statement's
 *   entry when that statement fails;
 * - the file is used only when its scope (server_version_num and the brain's
 *   schema version) matches the connected database; a migration clears it;
 * - keys are SHA-256 digests of the driver's (types, SQL) key, so no SQL text is
 *   written; the file is 0600 in a 0700 directory.
 *
 * `GBRAIN_PG_TYPE_CACHE=0` turns sharing off; `GBRAIN_PG_TYPE_CACHE_PERSIST=0`
 * keeps it in this process.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGbrainHome } from './gbrain-home.ts';

const MAX_ENTRIES = 4000;
const SAVE_DELAY_MS = 5000;

function digest(key: string): string {
  return createHash('sha256').update(key).digest('base64url');
}

function envOff(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '0' || value === 'false';
}

/** A database target without credentials: host, port, database and user. */
export function typeCacheTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}/${decodeURIComponent(u.pathname.replace(/^\//, ''))}?${decodeURIComponent(u.username)}`;
  } catch {
    return url.replace(/:\/\/[^@/]*@/, '://');
  }
}

export class SharedParameterTypes extends Map<string, number[]> {
  scope: string | null = null;
  file: string | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  override get(key: string): number[] | undefined {
    return super.get(digest(key));
  }

  override set(key: string, types: number[]): this {
    if (super.size >= MAX_ENTRIES) return this;
    super.set(digest(key), types);
    this.changed();
    return this;
  }

  override delete(key: string): boolean {
    const removed = super.delete(digest(key));
    if (removed) this.changed();
    return removed;
  }

  override clear(): void {
    super.clear();
    this.scope = null;
    this.dirty = false;
    if (this.file) rmSync(this.file, { force: true });
  }

  /** Merges the file's entries when its scope matches; from then on new entries are saved under that scope. */
  load(scope: string, file: string): number {
    this.scope = scope;
    this.file = file;
    const stored = readStore(file);
    if (!stored || stored.scope !== scope) return 0;
    let added = 0;
    for (const [key, types] of Object.entries(stored.types)) {
      if (super.size >= MAX_ENTRIES) break;
      if (!super.has(key)) { super.set(key, types); added++; }
    }
    return added;
  }

  /** Writes this process's entries, merged with what another process saved under the same scope. */
  save(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty || !this.file || !this.scope) return;
    this.dirty = false;
    try {
      const stored = readStore(this.file);
      const types: Record<string, number[]> = stored?.scope === this.scope ? stored.types : {};
      for (const [key, value] of super.entries()) types[key] = value;
      const keys = Object.keys(types);
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete types[key];
      mkdirSync(join(this.file, '..'), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ scope: this.scope, types }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // A cache that cannot be written only costs the next process its describes.
    }
  }

  private changed(): void {
    if (!this.file) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => this.save(), SAVE_DELAY_MS);
    this.timer.unref?.();
  }
}

function readStore(file: string): { scope: string; types: Record<string, number[]> } | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { scope?: unknown; types?: unknown };
    if (typeof parsed.scope !== 'string' || !parsed.types || typeof parsed.types !== 'object') return null;
    const types: Record<string, number[]> = {};
    for (const [key, value] of Object.entries(parsed.types as Record<string, unknown>)) {
      if (Array.isArray(value) && value.every(t => Number.isInteger(t) && t > 0 && t < 16384)) types[key] = value as number[];
    }
    return { scope: parsed.scope, types };
  } catch {
    return null;
  }
}

const byTarget = new Map<string, SharedParameterTypes>();
let exitHook = false;

/** The shared store for this database target, or false when `GBRAIN_PG_TYPE_CACHE=0`. */
export function sharedParameterTypes(url: string | undefined): SharedParameterTypes | false {
  if (envOff('GBRAIN_PG_TYPE_CACHE')) return false;
  if (!url) return new SharedParameterTypes();
  const target = typeCacheTarget(url);
  let store = byTarget.get(target);
  if (!store) {
    store = new SharedParameterTypes();
    byTarget.set(target, store);
  }
  return store;
}

/**
 * Loads the saved descriptions for this pool's store once its scope is known.
 * `serverVersion` is `server_version_num`; `schemaVersion` is `config.version`;
 * `database` names the database as the server sees it (database, server address
 * and port, user), so a proxy or pooler URL and a direct URL to one database
 * share a file. Without it the URL's target is used.
 */
export function loadSharedParameterTypes(url: string, serverVersion: string, schemaVersion: string | null, database?: string | null): number {
  const store = sharedParameterTypes(url);
  if (!store || !schemaVersion || envOff('GBRAIN_PG_TYPE_CACHE_PERSIST')) return 0;
  const scope = `${serverVersion}:${schemaVersion}`;
  if (store.scope === scope) return 0;
  const file = join(resolveGbrainHome(), 'cache', 'pg-types', `${digest(database || typeCacheTarget(url)).slice(0, 24)}.json`);
  const added = store.load(scope, file);
  if (!exitHook) {
    exitHook = true;
    process.once('exit', () => { for (const s of byTarget.values()) s.save(); });
  }
  return added;
}

export function _resetSharedParameterTypesForTests(): void {
  for (const store of byTarget.values()) store.scope = null;
  byTarget.clear();
}
