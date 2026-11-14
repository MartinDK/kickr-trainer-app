// bluetooth.js — Web Bluetooth connections, packet parsing, and demo data generator
import {
  $,
  CHARACTERISTIC,
  HISTORY_SECONDS,
  SERVICE,
  WAHOO_CONTROL_UUID,
  average,
  clamp,
  demo,
  devices,
  formatTime,
  ride,
  runtime,
  telemetry,
  toHex,
  workout,
} from "./state.js";
import { countPacket, log, shouldLogPackets, showModal } from "./ui.js";
import {
  sendActiveTarget,
  setSendStatus,
  targetSummary,
  writeControlBytes,
} from "./trainer.js";
import { applyWorkoutTarget } from "./workout.js";
import { currentDfaAlpha1, renderHrv } from "./hrv.js";
import { drawPowerChart } from "./charts.js";
import { renderPowerMetrics, updatePowerMetrics } from "./metrics.js";

export async function keepScreenAwake() {
  if (
    !("wakeLock" in navigator) ||
    runtime.wakeLock ||
    document.visibilityState !== "visible"
  )
    return;
  if (!Object.values(devices).some((d) => d.state === "connected")) return;
  try {
    runtime.wakeLock = await navigator.wakeLock.request("screen");
    runtime.wakeLock.addEventListener("release", () => {
      runtime.wakeLock = null;
    });
  } catch (err) {
    /* wake lock is optional */
  }
}

export function renderDevice(kind) {
  const d = devices[kind];
  const button = $("btn-" + kind);
  if (!button) return;
  button.classList.toggle(
    "device-button--connected",
    d.state === "connected",
  );
  button.classList.toggle(
    "device-button--connecting",
    d.state === "connecting",
  );
  $("dot-" + kind).className =
    "status-dot" + (d.state === "idle" ? "" : " status-dot--" + d.state);
  $("btnText-" + kind).textContent =
    d.state === "idle"
      ? "Connect"
      : d.state === "connecting"
        ? "Connecting…"
        : "";
  $("name-" + kind).textContent = d.state === "connected" ? d.name : "";
  button.setAttribute(
    "aria-label",
    d.state === "connected"
      ? d.role + ": connected to " + d.name + ". Activate to disconnect."
      : d.state === "connecting"
        ? d.role + ": connecting"
        : "Connect " + d.role,
  );
  if (d.battery && d.state !== "connected") {
    const badge = $(d.battery);
    badge.textContent = "--";
    badge.classList.remove("battery-badge--known");
  }
  if (kind === "trainer")
    $("deviceNameLabel").textContent =
      d.state === "connected" ? d.name : "None";

  const all = Object.values(devices);
  const anyConnected = all.some((x) => x.state === "connected");
  if (anyConnected && !ride.startedAt) ride.startedAt = Date.now();

  $("setupHint").classList.toggle("is-hidden", anyConnected);
  $("demoBadge").classList.toggle(
    "is-hidden",
    !all.some((x) => x.state === "connected" && x.demo),
  );
  $("modeTabList").classList.toggle(
    "mode-tab-list--trainer-connected",
    devices.trainer.state === "connected",
  );
  if (anyConnected) keepScreenAwake();
  else if (runtime.wakeLock) runtime.wakeLock.release().catch(() => {});
}

export function resetDevice(kind) {
  const d = devices[kind];
  if (d.device) d.device.ongattserverdisconnected = null;
  Object.assign(d, {
    state: "idle",
    demo: false,
    device: null,
    control: null,
    name: "",
    closing: false,
  });
  if (kind === "hr") {
    telemetry.heartRate = null;
    telemetry.lastGoodRr = null;
    telemetry.gapPending = true;
    $("liveRrDisplay").textContent = "--";
  } else {
    telemetry.power[kind] = [];
    telemetry.crank[kind] = null;
    telemetry.cadence[kind] = null;
  }
  renderDevice(kind);
  if (kind === "trainer") {
    setSendStatus(
      "Trainer not connected. " +
        targetSummary() +
        " will be sent when it connects.",
      "idle",
    );
  }
  renderLive();
}

