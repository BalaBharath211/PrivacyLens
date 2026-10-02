# Privacy Dashboard

Privacy Dashboard is a browser extension that helps you see when websites load third-party trackers and whether those requests are blocked or allowed.

It watches network activity in the browser, stores the data locally, and shows a simple dashboard with charts and summaries so users can understand what is tracking them.

## What it does

- Detects third-party requests
- Identifies possible trackers
- Tracks which domains are being contacted
- Blocks suspicious tracker domains using dynamic browser rules
- Shows results in a popup and dashboard
- Stores data locally in the browser

## Why this project exists

Many websites load scripts, ads, analytics tools, and other services from other domains. These can be used for tracking user behavior across the web.

This project gives users visibility into that activity and helps them understand which domains are collecting data.

## Main features

- Third-party request detection
- Heuristic tracker detection
- Dynamic blocking of suspicious domains
- Allowlist support
- Blocked vs allowed request tracking
- Dashboard with charts and visualizations
- Local browser storage using IndexedDB

## How it works

1. The browser sends a request to a resource.
2. The extension checks whether the request is coming from a different domain than the current site.
3. If it is a third-party request, it logs the request.
4. The extension checks whether the domain appears across many different sites.
5. If the same tracker appears often enough, it is treated as a likely tracker.
6. The extension can block that tracker dynamically.
7. The details are saved locally and shown in the dashboard.

## Tech stack

- JavaScript
- HTML
- CSS
- Chrome Extension APIs
- IndexedDB
- Chart.js
- D3.js
- Manifest V3

## Project structure

- background/ - browser event listeners and detection logic
- dashboard/ - dashboard UI and charts
- popup/ - quick summary popup
- settings/ - user settings page
- storage/ - local browser database logic
- rules/ - rule definitions
- icons/ - extension icons
- lib/ - third-party libraries
- manifest.json - browser extension configuration

## Installation

1. Open Google Chrome or Microsoft Edge.
2. Go to the extensions page.
3. Enable Developer Mode.
4. Click Load unpacked.
5. Select this project folder.
6. The extension will load and be ready to use.

## Usage

- Click the extension icon in the browser toolbar.
- Open the popup to see a quick summary.
- Open the dashboard for a more detailed view.
- Use settings to toggle heuristic tracking and manage allowlisted domains.

## Notes

This project is a privacy and tracking analysis tool. It is useful for learning, testing, and understanding how tracker behavior works in the browser.

The detection is heuristic-based, which means it tries to infer tracking behavior from patterns rather than relying on a static list only.

## License

This project is provided as-is for learning and experimentation.

## Contributing

You are welcome to improve the extension by:

- improving tracking detection
- adding better privacy controls
- improving the dashboard UI
- fixing bugs and edge cases