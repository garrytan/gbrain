# 09 — RULER: What’s the Real Context Size of Your Long-Context Language Models?

**Source:** [RULER: What’s the Real Context Size of Your Long-Context Language Models?](https://arxiv.org/abs/2404.06654v3).
**Type/version:** COLM work; archived arXiv revision; arXiv v3 (header date 2024-08-06); COLM 2024 conference version.

RULER is a useful counterweight to claims based on a single “needle in a haystack”
retrieval test. It evaluates 17 long-context models on 13 synthetic tasks spanning
retrieval, multi-hop tracing, aggregation, and question answering; each task/length
configuration uses 500 generated examples at 4K–128K tokens (§4). Scores are averaged
across all 13 tasks, and “effective length” is defined against Llama2-7B’s 85.6% score
at 4K (Table 3). The authors find that models can look nearly perfect on vanilla
passkey/NIAH retrieval yet degrade substantially on more complex tasks as contexts grow;
about half of models meet the authors’ chosen satisfactory-performance threshold at 32K
(Abstract; §4.3). In a stress test of Yi-34B up to 256K, increasing distractor needles
reduces accuracy by roughly 40 points in the extreme full-distractor condition (§5).
This suggests that locating an isolated fact is not the same capability as correctly
using evidence amid distractors or aggregating multiple facts.

RULER’s inputs are synthetic, not conversational; its threshold is a chosen proxy and
cannot establish user-facing quality. It does not contradict the possibility that
retrieved evidence helps; it warns that success on simple retrieval can overstate robust
evidence use. GBrain should measure both answer accuracy and evidence-grounded behavior
under realistic conversational distractors, while treating needle-style checks as only
one test tier.

[Citation and verified support](../sources/09-ruler.md) ·
[Compendium](../compendium.md) · [Index](../index.md)
