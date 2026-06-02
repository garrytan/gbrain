---
title: "iMacros Macro Command"
type: note
created: 2023-02-07
updated: 2023-02-07
source: chatgpt-export
conversation_id: b0ea2d0a-8fbd-49a7-8f54-b85bcdd68410
message_count: 4
tags: [chatgpt, import, code]
---
# iMacros Macro Command

> Conversation ID: b0ea2d0a-8fbd-49a7-8f54-b85bcdd68410
> Created: 2023-02-07T00:02:35Z
> Updated: 2023-02-07T00:02:35Z
> Messages: 4

---

## User

VERSION BUILD=1011 RECORDER=CR

FRAME F=2

TAG POS={{!LOOP}} TYPE=DIV ATTR=TXT:starfavorite



---

## Assistant

This is a macro command for the web automation tool iMacros. It specifies a loop command (`!LOOP`) that will repeat the following steps for a certain number of times. The specific step it will perform is to search for a `<div>` element with the text "starfavorite", and interact with it as if it is a "TAG" (most likely clicking on it). The "POS" attribute specifies the position of the element among other similar elements on the page. The "TYPE" attribute specifies the type of HTML element to interact with, in this case a "DIV". The "ATTR" attribute specifies the attribute of the element used for identifying it, in this case the "TXT" attribute with a value of "starfavorite".

---

## User

modify this so if the element isnt found it keeps going

---

## Assistant

You can modify the macro command to handle the scenario where the element is not found on the page by adding the following line before the `TAG` command:

```
SET !ERRORIGNORE YES
```

This will tell iMacros to ignore errors and continue running the macro even if the element is not found on the page. The modified macro command will look like this:

```
VERSION BUILD=1011 RECORDER=CR
FRAME F=2
SET !ERRORIGNORE YES
TAG POS={{!LOOP}} TYPE=DIV ATTR=TXT:starfavorite
```
