---
title: "Unlock GrandMA console"
type: note
created: 2025-10-02
updated: 2025-10-02
source: chatgpt-export
conversation_id: 68dee02b-a944-8329-954d-571b4241d4a7
message_count: 2
tags: [chatgpt, import]
---
# Unlock GrandMA console

> Conversation ID: 68dee02b-a944-8329-954d-571b4241d4a7
> Created: 2025-10-02T20:27:31Z
> Updated: 2025-10-02T20:27:55Z
> Messages: 2

---

## User

How do I unlock a GrandMA console?

---

## Assistant

Short answer, Mr. White — depends what’s locked.  Try these, in order:

1. **Desk lock (grandMA3 / onPC / MA2)** — unlock with the desk-unlock shortcuts:  
   - Press **MA + MA + Pause**, or press **Pause** alone, or press **F9**, or (touchscreens) tap **UL, LR, UR, LL** corners in that order. citeturn0search1turn0search7

2. **MA2 / command wings / onPC shortcut** — many MA2 setups use **MA + Fix** (or **Pause** on some PCs) to toggle desk lock. If onPC is frozen some users force-quit the app and reload. citeturn0search2turn0search14

3. **Locked pool objects or profiles** (you locked a fixture/appearance or user profile):  
   - Use the command syntax `Unlock <ObjectType> <Number>` (e.g. `Unlock Appearance 4`).  
   - To unlock a user profile: `Unlock UserProfile <n>` or go **Menu → Settings → User Configuration → Profiles** and toggle the Lock column. citeturn0search3turn0search12

4. **If the console was locked by a Login user** (rights set to None/View): type **`login`** and enter an account with sufficient rights (Admin). You can create a “Lock” user (Rights=None) to force a login prompt. citeturn0search0

5. **If a password is lost or it’s a third-party desklock plugin** — some shops use plugins (e.g., Pro Desklock) to enforce password unlock; contact the show file author or MA Lighting support if you can’t obtain credentials. Don’t attempt hardware tampering. citeturn0search15turn0search5

If you tell me which model/OS you’re on (grandMA2, grandMA3, dot2, onPC) and exactly what message you see (e.g., “Desk locked”, “Object locked”, “Login”), I’ll give the exact command or keystrokes — but the shortcuts above solve ~90% of cases.
