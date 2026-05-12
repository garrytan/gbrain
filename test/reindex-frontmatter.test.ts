import { describe, expect, test } from 'bun:test';

describe('gbrain reindex-frontmatter command wiring', () => {
  test('CLI passes the already-connected engine into reindex-frontmatter', async () => {
    const source = await Bun.file(new URL('../src/cli.ts', import.meta.url)).text();
    const block = source.slice(
      source.indexOf("case 'reindex-frontmatter'"),
      source.indexOf("case 'backfill'"),
    );

    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain('reindexFrontmatterCli(args, engine)');
    expect(block).not.toContain('reindexFrontmatterCli(args);');
  });

  test('reindex-frontmatter CLI only owns/disconnects engines it creates', async () => {
    const source = await Bun.file(new URL('../src/commands/reindex-frontmatter.ts', import.meta.url)).text();

    expect(source).toContain('existingEngine?: BrainEngine');
    expect(source).toContain('let ownsEngine = false');
    expect(source).toContain('let engine = existingEngine');
    expect(source).toContain('ownsEngine = true');
    expect(source).toContain('ownsEngine && engine');
  });
});