export async function connectDevice(kind) {
  const d = devices[kind];
  if (d.state === "connecting") return;
  if (d.state === "connected") {
    showModal(
      "Disconnect " + d.role + "?",
      d.name + " will stop sending data to this dashboard.",
      {
        label: "Disconnect",
        dismissLabel: "Keep connected",
        run: () => disconnectDevice(kind),
      },
    );
    return;
  }
  if (!navigator.bluetooth) {
    offerDemo(
      "This browser does not support Web Bluetooth. Use Chrome, Edge or Opera on desktop or Android to pair real devices.",
    );
    return;
  }

  d.state = "connecting";
  renderDevice(kind);
  log("Scanning for " + d.role + "...", "info");
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [d.service] }],
      optionalServices: [SERVICE.battery],
    });
    d.device = device;
    d.name = device.name || d.role;
    device.ongattserverdisconnected = () => handleDisconnected(kind);
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(d.service);

    if (kind === "hr") {
      const measurement = await service.getCharacteristic(
        CHARACTERISTIC.heartRateMeasurement,
      );
      measurement.oncharacteristicvaluechanged = (event) =>
        handleHeartRatePacket(event.target.value);
      await measurement.startNotifications();
    } else {
      const measurement = await service.getCharacteristic(
        CHARACTERISTIC.powerMeasurement,
      );
      measurement.oncharacteristicvaluechanged = (event) =>
        handlePowerPacket(kind, event.target.value);
      await measurement.startNotifications();
    }
    if (kind === "trainer") await setupTrainerControl(service);
    if (d.battery) await readBattery(kind, server);

    d.state = "connected";
    d.demo = false;
    renderDevice(kind);
    log("Connected: " + d.name, "success");
    if (kind === "trainer") onTrainerReady();
    renderLive();
  } catch (err) {
    const device = d.device;
    if (device) {
      device.ongattserverdisconnected = null;
      if (device.gatt && device.gatt.connected) device.gatt.disconnect();
    }
    resetDevice(kind);
    if (err.name === "NotFoundError") {
      log(d.role + ": no device selected (" + err.message + ")", "warning");
    } else if (
      err.name === "SecurityError" ||
      err.name === "NotAllowedError"
    ) {
      offerDemo(
        "Bluetooth access is blocked on this page (" + err.message + ").",
      );
    } else {
      log(d.role + " connection failed: " + err.message, "error");
      showModal("Connection failed", d.role + ": " + err.message);
    }
  }
}

async function setupTrainerControl(service) {
  const trainer = devices.trainer;
  try {
    trainer.control = await service.getCharacteristic(WAHOO_CONTROL_UUID);
    try {
      trainer.control.oncharacteristicvaluechanged = (event) =>
        handleControlResponse(event.target.value);
      await trainer.control.startNotifications();
    } catch (err) {
      /* responses are optional */
    }
    await writeControlBytes([0x20, 0xee, 0xfc]);
    countPacket();
    log("Unlock sequence sent [0x20, 0xEE, 0xFC]", "success");
    await new Promise((r) => setTimeout(r, 500));
  } catch (err) {
    trainer.control = null;
    log(
      "Wahoo control characteristic unavailable (" +
        err.message +
        "). Power is read only.",
      "warning",
    );
  }
}

async function readBattery(kind, server) {
  try {
    const service = await server.getPrimaryService(SERVICE.battery);
    const level = await (
      await service.getCharacteristic(CHARACTERISTIC.batteryLevel)
    ).readValue();
    const badge = $(devices[kind].battery);
    badge.textContent = level.getUint8(0) + "%";
    badge.classList.add("battery-badge--known");
  } catch (err) {
    log(devices[kind].role + ": battery level not available.", "system");
  }
}

