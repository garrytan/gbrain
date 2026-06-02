---
title: "Stop forgetting keys Mazda"
type: note
created: 2025-05-25
updated: 2025-05-25
source: chatgpt-export
conversation_id: 6832dfb2-1e48-8007-b91c-63b52cd95d93
message_count: 4
tags: [chatgpt, import]
---
# Stop forgetting keys Mazda

> Conversation ID: 6832dfb2-1e48-8007-b91c-63b52cd95d93
> Created: 2025-05-25T09:15:30Z
> Updated: 2025-05-25T09:19:03Z
> Messages: 4

---

## User

Okay, in the fucking Mazda, I have the key fob for it, and I constantly am, like, getting out of the car, and the fucking keys are, like, on the seat of the car, and I exit the car with the keys still in the car, and I go home, and then I realize that I don't have the keys on me, and it's frustrating because, like, the car doesn't, like, seem to give me any indication that I forgot the keys behind or anything, like, how do I, and, like, because I have the, like, auto-locking thing where the car just locks when I, like, walk away from it, I don't take my key out to lock the car, so I, like, never think about this shit, so, like, what do I fucking do? Like, how can I get it so I stop forgetting my fucking keys?

---

## Assistant

Mr. White, here are four fool-proof fixes:

1. **Put an AirTag on your fob**  
   – Attach an AirTag to your keychain and in Find My enable **Notify When Left Behind**. You’ll get an iPhone alert whenever you walk off with the keys still in the car.

2. **Use an iOS Shortcut on Bluetooth disconnect**  
   1. Open **Shortcuts** → **Automation** → **Create Personal Automation**.  
   2. Choose **Bluetooth** → select your Mazda’s Bluetooth/CarPlay → **Disconnected**.  
   3. Add **Show Notification** “Grab your keys!” → turn off **Ask Before Running**.  
   This fires every time your phone drops the car connection.

3. **Disable Mazda’s walk-away auto-lock**  
   In your CX-5’s infotainment menu go to **Settings** → **Convenience** → **Walk-Away Door Lock** and switch it **Off**. Now you’ll have to press the fob’s lock button (and hear the chirp) every time you leave.

4. **Create a visual habit cue**  
   Clip the fob to your belt loop or hang it on the inside door handle/visor when you park. Seeing it there becomes a built-in reminder before you walk away.

Pick one or combine them—together they’ll stop those “where are my keys?!” moments for good.

---

## User

Okay, so, the phone connects to CarPlay, and the keys have an AirTag on them. Is there any way that we can figure out a way to coordinate these things so that we know if my location moves away from the car? Also, there's an AirTag in the car. So, there's got to be something you could do, basically, to be like, either if I ever leave the location of the car, but the key stays in the same location as the car, then set off an alarm on the phone to tell me that I left my keys behind, or do something where, like, when the phone disconnects from CarPlay, and I start moving without the keys also moving with me or something, you know what I mean? Because, like, basically, if I'm never near the car, or if I'm not near the car, then the keys should not be near the car either.

---

## Assistant

Mr. White, iOS doesn’t give us a true “if phone moves and keys stay” trigger for AirTags, but you can get very close by combining:

1. **CarPlay-disconnect → “Find my keys” quick-action**  
   – In Shortcuts, make a Personal Automation:  
     - **Trigger**: CarPlay → Disconnected  
     - **Actions**:  
       1. **Play Sound** on your keys’ AirTag (via the “Find Items” action, if you’re on iOS 17+) or, if that’s not available, **Show Notification** “🔔 Play sound on keys?” + **Open App: Find My**.  
     – Now, whenever CarPlay drops, you’ll either hear your keys chirp (if they’re still in the car) or be prompted to open Find My and ping them yourself.

2. **Keep “Notify When Left Behind” on your keys AirTag**  
   – This will alert you anytime you walk off and truly leave your keys behind. No CarPlay or shortcuts needed—you’ll still get a map-pin notification whenever your iPhone loses proximity to your key fob.  

3. **Optional: Automate a visual cue**  
   – As soon as CarPlay disconnects, add a second action in that same Shortcut to **Show Notification** “🚗 + 🔑 check.” Seeing that pop forces you to glance for the chirp or manually grab your keys.

4. **Fallback: Use a tracker with Safe-Zone support**  
   – If you want real “if phone and tracker separate” logic without workarounds, consider a Tile device instead of an AirTag. Tile’s iOS app lets you define your car as a Safe Zone and trigger true “left-behind” alerts only when both your phone and car are in different zones—and you can even hook that into Shortcuts.

With CarPlay disconnect → ping-or-notify plus the built-in Notify-When-Left-Behind, you’ll catch almost every “I forgot my keys” scenario.
