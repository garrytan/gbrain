---
title: "Zip Codes: Monmouth & Ocean."
type: note
created: 2024-05-05
updated: 2024-05-05
source: chatgpt-export
topic: misc
message_count: 8
tags: [chatgpt, knowledge, misc]
---
# Zip Codes: Monmouth & Ocean.

> **Source:** ChatGPT conversation
> **Date:** 2024-05-05T22:40:41Z
> **Messages:** 8
> **Topic:** misc

## Question

please modify this to only include zip codes for monmouth county nj and ocean county nj

Contains("08861, 08862", [Zip])

## Answer

Contains("077XX, 087XX", [Zip])

## Question

does this cover all zips for both counties?

## Answer

The expression "Contains("077XX, 087XX", [Zip])" covers zip codes for Monmouth County (starting with 077) and Ocean County (starting with 087). However, it doesn't include all possible zip codes within these counties. For a more comprehensive coverage, you might need to expand the range or include additional zip codes.

## Question

please give me an expression to cover all

## Answer

To cover all zip codes for Monmouth County, NJ, and Ocean County, NJ, you can use the following expression:

```python
Contains("077, 087", [Zip]) 
```

## Question

does this cover all? does it cover any outside those counties?

## Answer

The expression "Contains("077, 087", [Zip])" will match any zip code that starts with "077" or "087", which covers all zip codes for Monmouth County, NJ (starting with "077"), and Ocean County, NJ (starting with "087"). It will not match zip codes outside of these counties because it specifically looks for these prefixes.
