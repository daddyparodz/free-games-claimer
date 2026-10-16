# Browser lifecycle

The four scheduled claimers (Epic, Prime Gaming, GOG, AliExpress) run all
post-launch work inside `withBrowser`. It closes the persistent context after
normal completion and when setup, claiming, diagnostics, or notifications throw.
Cookies and profile contents are retained. Epic post-failure retention defaults
to zero; `EG_ERROR_KEEP_OPEN_SECONDS` explicitly opts into bounded diagnostics
(up to 1800 seconds). Active login/MFA/CAPTCHA waits retain their existing limits;
this lifecycle does not solve challenges or introduce another claim retry.

## Relaunch and ownership

A profile-specific kernel listener serializes managed sessions: a Windows named
pipe, or a loopback TCP listener on other platforms. `.fgc-session.json` stores a
random per-run token and canonical profile hash, not authentication cookies.
A later invocation can ask the previous registered owner to close its own
Playwright context. It waits for acknowledged graceful closure before launching.
Concurrent contenders never repeatedly evict new owners. Failed closes retain
the owner so another cleanup can retry. No PID or executable-name killing is used.
Stale/reused PIDs therefore cannot authorize cleanup. A process crash releases the
kernel listener; browsers launched over Playwright's pipe shut down with it.

A matching profile alone is **not** permission to close a browser. Unregistered
manual browsers are never attached to or killed. On Windows a read-only process
check detects configured-profile conflicts before launch and fails closed with
an explanatory message. Native browser profile locks apply on Unix. A legacy
unregistered/diagnostic browser must be closed manually; the code does not guess
ownership from a debugging port. If a profile is shared, choose a dedicated
`BROWSER_DIR` rather than removing profile lock files.

The Windows automation repository calls `node close-browsers.js` **after** its
exclusive root-run lock and **before** Git sync/dependency work. Concurrent root
runs still skip without disturbing an active run or its manual CAPTCHA. An
accepted new run cleans up registered leftovers. Maintenance does not close
browsers. Both environment and `data/config.env` profile overrides are preserved;
the batch launcher no longer overwrites `BROWSER_DIR`.

## Regression checks

`npm test` includes real Chromium and Firefox lifecycle tests using **headless,
isolated temporary profiles**, no store login or purchase. They cover normal and
exception closure, replacement of a previous managed session, crash/stale record
recovery, cookie persistence, unrelated browsers, and manual browsers sharing the
configured profile. Ownership-token, failed-close, and concurrent-start tests are
also included. The outer repository's Python suite runs the real PowerShell
launcher with inert Git/claim bodies and a headless owned browser, verifying that
cleanup precedes sync and exit codes/logging remain intact.
