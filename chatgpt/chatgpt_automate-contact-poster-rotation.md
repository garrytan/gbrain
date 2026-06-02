---
title: "Automate Contact Poster Rotation"
type: note
created: 2025-05-23
updated: 2025-05-23
source: chatgpt-export
conversation_id: 683104ac-441c-8007-843b-8530283a379c
message_count: 4
tags: [chatgpt, import]
---
# Automate Contact Poster Rotation

> Conversation ID: 683104ac-441c-8007-843b-8530283a379c
> Created: 2025-05-23T23:28:44Z
> Updated: 2025-05-23T23:30:46Z
> Messages: 4

---

## User

Yo bro, so I have like 17,000 photos of baby kicks that I have set as contact posters on my iOS device. But like, I want to change them all the time because like, I get sick of the same thing. Is there a way I can automate that using like shortcuts or something on iOS?

---

## Assistant

Mr. White, you can absolutely automate rotating your Contact Poster using the Shortcuts app on iOS. Here’s the quickest way:

1. **Prepare your photos**  
   • In the Photos app, create a dedicated album (e.g. “Baby Kicks”).  

2. **Build the “Rotate Poster” shortcut**  
   - Open Shortcuts → **My Shortcuts** → “+” → **Add Action**  
   - **Photos** → *Get Photos from Album* → choose “Baby Kicks”  
   - **Scripting** → *Get Random Item from List*  
   - **Contacts** → *Set Contact Photo* → choose the contact(s) and select “Poster” as the photo type  
   - Tap **Done** and name it “Rotate Poster” citeturn1search0  

3. **Create a Personal Automation**  
   - In Shortcuts, switch to the **Automation** tab → “+” → **Create Personal Automation**  
   - Select **Time of Day** (or another trigger, e.g. “When App Opens”) → set your frequency (hourly, daily, etc.)  
   - Tap **Next** → **Add Action** → **Run Shortcut** → pick “Rotate Poster”  
   - Disable **Ask Before Running** → **Done** citeturn0search5  

Now Shortcuts will pick a random “Baby Kicks” image and set it as your contact’s poster automatically on your chosen schedule.

---

## User

What if I already have contact posters created and I just want to rotate through the ones created?

---

## Assistant

Mr. White, since Shortcuts can’t grab past posters straight from Contacts, you’ll need to have all your poster images in a Photos album (if you haven’t already, open each poster in Contacts, tap Edit → Long-press the image → Save to Photos, then group them in an album called, say, “Posters”).

Then update your “Rotate Poster” shortcut like this:

1. **Fetch your posters**  
   – Action: **Get Photos from Album** → Album: “Posters”  

2. **Pick the next image (sequentially)**  
   – Action: **Get File** → File: `/Shortcuts/posterIndex.txt` (create this in iCloud Drive with “1” inside)  
   – Action: **Get Contents of File** → **Get Number** → → `oldIndex`  
   – Action: **Get Variable** → `Photos` (the list from step 1) → **Count** → `total`  
   – Action: **Calculate** → Formula: `(oldIndex mod total) + 1` → `newIndex`  
   – Action: **Get Item from List** → List: `Photos`, Index: `newIndex` → `nextPoster`  
   – Action: **Set Contact Photo** → Contact: [your contact], Photo Type: Poster, Photo: `nextPoster`  
   – Action: **Save File** → File: `/Shortcuts/posterIndex.txt`, Text: `newIndex`  

3. **Automate it**  
   – Shortcuts → **Automation** → **Create Personal Automation** → Trigger: Time of Day (hourly/daily) → **Add Action**: Run Shortcut “Rotate Poster” → Disable “Ask Before Running.”

Each time it runs, it updates the index and sets your contact’s poster to the next image in the album. citeturn1view0
