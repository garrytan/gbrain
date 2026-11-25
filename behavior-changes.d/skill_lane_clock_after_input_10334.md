---
kind: fix
---
The skill resolver's hook lane now starts a turn's 50 ms clock after it has read the hook's input, not as soon as its worker thread loads. Hermes pipes its whole conversation history to the hook, and a long session's history could still be arriving when the clock started, so those turns timed out with no skill suggestions. Loading the worker and reading the input now share the existing 250 ms start bound; a turn whose input does not arrive within it still ends with no output, as before.
