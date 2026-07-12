import { spawnSync } from 'node:child_process';

const args = ['src/cli.ts', 'apply-migrations', '--yes', '--non-interactive'];

function run(command: string): boolean {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    windowsHide: true,
  });
  return result.status === 0;
}

if (!run(process.execPath) && !run('pmbrain') && !run('gbrain')) {
  console.error(
    '[pmbrain] postinstall skipped. If installed via bun install -g github:...: run `pmbrain doctor` and `pmbrain apply-migrations --yes` manually.',
  );
}
