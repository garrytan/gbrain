/**
 * #9717: the sanitized re-run inherits fd 1 and writes the command's `--json` document itself, so the wrapper that
 * spawned it must add no fallback document. A leaf module, so cli-preflight (which the hook launcher loads) can record
 * it without importing cli-force-exit and the CLI graph behind it.
 */
let delegated = false;

export function noteJsonDocumentDelegated(): void {
  delegated = true;
}

export function jsonDocumentDelegated(): boolean {
  return delegated;
}

/** #10548: the EPIPE handlers (process-cleanup) record that the reader closed the pipe, so the exit 0 that follows is not a command that printed no document. */
let readerClosedPipe = false;

export function noteJsonReaderClosedPipe(): void {
  readerClosedPipe = true;
}

export function jsonReaderClosedPipe(): boolean {
  return readerClosedPipe;
}
