---
kind: fix
---
gbrain facts relink no longer changes a linked fact's trust tier or write origin, and no longer rounds its valid_from and valid_until to the second; the entity page's facts table keeps the stored instant to the millisecond. A fact whose stored instant is finer than a millisecond (only raw SQL or a database clock default writes one) is now left unlinked and counted claim_unfenceable instead of being linked with rounded dates. Facts linked before this release keep the dates they have.
