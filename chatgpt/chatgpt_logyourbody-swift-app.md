---
conversation_id: 68584fb8-96fc-8007-a44d-98431a2e4b6f
created: 2025-06-22
links:
- '[[chatgpt-clusters/coding_mobile]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: LogYourBody Swift App
type: guide
updated: 2025-06-22
---

# LogYourBody Swift App

**Related:** [[coding_mobile]]

> Conversation ID: 68584fb8-96fc-8007-a44d-98431a2e4b6f
> Created: 2025-06-22T18:47:20Z
> Updated: 2025-06-22T18:48:43Z
> Messages: 4

---

## User

Write a prompt I can give to LovableAIChat to generate the Swift iOS app for LogYourBody. Based on all the features and stuff, you know we need.

---

## Assistant

Certainly, Mr. White. Here’s a concise, copy-and-paste-ready prompt for LovableAIChat:

```
You are to generate a full Swift iOS app called “LogYourBody” using SwiftUI (iOS 16+), with a dark-mode-only aesthetic inspired by Linear. Use MVVM + Combine and CoreData for local storage. Stub out a REST networking layer (URLSession) to sync with our existing LogYourBody web API. Implement:

1. **Authentication**  
   – Email/password + optional Sign in with Apple  
   – Persist tokens securely in Keychain  

2. **Onboarding**  
   – Allow bulk upload of BodySpec Dexa scan PDFs via PHPDFKit  
   – Parse each PDF to extract body fat %, lean mass, bone mass, FFMI, waist-hip ratio, hydration, weight  
   – Show a confirmation screen before saving  

3. **Dashboard**  
   – Interactive line charts (Swift Charts) of weight, BF %, FFMI, etc. over time  
   – Summary cards (latest values + delta since last scan)  

4. **History**  
   – Scrollable list of all scans/entries with date and key metrics  
   – Tap to view detailed breakdown  

5. **Avatar**  
   – A placeholder SwiftUI view that loads 3D wireframe PNGs (provided by backend) for given BF % & FFMI  
   – Fetch by URL and cache locally  

6. **Profile & Settings**  
   – Edit user info, choose units (kg/lb, cm/in)  
   – Toggle HealthKit sync (weight + body composition)  

7. **Notifications**  
   – Local push reminders (e.g. monthly scan upload)  

8. **Architecture & Code Style**  
   – MVVM with one ViewModel per screen  
   – Combine for async data flows  
   – URLSession + Codable for networking  
   – CoreData model mirroring server entities  
   – Dark-mode-only styling with semantic SwiftUI color assets  

Generate:  
• Xcode project scaffold with targets, entitlements, Info.plist  
• Swift files for Models, ViewModels, Views, Services  
• PDF parsing code with placeholders for parsing rules  
• Sample Chart views  
• Networking stubs and CoreData setup  
• Comments and TODOs for backend endpoints and asset integration  
```

Paste that into LovableAIChat to get a ready-to-run SwiftUI iOS project.

---

## User

Good. For the mobile app, don't worry about the PDF upload instead. Let's have it do a clean onboarding where it asks you to enable Apple HealthKit, and then it imports all of your weight data, body fat percentage data, and step count data, and imports it into the app. Thank you.

---

## Assistant

Certainly, Mr. White. Here’s the updated prompt—just swap it into LovableAIChat:

```
You are to generate a full Swift iOS app called “LogYourBody” using SwiftUI (iOS 16+), with a dark-mode-only aesthetic inspired by Linear. Use MVVM + Combine and CoreData for local storage. Stub out a REST networking layer (URLSession) to sync with our existing LogYourBody web API. Implement:

1. **Authentication**  
   – Email/password + optional Sign in with Apple  
   – Persist tokens securely in Keychain  

2. **Onboarding**  
   – Prompt user to enable Apple HealthKit permission  
   – On first launch, read and import:  
     • Weight samples  
     • Body-fat percentage samples  
     • Step-count data  
   – Store all imported metrics in CoreData  

3. **Dashboard**  
   – Interactive line charts (Swift Charts) of weight, BF %, FFMI, steps over time  
   – Summary cards (latest values + delta since last import)  

4. **History**  
   – Scrollable list of all imported entries with date and key metrics  
   – Tap to view detailed breakdown  

5. **Avatar**  
   – SwiftUI view loading 3D wireframe PNGs (provided by backend) for given BF % & FFMI  
   – Fetch by URL and cache locally  

6. **Profile & Settings**  
   – Edit user info, choose units (kg/lb, cm/in)  
   – Toggle HealthKit sync on/off  

7. **Notifications**  
   – Local reminders (e.g. weekly data sync)  

8. **Architecture & Code Style**  
   – MVVM with one ViewModel per screen  
   – Combine for async flows  
   – URLSession + Codable for networking  
   – CoreData mirroring server entities  
   – Dark-mode-only styling with semantic SwiftUI color assets  

Generate:  
• Xcode project scaffold with targets, entitlements, Info.plist  
• Swift files for Models, ViewModels, Views, Services  
• HealthKit integration code with comments/TODOs  
• Sample Chart views  
• Networking stubs and CoreData setup  
• Inline comments and TODOs for backend endpoints and asset integration  
```


**Topic:** [[chatgpt-clusters/coding_mobile]]


## See Also
- [[chatgpt/chatgpt_fixing-swift-errors]]
- [[chatgpt/chatgpt_ios-swift-dev-insights]]
- [[chatgpt/chatgpt_max-martins-taylor-swift-collaboration]]
- [[chatgpt/chatgpt_native-swift-vs-capacitor]]
- [[chatgpt/chatgpt_supabase-swift-integration]]
