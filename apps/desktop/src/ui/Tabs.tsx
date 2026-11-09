import { useId } from "react";

export function Tabs({
  items,
  value,
  onChange,
  label,
}: {
  items: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const id = useId();
  return (
    <div
      className="tabs-list"
      role="tablist"
      aria-label={label}
      onKeyDown={(event) => {
        const index = items.findIndex((item) => item.value === value);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : event.key === "ArrowRight"
                ? (index + 1) % items.length
                : event.key === "ArrowLeft"
                  ? (index - 1 + items.length) % items.length
                  : -1;
        if (next < 0 || !items[next]) return;
        event.preventDefault();
        onChange(items[next].value);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}
    >
      {items.map((item) => (
        <button
          type="button"
          className="tabs-trigger"
          role="tab"
          id={`${id}-${item.value}`}
          key={item.value}
          aria-selected={value === item.value}
          tabIndex={value === item.value ? 0 : -1}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
