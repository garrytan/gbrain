/**
 * GBRA-150: `config set sync.metafile_pages`. A value outside `typed | off` is refused as a usage error (exit 2) and
 * nothing is written: sync reads any other stored value as the default (`typed`), so a misspelled `of` would
 * silently keep importing typed metafiles.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { DEFAULT_METAFILE_PAGES_MODE, METAFILE_PAGES_MODES, SYNC_METAFILE_PAGES_KEY } from '../../core/sync.ts';
import { inertText } from '../../core/agent-output.ts';
import { exitCliError, usageError } from '../../cli/cli-error.ts';

export async function setMetafilePagesValue(engine: BrainEngine, value: string): Promise<void> {
  const normalized = value.trim().toLowerCase();
  if (!(METAFILE_PAGES_MODES as readonly string[]).includes(normalized)) {
    exitCliError(usageError(`${SYNC_METAFILE_PAGES_KEY} is one of ${METAFILE_PAGES_MODES.join(', ')}; "${inertText(value, 40)}" is not. Nothing was written.`,
      `Re-run with one of them: foresights config set ${SYNC_METAFILE_PAGES_KEY} off keeps every folder-scaffolding file out of the brain; ${DEFAULT_METAFILE_PAGES_MODE} (the default) imports a nested one whose frontmatter has type: or title:.`, {
        why: `Sync reads any other stored value as ${DEFAULT_METAFILE_PAGES_MODE}.`,
        fix: { argv: ['gbrain', 'config', 'get', SYNC_METAFILE_PAGES_KEY], consent: [], actor: 'agent', why: 'Shows the value in effect; nothing was written.', requires_exclusive: false },
      }), 'config');
  }
  await engine.setConfig(SYNC_METAFILE_PAGES_KEY, normalized);
}
