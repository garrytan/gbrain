---
title: "Modifying Vue Method: Editable Check"
type: note
created: 2023-06-03
updated: 2023-06-03
source: chatgpt-export
conversation_id: 4f0dbe7c-a2c0-401e-9330-90528be9e067
message_count: 2
tags: [chatgpt, import, code]
---
# Modifying Vue Method: Editable Check

> Conversation ID: 4f0dbe7c-a2c0-401e-9330-90528be9e067
> Created: 2023-06-03T17:18:37Z
> Updated: 2023-06-03T17:18:46Z
> Messages: 2

---

## User

 fileChanged(e) {
      let self = this;
      this.uploadProgress = 0;
      const src = URL.createObjectURL(e.target.files[0]);
      Vapor.store(e.target.files[0], {
        visibility: 'public-read',
        progress: (progress) => {
          this.uploadProgress = Math.round(progress * 100);
        },
      }).then((response) => {
        if (response.uuid) {
          this.$nextTick(() => {
            self.$emit('updateAvatar', response.uuid);
          });
        }
        document.getElementById(`profile_pic_url_img_${this.contact.id}`).src =
          src;
      });
    },


modify this vue method to only work when the value of editable is true

---

## Assistant

To modify the Vue method `fileChanged(e)` to only work when the value of `editable` is `true`, you can add a condition at the beginning of the method to check the value of `editable`. If it is `false`, the method will exit early without performing any further actions. Here's the modified code:

```javascript
fileChanged(e) {
  if (!this.editable) {
    return; // Exit the method if editable is false
  }

  let self = this;
  this.uploadProgress = 0;
  const src = URL.createObjectURL(e.target.files[0]);
  Vapor.store(e.target.files[0], {
    visibility: 'public-read',
    progress: (progress) => {
      this.uploadProgress = Math.round(progress * 100);
    },
  }).then((response) => {
    if (response.uuid) {
      this.$nextTick(() => {
        self.$emit('updateAvatar', response.uuid);
      });
    }
    document.getElementById(`profile_pic_url_img_${this.contact.id}`).src = src;
  });
},
```

In the modified code, the method checks the value of `this.editable` at the beginning. If it is `false`, the method immediately returns and doesn't execute any further code. If `editable` is `true`, the method continues with the existing logic for uploading and updating the avatar.
