---
title: "Profiles Directory: Check Manually"
type: note
created: 2024-04-30
updated: 2024-04-30
source: chatgpt-export
conversation_id: 5d23b0da-3235-4343-9cc1-768bc732eaf7
message_count: 8
tags: [chatgpt, import, code]
---
# Profiles Directory: Check Manually

> Conversation ID: 5d23b0da-3235-4343-9cc1-768bc732eaf7
> Created: 2024-04-30T00:07:01Z
> Updated: 2024-04-30T00:15:02Z
> Messages: 8

---

## User

https://app.hellothematic.com/creator/profile/1
https://app.hellothematic.com/creator/profile/2

create a list of all profiles 

---

## Assistant

I can't directly access the full list of profiles from the provided links without browsing capabilities for each individual profile. You would need to manually check each profile or search within the Hello Thematic platform if they offer a directory or search feature for creator profiles.

---

## User

provide a list of urls by incrementing the trailing number

---

## Assistant

Sure, if you want to create a list of URLs by incrementing the trailing number, you can follow a pattern like this:

```
https://app.hellothematic.com/creator/profile/1
https://app.hellothematic.com/creator/profile/2
https://app.hellothematic.com/creator/profile/3
```

You can continue incrementing the number at the end of the URL to access more profiles. This assumes that the profiles are sequentially numbered on the platform. If the numbering is not sequential, some numbers may not correspond to an existing profile.

---

## User

give me 50

---

## Assistant

Here is a list of URLs incrementing from 1 to 50 for the Hello Thematic profiles:

```
https://app.hellothematic.com/creator/profile/1
https://app.hellothematic.com/creator/profile/2
https://app.hellothematic.com/creator/profile/3
https://app.hellothematic.com/creator/profile/4
https://app.hellothematic.com/creator/profile/5
https://app.hellothematic.com/creator/profile/6
https://app.hellothematic.com/creator/profile/7
https://app.hellothematic.com/creator/profile/8
https://app.hellothematic.com/creator/profile/9
https://app.hellothematic.com/creator/profile/10
https://app.hellothematic.com/creator/profile/11
https://app.hellothematic.com/creator/profile/12
https://app.hellothematic.com/creator/profile/13
https://app.hellothematic.com/creator/profile/14
https://app.hellothematic.com/creator/profile/15
https://app.hellothematic.com/creator/profile/16
https://app.hellothematic.com/creator/profile/17
https://app.hellothematic.com/creator/profile/18
https://app.hellothematic.com/creator/profile/19
https://app.hellothematic.com/creator/profile/20
https://app.hellothematic.com/creator/profile/21
https://app.hellothematic.com/creator/profile/22
https://app.hellothematic.com/creator/profile/23
https://app.hellothematic.com/creator/profile/24
https://app.hellothematic.com/creator/profile/25
https://app.hellothematic.com/creator/profile/26
https://app.hellothematic.com/creator/profile/27
https://app.hellothematic.com/creator/profile/28
https://app.hellothematic.com/creator/profile/29
https://app.hellothematic.com/creator/profile/30
https://app.hellothematic.com/creator/profile/31
https://app.hellothematic.com/creator/profile/32
https://app.hellothematic.com/creator/profile/33
https://app.hellothematic.com/creator/profile/34
https://app.hellothematic.com/creator/profile/35
https://app.hellothematic.com/creator/profile/36
https://app.hellothematic.com/creator/profile/37
https://app.hellothematic.com/creator/profile/38
https://app.hellothematic.com/creator/profile/39
https://app.hellothematic.com/creator/profile/40
https://app.hellothematic.com/creator/profile/41
https://app.hellothematic.com/creator/profile/42
https://app.hellothematic.com/creator/profile/43
https://app.hellothematic.com/creator/profile/44
https://app.hellothematic.com/creator/profile/45
https://app.hellothematic.com/creator/profile/46
https://app.hellothematic.com/creator/profile/47
https://app.hellothematic.com/creator/profile/48
https://app.hellothematic.com/creator/profile/49
https://app.hellothematic.com/creator/profile/50
```

---

## User

how can i make a formula for google sheets 

---

## Assistant

To create a formula in Google Sheets to generate a list of URLs incrementing by the trailing number, you can use a formula based on cell manipulation and concatenation. Here’s an example of how you could set it up:

1. Place the base URL in cell A1: `https://app.hellothematic.com/creator/profile/`

2. In cell B1, enter the following formula to start the sequence from 1:
   ```
   =A$1 & ROW()
   ```
   This formula concatenates the base URL with the row number, which starts at 1.

3. Drag the fill handle (small square at the bottom right corner of the cell) down from cell B1 to fill the formula down as far as needed (for example, to B50).

This will generate URLs from "https://app.hellothematic.com/creator/profile/1" to "https://app.hellothematic.com/creator/profile/50" in the cells B1 to B50. Adjust the range as needed for more or fewer URLs.


## See Also
- [[chatgpt/chatgpt_model-agencies-directory]]
- [[chatgpt/chatgpt_seo-playlist-directory-tips]]
- [[chatgpt/chatgpt_accessibility-contrast-check]]
- [[chatgpt/chatgpt_ai-driven-artist-profiles]]
- [[chatgpt/chatgpt_altman-openai-salary-fact-check]]
