Here's what I'd add, in the order I'd do it.

✅ **1. Make the zones do something.** They're display-only right now.
✅ Colouring the chart's steps by zone (or just showing a "Z4" tag on each row) would make them useful.
✅ If you change FTP after editing zones, the zone boundaries and the steps drift apart. I'd store zones as % FTP internally and display watts.
✅ There's also an inconsistency to resolve: steps are in % FTP, but zones are in watts and don't rescale once you've edited them.

**2. Repeat blocks.** Most real workouts are "4 × (5 min hard / 3 min easy)", and right now you have to duplicate rows by hand. A "repeat" control that takes a group of steps and a count would save the most time. It could expand into plain steps on export, so the file format doesn't change.

**3. A workout library.** There is one autosaved workout, so starting a new one overwrites the old one. You need New, Save as, and a list to load or delete. Since the builder and the trainer app share an origin, you could also add a "Send to trainer" button that writes the workout to `localStorage`, so you skip the download and file-load step. That's a bigger win than it sounds.

**4. Import.** You can export `.mrc`/`.erg` but can't open them. Loading an existing file to tweak it would make the builder a real round-trip editor, and it would let you check how your exports parse.

**5. A time axis on the chart.** The chart has watt labels but no time scale, so you can't tell where minute 20 falls. A few time ticks along the bottom would fix that, along with a hover readout of time and power.

**Smaller things:**

- **FTP override bug.** `appFtp` overwrites `W.ftp` on every load, so an FTP you typed into the builder is lost on refresh. Either only use `appFtp` when nothing is saved, or add a "use app FTP" button.
- **Undo/redo.** Deleting a step or a bad paste of values currently can't be undone.
- **Label collisions.** Short ramps put their start and end labels on top of each other, and adjacent short steps can too. A rule to hide or nudge the end label when it would collide would fix this.
- **Enter steps in watts or by zone.** A toggle for power entry, or a "Z4" picker per row, is quicker than typing percentages.
- **Intensity Factor next to TSS.** It's trivial to add, since you already compute normalised power.
- **Validation feedback.** An invalid duration is silently ignored. Highlighting the field would be better.

If I had to pick one, I'd do repeat blocks first because they have the biggest day-to-day payoff, then send-to-trainer. Zone colouring is the easiest of the lot, since the data is already there.
