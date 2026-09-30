import type { PhaseError } from '../cycle.ts';

/** Map a thrown value onto the PhaseError a failed phase reports (peeled from cycle.ts for the module-size ratchet). */
export function makeErrorFromException(e: unknown, fallbackClass = 'InternalError'): PhaseError {
  const err = e instanceof Error ? e : new Error(String(e));
  // Node errors often have .code (e.g., 'ECONNREFUSED').
  const code = (err as NodeJS.ErrnoException).code || 'UNKNOWN';
  let className = fallbackClass;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') className = 'DatabaseConnection';
  if (code === 'ETIMEDOUT') className = 'Timeout';
  if (/OpenAI|embed/i.test(err.message)) className = 'LLMError';
  if (/ENOENT|EACCES|EISDIR|ENOTDIR/.test(code)) className = 'FilesystemError';
  return {
    class: className,
    code,
    message: err.message.slice(0, 200),
  };
}
