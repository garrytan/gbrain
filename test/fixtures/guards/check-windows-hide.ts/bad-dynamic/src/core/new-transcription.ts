export async function tempDir(): Promise<string> {
  const { execFileSync } = await import('child_process');
  return execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim();
}
