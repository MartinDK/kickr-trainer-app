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
