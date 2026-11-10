/**
 * The throwaway test databases (password `postgres`) listen on loopback only: every port the compose files publish
 * and every `docker run -p` the docs and scripts tell a contributor to type binds 127.0.0.1, so a test database on
 * a laptop or a CI host is never reachable from the network.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const COMPOSE = ['docker-compose.ci.yml', 'docker-compose.test.yml'];
const DOCS = [
  'CONTRIBUTING.md', 'docs/TESTING.md', 'scripts/persistence/README.md', 'test/e2e/sync-parallel.test.ts',
  'tests/heavy/_build_legacy_fixtures.sh', 'tests/heavy/pg_upgrade_matrix.sh', 'scripts/contributor-audit.ts',
];
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

describe('test databases publish on loopback only', () => {
  for (const file of COMPOSE) test(`${file}: every published port names host 127.0.0.1`, () => {
    const lines = read(file).split('\n');
    const published: string[] = [];
    lines.forEach((line, i) => {
      if (!/^\s*ports:\s*$/.test(line)) return;
      for (let j = i + 1; j < lines.length && /^\s*-\s/.test(lines[j]!); j++) published.push(lines[j]!.trim());
    });
    expect(published.length).toBeGreaterThan(0);
    for (const entry of published) expect(entry).toMatch(/^- "127\.0\.0\.1:[^"]+:5432"$/);
  });

  for (const file of DOCS) test(`${file}: every docker -p for a database binds 127.0.0.1`, () => {
    const publishes = [...read(file).matchAll(/(?:-p|'-p',)\s+'?([A-Za-z0-9.${}_:]+:5432)/g)].map(m => m[1]!);
    expect(publishes.length).toBeGreaterThan(0);
    for (const p of publishes) expect(p.startsWith('127.0.0.1:')).toBe(true);
  });
});
