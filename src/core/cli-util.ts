/**
 * Prompt on stdout, read one line from stdin, return trimmed string.
 * Shared helper used by interactive CLI flows (init, apply-migrations, etc.).
 */
export function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', (chunk) => {
      const data = chunk.toString().trim();
      process.stdin.pause();
      resolve(data);
    });
    process.stdin.resume();
  });
}