export function disconnectDevice(kind) {
  const d = devices[kind];
  if (d.state !== "connected") return;
  d.closing = true;
  if (d.device && d.device.gatt.connected) d.device.gatt.disconnect();
  else handleDisconnected(kind);
}

function handleDisconnected(kind) {
  const d = devices[kind];
  if (d.state !== "connected") return;
  const name = d.name;
  const requested = d.closing;
  resetDevice(kind);
  log(
    requested
      ? d.role + " disconnected (" + name + ")."
      : d.role +
          " connection lost (" +
          name +
          "). Tap " +
          d.role +
          " to reconnect.",
    requested ? "warning" : "error",
  );
}

function connectDemoDevice(kind) {
  const d = devices[kind];
  Object.assign(d, {
    state: "connected",
    demo: true,
    device: null,
    control: null,
    name: d.demoName,
  });
  renderDevice(kind);
  log("Demo " + d.role + " connected. Its values are simulated.", "warning");
  if (kind === "trainer") onTrainerReady();
}

export function startDemo() {
  Object.keys(devices).forEach((kind) => {
    if (devices[kind].state === "idle") connectDemoDevice(kind);
  });
  renderLive();
}

function offerDemo(reason) {
  log(reason, "warning");
  showModal(
    "Bluetooth unavailable",
    reason + " You can explore the dashboard with simulated data instead.",
    { label: "Use demo data", run: startDemo },
  );
}

function onTrainerReady() {
  workout.lastSent = "";
  if (workout.playing) applyWorkoutTarget();
  else sendActiveTarget();
}

function handleControlResponse(view) {
  countPacket();
  const rejected = view.byteLength >= 3 && view.getUint8(2) === 0x40;
  log(
    "RX control response [" +
      toHex(view) +
      "]" +
      (rejected ? " rejected by trainer" : ""),
    rejected ? "warning" : "data",
  );
  if (rejected)
    setSendStatus(
      "Trainer rejected command 0x" +
        view.getUint8(1).toString(16) +
        ". See the Bluetooth log.",
      "warn",
    );
}

function handlePowerPacket(kind, view) {
  countPacket();
  if (view.byteLength < 4) return;
  const flags = view.getUint16(0, true);
  const watts = view.getInt16(2, true);
  let offset = 4;
  if (flags & 0x01) offset += 1;
  if (flags & 0x04) offset += 2;
  if (flags & 0x10) offset += 6;
  let rpm;
  if (flags & 0x20 && view.byteLength >= offset + 4) {
    const revolutions = view.getUint16(offset, true);
    const eventTime = view.getUint16(offset + 2, true);
    const previous = telemetry.crank[kind];
    if (previous) {
      const revolutionDelta = (revolutions - previous.revolutions) & 0xffff;
      const timeDelta = (eventTime - previous.eventTime) & 0xffff;
      if (revolutionDelta > 0 && timeDelta > 0)
        rpm = (revolutionDelta * 60 * 1024) / timeDelta;
    }
    telemetry.crank[kind] = { revolutions, eventTime };
  }
  if (shouldLogPackets()) {
    log(
      "RX " +
        devices[kind].role +
        " power " +
        watts +
        " W" +
        (rpm !== undefined ? ", " + Math.round(rpm) + " rpm" : "") +
        " [" +
        toHex(view) +
        "]",
      "data",
    );
  }
  recordPower(kind, watts, rpm);
}

export function recordPower(kind, watts, rpm) {
  const now = Date.now();
  const samples = telemetry.power[kind];
  samples.push({ t: now, w: watts });
  while (samples.length && now - samples[0].t > 3000) samples.shift();
  if (rpm !== undefined && rpm < 250)
    telemetry.cadence[kind] = { rpm, at: now };
}

