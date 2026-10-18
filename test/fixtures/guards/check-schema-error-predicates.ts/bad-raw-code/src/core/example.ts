export function degraded(e: unknown): boolean {
  return (e as { code?: string }).code === '42703';
}
