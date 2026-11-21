# Usage: python3 -I stdio.py <home> [serve args...]  ; reads calls as JSON lines from CALLS env file
import json, subprocess, sys, os
home=sys.argv[1]; extra=sys.argv[2:]
calls=[json.loads(l) for l in open(os.environ['CALLS']) if l.strip()]
p=subprocess.Popen(['/var/tmp/audit/vega/brain-keyless.sh',home,'serve',*extra],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
def send(m): p.stdin.write(json.dumps(m)+'\n'); p.stdin.flush()
def recv(i):
    while True:
        l=p.stdout.readline()
        if not l: return None
        try: j=json.loads(l)
        except: continue
        if j.get('id')==i: return j
send({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"audit","version":"1"}}}); recv(0)
send({"jsonrpc":"2.0","method":"notifications/initialized"})
for n,c in enumerate(calls,1):
    send({"jsonrpc":"2.0","id":n,"method":"tools/call","params":{"name":c[0],"arguments":c[1]}})
    r=recv(n); res=(r or {}).get('result',{})
    txt=' | '.join(x.get('text','') for x in res.get('content',[]))
    print('==',c[0],json.dumps(c[1]),'isError=',res.get('isError'),'access=',json.dumps(res.get('_meta',{}).get('access')))
    print(txt[:int(os.environ.get('NT','700'))])
p.stdin.close(); p.terminate()
