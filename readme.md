# ReadMe

#### version 3.0

## TODO :

1. Screen Wake Lock API: Added automatic screen wake lock acquisition upon starting workout playback, with a visibility listener to re-acquire the lock if returning to the tab.
2. Drift-Free High-Precision Timer Loop: Replaced standard setInterval ticking with a requestAnimationFrame loop synced against performance.now().
3. 1Hz CSV & Data Logging Protection: Updated recordSample() to prevent duplicate logs per second and align telemetry samples to actual elapsed workout seconds.
4. Show a ride summary when clicking send to **intervals.icu**
5. Rider profile - training history (Maybe scraped from intervals api).

## Fixed

1. Fix telemetry chart - Only shows 5minutes of graph when a training ride is loaded.
2. Check why DFA 1 isn't uploading to **intervals.icu**
3. Add keyboard shortcuts

## Completed

✅ Add a workout builder page.

### Claude Handoff

Not quite. That summary lists what's left, but a new session also needs how the code is organised and the decisions we made. Paste the handoff below at the start tomorrow. It replaces your old one, so you can drop that. Then add `hrv.js`, which is the first thing the next step needs.

---

**Project: Training Hub**
Web Bluetooth training app for a 2016 KICKR, Polar H10 and Assioma pedals. The user is Martin, he rides with a tablet, and his FTP is 236 W.

**Files:** `index.html`, the Workout Builder (`workout-builder.html`/`.js`/`.css`, exports .mrc/.erg) and, in `src/`: `main.js`, `workout.js`, `state.js`, `bluetooth.js`, `trainer.js`, `metrics.js`, `charts.js`, `audio.js`, `hrv.js` (not yet seen), `drift.js` (new), `ui/ui.js`, `ui/cockpit.js`, `styles.css`, `cockpit.css`.

**Conventions:** all code is ES modules, so nothing is a console global. To inspect state use `const { telemetry } = await import("./src/state.js")`. Elements are found by ID and state classes (`is-hidden`, `mode-tab-button--active`). Settings go through `store.get/set`, which prefixes keys with `trainingHub.` (FTP is `trainingHub.ftp`).

**Done**

- **Cockpit:** the workout card is the Workout tab and opens on load, NP and total time are in the cockpit strip, there's a next-interval button, and the interval tile reads "Interval N of M". The duplicate `updateInterval` and the debug logging are gone, and the Crr buttons are fixed.
- **Builder:** a template picker (endurance, threshold, VO2, FTP ramp, AeT test), with interval numbers on the chart and time markers underneath. FTP ramp: 12-minute warm-up from 120 W to a 140 W first step, then +20 W/min in 1-minute steps, capped at 170% of FTP. AeT test: 10-minute warm-up, 8 blocks of 5 minutes from 60% to 95% of FTP, then a 5-minute cool-down. Starting values are in one `GEN` object.
- **Ride log:** each `telemetry.fullRideLog` row has `segment` (1-based, matching the tile), `segElapsed` and `segRemaining`. They're `null` when the workout is paused or not playing.
- **Drift table (`drift.js`):** columns are intervals, rows are power, HR start, HR end and Δ HR. Intervals qualify if they are 25 s or longer and steady (target spread of 3 W or less). Measuring windows scale with interval length. Rest intervals (target below 0.8 of the previous interval's) are tagged `rest`, and their Δ HR is the fall in HR. A live column redraws every 5 s from `recordHistorySample` in `bluetooth.js`, and `workout.js` redraws it at each interval change, on completion and on stop. `main.js` redraws at load and on ride reset.
- **Test mode:** a button beside "Try demo data" sets `trainingHub.testMode`, and demo data auto-starts on load. A 30-second `drift_test.mrc` is the quick check (three 30 s steps).

**To do, in order**

1. **Smoothed DFA a1 chip.** Use a 2-minute mean of a1, enter "too hard" below 0.72 and leave above 0.78, a 60-90 s dwell, and no verdict during warm-up. Wording like "a1 is 0.62, ease off about 10 W". Bands depend on the session goal, so the goal must be carried in the workout: the Builder writes `Name [goal]` in `DESCRIPTION`, and `parseWorkoutFile` must read it into `workout.goal`. It doesn't yet. Check `hrv.js` first for the a1 window length and artefact handling.
2. **FTP ramp support in the player.** Flag the failure point and record the best 1-minute power. FTP is about 75% of that, shown as a suggestion and never written automatically.
3. **AeT analysis.** Use settled a1 only (more than 2 minutes after each power change), averaged over about 60 s, fitted against power. a1 ≈ 0.75 gives AeT and a1 ≈ 0.50 gives AnT. Report "AeT = X W (Y% of current FTP)" and flag big gaps. It depends on item 1.
4. **Live Δ HR chip** beside the interval tile. It reuses `computeDrift`.
5. **Tablet landscape redesign.** A status bar, a metrics row, a full-width chart and a bottom thumb bar (pause, next interval, ±watts). Setup and mode controls move to a slide-over, and HRV, diagnostics and uploads go in a Review tab. `charts.js` hardcodes colours, so a flat theme through CSS variables would need it to read them.

**Loose ends**

- **Unseen code:** the Intervals.icu upload (check it still works with the new row fields) and `hrv.js`.
- **NP at the start of a ride:** it read about 139 W while riding about 98 W in the first seconds. Probably a rolling-window start-up effect.
- **Drift table:** the 0.8 rest ratio is a guess and needs real-ride tuning. An optional "cold start" flag on interval 1 when there was no warm-up.
- **Housekeeping:** `localStorage.removeItem("trainingHub.driftTest")` once, since the old key is unused.
- **Testing schedule:** ride the FTP ramp first, then the AeT test 48 hours later, and repeat every 6-8 weeks.

---

For tomorrow:

- **Project files:** the project copy of the Builder was older than your running copy. Re-upload `workout-builder.*` if you want it to be the source of truth. `drift.js` isn't in the project at all.
- **First step:** upload or paste `hrv.js` with the handoff, and the a1 chip can start straight away.
