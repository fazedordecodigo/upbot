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

export type ConfirmOptions = {
  title: string;
  description: string;
  action: string;
  cancel?: string;
  pendingAction?: string;
  onConfirm?: () => Promise<unknown>;
};
type Request = ConfirmOptions & { resolve: (confirmed: boolean) => void };
const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("Missing ConfirmProvider");
  return confirm;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const [pending, setPending] = useState(false);
  const current = useRef<Request | null>(null);
  const running = useRef(false);
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        if (running.current) {
          resolve(false);
          return;
        }
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
  const accept = async () => {
    const active = current.current;
    if (!active || running.current) return;
    if (!active.onConfirm) {
      settle(true);
      return;
    }
    running.current = true;
    setPending(true);
    let confirmed = true;
    try {
      await active.onConfirm();
    } catch {
      confirmed = false;
    } finally {
      running.current = false;
      setPending(false);
    }
    if (current.current === active && confirmed) settle(true);
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
      {request && (
        <Dialog
          open={request !== null}
          onClose={() => {
            if (!running.current) settle(false);
          }}
          id="confirm"
          aria-labelledby="confirm-title"
          aria-describedby="confirm-desc"
          aria-busy={pending}
        >
          <div className="dialog-body">
            <div className="dialog-header">
              <h2 className="dialog-title" id="confirm-title">
                {request.title}
              </h2>
              <p className="dialog-description" id="confirm-desc">
                {request.description}
              </p>
            </div>
            <div className="dialog-footer">
              <button
                type="button"
                className="btn btn-outline"
                id="confirm-cancel"
                data-action="close-dialog"
                disabled={pending}
                onClick={() => settle(false)}
              >
                {request.cancel ?? "Cancelar"}
              </button>
              <button
                type="button"
                className="btn btn-destructive"
                id="confirm-ok"
                disabled={pending}
                onClick={() => void accept()}
              >
                {pending ? (request.pendingAction ?? request.action) : request.action}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </ConfirmContext.Provider>
  );
}
