/**
 * v0.36 — embedding column resolver tests.
 *
 * Pins:
 *   - D2/D11: resolver returns descriptor (name, type, dimensions,
 *     embeddingModel).
 *   - D3: buildVectorCastFragment produces correct cast string per type.
 *   - D11: builtins (`embedding`, `embedding_image`) always present.
 *   - D12: registry-key regex + field validation reject malicious input.
 *   - D12: identifier-quoting handles embedded quotes safely.
 *   - Resolution chain: opts > cfg.search_embedding_column > 'embedding'.
 *   - normalizeEngineColumn: descriptor-passthrough + legacy literals +
 *     throw on unknown string.
 */

import { describe, test, expect } from 'bun:test';
import {
  resolveEmbeddingColumn,
  getEmbeddingColumnRegistry,
  buildVectorCastFragment,
  quoteIdentifier,
  validateColumnKey,
  validateColumnConfig,
  normalizeEngineColumn,
  EmbeddingColumnNotRegisteredError,
  EmbeddingColumnConfigError,
  COLUMN_NAME_REGEX,
  ALLOWED_COLUMN_TYPES,
  MAX_DIMENSIONS,
  DEFAULT_COLUMN_NAME,
  isDefaultColumn,
  isCacheSafe,
  isBuiltinColumn,
} from '../../src/core/search/embedding-column.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import type { ResolvedColumn } from '../../src/core/types.ts';

function cfg(overrides: Partial<GBrainConfig> = {}): GBrainConfig {
  return { engine: 'pglite', ...overrides };
}

describe('resolveEmbeddingColumn — resolution chain', () => {
  test('default fallback returns "embedding"', () => {
    const r = resolveEmbeddingColumn(undefined, cfg());
    expect(r.name).toBe('embedding');
    expect(r.type).toBe('vector');
  });

  test('cfg.search_embedding_column wins over default', () => {
    const r = resolveEmbeddingColumn(undefined, cfg({
      search_embedding_column: 'embedding_voyage',
      embedding_columns: {
        embedding_voyage: { provider: 'voyage:voyage-3-large', dimensions: 1024, type: 'vector' },
      },
    }));
    expect(r.name).toBe('embedding_voyage');
    expect(r.embeddingModel).toBe('voyage:voyage-3-large');
    expect(r.dimensions).toBe(1024);
  });

  test('opts.embeddingColumn wins over cfg.search_embedding_column', () => {
    const r = resolveEmbeddingColumn(
      { embeddingColumn: 'embedding_voyage' },
      cfg({
        search_embedding_column: 'embedding_zeroentropy',
        embedding_columns: {
          embedding_voyage: { provider: 'voyage:voyage-3-large', dimensions: 1024, type: 'vector' },
          embedding_zeroentropy: { provider: 'zeroentropyai:zembed-1', dimensions: 2560, type: 'halfvec' },
        },
      }),
    );
    expect(r.name).toBe('embedding_voyage');
  });

  test('unknown name throws EmbeddingColumnNotRegisteredError with hint', () => {
    let err: EmbeddingColumnNotRegisteredError | null = null;
    try {
      resolveEmbeddingColumn({ embeddingColumn: 'nonexistent' }, cfg());
    } catch (e) {
      err = e as EmbeddingColumnNotRegisteredError;
    }
    expect(err).toBeTruthy();
    expect(err?.code).toBe('embedding_column_not_registered');
    expect(err?.columnName).toBe('nonexistent');
    expect(err?.validColumns).toEqual(['embedding', 'embedding_image']);
    expect(err?.message).toContain('Declared columns:');
    expect(err?.message).toContain('gbrain config set');
  });

  test('SQL-injection-shaped name rejected before registry lookup', () => {
    expect(() =>
      resolveEmbeddingColumn(
        { embeddingColumn: 'embedding"; DROP TABLE pages; --' },
        cfg(),
      ),
    ).toThrow(EmbeddingColumnNotRegisteredError);
  });

  test('descriptor passthrough: ResolvedColumn returned as-is', () => {
    const descriptor: ResolvedColumn = {
      name: 'embedding_custom',
      type: 'halfvec',
      dimensions: 2560,
      embeddingModel: 'zeroentropyai:zembed-1',
    };
    const r = resolveEmbeddingColumn({ embeddingColumn: descriptor }, cfg());
    expect(r).toEqual(descriptor);
  });
});

