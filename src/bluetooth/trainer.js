export const CYCLING_POWER_SERVICE_UUID = 0x1818;
export const WAHOO_TRAINER_CHAR_UUID = 'a026e005-0a7d-4ab3-97fa-f1500f9feb8b';
export const UNLOCK_COMMAND = new Uint8Array([0x20, 0xee, 0xfc]);
export const RESISTANCE_MAX_RAW = 16383;

export function hexLog(uint8Array) {
    return Array.from(uint8Array)
        .map((b) => '0x' + b.toString(16).padStart(2, '0').toUpperCase())
        .join(' ');
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
    view.setUint8(0, 0x40);
    view.setUint16(1, raw, true);
    return { payload: new Uint8Array(buffer), raw };
}
