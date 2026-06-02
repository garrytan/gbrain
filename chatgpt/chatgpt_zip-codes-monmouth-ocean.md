---
title: "Zip Codes: Monmouth & Ocean."
type: note
created: 2024-05-05
updated: 2024-05-05
source: chatgpt-export
conversation_id: 5507b101-e920-4fa1-b408-ca8dcae8d658
message_count: 8
tags: [chatgpt, import, code]
---
# Zip Codes: Monmouth & Ocean.

> Conversation ID: 5507b101-e920-4fa1-b408-ca8dcae8d658
> Created: 2024-05-05T22:40:41Z
> Updated: 2024-05-05T22:41:46Z
> Messages: 8

---

## User

please modify this to only include zip codes for monmouth county nj and ocean county nj

Contains("08861, 08862", [Zip])

---

## Assistant

Contains("077XX, 087XX", [Zip])

---

## User

does this cover all zips for both counties?

---

## Assistant

The expression "Contains("077XX, 087XX", [Zip])" covers zip codes for Monmouth County (starting with 077) and Ocean County (starting with 087). However, it doesn't include all possible zip codes within these counties. For a more comprehensive coverage, you might need to expand the range or include additional zip codes.

---

## User

please give me an expression to cover all

---

## Assistant

To cover all zip codes for Monmouth County, NJ, and Ocean County, NJ, you can use the following expression:

```python
Contains("077, 087", [Zip]) 
```

---

## User

does this cover all? does it cover any outside those counties?

---

## Assistant

The expression "Contains("077, 087", [Zip])" will match any zip code that starts with "077" or "087", which covers all zip codes for Monmouth County, NJ (starting with "077"), and Ocean County, NJ (starting with "087"). It will not match zip codes outside of these counties because it specifically looks for these prefixes.


## See Also
- [[chatgpt/chatgpt_monmouth-county-nj-zip-codes]]
- [[chatgpt/chatgpt_alteryx-filter-zip-codes]]
- [[chatgpt/chatgpt_bodyspec-discount-codes]]
- [[chatgpt/chatgpt_cinematic-ocean-in-capture-one]]
- [[chatgpt/chatgpt_clear-discount-codes]]
