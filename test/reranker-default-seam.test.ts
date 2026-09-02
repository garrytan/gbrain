/**
 * #3657 reranker default seam — ONE code home for the runtime/bundle default.
 *
 * v0.48.2 flipped the default from the sunsetting `zeroentropyai:zerank-2`
 * to `voyage:rerank-2.5` (`DEFAULT_RERANKER_MODEL` in src/core/ai/defaults.ts).
 * Everything resolves through that constant:
 *   - the three mode bundles (src/core/search/mode.ts)
 *   - the gateway runtime fallback (src/core/ai/gateway.ts imports it; no local alias)
 * `LEGACY_DEFAULT_RERANKER_MODEL` stays as the retired historical value that
 * the RERANKER_SUNSETS row, the short-circuit tests and the migration copy name.
 *
 * The zerank literal is allowed to remain in exactly two other NON-DEFAULT code
 * positions, each with a documented reason:
 *   - src/core/embedding-pricing.ts — a pricing-table KEY, not a default
 *   - src/core/retrieval-upgrade-planner.ts — the HISTORICAL v0.36 ZE cutover
 *     target (dormant ze-switch flow; file is deleted wholesale in the v0.47
 *     removal wave). By definition it targets ZE and must not track the seam.
 *
 * Also pins the sunset list (RERANKER_SUNSETS) the doctor search_mode check
 * consults before recommending `gbrain search modes --reset` (#4382).
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { MODE_BUNDLES } from '../src/core/search/mode.ts';
import {
  DEFAULT_RERANKER_MODEL,
  LEGACY_DEFAULT_RERANKER_MODEL,
  NEW_INSTALL_DEFAULT_RERANKER_MODEL,
  RERANKER_SUNSETS,
  ZEROENTROPY_SUNSET_DATE,
  rerankerSunset,
} from '../src/core/ai/defaults.ts';

describe('DEFAULT_RERANKER_MODEL seam (#3657, flipped v0.48.2)', () => {
  test('all three mode bundles resolve their reranker_model through the one constant', () => {
    expect(MODE_BUNDLES.conservative.reranker_model).toBe(DEFAULT_RERANKER_MODEL);
    expect(MODE_BUNDLES.balanced.reranker_model).toBe(DEFAULT_RERANKER_MODEL);
    expect(MODE_BUNDLES.tokenmax.reranker_model).toBe(DEFAULT_RERANKER_MODEL);
  });

  test('the default IS the recommended new-install reranker (voyage) and is NOT on the sunset list', () => {
    expect(DEFAULT_RERANKER_MODEL).toBe(NEW_INSTALL_DEFAULT_RERANKER_MODEL);
    expect(DEFAULT_RERANKER_MODEL).toBe('voyage:rerank-2.5');
    for (const mode of ['conservative', 'balanced', 'tokenmax'] as const) {
      expect(rerankerSunset(MODE_BUNDLES[mode].reranker_model)).toBeNull();
    }
  });

  test('the retired legacy value is still named (history + sunset row), but nothing defaults to it', () => {
    expect(LEGACY_DEFAULT_RERANKER_MODEL).toBe('zeroentropyai:zerank-2');
    for (const mode of ['conservative', 'balanced', 'tokenmax'] as const) {
      expect(MODE_BUNDLES[mode].reranker_model).not.toBe(LEGACY_DEFAULT_RERANKER_MODEL);
    }
  });

  test('gateway imports DEFAULT_RERANKER_MODEL from defaults.ts — no local alias, no literal', () => {
    const src = readFileSync(
      join(import.meta.dir, '../src/core/ai/gateway.ts'),
      'utf8',
    );
    expect(src).not.toContain('const DEFAULT_RERANKER_MODEL =');
    expect(src).not.toContain('LEGACY_DEFAULT_RERANKER_MODEL');
    expect(src).toMatch(/import \{[^}]*\bDEFAULT_RERANKER_MODEL\b[^}]*\} from '\.\/defaults\.ts'/s);
  });

  test('the zerank literal has exactly three code homes in src/ (constant, pricing key, historical ZE target)', () => {
    const LITERAL = 'zeroentropyai:zerank-2';
    const ALLOWED = new Set([
      'src/core/ai/defaults.ts', // LEGACY_DEFAULT_RERANKER_MODEL — the retired value
      'src/core/embedding-pricing.ts', // pricing-table key, not a default
      'src/core/retrieval-upgrade-planner.ts', // historical ZE cutover target (deleted v0.47)
    ]);
    const root = join(import.meta.dir, '..');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (name.endsWith('.ts')) {
          const rel = full.slice(root.length + 1);
          for (const line of readFileSync(full, 'utf8').split('\n')) {
            if (!line.includes(LITERAL)) continue;
            const t = line.trim();
            // Comment lines are fine — only CODE positions count.
            if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
            hits.push(rel);
            break;
          }
        }
      }
    };
    walk(join(root, 'src'));
    const offenders = hits.filter((f) => !ALLOWED.has(f));
    expect(offenders).toEqual([]);
    // The seam home itself must carry it (guards against the constant moving
    // without this allowlist being updated).
    expect(hits).toContain('src/core/ai/defaults.ts');
  });
});

describe('RERANKER_SUNSETS (#3657/#4382)', () => {
  test('the legacy default is on the sunset list with the ZE date + a live replacement', () => {
    const s = rerankerSunset(LEGACY_DEFAULT_RERANKER_MODEL);
    expect(s).not.toBeNull();
    expect(s!.date).toBe(ZEROENTROPY_SUNSET_DATE);
    expect(s!.replacement).toBe(NEW_INSTALL_DEFAULT_RERANKER_MODEL);
  });

  test('every ZeroEntropy reranker matches by provider prefix (zerank-1, zerank-1-small too)', () => {
    expect(rerankerSunset('zeroentropyai:zerank-1')?.date).toBe(ZEROENTROPY_SUNSET_DATE);
    expect(rerankerSunset('zeroentropyai:zerank-1-small')?.date).toBe(ZEROENTROPY_SUNSET_DATE);
  });

  test('matching is case-insensitive and accepts the slash form (parseModelId parity)', () => {
    expect(rerankerSunset('ZeroEntropyAI:zerank-2')?.date).toBe(ZEROENTROPY_SUNSET_DATE);
    expect(rerankerSunset('zeroentropyai/zerank-2')?.date).toBe(ZEROENTROPY_SUNSET_DATE);
    expect(rerankerSunset(' zeroentropyai:zerank-1 ')?.date).toBe(ZEROENTROPY_SUNSET_DATE);
    // A provider whose id merely STARTS with the prefix text is not matched.
    expect(rerankerSunset('zeroentropyai-selfhost:zerank-2')).toBeNull();
  });

  test('live rerankers do not match', () => {
    expect(rerankerSunset('voyage:rerank-2.5')).toBeNull();
    expect(rerankerSunset('voyage:rerank-2.5-lite')).toBeNull();
    expect(rerankerSunset('dashscope-rerank:qwen3-rerank')).toBeNull();
    expect(rerankerSunset('llama-server-reranker:qwen3-reranker-4b')).toBeNull();
    expect(rerankerSunset('openrouter:cohere/rerank-v3.5')).toBeNull();
  });

  test('null/undefined/empty are not sunset', () => {
    expect(rerankerSunset(undefined)).toBeNull();
    expect(rerankerSunset(null)).toBeNull();
    expect(rerankerSunset('')).toBeNull();
  });

  test('a replacement must never itself be on the sunset list', () => {
    for (const s of RERANKER_SUNSETS) {
      expect(rerankerSunset(s.replacement)).toBeNull();
    }
  });
});
