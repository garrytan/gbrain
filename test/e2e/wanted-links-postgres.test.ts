/**
 * Postgres arms of the wanted-pages scenarios (test/wanted-links.test.ts runs
 * the same bodies on PGLite).
 */
import { defineWantedLinksPostgresCases } from '../helpers/wanted-links-postgres-cases.ts';

defineWantedLinksPostgresCases();
