/**
 * Postgres twin of test/amends-link.test.ts: the per-consumer final-output
 * invariance table for the non-ranking `amends` link, amendments versus
 * replacement in final search scores and labels, frontmatter `since`, and the
 * frozen-clock liveness exemption. One cloned database per scenario.
 */
import { defineAmendsLinkPostgresCases } from '../helpers/amends-link-postgres-cases.ts';

defineAmendsLinkPostgresCases();
