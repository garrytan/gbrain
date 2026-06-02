---
title: "Untitled Conversation 697"
type: note
created: 2022-12-13
updated: 2022-12-13
source: chatgpt-export
conversation_id: 529ffeed-e9a9-4be0-8c9f-4b709716e3eb
message_count: 2
tags: [chatgpt, import, code]
---
# Untitled Conversation 697

> Conversation ID: 529ffeed-e9a9-4be0-8c9f-4b709716e3eb
> Created: 2022-12-13T18:16:11Z
> Updated: 2022-12-13T18:16:11Z
> Messages: 2

---

## User

Im creating a chrome extension and on the context menu the icon is not showing up but instead showing a deafult jigsaw icon.  I have icons set in my manifest.json file for each size include 16x16 and they are all png. the icons show up fine in the toolbar of the browser just not in the context menu.  What am i doing wrong?

---

## Assistant

It sounds like you might be having an issue with the `manifest.json` file for your Chrome extension. In order to specify icons for your extension, you will need to add a `"icons"` field to your manifest file and specify the path to your icons. The `"icons"` field should be an object that maps different icon sizes to the corresponding paths of your icons. For example:

```
"icons": {
 "16": "icons/icon16.png",
 "32": "icons/icon32.png",
 ...
}
```

Make sure that the paths to your icons are correct and that the icons themselves are valid image files. You can also try using the `chrome://extensions` page to verify that the icons are being correctly loaded for your extension. If you are still having trouble, you can try asking for help on the [Chrome Dev Forum](https://developer.chrome.com/extensions/forum) where there are many experienced developers who can offer advice and assistance.


## See Also
- [[chatgpt/chatgpt_untitled-conversation-1180]]
- [[chatgpt/chatgpt_untitled-conversation-120]]
- [[chatgpt/chatgpt_untitled-conversation-128]]
- [[chatgpt/chatgpt_untitled-conversation-157]]
- [[chatgpt/chatgpt_untitled-conversation-261]]
