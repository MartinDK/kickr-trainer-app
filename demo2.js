(() => {
  "use strict";

  // ============================================================
  // HELPERS
  // ============================================================
  const $ = (id) => document.getElementById(id);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const average = (values) =>
    values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const formatGrade = (grade) =>
    (grade >= 0 ? "+" : "") + grade.toFixed(1) + "%";
  const formatTime = (seconds) => {
    const total = Math.max(0, Math.round(seconds));
    return (
      String(Math.floor(total / 60)).padStart(2, "0") +
      ":" +
      String(total % 60).padStart(2, "0")
    );
  };
  const toHex = (view) =>
    Array.from(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      (b) => b.toString(16).padStart(2, "0"),
    ).join(" ");

  // Local storage wrapper
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem("trainingHub." + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (err) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem("trainingHub." + key, JSON.stringify(value));
      } catch (err) {
        /* storage unavailable */
      }
    },
  };

  // ============================================================
  // CONSTANTS + STATE
  // ============================================================
  const WAHOO_CONTROL_UUID = "a026e005-0a7d-4ab3-97fa-f1500f9feb8b";
  const SERVICE = {
    cyclingPower: 0x1818,
    heartRate: 0x180d,
    battery: 0x180f,
  };
  const CHARACTERISTIC = {
    powerMeasurement: 0x2a63,
    heartRateMeasurement: 0x2a37,
    batteryLevel: 0x2a19,
  };
  const SIM_WIND_COEFFICIENT = 0.4;
  const HISTORY_SECONDS = 300;
  const MODES = ["erg", "resistance", "level", "sim"];
  const MODE_NAMES = {
    erg: "ERG",
    resistance: "Resistance",
    level: "Level",
    sim: "Sim grade",
  };
  const HRV_WINDOWS = [30, 60, 120, 300];
  const DEFAULT_PRESETS = {
    erg: [100, 150, 200, 250, 300],
    resistance: [10, 30, 50, 70, 90],
  };
  const CANVAS_FONT =
    "10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

  const devices = {
    trainer: {
      role: "Trainer",
      service: SERVICE.cyclingPower,
      demoName: "KICKR (demo)",
      battery: null,
    },
    hr: {
      role: "HR strap",
      service: SERVICE.heartRate,
      demoName: "Polar H10 (demo)",
      battery: "batteryHr",
    },
    pedals: {
      role: "Pedals",
      service: SERVICE.cyclingPower,
      demoName: "Assioma (demo)",
      battery: "batteryPedals",
    },
  };
  Object.values(devices).forEach((d) =>
    Object.assign(d, {
      state: "idle",
      demo: false,
      device: null,
      control: null,
      name: "",
      closing: false,
    }),
  );

  const control = {
    viewMode: "erg",
    activeMode: "erg",
    sim: { weight: 75, crr: 0.004, grade: 0 },
    sendTimer: null,
    sendStatus: { text: "", tone: "idle" },
  };

  const ride = {
    seconds: 0,
    intervalSeconds: 0,
    target: { kind: "erg", value: 150 },
    targetSource: "manual", // "manual" | "workout"
    fullTelemetryLog: [], // Full ride log recorded continuously
  };

  const workout = {
    points: [],
    unit: "percent",
    name: "",
    duration: 0,
    elapsed: 0,
    playing: false,
    mode: "erg",
    segment: -1,
    lastSent: "",
  };

  const telemetry = {
    power: { trainer: [], pedals: [] },
    crank: { trainer: null, pedals: null },
    cadence: { trainer: null, pedals: null },
    heartRate: null,
    beats: [],
    rejected: [],
    lastGoodRr: null,
    gapPending: false,
    rejectStreak: 0,
    hrvWindow: 120,
    history: [], // Rolling history for 5-minute graph
  };

  const demo = { heartRate: 105, beatClock: 0, nextRr: 570, rrDrift: 0 };

  const presets = {
    erg: { values: loadPresets("erg"), suffix: "W", editing: false },
    resistance: {
      values: loadPresets("resistance"),
      suffix: "%",
      editing: false,
    },
  };

  const sliders = {};
  ["erg", "resistance", "level", "grade"].forEach((key) => {
    sliders[key] = {
      slider: $(key + "Slider"),
      display: $(key + "ValueDisplay"),
    };
  });

  let packetCount = 0;
  let writeChain = Promise.resolve();
  let wakeLock = null;
  let lastTickAt = Date.now();
  let latestDfaA1 = null;

  // ============================================================
  // TERMINAL + MODAL
  // ============================================================
  const shouldLogPackets = () => $("logTelemetryToggle").checked;

  function log(message, type = "system") {
    const output = $("terminalLog");
    if (!output) return;
    const pinnedToBottom =
      output.scrollHeight - output.scrollTop - output.clientHeight < 40;
    const line = document.createElement("div");
    line.className = "terminal-line terminal-line--" + type;
    line.textContent =
      "[" +
      new Date().toLocaleTimeString("en-GB", { hour12: false }) +
      "] " +
      message;
    output.appendChild(line);
    while (output.children.length > 400) output.removeChild(output.firstChild);
    if (pinnedToBottom) output.scrollTop = output.scrollHeight;
  }

  function countPacket() {
    packetCount++;
    $("packetCountLabel").textContent = packetCount + " packets TX/RX";
  }

  function showModal(title, message, action) {
    $("modalTitle").textContent = title;
    $("modalMessage").textContent = message;
    const actions = $("modalActions");
    actions
      .querySelectorAll("[data-modal-extra]")
      .forEach((button) => button.remove());
    if (action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button button--secondary";
      button.dataset.modalExtra = "";
      button.textContent = action.label;
      button.addEventListener("click", () => {
        hideModal();
        action.run();
      });
      actions.prepend(button);
    }
    $("modalDefaultBtn").textContent = action
      ? action.dismissLabel || "Cancel"
      : "Got it";
    $("notificationModal").classList.remove("is-hidden");
    $("modalDefaultBtn").focus();
  }

  function hideModal() {
    $("notificationModal").classList.add("is-hidden");
  }

  // ============================================================
  // DEVICE CONNECTIONS
  // ============================================================
  function renderDevice(kind) {
    const d = devices[kind];
    const button = $("btn-" + kind);
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
    else if (wakeLock) wakeLock.release().catch(() => {});
  }

  function resetDevice(kind) {
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

  async function connectDevice(kind) {
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
        /* write without response fallback */
      }
      await writeControlBytes([0x20, 0xee, 0xfc]);
      countPacket();
      log("Unlock sequence sent [0x20, 0xEE, 0xFC]", "success");
      await delay(500);
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

  function disconnectDevice(kind) {
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

  function startDemo() {
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

  async function keepScreenAwake() {
    if (
      !("wakeLock" in navigator) ||
      wakeLock ||
      document.visibilityState !== "visible"
    )
      return;
    if (!Object.values(devices).some((d) => d.state === "connected")) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } catch (err) {
      /* ignore screen lock failures */
    }
  }

  // ============================================================
  // TRAINER COMMANDS
  // ============================================================
  const u16 = (value) => [value & 0xff, (value >> 8) & 0xff];

  const commands = {
    erg: (watts) => [0x42, ...u16(Math.round(watts))],
    resistance: (percent) => [
      0x40,
      ...u16(Math.round((1 - percent / 100) * 16383)),
    ],
    level: (level) => [0x41, level & 0xff],
    simMode: (weightKg, crr, windCoefficient) => [
      0x43,
      ...u16(Math.round(weightKg * 100)),
      ...u16(Math.round(crr * 1000)),
      ...u16(Math.round(windCoefficient * 1000)),
    ],
    simGrade: (gradePercent) => [
      0x46,
      ...u16(Math.round(((clamp(gradePercent / 100, -1, 1) + 1) * 65535) / 2)),
    ],
  };

  function writeControlBytes(bytes) {
    const characteristic = devices.trainer.control;
    const data = Uint8Array.from(bytes);
    const run = () =>
      characteristic.properties.write ||
      !characteristic.properties.writeWithoutResponse
        ? characteristic.writeValueWithResponse(data)
        : characteristic.writeValueWithoutResponse(data);
    const result = writeChain.then(run);
    writeChain = result.catch(() => {});
    return result;
  }

  function sendTrainerCommand(bytes, summary) {
    const trainer = devices.trainer;
    if (trainer.state !== "connected") {
      setSendStatus(
        "Trainer not connected. " + summary + " will be sent when it connects.",
        "idle",
      );
      return false;
    }
    if (!trainer.demo && !trainer.control) {
      setSendStatus(
        "This trainer does not expose the Wahoo control characteristic, so it cannot be controlled from here.",
        "warn",
      );
      return false;
    }
    countPacket();
    log(
      "TX " +
        summary +
        " [" +
        bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ") +
        "]",
      "data",
    );
    if (trainer.demo) {
      setSendStatus("Demo trainer: " + summary, "ok");
      return true;
    }
    writeControlBytes(bytes).then(
      () => setSendStatus("On trainer: " + summary, "ok"),
      (err) => {
        log("Write failed: " + err.message, "error");
        setSendStatus(
          "The trainer did not accept " + summary + ". See the Bluetooth log.",
          "warn",
        );
      },
    );
    return true;
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

  // ============================================================
  // TARGET + MANUAL CONTROL
  // ============================================================
  function formatTargetValue(kind, value) {
    if (kind === "erg") return value + " W";
    if (kind === "resistance") return value + " %";
    if (kind === "sim") return formatGrade(value);
    return String(value);
  }

  function targetSummary() {
    return (
      MODE_NAMES[ride.target.kind] +
      " " +
      formatTargetValue(ride.target.kind, ride.target.value)
    );
  }

  function setTarget(kind, value, source = "manual") {
    ride.target = { kind, value };
    ride.targetSource = source;
    const fromWorkout = source === "workout";
    const labels = {
      erg: fromWorkout ? "Workout target" : "ERG target",
      resistance: fromWorkout ? "Workout resistance" : "Resistance",
      level: "Level",
      sim: "Sim grade",
    };
    $("targetModeLabel").textContent = labels[kind];
    $("targetDisplay").textContent = formatTargetValue(kind, value);
    renderModeTabs();
  }

  function showControlStatus(text, tone) {
    const status = $("controlStatus");
    status.textContent = text;
    status.className = "control-status control-status--" + tone;
  }

  function setSendStatus(text, tone) {
    control.sendStatus = { text, tone };
    showControlStatus(text, tone);
  }

  function renderModeTabs() {
    MODES.forEach((mode) => {
      const tab = $("tab-" + mode);
      const selected = mode === control.viewMode;
      tab.classList.toggle("mode-tab-button--active", selected);
      tab.classList.toggle(
        "mode-tab-button--on-trainer",
        ride.targetSource === "manual" && mode === control.activeMode,
      );
      tab.setAttribute("aria-pressed", String(selected));
      $("panel-" + mode).classList.toggle("is-hidden", !selected);
    });
  }

  function selectModeTab(mode) {
    control.viewMode = mode;
    renderModeTabs();
    if (ride.targetSource === "manual" && mode === control.activeMode) {
      showControlStatus(control.sendStatus.text, control.sendStatus.tone);
    } else {
      const how =
        mode === "sim"
          ? "press Transmit Sim Parameters"
          : "change a value on this tab";
      showControlStatus(
        "Target stays " + targetSummary() + " until you " + how + ".",
        "idle",
      );
    }
  }

  function sendActiveTarget() {
    const mode = control.activeMode;
    if (mode === "sim") {
      const { weight, crr, grade } = control.sim;
      setTarget("sim", grade);
      if (
        sendTrainerCommand(
          commands.simMode(weight, crr, SIM_WIND_COEFFICIENT),
          "Sim " + weight + " kg, Crr " + crr,
        )
      ) {
        sendTrainerCommand(
          commands.simGrade(grade),
          "Sim grade " + formatGrade(grade),
        );
      }
      return;
    }
    const value = Number(sliders[mode].slider.value);
    setTarget(mode, value);
    sendTrainerCommand(commands[mode](value), targetSummary());
  }

  function commitManualTarget(mode) {
    if (workout.playing)
      pauseWorkout(
        "Manual change: workout paused. Press Resume Workout to hand control back.",
      );
    control.activeMode = mode;
    setTarget(mode, Number(sliders[mode].slider.value));
    clearTimeout(control.sendTimer);
    control.sendTimer = setTimeout(() => {
      ride.intervalSeconds = 0;
      sendActiveTarget();
    }, 200);
  }

  function renderSlider(key) {
    const { slider, display } = sliders[key];
    const value = Number(slider.value);
    const min = Number(slider.min);
    const max = Number(slider.max);
    display.textContent = key === "grade" ? formatGrade(value) : String(value);
    slider.style.setProperty(
      "--slider-fill",
      ((value - min) / (max - min)) * 100 + "%",
    );
    if (presets[key]) markActivePreset(key);
  }

  // ============================================================
  // PRESETS
  // ============================================================
  function loadPresets(key) {
    const fallback = DEFAULT_PRESETS[key];
    const saved = store.get("presets." + key, null);
    const valid =
      Array.isArray(saved) &&
      saved.length === fallback.length &&
      saved.every((v) => Number.isFinite(v));
    return valid ? saved : fallback.slice();
  }

  function renderPresets(key) {
    const preset = presets[key];
    const slider = sliders[key].slider;
    const grid = $(key + "Presets");
    grid.replaceChildren();
    preset.values.forEach((value, index) => {
      if (preset.editing) {
        const input = document.createElement("input");
        input.type = "number";
        input.className = "preset-input";
        input.value = value;
        input.min = slider.min;
        input.max = slider.max;
        input.step = slider.step;
        input.inputMode = "numeric";
        input.setAttribute(
          "aria-label",
          "Preset " + (index + 1) + " in " + preset.suffix,
        );
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") togglePresetEditing(key);
        });
        grid.appendChild(input);
      } else {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "preset-button";
        button.textContent = value + preset.suffix;
        button.addEventListener("click", () => {
          slider.value = value;
          slider.dispatchEvent(new Event("input", { bubbles: true }));
        });
        grid.appendChild(button);
      }
    });
    markActivePreset(key);
  }

  function markActivePreset(key) {
    const preset = presets[key];
    if (preset.editing) return;
    const current = Number(sliders[key].slider.value);
    Array.from($(key + "Presets").children).forEach((button, index) => {
      button.classList.toggle(
        "preset-button--active",
        preset.values[index] === current,
      );
    });
  }

  function togglePresetEditing(key) {
    const preset = presets[key];
    const slider = sliders[key].slider;
    if (preset.editing) {
      const step = Number(slider.step) || 1;
      preset.values = Array.from($(key + "Presets").children).map(
        (input, index) => {
          const entered = Number(input.value);
          if (input.value === "" || !Number.isFinite(entered))
            return preset.values[index];
          return clamp(
            Math.round(entered / step) * step,
            Number(slider.min),
            Number(slider.max),
          );
        },
      );
      store.set("presets." + key, preset.values);
      log("Presets saved for " + key + ": " + preset.values.join(", "), "info");
    }
    preset.editing = !preset.editing;
    const editButton = $(key + "EditBtn");
    editButton.textContent = preset.editing ? "Save presets" : "Edit presets";
    editButton.classList.toggle("button--primary", preset.editing);
    editButton.classList.toggle("button--ghost", !preset.editing);
    renderPresets(key);
    if (preset.editing) $(key + "Presets").firstElementChild.focus();
  }

  // ============================================================
  // WORKOUT PLAYER
  // ============================================================
  function currentFtp() {
    const input = $("ftpInput");
    const entered = Number(input.value);
    return entered >= 50 && entered <= 600
      ? entered
      : Number(input.defaultValue);
  }

  function parseWorkoutFile(text, fileName) {
    const points = [];
    let unit = null;
    let inData = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const upper = line.toUpperCase();
      if (upper.startsWith("[")) {
        inData = upper.startsWith("[COURSE DATA]");
        continue;
      }
      if (inData) {
        const [minutes, value] = line.split(/[\s,;]+/).map(Number);
        if (
          Number.isFinite(minutes) &&
          Number.isFinite(value) &&
          minutes >= 0 &&
          value >= 0
        )
          points.push({ t: minutes * 60, v: value });
      } else if (/^MINUTES\s+PERCENT/.test(upper)) {
        unit = "percent";
      } else if (/^MINUTES\s+WATTS/.test(upper)) {
        unit = "watts";
      }
    }
    points.sort((a, b) => a.t - b.t);
    const duration = points.length ? points[points.length - 1].t : 0;
    if (points.length < 2 || duration <= 0) {
      throw new Error(
        'No usable [COURSE DATA] block was found. Each data line needs minutes and a target value, for example "5.00 80".',
      );
    }
    return {
      points,
      duration,
      unit: unit || (/\.erg$/i.test(fileName) ? "watts" : "percent"),
    };
  }

  function workoutValueAt(time) {
    const points = workout.points;
    if (!points || !points.length) return { value: 0, segment: 0 };
    for (let i = 1; i < points.length; i++) {
      if (time < points[i].t) {
        const from = points[i - 1];
        const to = points[i];
        const ratio = clamp((time - from.t) / (to.t - from.t), 0, 1);
        return { value: from.v + (to.v - from.v) * ratio, segment: i };
      }
    }
    return { value: points[points.length - 1].v, segment: points.length };
  }

  function workoutTargetAt(time) {
    const ftp = currentFtp();
    const { value, segment } = workoutValueAt(time);
    const percent = workout.unit === "percent" ? value : (value / ftp) * 100;
    const watts = workout.unit === "percent" ? (value / 100) * ftp : value;
    return {
      segment,
      percent,
      watts: Math.round(watts),
      resistance: clamp(Math.round(percent), 0, 100),
    };
  }

  function applyWorkoutTarget() {
    if (!workout.points.length) return;
    const target = workoutTargetAt(workout.elapsed);
    const isErg = workout.mode === "erg";
    const value = isErg ? target.watts : target.resistance;
    setTarget(isErg ? "erg" : "resistance", value, "workout");
    const key = workout.mode + ":" + value;
    if (key === workout.lastSent) return;
    workout.lastSent = key;
    if (isErg)
      sendTrainerCommand(commands.erg(value), "Workout ERG " + value + " W");
    else
      sendTrainerCommand(
        commands.resistance(value),
        "Workout resistance " + value + " %",
      );
  }

  function renderWorkout() {
    $("workoutCurrentTime").textContent = formatTime(workout.elapsed);
    $("workoutTotalTime").textContent = formatTime(workout.duration);
    if (workout.points.length) {
      const target = workoutTargetAt(workout.elapsed);
      $("workoutTargetWatts").textContent =
        workout.mode === "erg" ? target.watts + " W" : target.resistance + " %";
      $("workoutTargetPct").textContent = Math.round(target.percent) + "% FTP";
    } else {
      $("workoutTargetWatts").textContent = "-- W";
      $("workoutTargetPct").textContent = "--% FTP";
    }
    drawWorkoutChart();
  }

  function setWorkoutMode(mode, silent) {
    workout.mode = mode;
    workout.lastSent = "";
    $("btnModeErg").classList.toggle("toggle-button--active", mode === "erg");
    $("btnModeRes").classList.toggle("toggle-button--active", mode === "res");
    $("btnModeErg").setAttribute("aria-pressed", String(mode === "erg"));
    $("btnModeRes").setAttribute("aria-pressed", String(mode === "res"));
    $("workoutModeDisplay").textContent =
      mode === "erg" ? "ERG (% FTP)" : "Resistance (% value sent as brake %)";
    if (!silent)
      log("Workout mode: " + $("workoutModeDisplay").textContent, "info");
    if (workout.playing) applyWorkoutTarget();
    renderWorkout();
  }

  function playWorkout() {
    if (!workout.points.length) {
      showModal(
        "No workout loaded",
        "Please load a .mrc or .erg workout file first.",
      );
      return;
    }
    if (workout.elapsed >= workout.duration) workout.elapsed = 0;
    clearTimeout(control.sendTimer);
    workout.playing = true;
    workout.lastSent = "";
    workout.segment = workoutValueAt(workout.elapsed).segment;
    ride.intervalSeconds = 0;

    const playBtn = $("workoutPlayBtn");
    playBtn.textContent = "Pause Workout";
    playBtn.classList.add("button--active");

    log(
      "Workout started/resumed from " +
        formatTime(workout.elapsed) +
        " (" +
        (workout.mode === "erg" ? "ERG" : "resistance") +
        " mode).",
      "success",
    );
    applyWorkoutTarget();
    renderWorkout();
  }

  function pauseWorkout(reason) {
    workout.playing = false;
    const playBtn = $("workoutPlayBtn");
    playBtn.textContent = "Resume Workout";
    playBtn.classList.remove("button--active");
    log(
      reason || "Workout paused at " + formatTime(workout.elapsed) + ".",
      "warning",
    );
  }

  function stopWorkout() {
    workout.playing = false;
    workout.elapsed = 0;
    workout.segment = -1;
    const playBtn = $("workoutPlayBtn");
    playBtn.textContent = "Play Workout";
    playBtn.classList.remove("button--active");
    renderWorkout();
  }

  function advanceWorkout(elapsedSeconds) {
    if (!workout.playing) return;
    workout.elapsed = Math.min(
      workout.duration,
      workout.elapsed + elapsedSeconds,
    );
    const { segment } = workoutValueAt(workout.elapsed);
    if (segment !== workout.segment) {
      workout.segment = segment;
      ride.intervalSeconds = 0;
    }
    applyWorkoutTarget();
    if (workout.elapsed >= workout.duration) {
      workout.playing = false;
      const playBtn = $("workoutPlayBtn");
      playBtn.textContent = "Play Workout";
      playBtn.classList.remove("button--active");
      log("Workout complete. The trainer stays on the last target.", "success");
    }
    renderWorkout();
  }

  async function loadWorkoutFile(file) {
    try {
      const parsed = parseWorkoutFile(await file.text(), file.name);
      Object.assign(workout, parsed, {
        name: file.name,
        elapsed: 0,
        playing: false,
        segment: -1,
        lastSent: "",
      });
      $("workoutTitleDisplay").textContent =
        file.name +
        " · " +
        formatTime(parsed.duration) +
        " · " +
        (parsed.unit === "percent" ? "% FTP" : "watts");
      const playButton = $("workoutPlayBtn");
      playButton.disabled = false;
      playButton.textContent = "Play Workout";
      playButton.classList.replace("button--secondary", "button--primary");
      $("workoutFileLabel").classList.replace(
        "button--primary",
        "button--secondary",
      );
      log(
        "Loaded workout " +
          file.name +
          ": " +
          parsed.points.length +
          " points, " +
          formatTime(parsed.duration) +
          ", values in " +
          (parsed.unit === "percent" ? "% FTP" : "watts") +
          ".",
        "success",
      );
    } catch (err) {
      log("Could not read " + file.name + ": " + err.message, "error");
      showModal("Could not read workout", err.message);
    }
    renderWorkout();
  }

  // ============================================================
  // FULL RIDE CSV EXPORT (TELEMETRY LOG)
  // ============================================================
  function saveWorkoutCsv() {
    if (!ride.fullTelemetryLog.length) {
      showModal(
        "No ride data recorded",
        "Connect a device or start the ride timer to log telemetry data for export.",
      );
      return;
    }
    const headers = [
      "elapsed_seconds",
      "time_formatted",
      "pedal_power_w",
      "trainer_power_w",
      "target_power_w",
      "heart_rate_bpm",
      "dfa_a1",
    ];

    const rows = ride.fullTelemetryLog.map((entry) => [
      entry.elapsedSeconds,
      formatTime(entry.elapsedSeconds),
      entry.pedals !== null ? entry.pedals : "",
      entry.trainer !== null ? entry.trainer : "",
      entry.target !== null ? entry.target : "",
      entry.hr !== null ? entry.hr : "",
      entry.dfaA1 !== null ? entry.dfaA1.toFixed(2) : "",
    ]);

    const csvContent =
      headers.join(",") + "\n" + rows.map((r) => r.join(",")).join("\n") + "\n";
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    link.href = url;
    link.download = `ride_telemetry_${timestamp}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    log(`Exported full ride log (${rows.length} records) to CSV.`, "success");
  }

  // ============================================================
  // TELEMETRY: PACKET PARSING
  // ============================================================
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

  function recordPower(kind, watts, rpm) {
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

  function recordHeartRate(bpm, intervals) {
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

  // ============================================================
  // TELEMETRY: DERIVED VALUES
  // ============================================================
  function averagePower(kind, now) {
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

  function dfaAlpha1(intervals) {
    const count = intervals.length;
    if (count < 64) return null;
    const mean = average(intervals);
    const profile = new Array(count);
    let running = 0;
    for (let i = 0; i < count; i++) {
      running += intervals[i] - mean;
      profile[i] = running;
    }
    const logSizes = [];
    const logFluctuations = [];
    for (let size = 4; size <= 16; size++) {
      const boxes = Math.floor(count / size);
      let squaredResiduals = 0;
      for (let box = 0; box < boxes; box++) {
        let sumX = 0;
        let sumY = 0;
        let sumXY = 0;
        let sumXX = 0;
        for (let k = 0; k < size; k++) {
          const y = profile[box * size + k];
          sumX += k;
          sumY += y;
          sumXY += k * y;
          sumXX += k * k;
        }
        const slope =
          (size * sumXY - sumX * sumY) / (size * sumXX - sumX * sumX);
        const intercept = (sumY - slope * sumX) / size;
        for (let k = 0; k < size; k++) {
          const residual = profile[box * size + k] - (intercept + slope * k);
          squaredResiduals += residual * residual;
        }
      }
      const fluctuation = Math.sqrt(squaredResiduals / (boxes * size));
      if (fluctuation > 0) {
        logSizes.push(Math.log(size));
        logFluctuations.push(Math.log(fluctuation));
      }
    }
    if (logSizes.length < 3) return null;
    const meanX = average(logSizes);
    const meanY = average(logFluctuations);
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < logSizes.length; i++) {
      numerator += (logSizes[i] - meanX) * (logFluctuations[i] - meanY);
      denominator += (logSizes[i] - meanX) ** 2;
    }
    return numerator / denominator;
  }

  function renderHrv(now) {
    const horizon = now - 300000;
    telemetry.beats = telemetry.beats.filter((beat) => beat.t >= horizon);
    telemetry.rejected = telemetry.rejected.filter((t) => t >= horizon);
    const cutoff = now - telemetry.hrvWindow * 1000;
    const beats = telemetry.beats.filter((beat) => beat.t >= cutoff);
    const intervals = beats.map((beat) => beat.rr);

    let meanRr = null;
    let sdnn = null;
    let rmssd = null;
    if (intervals.length >= 2) {
      meanRr = average(intervals);
      sdnn = Math.sqrt(
        intervals.reduce((sum, rr) => sum + (rr - meanRr) ** 2, 0) /
          (intervals.length - 1),
      );
      const squaredDifferences = [];
      for (let i = 1; i < beats.length; i++) {
        if (!beats[i].afterGap)
          squaredDifferences.push((beats[i].rr - beats[i - 1].rr) ** 2);
      }
      if (squaredDifferences.length)
        rmssd = Math.sqrt(average(squaredDifferences));
    }
    latestDfaA1 = dfaAlpha1(intervals);

    $("rrCountDisplay").textContent = beats.length;
    $("rejectedDisplay").textContent = telemetry.rejected.filter(
      (t) => t >= cutoff,
    ).length;
    $("meanRrDisplay").textContent =
      meanRr === null ? "--" : Math.round(meanRr);
    $("sdnnDisplay").textContent = sdnn === null ? "--" : sdnn.toFixed(1);
    $("rmssdDisplay").textContent = rmssd === null ? "--" : rmssd.toFixed(1);
    $("lnRmssdDisplay").textContent =
      rmssd > 0 ? Math.log(rmssd).toFixed(2) : "--";
    $("dfaA1Display").textContent =
      latestDfaA1 === null ? "--" : latestDfaA1.toFixed(2);
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

  function renderLive(now = Date.now()) {
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
    const powerSourceConnected =
      devices.trainer.state === "connected" ||
      devices.pedals.state === "connected";
    $("liveCadenceDisplay").textContent = cadence ? cadence.rpm : "--";
    $("cadenceSub").textContent = cadence
      ? "from " + cadence.source
      : powerSourceConnected
        ? "no crank data yet"
        : "\u00a0";

    const heartRate = telemetry.heartRate;
    const heartRateText =
      devices.hr.state === "connected" && heartRate && now - heartRate.at < 5000
        ? heartRate.bpm
        : "--";
    $("topHrDisplay").textContent = heartRateText;
    $("liveHrDisplay").textContent = heartRateText;

    $("totalTimeDisplay").textContent = formatTime(ride.seconds);
    $("intervalTimeDisplay").textContent = formatTime(ride.intervalSeconds);

    renderHrv(now);
    drawPowerChart();
  }

  function recordHistorySample(now) {
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

    const sample = {
      trainer: rounded(averagePower("trainer", now)),
      pedals: rounded(averagePower("pedals", now)),
      target: ride.target.kind === "erg" ? ride.target.value : null,
      hr: rounded(currentHr),
      dfaA1: latestDfaA1,
      elapsedSeconds: Math.round(ride.seconds),
    };

    // Store in rolling 5-minute graph data
    telemetry.history.push(sample);
    if (telemetry.history.length > HISTORY_SECONDS) telemetry.history.shift();

    // Store in full ride continuous telemetry log for CSV export
    ride.fullTelemetryLog.push(sample);
  }

  // ============================================================
  // DEMO DATA
  // ============================================================
  function demoRiderPower() {
    const { kind, value } = ride.target;
    if (kind === "erg") return value;
    if (kind === "resistance") return 60 + value * 3.2;
    if (kind === "level") return 90 + value * 28;
    return clamp(170 + value * 18, 40, 450);
  }

  function generateDemoData(now) {
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

  // ============================================================
  // CHARTS
  // ============================================================
  function prepareCanvas(canvas) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return null;
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
  }

  function drawCanvasMessage(ctx, width, height, message) {
    ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "#94a3b8";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(message, width / 2, height / 2);
  }

  function drawWorkoutChart() {
    const surface = prepareCanvas($("workoutThumbnailCanvas"));
    if (!surface) return;
    const { ctx, width, height } = surface;
    if (!workout.points.length) {
      drawCanvasMessage(
        ctx,
        width,
        height,
        "Load a .mrc or .erg file to preview the workout",
      );
      return;
    }
    const pad = 10;
    const points = workout.points;
    const ftpValue = workout.unit === "percent" ? 100 : currentFtp();
    const top =
      Math.max(...points.map((point) => point.v), ftpValue) * 1.1 || 1;
    const x = (time) => pad + (time / workout.duration) * (width - pad * 2);
    const y = (value) => height - pad - (value / top) * (height - pad * 2);

    ctx.beginPath();
    ctx.moveTo(x(points[0].t), height - pad);
    points.forEach((point) => ctx.lineTo(x(point.t), y(point.v)));
    ctx.lineTo(x(workout.duration), height - pad);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, pad, 0, height - pad);
    fill.addColorStop(0, "rgba(99, 102, 241, 0.5)");
    fill.addColorStop(1, "rgba(99, 102, 241, 0.08)");
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.beginPath();
    points.forEach((point, index) =>
      index
        ? ctx.lineTo(x(point.t), y(point.v))
        : ctx.moveTo(x(point.t), y(point.v)),
    );
    ctx.strokeStyle = "#818cf8";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();

    const ftpY = Math.round(y(ftpValue)) + 0.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(148, 163, 184, 0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, ftpY);
    ctx.lineTo(width - pad, ftpY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = CANVAS_FONT;
    ctx.fillStyle = "#94a3b8";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText("FTP", width - pad - 2, ftpY - 2);

    const progressX = x(workout.elapsed);
    ctx.fillStyle = "rgba(251, 191, 36, 0.12)";
    ctx.fillRect(pad, pad, progressX - pad, height - pad * 2);
    ctx.strokeStyle = "#fbbf24";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(progressX, pad);
    ctx.lineTo(progressX, height - pad);
    ctx.stroke();
  }

  function drawPowerChart() {
    const surface = prepareCanvas($("powerChart"));
    if (!surface) return;
    const { ctx, width, height } = surface;
    const history = telemetry.history;
    const powerValues = history
      .flatMap((sample) => [sample.trainer, sample.pedals, sample.target])
      .filter((value) => value !== null);
    const hrValues = history
      .map((sample) => sample.hr)
      .filter((value) => value !== null);

    if (!powerValues.length && !hrValues.length) {
      drawCanvasMessage(
        ctx,
        width,
        height,
        "Connect a trainer, pedals or HR strap to see chart",
      );
      return;
    }

    const padLeft = 38;
    const padRight = 38;
    const padTop = 10;
    const padBottom = 20;
    const plotWidth = width - padLeft - padRight;
    const plotHeight = height - padTop - padBottom;

    const topPower = Math.max(
      200,
      Math.ceil(
        (Math.max(200, ...(powerValues.length ? powerValues : [0])) * 1.1) / 50,
      ) * 50,
    );
    const topHr = Math.max(
      160,
      Math.ceil(
        (Math.max(100, ...(hrValues.length ? hrValues : [0])) * 1.1) / 20,
      ) * 20,
    );

    const x = (index) =>
      padLeft +
      plotWidth -
      (history.length - 1 - index) * (plotWidth / (HISTORY_SECONDS - 1));

    const yPower = (value) =>
      padTop + plotHeight - (clamp(value, 0, topPower) / topPower) * plotHeight;

    const yHr = (value) =>
      padTop + plotHeight - (clamp(value, 0, topHr) / topHr) * plotHeight;

    ctx.font = CANVAS_FONT;

    ctx.fillStyle = "#94a3b8";
    ctx.strokeStyle = "rgba(51, 65, 85, 0.55)";
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const value = (topPower / 4) * i;
      const lineY = Math.round(yPower(value)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padLeft, lineY);
      ctx.lineTo(width - padRight, lineY);
      ctx.stroke();
      ctx.fillText(Math.round(value) + "W", padLeft - 6, lineY);
    }

    ctx.textAlign = "left";
    for (let i = 0; i <= 4; i++) {
      const value = (topHr / 4) * i;
      const lineY = Math.round(yHr(value)) + 0.5;
      ctx.fillStyle = "#f43f5e";
      ctx.fillText(Math.round(value) + "bpm", width - padRight + 6, lineY);
    }

    ctx.fillStyle = "#94a3b8";
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    ctx.fillText("-5 min", padLeft, height - 4);
    ctx.textAlign = "right";
    ctx.fillText("now", width - padRight, height - 4);

    const drawSeries = (key, color, dashed, useHrAxis = false) => {
      let penDown = false;
      ctx.beginPath();
      history.forEach((sample, index) => {
        const value = sample[key];
        if (value === null) {
          penDown = false;
          return;
        }
        const chartY = useHrAxis ? yHr(value) : yPower(value);
        if (penDown) ctx.lineTo(x(index), chartY);
        else ctx.moveTo(x(index), chartY);
        penDown = true;
      });
      ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.strokeStyle = color;
      ctx.lineWidth = dashed ? 1.5 : 2;
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.setLineDash([]);
    };

    drawSeries("target", "#818cf8", true, false);
    drawSeries("trainer", "#34d399", false, false);
    drawSeries("pedals", "#fbbf24", false, false);
    drawSeries("hr", "#f43f5e", false, true);

    const avgHr = hrValues.length ? average(hrValues) : null;
    if (avgHr !== null) {
      const avgY = Math.round(yHr(avgHr)) + 0.5;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(244, 63, 94, 0.6)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, avgY);
      ctx.lineTo(width - padRight, avgY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = CANVAS_FONT;
      ctx.fillStyle = "#f43f5e";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText("Avg " + Math.round(avgHr) + " bpm", padLeft + 6, avgY - 2);
    }
  }

  // ============================================================
  // HRV WINDOW + RESET
  // ============================================================
  function setHrvWindow(seconds) {
    telemetry.hrvWindow = seconds;
    HRV_WINDOWS.forEach((option) => {
      const button = $("win-" + option);
      button.classList.toggle("toggle-button--active", option === seconds);
      button.setAttribute("aria-pressed", String(option === seconds));
    });
    renderHrv(Date.now());
  }

  function resetRideData() {
    ride.seconds = 0;
    ride.intervalSeconds = 0;
    ride.fullTelemetryLog = [];
    telemetry.history = [];
    telemetry.beats = [];
    telemetry.rejected = [];
    telemetry.lastGoodRr = null;
    telemetry.gapPending = false;
    telemetry.rejectStreak = 0;
    $("liveRrDisplay").textContent = "--";
    renderLive();
    log(
      "Ride timers, full telemetry log, power trend and HRV data reset.",
      "info",
    );
  }

  // ============================================================
  // MAIN TICK (once per second)
  // ============================================================
  function tick() {
    const now = Date.now();
    const elapsedSeconds = clamp((now - lastTickAt) / 1000, 0, 90);
    lastTickAt = now;
    if (Object.values(devices).some((d) => d.state === "connected")) {
      ride.seconds += elapsedSeconds;
      ride.intervalSeconds += elapsedSeconds;
    }
    advanceWorkout(elapsedSeconds);
    generateDemoData(now);
    recordHistorySample(now);
    renderLive(now);
  }

  // ============================================================
  // EVENT WIRING
  // ============================================================
  $("btn-trainer").addEventListener("click", () => connectDevice("trainer"));
  $("btn-hr").addEventListener("click", () => connectDevice("hr"));
  $("btn-pedals").addEventListener("click", () => connectDevice("pedals"));
  $("btn-demo").addEventListener("click", startDemo);

  MODES.forEach((mode) =>
    $("tab-" + mode).addEventListener("click", () => selectModeTab(mode)),
  );

  Object.keys(sliders).forEach((key) => {
    const slider = sliders[key].slider;
    if (slider) {
      slider.addEventListener("input", () => {
        renderSlider(key);
        if (key === "grade")
          showControlStatus(
            "Sim values changed. Press Transmit Sim Parameters to apply them.",
            "idle",
          );
        else commitManualTarget(key);
      });
    }
  });

  document.querySelectorAll("[data-step-for]").forEach((button) => {
    button.addEventListener("click", () => {
      const slider = $(button.dataset.stepFor);
      if (!slider) return;
      slider.value = clamp(
        Number(slider.value) + Number(button.dataset.step),
        Number(slider.min),
        Number(slider.max),
      );
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });

  Object.keys(presets).forEach((key) => {
    const editBtn = $(key + "EditBtn");
    if (editBtn)
      editBtn.addEventListener("click", () => togglePresetEditing(key));
  });

  ["simWeightInput", "simCrrInput"].forEach((id) => {
    const el = $(id);
    if (el) {
      el.addEventListener("input", () =>
        showControlStatus(
          "Sim values changed. Press Transmit Sim Parameters to apply them.",
          "idle",
        ),
      );
    }
  });

  $("btn-send-sim").addEventListener("click", () => {
    const weight = Number($("simWeightInput").value);
    const crr = Number($("simCrrInput").value);
    if (!(weight >= 30 && weight <= 150) || !(crr >= 0.001 && crr <= 0.02)) {
      showModal(
        "Check sim parameters",
        "Weight must be between 30 and 150 kg, and rolling resistance between 0.001 and 0.02.",
      );
      return;
    }
    if (workout.playing)
      pauseWorkout(
        "Sim transmit: workout paused. Press Resume Workout to hand control back.",
      );
    clearTimeout(control.sendTimer);
    control.sim = {
      weight,
      crr,
      grade: Number(sliders.grade.slider.value),
    };
    control.activeMode = "sim";
    ride.intervalSeconds = 0;
    sendActiveTarget();
  });

  $("workoutFileInput").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) loadWorkoutFile(file);
    event.target.value = "";
  });
  $("workoutPlayBtn").addEventListener("click", () =>
    workout.playing ? pauseWorkout() : playWorkout(),
  );
  $("btn-stop-workout").addEventListener("click", () => {
    stopWorkout();
    log("Workout stopped and rewound.", "info");
  });
  $("btn-save-csv-workout").addEventListener("click", saveWorkoutCsv);
  $("btnModeErg").addEventListener("click", () => setWorkoutMode("erg"));
  $("btnModeRes").addEventListener("click", () => setWorkoutMode("res"));
  $("ftpInput").addEventListener("input", () => {
    const entered = Number($("ftpInput").value);
    if (entered >= 50 && entered <= 600) store.set("ftp", entered);
    workout.lastSent = "";
    renderWorkout();
  });

  HRV_WINDOWS.forEach((seconds) => {
    const winBtn = $("win-" + seconds);
    if (winBtn) winBtn.addEventListener("click", () => setHrvWindow(seconds));
  });
  $("btn-reset-telemetry").addEventListener("click", () => {
    showModal(
      "Reset ride data?",
      "This clears the ride timers, the power trend and the collected RR intervals.",
      { label: "Reset", run: resetRideData },
    );
  });

  $("btn-clear-console").addEventListener("click", () => {
    $("terminalLog").replaceChildren();
    log("Console cleared.");
  });
  $("diagnosticsPanel").addEventListener("toggle", () => {
    const output = $("terminalLog");
    if (output) output.scrollTop = output.scrollHeight;
  });

  $("modalDefaultBtn").addEventListener("click", hideModal);
  $("notificationModal").addEventListener("click", (event) => {
    if (event.target === $("notificationModal")) hideModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideModal();
  });
  document.addEventListener("visibilitychange", keepScreenAwake);
  window.addEventListener("resize", () => {
    drawPowerChart();
    drawWorkoutChart();
  });

  // ============================================================
  // INITIAL RENDER
  // ============================================================
  const savedFtp = store.get("ftp", null);
  if (typeof savedFtp === "number" && savedFtp >= 50 && savedFtp <= 600)
    $("ftpInput").value = savedFtp;

  Object.keys(sliders).forEach(renderSlider);
  Object.keys(presets).forEach(renderPresets);
  Object.keys(devices).forEach(renderDevice);
  setHrvWindow(telemetry.hrvWindow);
  setWorkoutMode("erg", true);
  setTarget("erg", Number(sliders.erg.slider.value));
  setSendStatus(
    "Trainer not connected. " +
      targetSummary() +
      " will be sent when it connects.",
    "idle",
  );
  renderLive();
  if (!navigator.bluetooth)
    log(
      "Web Bluetooth is not available in this browser. Demo data can be used instead.",
      "warning",
    );
  setInterval(tick, 1000);
})();
