import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Dialog } from "../ui/Dialog";
import "./ConfirmDialog.css";

export type ConfirmOptions = { title: string; description: string; action: string };
type Request = ConfirmOptions & { resolve: (confirmed: boolean) => void };
const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("Missing ConfirmProvider");
  return confirm;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const current = useRef<Request | null>(null);
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        current.current?.resolve(false);
        const next = { ...options, resolve };
        current.current = next;
        setRequest(next);
      }),
    [],
  );
  const settle = (confirmed: boolean) => {
    current.current?.resolve(confirmed);
    current.current = null;
    setRequest(null);
  };
  useEffect(
    () => () => {
      current.current?.resolve(false);
    },
    [],
  );
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={request !== null}
        onClose={() => settle(false)}
        id="confirm"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-desc"
      >
        <div className="dialog-body">
          <div className="dialog-header">
            <h2 className="dialog-title" id="confirm-title">
              {request?.title}
            </h2>
            <p className="dialog-description" id="confirm-desc">
              {request?.description}
            </p>
          </div>
          <div className="dialog-footer">
            <button
              type="button"
              className="btn btn-outline"
              id="confirm-cancel"
              onClick={() => settle(false)}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-destructive"
              id="confirm-ok"
              onClick={() => settle(true)}
            >
              {request?.action}
            </button>
          </div>
        </div>
      </Dialog>
    </ConfirmContext.Provider>
  );
}
