---
title: "Stop AI scope creep"
type: note
created: 2025-11-03
updated: 2025-11-03
source: chatgpt-export
conversation_id: 69090986-1440-832e-945b-2383ff76bd22
message_count: 2
tags: [chatgpt, import, code]
---
# Stop AI scope creep

> Conversation ID: 69090986-1440-832e-945b-2383ff76bd22
> Created: 2025-11-03T19:59:13Z
> Updated: 2025-11-03T19:59:37Z
> Messages: 2

---

## User

For log your body claude code keeps trying to add features i dont want.

---

## Assistant

Sounds like you’re getting hit with AI scope creep, Mr. White 😅  

Here’s how to stop it from “helpfully” adding stuff to *Log Your Body*.

---

### 1. Give it a **hard scope box**

When you start a session, put something like this at the top (system or first message):

> You are modifying a project called **Log Your Body**.  
> Its scope is:  
> - Track body metrics (weight, body fat %, date, optional notes).  
> - Store data locally (e.g. JSON/CSV/SQLite).  
> - Provide simple commands: add entry, list entries, maybe basic stats (min/avg/max).  
>   
> **YOU MUST NOT ADD:**
> - Any new features not in the list above.  
> - Any analytics, graphs, charts, predictions, recommendations, or integrations.  
> - Any UI beyond simple text/CLI interaction.  
>   
> If the user asks for something outside this scope, reply:  
> “That’s outside the current scope of Log Your Body.”

LLMs respond much better when you explicitly say **“must not add”** and give examples of forbidden things.

---

### 2. Force it to confirm scope before coding

Ask it to **repeat the allowed features** before it writes code:

> Before writing any code, list the features you will implement in bullet points and explicitly confirm you will not add anything else.

If it lists more than you want, you can just reply “remove X/Y/Z.”

---

### 3. Only let it fill in marked areas

If you already have a file, tell it:

> Only edit code between:
> `// BEGIN EDITABLE` and `// END EDITABLE`  
> Do not create new files or new features. Do not modify code outside these markers.

Then wrap the parts you actually want changed:

```python
# BEGIN EDITABLE
def add_entry(...):
    # TODO: implement
    pass
# END EDITABLE
```

This drastically reduces “creative” feature additions.

---

### 4. Make it justify any new function

You can add:

> If you introduce a new function, class, or file, you must:  
> - Explain why it is required **for the existing agreed scope**,  
> - And ask for explicit approval before proceeding.  
> If unsure, do not add it.

That way, if it tries to invent stuff, you get a chance to say no.

---

### 5. If you want, we can lock the design here

If you paste your current Log Your Body spec or code, I can:

- Strip it down to the **exact** features you want, and  
- Give you a ready-to-paste “do not add features” prompt tailored to that codebase.  

You can then reuse that with Claude (or with me) and keep the project tight.
