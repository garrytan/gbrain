---
title: "Create Calendar Event."
type: guide
created: 2023-05-25
updated: 2023-05-25
source: chatgpt-export
conversation_id: 2ce87c0e-3fa8-4d72-92a4-31b014c1a0bf
message_count: 4
tags: [chatgpt, import, code]
---
# Create Calendar Event.

> Conversation ID: 2ce87c0e-3fa8-4d72-92a4-31b014c1a0bf
> Created: 2023-05-25T03:55:11Z
> Updated: 2023-05-25T03:55:53Z
> Messages: 4

---

## User

createCalendarEvent(contact) {
      window.open(
        `https://calendar.google.com/calendar/r/eventedit?text=${
          this.currentUser.first_name
        } ${this.currentUser.last_name} <> ${
          contact.full_name
        }&details=Created by ${this.currentUser.first_name} ${
          this.currentUser.last_name
        } on ${new Date().toLocaleDateString()}&location=&trp=false&sprop=&sprop=name:&dates=20200501T000000Z/20200501T000000Z&add=${
          contact.emails[0] || ''
        }&notes='Created via Jovie: https://jov.ie`
      );
    },

---

## Assistant

The code you provided is a JavaScript function that creates a calendar event using Google Calendar. When the function is called, it opens a new window with a pre-filled Google Calendar event creation form.

Here's a breakdown of the code:

```javascript
createCalendarEvent(contact) {
  window.open(
    `https://calendar.google.com/calendar/r/eventedit?text=${
      this.currentUser.first_name
    } ${this.currentUser.last_name} <> ${
      contact.full_name
    }&details=Created by ${this.currentUser.first_name} ${
      this.currentUser.last_name
    } on ${new Date().toLocaleDateString()}&location=&trp=false&sprop=&sprop=name:&dates=20200501T000000Z/20200501T000000Z&add=${
      contact.emails[0] || ''
    }&notes='Created via Jovie: https://jov.ie`
  );
},
```

The function takes a `contact` object as an argument, which presumably contains information about a particular contact. The code then uses this information along with the current user's details to generate the Google Calendar event.

Let's break down the URL used in `window.open()`:

1. `https://calendar.google.com/calendar/r/eventedit?` - Base URL for creating a new Google Calendar event.
2. `text=` - Sets the event title, which includes the current user's first name, last name, and the contact's full name.
3. `details=` - Specifies additional details about the event, including the user who created it, the creation date, and a note about it being created via Jovie.
4. `location=` - Allows specifying a location for the event, but it's empty in this code snippet.
5. `trp=false` - Indicates that the event should not show as "busy" on the calendar.
6. `sprop=` - URL property used by Google Calendar.
7. `dates=` - Specifies the event start and end dates/times. However, in this code, it uses a fixed value of "20200501T000000Z/20200501T000000Z," which represents May 1, 2020, from midnight to midnight.
8. `add=` - Specifies the email address to invite to the event. It uses the first email address from the `contact.emails` array or an empty string if no email is available.
9. `notes=` - Adds a note to the event, mentioning that it was created via Jovie and providing a link to "https://jov.ie."

Overall, this code is meant to open a new window with a pre-filled Google Calendar event form containing relevant information about the contact and the current user.

---

## User

we also want to include a default description in the event before the created by jovie note

we can use the variable this.currentUser.team_preferences.calender_event_note

---

## Assistant

To include a default description in the event before the "Created by Jovie" note, you can modify the code as follows:

```javascript
createCalendarEvent(contact) {
  const defaultDescription = this.currentUser.team_preferences.calendar_event_note;
  const createdByNote = 'Created by Jovie: https://jov.ie';

  window.open(
    `https://calendar.google.com/calendar/r/eventedit?text=${
      this.currentUser.first_name
    } ${this.currentUser.last_name} <> ${
      contact.full_name
    }&details=${defaultDescription}%0A%0A${createdByNote}&location=&trp=false&sprop=&sprop=name:&dates=20200501T000000Z/20200501T000000Z&add=${
      contact.emails[0] || ''
    }&notes=`
  );
}
```

Here's what has changed:

1. Added a `defaultDescription` variable that holds the default description value from `this.currentUser.team_preferences.calendar_event_note`.
2. Created a `createdByNote` variable that contains the "Created by Jovie" note with the Jovie URL.
3. In the URL, `details=` now includes both the `defaultDescription` and `createdByNote`. The `%0A` represents a line break in the URL, allowing a new line between the default description and the created by note.
4. The `notes=` parameter is left empty to avoid duplicating the "Created by Jovie" note.

By including the `defaultDescription` in the `details=` parameter before the "Created by Jovie" note, you ensure that the default description appears as the initial content in the event, followed by the "Created by Jovie" note.
