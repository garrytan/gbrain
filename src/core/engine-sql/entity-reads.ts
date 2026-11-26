
import { callerAccessAllowedSql, privatePagesFilterForCaller, remoteReadFloorSql } from '../search/private-visibility.ts';

/**
 * The page policy a retirement hop applies to the page it reads (alias `p`), rendered in the caller's access record:
 * none, the caller's page policy (`privatePagesFilterForCaller`), the remote read floor (`remoteReadFloorSql`), or
 * member access alone (`callerAccessAllowedSql`).
 */
export type RetirementPrivacy = 'none' | 'caller' | 'floor' | 'member_access';
