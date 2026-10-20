/**
 * `gbrain apple`: pre-connect dispatch (engine-free; opens its own engine
 * only for source registration and status), run by handleCliOnly before the
 * connectEngine() terminator. The record lives in src/cli/command-table.ts.
 */
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';

export async function run(args: string[]): Promise<void> {
  const { runApple } = await import('../../commands/apple.ts');
  setCliExitVerdict(await runApple(args));
}
