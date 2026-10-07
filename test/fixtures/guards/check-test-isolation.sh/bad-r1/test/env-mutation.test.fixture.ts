import { test } from 'bun:test';

// R1: a process.env write leaks to later files in the shard.
test('x', () => { process.env.GBRAIN_TEST_EXAMPLE = '1'; });
