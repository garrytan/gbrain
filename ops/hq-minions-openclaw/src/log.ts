type Level = 'debug' | 'info' | 'warn' | 'error';

const rank: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function configured(): Level {
  const value = (process.env.LOG_LEVEL || 'info').toLowerCase();
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
  return 'info';
}

function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/postgresql:\/\/([^:]+):([^@]+)@/g, 'postgresql://$1:***@');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /password|secret|token|key/i.test(k) ? '***' : redact(v);
    }
    return out;
  }
  return value;
}

export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (rank[level] < rank[configured()]) return;
  const line = JSON.stringify(redact({
    ts: new Date().toISOString(),
    level,
    message,
    component: 'hq-minions-openclaw',
    ...fields
  }));
  if (level === 'warn' || level === 'error') console.error(line);
  else console.log(line);
}