function handleHeartRatePacket(view) {
  countPacket();
  if (view.byteLength < 2) return;
  const flags = view.getUint8(0);
  const wide = flags & 0x01;
  const bpm = wide ? view.getUint16(1, true) : view.getUint8(1);
  let offset = wide ? 3 : 2;
  if (flags & 0x08) offset += 2;
  const intervals = [];
  if (flags & 0x10) {
    for (; offset + 1 < view.byteLength; offset += 2)
      intervals.push((view.getUint16(offset, true) * 1000) / 1024);
  }
  if (shouldLogPackets()) {
    log(
      "RX HR " +
        bpm +
        " bpm" +
        (intervals.length
          ? ", RR " + intervals.map((rr) => Math.round(rr)).join("/") + " ms"
          : "") +
        " [" +
        toHex(view) +
        "]",
      "data",
    );
  }
  recordHeartRate(bpm, intervals);
}

export function recordHeartRate(bpm, intervals) {
  const now = Date.now();
  telemetry.heartRate = { bpm, at: now };
  for (const rr of intervals) {
    const reference = telemetry.lastGoodRr;
    const outOfRange = rr < 300 || rr > 2000;
    const jump =
      reference !== null && Math.abs(rr - reference) / reference > 0.2;
    if (outOfRange || (jump && telemetry.rejectStreak < 5)) {
      telemetry.rejected.push(now);
      telemetry.rejectStreak++;
      telemetry.gapPending = true;
    } else {
      telemetry.beats.push({
        t: now,
        rr,
        afterGap: telemetry.gapPending,
      });
      telemetry.lastGoodRr = rr;
      telemetry.gapPending = false;
      telemetry.rejectStreak = 0;
      $("liveRrDisplay").textContent = Math.round(rr);
    }
  }
}

export function averagePower(kind, now) {
  if (devices[kind].state !== "connected") return null;
  const recent = telemetry.power[kind].filter(
    (sample) => now - sample.t <= 3000,
  );
  return recent.length ? average(recent.map((sample) => sample.w)) : null;
}

function currentCadence(now) {
  for (const kind of ["pedals", "trainer"]) {
    const cadence = telemetry.cadence[kind];
    if (devices[kind].state === "connected" && cadence) {
      return {
        rpm: now - cadence.at < 3000 ? Math.round(cadence.rpm) : 0,
        source: kind === "pedals" ? "pedals" : "Kickr",
      };
    }
  }
  return null;
}

function renderPowerReadout(kind, watts) {
  const prefix = kind === "trainer" ? "trainerPower" : "pedalPower";
  const d = devices[kind];
  $(prefix + "Display").textContent =
    watts === null ? "--" : Math.round(watts);
  $(prefix + "Sub").textContent =
    d.state !== "connected"
      ? "not connected"
      : watts === null
        ? "waiting for data"
        : d.demo
          ? "demo data"
          : "live";
}

export function renderLive(now = Date.now()) {
  const trainerWatts = averagePower("trainer", now);
  const pedalWatts = averagePower("pedals", now);
  renderPowerReadout("trainer", trainerWatts);
  renderPowerReadout("pedals", pedalWatts);

  if (trainerWatts !== null && pedalWatts !== null) {
    const delta = pedalWatts - trainerWatts;
    const sign = delta > 0 ? "+" : "";
    $("deltaDisplay").textContent = sign + Math.round(delta);
    $("deltaSub").textContent =
      trainerWatts > 0
        ? sign + ((delta / trainerWatts) * 100).toFixed(1) + " % vs Kickr"
        : "\u00a0";
  } else {
    $("deltaDisplay").textContent = "--";
    $("deltaSub").textContent = "\u00a0";
  }

  const cadence = currentCadence(now);
  $("liveCadenceDisplay").textContent = cadence ? cadence.rpm : "--";

  const heartRate = telemetry.heartRate;
  const heartRateText =
    devices.hr.state === "connected" && heartRate && now - heartRate.at < 5000
      ? heartRate.bpm
      : "--";
  $("topHrDisplay").textContent = heartRateText;
  $("liveHrDisplay").textContent = heartRateText;

  $("totalTimeDisplay").textContent = formatTime(ride.seconds);
  $("intervalTimeDisplay").textContent = formatTime(ride.intervalSeconds);

  renderPowerMetrics();
  renderHrv(now);
  drawPowerChart();
}

