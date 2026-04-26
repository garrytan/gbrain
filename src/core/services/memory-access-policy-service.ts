import type { BrainEngine } from '../engine.ts';
import type { MemoryAccessMode } from '../types.ts';

export class MemoryAccessPolicyError extends Error {
  constructor(
    public readonly code:
      | 'memory_session_not_found'
      | 'memory_session_not_active'
      | 'memory_realm_not_attached'
      | 'memory_realm_read_only',
    message: string,
  ) {
    super(message);
    this.name = 'MemoryAccessPolicyError';
  }
}

export async function assertMemoryWriteAllowed(
  engine: BrainEngine,
  input: {
    memory_session_id?: string | null;
    realm_id?: string | null;
  },
): Promise<void> {
  if (!input.memory_session_id) return;
  if (!input.realm_id) {
    throw new MemoryAccessPolicyError(
      'memory_realm_not_attached',
      'memory_session_id requires realm_id for write authorization.',
    );
  }

  const session = await engine.getMemorySession(input.memory_session_id);
  if (!session) {
    throw new MemoryAccessPolicyError(
      'memory_session_not_found',
      `Memory session ${input.memory_session_id} was not found.`,
    );
  }
  if (session.status !== 'active') {
    throw new MemoryAccessPolicyError(
      'memory_session_not_active',
      `Memory session ${input.memory_session_id} is not active.`,
    );
  }

  const attachments = await engine.listMemorySessionAttachments({
    session_id: input.memory_session_id,
    realm_id: input.realm_id,
    limit: 1,
  });
  const attachment = attachments.find((entry) => entry.realm_id === input.realm_id);
  if (!attachment) {
    throw new MemoryAccessPolicyError(
      'memory_realm_not_attached',
      `Memory realm ${input.realm_id} is not attached to session ${input.memory_session_id}.`,
    );
  }
  if ((attachment.access as MemoryAccessMode) !== 'read_write') {
    throw new MemoryAccessPolicyError(
      'memory_realm_read_only',
      `Memory realm ${input.realm_id} is attached read-only for session ${input.memory_session_id}.`,
    );
  }
}
