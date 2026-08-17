/**
 * ONE canonical migration command everywhere (D5). Before this, five warning
 * surfaces printed five different commands — including an unsubstituted
 * `<provider:model>` placeholder and a `--dim 1280` that Voyage rejects
 * (valid widths: 256/512/1024/2048).
 *
 *   1. Renderer contract: always `--dim 1024` on the Voyage line; keep-width
 *      OpenAI alternative only when the current width allows it (<= 1536);
 *      rebuild note only when the width actually changes.
 *   2. Source sweep: every `--to voyage:voyage-4` literal in src/ carries
 *      `--dim 1024` on the same line; no `<provider:model>` placeholder
 *      command survives anywhere in src/.
 *   3. Every sunset-warning surface consumes the renderer.
 *
 * The docs/skills sweep (same pairing rule over *.md) lives with the docs
 * wave commit — see the docs assertions appended there.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { renderCanonicalMigrationCommands } from '../src/core/ai/defaults.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.generated.ts')) out.push(p);
  }
  return out;
}

const SRC = join(import.meta.dir, '..', 'src');

describe('canonical migration command (single home: ai/defaults.ts)', () => {
  test('renderer contract', () => {
    const bare = renderCanonicalMigrationCommands();
    expect(bare.recommended).toBe('gbrain migrate embeddings --to voyage:voyage-4 --dim 1024');
    expect(bare.recommendedDryRun).toBe('gbrain migrate embeddings --to voyage:voyage-4 --dim 1024 --dry-run');
    expect(bare.openaiAlternative).toBeNull();
    expect(bare.note).toBeNull();

    const legacy = renderCanonicalMigrationCommands({ colDims: 1280 });
    expect(legacy.recommendedDryRun).toContain('--dim 1024');
    expect(legacy.note).toContain('256/512/1024/2048');
    expect(legacy.openaiAlternative).toBe('gbrain migrate embeddings --to openai:text-embedding-3-small --dim 1280 --dry-run');

    const already = renderCanonicalMigrationCommands({ colDims: 1024 });
    expect(already.note).toBeNull();

    const wide = renderCanonicalMigrationCommands({ colDims: 3072 });
    expect(wide.openaiAlternative).toBeNull(); // 3-small caps at 1536
    expect(wide.note).toContain('3072');
  });

  test('src sweep: every voyage migrate command carries --dim 1024; no placeholder commands', () => {
    const offenders: string[] = [];
    const placeholders: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf-8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (line.includes('--to voyage:voyage-4') && !line.includes('--dim 1024')) {
          // Allow pure prose ABOUT the flag pairing; command strings must pair.
          if (line.includes('migrate embeddings')) offenders.push(`${file}:${i + 1}`);
        }
        // The stage-1 booby-trap shape: an unsubstituted placeholder RECOMMENDED
        // with a concrete width (`--to <provider:model> --dim 1280`). Generic
        // usage/help syntax (`--to <provider:model> [--dim N]`) is legitimate.
        if (/migrate embeddings --to <provider:model>.*--dim \d/.test(line)) {
          placeholders.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
    expect(placeholders).toEqual([]);
  });

  test('docs/skills sweep: every voyage migrate command in md files carries --dim 1024; no phantom flags', () => {
    const roots = ['docs', 'skills', '.'];
    const offenders: string[] = [];
    const phantoms: string[] = [];
    const seen = new Set<string>();
    const mdWalk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git' || name.startsWith('.gbrain')) continue;
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) {
          if (dir === join(import.meta.dir, '..')) {
            if (name !== 'docs' && name !== 'skills') continue; // repo root: only top-level md + docs/skills trees
          }
          mdWalk(p, out);
        } else if (p.endsWith('.md')) out.push(p);
      }
      return out;
    };
    const files: string[] = [];
    for (const r of roots) {
      const abs = join(import.meta.dir, '..', r);
      for (const f of r === '.' ? readdirSync(abs).filter((n) => n.endsWith('.md')).map((n) => join(abs, n)) : mdWalk(abs)) {
        if (!seen.has(f)) { seen.add(f); files.push(f); }
      }
    }
    for (const file of files) {
      // CHANGELOG is an append-only historical record (entries also wrap
      // mid-command); guidance docs are the lint target.
      if (file.endsWith('CHANGELOG.md')) continue;
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (line.includes('migrate embeddings') && line.includes('--to voyage:voyage-4') && !line.includes('--dim 1024')) {
          offenders.push(`${file}:${i + 1}`);
        }
        // The phantom flag a doc used to prescribe.
        if (line.includes('retrieval-upgrade') && line.includes('--reindex')) {
          phantoms.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
    expect(phantoms).toEqual([]);
  });

  test('the ZE-sunset playbook carries the guess-killers', () => {
    const playbook = readFileSync(join(import.meta.dir, '..', 'skills', 'migrations', 'v0.46.3.0.md'), 'utf-8');
    // Env preflight (the incident class): named vars + unset instruction.
    expect(playbook).toContain('GBRAIN_EMBEDDING_MODEL');
    expect(playbook).toContain('unset GBRAIN_EMBEDDING_MODEL GBRAIN_EMBEDDING_DIMENSIONS');
    // Status surface + recovery + exit codes.
    expect(playbook).toContain('gbrain migrate embeddings --status');
    expect(playbook).toContain('## Recovery');
    expect(playbook).toContain('Exit codes');
    // Reranker handled in the same run + the plane asymmetry explained.
    expect(playbook).toContain('--reranker');
    expect(playbook).toContain('plane asymmetry');
    // The canonical command, correctly paired.
    expect(playbook).toContain('gbrain migrate embeddings --to voyage:voyage-4 --dim 1024');

    // Stale playbooks carry the do-not-follow banner.
    for (const rel of ['skills/migrations/v0.35.0.0.md', 'skills/migrations/v0.36.2.0.md']) {
      const text = readFileSync(join(import.meta.dir, '..', rel), 'utf-8');
      expect(text).toContain('HISTORICAL — DO NOT FOLLOW');
      expect(text).toContain('v0.46.3.0.md');
    }
  });

  test('every sunset-warning surface consumes the renderer', () => {
    const consumers = [
      'src/core/ai/gateway.ts',
      'src/commands/init.ts',
      'src/core/advisor/collect-setup-smells.ts',
      'src/commands/upgrade.ts',
      'src/core/ze-exposure.ts',
      'src/commands/ze-switch.ts',
      // Interim ZE cleanup: providers env prints the off-ramp for sunsetting
      // recipes instead of the signup funnel.
      'src/commands/providers.ts',
    ];
    for (const rel of consumers) {
      const text = readFileSync(join(import.meta.dir, '..', rel), 'utf-8');
      expect(text.includes('renderCanonicalMigrationCommands')).toBe(true);
    }
    // Doctor's consumer (checkProviderSunset) lives in the peeled checks tree;
    // the containment convention reads the concatenated doctor surface.
    const { doctorSource } = require('./helpers/doctor-source.ts');
    expect(doctorSource().includes('renderCanonicalMigrationCommands')).toBe(true);
  });
});
