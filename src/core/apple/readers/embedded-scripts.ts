/**
 * The three Apple helper scripts, embedded as text (#6855).
 *
 * `bun build --compile` bundles JS into a read-only `/$bunfs` filesystem, so a
 * helper path derived from `import.meta.url` does not exist for `swift` /
 * `osascript` to open. Importing each script with `{ type: 'text' }` inlines
 * its bytes in the bundle (and reads the real file under `bun run`).
 * `scripts/apple/*` stays the single source of truth; test/apple-embedded-scripts
 * asserts the embedded text equals the file bytes and that a bundle inlines it.
 *
 * At run time the text is written to a private temp directory (0700, files
 * 0600, unique per run, removed afterwards) and that path is handed to the
 * interpreter. The text is fixed package content, never user input.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-ignore — `type: 'text'` import attribute is valid Bun syntax, not in lib.d.ts
import CALENDAR_SWIFT_IMPORT from '../../../../scripts/apple/calendar.swift' with { type: 'text' };
// @ts-ignore
import CONTACTS_SWIFT_IMPORT from '../../../../scripts/apple/contacts.swift' with { type: 'text' };
// @ts-ignore
import MAIL_JS_IMPORT from '../../../../scripts/apple/mail.js' with { type: 'text' };

export const CALENDAR_SWIFT_TEXT: string = CALENDAR_SWIFT_IMPORT;
export const CONTACTS_SWIFT_TEXT: string = CONTACTS_SWIFT_IMPORT;
export const MAIL_JS_TEXT: string = MAIL_JS_IMPORT;

export type HelperScriptName = 'calendar.swift' | 'contacts.swift' | 'mail.js';

export const HELPER_SCRIPT_TEXT: Record<HelperScriptName, string> = {
  'calendar.swift': CALENDAR_SWIFT_TEXT,
  'contacts.swift': CONTACTS_SWIFT_TEXT,
  'mail.js': MAIL_JS_TEXT,
};

/**
 * Write the script to a fresh private directory, run `fn` with its path, and
 * remove the directory afterwards (also when `fn` throws).
 */
export async function withHelperScript<T>(name: HelperScriptName, fn: (scriptPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-apple-'));
  try {
    chmodSync(dir, 0o700);
    const path = join(dir, name);
    writeFileSync(path, HELPER_SCRIPT_TEXT[name], { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
    return await fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
