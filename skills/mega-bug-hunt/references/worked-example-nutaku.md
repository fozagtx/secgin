# Worked-example: the Nutaku session (2026-10-15/16) — what each phase actually produced

This is the reference case for the mega-bug-hunt skill. Copy the pattern, not the target.

## Timeline and yield
- Phases 0-1 (compliance + passive): DNS/TLS/CT/Wayback (17k URLs). No findings, but
  produced the whole probe corpus and revealed the WordPress history + legacy endpoints.
- Phases 2-5 (tooling + unauth probing + agents): ~600 requests, 6 subagents,
  Claude-BugHunter methodology. ONE candidate finding (signup controls) — later HELD
  by EV math (OOS-overlap + ~$50 EV on a 9%-acceptance program). Negative surface
  map was itself valuable: actuator closed, WAF blocks sensitive filenames, WP is a
  static HTTrack mirror (not WordPress anymore).
- Phase 6 (APK reverse engineering): THE PIVOT. Official APK from the in-scope download
  page -> jadx (11,366 files) -> Constants.java base URLs, Yb/a.java complete Retrofit
  route map, AuthenticationRequest model (oauth-front/oauth-frontpass, SHA-1 password)
  -> real JWTs for two owned accounts via the app's own login.
- Phase 7 (authenticated testing):
  * BOLA: users/{userId}/favorite-games cross-account read, disambiguated by creating
    a favorite on account B first, with own-list control. FINDING (Medium).
  * JWT: alg:none exact-payload 200 -> cache-vs-forgery disambiguation (nonexistent-sub
    401 proved processing) -> per-instance LB split discovered via LBSERVERID correlation
    (10-shot matrix: ded4491/ded4492 accept, 4 others reject) -> deterministic via cookie
    pinning -> exp-extension accepted pinned (immortal replay). FINDING (High).
- Phases 8-10: 7Q gate passed both; program-stats EV (9% acceptance, $639 avg) said
  submit both; slot limit forced ordering (JWT first); field blocks staged as files,
  pbcopy workflow; draft-verification step caught a wrong-paste (IDOR text in the JWT
  submission) BEFORE it burned the slot.

## The five moves that made the money
1. Registering the account OURSELVES when told to think adversarially: the signup API
   had no captcha enforcement, which minted test accounts in one scripted request and
   became a (held) finding by itself.
2. APK decompilation instead of guessing API routes: 45 minutes of jadx > 600 blind requests.
3. Disambiguation discipline: empty-response BOLA fixed with data-creation + control step;
   alg:none "success" validated against the caching objection with a nonexistent-sub probe.
4. LB-instance correlation: the flaky 200/401 pattern was a per-node config drift, and
   the LBSERVERID cookie turned a 30% bypass into a deterministic one.
5. Submission hygiene: EV math to decide, staged field files + pbcopy to execute,
   draft verification before Submit (caught the wrong-field paste).

## Held finding (record for completeness)
Signup controls not enforced (empty recaptcha_response accepted, no email verification
for login, no age attestation). Held: ~$50 EV, overlaps the program's
"Confirmation Email (anything related with)" OOS clause, zero-tolerance program, new account.
File: FINDING-signup-controls.md. Revisit only with a demonstrated impact chain.