describe('getEmbeddingColumnRegistry — builtins + merge', () => {
  test('builtin embedding always present even with empty user config', () => {
    // v0.37 fix wave (Lane A.5 + CDX2-3): the registry's resolution
    // chain is `cfg > gateway > DEFAULT_EMBEDDING_*`. Under the legacy
    // preload (bunfig.toml), the gateway is set to OpenAI/1536, so an
    // empty cfg picks up those values via the gateway tier. New tests
    // that want the pure-DEFAULT behavior call `resetGateway()` first.
    const reg = getEmbeddingColumnRegistry(cfg());
    expect(reg.embedding).toBeDefined();
    expect(reg.embedding!.type).toBe('vector');
    expect(reg.embedding!.dimensions).toBe(1536);
    expect(reg.embedding!.provider).toBe('openai:text-embedding-3-large');
  });

  test('builtin embedding_image always present with 1024d vector', () => {
    const reg = getEmbeddingColumnRegistry(cfg());
    expect(reg.embedding_image).toBeDefined();
    expect(reg.embedding_image!.type).toBe('vector');
    expect(reg.embedding_image!.dimensions).toBe(1024);
  });

  test('builtin embedding derives provider from cfg.embedding_model', () => {
    const reg = getEmbeddingColumnRegistry(
      cfg({ embedding_model: 'voyage:voyage-3-large', embedding_dimensions: 1024 }),
    );
    expect(reg.embedding!.provider).toBe('voyage:voyage-3-large');
    expect(reg.embedding!.dimensions).toBe(1024);
  });

  test('builtin embedding_image derives provider from cfg.embedding_multimodal_model', () => {
    const reg = getEmbeddingColumnRegistry(
      cfg({ embedding_multimodal_model: 'voyage:voyage-multimodal-3' }),
    );
    expect(reg.embedding_image!.provider).toBe('voyage:voyage-multimodal-3');
  });

  test('user-declared columns merge with builtins', () => {
    const reg = getEmbeddingColumnRegistry(
      cfg({
        embedding_columns: {
          embedding_voyage: { provider: 'voyage:voyage-3-large', dimensions: 1024, type: 'vector' },
        },
      }),
    );
    expect(Object.keys(reg).sort()).toEqual(['embedding', 'embedding_image', 'embedding_voyage']);
  });

  test('user override wins on conflict (override embedding builtin)', () => {
    const reg = getEmbeddingColumnRegistry(
      cfg({
        embedding_columns: {
          embedding: { provider: 'voyage:voyage-3-large', dimensions: 1024, type: 'vector' },
        },
      }),
    );
    expect(reg.embedding!.provider).toBe('voyage:voyage-3-large');
    expect(reg.embedding!.dimensions).toBe(1024);
  });

  test('halfvec column with high dim accepted', () => {
    const reg = getEmbeddingColumnRegistry(
      cfg({
        embedding_columns: {
          embedding_ze: { provider: 'zeroentropyai:zembed-1', dimensions: 2560, type: 'halfvec' },
        },
      }),
    );
    expect(reg.embedding_ze!.type).toBe('halfvec');
    expect(reg.embedding_ze!.dimensions).toBe(2560);
  });
});

