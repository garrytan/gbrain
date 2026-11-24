/** The access control members. Part of the member-to-family map composed in ../members.ts. */
import type { BrainEngine } from '../../engine.ts';
import type { MemberClass } from '../members.ts';

export const ACCESS_MEMBERS = {
  readLiveMember: 'access_control',
  readFolderAccess: 'access_control',
  hasLabelledOnlyMember: 'access_control',
  readMayActFor: 'access_control',
  readAudiencePrincipals: 'access_control',
  readLinkedMember: 'access_control',
} as const satisfies Partial<Record<keyof BrainEngine, MemberClass>>;
