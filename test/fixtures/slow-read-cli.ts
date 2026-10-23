/**
 * A CLI process stuck in a slow read, for the harness-timeout tests (test/read-heartbeat-cli.test.ts): the CLI's own
 * signal handlers and stdout guard, then a read that never finishes. `--json` turns the document guard on;
 * READ_EVERY_MS sets the heartbeat interval; NO_READ=1 skips the read (a command killed outside one).
 */
import { installSignalHandlers } from '../../src/core/process-cleanup.ts';
import { installStdoutPipeDelivery } from '../../src/core/cli-force-exit.ts';
import { beginSlowRead } from '../../src/core/read-heartbeat.ts';

const json = process.argv.includes('--json');
installSignalHandlers();
installStdoutPipeDelivery(json ? { json: 'document' } : {});
if (process.env.NO_READ !== '1') beginSlowRead('sync status for source alpha-example', { json, everyMs: Number(process.env.READ_EVERY_MS ?? 10_000) });
process.stderr.write('fixture: ready\n');
setInterval(() => {}, 1_000);
