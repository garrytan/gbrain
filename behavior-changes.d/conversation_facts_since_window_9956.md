---
kind: fix
---
gbrain extract-conversation-facts --since T --segment-limit N now keeps the facts it extracted on a page that already has extractor facts. Before, a run that started from --since and was stopped early by --segment-limit counted as partial, and a partial run publishes only its bookkeeping rows over a page's existing facts, so the facts the run had just paid for were thrown away. Such a run now counts as a window, so its facts are added beside the earlier ones and nothing earlier is retired. A run cut short from the page's first segment still publishes nothing over the existing facts.
