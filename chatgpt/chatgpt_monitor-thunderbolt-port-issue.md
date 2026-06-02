---
title: "Monitor Thunderbolt Port Issue"
type: note
created: 2025-11-12
updated: 2025-11-12
source: chatgpt-export
conversation_id: 69151e20-6414-832b-9d35-7b6e3e269a62
message_count: 4
tags: [chatgpt, import, long-form]
---
# Monitor Thunderbolt Port Issue

> Conversation ID: 69151e20-6414-832b-9d35-7b6e3e269a62
> Created: 2025-11-12T23:55:00Z
> Updated: 2025-11-12T23:58:41Z
> Messages: 4

---

## User

I have a 27 inch Samsung monitor curved, ultra wide, its got thunderbolt input that is also supposed to charge my macboook, however that port has not worked since i got it in 2019. The humid and displayport do. Is it just fucked or can i fix it

---

## Assistant

Short answer: it *might* be dead, but there are a few things worth checking before you write it off, Mr. White.

I’ll lay this out step-by-step so you can test it logically.

---

## 1. Confirm exactly what that port is

Many “Thunderbolt” Samsung monitors from around 2018–2020 actually have:

- A **USB-C** port that supports:
  - Video (DisplayPort over USB-C)
  - USB hub functions  
  - **Sometimes** power delivery (PD), but not always  
- Or a **Thunderbolt 3** port with limited power (often 40–60W, rarely 85–100W)

If your MacBook charger is >60W and the monitor only provides e.g. 45W, the Mac will still charge (slowly), but if it’s **no PD at all**, it will never charge.

➜ Check the model number on the back of the monitor and the spec sheet online. Look specifically for:
- “USB-C with 45W/60W/85W power delivery”
- OR “Thunderbolt 3 (up to xx W power delivery)”

If it doesn’t explicitly say power delivery or “charging”, that port was never meant to charge your Mac.

---

## 2. Use the *right* cable

This causes more issues than people think.

- You need a **full-featured USB-C / Thunderbolt 3 cable**:
  - For Thunderbolt: look for the little **lightning/bolt symbol** on both ends.
  - Avoid cheap USB-C charge-only cables (they may pass power but not video / TB features, or vice versa).

**Test:**  
- Use the **original Apple USB-C charge cable** that came with your MacBook (those usually do full PD + video on newer models).
- Or, if you have another known-good Thunderbolt 3/4 cable (like from a dock), use that.

If video works over that port but power doesn’t, that narrows things down to PD negotiation, not a dead port.

---

## 3. Check the MacBook’s side of the equation

A few sanity checks on the Mac:

1. Plug the monitor into **every USB-C/TB port** on the MacBook. Sometimes one port can be weird/damaged.  
2. On macOS, while connected:
   - Go to ** > About This Mac > System Report… > Power**  
   - Look under **AC Charger Information** – see if a wattage shows up when the monitor is connected.
   - If it says “No AC Charger Information” with only the monitor connected, the Mac isn’t seeing PD at all.

If the Mac never reports *any* charger when only the monitor is plugged in, that strongly suggests the monitor isn’t offering power.

---

## 4. Does *anything* work over that port?

Important distinction:

- Scenario A: **No video, no USB hub, no charging** via that port  
  → Port is very likely physically dead or a board issue.
- Scenario B: **Video + USB hub work, but no charging**  
  → Either:
  - The monitor never supported PD (marketing confusion), or  
  - The PD circuitry is dead, but the data path still works.

You said “thunderbolt input that is also supposed to charge my MacBook” — if this is based on marketing or a YouTube review, it’s still worth verifying in the official spec sheet/manual.

---

## 5. Firmware / settings to check

Some monitors have:

- A **USB/Thunderbolt/DP over USB-C setting** in the OSD (on-screen menu)  
- Occasional **firmware updates** that fix USB-C/PD issues

To check:

1. Go into the monitor’s menu:
   - Look for **Input**, **USB-C / Thunderbolt**, **Power Delivery**, or similar.
   - Make sure the USB-C/TB port is not disabled or in some weird low-power mode.
2. Check Samsung’s support page for your exact model:
   - See if there are firmware updates
   - Sometimes they ship early units with buggy USB-C/PD behavior

Realistically though, if it’s been broken since 2019 and multiple macOS versions / reboots / cables haven’t changed anything, firmware is a long shot but still worth a look.

---

## 6. The “2019 reality check”

You’ve had it since 2019, and the port **never** worked:

- If:
  - You’ve tried multiple cables  
  - Multiple MacBook ports  
  - Verified the monitor is *advertised* to provide power  
  - And no charger shows up in macOS power info  

Then yes, chances are high the PD side of that port has been dead from day one (bad controller, bad board, etc.).

At that age, out of warranty, the options are basically:

