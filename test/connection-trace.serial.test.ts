import { describe, expect, test } from 'bun:test';
import {
  postgresConnectionTraceOptions,
  startConnectionTraceSpan,
  type ConnectionEvent,
} from '../src/core/connection-audit.ts';
import { withEnv } from './helpers/with-env.ts';

describe('privacy-safe connection tracing', () => {
  test('is inert unless explicitly enabled', async () => {
    await withEnv({ GBRAIN_CONNECTION_TRACE: undefined }, () => {
      const events: ConnectionEvent[] = [];
      const span = startConnectionTraceSpan(
        { pool: 'read', caller: 'test', queryKind: 'static' },
        event => events.push(event),
      );
      span.finish();
      expect(span.unsafeOptions).toBeUndefined();
      expect(postgresConnectionTraceOptions('read')).toEqual({});
      expect(events).toEqual([]);
    });
  });

  test('records issue, exact checkout, and completion without query contents', async () => {
    await withEnv({ GBRAIN_CONNECTION_TRACE: '1' }, () => {
      const events: ConnectionEvent[] = [];
      const span = startConnectionTraceSpan(
        { pool: 'read', caller: 'PostgresEngine.executeRaw', queryKind: 'parameterized' },
        event => events.push(event),
      );

      expect(span.unsafeOptions?.onexecute({ id: 17 })).toBe(true);
      span.finish();
      span.finish();

      expect(events.map(event => event.op)).toEqual([
        'query_start',
        'checkout',
        'query_end',
      ]);
      expect(events[1]?.connection_id).toBe(17);
      expect(events[0]?.lease_id).toBe(events[1]?.lease_id);
      expect(events[1]?.lease_id).toBe(events[2]?.lease_id);
      expect(JSON.stringify(events)).not.toContain('sql');
      expect(JSON.stringify(events)).not.toContain('parameters');
    });
  });

  test('sanitizes errors and reports pool closes', async () => {
    await withEnv({ GBRAIN_CONNECTION_TRACE: 'true' }, () => {
      const events: ConnectionEvent[] = [];
      const emit = (event: ConnectionEvent) => events.push(event);
      const span = startConnectionTraceSpan(
        { pool: 'ddl', caller: 'PostgresEngine.executeRawDirect', queryKind: 'static' },
        emit,
      );
      const error = Object.assign(new Error('SELECT secret FROM private_table'), {
        code: '57014',
      });
      span.finish(error);
      postgresConnectionTraceOptions('ddl', emit).onclose?.(23);

      expect(events.map(event => event.op)).toEqual([
        'query_start',
        'query_error',
        'close',
      ]);
      expect(events[1]?.error).toEqual({ code: '57014', message: 'query_failed' });
      expect(events[2]?.connection_id).toBe(23);
      expect(JSON.stringify(events)).not.toContain('private_table');
      expect(JSON.stringify(events)).not.toContain('SELECT secret');
    });
  });
});
