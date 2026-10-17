#!/usr/bin/env python3
"""Rate-limited probe executor for authorized bug bounty testing (from mega-bug-hunt skill).

Guarantees: single process (no parallel egress), rate cap, in-scope host enforcement,
mandatory program header on every request, full JSONL logging, stop-file kill switch.

Usage: python3 ratelimited-probe.py <probefile> --header-conf header.conf --scope scope.txt --rate 6 --max 400
  probefile: one URL per line; # comments; optional \t note after URL
  header.conf: KEY=VALUE lines (e.g. X-Bug-Bounty=yourusername)
  scope.txt: allowed hostname per line
Stop the run any time: touch FUZZ-STOP in the working directory.
"""
import json, os, re, subprocess, sys, tempfile, time, urllib.parse

RATE = 6.0
LOG = "probe-log.jsonl"
STOP_FILE = "FUZZ-STOP"

def load_header_conf(path):
    headers = {}
    for line in open(path):
        m = re.match(r"^([A-Za-z0-9-]+)=(.+)$", line.strip())
        if m and not line.startswith("#"):
            headers[m.group(1)] = m.group(2).strip()
    return headers

def load_scope(path):
    return {l.strip() for l in open(path) if l.strip() and not l.startswith("#")}

def fetch(url, headers):
    with tempfile.NamedTemporaryFile(delete=False, suffix=".body") as tf:
        body_path = tf.name
    try:
        args = ["curl", "-s", "--max-time", "20", "-D", "-", "-o", body_path,
                "-w", "\n@@STATUS@@%{http_code}@@%{size_download}"]
        for k, v in headers.items():
            args += ["-H", f"{k}: {v}"]
        args.append(url)
        out = subprocess.run(args, capture_output=True, text=True).stdout
        status, size, location, ctype, body_head = 0, 0, "", "", ""
        m = re.search(r"@@STATUS@@(\d+)@@(\d+)\s*$", out)
        if m:
            status, size = int(m.group(1)), int(m.group(2))
        for line in out.splitlines():
            if ":" in line and not line.startswith("@@"):
                k, v = line.split(":", 1)
                kl = k.strip().lower()
                if kl == "location": location = v.strip()
                if kl == "content-type": ctype = v.strip()
        try:
            with open(body_path, "rb") as f:
                body_head = f.read(400).decode("utf-8", "replace")
        except Exception:
            pass
        return {"status": status, "size": size, "ctype": ctype, "location": location, "body_head": body_head}
    finally:
        try: os.unlink(body_path)
        except Exception: pass

def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    probe_file = sys.argv[1]
    args = sys.argv[2:]
    def arg(name, default):
        return args[args.index(name) + 1] if name in args else default
    header_conf = arg("--header-conf", "header.conf")
    scope_file = arg("--scope", "scope.txt")
    rate = float(arg("--rate", RATE))
    max_n = int(arg("--max", 400))
    headers, scope = load_header_conf(header_conf), load_scope(scope_file)
    if not headers:
        sys.exit("header.conf has no KEY=VALUE headers - refusing to send without program header")
    urls, seen = [], set()
    for line in open(probe_file):
        u = line.split("\t")[0].strip()
        if u and not u.startswith("#") and u not in seen:
            seen.add(u); urls.append(u)
    urls = urls[:max_n]
    print(f"executor: {len(urls)} probes, rate <= {rate}/s, headers {list(headers)}", flush=True)
    t0, sent, interesting = time.time(), 0, []
    with open(LOG, "a") as log:
        for u in urls:
            if os.path.exists(STOP_FILE):
                print(f"stop file hit after {sent} requests", flush=True); break
            host = urllib.parse.urlparse(u).hostname
            if host not in scope:
                print(f"SKIP out-of-scope: {u}", flush=True); continue
            while time.time() - t0 < sent / rate:
                time.sleep(0.02)
            r = fetch(u, headers); sent += 1
            rec = {"url": u, "ts": time.time(), **r}
            log.write(json.dumps(rec) + "\n"); log.flush()
            flag = ""
            if r["status"] not in (200, 401, 403, 404, 301, 302, 0):
                flag = " <<< NON-STANDARD"; interesting.append(rec)
            print(f"[{sent:3d}] {r['status']:3d} {r['size']:>8d}B {u[:110]}{flag}", flush=True)
    print(f"\ndone: {sent} requests in {time.time()-t0:.1f}s, interesting: {len(interesting)}", flush=True)
    for i in interesting:
        print(json.dumps({k: i[k] for k in ("url", "status", "size", "location", "body_head")}))

if __name__ == "__main__":
    main()
