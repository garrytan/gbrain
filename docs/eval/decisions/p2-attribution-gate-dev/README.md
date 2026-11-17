# Speaker attribution: the facts-lane gate (dev)

This gate decides whether attribution storage is built. Its question: do answers from saved facts trail answers
from pages on questions about what the assistant said? It ran on the baseline extractor (build 5bd9e8497, no
attribution setting) with the 30 LongMemEval-S single-session-assistant questions the decision kit selects with
seed 42 (development split). The same fixed reader (the benchmark's pinned reader and judge) answered twice:
once from the top five retrieved sessions (pages), and once from the saved facts of those sessions. The facts
come from foresights's conversation-facts extractor on dated conversation pages.

| Answer source | Score | Context |
|---|---|---|
| Pages (raw sessions) | 100.0% | about 13,200 tokens |
| Saved facts | 26.7% | about 27 facts |

The deficit is 73.3 points (95% bootstrap CI −90 to −57). Saved facts lost on 22 questions and won on none.
The deficit far exceeds the 5-point threshold, so attribution storage is in scope.

The cause shows directly in the stored facts. The baseline extractor keeps the user's side of the conversation
and drops what the assistant said. For the questions saved facts answered wrong, the gold sessions held facts
such as "User is interested in budget-friendly hostels in Amsterdam" and no fact about the hostel the assistant
recommended. Of 7,110 saved facts, 53 mention the assistant. Dev spend was $17.76.
