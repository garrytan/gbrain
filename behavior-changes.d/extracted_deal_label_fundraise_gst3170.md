---
kind: fix
---
Fundraising amounts the conversation fact extractor labels with a round or deal name (seed_round, series_a, round_size, deal_amount_usd and similar) are now stored under the fundraise metric, so one deal's amounts share one tag. Valuation, share price, cap, ownership, count, runway, loan, interest and target labels are never folded, and labels written in a page's Facts fence are kept as written. Facts already stored keep their labels.
