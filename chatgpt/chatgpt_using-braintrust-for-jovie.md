---
title: "Using Braintrust for Jovie"
type: guide
created: 2026-05-20
updated: 2026-05-20
source: chatgpt-export
conversation_id: 6a0d0365-1664-83e8-b41f-f9cb56f5eae4
message_count: 3
tags: [chatgpt, import, code, long-form]
---
# Using Braintrust for Jovie

> Conversation ID: 6a0d0365-1664-83e8-b41f-f9cb56f5eae4
> Created: 2026-05-20T00:42:13Z
> Updated: 2026-05-20T00:44:59Z
> Messages: 3

---

## User

how do i use braintrust? give me like the highlevel of what it does and how i would use it for jovie

---

## Assistant

I’ll ground this in Braintrust’s current docs and map its core concepts to a practical Jovie workflow.

---

## Assistant

Mr. White, **Braintrust is basically the QA, observability, and prompt-management layer for Jovie’s AI features**.

Jovie’s public positioning is “monetize your music catalog with AI,” turning releases into fan paths, presaves, playlist pitches, and acting as an “always-on AI artist manager.” citeturn848077view0 Braintrust is where you would make those AI outputs measurable, testable, versioned, and debuggable before and after they reach users. Braintrust describes itself as an AI observability platform for measuring, evaluating, and improving production AI apps, including comparing models, iterating prompts, catching regressions, and using real user data to improve applications. citeturn743355view0

## Mental model

| Braintrust feature | What it means | How it maps to Jovie |
|---|---|---|
| **Prompts** | Store/version prompts centrally | “Generate playlist pitch,” “build release rollout,” “recommend fan path,” “write presave CTA” |
| **Logs / traces** | See every AI run: input, output, timing, cost, tool calls | Debug why a campaign recommendation, pitch, or artist-manager response was wrong |
| **Datasets** | Reusable test cases | Real artist/release examples with expected outputs or rubrics |
| **Scorers** | Automated quality checks | Did it hallucinate? Use artist metadata? Match tone? Produce valid JSON? Recommend realistic actions? |
| **Playgrounds** | Browser-based prompt/model testing | Compare GPT-4.1 vs Claude vs smaller models on release-planning tasks |
| **Experiments** | Immutable eval runs | “Did the new prompt beat the old one across 100 release examples?” |
| **Monitoring** | Production quality tracking | Catch cost spikes, latency issues, bad generations, model regressions |

Braintrust’s eval workflow is: iterate in playgrounds, promote good configs to experiments, automate evals in CI/CD, score production traces, then feed useful production examples back into datasets. citeturn743355view1

## How I’d use it for Jovie

### 1. Start with one Jovie AI feature

Pick a narrow feature first. Good first candidates:

- **Playlist pitch generator**
- **Release launch plan generator**
- **Fan-path recommendation**
- **Presave CTA generator**
- **Artist profile enrichment**
- **AI artist-manager chat response**

Avoid starting with “all of Jovie’s AI.” Start with one repeatable task where bad output is obvious.

## 2. Create the prompt in Braintrust

You’re currently on Braintrust’s **Create prompt** page inside the Jovie project. For the first prompt, I’d create something like:

```text
Name: Playlist Pitch Generator
Slug: playlist-pitch-generator
```

Use Mustache variables such as:

```text
{{artist_name}}
{{release_title}}
{{genre}}
{{mood}}
{{similar_artists}}
{{release_context}}
{{target_playlist_type}}
```

Braintrust prompts can be called directly from application code by slug, and input values map into prompt variables such as `{{text}}`. Braintrust also says UI prompt changes can affect production behavior without redeploying, so this should be used carefully with versioning/review discipline. citeturn743355view2

## 3. Build a dataset of real Jovie examples

Create a dataset with 25–100 real or representative release examples:

```json
{
  "input": {
    "artist_name": "Example Artist",
    "release_title": "Midnight Signal",
    "genre": "melodic house",
    "mood": "dark, emotional, club-ready",
    "similar_artists": ["Lane 8", "Ben Böhmer"],
    "goal": "playlist pitch"
  },
  "expected": {
    "qualities": [
      "specific to the artist",
      "no fake claims",
      "playlist-relevant",
      "under 120 words",
      "clear positioning"
    ]
  },
  "metadata": {
    "use_case": "playlist_pitch",
    "genre": "electronic"
  }
}
```

