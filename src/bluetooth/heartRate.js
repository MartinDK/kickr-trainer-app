export const HEART_RATE_SERVICE_UUID = 0x180d;
export const HEART_RATE_MEASUREMENT_UUID = 0x2a37;
export const BATTERY_SERVICE_UUID = 0x180f;
export const BATTERY_LEVEL_UUID = 0x2a19;

/**
 * Connects to a Polar H10 or BLE Heart Rate strap and enables notifications.
 */
export async function connectHeartRateStrap(onLog) {
  try {
    onLog("Requesting Heart Rate strap via Web Bluetooth...", "info");

    // 1. Prompt user for device matching HR service
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [HEART_RATE_SERVICE_UUID] }],
      optionalServices: [BATTERY_SERVICE_UUID],
    });

    onLog(
      `Connecting to GATT server on ${device.name || "HR Strap"}...`,
      "info",
    );
    const server = await device.gatt.connect();

    // 2. Get Heart Rate Service & Characteristic
    const hrService = await server.getPrimaryService(HEART_RATE_SERVICE_UUID);
    const hrChar = await hrService.getCharacteristic(
      HEART_RATE_MEASUREMENT_UUID,
    );

    // 3. Enable live notifications
    await hrChar.startNotifications();
    onLog("Subscribed to live Heart Rate and RR intervals.", "success");

    // 4. Try reading battery level if available (optional)
    let batteryLevel = null;
    try {
      const batteryService =
        await server.getPrimaryService(BATTERY_SERVICE_UUID);
      const batteryChar =
        await batteryService.getCharacteristic(BATTERY_LEVEL_UUID);
      const value = await batteryChar.readValue();
      batteryLevel = value.getUint8(0);
      onLog(`Strap Battery Level: ${batteryLevel}%`, "info");
    } catch (e) {
      // Battery service optional / unsupported by some firmwares
    }

    return { device, server, hrChar, batteryLevel };
  } catch (error) {
    if (error.name === "NotFoundError") {
      onLog("HR Strap selection cancelled by user.", "warning");
    } else {
      onLog(`HR Strap connection error: ${error.message}`, "error");
    }
    return null;
  }
}

/**
 * Parses live Heart Rate and 16-bit RR intervals from 0x2A37 characteristic payload.
 */
export function parseHeartRate(value) {
  const flags = value.getUint8(0);
  const is16Bit = (flags & 0x01) !== 0;
  const hasContact = (flags & 0x04) !== 0;
  const energyExpended = (flags & 0x08) !== 0;
  const rrIntervalPresent = (flags & 0x10) !== 0;

  let offset = 1;
  let hr = 0;

  if (is16Bit) {
    hr = value.getUint16(offset, true);
    offset += 2;
  } else {
    hr = value.getUint8(offset);
    offset += 1;
  }

  if (energyExpended) {
    offset += 2;
  }

  const rrIntervals = [];
  if (rrIntervalPresent) {
    while (offset < value.byteLength) {
      // Polar H10 RR intervals are in 1/1024th of a second, converted here to milliseconds
      const rawRr = value.getUint16(offset, true);
      const ms = Math.round((rawRr / 1024) * 1000);
      rrIntervals.push(ms);
      offset += 2;
    }
  }

  return { hr, rrIntervals, hasContact };
}
