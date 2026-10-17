---
name: mega-bug-hunt
description: End-to-end bug bounty hunting pipeline for authorized programs (Intigriti/HackerOne/Bugcrowd). Use when the operator wants to hunt a bug bounty program from scratch to submission: scope analysis, passive recon, compliant live testing, APK reverse engineering, API testing with extracted credentials, triage, EV-based submit/hold decisions, and submission staging. Covers the full methodology that produced paid findings: Drost MCP driving, rate-limited probing, 6-agent parallel analysis, APK jadx decompilation to extract auth flows and API route maps, code-graph indexing with bidirectional blast-radius and reachability analysis (bug amplification through call chains, one node's bug compounding into a bigger one along the edges), BOLA cross-account matrices, JWT manipulation, LB-instance pinning, the 7-Question Gate, and program-stats submission math. Trigger words: bug bounty, hunt, bughunt, recon the program, find the bug, submit the finding, graph the code, blast radius, call chain, dependency graph, impact mapping.
license: MIT
---

# mega-bug-hunt

The complete pipeline, in phase order. Each phase lists the exact mechanics and the
lessons that produced real findings. NEVER SKIP A PHASE GATE. The worked example:
Nutaku/Aylo Intigriti (2026-10-15/16) — 2 findings (High JWT-validation + Medium BOLA),
full artifacts at ~/stw/recon (ENGAGEMENT-REPORT-NUTAKU.md is the template for your report).

## Phase 0 - Program compliance setup (DO THIS FIRST, ALWAYS)

1. Read the program page COMPLETELY. Extract into `recon/header.conf`:
   - In-scope asset list (exact host list; note wildcard vs URL asset types)
   - Out-of-scope list (verbatim — this kills half your candidate findings later)
   - RoE: rate cap (e.g. 7 req/s), mandatory header format, account rules, report window (24h?)
2. Write the mandatory header into header.conf and NEVER send a request to a target
   host without it. In-scope host whitelist goes into every tool you run.
3. Unlisted host != in scope. Intigriti URL-type assets cover that URL only.
   Wildcard assets (*.domain) cover subdomains. When in doubt: note it, don't test it.
   Staging/sbox/CDN hosts are ban-bait even when the app references them.

LESSON: the header requirement is the #1 reason agents stall. If the operator refuses
to provide the username, do passive recon (Phase 1) — it touches no target servers — and
keep asking. Compliance record IS an asset: it survives program audits.

## Phase 1 - Passive recon (zero target traffic)

- DNS: `dig +short A/CNAME` for every in-scope host; note shared IPs (one operator range = one org).
- TLS: `openssl s_client` SANs per host (no `timeout` on macOS — pipe stdin instead).
- Cert transparency: `curl "https://crt.sh/?q=%25.<domain>&output=json"` per apex.
  Unlisted subdomains found here = OUT OF SCOPE unless listed. Record, don't touch.
- Wayback: `curl "http://web.archive.org/cdx/search/cdx?url=*.<domain>&output=text&fl=original&collapse=urlkey&limit=8000"`
  Save all-urls.txt. Mine it for: admin/api/backup paths, parameter names, archived JS,
  legacy endpoints (they reveal the app's HISTORY even when hardened today).
- Archived snapshots: fetch interesting pages via `/web/<ts>id_/<url>` — old JS bundles,
  old config, version drift. Zero requests to the target.

LESSON: the Wayback dump found the exchange redirect, the token-in-URL game handoffs,
and the WordPress history that revealed nutakupublishing.com became a static HTTrack
mirror. Passive is never wasted even when it finds nothing live.

## Phase 2 - Tooling standup

- Drost CE (docker, ~700MB+ Kali image): `bash install.sh` from the cloned repo;
  verify `docker exec drost-ai drost-mcp --self-test`. Drive it with a stdio MCP driver
  (scripts/drost-mcp-driver.py in this skill): initialize -> tools/list -> tools/call.
  Browser sessions are PROCESS-SCOPED: keep ONE persistent process for browser workflows.
- HTTP workbench sessions: create with scope_hosts + default_headers (bake the RoE
  header in). Rate cap belongs in YOUR executor, not the tool.
- secgin (source-review harness): only applies if the operator HAS source. It is
  source-only by design; do not expect it to scan live targets.
- Claude-BugHunter: clone it, read skills/triage-validation (7-Question Gate) and the
  hunt-* skills. It's a knowledge layer, not a scanner.

## Phase 3 - Rate-limited live probing

Build ONE executor for all volume probing (scripts/ratelimited-probe.py):
- single-threaded (hard egress cap), sleep-enforced rate (e.g. 6/s), host whitelist,
  header from header.conf, JSONL log of every request+response head, stop-file kill switch.
- Curated probe lists ONLY. Sources: archived URLs (Phase 1), extracted params,
  targeted guesses derived from the app stack. NEVER dictionary-blast a production host.
- Diff responses: status/size/content-type. "200 with identical body" = param ignored. Log everything.

## Phase 4 - Parallel agent analysis (6 agents)

Spawn read-only subagents on the saved artifacts, NO network:
1. path miner (archived URLs -> probe list)
2. API route miner (route templates + guesses)
3. platform-surface specialist (WP/etc. exposure files)
4. client-artifact reviewer (forms, params, cookies, CSRF, reflection sinks)
5. payload designer (bounded probes, each tagged with bug class + OOS-pass reason)
6. reportability judge (decision table from the program's OOS list + evidence bar)
Merge outputs -> executor run. The judge's ruleset is the triage pre-filter.

## Phase 5 - Client-side artifact review

Map every form (action/method/hidden fields), every cookie name (auth vs tracking vs
UI), CSRF token mechanism, error-response contract (reflection candidates), and every
URL param that lands in DOM sinks (.html(), innerHTML). Test reflection with MILD
breakout probes first (`"`, `<`) — WAFs block the loud payloads and you learn nothing.

LESSON: login/signup error reflection was Agent-4's top candidate and died quietly —
generic messages, strict validation. Expect most client-side candidates to die; that's
the process working.

## Phase 6 - THE MONEY MOVE: APK reverse engineering

When the program has a mobile app (download page in scope => official APK is fair game):
1. Get the APK from the official link ON AN IN-SCOPE PAGE. `file` to verify.
2. android-reverse-engineering skill: `fingerprint.sh` first (framework matters — Flutter
   means jadx is useless). Then `install-dep.sh jadx`, `decompile.sh` (runs in the drost
   container on macOS — the host bash is too old for the scripts).
3. Mine the decompiled tree:
   - Constants/<App class>: ALL base URLs (prod/stage split), embedded client creds
   - Retrofit/API interface files: THE COMPLETE ROUTE MAP with per-route auth params
     (grep the annotations: @GET/@POST("path"), @Header("Authorization"), @Path("id"))
   - The login request model: exact field names + password transform (SHA-1? MD5? plaintext?)
   - Auth flow: clientId/clientSecret/grantType/device fields
4. Use the extracted login flow to mint REAL tokens for your own accounts. This is the
   bridge from "unauthenticated recon" to "authenticated testing" without the app.

LESSON: this was the pivot that produced BOTH findings. 45 minutes of jadx produced
the complete API surface that 600 blind requests could not.

## Phase 7 - Authenticated API testing

With tokens for TWO of your own accounts:
- BOLA matrix: for every route with a path id (users/{id}/...), swap cross-account:
  A-token + B-id, B-token + A-id, plus own-id baselines. Empty-array responses are
  AMBIGUOUS — create data on the target account first (favorite something, change a
  setting) so the cross-read is decisive. Include the own-list control step.
- JWT manipulation on auth'd endpoints: alg:none with (a) exact payload (b) modified
  exp (c) modified jti (d) nonexistent sub. Nonexistent-sub 401 + exact-payload 200
  proves the server processes tokens (kills the "it's cached" objection).
- LB-instance correlation: record `set-cookie: LBSERVERID=<id>` per response. Inconsistent
  validation across instances = per-node config drift. Pin with the cookie to make it
  deterministic (5/5, not 30%). Test exp-tampering PINNED, or you'll get flaky 401s.
- Purchase/financial flows: with 0 balance, a success = critical, a clean refusal = normal.
- NEVER enumerate real users' data. Two owned accounts is the compliant complete PoC.

## Phase 7.5 - Graph-based bug amplification (ANY source: decompiled APK, archived JS, operator's tree)

A bug at one node is rarely the finding. Code links to other code: a small defect that
travels an edge (unvalidated param -> authz decision -> data sink) becomes a much
bigger bug than either endpoint. Build the graph once, then hunt the EDGES, not the nodes.

1. Index every source artifact into a code graph with scripts/graph-blast-radius.py:
   `index <src-dir> -o graph.json`. Nodes: files, functions/methods, API routes, path
   params. Edges: imports, cross-file calls, route -> handler -> params. The Phase 6
   jadx route map IS a graph — index it, don't eyeball it.
2. Blast EVERY candidate bug in both directions (`blast graph.json <seed>`):
   - Backward reachability: which entry points (routes, handlers, main) reach the
     buggy node. That is the attack surface rating. A bug nothing reaches is dead.
   - Forward blast radius: which sinks the buggy node reaches (authz, session, SQL,
     exec, file write, redirect, payment). That is the impact rating.
3. Chains beat nodes: a Medium node flowing into a High sink is ONE High finding (the
   chain), not two Mediums. Hunt the chain patterns first: unvalidated param into an
   authz decision; error text into a logger that renders to output; one config value
   into every route that reads it (systemic single-line).
4. Persist graph.json + graph.dot with the engagement artifacts. Re-run blast on every
   new candidate — the graph is the long-run asset: later phases query it for free,
   and on a repeat program you re-index in minutes and start ahead.

LESSON: both worked-example findings were EDGE traversals of the route map, not node
bugs: users/{userId}/favorite-games (route -> id param -> cross-account read) and
alg:none (token -> per-instance authz). The graph view is why they were findings.

## Phase 8 - Triage (7-Question Gate)

Before ANY submission, apply CBH's gate. Q1: can an attacker use this RIGHT NOW, step by
step, with copy-paste requests? One wrong answer = kill the finding. Cross-check every
candidate against the program's OOS list VERBATIM (info-disclosure-without-impact and
IDOR-without-impact clauses kill more candidates than any technical control).
Also verify the finding is STILL LIVE minutes before submission.

## Phase 9 - Submission decision by program stats

- acceptance_rate = accepted / total submissions on the program page
- avg payout tells you which severity band actually pays
- EV = P(accept|band) x band_midpoint. Compare against: OOS-list overlap risk,
  zero-tolerance clauses, account age. ~$50 EV on a strict program = HOLD.
- 24h rule vs platform slot limits: document discovery time INSIDE the report
  ("submission delayed by slot availability") and stage the submission fully.

## Phase 10 - Submission staging (zero-friction submit)

1. Write FINDING-<slug>.md (full report) — summary, numbered repro steps with exact
   requests, evidence matrix, impact numbered points, notes (own-accounts-only,
   header compliance), severity reasoning with CVSS vector.
2. Stage form field blocks as .txt files: submission-<slug>-poc-field.txt,
   submission-<slug>-impact-field.txt. Load via `pbcopy < file` — operator pastes with
   Cmd+A/Cmd+V. THIS PREVENTS PASTE-INTO-WRONG-FIELD disasters (it happened).
3. Form values card: title (under the char limit), asset, type (exact CWE entry),
   CVSS selectors, endpoint, recommended solution, IP note.
4. Verify draft on the review screen END TO END before Submit: title/type/severity
   must match the PoC content. A mismatched submission on a zero-tolerance program
   burns the slot and the account.

## Phase 11 - After submission

- Log to the engagement report (timestamp, program, severity, SLA, possible bounty).
- Stage the next finding for when a slot frees.
- Keep test-account credentials in tokens.json for triage follow-up demos.
- If triage pushes back: the JSONL evidence log is your appeal document.

## Never-miss checklist (the whole skill in 13 lines)

1. header.conf + host whitelist before ANY request
2. passive before active; archived history before live guessing
3. one rate-limited executor for all volume; JSONL everything
4. unlisted host = out of scope; staging/sbox/CDN = ban-bait
5. check for a mobile app — APK -> jadx -> constants -> login flow -> route map
6. two owned accounts minimum for BOLA matrices; disambiguate empty responses with data
7. JWT: alg:none x4 payload variants; correlate with LB instance cookie; pin to confirm
8. 7Q gate + verbatim OOS check before writing any report
9. program stats -> EV math -> submit/hold decision
10. stage field blocks as files; pbcopy; verify draft matches finding before submit
11. discovery time inside the report if slot-delayed
12. log everything; the evidence trail is also the triage-appeal trail
13. index the code graph once; blast every candidate both directions; the chain is the finding, not the node
