---
title: "Connect QLab to Next.js"
type: note
created: 2025-09-25
updated: 2025-09-25
source: chatgpt-export
conversation_id: 68d5c633-9f6c-8320-ad65-bf7bf345ce26
message_count: 2
tags: [chatgpt, import, code]
---
# Connect QLab to Next.js

> Conversation ID: 68d5c633-9f6c-8320-ad65-bf7bf345ce26
> Created: 2025-09-25T22:46:28Z
> Updated: 2025-09-25T22:47:42Z
> Messages: 2

---

## User

Can I connect QLab to our next.js site to display what cue we are currently on?

---

## Assistant

Yes—use QLab’s OSC to publish status and a tiny Node “bridge” to relay it to your Next.js site.

### How it works (short)
1) **QLab → OSC (UDP/TCP)**  
QLab listens on **53000** and sends OSC replies on **53001**. Enable OSC in *Workspace Settings → Network → OSC Access*. citeturn2search3turn1search1turn1search18

2) **Subscribe to updates**  
From your bridge, send `/listen/playhead` (and, if you want, `/listen/go`, `/listen/cue/start`) to QLab. QLab will push messages like:  
`/qlab/event/workspace/playhead {number} {name} {uniqueID} {type}` whenever the playhead moves. citeturn3view0

3) **Bridge → Web**  
Browsers can’t speak UDP/OSC, and Vercel can’t see your show network. Run a small **Node process on the QLab Mac (or same LAN)** that:
- Subscribes to QLab OSC
- Maintains current cue state
- Re-broadcasts via **WebSocket/HTTP** to your Next.js client

### Minimal bridge (Node)
```js
// server.js
import dgram from 'dgram';
import { WebSocketServer } from 'ws';
import osc from 'osc-min';

const QLAB_IP = '127.0.0.1';
const QLAB_PORT = 53000;   // send to QLab
const REPLY_PORT = 53001;  // listen for QLab replies

// Send helper
const sockOut = dgram.createSocket('udp4');
const send = (address, args=[]) =>
  sockOut.send(osc.toBuffer({ address, args }), QLAB_PORT, QLAB_IP);

// Listen for QLab replies
const sockIn = dgram.createSocket('udp4');
sockIn.on('message', (msg) => {
  const m = osc.fromBuffer(msg);
  if (m.address.startsWith('/qlab/event/workspace/playhead')) {
    // args: number, name, uniqueID, type
    const [number, name] = m.args;
    const payload = { number: number?.value, name: name?.value };
    wss.clients.forEach(c => c.send(JSON.stringify({ type: 'playhead', ...payload })));
  }
});
sockIn.bind(REPLY_PORT);

// Subscribe to events
send('/listen/playhead'); // also consider '/listen/go', '/listen/cue/start'

// WS for Next.js client
const wss = new WebSocketServer({ port: 8080 });
console.log('Bridge up: ws://<bridge-ip>:8080');
```
(Ports and messages per QLab docs.) citeturn1search1turn3view0

### Next.js (client)
Connect to the bridge and render the current cue:
```ts
// app/cue/page.tsx (or a client component)
'use client';
import { useEffect, useState } from 'react';

export default function Cue() {
  const [cue, setCue] = useState<{number?:string, name?:string}>({});
  useEffect(() => {
    const ws = new WebSocket('ws://<bridge-ip>:8080');
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'playhead') setCue({ number: msg.number, name: msg.name });
    };
    return () => ws.close();
  }, []);
  return <div>Current cue: {cue.number} — {cue.name}</div>;
}
```

### Notes / options
- **Security**: keep this on the show LAN; allow ports **53000/53001** through the Mac firewall only for the bridge host. citeturn1search18  
- **TCP mode** works too (no 53001), but UDP is simplest; QLab also supports custom formats via `/eventFormat` if you want slimmer messages. citeturn2search3turn3view0  
- If you only need a **pull** endpoint, you can query playhead/selection over OSC on demand, but push via `/listen` is more reliable for “live now”. citeturn2search3

If you want, I can tailor this exact bridge for Vault’s network layout and drop in a production-ready PM2 service script.
