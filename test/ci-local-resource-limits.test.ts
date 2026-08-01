import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('runner image build wiring provides Git', () => {
  const compose = readFileSync(resolve(import.meta.dir, '..', 'docker-compose.ci.yml'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
  const dockerfile = readFileSync(
    resolve(import.meta.dir, '..', 'docker', 'ci-runner.Dockerfile'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  expect(compose).toContain('build:\n      context: .\n      dockerfile: docker/ci-runner.Dockerfile');
  expect(dockerfile.startsWith('FROM oven/bun:1\n')).toBe(true);
  expect(dockerfile).toContain('--no-install-recommends git ca-certificates');
});

test('ci-local refreshes pulled services and rebuilds the runner', () => {
  const script = readFileSync(resolve(import.meta.dir, '..', 'scripts', 'ci-local.sh'), 'utf8');

  expect(script).toContain(
    'docker compose -f "$COMPOSE_FILE" pull --ignore-buildable 2>&1 | tail -5',
  );
  expect(script).toContain('docker compose -f "$COMPOSE_FILE" build --pull runner');
});
