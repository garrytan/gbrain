import { describe, test, expect } from 'bun:test';

const cwd = new URL('..', import.meta.url).pathname;

async function runCli(args: string[]) {
  const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe('CLI help discoverability', () => {
  test('global help routes exact lookup to search and recall questions to query', async () => {
    const { stdout, exitCode } = await runCli(['--help']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('search <query>');
    expect(stdout).toContain('Keyword search (tsvector)');
    expect(stdout).toContain('exact known token');
    expect(stdout).toContain('structured field');
    expect(stdout).toContain('historical exact-match');
    expect(stdout).toContain('query <question> [--no-expand]');
    expect(stdout).toContain('Hybrid search (RRF + expansion)');
    expect(stdout).toContain('concept');
    expect(stdout).toContain('synonym');
    expect(stdout).toContain('landscape');
    expect(stdout).toContain('recall-completeness');
    expect(stdout).toContain('When to use which: start with query for all matching');
  });

  test('search help includes routing note and existing usage/options', async () => {
    const { stdout, stderr, exitCode } = await runCli(['search', '--help']);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Usage: gbrain search');
    expect(stdout).toContain('Keyword search using full-text search');
    expect(stdout).toContain('When to use which:');
    expect(stdout).toContain('exact known tokens');
    expect(stdout).toContain('structured fields');
    expect(stdout).toContain('historical exact-match lookups');
    expect(stdout).toContain('use gbrain query');
    expect(stdout).toContain('concept');
    expect(stdout).toContain('landscape');
    expect(stdout).toContain('all matching');
    expect(stdout).toContain('recall-completeness');
    expect(stdout).toContain('Options:');
    expect(stdout).toContain('<query>');
    expect(stdout).toContain('--limit');
  });

  test('query help names the recommended fuzzy recall cases', async () => {
    const { stdout, stderr, exitCode } = await runCli(['query', '--help']);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Usage: gbrain query');
    expect(stdout).toContain('Hybrid search with vector + keyword + multi-query expansion');
    expect(stdout).toContain('concept');
    expect(stdout).toContain('synonym');
    expect(stdout).toContain('landscape');
    expect(stdout).toContain('all matching');
    expect(stdout).toContain('recall-completeness');
    expect(stdout).toContain('Use gbrain search for exact known tokens');
  });

  test('unknown subcommand still returns a non-empty help pointer', async () => {
    const { stderr, exitCode } = await runCli(['notacommand']);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Unknown command: notacommand');
    expect(stderr).toContain('Run gbrain --help for available commands.');
  });
});
