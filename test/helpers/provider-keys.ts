/**
 * Synthetic AI-provider API keys for the #7959 secret-scan rules (openrouter,
 * groq, xai, perplexity, replicate), each built at runtime from random parts
 * so no committed line carries a key-shaped literal (gitleaks, CEO-10).
 *
 * `nearMisses` are strings one step off each published shape (a body one
 * character short or long, the wrong case or separator, the prefix embedded
 * in a longer word). No rule may match them.
 */
import { randomBytes } from 'node:crypto';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Random alphanumeric run that always carries a digit and a letter. */
export function alnum(n: number): string {
  let s = '';
  for (const b of randomBytes(n)) s += ALNUM[b % ALNUM.length];
  return 'k' + s.slice(2) + String(randomBytes(1)[0]! % 10);
}

export const hex = (n: number): string => randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);

export interface ProviderKeyShape {
  pattern: 'openrouter' | 'groq' | 'xai' | 'perplexity' | 'replicate';
  make(): string;
  nearMisses(): string[];
}

const join = (sep: string, ...parts: string[]) => parts.join(sep);

export const PROVIDER_KEY_SHAPES: ReadonlyArray<ProviderKeyShape> = [
  {
    pattern: 'openrouter',
    make: () => join('-', 'sk', 'or', 'v1', hex(64)),
    nearMisses: () => [
      join('-', 'sk', 'or', 'v1', hex(63)),
      join('-', 'sk', 'or', 'v1', hex(65)),
      join('-', 'sk', 'or', 'v1', hex(64).toUpperCase().replace(/[0-9]/g, 'A')),
      join('-', 'xsk', 'or', 'v1', hex(64)),
      join('_', 'sk', 'or', 'v1', hex(64)),
    ],
  },
  {
    pattern: 'groq',
    make: () => join('_', 'gsk', alnum(52)),
    nearMisses: () => [
      join('_', 'gsk', alnum(51)),
      join('_', 'gsk', alnum(53)),
      join('-', 'gsk', alnum(52)),
      join('_', 'agsk', alnum(52)),
    ],
  },
  {
    pattern: 'xai',
    make: () => join('-', 'xai', alnum(40) + '_' + alnum(39)),
    nearMisses: () => [
      join('-', 'xai', alnum(79)),
      join('-', 'xai', alnum(81)),
      join('_', 'xai', alnum(80)),
      join('-', 'foxai', alnum(80)),
    ],
  },
  {
    pattern: 'perplexity',
    make: () => join('-', 'pplx', alnum(48)),
    nearMisses: () => [
      join('-', 'pplx', alnum(47)),
      join('-', 'pplx', alnum(49)),
      join('_', 'pplx', alnum(48)),
      join('-', 'applx', alnum(48)),
    ],
  },
  {
    pattern: 'replicate',
    make: () => join('_', 'r8', alnum(20) + '-' + alnum(16)),
    nearMisses: () => [
      join('_', 'r8', alnum(36)),
      join('_', 'r8', alnum(38)),
      join('-', 'r8', alnum(37)),
      join('_', 'ar8', alnum(37)),
    ],
  },
];

/** Prose that names every prefix without carrying a key. */
export const PROVIDER_PREFIX_PROSE =
  'route through the sk-or-v1 router, a gsk_ prefix, the xai-sdk, pplx-api docs and r8_ tokens are rotated monthly';
