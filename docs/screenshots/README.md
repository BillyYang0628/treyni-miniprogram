# Screenshots

Captured with `miniprogram-automator` against a live backend, then checked with a vision
pass before being published (the check has already caught a placeholder plant name, a
debug panel leaking a local address, and a text-overflow bug).

| File | Page |
| --- | --- |
| `garden.png` | Garden overview — the "what needs doing next" aggregation |
| `plant-detail.png` | Plant record with daily reminders and the journal entry point |
| `reminder-detail.png` | Reminder detail: weather-adjusted plan, soil-water estimate |
| `add-plant.png` | Add a plant — species search, pot/soil/light fields |
| `diagnosis.png` | Photo-based pest & disease diagnosis |
| `chat-opener.png` | AI gardener opening with the plant's context |
| `chat-executed-change.png` | Advice, plus a system bubble echoing an executed schedule change |
| `care-report.png` | Care report entry |

## How these were captured

Two scripts drive WeChat DevTools via `miniprogram-automator`:

- `tools/uitest/art-check.js` walks the product with a temporary plant and deletes it
  afterwards. The fixture is fully filled in (name, cultivar, pot, substrate, light,
  location, dates) rather than a placeholder, and the profile screen is captured with the
  development-only debug block switched off.
- `tools/uitest/shots-portfolio.js` switches the client to a throwaway demo account whose
  garden holds three complete sample plants, so the garden screen shows product data
  instead of the accumulated test plants of a development account. The account and its
  plants are deleted at the end of the run.

Plant photos are the built-in default illustration (the sample plants have no photo
uploaded); the app ships this as its placeholder image.

## Note on the reminder-detail screen

An earlier review flagged the bottom of this page as clipped. It is not: the page is a
plain scrolling `<view>` (not a `scroll-view`), so what looked like truncation is simply
content below the fold.
