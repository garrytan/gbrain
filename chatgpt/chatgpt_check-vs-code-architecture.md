---
title: "Check VS Code architecture."
type: note
created: 2023-05-07
updated: 2023-05-07
source: chatgpt-export
conversation_id: 33e99678-e8eb-49e8-a160-40f22d5cf4ca
message_count: 2
tags: [chatgpt, import]
---
# Check VS Code architecture.

> Conversation ID: 33e99678-e8eb-49e8-a160-40f22d5cf4ca
> Created: 2023-05-07T00:05:45Z
> Updated: 2023-05-07T00:05:55Z
> Messages: 2

---

## User

how cna i tell if my vs code is intel or apple silicon

---

## Assistant

To determine if your VS Code installation is built for Intel or Apple Silicon, you can follow these steps:

1. Launch VS Code on your macOS device.
2. Open the Activity Monitor. You can do this by searching for "Activity Monitor" in Spotlight or locating it in the "Applications/Utilities" folder.
3. In the Activity Monitor, locate the running VS Code process.
4. Select the process and click on the "i" button in the top toolbar, or right-click on the process and choose "Get Info."
5. In the process information window, you will see a field called "Kind" or "Architecture." This field will indicate whether the application is running as an Intel or Apple Silicon (ARM) binary.

If the "Kind" or "Architecture" field displays "Intel" or "x86_64," it means your VS Code installation is built for Intel-based Macs. If it shows "Apple Silicon," "ARM," or "Apple," then it indicates that your VS Code installation is built natively for Apple Silicon-based Macs.

Please note that as of my knowledge cutoff in September 2021, Microsoft had not released an official Apple Silicon build of VS Code. However, this information might have changed since then, so make sure to keep your VS Code installation updated to the latest version to take advantage of any new developments.


**Topic:** [[chatgpt-clusters/code_review]]
