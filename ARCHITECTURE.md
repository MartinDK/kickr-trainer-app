# Training Hub: Architecture

A browser app (plain ES modules, no bundler) that connects to a Wahoo Kickr trainer, Assioma pedals and an HR strap over Web Bluetooth, runs workouts, shows live telemetry, and uploads rides to Intervals.icu.

Some module descriptions below are inferred from how other files import them. Modules marked *(inferred)* were not read in full, so check them before relying on the details.

## Module map

| File | Responsibility |
|---|---|
| `main.js` | Entry point. Wires DOM events, restores saved settings, first render, starts the 1 Hz tick. Contains no feature logic. |
| `state.js` | Shared state objects (`ride`, `telemetry`, `workout`, `control`, `devices`, `presets`, `sliders`, `demo`, `runtime`), constants (`MODES`, `FTP_RANGE`, `HISTORY_SECONDS`, `CANVAS_FONT`, ...), `store` (saved settings), and small helpers (`$`, `clamp`, `average`, `formatTime`, `formatGrade`). Imports nothing from the app. |
| `trainer.js` | Wahoo control commands (ERG, resistance, level, sim), setting and sending targets, mode tabs, sliders, preset rendering and editing, `selectPreset` / `adjustPreset`. |
| `workout.js` *(inferred)* | Workout file loading, playback (`advanceWorkout`), `workoutValueAt`, workout rendering, CSV export. |
| `bluetooth.js` *(inferred)* | Device connection, incoming data, demo data, history sampling (`recordHistorySample`), live readouts (`renderLive`), wake lock. |
| `metrics.js` | NP, TSS and W'bal calculation (`updatePowerMetrics`) and their rendering. |
| `hrv.js` | HRV time-domain metrics and DFA a1 (`dfaAlpha1`, `renderHrv`). |
| `charts.js` | Canvas drawing for the Live Telemetry chart (`drawPowerChart`): power and HR series, workout profile and playhead, axes. Text style comes from `CANVAS_FONT` in `state.js`. |
| `intervals.js` | Intervals.icu credentials and upload. Builds a FIT file with an `Alpha1` developer field for DFA a1. |
| `shortcuts.js` | Keyboard bindings for preset selection and adjustment. |
| `cockpit.js` | Helpers that drive the cockpit tiles: interval countdown, target deviation bar, DFA gauge, W'bal bar. |
| `ui/ui.js` *(inferred)* | `log`, `showModal`, `hideModal`, `withBusy`, `countPacket`. |
| `cockpit.html` / `cockpit.css` | Markup and styling of the ride cockpit tiles. |

## Data flow

```
Bluetooth / demo data
        |
        v
  telemetry, ride  (state.js)  <---- trainer.js sets ride.target
        |
        v
  tick() in main.js, once per second
    1. update ride.seconds and ride.intervalSeconds (only while a device is connected)
    2. advanceWorkout()          sets the target, resets the interval clock on segment change
    3. generateDemoData()
    4. recordHistorySample()     feeds the chart and telemetry.fullRideLog
    5. renderLive()              writes all live readouts, calls the cockpit helpers
        |
        +--> cockpit.js          interval countdown, deviation bar, DFA gauge, W'bal bar
        +--> metrics.js          renderPowerMetrics()
        +--> hrv.js              renderHrv()
        +--> charts.js           drawPowerChart()
```

`telemetry.fullRideLog` is the permanent record of the ride. The Intervals.icu upload and the CSV export both read it. A row holds `elapsedSeconds`, `pedals`, `trainer`, `target`, `np`, `tss`, `wPrimeBal`, `hr`, `cadence` and `dfaA1`.

## Where to make a change

| I want to... | Edit |
|---|---|
| Change a keyboard shortcut or step size | `KEY_ROWS` / `MODE_CONFIG` in `shortcuts.js` |
| Add shortcuts for another trainer mode | Add a line to `MODE_CONFIG` in `shortcuts.js` |
| Change what happens when a preset is selected | `selectPreset` in `trainer.js` |
| Add or change a trainer command | `commands` in `trainer.js` |
| Change the cockpit layout or colours | `cockpit.html` and `cockpit.css` |
| Change how a cockpit bar or gauge behaves | The matching `update...` function in `cockpit.js` |
| Change DFA a1 scale or zone names | `updateDfa` in `cockpit.js` and the gauge CSS (`.dfa-*`) |
| Change what is uploaded to Intervals.icu | `buildFitPayload` in `intervals.js` |
| Change the FIT SDK version | `FIT_SDK_URL` in `intervals.js` |
| Change NP, TSS or W'bal maths | `updatePowerMetrics` in `metrics.js` |
| Change HRV or DFA calculation | `hrv.js` |
| Change the chart's text size or typeface | `CANVAS_FONT` in `state.js` |
| Change chart margins (for example if axis labels clip) | `padLeft` / `padRight` / `padTop` / `padBottom` in `drawPowerChart` |
| Change chart line colours, dashes or series | the `drawSeries(...)` calls in `charts.js` |
| Change chart axis ranges or grid line count | `topPower` / `topHr` and the `i <= 4` loops in `charts.js` |
| Add a new button or input handler | The matching section in `main.js` |
| Change the tick order or rate | `tick()` at the bottom of `main.js` |
| Add a saved setting | `loadSetting` pattern in `main.js`, plus `store` in `state.js` |

