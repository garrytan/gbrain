/**
 * `gbrain sources set-precedence <id> <class>` / `--clear` (agent-platform C3): the per-source precedence class
 * (`sources.config.precedence`) every row from that source is labeled with: record, approved, curated, doc, chat or
 * external (eligibility/precedence.ts). A label only: it never raises trust and never changes ranking. Trusted local
 * CLI only, like set-trust. A guest source is always external, whatever this says.
 */
import type { BrainEngine } from '../core/engine.ts';
import { normalizeSourceConfig, parseSourceConfig } from '../core/sources-load.ts';
import { PRECEDENCE_CLASSES, isPrecedence } from '../core/eligibility/precedence.ts';

export const SOURCES_SET_PRECEDENCE_USAGE = `Usage: gbrain sources set-precedence <id> <${PRECEDENCE_CLASSES.join('|')}> | --clear`;

export async function runSetPrecedence(engine: BrainEngine, args: string[]): Promise<void> {
  const [id, value] = args;
  if (!id || id.startsWith('-') || !value) {
    console.error(SOURCES_SET_PRECEDENCE_USAGE);
    process.exit(2);
  }
  if (value !== '--clear' && !isPrecedence(value)) {
    console.error(`${JSON.stringify(value)} is not a precedence class. Accepted: ${PRECEDENCE_CLASSES.join(', ')}.`);
    process.exit(2);
  }
  const [src] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [id]);
  if (!src) {
    console.error(`Source "${id}" not found. List sources with: gbrain sources list`);
    process.exit(4);
  }
  const config = parseSourceConfig(src.config);
  if (value === '--clear') delete config.precedence;
  else config.precedence = value;
  await engine.executeRaw('UPDATE sources SET config = $1::text::jsonb WHERE id = $2', [JSON.stringify(normalizeSourceConfig(config)), id]);
  console.log(value === '--clear'
    ? `Source "${id}" uses the default precedence again (chat for the conversation archive, meeting and Google sources, external for guests, curated otherwise).`
    : `Rows from source "${id}" are now labeled precedence ${value}. It is a label: trust and ranking are unchanged.`);
}
