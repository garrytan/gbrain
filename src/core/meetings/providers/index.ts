/** Meeting provider registry: one leaf per provider. */
import { firefliesProvider, type FirefliesOpts } from './fireflies.ts';
import type { MeetingProvider, MeetingProviderName } from '../types.ts';
import { assertNever } from '../../types.ts';

export type MeetingProviderOpts = FirefliesOpts;

export function meetingProvider(name: MeetingProviderName, opts: MeetingProviderOpts): MeetingProvider {
  switch (name) {
    case 'fireflies': return firefliesProvider(opts);
    default: return assertNever(name);
  }
}
