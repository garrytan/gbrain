import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, saveConfig, toEngineConfig, type GBrainConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';

const FILE_BACKED_KEYS = new Set<keyof GBrainConfig>([
  'engine',
  'database_url',
  'database_path',
  'openai_api_key',
  'anthropic_api_key',
]);


async function withConnectedEngine<T>(config: GBrainConfig | null, fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
  if (!config) {
    console.error('No config found. Run: gbrain init');
    process.exit(1);
  }
  const engine = await createEngine(toEngineConfig(config));
  await engine.connect(toEngineConfig(config));
  try {
    return await fn(engine);
  } finally {
    await engine.disconnect();
  }
}

function redactUrl(url: string): string {
  // Redact password in postgresql:// URLs
  return url.replace(
    /(postgresql:\/\/[^:]+:)([^@]+)(@)/,
    '$1***$3',
  );
}

export async function runConfig(engine: BrainEngine | null, args: string[]) {
  const action = args[0];
  const key = args[1];
  const value = args[2];
  const config = loadConfig();

  if (action === 'show') {
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
    if (config && key in config) {
      const val = config[key as keyof typeof config];
      if (val !== undefined && val !== null) {
        console.log(val);
        return;
      }
    }
    if (!engine) {
      const val = await withConnectedEngine(config, async connected => connected.getConfig(key));
      if (val !== null) {
        console.log(val);
        return;
      }
      console.error(`Config key not found: ${key}`);
      process.exit(1);
    }
    const val = await engine.getConfig(key);
    if (val !== null) {
      console.log(val);
    } else {
      console.error(`Config key not found: ${key}`);
      process.exit(1);
    }
  } else if (action === 'set' && key && value) {
    if (FILE_BACKED_KEYS.has(key as keyof GBrainConfig)) {
      const nextConfig: GBrainConfig = {
        engine: config?.engine || 'postgres',
        ...config,
        [key]: value,
      };
      saveConfig(nextConfig);
      console.log(`Set ${key} = ${value}`);
      return;
    }
    if (!engine) {
      await withConnectedEngine(config, async connected => {
        await connected.setConfig(key, value);
      });
      console.log(`Set ${key} = ${value}`);
      return;
    }
    await engine.setConfig(key, value);
    console.log(`Set ${key} = ${value}`);
  } else {
    console.error('Usage: gbrain config [show|get|set] <key> [value]');
    process.exit(1);
  }
}
