import { DAEMON_NOT_CONNECTED, DAEMON_SOCKET_CLOSED, DAEMON_SOCKET_ERROR } from "./log";

const DISCONNECTED = new Set([DAEMON_NOT_CONNECTED, DAEMON_SOCKET_CLOSED, DAEMON_SOCKET_ERROR]);

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return DISCONNECTED.has(message)
    ? "Sem conexão com o Boto. Tente de novo quando a conexão voltar."
    : message;
}

export function onboardingErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (DISCONNECTED.has(message)) return errorMessage(error);
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "bad_request"
  )
    return "Confira os dados: o nome pode ter até 40 caracteres e o texto sobre você, até 600.";
  return "Não foi possível salvar suas preferências. Tente de novo.";
}
