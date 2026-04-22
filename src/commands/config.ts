import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';

const DISPLAY_KEYS = [
  ['embedding.provider', 'embedding_provider'],
  ['embedding.model', 'embedding_model'],
  ['embedding.base_url', 'embedding_base_url'],
  ['embedding.dimensions', 'embedding_dimensions'],
] as const;

function redactUrl(url: string): string {
  return url.replace(
    /(postgresql:\/\/[^:]+:)([^@]+)(@)/,
    '$1***$3',
  );
}

function displayValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.includes('postgresql://')) return redactUrl(value);
  if (key.includes('key') || key.includes('secret')) return '***';
  return value;
}

async function getConfigValue(engine: BrainEngine, key: string): Promise<string | null> {
  const direct = await engine.getConfig(key);
  if (direct !== null) return direct;

  if (key.includes('.')) {
    return engine.getConfig(key.replace(/\./g, '_'));
  }
  if (key.includes('_')) {
    return engine.getConfig(key.replace(/_/g, '.'));
  }
  return null;
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

    const combined = new Map<string, unknown>(Object.entries(config));
    for (const [primary, legacy] of DISPLAY_KEYS) {
      const resolved = await getConfigValue(engine, primary) ?? await getConfigValue(engine, legacy);
      if (resolved !== null) combined.set(primary, resolved);
    }

    console.log('GBrain config:');
    for (const [k, v] of combined.entries()) {
      console.log(`  ${k}: ${displayValue(k, v)}`);
    }
    return;
  }

  if (action === 'get' && key) {
    const resolved = await getConfigValue(engine, key);
    if (resolved !== null) {
      console.log(resolved);
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
