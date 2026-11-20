/**
 * #8729 Postgres arm: test/helpers/segmented-sync-replace-cases.ts (the PGLite arm is
 * test/large-pages/segmented-sync-replace-8729.test.ts). Only Postgres pipelines a publication's calls, so only this arm
 * can run a version's prune sweep beside the flip. The arm itself is test/helpers/segmented-sync-replace-postgres-arm.ts.
 */
import { defineSegmentedSyncReplacePostgresArm } from '../helpers/segmented-sync-replace-postgres-arm.ts';

defineSegmentedSyncReplacePostgresArm();
