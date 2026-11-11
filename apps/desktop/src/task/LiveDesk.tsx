import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { MachineSession } from "../hooks/useMachine";
import { toGuestCoords, toKeysym, xButton } from "../lib/desktop";
import { Icon } from "../ui/icons";
import "./LiveDesk.css";

export const machineStatus = {
  starting: "Ligando a máquina…",
  ready: "Pronta",
  stopped: "Máquina desligada",
  error: "Não foi possível iniciar a máquina",
};

export function LiveDesk({
  session,
  available,
  onExpand,
  onRelease,
}: {
  session: MachineSession;
  available: boolean;
  onExpand?: (() => void) | undefined;
  onRelease: () => void;
}) {
  const { machine, frame, frameUrl, cursor, owned, input } = session;
  const surface = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [announcement, setAnnouncement] = useState("");
  const [waves, setWaves] = useState<{ id: number; x: number; y: number }[]>([]);
  const [decoded, setDecoded] = useState(false);
  const lastAnnouncement = useRef(0);
  const lastClick = useRef<typeof cursor>(null);
  useEffect(() => {
    const el = surface.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!frameUrl) setDecoded(false);
  }, [frameUrl]);
  useEffect(() => {
    if (!cursor) return;
    if (cursor.kind === "click" && lastClick.current !== cursor) {
      lastClick.current = cursor;
      setWaves((value) => [
        ...value.slice(-3),
        { id: Date.now() + Math.random(), x: cursor.x, y: cursor.y },
      ]);
    }
    if (Date.now() - lastAnnouncement.current < 1500) return;
    lastAnnouncement.current = Date.now();
    setAnnouncement(
      cursor.kind === "click"
        ? "O Boto clicou"
        : cursor.kind === "type" || cursor.kind === "key"
          ? "O Boto está digitando"
          : "O Boto moveu o cursor",
    );
  }, [cursor]);
  const width = frame?.width || machine?.width || 1280;
  const height = frame?.height || machine?.height || 800;
  const scale = Math.min(size.width / width, size.height / height);
  const guest = {
    width: width * scale,
    height: height * scale,
    left: (size.width - width * scale) / 2,
    top: (size.height - height * scale) / 2,
  };
  const point = (event: { clientX: number; clientY: number }) => {
    const rect = surface.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return toGuestCoords(
      { ...guest, left: rect.left + guest.left, top: rect.top + guest.top },
      event,
      { width, height },
    );
  };
  const key = (event: KeyboardEvent<HTMLDivElement>, type: "key_down" | "key_up") => {
    if (!owned || event.key === "Tab" || event.target !== event.currentTarget) return;
    const keysym = toKeysym(event.key);
    if (keysym) {
      event.preventDefault();
      input({ type, keysym });
    }
  };
  const ready = machine?.status === "ready";
  const copy = !available
    ? "Este bot trabalha sem área de trabalho. Ela está disponível para bots em uma máquina virtual."
    : (session.error ??
      (!machine
        ? "Conectando à máquina…"
        : !ready
          ? machineStatus[machine.status]
          : "Aguardando a primeira imagem…"));
  return (
    <div className="live-desk" data-owned={owned}>
      {owned && (
        <div className="live-control">
          <span className="live-control-label">
            <Icon name="mouse-pointer" />
            Você está no controle
          </span>
          <button type="button" className="btn btn-outline btn-sm" onClick={onRelease}>
            Devolver ao Boto
          </button>
        </div>
      )}
      <div
        className="live-surface"
        ref={surface}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: remote desktop accepts pointer and keyboard input; Tab exits.
        tabIndex={0}
        role="application"
        aria-label={
          owned
            ? "Área de trabalho da máquina. Tab sai do controle remoto."
            : "Área de trabalho do Boto"
        }
        onDoubleClick={() => {
          if (!owned) onExpand?.();
        }}
        onContextMenu={(event) => {
          if (owned) event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (owned) input({ type: "mouse_move", ...point(event) });
        }}
        onPointerDown={(event) => {
          if (!owned) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          input({ type: "mouse_move", ...point(event) });
          input({ type: "mouse_down", button: xButton(event.button) });
        }}
        onPointerUp={(event) => {
          if (owned) input({ type: "mouse_up", button: xButton(event.button) });
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onWheel={(event) => {
          if (owned) {
            event.preventDefault();
            input({
              type: "wheel",
              deltaY: Math.max(-100, Math.min(100, Math.round(event.deltaY))),
            });
          }
        }}
        onKeyDown={(event) => key(event, "key_down")}
        onKeyUp={(event) => key(event, "key_up")}
      >
        {(!frameUrl || !decoded || !ready) && (
          <div className="live-empty">
            <img className="live-mark" src="/assets/boto-simbolo.svg" alt="" />
            <p>{copy}</p>
          </div>
        )}
        {ready && frameUrl && (
          <img
            className="live-frame"
            src={frameUrl}
            alt="Tela ao vivo da máquina"
            draggable={false}
            onLoad={() => setDecoded(true)}
            onError={() => setDecoded(false)}
            style={{ ...guest, visibility: decoded ? "visible" : "hidden" }}
          />
        )}
        {ready && decoded && cursor && !owned && (
          <div
            className="live-cursor"
            style={
              {
                left: guest.left + cursor.x * scale,
                top: guest.top + cursor.y * scale,
              } as CSSProperties
            }
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 32" aria-hidden="true">
              <path d="M2 2 L2 26 L8 21 L13 31 L18 28 L13 18 L22 18 Z" />
            </svg>
            <span>Boto</span>
          </div>
        )}
        {waves.map((wave) => (
          <i
            key={wave.id}
            className="live-click"
            style={{ left: guest.left + wave.x * scale, top: guest.top + wave.y * scale }}
            onAnimationEnd={() => setWaves((value) => value.filter((w) => w.id !== wave.id))}
            aria-hidden="true"
          />
        ))}
      </div>
      <div className="live-bar">
        <Icon name="monitor" />
        <span className="live-machine-name">{machine?.name ?? "Área de trabalho"}</span>
        <span className="live-machine-status">{machine ? machineStatus[machine.status] : ""}</span>
        {onExpand && available && (
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            aria-label="Abrir em tela cheia"
            data-tip="Abrir em tela cheia"
            onClick={onExpand}
          >
            <Icon name="app-window" />
          </button>
        )}
      </div>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
