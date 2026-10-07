/**
 * `gbrain schema active [--source <id>] [--json]` (#6090): report the pack the
 * engine would use, resolved through the same tier chain as the engine
 * (`engineSchemaInput`), including the tier-3 per-source override. An unknown
 * source is refused (`unknown_source`); an unreadable database is a degraded
 * read: text mode marks it on stderr, `--json` exits nonzero with the
 * file-plane answer attached to a `database_error` envelope.
 */
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';
import { opError } from '../core/ops/contract.ts';
import { engineSchemaInput } from '../core/schema-pack/engine-resolution.ts';
import { loadActivePack, resolveActivePackNameOnly, type LoadActivePackInput } from '../core/schema-pack/load-active.ts';
import { fetchSource } from '../core/sources-load.ts';
import { writeCliRefusal } from '../cli/cli-error.ts';

type WithEngine = <T>(fn: (engine: BrainEngine) => Promise<T>) => Promise<T>;
type DatabaseRead =
  | { state: 'read'; input: LoadActivePackInput; sourceKnown: boolean }
  | { state: 'unreadable'; error: string }
  | { state: 'not_configured' };

const DOCS = 'docs/architecture/schema-packs.md#per-source-resolution';

async function readDatabasePlane(withEngine: WithEngine, sourceId: string | undefined): Promise<DatabaseRead> {
  try {
    return await withEngine(async (engine) => {
      const input = await engineSchemaInput(engine, { remote: false, sourceId });
      const source = sourceId ? await fetchSource(engine, sourceId) : null;
      return { state: 'read' as const, input, sourceKnown: !sourceId || (source !== null && source.archived !== true) };
    });
  } catch (e) {
    return { state: 'unreadable', error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runSchemaActive(opts: { json: boolean; sourceId?: string }, withEngine: WithEngine): Promise<void> {
  const { json, sourceId } = opts;
  const cfg = loadConfig();
  const db: DatabaseRead = cfg ? await readDatabasePlane(withEngine, sourceId) : { state: 'not_configured' };

  if (db.state === 'read' && !db.sourceKnown) {
    process.exit(writeCliRefusal(opError('unknown_source',
      `Source "${sourceId}" is not registered on this brain (or is archived), so no per-source pack applies to it.`,
      'Run `gbrain sources list --json` for the registered source ids, then pass one with --source.', {
        docs: DOCS,
        fix: { argv: ['gbrain', 'sources', 'list', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
          why: 'Lists the registered source ids that schema active --source accepts.' },
      }), 'schema', { json }));
  }

  const input: LoadActivePackInput = db.state === 'read' ? db.input : { cfg, remote: false, sourceId };
  const resolution = resolveActivePackNameOnly(input);
  const pack = await loadActivePack(input);
  const result = {
    schema_version: 1,
    pack: pack.manifest.name,
    version: pack.manifest.version,
    identity: pack.identity,
    resolved_from: resolution.source,
    source_id: sourceId ?? null,
    database: db.state,
    page_types: pack.manifest.page_types.length,
    link_verbs: pack.manifest.link_types.length,
    takes_kinds: pack.manifest.takes_kinds,
    ...(pack.manifest.description ? { description: pack.manifest.description } : {}),
  };

  if (db.state === 'unreadable') {
    const why = `The brain database could not be read (${db.error}), so the database-plane tiers (brain-wide schema_pack and per-source overrides) were skipped; the pack shown comes from env/config.json only and may not be what the engine uses.`;
    if (json) {
      process.exit(writeCliRefusal(opError('database_error', 'database unreadable: showing the env/config.json resolution only.',
        'Run `gbrain doctor --json` to diagnose the database, then rerun `gbrain schema active --json`.', {
          why, docs: DOCS,
          fix: { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
            why: 'Reports why the brain database is unreadable and names the repair.',
            verify: { argv: ['gbrain', 'schema', 'active', '--json'] } },
        }), 'schema', { json, legacy: { ...result, degraded: true } }));
    }
    console.error(`Degraded: database unreadable (${db.error}); showing the env/config.json resolution only. Run: gbrain doctor --json`);
  }

  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`Active pack: ${result.pack} v${result.version}`);
  console.log(`Source: ${result.resolved_from}`);
  if (sourceId) console.log(`Resolved for source ${sourceId}: ${result.resolved_from}`);
  console.log(`Pack identity: ${result.identity}`);
  console.log(`Page types: ${result.page_types}`);
  console.log(`Link verbs: ${result.link_verbs}`);
  console.log(`Takes kinds: ${result.takes_kinds.join(', ')}`);
  if (result.description) console.log(`\n${result.description}`);
}
