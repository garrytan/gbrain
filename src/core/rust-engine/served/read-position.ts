/**
 * Read-your-writes across connections (interfaces I-2 and I-7; multi-writer conformance C21).
 *
 * A write a brain server acknowledges carries the commit position it got; a served engine's connection keeps the newest
 * (served/client.ts `lastPosition`). `readPositionToken(engine)` gives it as a `cp1:<sequence>.<index>` token, and
 * `withReadPosition(token, fn)` makes every served read in `fn` carry it as `min_position`: the server answers only once
 * the brain has published that position, or ends the read `position_not_reached` (it ran nothing) at the read's deadline.
 *
 * An engine that is not a served client (in process, or a client of a local owner socket) reads from the one process
 * that acknowledged every write, so it already sees each acknowledged write; a token changes nothing there.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { opError } from '../../ops/contract.ts';
import { ownerConnectionFor } from '../owner-ipc/client.ts';
import { parsePositionToken, positionToken, type CommitPositionWire } from '../owner-ipc/protocol.ts';

const readPosition = new AsyncLocalStorage<string>();

/** The token of the newest write `engine`'s served connection acknowledged, or null (none yet, or not a served client). */
export function readPositionToken(engine: object): string | null {
  const position = (ownerConnectionFor(engine) as { lastPosition?: CommitPositionWire | null } | undefined)?.lastPosition;
  return position ? positionToken(position) : null;
}

/** Runs `fn` with every served read in it carrying `token` as its `min_position`; a malformed token is refused first. */
export function withReadPosition<T>(token: string, fn: () => Promise<T>): Promise<T> {
  if (!parsePositionToken(token)) {
    return Promise.reject(opError('invalid_params', `The read token ${JSON.stringify(token).slice(0, 80)} is not a commit position (cp1:<sequence>.<index>); nothing ran.`,
      'Pass the token readPositionToken returned for the engine that wrote.', { reason: 'read_token_malformed' }));
  }
  return readPosition.run(token, fn);
}

/** The read token the current call carries, if any (served/client.ts adds it to the frame). */
export function currentReadPosition(): string | undefined {
  return readPosition.getStore();
}
