# Walkthrough & regression scripts

~90 scripts used to drive the Mini Program through WeChat DevTools
(`miniprogram-automator`) and to verify backend behaviour directly.

## Named verifiers

`verify-*.js` files are the regression suite — each one asserts a specific contract and
prints a pass/fail tally:

```bash
npm install
node verify-reminder-timing.js     # threshold table + freezing into meta.timing
node verify-occurred-at.js         # next round scheduled from the actual date + undo
node verify-water-baseline.js      # soil-water account (creates and deletes its own plant)
node verify-session-recovery.js    # invalid token → silent re-login → replayed request
node verify-purchase-guide.js      # purchase-guide tiers and alias matching
node verify-share.js               # share to chat and to timeline (field-by-field)
```

Scripts that only exercise the HTTP API need the backend running. Scripts whose names start
with `verify-*-ui` (and the `capture-*` / `*-shots` walkthroughs) additionally need WeChat
DevTools with the automation port open:

```bash
# in WeChat DevTools: cli auto --project <path to Treyni> --auto-port 9420
node verify-plan-ui.js
```

## Conventions

- **No hardcoded IDs.** Scripts resolve a suitable plant via `lib.js`, or create their own
  temporary fixture and delete it in a `finally` block.
- **Read-only by default.** A script that must write data (a diagnosis flow, for example)
  runs against a temporary plant unless you pass `--plant=<id>` explicitly.
- **Measure, don't eyeball.** Layout claims are checked by querying
  `boundingClientRect` in the render layer, not by looking at a screenshot.

## Not included

The Windows helpers in the private tree (`make-compare.ps1` for before/after screenshot
pairs, `run-ui-regression.ps1` for reopening DevTools between scripts, and the Taobao
price-probe scripts) are excluded here because they hardcode machine-specific paths.
