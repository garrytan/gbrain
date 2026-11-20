#!/usr/bin/env python3
# Usage: confirm.py <HOME> <ref>  -- runs `gbrain trust confirm <ref>` in a pty and types the token it asks for.
import os, pty, re, sys, select, time
home, ref = sys.argv[1], sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    os.execv('/var/tmp/audit/brain.sh', ['/var/tmp/audit/brain.sh', home, 'trust', 'confirm', ref])
buf = b''
sent = False
deadline = time.time() + 60
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 1)
    if fd in r:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        buf += data
        text = buf.decode('utf8', 'replace')
        if not sent:
            m = re.search(r'[Tt]ype\s+[`"\']?([A-Za-z0-9:_\-]+)[`"\']?', text)
            if m and ('confirm' in text.lower()):
                time.sleep(0.3)
                os.write(fd, (m.group(1) + '\n').encode())
                sent = True
print(buf.decode('utf8', 'replace'))
