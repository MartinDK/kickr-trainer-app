// src/bluetooth/trainer.js

// Wahoo Proprietary Service & Characteristic UUIDs (2016 / Gen 2 KICKR)
export const WAHOO_SERVICE_UUID = "a026e001-0a7d-4ab3-97fa-f1500f9feb8b";
export const WAHOO_TRAINER_CHAR_UUID = "a026e005-0a7d-4ab3-97fa-f1500f9feb8b";

// Standard Cycling Power Service (for power and cadence telemetry)
export const CYCLING_POWER_SERVICE_UUID = 0x1818;
export const CYCLING_POWER_MEASUREMENT_UUID = 0x2a63;

export const UNLOCK_COMMAND = new Uint8Array([0x20, 0xee, 0xfc]);
export const RESISTANCE_MAX_RAW = 16383;

export function hexLog(uint8Array) {
  return Array.from(uint8Array)
    .map((b) => "0x" + b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

export function encodeResistance(percent) {
  const fraction = 1 - percent / 100;
  return Math.max(
    0,
    Math.min(RESISTANCE_MAX_RAW, Math.round(fraction * RESISTANCE_MAX_RAW)),
  );
}

export function buildResistancePacket(percent) {
  const raw = encodeResistance(percent);
  const buffer = new ArrayBuffer(3);
  const view = new DataView(buffer);
  view.setUint8(0, 0x40); // 2016 Resistance Opcode
  view.setUint16(1, raw, true);
  return { payload: new Uint8Array(buffer), raw };
}

export async function unlockTrainer(characteristic) {
  try {
    await characteristic.writeValueWithoutResponse(UNLOCK_COMMAND);
    console.log("2016 KICKR unlocked via proprietary opcode 0x20 0xEE 0xFC.");
  } catch (error) {
    console.error("Failed to unlock 2016 KICKR:", error);
    throw error;
  }
}

export async function setTrainerResistance(characteristic, percent) {
  if (!characteristic) {
    throw new Error("Trainer characteristic not initialized");
  }
  const { payload, raw } = buildResistancePacket(percent);
  await characteristic.writeValueWithResponse(payload);
  return { payload, raw };
}
