import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';

/**
 * `cycle.lint_fix` (default on): only an explicit falsy value makes the
 * cycle's lint phase report-only; a config read failure keeps the default.
 * `gbrain lint --fix` is unaffected. Its own module so the cycle reads the
 * setting without depending on the lint command's export surface.
 */
export async function cycleLintFixEnabled(engine?: BrainEngine | null): Promise<boolean> {
  return !/^\s*(false|0|off|no)\s*$/i.test(await engine?.getConfig('cycle.lint_fix').catch(() => null) ?? '');
}

export const CYCLE_LINT_EXCLUDE_KEY = 'cycle.lint_exclude';

/**
 * #6134: `cycle.lint_exclude` is a comma-separated list of directory or file
 * basenames the cycle's lint phase and the minion lint handlers skip, matched
 * like `gbrain lint --exclude`. Whitespace is trimmed and blank entries are
 * dropped; unset excludes nothing. `config set` refuses a path, which a
 * basename match would never apply.
 */
export function parseCycleLintExclude(raw: string): string[] {
  const names = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!names.some(name => /[\\/]/.test(name))) return names;
  throw opError('invalid_params', `Invalid ${CYCLE_LINT_EXCLUDE_KEY}: expected comma-separated basenames, not paths.`,
    `Set ${CYCLE_LINT_EXCLUDE_KEY} to directory or file names without a slash, for example: gbrain config set ${CYCLE_LINT_EXCLUDE_KEY} attachments,drafts.md`, {
      why: 'Lint matches each entry against one directory or file name at a time, so an entry with a slash would never apply. Nothing was written.',
      fix: {
        argv: ['gbrain', 'config', 'set', CYCLE_LINT_EXCLUDE_KEY, '<NAMES>'],
        inputs: [{ name: 'NAMES', how: 'Comma-separated directory or file basenames to skip (the last part of each path); ask the user when unclear.' }],
        consent: [], actor: 'agent', requires_exclusive: false,
        why: 'The next lint phase skips the named directories and files.',
        verify: { argv: ['gbrain', 'config', 'get', CYCLE_LINT_EXCLUDE_KEY] },
      },
    });
}

/** The cycle's lint excludes; an unreadable setting or an entry with a slash (written with --force) contributes nothing. */
export async function cycleLintExcludes(engine?: BrainEngine | null): Promise<string[]> {
  const raw = await engine?.getConfig(CYCLE_LINT_EXCLUDE_KEY).catch(() => null) ?? '';
  return raw.split(',').map(s => s.trim()).filter(name => name && !/[\\/]/.test(name));
}
