---
title: "Tracking Drug Use in HK"
type: note
created: 2025-05-25
updated: 2025-05-25
source: chatgpt-export
conversation_id: 6832d13b-0f74-8007-ba1f-27403e798c5c
message_count: 4
tags: [chatgpt, import]
---
# Tracking Drug Use in HK

> Conversation ID: 6832d13b-0f74-8007-ba1f-27403e798c5c
> Created: 2025-05-25T08:13:47Z
> Updated: 2025-05-25T08:15:04Z
> Messages: 4

---

## User

Is it possible to track my recreational drug use in Apple HealthKit? I'd like to have a record of exact dosages on exact dates so that I can cross-reference it with other data like sleep data and weight data to see how the usage contributes to quality of sleep and how it affects weight loss. And then also I'd like to correlate it with my journal entries to see if I could find any correlation between different drug usages and mood and stuff. And then finally I would like to be able to access it to share with my doctors so they can cross-reference it against other things and ensure no incompatibilities with medications that are prescriptions and such.

---

## Assistant

Mr. White, yes—mostly. Here’s how you can log and correlate your dosages in HealthKit:

1. **Use the built-in Medications feature**  
   - In iOS 16+ Health.app, tap **Browse → Medications → Add Medication**.  
   - Manually enter each recreational drug as a “medication,” specifying name, form (e.g. “powder,” “pill”), exact dosage and time.  
   - Those entries become HealthKit samples you can trend and chart alongside sleep, weight, etc.  

2. **Cross-reference with Sleep and Weight**  
   - In Health.app, go to **Browse → Sleep** (or Weight), enable **Show on Dashboard**.  
   - In **Trends** you’ll see if spikes in your “medication” use line up with poor sleep or weight fluctuations.  

3. **Correlate with journal entries**  
   - Pick a journaling app that writes mood or tags into HealthKit (e.g. Day One with HealthKit integration, or Nomie).  
   - Log mood/tags there; then export both HealthKit and journal data (CSV or XML) and run your own analyses (e.g. in a spreadsheet or Python/R) to spot patterns.  

4. **Share with your doctor**  
   - In Health.app, tap your profile picture → **Export All Health Data**.  
   - You’ll get an XML file (and a ZIP) that contains every timestamped “medication,” sleep, weight, etc.  
   - Send that to your physician—or import into a clinical-grade portal if they support it—so they can cross-check against your prescriptions.  

**Limitations to keep in mind**  
- HealthKit only has “Medication” and a few substance types (alcohol, caffeine, nicotine) built in—there’s no dedicated slot for e.g. psychedelics or stimulants beyond logging them as meds.  
- If you want richer custom data (e.g. blood levels, multiple forms), you’ll need either a third-party tracker that writes custom HealthKit samples or build a simple Shortcut that uses “Add Health Sample” actions.  

With this setup you’ll have precise timestamps and dosages in HealthKit that you can graph against your sleep, weight and—via export—against any other notes or mood logs you keep.

---

## User

What about, um, tracking my trizepatide that I get from Mochi Health? It's compounded trizepatide and I take an injection once a week.

---

## Assistant

Mr. White, you can track your weekly tirzepatide injections just like any other medication in HealthKit:

1. **Add it as a Medication**  
   - Open **Health → Browse → Medications → Add Medication**.  
   - Search “Tirzepatide” (or type “Tirzepatide (Mochi Health)” if it doesn’t auto-complete), set the form to “Injection,” enter your per-dose amount (e.g. “2.5 mg”) and choose “Weekly” as the frequency.  
   - This gives you both scheduled reminders and timestamped logs whenever you mark a dose as taken.

2. **Log each injection**  
   - When you inject, open **Health → Medications**, tap your tirzepatide entry, then “Log.”  
   - That creates a dated, dosed sample in HealthKit you can chart alongside sleep, weight, etc.

3. **Automate via Shortcuts (optional)**  
   - Create an iOS Shortcut that runs on your injection day—“Add Health Sample” for Medication “Tirzepatide,” quantity “2.5 mg,” date “Current Date.”  
   - You can schedule that Shortcut to run weekly, so you never forget logging.

4. **Correlate & share**  
   - Once logged, your weekly injections appear in **Health → Summary** under Medications.  
   - Export your Health data (Profile → Export All Health Data) to get an XML/ZIP that your doctor can import or review alongside prescriptions.

With that, you’ll have precise dose-by-date records for tirzepatide in HealthKit—fully integrated with your sleep, weight, and any third-party journal entries you import.
