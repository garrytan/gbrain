/**
 * `gbrain sources writers <id>` (GBRA-504): lists or changes who may write a
 * guest source (guest_sources.writers, which the trust trigger enforces).
 * Refuses a source that is not a guest source. Trusted local CLI only.
 */
import type { BrainEngine } from '../core/engine.ts';
import { GUEST_WRITER_FORMAT, changeGuestWriters, isGuestWriter, readGuestSource } from '../core/guests/sources.ts';

export const SOURCES_WRITERS_USAGE = `Usage: gbrain sources writers <id> [--add ${GUEST_WRITER_FORMAT}]... [--remove <writer>]... [--clear] [--json]
  Lists the writers of a guest source, or changes them. Only a listed writer can
  create or change pages there.`;

export async function runSourcesWriters(engine: BrainEngine, args: string[]): Promise<void> {
  const add: string[] = [], remove: string[] = [];
  let id: string | undefined, clear = false, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--clear') clear = true;
    else if (arg === '--json') json = true;
    else if ((arg === '--add' || arg === '--remove') && args[i + 1] !== undefined) (arg === '--add' ? add : remove).push(args[++i]!);
    else if (arg === '--help' || arg === '-h') { console.log(SOURCES_WRITERS_USAGE); return; }
    else if (!arg.startsWith('-') && id === undefined) id = arg;
    else {
      console.error(`Unknown or incomplete argument: ${arg}`);
      console.error(SOURCES_WRITERS_USAGE);
      process.exit(2);
    }
  }
  if (!id) { console.error(SOURCES_WRITERS_USAGE); process.exit(2); }
  const malformed = add.filter(w => !isGuestWriter(w));
  if (malformed.length > 0) {
    console.error(`Not a writer principal: ${malformed.join(', ')}. Name each writer as ${GUEST_WRITER_FORMAT}.`);
    process.exit(2);
  }
  const [source] = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE id = $1', [id]);
  if (!source) {
    console.error(`Source "${id}" not found. List sources with: gbrain sources list`);
    process.exit(4);
  }
  const changing = clear || add.length > 0 || remove.length > 0;
  const guest = changing ? await changeGuestWriters(engine, id, { clear, add, remove }) : await readGuestSource(engine, id);
  if (!guest) {
    console.error(`Source "${id}" is not a guest source, so it has no writer list. Set one up with: gbrain guests init --source <id>`);
    process.exit(2);
  }
  if (json) { console.log(JSON.stringify({ source: guest.source_id, writers: guest.writers, trust_ceiling: guest.trust_ceiling })); return; }
  console.log(`${changing ? 'Writers of' : 'Guest source'} "${id}"${changing ? ' are now' : ' writers'}: ${guest.writers.length > 0 ? guest.writers.join(', ') : 'none (nobody can create or change its pages)'}`);
}
