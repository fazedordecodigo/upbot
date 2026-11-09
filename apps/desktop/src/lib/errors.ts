import { DAEMON_NOT_CONNECTED, DAEMON_SOCKET_CLOSED, DAEMON_SOCKET_ERROR } from "./log";

const DISCONNECTED = new Set([DAEMON_NOT_CONNECTED, DAEMON_SOCKET_CLOSED, DAEMON_SOCKET_ERROR]);

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return DISCONNECTED.has(message)
    ? "Sem conexão com o Boto. Tente de novo quando a conexão voltar."
    : message;
}
