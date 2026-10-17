/** Disclose that legacy model writes are defaults, not authoritative overrides. */
export function warnLegacyModelPin(key: string): void {
  if (key !== 'chat_model' && key !== 'expansion_model') return;
  const task = key === 'chat_model' ? 'chat' : 'expansion';
  console.error(`[config] Stored in the DB plane. File/env ${key} pins and models.* overrides take precedence; this write may be shadowed. For a DB-authoritative task override: gbrain config set models.${task} <provider>:<model>. Running serves pick it up on restart; workers on their next gateway refresh.`);
}
