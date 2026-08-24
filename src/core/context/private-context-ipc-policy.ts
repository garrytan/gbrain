/** Disabled-by-default deployment gate for trusted-local private packs. */
export function privateContextIpcEnabled(config: unknown): boolean {
  const env = process.env.GBRAIN_PRIVATE_CONTEXT_IPC;
  if (env !== undefined && env !== '') {
    return /^(true|1|on|yes)$/i.test(env.trim());
  }
  if (!config || typeof config !== 'object') return false;
  return (config as { private_context_ipc?: unknown }).private_context_ipc === true;
}
