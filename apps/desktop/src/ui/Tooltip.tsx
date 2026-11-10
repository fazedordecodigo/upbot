import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

export function TooltipLayer() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const id = useId();
  useEffect(() => {
    let keyboardFocus = false;
    const keydown = (event: KeyboardEvent) => {
      keyboardFocus = [
        "Tab",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
      ].includes(event.key);
    };
    const show = (event: Event) => {
      const element =
        event.target instanceof Element ? event.target.closest<HTMLElement>("[data-tip]") : null;
      setTarget(
        event.type === "focusin" && (!keyboardFocus || !element?.matches(":focus-visible"))
          ? null
          : element,
      );
      if (event.type === "focusin") keyboardFocus = false;
    };
    const hide = () => setTarget(null);
    const pointerdown = () => {
      keyboardFocus = false;
      hide();
    };
    document.addEventListener("keydown", keydown);
    document.addEventListener("pointermove", show);
    document.addEventListener("focusin", show);
    document.addEventListener("pointerout", hide);
    document.addEventListener("focusout", hide);
    document.addEventListener("pointerdown", pointerdown);
    window.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("pointermove", show);
      document.removeEventListener("focusin", show);
      document.removeEventListener("pointerout", hide);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("pointerdown", pointerdown);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);
  useEffect(() => {
    if (!target) return;
    const previous = target.getAttribute("aria-describedby");
    target.setAttribute("aria-describedby", [previous, id].filter(Boolean).join(" "));
    return () => {
      if (previous) target.setAttribute("aria-describedby", previous);
      else target.removeAttribute("aria-describedby");
    };
  }, [target, id]);
  if (!target?.isConnected || !target.dataset.tip) return null;
  const rect = target.getBoundingClientRect();
  const tooltip = (
    <div
      className="tooltip"
      id={id}
      role="tooltip"
      style={{
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 248)),
        top: rect.bottom + 8,
      }}
    >
      {target.dataset.tip}
    </div>
  );
  const dialog = target.closest("dialog[open]");
  return createPortal(tooltip, dialog ?? document.body);
}
