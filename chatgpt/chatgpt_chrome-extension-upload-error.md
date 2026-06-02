---
title: "Chrome Extension Upload Error"
type: note
created: 2023-02-24
updated: 2023-02-24
source: chatgpt-export
conversation_id: 03d77abd-4527-445a-b55c-644cdcc531b8
message_count: 2
tags: [chatgpt, import, code]
---
# Chrome Extension Upload Error

**Related:** [[coding_troubleshoot]]

> Conversation ID: 03d77abd-4527-445a-b55c-644cdcc531b8
> Created: 2023-02-24T03:01:33Z
> Updated: 2023-02-24T03:01:33Z
> Messages: 2

---

## User

Run chrome-webstore-upload upload --client-id *** --client-secret *** --refresh-token *** --source chrome-extension-.zip --extension-id <extension id her>
  chrome-webstore-upload upload --client-id *** --client-secret *** --refresh-token *** --source chrome-extension-.zip --extension-id <extension id her>
  shell: /usr/bin/bash -e {0}
  env:
    EXTENSION_ID: <extension id her>
/home/runner/work/_temp/322a2473-a029-49c7-ac4e-08944f31a1fb.sh: line 1: syntax error near unexpected token `newline'
Error: Process completed with exit code 2.

---

## Assistant

It looks like there may be a syntax error in the command you are trying to run. Specifically, the command appears to be split into two lines with a newline character between them, which is causing the syntax error.

To fix this, you should make sure that the command is entered on a single line without any extra characters, such as newlines or spaces. It should look something like this:

```
chrome-webstore-upload upload --client-id *** --client-secret *** --refresh-token *** --source chrome-extension-.zip --extension-id <extension id here>
```

Make sure to replace the `<extension id here>` placeholder with the actual extension ID for your extension.

If you continue to have issues, please provide more information about the context in which you are trying to run this command and any error messages or output you are seeing.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]


## See Also
- [[chatgpt/chatgpt_file-upload-error-troubleshoot-part1]]
- [[chatgpt/chatgpt_file-upload-error-troubleshoot-part2]]
- [[chatgpt/chatgpt_large-file-upload-error]]
- [[chatgpt/chatgpt_remote-extension-error-fix]]
- [[chatgpt/chatgpt_chrome-extension-function-location]]
