/**
 * `config set` refusal for an unregistered leaf under an enumerated prefix.
 *
 * A prefix in KNOWN_CONFIG_KEY_PREFIXES admits any sub-key, so a misspelled
 * or retired `search.token_budget` (the reader is `search.tokenBudget`) used
 * to be written and never read. Under these prefixes every key gbrain reads
 * is registered in KNOWN_CONFIG_KEYS: `search.*` is pinned key by key in
 * test/config-search-registry.test.ts, and `content_sanity.*` has one reader,
 * the DB-plane merge in loadConfigWithEngine. Other prefixes hold per-phase,
 * per-provider or per-name sub-keys; `chronicle.*` has its own list.
 *
 * The refusal is a usage error (exit 2) naming the nearest registered
 * spelling; nothing is written. `--force` writes the key anyway (one a newer
 * gbrain reads) with a warning.
 */
import { KNOWN_CONFIG_KEYS } from '../../core/config.ts';
import { suggestNearest } from '../../core/levenshtein.ts';
import { inertText } from '../../core/agent-output.ts';
import { exitCliError, usageError } from '../../cli/cli-error.ts';

const ENUMERATED_CONFIG_KEY_PREFIXES: readonly string[] = ['search.', 'content_sanity.'];

export function refuseUnregisteredEnumeratedKey(key: string, force: boolean): void {
  const prefix = ENUMERATED_CONFIG_KEY_PREFIXES.find((p) => key.startsWith(p));
  if (!prefix || KNOWN_CONFIG_KEYS.includes(key)) return;
  // Case- and underscore-blind: the usual miss is a camelCase reader under a
  // snake_case write (or the reverse), not a typo.
  const fold = (k: string) => k.toLowerCase().replaceAll('_', '');
  const registered = KNOWN_CONFIG_KEYS.filter((k) => k.startsWith(prefix));
  const nearest = suggestNearest(fold(key), registered.map(fold), 3);
  const suggestion = registered.find((k) => fold(k) === nearest);
  const shown = inertText(key, 80);
  const didYouMean = suggestion ? ` Did you mean "${suggestion}"?` : '';
  if (force) {
    console.error(`[config] WARN: writing unregistered ${prefix}* key "${shown}" with --force. Nothing in gbrain reads it.${didYouMean}`);
    return;
  }
  const target = suggestion ?? '<KEY>';
  exitCliError(usageError(
    `Unknown config key "${shown}".${didYouMean} Nothing was written.`,
    suggestion
      ? `Set the registered key instead: gbrain config set ${suggestion} <value>. To write "${shown}" anyway (a key that a newer release reads), re-run with --force.`
      : `Set a registered ${prefix}* key instead. To write "${shown}" anyway (a key that a newer release reads), re-run with --force.`,
    {
      why: `Every ${prefix}* key gbrain reads is registered, so nothing would read this one.`,
      fix: {
        argv: ['gbrain', 'config', 'set', target, '<VALUE>'],
        inputs: [
          ...(suggestion ? [] : [{ name: 'KEY', how: `Ask the user which registered ${prefix}* key they meant; gbrain reads no other ${prefix}* key.` }]),
          { name: 'VALUE', how: 'The value the refused command carried.' },
        ],
        consent: [],
        actor: suggestion ? 'agent' : 'user',
        why: `Writes the value under the ${prefix}* key gbrain reads.`,
        verify: { argv: ['gbrain', 'config', 'get', target] },
        requires_exclusive: false,
      },
    },
  ), 'config');
}
