---
title: "Mazda CX-5 CarPlay Issues"
type: note
created: 2025-05-03
updated: 2025-05-03
source: chatgpt-export
conversation_id: 6816a146-21b8-8007-ac49-2a8e1be1a9d7
message_count: 2
tags: [chatgpt, import, long-form]
---
# Mazda CX-5 CarPlay Issues

> Conversation ID: 6816a146-21b8-8007-ac49-2a8e1be1a9d7
> Created: 2025-05-03T23:05:42Z
> Updated: 2025-05-03T23:06:28Z
> Messages: 2

---

## User

So I've got the Mazda CX-5, and we have upgraded the infotainment system to support wireless card play using the upgrade kit. And part of that process was updating the firmware to 74.0 whatever whatever I think is the latest firmware or close to it. So we did that. And then... And then... And then... On... On... Uh... And then... And then... Um... And then... So that was... That was working good. Um... Every time I turn the car on now, the system boots up into the Mazda system, takes a second, and then it throws the CarPlay logo up top in the corner. And then it takes a second, and then it automatically switches over to open the CarPlay app. And then I'm back in CarPlay with music resuming, and the Google Maps showing my location and everything, and it all looks good and whatnot. Now... Um... I've got... I've noticed a couple issues so far, and I just want to walk through them and see how we can resolve them. Um... If they're resolvable, if there are any firmware updates that address them, or if there's any, like, things that I could check that would fix them, or if I'm screwed and there are just known permanent issues or something. So, the first one being that... Um... I've had once or twice the system... Um... Where the system seems to be operating while connected to a phone. This actually happened when I was connecting Liv's phone the other day. Um... The system's operating, and I can see all the stuff on CarPlay and everything, but then suddenly the actual volume control for, like, the Mazda interface overlay of volume doesn't work when I change the volume knob. Um... And then also music doesn't play, even though I have play pressed on Spotify or whatever. Um... And I've... The only way I've seemed to be able to then get audio to resume is to put the car in park, shut off the engine, turn the car back on, and then as soon as the system starts up again and it reopens CarPlay, it automatically starts playing the music and the volume control works again. I had that happen twice yesterday when we were taking a road trip. Um... And, uh... So that was a little bizarre. Um, I've since reconnected to my phone, because, um, we haven't used Liv's phone at all today, and I experienced no issues today. So, so far I can't tell if that's isolated just to Liv's phone, um, or if that's an issue, or if it's isolated to, like, switching between phones when multiple phones are in the car or something. Um... Or not, I don't know. Um, so that's the first issue. Then the second issue is one I'm having right now, where, um, I picked up Liv, and we were driving around, and we drove to her place, um, CarPlay was all functioning properly, um, navigation was, was navigating me to Liv's park where I picked her up, um, and everything was working fine as we were driving home. I don't think I used navigation on the way home. Um, arrived at Liv's, uh, house, and then parked, went inside, um, Liv went to take a nap, I left, I got in the car, um, and then I started driving and went to put navigation on to... CarPlay came up and everything, um, volume controls work and everything, um, and then I went to navigate to my house, and I noticed that, um, on the home screen I was able to use the jog wheel to navigate to the Google Maps app, but then once within the Google Maps app, I lost any navigation. So I cannot navigate anymore with the jog wheel, either rotating it or pushing it, um, in the four directions. Um, then I'm able to press the button on the steering wheel to activate Siri and request that it, um, navigate home, but then it pulls up Google Maps, and it shows my address, and it asks me, um, it asks me to, um, confirm that I want to start the route, or it gives me the more routes option, or the back option, and when that screen comes up, I'm able to start the route. When that screen comes up, I lose, I'm losing the ability to navigate with the jog wheel at that point. Um, so, um, that's been my, um, that's my current situation, where I'm staring at the screen, and the screen does not seem to allow me to control navigation. However, I can still use the Siri button, and when I use the Siri button, I get back to the home screen, um, and I can ask it to do things, but when I ask it to go back into Google Maps, or navigate anywhere, I get back to the screen where I'm locked out of the control of the jog wheel. So that's the second issue. Um, and then the third issue is, I do not know how on this car with this infotainment system and this upgrade kit for the CarPlay, I don't know how to easily switch between phones. Now, I know how to switch between phones on the Bluetooth menu in the Mazda app, but I don't know how to switch between phones picking which phone is on CarPlay. Now, in modern Mazdas that I've rented, I've rented a 2024 Mazda CX-5, which has built-in CarPlay and has, like, the wider screen up top and stuff, on that car, it usually gives you, like, pops up and asks me if I want to switch, um, to, you know, it'll say, oh, it's still connected to Tim, do you want to switch to Livia's phone, or something like that. But, um, I don't know, I don't know how to do that on this system. So that would be the next issue.

---

## Assistant

Mr. White—here’s a concise checklist to troubleshoot each quirk you’re seeing:

**1. Volume-knob drop-outs / no audio**  
- **Reset the CarPlay pairing**  
  1. On your iPhone go to Settings > General > CarPlay.  
  2. Tap your Mazda, choose “Forget This Car.”  
  3. Reconnect via USB (or wireless adapter), then press-and-hold the steering-wheel voice button to pair anew. citeturn3view0  
- **Swap the power cable**  
  Even wireless adapters need a good USB power feed. Try a fresh, Apple-certified Lightning cable (or USB-C cable if your kit uses that) in case the old one isn’t delivering steady power citeturn3view0.  
- **Restart the CMU**  
  Force-reboot Mazda Connect by holding Volume + Nav + Back together for 10 seconds. This often clears odd audio hangs citeturn5search2.  
- **Adapter firmware**  
  If you’re on an aftermarket CarPlay dongle (e.g. Carlinkit/Autokit), log into its Wi-Fi interface (usually at 192.168.50.2) and apply the latest update—or roll back to the last known-good build—via OTA or USB-stick citeturn4search2.

---

**2. Jog-wheel (Commander) unresponsive in Google Maps**  
- **By design, deep in-app controls default to touch or Siri.** The official CarPlay guide shows the Commander is meant for app selection, play/pause, skipping tracks and volume, not full map navigation citeturn5search8.  
- **Workaround**:  
  - Use the touchscreen for panning/zooming.  
  - Or simply hold the voice button and say “Navigate home”—once confirmed, Maps will guide you without needing the knob.  

---

**3. Switching between two iPhones on wireless CarPlay**  
- **Last-paired logic**  
  Wireless CarPlay usually auto-connects to whatever phone it saw last. To force the other phone:  
  1. Turn off Bluetooth (and Wi-Fi) on the active phone.  
  2. On the second phone, enable Bluetooth/Wi-Fi—CarPlay will then latch onto that device citeturn0search5.  
- **Explicit CarPlay device selection**  
  On each iPhone:  
  1. Settings > General > CarPlay.  
  2. Tap “Mazda Connect” > choose “Connect” for the phone you want.

---

If any of these still misbehave, you may need a dealer-level Mazda Connect firmware bump (beyond 74.x) or a deeper adapter-firmware downgrade. Let me know which step moves the needle.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]
