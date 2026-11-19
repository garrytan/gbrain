#!/usr/bin/env bun
/**
 * scripts/skillify-check.ts — thin shim (v0.17+).
 *
 * The 10-item audit logic lives in `src/commands/skillify-check.ts`
 * and is exposed as `foresights skillify check` (D-CX-2). This file stays
 * as a shim so existing callers (tests, docs, cron entries) continue
 * to work. New code should prefer `foresights skillify check ...`.
 */

import { runSkillifyCheckInline } from '../src/commands/skillify-check.ts';

await runSkillifyCheckInline(process.argv.slice(2));
