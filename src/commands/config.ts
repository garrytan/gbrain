import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';

function redactUrl(url: string): string {
  // Redact password in postgresql:// URLs
  return url.replace(
    /(postgresql:\/\/[^:]+:)([^@]+)(@)/,
    '$1***$3',
  );
}

function redactConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactConfigValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => {
        if (typeof val === 'string') {
          if (/key|secret|token|password/i.test(key)) return [key, '***'];
          if (val.includes('postgresql://')) return [key, redactUrl(val)];
          return [key, val];
        }
        return [key, redactConfigValue(val)];
      }),
    );
  }
  return value;
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
          : typeof v === 'object' && v !== null
            ? JSON.stringify(redactConfigValue(v), null, 2).split('\n').join('\n    ')
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
    console.log(`Set ${key} = ${value}`);
  } else {
    console.error('Usage: gbrain config [show|get|set] <key> [value]');
    process.exit(1);
  }
}
