import { readStorage, writeStorage } from "./storage";

export function readSidebarWidth() {
  const value = Number(readStorage("boto.sidebar-width"));
  return value >= 220 && value <= 400 ? value : 272;
}

export function setSidebarWidth(value: number) {
  const width = Number.isFinite(value) ? Math.min(400, Math.max(220, value)) : 272;
  writeStorage("boto.sidebar-width", String(width));
  window.dispatchEvent(new Event("boto:sidebar-width"));
}
