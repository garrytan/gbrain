---
kind: fix
---
A fact or take the write gate holds for your review now stays held when its page is renamed, and a different page that takes the old name does not inherit it. Releasing a held fact publishes it on the page it was held for, under that page's current name, and is refused when that page no longer exists. On upgrade, existing held writes are matched to their page; any that cannot be matched to one page stay held for every page they could belong to and are listed by gbrain doctor as write_gate_hold_ambiguous, so you can review and drop them with gbrain trust review.
