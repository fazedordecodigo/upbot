import {
  type ComponentPropsWithoutRef,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { menuKeyDown } from "./Dropdown";

const CloseMenu = createContext(() => {});

/**
 * A right-click menu anchored at a pointer position. Styled like Dropdown's
 * panel; closes on outside press, Escape, Tab, resize or window blur, and
 * roves focus across its items with the arrow keys.
 */
export function ContextMenu({
  x,
  y,
  label,
  close,
  children,
}: {
  x: number;
  y: number;
  label: string;
  close: () => void;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const panel = menu.current;
    if (!panel) return;
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - panel.offsetWidth - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - panel.offsetHeight - 8)),
    });
    panel.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus();
  }, [x, y]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [close]);
  return (
    <CloseMenu.Provider value={close}>
      <div
        ref={menu}
        className="dropdown-menu"
        role="menu"
        aria-label={label}
        style={position}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => menuKeyDown(event, close)}
      >
        {children}
      </div>
    </CloseMenu.Provider>
  );
}

export function ContextMenuItem({ onClick, ...props }: ComponentPropsWithoutRef<"button">) {
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
