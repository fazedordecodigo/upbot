import { z } from "zod";

/**
 * Live guest desktop ("Área de trabalho ao vivo"): one Machine per agent placed in a
 * Firecracker microVM. Frames, cursor and machine events only reach connections that
 * subscribed to that machine; user input is accepted only from the connection that owns
 * the takeover while `controller === "user"`.
 */

export const MachineStatus = z.enum(["starting", "ready", "stopped", "error"]);
export type MachineStatus = z.infer<typeof MachineStatus>;

export const MachineController = z.enum(["agent", "user"]);
export type MachineController = z.infer<typeof MachineController>;

export const Machine = z.object({
  id: z.string(),
  /** Deterministic mono-spaced name shown in the UI, e.g. `codigo-01`. */
  name: z.string(),
  agentId: z.string(),
  hostId: z.string().nullable(),
  status: MachineStatus,
  controller: MachineController,
  width: z.number().int(),
  height: z.number().int(),
  taskId: z.string().nullable(),
  /** ISO timestamp of the latest thumbnail, null until the first frame arrived. */
  thumbnailAt: z.string().nullable(),
});
export type Machine = z.infer<typeof Machine>;

export const DESKTOP_MAX_DIMENSION = 8192;
export const DESKTOP_INPUT_BATCH_MAX = 64;
const Coord = z.number().int().min(0).max(DESKTOP_MAX_DIMENSION);
const MouseButton = z.number().int().min(1).max(5);
/** X11 keysym name (`a`, `Return`, `shift`, `ctrl+c` is NOT accepted — one key per event). */
const Keysym = z.string().regex(/^[A-Za-z0-9_]{1,32}$/);

export const DesktopInputEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mouse_move"), x: Coord, y: Coord }).strict(),
  z.object({ type: z.literal("mouse_down"), button: MouseButton }).strict(),
  z.object({ type: z.literal("mouse_up"), button: MouseButton }).strict(),
  z.object({ type: z.literal("wheel"), deltaY: z.number().int().min(-100).max(100) }).strict(),
  z.object({ type: z.literal("key_down"), keysym: Keysym }).strict(),
  z.object({ type: z.literal("key_up"), keysym: Keysym }).strict(),
]);
export type DesktopInputEvent = z.infer<typeof DesktopInputEvent>;

export const DesktopInputBatch = z.array(DesktopInputEvent).min(1).max(DESKTOP_INPUT_BATCH_MAX);

export const DesktopThumbnail = z.object({
  mime: z.string(),
  dataBase64: z.string(),
  at: z.string(),
});
export type DesktopThumbnail = z.infer<typeof DesktopThumbnail>;

export const DesktopFrameEvent = z.object({
  machineId: z.string(),
  seq: z.number().int(),
  mime: z.string(),
  dataBase64: z.string(),
  width: z.number().int(),
  height: z.number().int(),
});
export type DesktopFrameEvent = z.infer<typeof DesktopFrameEvent>;

export const DesktopCursorKind = z.enum(["move", "click", "type", "key"]);
export const DesktopCursorEvent = z.object({
  machineId: z.string(),
  x: z.number().int(),
  y: z.number().int(),
  kind: DesktopCursorKind,
});
export type DesktopCursorEvent = z.infer<typeof DesktopCursorEvent>;

const MachineIdParams = z.object({ machineId: z.string() }).strict();
const Ok = z.object({ ok: z.literal(true) });

export const desktopMethodMap = {
  "desktop.machines": { params: z.object({}).strict(), result: z.array(Machine) },
  "desktop.subscribe": { params: MachineIdParams, result: Machine },
  "desktop.unsubscribe": { params: MachineIdParams, result: Ok },
  "desktop.thumbnail": { params: MachineIdParams, result: DesktopThumbnail },
  "desktop.takeover": { params: MachineIdParams, result: Machine },
  "desktop.release": { params: MachineIdParams, result: Machine },
  "desktop.input": {
    params: z.object({ machineId: z.string(), events: DesktopInputBatch }).strict(),
    result: Ok,
  },
} as const;

export type DesktopEventMap = {
  "desktop.frame": DesktopFrameEvent;
  "desktop.cursor": DesktopCursorEvent;
  "desktop.machine": Machine;
};