## State reference (`state.js`)

State is a set of plain mutable objects shared by reference. Modules change them directly and then call a render function. Nothing watches them for changes, so a state change that isn't followed by a render won't show on screen until the next tick.

| Object | What it holds |
|---|---|
| `devices` | The trainer, HR strap and pedals: connection `state`, `demo` flag, Bluetooth handles, battery element id. |
| `control` | Control panel: `viewMode` (tab being viewed), `activeMode` (last sent to trainer), sim parameters, send timer and status line. |
| `ride` | Ride clock `seconds`, `intervalSeconds`, current `target` `{ kind, value }`, `targetSource`, `startedAt`. |
| `workout` | Loaded workout: `points` `{ t, v }`, `duration`, `elapsed`, `playing`, `mode`, current `segment`, `ftp`, `wPrime`. |
| `telemetry` | Raw sensor data, RR beats and artifact state, `history` (rolling chart samples), `fullRideLog` (whole ride), NP/TSS/W'bal values. |
| `presets` | Preset values per group (`erg`, `resistance`), saved in `store`. |
| `sliders` | Slider and readout elements. The sim slider's key is `grade`, but its mode is `sim`. |
| `demo`, `runtime` | Demo-mode simulation state; packet counter and wake lock. |

`store` saves settings to localStorage under `trainingHub.<key>`. It never throws, so a blocked or corrupt store silently falls back to defaults.

## Conventions and gotchas

- **Element IDs are the contract between HTML and JS.** Renaming an ID in `cockpit.html` needs the same rename in `cockpit.js` and `renderLive`. A wrong ID throws at runtime.
- **Names are case-sensitive.** A lowercased file breaks imports with "does not provide an export named ..." errors.
- **`ride.target`** holds the current target as `{ kind, value }`. Only `kind === "erg"` values are watts. `ride.targetSource` is `"manual"` or `"workout"`.
- **`ride.intervalSeconds`** is reset in three places: when a workout segment changes (`advanceWorkout`), when a manual target is committed (`commitManualTarget`), and when sim parameters are transmitted. It only advances while a device is connected.
- **Power source priority is pedals first, Kickr as fallback**, in the ride log and in the Intervals.icu export (`row.pedals ?? row.trainer`). The live NP/TSS source is chosen where `updatePowerMetrics` is called.
- **Manual changes pause the workout.** Moving a slider, pressing a preset or transmitting sim all pause playback.
- **DFA a1 needs at least 64 beats** in the HRV window before it shows a value.
- **Shortcuts follow the visible mode tab** (`control.viewMode`), not the mode active on the trainer (`control.activeMode`). They are ignored while typing in text or number fields and while a preset row is in edit mode.
- **The FIT SDK loads from a CDN at upload time**, pinned to an exact version. It is not part of the page load.
- **Charts size themselves from the displayed canvas size**, so they redraw on window resize. Text size is set in the drawing code (`ctx.font`), and axis margins must be wide enough for the longest label.

## Known loose ends

- **FTP and W' defaults disagree between files.** `state.js` has `FTP_RANGE` 50 to 350 with fallback 250, and `WPRIME_RANGE` fallback 19000. `metrics.js` hard-codes its own fallbacks (236 W and 20000 J) and accepts FTP up to 600. If an input is empty or invalid, `metrics.js` can use different numbers from the rest of the app. Having `metrics.js` read `FTP_RANGE` and `WPRIME_RANGE` would fix it.
- **One time formatter.** Use `formatTime` from `state.js` for all durations. Don't write local ones.
- **`average([])` returns `null`** (no data). Check for `null` before formatting or doing maths with the result.
- **`CANVAS_FONT` lives in `state.js`** but only the chart uses it. If nothing else imports it, it belongs in `charts.js`.
- `drawCanvasMessage` in `charts.js` is defined but never called, and it doesn't set a font. Use it for an empty-state message or delete it.
- The chart's time labels ("-5 min") and the 60 s/300 s history assumption are tied to `HISTORY_SECONDS` in `state.js`, but the "-5 min" label is hard-coded. If you change `HISTORY_SECONDS`, update that label too.
- The chart assumes one history sample per second. If the sampling rate changes, the x mapping in `drawPowerChart` needs to change with it.

- Two upload buttons exist. `btn-upload-intervals` uses `withBusy` for instant feedback. `btn-sync-intervals-now` calls the uploader directly and gives no busy feedback.
- `drawWorkoutChart(currentFtp())` is commented out in the resize handler in `main.js`.
- `metrics.js` reads FTP and W' from the input elements (`ftpInput`, `wPrimeInput`), while `main.js` also stores them on `workout.ftp` and `workout.wPrime`. They are kept in sync by `applyFtp` and `applyWPrime`, but there are two sources of truth.
