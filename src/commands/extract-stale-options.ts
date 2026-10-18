/**
 * #6803 (D2): `gbrain extract --stale` source-option validation, run before both direct dispatch and the PGLite-owner
 * hand-off (`writer_extract_stale`). `--source fs|db` is extract's read-mode selector, never a source id: stale
 * extraction reads the database, so `--source db` is accepted (refused as ambiguous when a registered source is named
 * `db`), `--source fs` is refused, and any other `--source <x>` is refused with the `--source-id <x>` command that scopes
 * the sweep, instead of silently running brain-wide.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { Action } from '../core/agent-output.ts';
import { opError } from '../core/ops/contract.ts';
import { SOURCE_ID_RE } from '../core/source-id.ts';

export interface StaleSourceSelection { sourceId?: string; mode?: 'db' }

const sourceArgAt = (args: readonly string[], i: number): { value: string | undefined; width: number } =>
  args[i]!.startsWith('--source=') ? { value: args[i]!.slice('--source='.length), width: 1 } : { value: args[i + 1], width: 2 };

/** `args` with the `--source <x>` at `i` replaced by `replacement` (dropped when empty). */
function replaced(args: readonly string[], i: number, width: number, replacement: string[]): string[] {
  return ['gbrain', 'extract', ...args.slice(0, i), ...replacement, ...args.slice(i + width)];
}

const corrected = (argv: string[], why: string): Action => ({ argv, consent: [], actor: 'agent', requires_exclusive: false, why });
const invalid = (message: string, suggestion: string, fix?: Action) => opError('invalid_params', message, suggestion, fix ? { fix } : {});

/** Engine-free half: `--source` must be `db` (or absent); `--source-id` names the source to scope to. */
export function parseStaleSourceArgs(args: readonly string[]): StaleSourceSelection {
  const selection: StaleSourceSelection = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--source-id' || arg.startsWith('--source-id=')) {
      const value = arg === '--source-id' ? args[i + 1] : arg.slice('--source-id='.length);
      if (value && !value.startsWith('-')) selection.sourceId = value;
      continue;
    }
    if (arg !== '--source' && !arg.startsWith('--source=')) continue;
    const { value, width } = sourceArgAt(args, i);
    if (value === 'db') { selection.mode = 'db'; continue; }
    if (!value || value.startsWith('-')) {
      throw invalid('--source requires a value; extract --stale only takes --source db.',
        'Drop --source (stale extraction always reads the database), or pass --source-id with a source id to scope the sweep to that source.',
        corrected(replaced(args, i, 1, []), 'The same extraction without the empty --source; it reads the database.'));
    }
    if (value === 'fs') {
      throw invalid("extract --stale is DB-source only (it reads pages from the database); '--source fs' is not a mode it takes.",
        "Drop '--source fs' (stale extraction works on checkout-less brains). To scope the sweep to a source named fs, pass --source-id fs.",
        corrected(replaced(args, i, width, []), "The same extraction without '--source fs'; it reads the database."));
    }
    throw invalid(`'--source ${value}' does not select a source for extract --stale: --source picks the read mode (fs|db), and without --source-id the sweep would run brain-wide.`,
      `To scope the sweep to source ${value}, pass --source-id ${value}.`,
      SOURCE_ID_RE.test(value) ? corrected(replaced(args, i, width, ['--source-id', value]), `The same extraction scoped to source ${value}.`) : undefined);
  }
  return selection;
}

/** Engine half: `--source db` is ambiguous when a registered source has that id. */
export async function assertStaleSourceModeUnambiguous(engine: Pick<BrainEngine, 'executeRaw'>, args: readonly string[]): Promise<void> {
  if (parseStaleSourceArgs(args).mode !== 'db') return;
  const rows = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE id = $1', ['db']);
  if (!rows.length) return;
  const i = args.findIndex(arg => arg === '--source' || arg === '--source=db');
  throw invalid("'--source db' is ambiguous: it is extract's read mode, and a registered source is named db.",
    'Pass --source-id db to scope the sweep to that source, or drop --source db (stale extraction always reads the database) to sweep every source.',
    corrected(replaced(args, i, args[i] === '--source' ? 2 : 1, ['--source-id', 'db']), 'The same extraction scoped to the source named db.'));
}
