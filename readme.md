TODO : interface updates:

- **Advanced Notifications & File Handling:** Implement persistent notifications for workout completion and interval finishes that do not disappear upon the first click. Add options within these notifications to "Save to CSV" and "Send to Intervals.icu."

Summary of Changes Integrated

1. Screen Wake Lock API: Added automatic screen wake lock acquisition upon starting workout playback, with a visibility listener to re-acquire the lock if returning to the tab.
2. Drift-Free High-Precision Timer Loop: Replaced standard setInterval ticking with a requestAnimationFrame loop synced against performance.now().
3. 1Hz CSV & Data Logging Protection: Updated recordSample() to prevent duplicate logs per second and align telemetry samples to actual elapsed workout seconds.
4. Add a workout builder page.
5. Show a ride summary when clicking send to **intervals.icu**
6. Rider profile - training history (Maybe scraped from intervals api).
