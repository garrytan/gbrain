import type { SinkPatterns } from './ts.ts';

export const PY_SINKS: SinkPatterns = {
  http_call: ['requests.*', 'urllib.*', 'httpx.*', 'aiohttp.*'],
  db_call: ['*.execute', '*.fetchall', '*.fetchone', '*.commit', 'sqlite3.*', 'psycopg2.*'],
  file_io: ['open', 'pathlib.*', 'os.read', 'os.write'],
  process_exec: ['subprocess.*', 'os.system', 'os.popen', 'os.exec*'],
} as const;
