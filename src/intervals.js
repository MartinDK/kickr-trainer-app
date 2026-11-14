// intervals.js — Free Intervals.icu API activity upload (no paid subscription required)
import { $, ride, store, telemetry, workout } from "./state.js";
import { log, showModal } from "./ui/ui.js";

export function loadIntervalsCredentials() {
  const athleteId = store.get("intervals.athleteId", "");
  const apiKey = store.get("intervals.apiKey", "");
  const idInput = $("intervalsAthleteId");
  const keyInput = $("intervalsApiKey");
  if (idInput) idInput.value = athleteId;
  if (keyInput) keyInput.value = apiKey;
}

export function saveIntervalsCredentials() {
  const athleteId = ($("intervalsAthleteId")?.value || "").trim() || "0";
  const apiKey = ($("intervalsApiKey")?.value || "").trim();
  store.set("intervals.athleteId", athleteId);
  store.set("intervals.apiKey", apiKey);

  const statusEl = $("intervalsStatusMsg");
  if (statusEl) {
    statusEl.textContent = apiKey
      ? "Credentials saved locally."
      : "API key cleared.";
  }
  log(
    "Intervals.icu credentials updated (Athlete ID: " + athleteId + ").",
    "info",
  );
}

/**
 * Generates a standard Garmin TCX XML string from telemetry.fullRideLog.
 * Intervals.icu's /api/v1/athlete/{id}/activities endpoint natively parses .tcx
 * including power (Watts), heart rate (BPM), and cadence (RPM).
 */
function buildTcxPayload() {
  const startTime = ride.startedAt
    ? new Date(ride.startedAt).toISOString()
    : new Date(Date.now() - Math.round(ride.seconds * 1000)).toISOString();

  const trackpoints = telemetry.fullRideLog
    .map((row) => {
      const ts = new Date(
        Date.parse(startTime) + row.elapsedSeconds * 1000,
      ).toISOString();
      const watts = row.pedals ?? row.trainer;
      const hrXml =
        row.hr !== null
          ? `<HeartRateBpm><Value>${Math.round(row.hr)}</Value></HeartRateBpm>`
          : "";
      const cadXml =
        row.cadence !== null && row.cadence !== undefined
          ? `<Cadence>${Math.round(row.cadence)}</Cadence>`
          : "";
      const wattsXml =
        watts !== null && watts !== undefined
          ? `<Extensions><TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2"><Watts>${Math.round(watts)}</Watts></TPX></Extensions>`
          : "";
      return `        <Trackpoint><Time>${ts}</Time>${hrXml}${cadXml}${wattsXml}</Trackpoint>`;
    })
    .join("\n");

  const totalSec = Math.max(1, Math.round(ride.seconds));
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>${startTime}</Id>
      <Lap StartTime="${startTime}">
        <TotalTimeSeconds>${totalSec}</TotalTimeSeconds>
        <DistanceMeters>0</DistanceMeters>
        <Calories>0</Calories>
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
${trackpoints}
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;
}

export async function uploadToIntervalsIcu() {
  if (!telemetry.fullRideLog.length) {
    showModal(
      "No ride data recorded",
      "Record some ride telemetry first before uploading to Intervals.icu.",
    );
    return;
  }

  const athleteId =
    ($("intervalsAthleteId")?.value || "").trim() ||
    store.get("intervals.athleteId", "0");
  const apiKey =
    ($("intervalsApiKey")?.value || "").trim() ||
    store.get("intervals.apiKey", "");

  if (!apiKey) {
    const details = $("diagnosticsPanel");
    if (details) details.open = true;
    showModal(
      "Intervals.icu API Key needed",
      "Enter your free Intervals.icu Athlete ID and API Key in the Diagnostics & Intervals.icu panel below, then click Upload.",
    );
    return;
  }

  const statusEl = $("intervalsStatusMsg");
  if (statusEl) statusEl.textContent = "Uploading to Intervals.icu…";
  log(
    "Uploading ride TCX to Intervals.icu (athlete " + athleteId + ")...",
    "info",
  );

  try {
    const tcxXml = buildTcxPayload();
    const activityName = workout.name
      ? workout.name.replace(/\.[^.]+$/, "")
      : "Indoor Trainer Ride (" + Math.round(telemetry.tss) + " TSS)";

    const formData = new FormData();
    const fileBlob = new Blob([tcxXml], {
      type: "application/vnd.garmin.tcx+xml",
    });
    formData.append("file", fileBlob, activityName + ".tcx");
    formData.append("name", activityName);
    formData.append(
      "description",
      `Uploaded from Training Hub. NP: ${telemetry.normalizedPower ? Math.round(telemetry.normalizedPower) + "W" : "--"}, TSS: ${telemetry.tss.toFixed(1)}`,
    );

    const authHeader = "Basic " + btoa("API_KEY:" + apiKey);
    const response = await fetch(
      `https://intervals.icu/api/v1/athlete/${encodeURIComponent(athleteId)}/activities`,
      {
        method: "POST",
        headers: {
          Authorization: authHeader,
        },
        body: formData,
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `HTTP ${response.status}: ${errText || response.statusText}`,
      );
    }

    const result = await response.json();
    const msg = `Uploaded! Activity ID: ${result.id || "OK"}`;
    if (statusEl) statusEl.textContent = msg;
    log("Intervals.icu upload complete (" + msg + ").", "success");
    showModal(
      "Uploaded to Intervals.icu",
      `Your ride "${activityName}" (${telemetry.tss.toFixed(1)} TSS) has been uploaded to your Intervals.icu calendar.`,
    );
  } catch (err) {
    const msg = "Upload failed: " + err.message;
    if (statusEl) statusEl.textContent = msg;
    log("Intervals.icu " + msg, "error");
    showModal("Intervals.icu Upload Failed", err.message);
  }
}
