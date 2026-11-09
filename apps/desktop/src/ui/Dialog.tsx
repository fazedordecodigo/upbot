import { type ComponentPropsWithoutRef, useEffect, useRef } from "react";
import { Icon } from "./icons";

export type DialogProps = ComponentPropsWithoutRef<"dialog"> & {
  open: boolean;
  onClose: () => void;
  closeButton?: boolean;
};

export function Dialog({
  open,
  onClose,
  closeButton = false,
  className = "",
  children,
  ...props
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const previous = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);
  return (
    <dialog
      {...props}
      ref={ref}
      className={`dialog ${className}`}
      onKeyDown={(event) => {
        props.onKeyDown?.(event);
        if (event.key !== "Tab" || event.defaultPrevented) return;
        const items = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ),
        ].filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
        const first = items[0];
        const last = items.at(-1);
        if (!first || !last) return;
        if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        close.current();
      }}
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
    >
      {children}
      {closeButton && (
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm dialog-close"
          aria-label="Fechar"
          data-tip="Fechar"
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
      )}
    </dialog>
  );
}
