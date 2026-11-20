#!/usr/bin/env python3
"""Minimal stdio MCP driver: mcp.py <home> <script.json>; script = list of [tool, args]. Prints each result."""
import json, subprocess, sys, select

home = sys.argv[1]
calls = json.load(open(sys.argv[2])) if len(sys.argv) > 2 else []
p = subprocess.Popen(['/var/tmp/audit/brain.sh', home, 'serve'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(home + '.serve.err', 'w'), text=True, bufsize=1)
_id = 0
def rpc(method, params=None, notify=False):
    global _id
    msg = {'jsonrpc': '2.0', 'method': method}
    if params is not None: msg['params'] = params
    if not notify:
        _id += 1; msg['id'] = _id
    p.stdin.write(json.dumps(msg) + '\n'); p.stdin.flush()
    if notify: return None
    while True:
        line = p.stdout.readline()
        if not line: raise SystemExit('server closed')
        try: r = json.loads(line)
        except Exception: continue
        if r.get('id') == _id: return r

rpc('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {}, 'clientInfo': {'name': 'audit', 'version': '0'}})
rpc('notifications/initialized', {}, notify=True)

def call(tool, args):
    r = rpc('tools/call', {'name': tool, 'arguments': args})
    res = r.get('result') or r.get('error')
    texts = [c.get('text') for c in (res.get('content') or [])] if isinstance(res, dict) else []
    out = texts[0] if texts else json.dumps(res)
    try: return json.loads(out), res.get('isError') if isinstance(res, dict) else None
    except Exception: return out, res.get('isError') if isinstance(res, dict) else None

if __name__ == '__main__':
    for tool, args in calls:
        out, err = call(tool, args)
        print(json.dumps({'tool': tool, 'args': args, 'isError': err, 'out': out}, ensure_ascii=False))
    p.stdin.close(); p.terminate()
