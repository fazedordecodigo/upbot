import type { ComponentPropsWithoutRef } from "react";

export function Switch({
  checked,
  onCheckedChange,
  ...props
}: Omit<ComponentPropsWithoutRef<"button">, "onChange"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      {...props}
      type="button"
      className="switch"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
    />
  );
}
