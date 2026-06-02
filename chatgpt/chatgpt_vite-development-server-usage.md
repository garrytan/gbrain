---
title: "Vite development server usage."
type: note
created: 2023-02-23
updated: 2023-02-23
source: chatgpt-export
conversation_id: 701dc625-5f22-4a1e-985d-a8e9cbc8c2c5
message_count: 2
tags: [chatgpt, import, code]
---
# Vite development server usage.

> Conversation ID: 701dc625-5f22-4a1e-985d-a8e9cbc8c2c5
> Created: 2023-02-23T03:24:20Z
> Updated: 2023-02-23T03:24:20Z
> Messages: 2

---

## User

im used to running npm run watch and getting a lcoalhost:3000 page open in my browser.

Im trying out vite. How do i get the same result

---

## Assistant

To get the same result as running `npm run watch` with Vite, you can use the following steps:

1. Install Vite globally (if you haven't already) using npm:

```
npm install -g vite
```

2. Navigate to the directory of your project in the terminal.

3. Start the development server using the following command:

```
vite
```

This will start a local development server and automatically open your default browser to `localhost:3000`, which will show your application.

If you want to specify a different port number, you can use the `--port` flag followed by the desired port number, like this:

```
vite --port 8080
```

This will start the server on port 8080 instead of the default 3000.

You can also use other command line options with Vite, such as `--host` to specify the host name or IP address to bind the server to, or `--https` to enable HTTPS. You can find more information about these options in the Vite documentation.
