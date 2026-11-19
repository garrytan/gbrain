/**
 * `foresights migrate --plan` and `--status` perform zero mutations: polled at
 * every custody boundary of a paused graduation and after a SIGKILL at
 * `verified`, neither changes a byte or a row. One graduation per file; this
 * file probes part 1 of the boundaries (test/helpers/graduation-cli-cases.ts).
 */
import { zeroMutationSuite } from '../helpers/graduation-cli-cases.ts';

zeroMutationSuite(1);
