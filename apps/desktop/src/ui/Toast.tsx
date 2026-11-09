import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Icon } from "./icons";
import "../dialogs/onboarding-dialogs/Toast.css";

const ToastContext = createContext<(text: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<{ id: number; text: string }[]>([]);
  const next = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const toast = useCallback((text: string) => {
    const id = next.current++;
    setMessages((items) => [...items, { id, text }]);
    const timer = setTimeout(() => {
      setMessages((items) => items.filter((item) => item.id !== id));
      timers.current.delete(timer);
    }, 5000);
    timers.current.add(timer);
  }, []);
  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <section className="toaster" aria-live="polite" aria-label="Avisos">
        {messages.map((message) => (
          <div className="toast od-row" key={message.id}>
            <span className="od-fill">{message.text}</span>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              aria-label="Fechar"
              data-tip="Fechar"
              onClick={() => setMessages((items) => items.filter((item) => item.id !== message.id))}
            >
              <Icon name="x" />
            </button>
          </div>
        ))}
      </section>
    </ToastContext.Provider>
  );
}
