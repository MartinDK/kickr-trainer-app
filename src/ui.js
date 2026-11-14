import { $, runtime } from "./state.js";

export const shouldLogPackets = () => {
  const toggle = $("logTelemetryToggle");
  return toggle ? toggle.checked : false;
};

export function log(message, type = "system") {
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

export function countPacket() {
  runtime.packetCount++;
  const label = $("packetCountLabel");
  if (label) label.textContent = runtime.packetCount + " packets TX/RX";
}

export function showModal(title, message, action) {
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

export function hideModal() {
  $("notificationModal").classList.add("is-hidden");
}
