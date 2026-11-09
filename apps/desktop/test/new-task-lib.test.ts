import { expect, test } from "bun:test";
import { attachmentError, draftError, greeting, type NewTaskDraft } from "../src/lib/new-task";

const draft: NewTaskDraft = {
  agentId: "agent",
  text: "Uma tarefa",
  when: "now",
  schedule: null,
  toolMode: "both",
  private: false,
  requireApproval: true,
  files: [],
};

test("new-task validates text, agent, limits and never drops scheduled attachments", () => {
  expect(draftError(draft)).toBeNull();
  expect(draftError({ ...draft, text: "  " })).toContain("Descreva");
  expect(draftError({ ...draft, agentId: "" })).toContain("Escolha um agente");
  expect(draftError({ ...draft, text: "x".repeat(100_001) })).toContain("100.000");
  expect(draftError({ ...draft, text: "x".repeat(20_001), when: "daily" })).toContain("20.000");
  expect(draftError({ ...draft, when: "in1h", files: [new File(["a"], "a.txt")] })).toBeNull();
  expect(
    draftError({ ...draft, schedule: "every 2h", files: [new File(["a"], "a.txt")] }),
  ).toBeNull();
});

test("new-task enforces the daemon's attachment count, size and filename limits", () => {
  expect(attachmentError([new File(["a"], "a.txt")])).toBeNull();
  expect(attachmentError(Array.from({ length: 11 }, () => new File([], "a")))).toContain(
    "10 arquivos",
  );
  expect(attachmentError([new File([new Uint8Array(25 * 1024 * 1024 + 1)], "a")])).toContain(
    "25 MB",
  );
  expect(attachmentError([new File([], "a".repeat(256))])).toContain("longo demais");
});

test("new-task greeting follows the local time", () => {
  expect(greeting(0)).toBe("Boa noite.");
  expect(greeting(4)).toBe("Boa noite.");
  expect(greeting(5)).toBe("Bom dia.");
  expect(greeting(11)).toBe("Bom dia.");
  expect(greeting(12)).toBe("Boa tarde.");
  expect(greeting(17)).toBe("Boa tarde.");
  expect(greeting(18)).toBe("Boa noite.");
  expect(greeting(23)).toBe("Boa noite.");
});