Braintrust datasets are versioned collections of test cases used for repeatable evaluations, and each record can include `input`, optional `expected`, `metadata`, and `tags`. citeturn743355view4

## 4. Define scorers

For Jovie, scorers should measure business quality, not abstract “helpfulness.”

Good starter scorers:

| Scorer | Type | What it catches |
|---|---|---|
| **No hallucinated facts** | LLM judge / rules | Claims about streams, labels, syncs, press, or playlist support that were never provided |
| **Uses release metadata** | LLM judge | Generic outputs that ignore genre, mood, artist, or catalog data |
| **Valid JSON** | Code scorer | Broken structured output |
| **Length limit** | Code scorer | Pitches that are too long |
| **Actionability** | LLM judge | Vague advice instead of concrete next steps |
| **Brand/tone fit** | LLM judge / human review | Whether it sounds like Jovie’s product voice |

Braintrust evaluations have three parts: data, the task being evaluated, and scores that measure quality using built-in autoevals, LLM-as-judge scorers, or custom code. citeturn743355view1

## 5. Use Playgrounds before shipping

Use **Playgrounds** to test prompt variants, models, parameters, tools, and datasets side by side. This is where you compare:

- GPT-4.1 vs GPT-4.1 mini vs Claude
- strict JSON prompt vs natural language prompt
- short rubric vs detailed rubric
- high creativity vs low temperature

Braintrust Playgrounds are browser-based workspaces for iterating on prompts, models, scorers, and datasets, including real-time evals and side-by-side comparison. citeturn743355view5

## 6. Promote the best version to an Experiment

Once the playground output looks good, run an **Experiment**. That gives you a frozen record of:

- prompt version
- model
- parameters
- dataset version
- scores
- examples that passed/failed

Braintrust experiments are immutable comparable records of eval runs, and they can be run from code or the UI and integrated into CI/CD to catch regressions before production. citeturn743355view1

## 7. Log production AI calls

Once Jovie users interact with the feature, send AI traces into Braintrust. For every generation, log:

- user/account/artist ID metadata
- release ID
- prompt slug/version
- model
- input
- output
- tool calls
- cost
- latency
- user feedback, if available

Braintrust’s observability captures requests as traces you can view, filter, and analyze, and production logs can become evaluation datasets. citeturn743355view3

## 8. Feed failures back into evals

When production logs show bad behavior, convert those examples into dataset rows.

Examples:

- The model invented playlist placements.
- The pitch sounded generic.
- The release plan ignored release date timing.
- The output failed JSON parsing.
- The recommendation was irrelevant to the genre.
- The model gave advice that conflicts with Jovie’s product flow.

That creates a compounding loop: **production failure → dataset example → eval → prompt/model fix → regression protection**.

## 9. Add human review for subjective quality

For music and artist-facing workflows, automated scoring will miss nuance. Use human review for:

- pitch quality
- taste level
- genre accuracy
- artist tone
- commercial usefulness
- whether the recommendation feels credible

Braintrust supports structured human judgment on production traces, experiments, and dataset rows to build ground truth, validate automated scores, curate logs into datasets, and track quality over time. citeturn743355view7

## The simplest first Jovie setup

I’d set up Braintrust in this order:

1. **Prompt:** `playlist-pitch-generator`
2. **Dataset:** 50 release examples across genres
3. **Scorers:** hallucination, metadata use, length, valid structure, actionability
4. **Playground:** compare 2–3 prompt/model variants
5. **Experiment:** save the best version
6. **Production logging:** trace every generated pitch
7. **Review loop:** add bad outputs back into the dataset weekly

## Practical takeaway

Braintrust is useful for Jovie because your product quality depends on AI outputs being **specific, accurate, useful, and repeatable**. It gives you the system to answer:

- “Did this prompt actually improve?”
- “Which model gives the best output per dollar?”
- “What are users seeing in production?”
- “Where is the AI hallucinating?”
- “Can we catch regressions before shipping?”
- “Which real user failures should become tests?”

For Jovie, Braintrust should become the operating system for AI quality control: prompts, evals, production traces, scoring, and continuous improvement in one place.


**Topic:** [[chatgpt-clusters/jovie_music]]
