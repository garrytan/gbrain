
import type { OauthClientRow } from '../engine-sql/oauth-clients.ts';

export interface JobsMembers {
  readOauthClient(clientId: string): Promise<OauthClientRow | null>;
}
