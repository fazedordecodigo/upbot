import { expect, test } from "bun:test";
import { errorMessage } from "../src/lib/errors";
import { DAEMON_NOT_CONNECTED, DAEMON_SOCKET_CLOSED, errorFields } from "../src/lib/log";

test("errorMessage never surfaces the internal disconnected sentinel", () => {
  expect(errorMessage(new Error(DAEMON_NOT_CONNECTED))).toBe(
    "Sem conexão com o Boto. Tente de novo quando a conexão voltar.",
  );
  expect(errorMessage(new Error(DAEMON_SOCKET_CLOSED))).toBe(
    "Sem conexão com o Boto. Tente de novo quando a conexão voltar.",
  );
  expect(errorFields(new Error(DAEMON_NOT_CONNECTED))).toEqual({ error: DAEMON_NOT_CONNECTED });
  expect(errorMessage(new Error("Nome muito longo."))).toBe("Nome muito longo.");
  expect(errorMessage("falhou")).toBe("falhou");
});
