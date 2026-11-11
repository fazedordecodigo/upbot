import {
  type ComponentPropsWithoutRef,
  cloneElement,
  createContext,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const CloseMenu = createContext(() => {});

/** Roving-tabindex navigation shared by Dropdown and ContextMenu panels. */
export function menuKeyDown(event: KeyboardEvent<HTMLElement>, close: () => void) {
  if (event.key === "Escape" || event.key === "Tab") {
    if (event.key === "Escape") event.preventDefault();
    close();
    return;
  }
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)'),
  ];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (index + 1) % items.length
          : event.key === "ArrowUp"
            ? (index - 1 + items.length) % items.length
            : -1;
  if (next >= 0) {
    event.preventDefault();
    items[next]?.focus();
  }
}
export function Dropdown({
  trigger,
  children,
  label,
  align = "start",
}: {
  trigger: ReactElement<ComponentPropsWithoutRef<"button">>;
  children: ReactNode;
  label: string;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => {
    setOpen(false);
    root.current?.querySelector("button")?.focus();
  };
  useLayoutEffect(() => {
    if (!open) return;
    const rect = root.current?.querySelector("button")?.getBoundingClientRect();
    const panel = menu.current;
    if (!rect || !panel) return;
    setPosition({
      left: Math.max(
        8,
        Math.min(
          align === "end" ? rect.right - panel.offsetWidth : rect.left,
          window.innerWidth - panel.offsetWidth - 8,
        ),
      ),
      top:
        rect.bottom + panel.offsetHeight > window.innerHeight
          ? Math.max(8, rect.top - panel.offsetHeight)
          : rect.bottom,
    });
    panel.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus();
  }, [open, align]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const hide = () => setOpen(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", hide);
    };
  }, [open]);
  return (
    <div className="dropdown" ref={root}>
      {cloneElement(trigger, {
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": open ? id : undefined,
        onClick: () => setOpen(!open),
        onKeyDown: (event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        },
      })}
      {open && (
        <CloseMenu.Provider value={close}>
          <div
            ref={menu}
            id={id}
            className="dropdown-menu"
            role="menu"
            aria-label={label}
            style={position}
            onKeyDown={(event) => menuKeyDown(event, close)}
          >
            {children}
          </div>
        </CloseMenu.Provider>
      )}
    </div>
  );
}

export function DropdownItem({ onClick, ...props }: ComponentPropsWithoutRef<"button">) {
  const close = useContext(CloseMenu);
  return (
    <button
      {...props}
      type="button"
      className="dropdown-item"
      role={props.role ?? "menuitem"}
      tabIndex={-1}
      onClick={(event) => {
        onClick?.(event);
        close();
      }}
    />
  );
}
export function DropdownLabel({ children }: { children: ReactNode }) {
  return <p className="dropdown-label">{children}</p>;
}
export function DropdownSeparator() {
  // biome-ignore lint/a11y/useSemanticElements: prototype dropdown anatomy.
  return <div className="dropdown-separator" role="separator" />;
}
