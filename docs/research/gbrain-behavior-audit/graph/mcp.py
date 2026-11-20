#!/usr/bin/env python3
# Usage: mcp.py <HOME> <calls.jsonl>   each line: {"name": tool, "arguments": {...}}
import json, subprocess, sys, select, time
home, calls = sys.argv[1], sys.argv[2]
p = subprocess.Popen(['/var/tmp/audit/brain.sh', home, 'serve'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(home + '.serve.err', 'w'), text=True, bufsize=1)
def send(o):
    p.stdin.write(json.dumps(o) + '\n'); p.stdin.flush()
def recv(id_, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([p.stdout], [], [], 1)
        if not r: continue
        line = p.stdout.readline()
        if not line: break
        try: m = json.loads(line)
        except Exception: continue
        if m.get('id') == id_: return m
    return {'timeout': True}
send({'jsonrpc': '2.0', 'id': 0, 'method': 'initialize', 'params': {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'audit', 'version': '0'}}})
recv(0)
send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
for i, line in enumerate(open(calls), start=1):
    line = line.strip()
    if not line: continue
    c = json.loads(line)
    send({'jsonrpc': '2.0', 'id': i, 'method': 'tools/call', 'params': c})
    m = recv(i)
    res = m.get('result', m)
    texts = [x.get('text', '') for x in res.get('content', [])] if isinstance(res, dict) else []
    print('### ' + json.dumps(c) + (' isError' if res.get('isError') else ''))
    print('\n'.join(texts)[:4000] if texts else json.dumps(m)[:4000])
p.stdin.close(); p.terminate()
