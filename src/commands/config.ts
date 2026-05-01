import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';

function redactUrl(url: string): string {
  // Redact password in postgresql:// URLs
  return url.replace(
    /(postgresql:\/\/[^:]+:)([^@]+)(@)/,
    '$1***$3',
  );
}

export async function runConfig(engine: BrainEngine, args: string[]) {
  const action = args[0];
  const key = args[1];
  const value = args[2];

  if (action === 'show') {
    runConfigShow();
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
    console.error('Usage: mbrain config [show|get|set] <key> [value]');
    process.exit(1);
  }
}

export function runConfigShow(): void {
  const config = loadConfig();
  if (!config) {
    console.error('No config found. Run: mbrain init');
    process.exit(1);
  }
  console.log('MBrain config:');
  for (const [k, v] of Object.entries(config)) {
    const display = typeof v === 'string' && v.includes('postgresql://')
      ? redactUrl(v)
      : typeof v === 'string' && (k.includes('key') || k.includes('secret'))
        ? '***'
        : v;
    console.log(`  ${k}: ${display}`);
  }
}
