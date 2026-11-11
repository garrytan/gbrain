/**
 * A warm catalog handle for a long-lived host (an adapter's process, a
 * daemon): `openCatalog(catalogs, opts)` keeps each catalog's receipt and
 * open index (term dictionary, lengths, offsets) and the resolver settings
 * in memory, so a turn reads only the postings and metadata it ranks. Each
 * turn stats every catalog's receipt.json and index.bin, and config.json,
 * once, and reloads only what a rebuild or an edit replaced; a removed
 * catalog refuses exactly as it does cold. Turns run through resolve.ts
 * runTurn, the code resolveSkills runs, so the output, the pending commit
 * and every error match resolveSkills byte for byte apart from
 * meta.timing_ms. The per-turn freshness sweep and stamps are unchanged.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { readResolverSettings, type ResolverSettings } from './config.ts';
import { catalogFile } from './paths.ts';
import { openCatalogIndex, runTurn, type OpenedCatalog, type ResolveOptions, type ResolveResult, type TurnInput, type TurnSource } from './resolve.ts';

export type CatalogHandleOptions = Omit<ResolveOptions, 'catalogs'>;
export type CatalogTurnOptions = Omit<ResolveOptions, 'catalogs' | 'home' | 'env'>;

export interface CatalogHandle {
  /** One turn, as resolveSkills(input, { ...opts, ...turn, catalogs }). */
  resolve(input: TurnInput | unknown, turn?: CatalogTurnOptions): Promise<ResolveResult>;
  /** Close the open index files; a later resolve opens them again. */
  close(): void;
}

const fileId = (path: string): string => { try { const s = statSync(path); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`; } catch { return '-'; } };

/** Open a warm handle over the named catalogs (none: the only built catalog, as resolveSkills picks it each turn). */
export function openCatalog(catalogs: string[], opts: CatalogHandleOptions = {}): CatalogHandle {
  const kept = new Map<string, { id: string; c: OpenedCatalog }>();
  let settings: { key: string; value?: ResolverSettings; error?: unknown } | null = null;
  const drop = (name: string) => { kept.get(name)?.c.ix.close(); kept.delete(name); };
  const source: TurnSource = {
    settings(home, env) {
      const key = `${home}|${fileId(join(home, 'config.json'))}|${(env ?? process.env).GBRAIN_SKILLS_NO_AUTOREBUILD}`;
      if (settings?.key !== key) {
        try { settings = { key, value: readResolverSettings(home, env) }; } catch (error) { settings = { key, error }; }
      }
      if (settings.error !== undefined) throw settings.error;
      return settings.value!;
    },
    open(home, name) {
      const id = `${home}|${fileId(catalogFile(home, name, 'receipt.json'))}|${fileId(catalogFile(home, name, 'index.bin'))}`;
      const k = kept.get(name);
      if (k?.id === id) return k.c;
      drop(name);
      const c = openCatalogIndex(home, name);
      kept.set(name, { id, c });
      return c;
    },
    done(opened) { for (const name of [...kept.keys()]) if (!opened.some(c => c.name === name)) drop(name); },
  };
  return {
    resolve: (input, turn = {}) => runTurn(input, { ...opts, ...turn, catalogs }, source),
    close: () => { for (const name of [...kept.keys()]) drop(name); },
  };
}
