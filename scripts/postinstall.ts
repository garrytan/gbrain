const skipMessage =
  '[gbrain] postinstall skipped. If installed via bun install -g github:...: run `gbrain doctor` and `gbrain apply-migrations --yes` manually. See https://github.com/garrytan/gbrain/issues/218';

try {
  const proc = Bun.spawn(['gbrain', 'apply-migrations', '--yes', '--non-interactive'], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(skipMessage);
  }
} catch {
  console.error(skipMessage);
}
