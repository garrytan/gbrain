---
title: "County ZIPs Regex: NJ"
type: note
created: 2024-05-05
updated: 2024-05-05
source: chatgpt-export
conversation_id: c2abaad4-d36e-497f-b3e1-2d9a89d5c5a0
message_count: 5
tags: [chatgpt, import, code]
---
# County ZIPs Regex: NJ

> Conversation ID: c2abaad4-d36e-497f-b3e1-2d9a89d5c5a0
> Created: 2024-05-05T22:42:20Z
> Updated: 2024-05-05T22:42:44Z
> Messages: 5

---

## User

Contains("077, 087", [Zip]) 

i need an expression like this that covers all zip codes in monmouth county nj and ocean county nj

---

## Assistant

To create an expression that matches zip codes specifically for Monmouth and Ocean counties in New Jersey, you would want to use a pattern that covers their ranges. Here's a suitable regular expression:

```regex
(07[789]\d{2})|(08[5789]\d{2})
```

### Explanation:
- **07[789]\d{2}:** Matches zip codes starting with 077 or 078 (Monmouth County)
- **08[5789]\d{2}:** Matches zip codes starting with 085, 087, 088, and 089 (Ocean County)

This pattern will cover both counties' zip code ranges effectively.

---

## Assistant

For Monmouth County and Ocean County in New Jersey, the ZIP codes range primarily between `077xx` for Monmouth County and `087xx` for Ocean County. To write a regular expression that matches any ZIP codes in these areas, you can use the following pattern:

```regex
^(077|087)\d{2}$
```

This expression checks for strings that start with "077" or "087" followed by any two digits, which covers all ZIP codes in the requested counties.

---

## User

its for alteryx data

---

## Assistant

If you're using Alteryx to filter data based on zip codes from Monmouth and Ocean counties, you can achieve this using the `Contains` function combined with logical operators. The idea is to check whether the zip codes start with the relevant prefixes ("077" or "087") and filter them accordingly.

1. **Formula Tool**: If you want to create a flag column or modify existing data, use the Formula tool with this expression:
   ```alteryx
   Contains([Zip], "077") OR Contains([Zip], "087")
   ```
   This will return `True` or `False` depending on whether the zip code starts with either prefix.

2. **Filter Tool**: If you just want to filter data directly:
   - Place a Filter tool.
   - Use this expression in the `Basic Filter`:
   ```alteryx
   [Zip] LIKE "077*" OR [Zip] LIKE "087*"
   ```

This method ensures that only zip codes starting with "077" or "087" will pass through the filter.
