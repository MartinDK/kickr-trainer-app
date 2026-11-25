// drift.js — per-interval heart-rate table, built from telemetry.fullRideLog.
// Work intervals: HR start vs HR end shows drift. Rest intervals: the same two
// numbers show how far HR fell. Windows scale with each interval's length.
import { $, telemetry } from "./state.js";

const DRIFT = {
  minLength: 25, // seconds: shorter intervals are left out
  maxTargetSpread: 3, // W: target may vary this much and still count as steady
  recoveryRatio: 0.8, // a rest is an interval below this share of the previous one's target
};

const mean = (xs) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// Measuring windows, in seconds into the interval.
// Work: starts halfway in (at most 60 s) and runs to just before the end window (at most 90 s).
// Rest: starts at the beginning (first 10 s at most), so it catches HR just after the effort.
// End window is the last 30% of the interval, at most 30 s.
function windowsFor(length, rest) {
  const endLast = Math.min(30, Math.round(length * 0.3));
  if (rest)
    return { from: 0, to: Math.min(10, Math.round(length * 0.3)), endLast };
  return {
    from: Math.min(60, Math.round(length * 0.5)),
    to: Math.min(90, length - endLast - 1),
    endLast,
  };
}
// HR samples needed to trust a window: 60% of its length, between 3 and 20
const need = (from, to) =>
  Math.max(3, Math.min(20, Math.floor((to - from + 1) * 0.6)));

/** One entry per qualifying interval, in workout order. */
export function computeDrift() {
  const log = telemetry.fullRideLog;
  const last = log.at(-1);
  const liveSeg = last && last.segment !== null ? last.segment : null;

  const byInterval = new Map();
  for (const row of log) {
    if (row.segment === null) continue;
    if (!byInterval.has(row.segment)) byInterval.set(row.segment, []);
    byInterval.get(row.segment).push(row);
  }

  const out = [];
  let prevTarget = null;
  for (const [index, rows] of byInterval) {
    const targets = rows.map((r) => r.target).filter((t) => t !== null);
    const meanTarget = mean(targets);
    const rest =
      prevTarget !== null &&
      meanTarget !== null &&
      meanTarget < prevTarget * DRIFT.recoveryRatio;
    prevTarget = meanTarget;

    const length = rows[0].segElapsed + rows[0].segRemaining;
    if (length < DRIFT.minLength) continue;
    if (!targets.length) continue; // resistance mode: no target to judge steadiness by
    if (Math.max(...targets) - Math.min(...targets) > DRIFT.maxTargetSpread)
      continue;

    const live = index === liveSeg;
    const now = rows[rows.length - 1].segElapsed;
    const w = windowsFor(length, rest);
    const hr = (pick) =>
      rows.filter((r) => pick(r) && r.hr !== null).map((r) => r.hr);
    const startHr = hr((r) => r.segElapsed >= w.from && r.segElapsed <= w.to);
    const endHr = live
      ? hr((r) => r.segElapsed > now - w.endLast)
      : hr((r) => r.segRemaining <= w.endLast);
    const power = rows
      .map((r) => r.pedals ?? r.trainer)
      .filter((p) => p !== null);

    // A live column waits until its two windows no longer overlap
    const ok =
      startHr.length >= need(w.from, w.to) &&
      endHr.length >= need(0, w.endLast) &&
      (!live || now >= w.to + w.endLast);
    const hrStart = ok ? mean(startHr) : null;
    const hrEnd = ok ? mean(endHr) : null;
    out.push({
      index,
      length,
      live,
      rest,
      avgPower: mean(power),
      hrStart,
      hrEnd,
      delta: ok ? hrEnd - hrStart : null,
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

const mmss = (s) =>
  Math.floor(s / 60) + ":" + String(Math.round(s % 60)).padStart(2, "0");
const num = (v) => (v === null ? "–" : String(Math.round(v)));

export function renderDriftTable() {
  const el = $("driftTable");
  if (!el) return;
  const found = computeDrift();
  const cols = found.length ? found : [null]; // null = placeholder column before any interval qualifies

  const head = cols
    .map((c) =>
      c
        ? `<th scope="col">#${c.index}<small>${c.live ? "live" : mmss(c.length)}${c.rest ? " · rest" : ""}</small></th>`
        : `<th scope="col" class="drift-wait" title="Waiting for a steady interval of ${mmss(DRIFT.minLength)} or more">–</th>`,
    )
    .join("");
  const row = (label, value, cls = "") =>
    `<tr><th scope="row">${label}</th>${cols
      .map((c) => `<td class="${cls}">${c ? value(c) : "–"}</td>`)
      .join("")}</tr>`;

  el.innerHTML =
    `<table class="drift-table"><thead><tr><th id="driftTitle" class="drift-title">Interval drift</th>${head}</tr></thead><tbody>` +
    row("Power (W)", (c) => num(c.avgPower)) +
    row("HR start", (c) => num(c.hrStart)) +
    row("HR end", (c) => num(c.hrEnd)) +
    row(
      "Δ HR (bpm)",
      (c) =>
        c.delta === null ? "–" : (c.delta > 0 ? "+" : "") + Math.round(c.delta),
      "drift-delta",
    ) +
    `</tbody></table>`;
}
