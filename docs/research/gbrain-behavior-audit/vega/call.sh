#!/usr/bin/env bash
# Usage: call.sh <tokenfile> <tool> '<json args>' [extra curl headers...]
T=$(cat "$1"); tool="$2"; args="${3:-{\}}"; shift 3
curl -s --max-time 30 -X POST http://127.0.0.1:31871/mcp -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' "$@" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}" > /var/tmp/audit/vega/last.raw
python3 -I -c '
import json,sys
raw=open("/var/tmp/audit/vega/last.raw").read()
line=[l[6:] if l.startswith("data: ") else l for l in raw.splitlines() if l.startswith("data: ") or l.startswith("{")]
if not line: print("RAW:",raw[:2000]); sys.exit()
j=json.loads(line[0])
if "error" in j: print("RPCERR",json.dumps(j["error"])[:1500]); sys.exit()
r=j["result"]
print("isError:",r.get("isError"))
for c in r.get("content",[])[:int(sys.argv[1])]:
  print(c.get("text","")[:int(sys.argv[2])])
' "${NC:-1}" "${NT:-3000}"
