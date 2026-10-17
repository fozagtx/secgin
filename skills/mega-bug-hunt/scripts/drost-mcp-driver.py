#!/usr/bin/env python3
"""MCP stdio driver for the Drost Community Edition container (from mega-bug-hunt skill).

Speaks JSON-RPC 2.0 (newline-delimited JSON) over `docker exec -i drost-ai drost-mcp`.
Usage:
  drost-mcp-driver.py list
  drost-mcp-driver.py call <tool_name> '<json-arguments>'

NOTE: browser sessions are process-scoped. For browser workflows, keep ONE persistent
subprocess and issue multiple tools/call requests over the same stdio connection (see
the mega-bug-hunt SKILL.md Phase 2).
"""
import json, subprocess, sys

PROC = ["docker", "exec", "-i", "drost-ai", "drost-mcp"]

def rpc(p, msg):
    p.stdin.write((json.dumps(msg) + "\n").encode()); p.stdin.flush()

def read_response(p, want_id):
    while True:
        line = p.stdout.readline()
        if not line:
            raise RuntimeError("drost-mcp closed stdout")
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("id") == want_id:
            return msg

def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    mode = sys.argv[1]
    p = subprocess.Popen(PROC, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        rpc(p, {"jsonrpc": "2.0", "id": 0, "method": "initialize",
                "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                           "clientInfo": {"name": "mega-bug-hunt", "version": "1.0"}}})
        init = read_response(p, 0)
        if "error" in init:
            print(json.dumps(init, indent=2)); sys.exit(1)
        rpc(p, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        if mode == "list":
            rpc(p, {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
            tools = read_response(p, 1).get("result", {}).get("tools", [])
            print(f"{len(tools)} tools")
            for t in tools:
                desc = (t.get("description") or "").split("\n")[0][:90]
                print(f"{t['name']}  -  {desc}")
        elif mode == "call":
            if len(sys.argv) < 4:
                print("call requires <tool_name> '<json-args>'"); sys.exit(2)
            name = sys.argv[2]
            args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
            rpc(p, {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                    "params": {"name": name, "arguments": args}})
            print(json.dumps(read_response(p, 2), indent=2, default=str))
        else:
            print(__doc__); sys.exit(2)
    finally:
        try: p.stdin.close()
        except Exception: pass
        try: p.wait(timeout=5)
        except Exception: p.kill()

if __name__ == "__main__":
    main()