describe('D12 — defense-in-depth validation', () => {
  describe('validateColumnKey', () => {
    test('accepts lowercase identifier', () => {
      expect(() => validateColumnKey('embedding_voyage')).not.toThrow();
      expect(() => validateColumnKey('a')).not.toThrow();
      expect(() => validateColumnKey('_underscore_first')).not.toThrow();
      expect(() => validateColumnKey('mix_of_letters_and_123')).not.toThrow();
    });

    test('rejects keys with quotes (SQL injection vector)', () => {
      expect(() => validateColumnKey('embedding"; DROP --')).toThrow(EmbeddingColumnConfigError);
      expect(() => validateColumnKey("embedding'")).toThrow(EmbeddingColumnConfigError);
    });

    test('rejects keys with uppercase', () => {
      expect(() => validateColumnKey('Embedding')).toThrow(EmbeddingColumnConfigError);
      expect(() => validateColumnKey('EMBEDDING_VOYAGE')).toThrow(EmbeddingColumnConfigError);
    });

    test('rejects keys starting with digits', () => {
      expect(() => validateColumnKey('1embedding')).toThrow(EmbeddingColumnConfigError);
    });

    test('rejects keys with hyphens, spaces, special chars', () => {
      expect(() => validateColumnKey('embed-voyage')).toThrow(EmbeddingColumnConfigError);
      expect(() => validateColumnKey('embed voyage')).toThrow(EmbeddingColumnConfigError);
      expect(() => validateColumnKey('embed.voyage')).toThrow(EmbeddingColumnConfigError);
    });

    test('rejects empty key', () => {
      expect(() => validateColumnKey('')).toThrow(EmbeddingColumnConfigError);
    });
  });

  describe('validateColumnConfig', () => {
    test('accepts valid config', () => {
      expect(() =>
        validateColumnConfig('embedding_voyage', {
          provider: 'voyage:voyage-3-large',
          dimensions: 1024,
          type: 'vector',
        }),
      ).not.toThrow();
    });

    test('rejects bad type', () => {
      expect(() =>
        validateColumnConfig('embedding_voyage', {
          provider: 'voyage:voyage-3-large',
          dimensions: 1024,
          type: 'jsonb' as 'vector',
        }),
      ).toThrow(EmbeddingColumnConfigError);
    });

    test('rejects bad dimensions (zero/negative/too-large)', () => {
      const base = { provider: 'voyage:voyage-3-large', type: 'vector' as const };
      expect(() => validateColumnConfig('x', { ...base, dimensions: 0 })).toThrow();
      expect(() => validateColumnConfig('x', { ...base, dimensions: -5 })).toThrow();
      expect(() => validateColumnConfig('x', { ...base, dimensions: MAX_DIMENSIONS + 1 })).toThrow();
      expect(() => validateColumnConfig('x', { ...base, dimensions: 1.5 as number })).toThrow();
    });

    test('rejects bad provider (empty, missing colon, missing model)', () => {
      const base = { dimensions: 1024, type: 'vector' as const };
      expect(() => validateColumnConfig('x', { ...base, provider: '' })).toThrow();
      expect(() => validateColumnConfig('x', { ...base, provider: 'voyage' })).toThrow();
      expect(() => validateColumnConfig('x', { ...base, provider: 'voyage:' })).toThrow();
      expect(() => validateColumnConfig('x', { ...base, provider: ':voyage-3-large' })).toThrow();
    });

    test('rejects non-object shapes (array, null, scalar)', () => {
      expect(() => validateColumnConfig('x', null)).toThrow();
      expect(() => validateColumnConfig('x', [])).toThrow();
      expect(() => validateColumnConfig('x', 'string')).toThrow();
      expect(() => validateColumnConfig('x', 42)).toThrow();
    });
  });

  test('registry load throws when any entry is invalid', () => {
    expect(() =>
      getEmbeddingColumnRegistry(
        cfg({
          embedding_columns: {
            'embedding"; DROP --': { provider: 'voyage:voyage-3-large', dimensions: 1024, type: 'vector' },
          },
        }),
      ),
    ).toThrow(EmbeddingColumnConfigError);
  });
});

describe('D3 — buildVectorCastFragment + quoteIdentifier', () => {
  test('vector type emits $1::vector cast', () => {
    const r: ResolvedColumn = { name: 'embedding', type: 'vector', dimensions: 1536, embeddingModel: '' };
    const { col, castSql } = buildVectorCastFragment(r);
    expect(col).toBe('"embedding"');
    expect(castSql).toBe('$1::vector');
  });

  test('halfvec type emits $1::halfvec(N) cast', () => {
    const r: ResolvedColumn = { name: 'embedding_ze', type: 'halfvec', dimensions: 2560, embeddingModel: 'zeroentropyai:zembed-1' };
    const { col, castSql } = buildVectorCastFragment(r);
    expect(col).toBe('"embedding_ze"');
    expect(castSql).toBe('$1::halfvec(2560)');
  });

  test('quoteIdentifier wraps in double quotes', () => {
    expect(quoteIdentifier('embedding')).toBe('"embedding"');
    expect(quoteIdentifier('embedding_voyage')).toBe('"embedding_voyage"');
  });

  test('quoteIdentifier doubles embedded quotes (defense belt)', () => {
    // Even though regex prevents this from reaching here in practice,
    // the quoting belt handles a quoted-string-break attempt.
    expect(quoteIdentifier('embed"ding')).toBe('"embed""ding"');
  });
});

