# Privacy Lens

Privacy Lens is a local-first Manifest V3 browser extension for identifying third-party requests and blocking known trackers and advertising domains. Its popup is the main interface; it does not use a separate analytics dashboard.

## Runtime flow

1. Chrome's Declarative Net Request (DNR) engine evaluates the bundled static rules and synchronized dynamic policy rules.
2. The background service worker observes completed requests and, when available, DNR block matches.
3. The request analyzer identifies the request host, best-effort registered domain, initiator, resource type, and tracker catalog match.
4. The heuristic classifier flags suspicious unknown requests but does not automatically block them.
5. The policy layer combines protection settings and exceptions; bounded request records and longer-lived site/tracker counters are saved locally.
6. The popup requests current-site data from the service worker and displays categories, outcomes, and controls.

DNR performs blocking before extension JavaScript observes a request. The service worker cannot make a synchronous JavaScript decision to cancel a request; actual blocked status is recorded when Chrome reports a matching block rule. `onRuleMatchedDebug` is principally available for unpacked/developer or policy-installed extensions, so blocked-request counts should be verified in the target installation mode.

## Main files

- `manifest.json`: extension entry points, permissions, and static ruleset registration.
- `background/background.js`: event and popup-message orchestration.
- `background/request-analyzer.js`: defensive request parsing and tracker lookup.
- `background/heuristic-tracker-detection.js`: confidence-based suspicious-request classification.
- `background/risk-engine.js`: centralized `BLOCKED`, `ALLOWED`, and `FLAGGED` policy outcomes.
- `background/rule-manager.js`: dynamic DNR policy reconciliation and exception priorities.
- `tracker-db/trackers.json`: small, original tracker/service catalog.
- `tracker-db/tracker-db.js`: cached domain matching and supported categories.
- `storage/indexedDB.js`: bounded request history and aggregated site/tracker counts.
- `storage/settings.js`: extension policy settings and bounded cross-site observations.
- `popup/`: primary protection controls, activity categories, and tracker details.
- `settings/`: global policy, detection sensitivity, trusted sites, and global blocked domains.
- `rules/rules.json`: bundled static DNR rules.
- `easylist-converter/`: utility for generating supported domain rules from its local list.

The request history is capped at 500 records. Query strings and URL fragments are removed before persistence; heuristic checks use the full in-memory request URL. All data remains in the browser profile.

## Load locally

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode.
3. Select **Load unpacked** and choose this project directory.
4. Open the extension popup on a normal website to inspect activity and adjust site controls.

## Manual verification

Test on ordinary sites and sites that load known analytics/ad services. Check category grouping, blocked/allowed/flagged outcomes, global and per-site switches, trust/allow exceptions, global domain blocking, navigation badge resets, and settings after restarting the service worker. DNR reporting and rule limits vary by Chrome version and extension installation mode; validate those in the target browser.