1. **Live with it**:  
   - Use DisplayPort or HDMI for video  
   - Use your normal Mac charger for power  
   - Treat the USB-C/TB port as a “video only” or dead port.

2. **Board repair** (not usually worth it):  
   - You *might* find a specialist who repairs monitor mainboards / USB-C PD circuits, but:
     - Labor + parts will often approach or exceed the value of the monitor.
     - No guarantee of success.

3. **External dock workaround**:  
   - Get a **USB-C/Thunderbolt dock** that:
     - Charges the MacBook (60–100W PD)  
     - Outputs DisplayPort/HDMI to the monitor  
   - This bypasses the monitor’s PD entirely and just uses it as a dumb display.

---

## 7. Quick sanity checklist for you

Run this in order:

1. Confirm the **exact model number** and verify:
   - Does it *officially* support charging (PD)? Yes/No.
2. Try:
   - Known-good USB-C/TB cable  
   - Different USB-C port on your MacBook  
3. Check in macOS Power section if any **charger wattage** is detected from the monitor.
4. Check the **monitor menus** for any USB-C / Thunderbolt / PD settings.
5. If after all that:
   - Specs say it *should* charge  
   - But nothing shows up as a charger on the Mac  

Then: the PD side is almost certainly cooked, and you’re not fixing that without a board swap.

---

If you can drop the exact Samsung model number, I can tell you in very concrete terms whether it was *ever* able to charge a MacBook or if Samsung’s marketing / reviewers misled you.

---

## User

{'asset_pointer': 'sediment://file_0000000053a8722f818f8c3ebcd95acd', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 262996, 'width': 1152}

---

## Assistant

Yeah, from that pic I can see what you’ve got, Mr. White:

- Model: **Samsung C34J791** (C34J791WT / LC34J791WTNXZA)  
- Ports labeled: **DP IN**, then a laptop icon with ⚡ **(85W)**, then ⚡ **(15W)**.

So there are **two Thunderbolt 3 / USB-C ports**:

- The **85W port** = the one that’s supposed to charge your MacBook.  
- The **15W port** = daisy-chain/output only, basically no laptop charging.

If that 85W port has *never* worked since 2019, it’s very likely a hardware issue, but here’s everything worth trying before declaring it dead.

---

### 1. Make sure you’re on the right port

Your MacBook must be plugged into the port under the **laptop + ⚡ (85W)** icon, **not** the 15W one.

If the white cable in your photo is currently in HDMI or DP, that’s only giving you video, not power. You want:

MacBook ⟷ USB-C/Thunderbolt cable ⟷ **85W TB3 port** on the monitor.

---

### 2. Use a proper cable

You need a **full-fat USB-C / Thunderbolt 3 cable**, not a random charge-only cable.

- Best test: use the **Apple USB-C charging cable** that came with the MacBook (or any known Thunderbolt 3/4 cable with the little lightning symbol on the ends).

If you’ve only ever tried cheap Amazon USB-C cables, it might never have negotiated power or video properly.

---

### 3. See what macOS thinks

With the monitor plugged into the **85W port** using a good cable and your normal Mac charger **unplugged**:

1. On the Mac:  menu → **About This Mac** → **System Report…**
2. Check:
   - **Thunderbolt** section: do you see “C34J791” or similar listed?
   - **Power** section: under “AC Charger Information”, does any wattage show up?

If:
- Nothing appears in **Thunderbolt**, and  
- No charger is detected under **Power**  

…then the TB/USB-C circuitry in the monitor isn’t talking to the laptop at all.

---

### 4. What’s realistically going on

Given:

- The label clearly says **85W**, so it *is* supposed to charge a laptop.
- HDMI and DP work fine.
- You’ve had it since **2019** and the TB port has **never** worked.

Most likely:

- The **Thunderbolt/USB-C controller on the monitor’s mainboard is dead** (or was DOA), while the rest of the monitor is fine.

There’s no “software setting” that would kill only power/video on that one port for years.

---

### 5. Can you fix it?

Realistically:

- **DIY fix:** No simple one. It would require board-level repair or a mainboard swap. That’s specialist work.
- **Official repair:** On a 2019 monitor, out of warranty, a Samsung service center would probably quote you a price that’s close to a used/new monitor.
- **Practical move:** Treat the TB port as toast and do one of these:
  - Keep using **DP/HDMI for video** + your normal MacBook charger, or  
  - Get a **USB-C / Thunderbolt dock** that:
    - Charges the Mac (60–100W PD)  
    - Outputs DisplayPort/HDMI to the monitor.

So: if you’ve confirmed you’re in the 85W port, tried a known-good cable, and macOS never sees a charger or Thunderbolt device, then yeah — that TB port is basically **fucked**, and the sane fix is to work around it rather than repair it.
