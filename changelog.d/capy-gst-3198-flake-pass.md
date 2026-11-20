**Sonnet 5.5 cache reads are priced at $0.10 per million tokens, and a llama.cpp or Ollama "exceeds the available context size" error now counts as an input that is too large.**

### Fixed
- Cost estimates, `--max-cost` checks and spend receipts priced Claude Sonnet 5.5 cache reads at $0.20 per million tokens, twice Anthropic's $0.10 rate. Reported in #9775 by @Masashi-Ono0611.
- When a local model served by llama.cpp or Ollama refused a page because it did not fit the model's context, the error was treated as a new failure on every run. With a few large pages first in line, phases such as `propose_takes` stopped after five failures in a row. That error is now recorded once as `request_too_large`, like the same refusal from OpenAI or Anthropic. Reported in #9764 by @Solusan.
- The TLA+ model checks no longer hang now and then. TLC's disk-backed state queue can lose its writer thread and stop for good (tlaplus/tlaplus#1403). The checks now keep up to a million queued states in memory, so the specs checked on every pull request never use that writer.
- The Windows test for hidden console windows no longer fails at cleanup when Windows still holds the compiled test program open for a moment after it exits.
