export type LocalConfigurationReasonCode =
  | 'postgres_cancellation_unavailable'
  | 'child_executable_invalid'
  | 'child_protocol_incompatible';

export class LocalConfigurationError extends Error {
  readonly reasonCode: LocalConfigurationReasonCode;

  constructor(reasonCode: LocalConfigurationReasonCode, message: string) {
    super(message);
    this.name = 'LocalConfigurationError';
    this.reasonCode = reasonCode;
  }
}

export function isLocalConfigurationError(error: unknown): error is LocalConfigurationError {
  return error instanceof LocalConfigurationError;
}
