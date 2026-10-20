/**
 * #6795: `gbrain config set chat_model|expansion_model` writes a DB-plane
 * default. A `models.*` key, `GBRAIN_MODEL`, the per-key env var or a
 * config.json pin outranks it at runtime (gateway.ts resolveGatewayModels +
 * ai/legacy-model-pin.ts). This names the one that actually wins, by key,
 * variable or file path, never its value, with the fix that clears it.
 */
import { cliRenderContext, renderNotice, type Action, type Notice } from '../../core/agent-output.ts';
import { configPath, loadConfigFileOnly, saveConfig } from '../../core/config.ts';
import type { ConfigReader } from '../../core/config-snapshot.ts';

export type LegacyModelKey = 'chat_model' | 'expansion_model';
export const isLegacyModelKey = (key: string): key is LegacyModelKey => key === 'chat_model' || key === 'expansion_model';

export interface ModelPinShadow { kind: 'config_key' | 'env' | 'file'; name: string }

export async function modelPinShadow(engine: ConfigReader, key: LegacyModelKey): Promise<ModelPinShadow | null> {
  const chat = key === 'chat_model';
  for (const name of [chat ? 'models.chat' : 'models.expansion', chat ? 'models.tier.reasoning' : 'models.tier.utility', 'models.default']) {
    if ((await engine.getConfig(name))?.trim()) return { kind: 'config_key', name };
  }
  for (const name of ['GBRAIN_MODEL', chat ? 'GBRAIN_CHAT_MODEL' : 'GBRAIN_EXPANSION_MODEL']) {
    if (process.env[name]?.trim()) return { kind: 'env', name };
  }
  return loadConfigFileOnly()?.[key] !== undefined ? { kind: 'file', name: configPath() } : null;
}

export function modelPinShadowNotice(key: LegacyModelKey, shadow: ModelPinShadow): Notice {
  const by = shadow.kind === 'config_key' ? `the config key ${shadow.name}`
    : shadow.kind === 'env' ? `the environment variable ${shadow.name}` : `the ${key} pin in ${shadow.name}`;
  const verify = { argv: ['gbrain', 'config', 'get', shadow.kind === 'config_key' ? shadow.name : key] };
  const fix: Action = shadow.kind === 'config_key'
    ? { argv: ['gbrain', 'config', 'unset', shadow.name], ask_user: true, consent: [], actor: 'agent', requires_exclusive: false, verify,
      why: `Removes ${shadow.name} so the ${key} just written takes effect; it may also select other models, so ask first.` }
    : shadow.kind === 'env'
      ? { argv: ['unset', shadow.name], consent: [], actor: 'user', requires_exclusive: false, verify,
        why: `${shadow.name} is set in the environment gbrain runs in; only the user can remove it (shell profile or service environment).` }
      : { argv: ['gbrain', 'config', 'unset', key, '--file'], ask_user: true, consent: [], actor: 'agent', requires_exclusive: false, verify,
        why: `Removes the ${key} pin from ${shadow.name} so the database value just written takes effect.` };
  return { code: 'config_write_shadowed', kind: 'degraded', why: `${key} was stored in the database, but ${by} outranks it, so the model in use does not change.`, fix };
}

/** The confirmation of a DB write to a legacy model key: `effective` says whether it takes effect, `shadowed_by` what outranks it. */
export async function reportLegacyModelWrite(engine: ConfigReader, key: LegacyModelKey, value: string, json: boolean): Promise<void> {
  const shadow = await modelPinShadow(engine, key);
  const notice = shadow ? modelPinShadowNotice(key, shadow) : null;
  if (json) {
    console.log(JSON.stringify({ key, value, written: true, effective: shadow === null, ...(shadow ? { shadowed_by: shadow, notices: [renderNotice(notice!, cliRenderContext())] } : {}) }));
    return;
  }
  console.log(`Set ${key} = ${value}`);
  if (notice) console.error(`[config] WARN: ${notice.why} Fix: ${notice.fix!.argv!.join(' ')} (${notice.fix!.why})`);
}

/** `gbrain config unset chat_model|expansion_model --file`: drop only the config.json pin; the database value stays. */
export function unsetModelFilePin(key: LegacyModelKey): void {
  const cfg = loadConfigFileOnly();
  if (!cfg || cfg[key] === undefined) {
    console.error(`Config key not found in ${configPath()}: ${key}`);
    process.exit(1);
  }
  delete cfg[key];
  saveConfig(cfg);
  console.log(`Unset ${key} (file plane: ${configPath()})`);
}
