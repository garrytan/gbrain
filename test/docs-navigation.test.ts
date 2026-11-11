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
  const linkedPages = (markdown: string, prefix: string) => new Set(
    [...markdown.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)\s]*)?\)/g)]
      .map(match => match[1])
      .filter(href => href.startsWith(prefix))
      .map(href => href.slice(prefix.length))
      .filter(name => subsystems.includes(name)),
  );
  const pageText = (name: string) => readFileSync(join(root, subsystemDir, name), 'utf8');
  const lastLine = (name: string) => pageText(name).trimEnd().split('\n').at(-1) ?? '';
  const indexed = linkedPages(readFileSync(join(root, 'docs/architecture/KEY_FILES.md'), 'utf8'), 'key-files/');

  test('every subsystem page is reachable from the bounded index', () => {
    expect(subsystems.length).toBeGreaterThan(1);
    const reached = new Set(indexed);
    const queue = [...indexed];
    while (queue.length > 0) {
      for (const next of linkedPages(pageText(queue.shift()!), '')) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    expect(subsystems.filter(name => !reached.has(name))).toEqual([]);
  });

  test('a page the index does not link continues exactly one chain from its predecessor', () => {
    const failures: string[] = [];
    const predecessorOf = new Map<string, string>();
    for (const name of subsystems.filter(page => !indexed.has(page))) {
      const previous = [...pageText(name).matchAll(/\[Previous entries\]\(([^)#\s]+\.md)\)/g)].map(match => match[1]);
      if (previous.length !== 1 || !subsystems.includes(previous[0])) {
        failures.push(`${name}: not linked from the index and has no single [Previous entries](<page>.md) link`);
        continue;
      }
      predecessorOf.set(name, previous[0]);
      if (!linkedPages(lastLine(previous[0]), '').has(name)) failures.push(`${name}: the last line of ${previous[0]} does not link it`);
    }
    for (const [name] of predecessorOf) {
      const seen = new Set([name]);
      let page = name;
      while (!indexed.has(page)) {
        const previous = predecessorOf.get(page);
        if (!previous || seen.has(previous)) {
          failures.push(`${name}: its chain never reaches a page the index links`);
          break;
        }
        seen.add(previous);
        page = previous;
      }
    }
    for (const name of subsystems) {
      for (const next of linkedPages(lastLine(name), '')) {
        if (!indexed.has(next) && predecessorOf.get(next) !== name) failures.push(`${next}: continued from ${name}, which is not its [Previous entries] page`);
      }
    }
    const continuations = [...predecessorOf.values()];
    for (const previous of new Set(continuations)) {
      if (continuations.filter(page => page === previous).length > 1) failures.push(`${previous}: continued by more than one page`);
    }
    expect(failures).toEqual([]);
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
});
