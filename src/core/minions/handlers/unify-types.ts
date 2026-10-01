/**
 * `unify-types` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';
import { UnrecoverableError } from '../errors.ts';
import { OperationError } from '../../ops/contract.ts';

/**
 * v0.42 type-unification (T10): unify-types PROTECTED handler. Pack-upgrade
 * migration that retypes 25K+ pages, creates alias rows, converts edge-
 * shaped pages to link rows, AND flips the active pack at end of run.
 * manual_only via src/core/onboard/render.ts:MANUAL_ONLY_PROTECTED_JOBS.
 * Dry-run preview: `gbrain jobs submit unify-types --allow-protected
 * --params '{"target_pack":"gbrain-base-v2"}'`; apply with
 * '{"target_pack":"gbrain-base-v2","apply":true}'.
 */
export function makeUnifyTypesHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { runUnifyTypes } = await import('../../schema-pack/unify-types-handler.ts');
    const data = (job.data ?? {}) as {
      target_pack?: string;
      apply?: boolean;
      sourceId?: string;
    };
    if (!data.target_pack) {
      throw new Error(`unify-types: missing required 'target_pack' parameter`);
    }
    const ctx = {
      engine,
      cfg: null,
      remote: false,
    } as unknown as import('../../operations.ts').OperationContext;
    // #5634: a managed-brain refusal is deterministic; dead-letter it on the
    // first attempt instead of burning every retry.
    return await runUnifyTypes(ctx, {
      target_pack: data.target_pack,
      // #1575: default matches the handler interface's "Default false
      // (dry-run)" — a destructive one-shot migration must be opted into
      // with apply:true (the onboard remediation + the printed migration
      // command both carry it explicitly).
      apply: data.apply ?? false,
      sourceId: data.sourceId,
      onProgress: (msg: string) => {
        job.updateProgress({ phase: 'unify-types', message: msg }).catch(() => {});
        process.stderr.write(msg + '\n');
      },
    }).catch((error: unknown) => {
      if (error instanceof OperationError && error.code === 'writer_coordinator_required') {
        throw new UnrecoverableError(`${error.code}: ${error.message}`);
      }
      throw error;
    });
  };
}
