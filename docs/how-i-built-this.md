# How this was built

Notes on the engineering method behind Treyni: what the invariants are, why the data model
looks the way it does, how the AI layer is kept honest, and how changes are verified.
Written for a reader who wants to understand the decisions rather than the feature list.

---

## 1. The working method

Every non-trivial change follows the same four steps:

1. **Write the invariant down first.** Not "add a completion panel" but "a skipped item
   must never be recorded as if the user followed the plan."
2. **Find the single source of truth.** If two places can answer the same question, one of
   them is wrong already — they just haven't diverged yet.
3. **Build the smallest verifier that can turn red.** A script, an assertion, a measured
   box. If a rule can't be checked, it isn't a rule.
4. **Produce before/after evidence.** UI work ships with a side-by-side screenshot of the
   same page before and after the change.

This is why the repository carries ~90 scripts under `tools/uitest/` for an app of this
size. They are not ceremony: several of them were written *after* a bug that a screenshot
looked fine in.

## 2. Invariants

These are the rules that other code must not violate, with the reason each one exists.

| Invariant | Why |
| --- | --- |
| A skipped / unclear completion is recorded as *unregistered*, never as "followed the plan". | The data feeds the next prompt. Fabricating compliance makes the AI confidently plan around something that never happened. |
| The next reminder is computed from the date the work **actually happened**, with a guard against landing in the past. | The user may complete a watering three days after the reminder. Scheduling from the tap time silently drifts. |
| Scheduling thresholds are frozen into the reminder when it is generated, and only read afterwards. | Recomputing at completion time makes the schedule depend on today's weather, which is not what the user acted on. |
| Undo restores a whole-row snapshot. | Field-by-field write-back breaks the moment a new column is added. |
| In-scope vs out-of-scope plans stay separate, with one classifier on the server. | One duplicated rule in the client is enough to make the two answers disagree. |
| Repotting immediately recomputes the watering plan. | Pot depth and substrate are direct inputs to the water model. |

## 3. Data model decisions

**JSON columns instead of migrations.** Two features needed new persisted state — the
soil-water account and the frozen scheduling threshold. Both went into
`plant_reminders.meta_json` rather than into new columns. The reasoning: they are
per-reminder derived state with no cross-reminder query needs, so a schema change would buy
nothing and cost a migration on a database that already holds real user data. Where the
data *is* relational (water events, reports, chat messages) it gets real tables — 16 in
total.

**Server owns the prompt inputs.** The client sends identifiers, never assembled knowledge.
The server pulls the relevant knowledge-base slices, the plant's recent activity and the
current reminder state, and composes the prompt. This keeps prompt logic in one place and
means a client update can't silently change what the model sees.

**One source per answer.** "Recent activity" (journals + completed reminders, including what
the user said they actually used) is produced by one module and consumed by both the
next-reminder scheduler and the chat context. Before that, two queries existed and the
chat could say "there's no record of that" while the scheduler had already planned around
it.

## 4. Keeping the AI honest

**The model is a component with a contract.** Each AI feature has a written contract —
what data it receives, what shape it must return, what it must not do — and prompt changes
are reviewed in small blocks against that contract. A clause without a way to verify it
doesn't ship.

**Defensive parsing.** Long Chinese generations occasionally emit *raw newlines inside JSON
strings*, which is invalid JSON. A repair pass handles control characters before parsing;
without it the UI displayed a truncated `{"detail": …` blob instead of a plan.

**Two layers of candidates.** The "what did you actually use?" panel needs concrete options
(fertiliser and pesticide names). Species-level candidates are generated once per species,
asynchronously, with an in-flight lock so concurrent plants of the same species don't
duplicate the work. The per-plan layer is generated with the reminder itself, because only
that plan knows what it will actually ask for. Resolution order at render time:
plan-level → species-level → static fallback table.