describe('normalizeEngineColumn — engine-side legacy converter', () => {
  test('undefined returns builtin embedding descriptor', () => {
    const r = normalizeEngineColumn(undefined);
    expect(r.name).toBe('embedding');
    expect(r.type).toBe('vector');
  });

  test("'embedding' literal returns builtin descriptor", () => {
    const r = normalizeEngineColumn('embedding');
    expect(r.name).toBe('embedding');
    expect(r.type).toBe('vector');
  });

  test("'embedding_image' literal returns 1024d vector descriptor", () => {
    const r = normalizeEngineColumn('embedding_image');
    expect(r.name).toBe('embedding_image');
    expect(r.type).toBe('vector');
    expect(r.dimensions).toBe(1024);
  });

  test('ResolvedColumn descriptor passes through', () => {
    const descriptor: ResolvedColumn = {
      name: 'embedding_ze',
      type: 'halfvec',
      dimensions: 2560,
      embeddingModel: 'zeroentropyai:zembed-1',
    };
    expect(normalizeEngineColumn(descriptor)).toEqual(descriptor);
  });

  test('unknown raw string throws (engine purity contract)', () => {
    // Strings other than legacy literals must NEVER reach the engine.
    // The resolver lives at hybrid/op boundary; the engine throws if
    // a caller bypassed it.
    expect(() => normalizeEngineColumn('embedding_voyage' as string)).toThrow(
      EmbeddingColumnNotRegisteredError,
    );
  });
});

describe('helpers', () => {
  test('isDefaultColumn true only for "embedding"', () => {
    const def: ResolvedColumn = { name: 'embedding', type: 'vector', dimensions: 1536, embeddingModel: '' };
    const alt: ResolvedColumn = { name: 'embedding_voyage', type: 'vector', dimensions: 1024, embeddingModel: 'v' };
    expect(isDefaultColumn(def)).toBe(true);
    expect(isDefaultColumn(alt)).toBe(false);
  });

  test('isBuiltinColumn matches both builtins exactly', () => {
    expect(isBuiltinColumn('embedding')).toBe(true);
    expect(isBuiltinColumn('embedding_image')).toBe(true);
    expect(isBuiltinColumn('embedding_voyage')).toBe(false);
  });

  test('exported constants are stable', () => {
    expect(DEFAULT_COLUMN_NAME).toBe('embedding');
    expect(ALLOWED_COLUMN_TYPES.has('vector')).toBe(true);
    expect(ALLOWED_COLUMN_TYPES.has('halfvec')).toBe(true);
    expect(MAX_DIMENSIONS).toBe(8192);
    expect(COLUMN_NAME_REGEX.test('embedding_voyage')).toBe(true);
    expect(COLUMN_NAME_REGEX.test('Embedding')).toBe(false);
  });
});

describe('codex /ship #1 — prototype-pollution-safe registry', () => {
  test('resolver rejects "constructor" even though regex accepts it', () => {
    // The regex `^[a-z_][a-z0-9_]*$` matches "constructor" — but the
    // registry uses Object.create(null) + Object.hasOwn so Object's
    // inherited members don't masquerade as registered columns.
    expect(() =>
      resolveEmbeddingColumn({ embeddingColumn: 'constructor' }, cfg()),
    ).toThrow(EmbeddingColumnNotRegisteredError);
  });

  test('resolver rejects other inherited names (toString, hasOwnProperty)', () => {
    for (const name of ['tostring', 'hasownproperty', 'isprototypeof', 'valueof']) {
      expect(() =>
        resolveEmbeddingColumn({ embeddingColumn: name }, cfg()),
      ).toThrow(EmbeddingColumnNotRegisteredError);
    }
  });

  test('getEmbeddingColumnRegistry returns a null-prototype object', () => {
    const reg = getEmbeddingColumnRegistry(cfg());
    // No Object.prototype inheritance — direct prototype access returns null.
    expect(Object.getPrototypeOf(reg)).toBeNull();
    // Inherited properties are genuinely absent.
    expect((reg as any).constructor).toBeUndefined();
    expect((reg as any).toString).toBeUndefined();
  });
});

