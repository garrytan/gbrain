---
title: "QNAP TVS-872XT Update Error"
type: note
created: 2024-04-04
updated: 2024-04-04
source: chatgpt-export
conversation_id: d04f3391-a612-4070-adc5-c0b4881fcd6c
message_count: 8
tags: [chatgpt, import, long-form]
---
# QNAP TVS-872XT Update Error

> Conversation ID: d04f3391-a612-4070-adc5-c0b4881fcd6c
> Created: 2024-04-04T20:06:52Z
> Updated: 2024-04-04T20:26:36Z
> Messages: 8

---

## User

{'asset_pointer': 'file-service://file-eNqXeLhIcetoEzbAfYhg7Dqf', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 320, 'metadata': None, 'size_bytes': 32116, 'width': 548}

---

## User

this is on a qnap tvs-872xt


---

## Assistant

The error message you're seeing indicates that there was a problem with the flash memory read/write process during a firmware update. This could be due to a number of issues such as corruption of the firmware file, problems with the flash memory itself, or compatibility issues with the firmware.

Here are steps you could take to address this:

1. Restart the device and attempt the firmware update again. A temporary glitch could cause such errors.
2. Ensure that the firmware you are trying to install is specifically designed for your device and is the correct version.
3. If the device has an option for it, try resetting it to factory settings and then attempt the update again.
4. Check the manufacturer’s website for specific instructions or tools that might be required for the firmware update.
5. If the problem persists, contact the manufacturer's support as it could be indicative of a hardware issue with the flash memory that might require professional repair or replacement

---

## Assistant

The error message you're seeing, "Failed to update system. A flash read/write error occurred. Error code: 13," suggests that there is a problem with the firmware update process on your QNAP TVS-872XT. This could be due to a variety of issues, such as corrupted download, problems with the flash memory, or other hardware-related issues.

Here's what you can do to try and resolve this issue:

1. **Retry the Update**: Sometimes, simply retrying the update can resolve the issue. Ensure you have a stable internet connection before proceeding.

2. **Check QNAP Support**: Visit the QNAP support website and check for any specific instructions or newer firmware versions. Make sure the firmware you are trying to install is the correct version for your specific model.

3. **Use QNAP Qfinder Pro**: If the regular update process fails, you can use QNAP's Qfinder Pro software to update the firmware. This software can often bypass issues encountered with updates performed directly on the device.

4. **Hard Drive Check**: Make sure all hard drives in the NAS are functioning properly. A failing drive can sometimes interfere with the update process.

5. **Reset Button**: If the issue persists, try using the reset button on the device to revert to factory defaults and then attempt the update again. Be aware that this may reset settings and potentially affect the data on the device, so it should be done with caution and ideally after backing up your data.

6. **Contact Support**: If none of the above solutions work, it's best to contact QNAP's customer support directly for assistance. They may provide specific steps for troubleshooting or have you send in the device for repair.

Always ensure that your important data is backed up before attempting firmware updates or resets, as these processes can sometimes lead to data loss.

---

## User

{'asset_pointer': 'file-service://file-vZc2ERhOAhBV80yumi7ic5Mz', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 555, 'metadata': None, 'size_bytes': 95663, 'width': 1012}
it dailed with automic update over qfinder but worked with when i downloaded the file and then specified the path to the file. but now it seems to have stopped at 65% for a few minutes. im not sure if tis stuck or just slow

---

## Assistant

If the firmware update progress has stalled at 65% for a few minutes, there are a few potential reasons for this. It could be a normal part of the update process where certain operations take longer, or it could be indicative of a problem.

Here are steps you should take:

1. **Wait**: If it's a large update or if it's updating several parts of the system, some stages may take longer than others. Give it some more time if it hasn't been too long since the progress stopped.

2. **Check Activity Lights**: Look at the NAS and check for any activity lights. If the hard drive activity lights are blinking, the device might still be processing the update.

3. **Do Not Interrupt**: Avoid the urge to reboot or turn off the NAS during the firmware update process, as this could cause irreparable damage to the system.

4. **Check Network Connection**: Ensure that your computer and NAS have a stable network connection. A drop in the network connection during the update could halt the process.

5. **Monitor the NAS**: If your NAS has a display, check it for any status messages. Alternatively, if the NAS is accessible via the network, you could try to ping it from a command terminal or check if the management interface is accessible from a browser.

6. **Consult Documentation**: Refer to the QNAP manual or online resources for information on update times and what to do if an update does not progress as expected.

7. **Contact QNAP Support**: If the update does not resume after a reasonable amount of time, it may be necessary to contact QNAP support for assistance. They could provide more detailed instructions specific to your model or help troubleshoot any issues.

For future updates, ensure that a full backup of your NAS is taken to prevent data loss in case of such occurrences.

---

## User

its 226mb file


---

## Assistant

For a 226MB firmware file, the update process should not typically take an excessively long time to complete. However, the duration can still vary depending on the specific processes the firmware update is performing. 

Considering it has been several minutes and the update appears to be stuck at 65%, it's reasonable to consider some potential next steps:

1. **Patience**: Continue to wait a little longer. Some firmware updates may appear to hang at certain percentages when they are actually working on more complex parts of the update.

2. **Status Check**: If your NAS has LEDs or a status screen, monitor them for any signs of activity or error messages.

3. **Network Stability**: Double-check that your network connection hasn't dropped, which could disrupt the update.

4. **Documentation**: Look up the firmware update process in the QNAP documentation to see if there is any mention of expected wait times or what to do in case of a stalled update.

5. **QNAP Forums/Support**: If you've given it ample time and the update doesn't proceed, consider reaching out to QNAP support or checking QNAP forums for similar issues and potential solutions.

6. **Intervention**: If there is no change after an extended period and no signs of activity, you may need to reboot the device. However, this carries a risk of corrupting the firmware, so it's typically advised to only do this as a last resort and under guidance from QNAP support.

Since there is a risk of firmware corruption if the device is improperly shut down during an update, it's generally best to wait and reach out to support before taking any drastic measures.
