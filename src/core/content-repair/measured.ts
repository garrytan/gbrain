/**
 * What the content-repair judgment eval measured (#6377 section 4,
 * evals/content-repair-judgment/; verdicts in gbrain-evals).
 *
 * `CONTENT_REPAIR_MEASURED_MODELS`: the models that met the preregistered
 * rule (zero hard failures: no `remove_slug` on a true duplicate, no
 * `merge_into` on an unrelated pair or with the wrong canonical; at least 80%
 * `merge_into` with the right canonical on true duplicates), best first,
 * ties to the cheaper model. Measured 2026-10-09 on 48 synthetic pairs
 * (25 true duplicates, 10 stray slugs, 8 adversarial, 5 ambiguous), three
 * runs per model, prompt v1: every listed model gave zero hard failures in
 * 144 pair runs, removed every stray slug, deferred every ambiguous pair and
 * never merged an adversarial pair; true-duplicate recognition 92.0%,
 * 85.3% and 80.0%. Verdict mirrored in gbrain-evals
 * (docs/benchmarks/2026-10-09-content-repair-judgment.md). The next eval run
 * updates this list with the prompt version it measured. With
 * `models.content_repair` and `models.fence_repair` unset, the judgment uses
 * the first one the brain has a provider key for; with none, the model tier
 * stays off (`no_measured_model`).
 */
export const CONTENT_REPAIR_MEASURED_MODELS: readonly string[] = ['anthropic:claude-opus-5-5', 'openai:gpt-6.1-sol', 'anthropic:claude-sonnet-5-5'];

export const CONTENT_REPAIR_MEASURED = 'On 48 synthetic slug-conflict pairs over three runs, each measured default model gave no harmful answer (never deleted the slug of a true duplicate, never merged two different pages) and recognised at least 80% of true duplicates, deferring the rest to a person.';
