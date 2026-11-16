// intervals.js — Free Intervals.icu API activity upload (no paid subscription required)
import { $, ride, store, telemetry, workout } from "./state.js";
import { log, showModal } from "./ui/ui.js";

// Pin this to the current release (run `npm view @garmin/fitsdk version`).
const FIT_SDK_URL = "https://cdn.jsdelivr.net/npm/@garmin/fitsdk@21.221.0/+esm";

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
 * Builds a FIT activity file from telemetry.fullRideLog.
 * TCX has no field for DFA a1, so we use FIT and write it as a developer
 * field named "Alpha1", which is the name Intervals.icu looks for.
 * Power source priority is unchanged: pedals first, Kickr as fallback.
 */
async function buildFitPayload() {
  const { Encoder, Profile } = await import(FIT_SDK_URL);

  const startMs = ride.startedAt
    ? new Date(ride.startedAt).getTime()
    : Date.now() - Math.round(ride.seconds * 1000);
  const startDate = new Date(startMs);
  const totalSec = Math.max(1, Math.round(ride.seconds));
  const endDate = new Date(startMs + totalSec * 1000);

  // Developer field setup. FIT base type 136 = float32.
  const developerDataIdMesg = {
    developerDataIndex: 0,
    applicationId: [
      0x54, 0x72, 0x61, 0x69, 0x6e, 0x69, 0x6e, 0x67, 0x48, 0x75, 0x62, 0x00,
      0x00, 0x00, 0x00, 0x01,
    ],
  };
  const alpha1Description = {
    developerDataIndex: 0,
    fieldDefinitionNumber: 0,
    fitBaseTypeId: 136,
    fieldName: ["Alpha1"],
    units: [""],
    nativeMesgNum: Profile.MesgNum.RECORD,
  };
  const encoder = new Encoder({
    fieldDescriptions: {
      0: {
        developerDataIdMesg,
        fieldDescriptionMesg: alpha1Description,
      },
    },
  });

  encoder.onMesg(Profile.MesgNum.FILE_ID, {
    type: "activity",
    manufacturer: "development",
    product: 0,
    timeCreated: startDate,
    serialNumber: 1,
  });
  encoder.onMesg(Profile.MesgNum.DEVELOPER_DATA_ID, developerDataIdMesg);
  encoder.onMesg(Profile.MesgNum.FIELD_DESCRIPTION, alpha1Description);

  for (const row of telemetry.fullRideLog) {
    const watts = row.pedals ?? row.trainer;
    const record = {
      timestamp: new Date(startMs + row.elapsedSeconds * 1000),
    };
    if (watts !== null && watts !== undefined) record.power = Math.round(watts);
    if (row.hr !== null && row.hr !== undefined)
      record.heartRate = Math.round(row.hr);
    if (row.cadence !== null && row.cadence !== undefined)
      record.cadence = Math.round(row.cadence);
    if (
      row.dfaA1 !== null &&
      row.dfaA1 !== undefined &&
      Number.isFinite(row.dfaA1)
    )
      record.developerFields = { 0: row.dfaA1 };
    encoder.onMesg(Profile.MesgNum.RECORD, record);
  }

  encoder.onMesg(Profile.MesgNum.LAP, {
    timestamp: endDate,
    startTime: startDate,
    totalElapsedTime: totalSec,
    totalTimerTime: totalSec,
  });
  encoder.onMesg(Profile.MesgNum.SESSION, {
    timestamp: endDate,
    startTime: startDate,
    totalElapsedTime: totalSec,
    totalTimerTime: totalSec,
    sport: "cycling",
    subSport: "indoorCycling",
    firstLapIndex: 0,
    numLaps: 1,
  });
  encoder.onMesg(Profile.MesgNum.ACTIVITY, {
    timestamp: endDate,
    numSessions: 1,
    type: "manual",
    event: "activity",
    eventType: "stop",
  });

  return encoder.close(); // Uint8Array
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
    "Uploading ride FIT to Intervals.icu (athlete " + athleteId + ")...",
    "info",
  );

  try {
    const fitBytes = await buildFitPayload();
    const activityName = workout.name
      ? workout.name.replace(/\.[^.]+$/, "")
      : "Indoor Trainer Ride (" + Math.round(telemetry.tss) + " TSS)";

    const formData = new FormData();
    const fileBlob = new Blob([fitBytes], { type: "application/octet-stream" });
    formData.append("file", fileBlob, activityName + ".fit");
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
