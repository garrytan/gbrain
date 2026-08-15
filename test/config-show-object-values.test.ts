/**
 * #575 — `gbrain config show` printed `[object Object]` for object-valued
 * config fields (e.g. `provider_base_urls`) because non-string values were
 * interpolated straight into a template literal.
 *
 * Behavioral pin: object values render as JSON; object values under a
 * sensitive key stay redacted; scalars keep their existing rendering.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withEnv } from './helpers/with-env.ts';
import { runConfig } from '../src/commands/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('config show object-valued fields (#575)', () => {
  test('provider_base_urls renders as JSON, not [object Object]', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-cfgshow-'));
    try {
      mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
      writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({
        engine: 'pglite',
        database_path: join(tmpHome, '.gbrain', 'brain'),
        provider_base_urls: { ollama: 'http://localhost:11434' },
        some_nested_secret: { api_key: 'sk-super-secret' },
      }, null, 2));

      const outLines: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => { outLines.push(args.map(String).join(' ')); };
      try {
        await withEnv({ GBRAIN_HOME: tmpHome, DATABASE_URL: undefined }, async () => {
          await runConfig({} as unknown as BrainEngine, ['show']);
        });
      } finally {
        console.log = origLog;
      }

      const out = outLines.join('\n');
      expect(out).not.toContain('[object Object]');
      const urlLine = outLines.find(l => l.includes('provider_base_urls'));
      expect(urlLine).toBeDefined();
      expect(urlLine!).toContain('http://localhost:11434');
      // Objects under a sensitive key must NOT leak their contents.
      const secretLine = outLines.find(l => l.includes('some_nested_secret'));
      expect(secretLine).toBeDefined();
      expect(secretLine!).not.toContain('sk-super-secret');
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
