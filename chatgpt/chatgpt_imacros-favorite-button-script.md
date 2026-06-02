---
title: "iMacros Favorite Button Script"
type: note
created: 2023-02-06
updated: 2023-02-06
source: chatgpt-export
conversation_id: de1b5247-c1e6-49db-b551-7cf5469ba7c9
message_count: 2
tags: [chatgpt, import, code]
---
# iMacros Favorite Button Script

> Conversation ID: de1b5247-c1e6-49db-b551-7cf5469ba7c9
> Created: 2023-02-06T23:40:31Z
> Updated: 2023-02-06T23:40:31Z
> Messages: 2

---

## User

write an i macros script that will go to
https://beta.meetme.com/#live/search/nearby/ALL
and click the first item that has favorite as the text. for example:
<div class="tmg-live-video-feed-favorite-button"><i class="material-icons">star</i>favorite</div>
if the item has the text "favorited" it should not be clicked.


---

## Assistant

Here's an iMacros script that will navigate to the specified URL and click the first item that has "favorite" as the text:

```
URL GOTO=https://beta.meetme.com/#live/search/nearby/ALL
SET !TIMEOUT_STEP 1
TAG POS=1 TYPE=DIV ATTR=CLASS:"tmg-live-video-feed-favorite-button" EXTRACT=TXT
SET !VAR1 EVAL("'{{!EXTRACT}}' == 'favorite' ? 'YES' : 'NO'")
SET !TIMEOUT_STEP 2
TAG POS=R1 TYPE=DIV ATTR=CLASS:"tmg-live-video-feed-favorite-button"&&TXT:favorite
TAG POS=R1 TYPE=I ATTR=CLASS:"material-icons"
TAG POS=R1 TYPE=I ATTR=CLASS:"material-icons"&&TXT:star
WAIT SECONDS=1
TAG POS=R1 TYPE=I ATTR=CLASS:"material-icons"&&TXT:star CONTENT=EVENT:MOUSEDOWN
TAG POS=R1 TYPE=I ATTR=CLASS:"material-icons"&&TXT:star CONTENT=EVENT:MOUSEUP
IF !VAR1 == "NO" GOTO END
```

This script sets a timeout of 1 second for the first `TAG` command, which is used to extract the text of the first item with the specified class. The script then sets a timeout of 2 seconds for all subsequent `TAG` commands. If the extracted text is not "favorite", the script jumps to the `END` label, skipping the remaining commands.


## See Also
- [[chatgpt/chatgpt_material-icon-favorite-button]]
- [[chatgpt/chatgpt_animation-script-expression]]
- [[chatgpt/chatgpt_bind-input-value-to-content-script]]
- [[chatgpt/chatgpt_branch-cinematic-demo-script]]
- [[chatgpt/chatgpt_brief-summary-script-request]]
