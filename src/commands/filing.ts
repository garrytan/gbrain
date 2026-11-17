/**
 * foresights filing — the filing method a source follows for NEW pages.
 *
 *   foresights filing [show] [--source <id>] [--json]
 *   foresights filing set <generic|para|lyt|zettelkasten> [--source <id>]
 *   foresights filing route <type> <title> [--project <name>] [--area <name>] [--archived] [--source <id>] [--json]
 *
 * The mode lives in sources.config.filing_mode (absent: generic). `route`
 * suggests the slug a new page should get under the source's mode (core/filing/
 * modes.ts); generic mode uses the active schema pack's folder for the type.
 * A taken slug gets -2, -3 ... Changing the mode never moves an existing page.
 */
import type { BrainEngine } from '../core/engine.ts';
import {
  DEFAULT_FILING_MODE, FILING_MODES, FILING_MODE_DESCRIPTIONS, isFilingMode, routeNewPage, type FilingMode, type FilingSuggestion,
} from '../core/filing/modes.ts';

const USAGE = `Usage: foresights filing [show | set <mode> | route <type> <title>] [--source <id>] [--json]
  show                   the source's filing mode (default)
  set <mode>             file NEW pages by: ${FILING_MODES.join(', ')}; existing pages never move
  route <type> <title>   where a new page of this type and title goes
    --project <name>     para: it serves this project
    --area <name>        para: it belongs to this ongoing area
    --archived           para: it is finished or inactive
  --source <id>          the source (default: the current source; see foresights sources current)
  --json                 machine-readable output`;

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined; // the CLI entry splits --flag=value (cli/flag-equals.ts)
}

/** Positional arguments: everything that is neither a flag nor a flag's value. */
function positionals(args: string[]): string[] {
  const valued = new Set(['--source', '--project', '--area']);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valued.has(a)) { i++; continue; }
    if (a.startsWith('--')) continue;
    out.push(a);
  }
  return out;
}

export async function getFilingMode(engine: BrainEngine, sourceId: string): Promise<FilingMode | null> {
  const [row] = await engine.executeRaw<{ mode: string | null }>(
    "SELECT config->>'filing_mode' AS mode FROM sources WHERE id = $1", [sourceId]);
  if (!row) return null;
  return isFilingMode(row.mode) ? row.mode : DEFAULT_FILING_MODE;
}

export async function setFilingMode(engine: BrainEngine, sourceId: string, mode: FilingMode): Promise<boolean> {
  const rows = await engine.executeRaw<{ id: string }>(
    `UPDATE sources SET config = jsonb_set(CASE WHEN jsonb_typeof(config) = 'object' THEN config ELSE '{}'::jsonb END,
       '{filing_mode}', to_jsonb($2::text)) WHERE id = $1 RETURNING id`, [sourceId, mode]);
  return rows.length > 0;
}

/** The active schema pack's first folder for a type, without the trailing slash: its own name first, then an alias. */
async function packTypeFolder(engine: BrainEngine, sourceId: string, type: string): Promise<string | undefined> {
  try {
    const { loadActivePackForEngine } = await import('../core/schema-pack/engine-resolution.ts');
    const types = (await loadActivePackForEngine(engine, { remote: false, sourceId })).manifest.page_types ?? [];
    const t = type.toLowerCase();
    const hit = types.find(p => p.name === t) ?? types.find(p => (p.aliases ?? []).includes(t));
    return hit?.path_prefixes?.[0]?.replace(/\/+$/, '') || undefined;
  } catch {
    return undefined; // no readable pack: the router falls back to the plural of the type
  }
}

/** The suggestion with a slug no live page of the source uses (-2, -3 ... when taken). */
export async function routeForSource(engine: BrainEngine, sourceId: string, mode: FilingMode,
  req: { type: string; title: string; project?: string; area?: string; archived?: boolean; now?: Date }): Promise<FilingSuggestion> {
  const suggestion = routeNewPage(mode, { ...req, typeFolder: await packTypeFolder(engine, sourceId, req.type) });
  for (let n = 1; n <= 50; n++) {
    const slug = n === 1 ? suggestion.slug : `${suggestion.slug}-${n}`;
    const taken = await engine.executeRaw('SELECT 1 FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [sourceId, slug]);
    if (taken.length === 0) return { ...suggestion, slug };
  }
  return suggestion;
}

export async function runFiling(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return; }
  const pos = positionals(args);
  const sub = pos[0] ?? 'show';
  const { resolveSourceId } = await import('../core/source-resolver.ts');
  const sourceId = await resolveSourceId(engine, flagValue(args, '--source') ?? null);
  const json = args.includes('--json');
  const mode = await getFilingMode(engine, sourceId);
  if (mode === null) {
    console.error(`No source "${sourceId}". See foresights sources list.`);
    process.exitCode = 1;
    return;
  }

  if (sub === 'show') {
    if (json) { console.log(JSON.stringify({ source: sourceId, mode, modes: FILING_MODE_DESCRIPTIONS }, null, 2)); return; }
    console.log(`Source ${sourceId} files new pages in ${mode} mode: ${FILING_MODE_DESCRIPTIONS[mode]}.`);
    console.log('Modes:');
    for (const m of FILING_MODES) console.log(`  ${m === mode ? '*' : ' '} ${m.padEnd(12)} ${FILING_MODE_DESCRIPTIONS[m]}`);
    console.log(`Change it with: foresights filing set <mode>${sourceId === 'default' ? '' : ` --source ${sourceId}`}. Existing pages never move.`);
    return;
  }

  if (sub === 'set') {
    const next = pos[1];
    if (!isFilingMode(next)) {
      console.error(`foresights filing set: give one of ${FILING_MODES.join(', ')}.`);
      process.exitCode = 1;
      return;
    }
    await setFilingMode(engine, sourceId, next);
    if (json) { console.log(JSON.stringify({ source: sourceId, mode: next, previous: mode }, null, 2)); return; }
    console.log(`Source ${sourceId} now files new pages in ${next} mode: ${FILING_MODE_DESCRIPTIONS[next]}. Existing pages stay where they are.`);
    return;
  }

  if (sub === 'route') {
    const [, type, ...titleParts] = pos;
    const title = titleParts.join(' ').trim();
    if (!type || !title) {
      console.error('foresights filing route: give a page type and a title, for example: foresights filing route concept "Flywheel effect"');
      process.exitCode = 1;
      return;
    }
    const s = await routeForSource(engine, sourceId, mode,
      { type, title, project: flagValue(args, '--project'), area: flagValue(args, '--area'), archived: args.includes('--archived') });
    if (json) { console.log(JSON.stringify({ source: sourceId, ...s }, null, 2)); return; }
    console.log(`${s.slug}\n  ${s.reason} (${mode} mode).`);
    if (Object.keys(s.frontmatter).length) console.log(`  Frontmatter: ${Object.entries(s.frontmatter).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
    return;
  }

  console.error(USAGE);
  process.exitCode = 1;
}
