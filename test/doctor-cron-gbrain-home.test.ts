/**
 * doctor `cron_gbrain_home` (GBRA-108): cron commands, and scripts they run, that call gbrain without GBRAIN_HOME.
 */
import { expect, test } from 'bun:test';
import { cronGbrainHomeCheck, cronGbrainHomeFindings } from '../src/commands/doctor/checks/cron-gbrain-home.ts';

const scripts: Record<string, string> = {
  '/opt/example/run-sync.sh': '#!/bin/bash\ncd /opt/example/gbrain\nbun run src/cli.ts sync --all\n',
  '/opt/example/wrapped.sh': '#!/bin/bash\nexport GBRAIN_HOME=/srv/brain-a\nbun run src/cli.ts sync --all\n',
};
const read = (path: string) => scripts[path] ?? null;

test('a direct src/cli.ts call without GBRAIN_HOME is flagged on the line and inside a script the line runs', () => {
  const crontab = [
    '# m h dom mon dow command',
    'SHELL=/bin/bash',
    '*/5 * * * * cd /opt/example/gbrain && bun run src/cli.ts sync --all >> /tmp/sync.log 2>&1',
    '*/5 * * * * GBRAIN_HOME=/srv/brain-a bun run /opt/example/gbrain/src/cli.ts dream',
    '0 * * * * /opt/example/run-sync.sh',
    '0 * * * * /opt/example/wrapped.sh',
    '@hourly cd ~/gbrain && git pull',
  ].join('\n');
  expect(cronGbrainHomeFindings(crontab, undefined, read)).toEqual([
    { where: 'crontab line 3', command: 'cd /opt/example/gbrain && bun run src/cli.ts sync --all >> /tmp/sync.log 2>&1', reason: 'direct_cli' },
    { where: '/opt/example/run-sync.sh:3 (run by crontab line 5)', command: 'bun run src/cli.ts sync --all', reason: 'direct_cli' },
  ]);
});

test('the gbrain binary without GBRAIN_HOME is flagged only while this brain runs under a GBRAIN_HOME; a crontab env line covers every line', () => {
  const crontab = '0 * * * * /usr/local/bin/gbrain sync --all\n15 * * * * gbrain doctor --json\n';
  expect(cronGbrainHomeFindings(crontab, undefined, read)).toEqual([]);
  expect(cronGbrainHomeFindings(crontab, '/srv/brain-a', read).map(f => [f.where, f.reason])).toEqual([['crontab line 1', 'default_home'], ['crontab line 2', 'default_home']]);
  expect(cronGbrainHomeFindings(`GBRAIN_HOME=/srv/brain-a\n${crontab}0 * * * * /opt/example/run-sync.sh\n`, '/srv/brain-a', read)).toEqual([]);
});

test('the check: no crontab, or one that never mentions gbrain, emits nothing; a clean one is ok; findings warn with a user fix naming the home', () => {
  expect(cronGbrainHomeCheck(null, undefined, read)).toBeNull();
  expect(cronGbrainHomeCheck('0 3 * * * /usr/bin/backup --nightly\n', '/srv/brain-a', read)).toBeNull();
  expect(cronGbrainHomeCheck('0 * * * * gbrain sync --all\n', undefined, read)).toMatchObject({ name: 'cron_gbrain_home', status: 'ok' });
  const check = cronGbrainHomeCheck('0 * * * * gbrain sync --all\n', '/srv/brain-a', read)!;
  expect(check).toMatchObject({ name: 'cron_gbrain_home', status: 'warn', details: { gbrain_home: '/srv/brain-a' },
    fix: { argv: ['crontab', '-e'], actor: 'user', verify: { argv: ['gbrain', 'doctor', '--only', 'cron_gbrain_home', '--json'] } } });
  expect(check.message).toContain('crontab line 1');
  expect((check.fix as { user_message: string }).user_message).toContain('GBRAIN_HOME=/srv/brain-a');
});
