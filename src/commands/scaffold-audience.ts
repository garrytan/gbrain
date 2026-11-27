import { BOT_HARNESSES, sharedTokenNotice, writeExposureNotice, type ExposureServes } from '../core/grants/shared-exposure.ts';
import { resolveChildCliInvocation } from '../core/minions/job-isolation.ts';
import { readServesStatus } from './setup-serves.ts';

/** Read the same brain's audience before warning about a bot scaffold. */
export function warnForBotWorkspace(harness: string | null | undefined): void {
  if (!harness || !BOT_HARNESSES.includes(harness)) return;
  const cli = resolveChildCliInvocation({}, process.execPath, process.argv[1], () => null);
  let serves: ExposureServes = null;
  if (cli) {
    try {
      const result = readServesStatus([cli.cmd, ...cli.argsPrefix], 5_000);
      if ('status' in result) serves = result.status.serves;
    } catch { /* an unreadable brain keeps the warning */ }
  }
  writeExposureNotice(sharedTokenNotice({ kind: 'stdio', harness }, { harness, serves }));
}
