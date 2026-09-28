# Screenshots

Captured with `miniprogram-automator` against a live backend, then checked with a vision
pass before being published (the check has already caught a placeholder plant name, a
debug panel leaking a local address, and a text-overflow bug).

| File | Page |
| --- | --- |
| `plant-detail.png` | Plant record with daily reminders and the journal entry point |
| `add-plant.png` | Add a plant — species search, pot/soil/light fields |
| `diagnosis.png` | Photo-based pest & disease diagnosis |
| `chat-opener.png` | AI gardener opening with the plant's context |
| `chat-executed-change.png` | Advice, plus a system bubble echoing an executed schedule change |
| `care-report.png` | Care report entry |

## How these were captured

`tools/uitest/art-check.js` creates a temporary plant, drives the Mini Program through
WeChat DevTools, screenshots each page and deletes the plant afterwards. The fixture is a
fully-filled-in plant (name, cultivar, pot, substrate, light, location, dates) rather than
a placeholder, so the shots read as product documentation. The profile screen is captured
with the development-only debug block switched off.

## Deliberately not published

The garden screen contains real user data, and the reminder-detail screen is being checked
for bottom-edge clipping before it goes in. Both are excluded rather than cropped.
