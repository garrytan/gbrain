import { join } from 'node:path';
import { configDir } from '../config.ts';
import { readCredentials, writeCredentials, type HarnessCredentials } from './credentials.ts';

/** A private, host-local delivery journal. Written before the grant transaction
 * commits, so losing an HTTP response never requires a duplicate or a rotation.
 * A journal is deliverable only after the caller verifies its live client row. */
export function deliveryPath(clientId: string): string {
  if (!/^gbrain_cl_[A-Za-z0-9_-]+$/.test(clientId)) throw new Error('Invalid delivery client');
  return join(configDir(), 'credential-deliveries', `${clientId}.json`);
}

export function retainCredentialDelivery(credentials: HarnessCredentials): void {
  writeCredentials(deliveryPath(credentials.client_id), credentials);
}

export function recoverCredentialDelivery(clientId: string, endpoint: string): HarnessCredentials {
  let credentials: HarnessCredentials;
  try { credentials = readCredentials(deliveryPath(clientId)); }
  catch { throw new Error(`client_secret_delivery_unavailable: ${clientId}. Use its retained private setup or explicit rotation output. Inspect the client with gbrain mcp admin client before choosing replacement. Legacy host-side agent register --reissue only supports confidential clients with client_credentials and rotates authority; it is not a repeated download. Native-only clients without retained delivery require an explicitly approved replacement.`); }
  if (credentials.client_id !== clientId || credentials.mcp_url !== endpoint) throw new Error('credential_delivery_conflict: client or endpoint differs from the original delivery');
  return credentials;
}
