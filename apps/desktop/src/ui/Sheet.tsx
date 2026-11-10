import { Dialog, type DialogProps } from "./Dialog";

export function Sheet({ className = "", ...props }: DialogProps) {
  return <Dialog {...props} className={`sheet ${className}`} />;
}
