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

let readerGone = false;

/** The EPIPE handlers record that the reader closed fd 1/2, so the exit that follows is not a command bug. */
export function noteJsonReaderGone(): void {
  readerGone = true;
}

export function jsonReaderGone(): boolean {
  return readerGone;
}
