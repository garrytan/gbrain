---
title: "Task Suggestions Based on Values"
type: essay
created: 2025-05-20
updated: 2025-05-20
source: chatgpt-export
topic: music-production
message_count: 22
tags: [chatgpt, knowledge, music-production]
---
# Task Suggestions Based on Values

> **Source:** ChatGPT conversation
> **Date:** 2025-05-20T01:31:25Z
> **Messages:** 22
> **Topic:** music-production

## Question

{'asset_pointer': 'file-service://file-BrjtszyhuDLfKhfKvjTHqu', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 567, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 123245, 'width': 477}
Help me think about my life and everything you know and suggest tasks for my todo list. Keep in mind that I tag items by the core value that they relate to. You should have my core values in your memory

## Answer

Based on your core values and what I know about your current lifestyle and goals, here are concise suggestions for tasks to add to your to-do list:

- **Automate monthly investment transfer** (#SystemizeEverything)
- **Order car cleaning supplies and first-aid kit** (#TakeControl)
- **Update pricing comparison (Costco vs. Stache)** (#Focus)
- **Draft SOPs for outsourced tasks** (#SystemizeEverything)
- **Research macro-friendly, budget dining alternatives** (#BeConcise)
- **Pack gym bag essentials** (#BeSexy)
- **Schedule quarterly DEXA scan** (#BeSexy)
- **Evaluate potential apartments near Liv** (#LeadWithLove)
- **Review and adjust monthly spending budget** (#TakeControl)
- **Purchase vitamin C supplements for Liv** (#LeadWithLove)
- **Create availability notice for Model Mayhem** (#BeSexy)
- **Check Genius Shot stock and budget** (#StayAlive)
- **Disable Bose Centerpoint in car (for song testing)** (#BeSoGoodTheyCantIgnoreYou)

Feel free to add or adjust according to your immediate priorities!

## Question

Is there a way i can get you to talk to the reminders app on iOS and create these items on my todo list for me

## Answer

Direct integration between ChatGPT and Apple's Reminders app isn't supported right now. However, here's the quickest workaround:

### Fastest workaround (Siri Shortcut):
1. **Open Shortcuts App** on your iPhone.
2. Tap **"+"** to create a new shortcut.
3. Add action: **"Split Text"** (use new lines).
4. Then add action: **"Add New Reminder"** and choose the appropriate Reminders list.
5. Copy and paste the tasks I provided earlier into a single text block.
6. Run the shortcut to instantly add all tasks at once.

### Manual Siri Approach (easiest setup, slower):
Simply say: 
- “Hey Siri, remind me to [task name]”

Then manually tag the tasks afterward.

If you'd like step-by-step help creating the Shortcut, let me know!

## Question

Give me a step by step for creating the shortcut

## Answer

Here's a concise step-by-step guide to creating a Shortcut to quickly add multiple reminders at once on your iPhone:

### Step-by-Step Instructions:
  
1. **Open the Shortcuts App** on your iPhone.

2. Tap the **"+"** in the top-right corner to create a new shortcut.

3. Tap **"Add Action"**.

4. Search and select **"Text"**.
   - Paste your task list here (each task on a new line):
     ```
     Automate monthly investment transfer
     Order car cleaning supplies and first-aid kit
     Update pricing comparison (Costco vs. Stache)
     Draft SOPs for outsourced tasks
     Research macro-friendly, budget dining alternatives
     Pack gym bag essentials
     Schedule quarterly DEXA scan
     Evaluate potential apartments near Liv
     Review and adjust monthly spending budget
     Purchase vitamin C supplements for Liv
     Create availability notice for Model Mayhem
     Check Genius Shot stock and budget
     Disable Bose Centerpoint in car (for song testing)
     ```

5. Tap **"+"** again and search for **"Split Text"**.
   - Set "Split Text" by **New Lines**.

6. Tap **"+"** and add a **"Repeat with Each"** action.

7. Inside the **Repeat with Each** loop, tap **"+"** again and add **"Add New Reminder"**.
   - In "Add New Reminder":
     - Tap "Reminder" and select **"Repeat Item"**.
     - Tap "List" and choose your preferred reminders list.

8. Tap "Next" (top-right corner), name your shortcut clearly, like "Quick Reminders", and tap **Done**.

### How to use the Shortcut:
- Just tap the Shortcut from your Shortcuts app, and it will instantly create reminders for all listed items.

That's it!

## Question

{'asset_pointer': 'file-service://file-WCGY13sLY8EFR3egyBWFQV', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 828, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 655213, 'width': 1351}
Hows this also Can you include the tags



## Answer

Your setup looks good, but you'll need a slight modification to include tags:

### How to add tags to your reminders:

1. In the **"Add Reminder"** action, click on the **Tags** field.
2. Enter the tags corresponding to each item. You have two easy options here:

**Option A (Quick & Easy):**  
Use the same tag (e.g., "#BeSexy") for all tasks:
- Just type your preferred tag directly into the **Tags** field (e.g., `#BeSexy`).

**Option B (Dynamic tags, recommended if you have various tags):**  
Include the tags directly in the task list in the text action, like this:

```
Automate monthly investment transfer #SystemizeEverything
Order car cleaning supplies and first-aid kit #TakeControl
Update pricing comparison (Costco vs. Stache) #Focus
Draft SOPs for outsourced tasks #SystemizeEverything
Research macro-friendly, budget dining alternatives #BeConcise
Pack gym bag essentials #BeSexy
Schedule quarterly DEXA scan #BeSexy
Evaluate potential apartments near Liv #LeadWithLove
Review and adjust monthly spending budget #TakeControl
Purchase vitamin C supplements for Liv #LeadWithLove
Create availability notice for Model Mayhem #BeSexy
Check Genius Shot stock and budget #StayAlive
Disable Bose Centerpoint in car (for song testing) #BeSoGoodTheyCantIgnoreYou
```

Then modify your Shortcut slightly:

- Before your **"Add Reminder"** action:
  - Add the **"Match Text"** action.
  - Set the pattern to `#\w+` (this grabs hashtags).
- In your **"Add Reminder"** action:
  - Set "Reminder" to `Repeat Item`.
  - Set "Tags" to the output from the **"Match Text"** action.

Your Shortcut will now correctly extract tags from each line and assign them automatically.

## Question

{'asset_pointer': 'file-service://file-QZo4mZwo3vAaZemrBhoyum', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 690, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 238427, 'width': 848}
Let me know what im doing wrong

## Answer

You're almost there! You just need to make two quick adjustments:

### **1. Fix the Reminder's Text (remove tags from the task text):**
- Add a **Replace Text** action above your **Add Reminder** action:
  - Select **Replace Text** action.
  - In "Text," select **Repeat Item**.
  - Set "Find text" as the pattern `\s#\w+` (this removes the tags from task text).
  - Leave "Replace With" empty.

Then, in your **Add Reminder** action, set "Reminder" to the output from this **Replace Text** action (instead of Repeat Item).

### **2. Set Tags correctly in Add Reminder action:**
- In your **Add Reminder** action's **Tags** field, select the output from your **Match** action (currently missing).

### Corrected workflow structure:

```
Split Clipboard by New Lines
  Repeat with Each item in Split Text:
    Match "#\w+" in Repeat Item
    Replace Text "\s#\w+" in Repeat Item (Replace with: "")
    Add [Replace Text Output] to Reminders List (Tags: [Match Output])
```

This setup ensures:
- Tasks are created **without** tags in the actual text.
- Tags are properly assigned in the Reminders app.

This will resolve your issue completely!

## Question

{'asset_pointer': 'file-service://file-6tKcT6S4WuHLPiDXC1p7Kc', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 954, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 574117, 'width': 1466}
What do i need to fix

## Answer

You're close! Here's exactly what to fix:

### **1\. Adjust your "Replace Text" action:**
- **Currently:** You have it set to replace `#\w+` with "World" in **Matches**.
- **Fix:** Change "Matches" to **Repeat Item**.  
- **Fix:** Change "World" to an empty field, so tags are just removed and not replaced.

It should look like:

```
Replace #\w+ with [leave blank] in Repeat Item
```

### **Final Workflow should clearly read:**
- **Split Clipboard** by new lines
- **Repeat with each** in Split Text:
  - **Match** `#\w+` in Repeat Item
  - **Replace Text** `#\w+` with [blank] in **Repeat Item**
  - **Add Reminder** using **Updated Text**, assign **Matches** to Tags.

Make this small adjustment, and you're set!

## Question

{'asset_pointer': 'file-service://file-RtHENpaWa5sMpgFZ2Shhv1', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 956, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 583451, 'width': 1468}
its not including the actual reminder just the tag

## Answer

The reason you’re only getting the tag and not the task text is that your **Replace Text** step is stripping the tags out of the **Matches** array**,** rather than out of the original line. That leaves you with nothing in **Updated Text**, so the reminder title ends up empty.

Here’s exactly how to fix it:

1. **Match Tags**  
   ```text
   Match:  #\w+  
   In:     Repeat Item
   ```
   – Output → **Matches**  

2. **Strip Tags from the Original Line**  
   ```text
   Replace:    #\w+  
   With:       (leave blank)  
   In:         Repeat Item        ← **this must be “Repeat Item”**, not “Matches”  
   ```
   – Output → **Updated Text**  

3. **Add the Reminder**  
   - **Reminder (title):** Updated Text  
   - **Tags:** Matches  

So your loop should look exactly like this:  
```
Split Clipboard by New Lines
Repeat with Each item in Split Text
  ├─ Match #\w+ in Repeat Item → Matches
  ├─ Replace #\w+ with (blank) in Repeat Item → Updated Text
  └─ Add [Updated Text] to Reminders List (Tags: [Matches])
End Repeat
```
  
Once you switch your Replace-“in” back to **Repeat Item**, your shortcuts will create each reminder with the cleaned-up task text and attach the hashtag tag correctly.

## Question

{'asset_pointer': 'file-service://file-PyTHPBhuuJRGUvA7tc9FKk', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 956, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 582527, 'width': 1469}
Great but the tag is stil in the output now 

## Answer

Mr. White, the culprit is that your replace isn’t picking up the leading space, and you need to turn on regex mode. Here’s the tweak:

1. **Edit your “Replace Text” action**  
   - Tap **Show More** under it.  
   - Toggle **Regular Expression** on.  
   - Change **Find** to:  
     ```
     \s#\w+
     ```  
   - Leave **Replace With** blank.  
   - Ensure **“In”** is set to **Repeat Item**.

2. **Verify your “Add Reminder”**  
   - Title uses **Updated Text** (the output of Replace).  
   - Tags use **Matches** (from the Match step).

That `\s#\w+` regex will strip “ #BeSexy” (or any #Tag) plus its preceding space, leaving only the clean task text, while your Matches array still feeds the tag field.

## Question

Ok great it works so back to the todolist

## Answer

Here are a few actionable tasks to drop into your list—each tagged by core value:

- Bleach full head with 30-volume developer #BeSexy  
- Wax chest #BeSexy  
- Plan next RP Hypertrophy mesocycle #Focus  
- Schedule CT and PET scan #StayAlive  
- Set up home scale & sync to Health #SystemizeEverything  
- Clean up credit report (Credit Karma) #TakeControl  
- Clone garage-opener code in HomeKit #SystemizeEverything  
- Order vitamin C for Liv #LeadWithLove  
- Whiten teeth with whitening strips #BeSexy

## Question

Give me your suygesttions

## Answer

Mr. White, here are a few more to-dos, each tagged by core value:

- Automate monthly surplus → investment account #SystemizeEverything  
- Order car-bag supplies (trash can, first-aid, wet wipes) #StayAlive  
- Research macro-friendly, budget dining spots #BeConcise  
- Schedule apartment viewings near Liv #LeadWithLove  
- Draft & post Model Mayhem availability notice #BeSexy  
- Plan next mesocycle in RP Hypertrophy app #Focus  
- Meal-prep twice this week at Trader Joe’s #BeSexy  
- Book dental cleaning & whitening strips #StayAlive  
- Set recurring reminder to disable Bose Centerpoint #BeSoGoodTheyCantIgnoreYou  
- Outline SOPs for outsourcing routine tasks #SystemizeEverything  
- Review & adjust monthly budget allocations #TakeControl  
- Ideate 3 Instagram captions for “Never Say A Word” #BestIdeaWins

## Question

Bose counterpoint is done. I use white strips nad have them currently. I dont need to promote snow right now. Were focused on MUFFINTOP and the next priority is finalizing the head design and finding a fabrictor

## Answer

Mr. White, here are your next to-dos—focused on nailing the MUFFINTOP helmet and lining up a fabricator:

- Finalize 3D CAD model with exact dimensions #BeSexy  
- Research & select lightweight, breathable shell materials #StayAlive  
- Compile shortlist of 3–5 helmet fabricators & request quotes #SystemizeEverything  
- Create a detailed tech-pack (measurements, tolerances, vent/vision specs) #SystemizeEverything  
- Schedule prototype fitting & test visibility/comfort #BeSoGoodTheyCantIgnoreYou  
- Review incoming cost estimates & lock in fabrication budget #TakeControl  
- Test airflow & padding layout on initial mock-up #StayAlive  
- Confirm final color, texture, and finish details #BeSexy  
- Map out production timeline with key milestones #Focus  

Let me know if you want to turn any into reminders.