export function recordHistorySample(now, elapsedSeconds = 1) {
  if (
    devices.trainer.state !== "connected" &&
    devices.pedals.state !== "connected" &&
    devices.hr.state !== "connected"
  )
    return;
  const rounded = (value) => (value === null ? null : Math.round(value));

  let currentHr = null;
  if (telemetry.heartRate && now - telemetry.heartRate.at < 5000) {
    currentHr = telemetry.heartRate.bpm;
  }

  const trainer = rounded(averagePower("trainer", now));
  const pedals = rounded(averagePower("pedals", now));
  const target = ride.target.kind === "erg" ? ride.target.value : null;
  const hr = rounded(currentHr);
  const cadenceObj = currentCadence(now);
  const primaryPower = pedals !== null ? pedals : trainer;

  // Update NP, TSS, and W' Balance
  updatePowerMetrics(primaryPower, elapsedSeconds);

  telemetry.history.push({ trainer, pedals, target, hr });
  if (telemetry.history.length > HISTORY_SECONDS) telemetry.history.shift();

  // Record full-ride sample for CSV & Intervals.icu TCX export
  telemetry.fullRideLog.push({
    elapsedSeconds: Math.round(ride.seconds),
    formattedTime: formatTime(ride.seconds),
    pedals,
    trainer,
    target,
    np: telemetry.normalizedPower !== null ? Math.round(telemetry.normalizedPower) : null,
    tss: telemetry.tss,
    wPrimeBal: telemetry.wPrimeBalance,
    hr,
    cadence: cadenceObj ? cadenceObj.rpm : null,
    dfaA1: currentDfaAlpha1(now),
  });
}

function demoRiderPower() {
  const { kind, value } = ride.target;
  if (kind === "erg") return value;
  if (kind === "resistance") return 60 + value * 3.2;
  if (kind === "level") return 90 + value * 28;
  return clamp(170 + value * 18, 40, 450);
}

export function generateDemoData(now) {
  const isDemo = (kind) =>
    devices[kind].state === "connected" && devices[kind].demo;
  const riderPower = demoRiderPower();
  if (isDemo("trainer")) {
    countPacket();
    recordPower(
      "trainer",
      Math.max(0, Math.round(riderPower + (Math.random() - 0.5) * 12)),
    );
  }
  if (isDemo("pedals")) {
    countPacket();
    const cadence =
      88 + Math.sin(now / 15000) * 4 + (Math.random() - 0.5) * 2;
    recordPower(
      "pedals",
      Math.max(0, Math.round(riderPower * 1.02 + (Math.random() - 0.5) * 16)),
      cadence,
    );
  }
  if (isDemo("hr")) {
    countPacket();
    const settledHeartRate = clamp(88 + riderPower * 0.3, 60, 185);
    demo.heartRate +=
      (settledHeartRate - demo.heartRate) * 0.03 +
      (Math.random() - 0.5) * 0.4;
    demo.beatClock += 1000;
    const intervals = [];
    while (demo.beatClock >= demo.nextRr) {
      demo.beatClock -= demo.nextRr;
      intervals.push(demo.nextRr);
      demo.rrDrift = demo.rrDrift * 0.9 + (Math.random() - 0.5) * 6;
      demo.nextRr =
        60000 / demo.heartRate + demo.rrDrift + (Math.random() - 0.5) * 4;
    }
    recordHeartRate(Math.round(demo.heartRate), intervals);
  }
  if (
    shouldLogPackets() &&
    (isDemo("trainer") || isDemo("pedals") || isDemo("hr"))
  ) {
    log(
      "Demo packets generated (target " + Math.round(riderPower) + " W).",
      "data",
    );
  }
}
