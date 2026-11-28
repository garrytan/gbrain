/**
 * One served session's side of the replica-ack gate (replica-gate.ts; rust/docs/store/commit-log.md, "Replica acks"):
 * a successful write is answered as a success only once an attached replica's ack covers its commit position, a write
 * that would wait past the budget is refused before it runs, and a wait that ends without the ack answers
 * `replication_timeout`. Peeled from session.ts so `servedSession` keeps its size.
 */
import type { OperationError } from '../../ops/contract.ts';
import { servedReplicationBusy, servedReplicationTimeout } from './errors.ts';
import type { PositionReader } from './positions.ts';
import type { ReplicaGate, ReplicaRefusal } from './replica-gate.ts';
import type { StoredOutcome } from './requests.ts';

type Position = { sequence: number; index: number };

/** The settled call a reply goes to (session.ts ServedCall). */
interface SettledCall {
  id: number;
  member: string;
  done: boolean;
  controller?: { readonly signal: AbortSignal };
  reply(frame: object): void;
}

export interface SessionReplica {
  /** A stored or attached outcome (a retry of a request id): answered as a success only once the replica holds it. */
  answerStored(id: number, member: string, req: string, outcome: StoredOutcome): Promise<void>;
  /** For a write (`write`), the `replication_busy` refusal when the waiter budget is full, else null. Checked before it runs. */
  busy(member: string, req: unknown, write: boolean): Promise<OperationError | null>;
  /**
   * The commit position of a settled successful write, read whatever the client's capabilities (the gate needs it);
   * `crosses` (the client offered `positions`) only decides whether it goes on the wire. The gate remembers it with
   * the outcome, so a retry waits for the same position.
   */
  notePosition(outcome: StoredOutcome, crosses: boolean): Promise<Position | null>;
  /** Answers a settled successful write once the replica holds it; not awaited, so the wait holds no execution permit. */
  answerCommitted(call: SettledCall, req: unknown, outcome: StoredOutcome, position: Position | null): void;
  /** A served transaction committed at `position`: null once the replica holds it, else the refusal to answer. */
  afterCommit(position: Position | null): Promise<OperationError | null>;
}

export function sessionReplica(o: {
  gate: ReplicaGate;
  positions: PositionReader | null;
  writeFrame: (frame: object, member?: string) => void;
  encodeErr: (error: unknown) => unknown;
}): SessionReplica {
  const reqText = (req: unknown) => (typeof req === 'string' ? req : '-');
  const timeout = (member: string, req: unknown, refusal: ReplicaRefusal) =>
    servedReplicationTimeout(member, reqText(req), refusal.position, refusal.timeoutMs, refusal.ackedThrough, refusal.why);
  const refused = (id: number, member: string, req: unknown, refusal: ReplicaRefusal) =>
    ({ t: 'result', id, ok: false, error: o.encodeErr(timeout(member, req, refusal)) });
  return {
    async answerStored(id, member, req, outcome) {
      const { write, position } = o.gate.recall(outcome);
      const refusal = write && outcome.ok ? await o.gate.admit(position) : null;
      o.writeFrame(refusal ? refused(id, member, req, refusal) : { t: 'result', id, ...outcome }, member);
    },
    async busy(member, req, write) {
      if (!write) return null;
      const full = await o.gate.busy().catch(() => null);
      return full ? servedReplicationBusy(member, reqText(req), full.maxWaiters) : null;
    },
    async notePosition(outcome, crosses) {
      let position: Position | null = null;
      if (o.positions) {
        try { const p = await o.positions(); if (p?.exact) position = { sequence: p.sequence, index: p.index }; } catch { /* no position */ }
      }
      if (position && crosses) outcome.position = position;
      o.gate.remember(outcome, position);
      return position;
    },
    answerCommitted(call, req, outcome, position) {
      o.gate.committed();
      if (call.done) return;
      void o.gate.admit(position).then(refusal => {
        // `done` is set once the engine call settled; only an abort (cancel, disconnect, close) drops this reply.
        if (call.controller?.signal.aborted ?? call.done) return;
        call.reply(refusal ? refused(call.id, call.member, req, refusal) : { t: 'result', id: call.id, ...outcome });
      });
    },
    async afterCommit(position) {
      o.gate.committed();
      const refusal = await o.gate.admit(position);
      return refusal ? timeout('transaction', '-', refusal) : null;
    },
  };
}
