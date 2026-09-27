import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { marked } from 'marked';

const root = resolve(import.meta.dir, '..');
const subsystemDir = 'docs/architecture/key-files';
const subsystems = readdirSync(join(root, subsystemDir)).filter(name => name.endsWith('.md'));
const guides = [
  'brain-vs-memory', 'memory-boundaries', 'hosted-harness-access', 'in-agent-setup',
  'capabilities', 'data-ingestion', 'troubleshooting', 'skill-reference', 'grok-bot', 'muse',
];
const documents = [
  'README.md', 'CLAUDE.md', 'AGENTS.md', 'INSTALL_FOR_AGENTS.md', 'docs/INSTALL.md',
  'docs/architecture/KEY_FILES.md', 'docs/tutorials/connect-coding-agent.md',
  'docs/operations/backfill-pacing.md', 'docs/contributing/version-recovery.md',
  'docs/guides/search-modes.md', 'docs/architecture/RETRIEVAL.md',
  'docs/architecture/topologies.md', 'docs/guides/concurrent-writes.md',
  'docs/protocol/DEEP_RESEARCH_IDS_v1.md', 'docs/mcp/CHATGPT.md',
  'docs/mcp/HERMES-CLI-PIN.md', 'docs/mcp/OPENCODE-CLI-PIN.md',
  ...guides.map(name => `docs/guides/${name}.md`),
  ...subsystems.map(name => `${subsystemDir}/${name}`),
];

function anchors(markdown: string): Set<string> {
  const result = new Set<string>();
  const counts = new Map<string, number>();
  let fence: string | undefined;
  const headings = markdown.split('\n').filter(line => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      return false;
    }
    return !fence && /^#{1,6}\s/.test(line);
  }).join('\n\n');
  marked.walkTokens(marked.lexer(headings), token => {
    if (token.type !== 'heading') return;
    const slug = token.text.replace(/<[^>]*>/g, '').toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = counts.get(slug) ?? 0;
    result.add(count ? `${slug}-${count}` : slug);
    counts.set(slug, count + 1);
  });
  for (const match of markdown.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) result.add(match[1]);
  return result;
}

describe('primary documentation navigation', () => {
  test('every subsystem is directly discoverable from the bounded index', () => {
    const index = readFileSync(join(root, 'docs/architecture/KEY_FILES.md'), 'utf8');
    for (const name of subsystems) expect(index).toContain(`](key-files/${name})`);
    expect(subsystems.length).toBeGreaterThan(1);
  });

  const anchorCache = new Map<string, Set<string>>();
  test.each(documents)('local Markdown links and fragments resolve in %s', document => {
    const failures: string[] = [];
    const path = join(root, document);
    marked.walkTokens(marked.lexer(readFileSync(path, 'utf8')), token => {
      if (token.type !== 'link' && token.type !== 'image') return;
      const url = token.href;
      if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(url)) return;
      const [relative, fragment] = url.split('#');
      const target = relative ? resolve(dirname(path), decodeURIComponent(relative)) : path;
      if (!existsSync(target)) {
        failures.push(`${document}: missing ${url}`);
      } else if (fragment && target.endsWith('.md') && statSync(target).isFile()) {
        let found = anchorCache.get(target);
        if (!found) {
          found = anchors(readFileSync(target, 'utf8'));
          anchorCache.set(target, found);
        }
        if (!found.has(decodeURIComponent(fragment))) failures.push(`${document}: missing fragment ${url}`);
      }
    });
    expect(failures).toEqual([]);
  });

  test('active memory guidance keeps durable preferences separate from configuration', () => {
    const guide = readFileSync(join(root, 'docs/guides/brain-vs-memory.md'), 'utf8');
    expect(guide).toContain('Durable facts, preferences');
    expect(guide).toContain('Tool configuration, credentials');
    expect(guide).not.toContain("Don't store user preferences in GBrain");
    expect(guide).not.toContain('it should return nothing');
  });

  test('primary docs do not reinstate blanket graph or exclusivity promises', () => {
    for (const document of documents.filter(path => !path.startsWith(subsystemDir))) {
      const text = readFileSync(join(root, document), 'utf8');
      expect(text).not.toMatch(/Every (?:future )?`put_page` (?:auto-creates|extracts)/);
      expect(text).not.toContain('auto-linking on every write');
      expect(text).not.toContain('nobody else ships together');
    }
    const boundaries = readFileSync(join(root, 'docs/guides/memory-boundaries.md'), 'utf8');
    expect(boundaries).toContain('no inline graph extraction');
    expect(boundaries).toContain('Does not self-sweep');
    expect(boundaries).toContain('embeddings receive the text');
    expect(boundaries).toContain('rerankers receive the query');
    expect(boundaries).toContain('not a full database backup');
  });
});
