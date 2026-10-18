/**
 * #6696 (A6/B2): the read-only verification of every write-capacity fix: doctor
 * on the brain host, and the read-scope `get_brain_health` operation for an
 * agent without admin scope (its capacity band clears).
 */
export const CAPACITY_VERIFY = { argv: ['gbrain', 'doctor', '--only', 'persistence_capacity', '--json'], mcp: { tool: 'get_brain_health', arguments: {} } };