**Prompt fingerprints.** Every AI call logs a hash of the system message only. Conversation
history, knowledge chunks and images differ every time — including them would make the
hash meaningless. With the hash, "which prompt is this feature running right now?" is a
query, and a feature showing two hashes means the prompt changed recently.

**Cost and latency as a budget.** Each feature declares a thinking level, sharing the
`max_tokens` allowance with the response. If thinking consumes the budget, the request
retries without thinking rather than failing. Measured per-feature latencies live in the
backend README; the design point was "quality first, but never let the user wait past a
minute."

## 5. Verification

Three complementary tools, because each one alone lies:

| Tool | Catches | Fails at |
| --- | --- | --- |
| `verify-*.js` scripts (server-side) | Scheduling, thresholding, data invariants, API contracts | Anything visual |
| Screenshot pairs (before/after) | Layout and copy regressions a user would notice | Subtle layout truth — a vision model read a two-column layout as one column more than once |
| Render-layer measurement (`boundingClientRect` via the automator) | Overflow, wrapping, real box sizes | Anything about whether the result looks *good* |

Concretely: a two-column option grid had never actually rendered as two columns. Each
candidate was `calc(50% - 7rpx)` wide with a `14rpx` gap, and the two values rounded up to
one pixel over the viewport, so every option wrapped to its own row. Screenshots looked
plausible; measuring `left + width` against the window width proved it. The fix was to stop
using `calc()` + `gap` for that layout and use percentage widths with `space-between`.

Two more verification rules that saved real time:

- **No hardcoded IDs in test scripts.** An early walkthrough script pinned `PLANT_ID = 6`
  and silently broke the first time the database was cleaned. Scripts now resolve a
  suitable plant, create their own fixture, and delete it afterwards.
- **Fixtures own their state.** Scripts that need a particular intermediate state (a
  submitted feedback item, a pending one) create both, rather than hoping the database
  happens to contain the right row.

## 6. Real-device pitfalls worth writing down

The simulator is a Chromium browser; phones are not.

- **WebP variants.** An illustration rendered fine in DevTools and was blank on device: the
  file was VP8X (extended, with alpha), which some phone decoders don't accept. Rule adopted:
  static images ship as PNG.
- **Address discovery.** A phone can't discover the development machine's LAN address. The
  backend now writes its current address into a generated module at boot, the client keeps
  a short candidate list, probes `/health` on failure, switches to whichever answers, tells
  the user, and replays the request. Wi-Fi changes stopped being an outage.
- **Session expiry presented as a network error.** A 401 rendered as "can't reach the
  backend", which sent debugging in the wrong direction for a while. A 401 is now a
  distinct state with its own handling. (For a few weeks it was answered with a silent
  re-login and a replayed request; that went away when the app moved to invite-only
  accounts, because there is nothing to renew silently — the client clears the token and
  returns to the login screen.)
- **`scroll-view` padding.** Padding on a `scroll-view` pushes content without narrowing the
  content box, so children were laid out against the full width and overflowed on the right.
  Padding moved to an inner wrapper.
- **Package budget.** The main package has a 2 MB ceiling. Brand assets are quantized before
  they enter the bundle, and unreferenced files are excluded — an unused logo is still
  shipped weight.

## 7. What I'd do differently

- **Version control from day one.** The project started without git and was put under
  version control at the end of September. Everything above would have been cheaper with
  history: several "what did this look like before?" questions were answered by screenshots
  in a folder rather than by `git log`.
- **Screenshot fixtures earlier.** Test pages were captured with placeholder plants, which
  makes the shots unusable as documentation and forces a re-capture.
- **Write the invariant table sooner.** It exists now because the same class of bug
  (two sources of truth) appeared three times.

## 8. Third-party components

WeChat Mini Program APIs, Express 5, SQLite (`node:sqlite`), `miniprogram-automator` for UI
automation, and the external APIs listed in the main README. Illustrations and the icon set
are generated for this project and quantized for the package budget.
