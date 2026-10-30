/**
 * GBRA-161: set-time refusal for the generations.* keys (bounds and reader in core/generations/config.ts). A value out
 * of range exits with the shared usage-error shape and writes nothing.
 */
export async function refuseGenerationsValue(key: string, value: string): Promise<void> {
  const refusal = (await import('../../core/generations/config.ts')).generationsConfigRefusal(key, value);
  if (!refusal) return;
  const { exitCliError, usageError } = await import('../../cli/cli-error.ts');
  exitCliError(usageError(refusal.message, `Re-run with a value in range, e.g. gbrain config set ${key} ${refusal.example}.`,
    { fix: { argv: ['gbrain', 'config', 'get', key], consent: [], actor: 'agent', why: 'Shows the value in effect; nothing was written.', requires_exclusive: false } }), 'config');
}
