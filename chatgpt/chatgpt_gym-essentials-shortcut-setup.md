---
title: "Gym Essentials Shortcut Setup"
type: note
created: 2025-05-31
updated: 2025-05-31
source: chatgpt-export
conversation_id: 683a7a77-ac60-8007-ad7d-b82704d7e810
message_count: 4
tags: [chatgpt, import]
---
# Gym Essentials Shortcut Setup

**Related:** [[personal_health]]

> Conversation ID: 683a7a77-ac60-8007-ad7d-b82704d7e810
> Created: 2025-05-31T03:41:43Z
> Updated: 2025-05-31T03:42:09Z
> Messages: 4

---

## User

When I go to the gym I bring my gym bag and my toiletry kit and my AirPods and my iPhone. Is there a way to make a shortcut that triggers when I leave for the gym in the morning to check I have everything 

---

## Assistant

Yes, you can use the **Apple Shortcuts app** to create a “Check Gym Essentials” shortcut that runs when you leave for the gym. Here’s how:

### ✅ Step-by-Step: Create a Gym Essentials Checklist Shortcut

1. **Open the Shortcuts app** on your iPhone.
2. Tap **Automation** → **+** → **Create Personal Automation**.
3. Choose **Time of Day** → set it for when you usually leave for the gym (e.g., 11:00 AM) → **Next**.
4. Tap **Add Action** → search for **"Show Checklist"** → select **"Choose from List"**.
5. Configure it:
   - **Prompt:** `Do you have everything?`
   - **Items:**
     - Gym bag
     - Toiletry kit
     - AirPods
     - iPhone
   - Enable **Select Multiple**
6. Tap **Next** → Disable **Ask Before Running** if you want it to appear automatically.
7. Tap **Done**.

---

### 🧠 Pro Tip:
If you want it to run **only when you leave home**, choose:
- **Automation trigger:** *Leave Location* → select your home address
- Combine it with a **time filter** (e.g., only between 10 AM–12 PM) to avoid false triggers.

Let me know if you want to include a reminder to bring supplements or Genius shots.

---

## User

They’re all air tagged

---

## Assistant

Perfect. Since all your items (gym bag, toiletry kit, AirPods, iPhone) are **AirTagged**, you can automate a **proximity-based check** using the Find My network and a manual Shortcuts checklist.

Unfortunately, **iOS doesn’t yet support triggering shortcuts based on AirTag presence or distance** directly. But here's the best workaround:

---

### 🔁 Workaround: Manual Shortcut with Real-Time AirTag Status

1. **Create a Shortcut** in the **Shortcuts** app:
   - Action 1: **Choose from List** →  
     Prompt: `Check your gym gear`  
     Items:  
     - Gym bag (AirTag)  
     - Toiletry kit (AirTag)  
     - AirPods (Find My-enabled)  
     - iPhone (this device)

   - Action 2: Optional → Add **URLs** to open Find My for manual visual check:
     - `findmy://items` → This opens directly to the Items tab in Find My.

2. **Create an Automation**:
   - Trigger: **Leave Location** → set to your home
   - Add **Time filter** (e.g., only between 9 AM–12 PM)
   - Action: **Run Shortcut**

3. **Toggle "Ask Before Running" ON**, but **disable “Notify When Run”** to avoid clutter.

---

### 🧠 Why This Works:
- The shortcut will pop up as you're leaving home.
- You can tap into Find My to manually verify that each AirTag is still nearby.
- You still get a tactile checklist prompt to make sure you’re not relying solely on proximity.

---

Want a custom version of the shortcut with your actual item names pre-filled? I can write out the full shortcut configuration for you.


**Topic:** [[chatgpt-clusters/personal_health]]


## See Also
- [[chatgpt/chatgpt_accelerator-tracking-setup]]
- [[chatgpt/chatgpt_ai-ops-setup-inquiry]]
- [[chatgpt/chatgpt_ai-setup-instructions]]
- [[chatgpt/chatgpt_alert-setup-for-updates-part1]]
- [[chatgpt/chatgpt_alert-setup-for-updates-part10]]
