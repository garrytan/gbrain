import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';

export function redactUrl(url: string): string {
  // Redact password in postgresql:// URLs
  return url.replace(
    /(postgresql:\/\/[^:]+:)([^@]+)(@)/,
    '$1***$3',
  );
}

export function isSensitiveConfigKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return /(^|[_.-])(api[_-]?key|token|secret|password|passwd|pwd|pat)([_.-]|$)/.test(normalized)
    || normalized.includes('password')
    || normalized.endsWith('_key')
    || normalized.endsWith('.key');
}

export function redactConfigValue(key: string, value: string): string {
  if (value.includes('postgresql://')) return redactUrl(value);
  return isSensitiveConfigKey(key) ? '<REDACTED>' : value;
}

export async function runConfig(engine: BrainEngine, args: string[]) {
  const action = args[0];
  const key = args[1];
  const value = args[2];

  if (action === 'show') {
    const config = loadConfig();
    if (!config) {
      console.error('No config found. Run: gbrain init');
      process.exit(1);
    }
    console.log('GBrain config:');
    for (const [k, v] of Object.entries(config)) {
      const display = typeof v === 'string' && v.includes('postgresql://')
        ? redactUrl(v)
        : typeof v === 'string' && (k.includes('key') || k.includes('secret'))
          ? '***'
          : v;
      console.log(`  ${k}: ${display}`);
    }
    return;
  }

  if (action === 'get' && key) {
    const val = await engine.getConfig(key);
    if (val !== null) {
      console.log(val);
    } else {
      console.error(`Config key not found: ${key}`);
      process.exit(1);
    }
  } else if (action === 'set' && key && value) {
    await engine.setConfig(key, value);
    console.log(`Set ${key} = ${redactConfigValue(key, value)}`);
  } else {
    console.error('Usage: gbrain config [show|get|set] <key> [value]');
    process.exit(1);
  }
}
