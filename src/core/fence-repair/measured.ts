/**
 * What the Tier 3 fence-repair eval measured (#6188 T4,
 * evals/fence-repair-tier3/; verdicts in gbrain-evals). The next eval run
 * updates both constants together.
 *
 * `FENCE_REPAIR_MEASURED_MODELS`: the models that met the preregistered
 * rule (gate-pass at least 80%, false accepts at most 1%) on both the round 1
 * fixtures and the held-out set (round 2, prompt v2), best first by held-out
 * gate-pass with ties to the cheaper model. `anthropic:claude-fable-5-1` also
 * met the rule but is left out: Fable runs only in smoke tests, never as a
 * counted or default model, and it came after `claude-opus-5-5` on the same
 * key, so it was never chosen. With
 * `models.fence_repair` unset, model repair uses the first one the brain has
 * a provider key for; with none, model repair stays off by default
 * (`no_measured_model`). An explicit `models.fence_repair` always runs.
 *
 * `FENCE_REPAIR_MEASURED`: the sentence the behavior-change notice prints
 * about how often the model's rewrites are accepted. HTTP clients see it too,
 * so it names no model or provider (`gbrain models` names the model).
 */
export const FENCE_REPAIR_MEASURED_MODELS: readonly string[] = ['openai:gpt-6.1-sol', 'anthropic:claude-opus-5-5'];

export const FENCE_REPAIR_MEASURED = 'On 40 held-out synthetic malformed fences over three runs, each measured default model repaired 95 of 99 attempts with no cell in the wrong column and declined the other 4.';
