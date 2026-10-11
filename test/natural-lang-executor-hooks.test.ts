import { describe, expect, test } from 'bun:test';
import {
  cancelRun,
  CHILD_HANG_AFTER_RESULT_MS,
  parseTerminalChildResult,
  PgliteRunCoordinator,
  resolveRunTimeoutMs,
  startRun,
} from '../src/commands/natural-lang/executor.ts';

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for run state');
    await Bun.sleep(10);
  }
}

describe('natural language child-process hooks', () => {
  test('keeps the generic default while allowing long-running maintenance to opt out', () => {
    expect(resolveRunTimeoutMs(undefined)).toBe(6 * 60 * 60 * 1000);
    expect(resolveRunTimeoutMs(120_000)).toBe(120_000);
    expect(resolveRunTimeoutMs(null)).toBeNull();
    expect(resolveRunTimeoutMs(undefined, 'embed_stale')).toBeNull();
    expect(resolveRunTimeoutMs(undefined, 'sync_source')).toBeNull();
    expect(resolveRunTimeoutMs(undefined, 'sync_all')).toBeNull();
  });

  test('does not expose a completed run until PGLite reconnection finishes', async () => {
    let releaseReconnect!: () => void;
    const reconnect = new Promise<void>(resolve => {
      releaseReconnect = resolve;
    });
    const run = await startRun(
      'source_add',
      [process.execPath, '-e', 'process.exit(0)'],
      process.cwd(),
      { afterComplete: async () => await reconnect },
    );

    await Bun.sleep(100);
    expect(run.status).toBe('running');
    expect(run.completedAt).toBeNull();

    releaseReconnect();
    await waitFor(() => run.status !== 'running');
    expect(run.status).toBe('completed');
    expect(run.completedAt).not.toBeNull();
  });

  test('reports a reconnect failure instead of a false successful completion', async () => {
    const run = await startRun(
      'source_add',
      [process.execPath, '-e', 'process.exit(0)'],
      process.cwd(),
      { afterComplete: async () => { throw new Error('PGLite unavailable'); } },
    );

    await waitFor(() => run.status !== 'running');
    expect(run.status).toBe('failed');
    expect(run.error).toContain('database reconnection failed');
    expect(run.error).toContain('PGLite unavailable');
  });

  test('serializes PGLite children through disconnect, exit, and reconnect', async () => {
    const coordinator = new PgliteRunCoordinator();
    const events: string[] = [];
    const hooks = {
      acquireExclusive: () => coordinator.acquire(),
      beforeSpawn: async () => { events.push('disconnect'); },
      afterComplete: async () => {
        await Bun.sleep(20);
        events.push('reconnect');
      },
    };

    const first = await startRun(
      'import_path',
      [process.execPath, '-e', 'setTimeout(() => process.exit(0), 80)'],
      process.cwd(),
      hooks,
    );
    const second = await startRun(
      'dream_cycle',
      [process.execPath, '-e', 'process.exit(0)'],
      process.cwd(),
      hooks,
    );

    expect(['queued', 'running']).toContain(first.status);
    expect(second.status).toBe('queued');
    await waitFor(() => first.status === 'completed' && second.status === 'completed');
    expect(events).toEqual(['disconnect', 'reconnect', 'disconnect', 'reconnect']);
  });

  test('keeps the complete Dream result separately when the visible log tail is truncated', async () => {
    const script = [
      "const report={schema_version:'1',status:'partial',",
      "totals:{pages_added:988,links_created:183,pages_embedded:12132},",
      "phases:[{phase:'embed',status:'warn',details:{embedded:12132,total_chunks:14000,",
      "errors:[{message:'balance unavailable'}],filler:'x'.repeat(140000)}}]};",
      'process.stdout.write(JSON.stringify(report));',
    ].join('');
    const run = await startRun(
      'dream_full',
      [process.execPath, '-e', script],
      process.cwd(),
      { captureJsonResult: true },
    );

    await waitFor(() => run.status !== 'running');
    expect(run.stdout.length).toBeLessThanOrEqual(120_000);
    expect(run.result).toMatchObject({
      status: 'partial',
      totals: { pages_added: 988, links_created: 183, pages_embedded: 12132 },
      phases: [{
        phase: 'embed',
        details: { embedded: 12132, total_chunks: 14000, pending: 1868, errors_count: 1 },
      }],
    });
  });

  test('recognizes an embed-style terminal JSON result after human summary text', () => {
    expect(CHILD_HANG_AFTER_RESULT_MS).toBe(15_000);
    expect(parseTerminalChildResult(
      'Embedded 2 chunks across 2 pages\n{"embedded":2,"skipped":0,"total_chunks":2,"status":"ok","dryRun":false}\n',
    )).toEqual({ status: 'ok' });
    expect(parseTerminalChildResult('{"event":"tick","phase":"embed.pages","status":"ok"}\n')).toBeNull();
    expect(parseTerminalChildResult('still working')).toBeNull();
  });

  test('requires a root Dream report before treating Dream output as terminal', () => {
    expect(parseTerminalChildResult('Import complete (0.4s)\n', 'dream_quick')).toBeNull();
    expect(parseTerminalChildResult(
      '{"status":"imported","chunks":1}\n',
      'dream_quick',
    )).toBeNull();
    expect(parseTerminalChildResult(
      '{"schema_version":"1","status":"partial","phases":[]}\n',
      'dream_quick',
    )).toEqual({ status: 'partial' });
  });

  test('treats per-file import JSON as progress, not the finished import command', () => {
    expect(parseTerminalChildResult(
      '[pmbrain import-file] {"status":"imported","path":"a.pptx","chunks":1}\n',
      'import_path',
    )).toBeNull();
    expect(parseTerminalChildResult(
      '[pmbrain import-file] {"status":"failed","path":"~$a.pptx","reason":"Can\'t find end of central directory"}\n',
      'import_path',
    )).toBeNull();
    expect(parseTerminalChildResult(
      '[pmbrain import-file] {"status":"unchanged","path":"same.md"}\n',
      'import_path',
    )).toBeNull();
    expect(parseTerminalChildResult(
      'Import complete (0.4s):\n  1 pages imported\n',
      'import_path',
    )).toEqual({ status: 'ok' });
    expect(parseTerminalChildResult(
      '{"status":"success","imported":1,"skipped":0,"errors":0,"chunks":2,"total_files":2,"duration_s":1.2}\n',
      'import_path',
    )).toEqual({ status: 'success' });
  });

  test('recognizes pretty-printed think JSON as a finished knowledge search', () => {
    const output = `{
  "question": "我家狗叫什么名字",
  "answer": "靓靓",
  "citations": [],
  "gaps": [],
  "pagesGathered": 11,
  "modelUsed": "deepseek:deepseek-v4-flash"
}`;
    expect(parseTerminalChildResult(output, 'search_brain')).toEqual({ status: 'ok' });
    expect(parseTerminalChildResult(output)).toBeNull();
    expect(parseTerminalChildResult('{"question":"q","answer":"a"}\n', 'search_brain')).toBeNull();
  });

  test('force-completes a think child that printed answer JSON but never exits', async () => {
    const run = await startRun(
      'search_brain',
      [
        process.execPath,
        '-e',
        'process.stdout.write("{\\n  \\"question\\": \\"我家狗叫什么名字\\",\\n  \\"answer\\": \\"靓靓\\",\\n  \\"pagesGathered\\": 11,\\n  \\"modelUsed\\": \\"deepseek:deepseek-v4-flash\\"\\n}\\n"); setInterval(() => {}, 1000);',
      ],
      process.cwd(),
      { hangAfterResultMs: 80 },
    );

    await waitFor(() => run.status !== 'running', 5_000);
    expect(run.status).toBe('completed');
    expect(run.stdout).toContain('靓靓');
    expect(run.stderr).toContain('force-killing');
  });

  test('force-completes a child that printed success JSON but never exits', async () => {
    // Product check: the packaged embed catch-up command already printed
    // {"status":"ok"} while the process stayed alive, so Admin kept showing
    // the task as running and 423-locked the database. After the result JSON
    // appears, the parent must kill that stuck child and mark the task done.
    const run = await startRun(
      'embed_stale',
      [
        process.execPath,
        '-e',
        'process.stdout.write("Embedded 2 chunks\\n{\\"status\\":\\"ok\\",\\"embedded\\":2,\\"total_chunks\\":2}\\n"); setInterval(() => {}, 1000);',
      ],
      process.cwd(),
      { hangAfterResultMs: 80 },
    );

    await waitFor(() => run.status !== 'running', 5_000);
    expect(run.status).toBe('completed');
    expect(run.stdout).toContain('"status":"ok"');
    expect(run.stderr).toContain('force-killing');
  });

  test('force-fails a child that printed a failed JSON result but never exits', async () => {
    const run = await startRun(
      'embed_stale',
      [
        process.execPath,
        '-e',
        'process.stdout.write("{\\"status\\":\\"failed\\",\\"failedPages\\":1}\\n"); setInterval(() => {}, 1000);',
      ],
      process.cwd(),
      { hangAfterResultMs: 80 },
    );

    await waitFor(() => run.status !== 'running', 5_000);
    expect(run.status).toBe('failed');
    expect(run.stderr).toContain('force-killing');
  });

  test('does not treat per-file import JSON as a finished import command', async () => {
    const run = await startRun(
      'import_path',
      [
        process.execPath,
        '-e',
        'process.stderr.write("[pmbrain import-file] {\\"status\\":\\"imported\\",\\"path\\":\\"a.md\\",\\"chunks\\":1}\\n"); setTimeout(() => { process.stdout.write("Import complete (0.1s)\\nSTILL_RUNNING_THEN_DONE\\n"); process.exit(0); }, 180);',
      ],
      process.cwd(),
      { hangAfterResultMs: 80 },
    );

    await waitFor(() => run.status !== 'running', 5_000);
    expect(run.status).toBe('completed');
    expect(run.stdout).toContain('STILL_RUNNING_THEN_DONE');
    expect(run.stderr).not.toContain('force-killing');
  });

  test('does not kill a folder import after a per-file failed JSON', async () => {
    const run = await startRun(
      'import_path',
      [
        process.execPath,
        '-e',
        [
          'process.stderr.write("[pmbrain import-file] {\\"status\\":\\"imported\\",\\"path\\":\\"a.pptx\\"}\\n");',
          'process.stderr.write("[pmbrain import-file] {\\"status\\":\\"failed\\",\\"path\\":\\"~$a.pptx\\",\\"reason\\":\\"zip\\"}\\n");',
          'setTimeout(() => {',
          '  process.stderr.write("[pmbrain import-file] {\\"status\\":\\"imported\\",\\"path\\":\\"b.docx\\"}\\n");',
          '  process.stdout.write("Import complete (1.2s):\\n  2 pages imported\\nMORE_AFTER_COMPLETE\\n");',
          '  process.exit(0);',
          '}, 180);',
        ].join(''),
      ],
      process.cwd(),
      { hangAfterResultMs: 80 },
    );

    await Bun.sleep(120);
    expect(run.status).toBe('running');
    expect(run.stderr).not.toContain('force-killing');
    await waitFor(() => run.status !== 'running', 5_000);
    expect(run.status).toBe('completed');
    expect(run.stdout).toContain('MORE_AFTER_COMPLETE');
    expect(run.stderr).not.toContain('force-killing');
  });

  test('force-completes a hanging import child after the human Import complete line', async () => {
    const run = await startRun(
      'import_path',
      [
        process.execPath,
        '-e',
        'process.stdout.write("Import complete (0.4s):\\n  1 pages imported\\n"); setInterval(() => {}, 1000);',
      ],
      process.cwd(),
      { hangAfterResultMs: 80 },
    );

    await waitFor(() => run.status !== 'running', 5_000);
    expect(run.status).toBe('completed');
    expect(run.stderr).toContain('force-killing');
  });

  test('does not stop quick maintenance after its intermediate import summary', async () => {
    // Product check: Quick Maintenance runs sync/import before later Dream
    // phases. "Import complete" means only that nested phase finished; the
    // parent must wait for the whole Dream child to exit normally.
    const run = await startRun(
      'dream_quick',
      [
        process.execPath,
        '-e',
        'process.stdout.write("Import complete (0.4s):\\n  1 pages imported\\n"); setTimeout(() => { process.stdout.write("DREAM_FINISHED\\n"); process.exit(0); }, 180);',
      ],
      process.cwd(),
      { hangAfterResultMs: 80 },
    );

    await waitFor(() => run.status !== 'running', 5_000);
    expect(run.status).toBe('completed');
    expect(run.stdout).toContain('DREAM_FINISHED');
    expect(run.stderr).not.toContain('force-killing');
  });

  test('does not treat progress-event JSON as a finished command', async () => {
    const run = await startRun(
      'embed_stale',
      [
        process.execPath,
        '-e',
        'process.stdout.write("{\\"event\\":\\"tick\\",\\"phase\\":\\"embed.pages\\",\\"status\\":\\"ok\\"}\\n"); setInterval(() => {}, 1000);',
      ],
      process.cwd(),
      { hangAfterResultMs: 80 },
    );

    await Bun.sleep(200);
    expect(run.status).toBe('running');
    await cancelRun(run.id);
    await waitFor(() => run.status !== 'running', 5_000);
    expect(run.status).toBe('cancelled');
  });

  test('cancel waits for child exit and PGLite reconnection before confirming cancellation', async () => {
    let reconnected = false;
    const run = await startRun(
      'dream_propose_takes',
      [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      process.cwd(),
      {
        afterComplete: async () => {
          await Bun.sleep(120);
          reconnected = true;
        },
      },
    );
    await waitFor(() => run.status === 'running');

    const cancelled = await cancelRun(run.id);

    expect(cancelled?.status).toBe('cancelled');
    expect(reconnected).toBe(true);
  });
});
