import type {
  DesktopCursorEvent,
  DesktopFrameEvent,
  DesktopInputEvent,
  DesktopThumbnail,
  Machine,
} from "@boto/protocol";
import type { DaemonClient } from "./daemon";

/**
 * Typed client for the live guest desktop ("Área de trabalho ao vivo"). Frames and cursor
 * events only arrive for machines this connection subscribed to; input is accepted only
 * while this connection holds the takeover ("Assumir o controle" → "Devolver ao Boto").
 */
export class DesktopClient {
  constructor(private readonly daemon: DaemonClient) {}

  machines(): Promise<Machine[]> {
    return this.daemon.request("desktop.machines", {});
  }

  subscribe(machineId: string): Promise<Machine> {
    return this.daemon.request("desktop.subscribe", { machineId });
  }

  unsubscribe(machineId: string): Promise<{ ok: true }> {
    return this.daemon.request("desktop.unsubscribe", { machineId });
  }

  thumbnail(machineId: string): Promise<DesktopThumbnail> {
    return this.daemon.request("desktop.thumbnail", { machineId });
  }

  takeover(machineId: string): Promise<Machine> {
    return this.daemon.request("desktop.takeover", { machineId });
  }

  release(machineId: string): Promise<Machine> {
    return this.daemon.request("desktop.release", { machineId });
  }

  input(machineId: string, events: DesktopInputEvent[]): Promise<{ ok: true }> {
    return this.daemon.request("desktop.input", { machineId, events });
  }

  onFrame(machineId: string, cb: (frame: DesktopFrameEvent) => void): () => void {
    return this.daemon.on("desktop.frame", (frame) => {
      if (frame.machineId === machineId) cb(frame);
    });
  }

  onCursor(machineId: string, cb: (cursor: DesktopCursorEvent) => void): () => void {
    return this.daemon.on("desktop.cursor", (cursor) => {
      if (cursor.machineId === machineId) cb(cursor);
    });
  }

  onMachine(cb: (machine: Machine) => void): () => void {
    return this.daemon.on("desktop.machine", cb);
  }
}

/** `data:` URL for an <img> from a frame or thumbnail payload. */
export function frameDataUrl(payload: { mime: string; dataBase64: string }): string {
  return `data:${payload.mime};base64,${payload.dataBase64}`;
}

/** Maps a pointer position inside the rendered <img> to guest pixels (integers, clamped). */
export function toGuestCoords(
  rect: { left: number; top: number; width: number; height: number },
  client: { clientX: number; clientY: number },
  machine: { width: number; height: number },
): { x: number; y: number } {
  const fx = rect.width > 0 ? (client.clientX - rect.left) / rect.width : 0;
  const fy = rect.height > 0 ? (client.clientY - rect.top) / rect.height : 0;
  const clamp = (v: number, max: number) =>
    Math.min(Math.max(Math.round(v), 0), Math.max(max - 1, 0));
  return {
    x: clamp(fx * machine.width, machine.width),
    y: clamp(fy * machine.height, machine.height),
  };
}

/** DOM mouse button (0/1/2) → X11 button (1/2/3). */
export function xButton(domButton: number): 1 | 2 | 3 {
  return domButton === 1 ? 2 : domButton === 2 ? 3 : 1;
}

const KEY_MAP: Record<string, string> = {
  Enter: "Return",
  Backspace: "BackSpace",
  Tab: "Tab",
  Escape: "Escape",
  " ": "space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "Prior",
  PageDown: "Next",
  Shift: "Shift_L",
  Control: "Control_L",
  Alt: "Alt_L",
  Meta: "Super_L",
  CapsLock: "Caps_Lock",
};

/** KeyboardEvent.key → X11 keysym accepted by desktop.input, or null when unmapped. */
export function toKeysym(key: string): string | null {
  const mapped = KEY_MAP[key];
  if (mapped) return mapped;
  if (/^F([1-9]|1[0-2])$/.test(key)) return key;
  if (/^[A-Za-z0-9]$/.test(key)) return key;
  return null;
}
