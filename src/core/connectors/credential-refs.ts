import { createHash } from 'crypto';

export const CREDENTIAL_PROVIDER_PRIORITY = [
  'credential_gateway',
  'os_keychain',
  'password_manager',
  'local_encrypted_vault',
] as const;

export type CredentialProvider = typeof CREDENTIAL_PROVIDER_PRIORITY[number];
export type CredentialRotationStatus = 'current' | 'rotation_due' | 'rotating' | 'revoked';
export type CredentialHealthStatus = 'healthy' | 'unhealthy' | 'expired' | 'unknown';

export interface CredentialReferenceInput {
  id?: string;
  connector_id: string;
  account_id: string;
  provider: CredentialProvider;
  reference: string;
  scopes: string[];
  expires_at?: string | null;
  now?: string;
  rotation_status?: CredentialRotationStatus;
  health_status?: CredentialHealthStatus;
}

export interface CredentialReferenceRecord {
  id: string;
  connector_id: string;
  account_id: string;
  provider: CredentialProvider;
  reference: string;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  rotation_status: CredentialRotationStatus;
  health_status: CredentialHealthStatus;
  created_at: string;
  updated_at: string;
}

export function createCredentialReference(input: CredentialReferenceInput): CredentialReferenceRecord {
  const now = input.now ?? new Date().toISOString();
  validateCredentialReference(input.provider, input.reference);
  return {
    id: input.id ?? stableId('credential-ref', input.connector_id, input.account_id, input.provider, input.reference),
    connector_id: input.connector_id,
    account_id: input.account_id,
    provider: input.provider,
    reference: input.reference,
    scopes: [...input.scopes],
    expires_at: input.expires_at ?? null,
    last_used_at: null,
    rotation_status: input.rotation_status ?? 'current',
    health_status: input.health_status ?? 'healthy',
    created_at: now,
    updated_at: now,
  };
}

export function selectCredentialProvider(
  availableProviders: readonly CredentialProvider[],
): CredentialProvider | null {
  return CREDENTIAL_PROVIDER_PRIORITY.find((provider) => availableProviders.includes(provider)) ?? null;
}

const PROVIDER_REFERENCE_PREFIXES: Record<CredentialProvider, string[]> = {
  credential_gateway: ['credential-gateway://', 'broker://'],
  os_keychain: ['keychain://', 'os-keychain://'],
  password_manager: ['password-manager://', '1password://', 'op://'],
  local_encrypted_vault: ['vault://', 'mbrain-vault://'],
};

const RAW_SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/,
  /xox[baprs]-[A-Za-z0-9-]{12,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /postgres(?:ql)?:\/\/[^/:\s]+:[^@\s]+@/i,
];

function validateCredentialReference(provider: CredentialProvider, reference: string): void {
  if (!reference.includes('://') || RAW_SECRET_PATTERNS.some((pattern) => pattern.test(reference))) {
    throw new Error('credential reference must use an external provider URI');
  }
  const allowedPrefixes = PROVIDER_REFERENCE_PREFIXES[provider];
  if (!allowedPrefixes.some((prefix) => reference.startsWith(prefix))) {
    throw new Error(`credential provider ${provider} requires reference prefix ${allowedPrefixes.join(', ')}`);
  }
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`;
}