describe('codex /ship #2 — descriptor passthrough validates', () => {
  test('passthrough re-validates name regex', () => {
    const bad: ResolvedColumn = {
      name: 'embedding"; DROP TABLE pages; --',
      type: 'vector',
      dimensions: 1536,
      embeddingModel: 'voyage:voyage-3-large',
    };
    expect(() =>
      resolveEmbeddingColumn({ embeddingColumn: bad }, cfg()),
    ).toThrow(EmbeddingColumnNotRegisteredError);
  });

  test('passthrough re-validates type field (rejects unknown)', () => {
    const bad = {
      name: 'embedding_voyage',
      type: 'jsonb',
      dimensions: 1024,
      embeddingModel: 'voyage:voyage-3-large',
    } as unknown as ResolvedColumn;
    expect(() =>
      resolveEmbeddingColumn({ embeddingColumn: bad }, cfg()),
    ).toThrow(EmbeddingColumnConfigError);
  });

  test('passthrough re-validates dimensions field (rejects out-of-range)', () => {
    const bad: ResolvedColumn = {
      name: 'embedding_voyage',
      type: 'vector',
      dimensions: -5,
      embeddingModel: 'voyage:voyage-3-large',
    };
    expect(() =>
      resolveEmbeddingColumn({ embeddingColumn: bad }, cfg()),
    ).toThrow(EmbeddingColumnConfigError);
  });

  test('passthrough re-validates dimensions field (rejects SQL-shaped string)', () => {
    const bad = {
      name: 'embedding_voyage',
      type: 'halfvec',
      dimensions: '1); DROP TABLE pages; --',
      embeddingModel: 'voyage:voyage-3-large',
    } as unknown as ResolvedColumn;
    expect(() =>
      resolveEmbeddingColumn({ embeddingColumn: bad }, cfg()),
    ).toThrow(EmbeddingColumnConfigError);
  });

  test('valid descriptor passes through unchanged', () => {
    const good: ResolvedColumn = {
      name: 'embedding_ze',
      type: 'halfvec',
      dimensions: 2560,
      embeddingModel: 'zeroentropyai:zembed-1',
    };
    expect(resolveEmbeddingColumn({ embeddingColumn: good }, cfg())).toEqual(good);
  });
});

describe('codex /ship #4 — isCacheSafe (embedding-space-based skip)', () => {
  test('default name + matching dim + matching model → safe', () => {
    // v0.37 fix wave (Lane A.6 + CDX2-3): isCacheSafe baselines against
    // `cfg > gateway > DEFAULT`. Under the legacy preload (bunfig.toml),
    // the gateway is set to OpenAI/1536, so a matching resolved column
    // is cache-safe even with empty cfg.
    const r: ResolvedColumn = {
      name: 'embedding',
      type: 'vector',
      dimensions: 1536,
      embeddingModel: 'openai:text-embedding-3-large',
    };
    expect(isCacheSafe(r, cfg())).toBe(true);
  });

  test('non-default name → unsafe', () => {
    const r: ResolvedColumn = {
      name: 'embedding_voyage',
      type: 'vector',
      dimensions: 1024,
      embeddingModel: 'voyage:voyage-3-large',
    };
    expect(isCacheSafe(r, cfg())).toBe(false);
  });

  test('default name BUT overridden to different dim → unsafe', () => {
    // User overrode the `embedding` builtin to point at a 1024-dim Voyage
    // column. Name is still 'embedding' but the cache table is sized for
    // 1536d (or whatever the brain's cfg dim was at init). UNSAFE.
    const r: ResolvedColumn = {
      name: 'embedding',
      type: 'vector',
      dimensions: 1024,
      embeddingModel: 'voyage:voyage-3-large',
    };
    expect(isCacheSafe(r, cfg({ embedding_dimensions: 1536 }))).toBe(false);
  });

  test('default name BUT overridden to different model (same dim) → unsafe', () => {
    // Different model = different embedding space even at the same dim.
    // OpenAI 1536d vectors are NOT interchangeable with Cohere/Voyage 1536d.
    const r: ResolvedColumn = {
      name: 'embedding',
      type: 'vector',
      dimensions: 1536,
      embeddingModel: 'voyage:voyage-3-large',
    };
    expect(
      isCacheSafe(
        r,
        cfg({
          embedding_dimensions: 1536,
          embedding_model: 'openai:text-embedding-3-large',
        }),
      ),
    ).toBe(false);
  });

  test('zero-config brain (cfg has no embedding_dimensions/model) → defaults match → safe', () => {
    // v0.37 fix wave: with empty cfg, registry + isCacheSafe fall
    // through to gateway state. Preload sets OpenAI/1536; matching
    // column is safe.
    const r: ResolvedColumn = {
      name: 'embedding',
      type: 'vector',
      dimensions: 1536,
      embeddingModel: 'openai:text-embedding-3-large',
    };
    expect(isCacheSafe(r, cfg())).toBe(true);
  });
});
