import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';

export function redactUrl(url: string): string {
  const scheme = url.match(/^(postgres(?:ql)?:\/\/)/i);
  if (!scheme) return url;

  const authorityStart = scheme[0].length;
  const at = url.lastIndexOf('@');
  const passwordSeparator = url.indexOf(':', authorityStart);
  const withRedactedPassword = at < 0 || passwordSeparator < 0 || passwordSeparator > at
    ? url
    : `${url.slice(0, passwordSeparator + 1)}***${url.slice(at)}`;

  try {
    const parsed = new URL(withRedactedPassword);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/(password|pass|secret|token|key|credential)/i.test(key)) {
        parsed.searchParams.set(key, '***');
      }
    }
    return parsed.toString();
  } catch {
    return withRedactedPassword;
  }
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
    const display = typeof v === 'string' && (k.includes('key') || k.includes('secret'))
      ? '***'
      : typeof v === 'string'
        ? redactUrl(v)
        : v;
    console.log(`  ${k}: ${display}`);
  }
}
