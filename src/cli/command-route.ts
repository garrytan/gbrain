/**
 * #7191: `search --exact "<phrase>"` is the exhaustive literal scan
 * (`search-exact`), routed before any ranked-search flag is parsed; a `--exact`
 * after a bare `--` is a positional and routes nothing. Shared by the CLI
 * dispatcher (cli/main.ts) and the docs command checker so both read the same
 * command. The `ask` alias stays inline in main.ts, where the dispatch-shape
 * analyzer reads it.
 *
 * GBRA-377: `skills index ...`, `skills resolve ...` and `skills library` route to the
 * engine-free skill resolver (`skill-resolver`) before help, prewarming or
 * any engine work; plain `skills` stays the `list_skills` listing.
 */
export function routeCommand(command: string, subArgs: string[]): { command: string; subArgs: string[] } {
  if (command === 'skills' && (subArgs[0] === 'index' || subArgs[0] === 'resolve' || subArgs[0] === 'library')) return { command: 'skill-resolver', subArgs };
  if (command !== 'search') return { command, subArgs };
  const at = subArgs.indexOf('--exact');
  const end = subArgs.indexOf('--');
  if (at < 0 || (end >= 0 && end < at)) return { command, subArgs };
  return { command: 'search-exact', subArgs: subArgs.filter((_, i) => i !== at) };
}
