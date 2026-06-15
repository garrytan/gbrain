import type {
  MemoryCandidateCreateStatus,
  MemoryCandidateStatus,
  MemoryCandidateStatusEventInput,
  MemoryCandidateStatusPatch,
} from './types.ts';

export function isMemoryCandidateCreateStatus(
  status: MemoryCandidateStatus,
): status is MemoryCandidateCreateStatus {
  return status === 'captured'
    || status === 'candidate'
    || status === 'staged_for_review';
}

export function assertMemoryCandidateCreateStatus(
  status: MemoryCandidateStatus,
): MemoryCandidateCreateStatus {
  if (!isMemoryCandidateCreateStatus(status)) {
    throw new Error(
      `Cannot create memory candidate directly in ${status} status; use bounded governance workflows instead.`,
    );
  }
  return status;
}

// Governs generic status patches only; promotion and supersession use dedicated CAS methods.
export function isAllowedMemoryCandidateStatusUpdate(
  currentStatus: MemoryCandidateStatus,
  nextStatus: MemoryCandidateStatusPatch['status'],
): boolean {
  switch (currentStatus) {
    case 'captured':
      return nextStatus === 'candidate';
    case 'candidate':
      return nextStatus === 'staged_for_review';
    case 'staged_for_review':
      return nextStatus === 'rejected';
    case 'rejected':
    case 'promoted':
    case 'superseded':
      return false;
    default:
      return assertNeverMemoryCandidateStatus(currentStatus);
  }
}

export function assertMemoryCandidateStatusEventInput(
  input: MemoryCandidateStatusEventInput,
): void {
  switch (input.event_kind) {
    case 'created':
      if ((input.from_status ?? null) !== null || !isMemoryCandidateCreateStatus(input.to_status)) {
        throw invalidMemoryCandidateStatusEvent(input);
      }
      return;
    case 'advanced':
      if (
        !(
          (input.from_status === 'captured' && input.to_status === 'candidate')
          || (input.from_status === 'candidate' && input.to_status === 'staged_for_review')
          || (
            input.from_status === input.to_status
            && input.from_status !== undefined
            && input.from_status !== null
            && isMemoryCandidateCreateStatus(input.from_status)
          )
        )
      ) {
        throw invalidMemoryCandidateStatusEvent(input);
      }
      return;
    case 'promoted':
      if (input.from_status !== 'staged_for_review' || input.to_status !== 'promoted') {
        throw invalidMemoryCandidateStatusEvent(input);
      }
      return;
    case 'rejected':
      if (input.from_status !== 'staged_for_review' || input.to_status !== 'rejected') {
        throw invalidMemoryCandidateStatusEvent(input);
      }
      return;
    case 'superseded':
      if (
        (input.from_status !== 'staged_for_review' && input.from_status !== 'promoted')
        || input.to_status !== 'superseded'
      ) {
        throw invalidMemoryCandidateStatusEvent(input);
      }
      return;
    default:
      return assertNeverMemoryCandidateStatusEventKind(input.event_kind);
  }
}

function assertNeverMemoryCandidateStatus(status: never): never {
  throw new Error(`Unhandled memory candidate status: ${status}`);
}

function assertNeverMemoryCandidateStatusEventKind(kind: never): never {
  throw new Error(`Unhandled memory candidate status event kind: ${kind}`);
}

function invalidMemoryCandidateStatusEvent(input: MemoryCandidateStatusEventInput): Error {
  return new Error(
    `Invalid memory candidate status event: ${input.event_kind} ${input.from_status ?? 'null'} -> ${input.to_status}.`,
  );
}
