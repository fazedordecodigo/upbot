import type { MethodParams, ToolMode, When } from "@boto/protocol";
import { whenToRoutine } from "@boto/protocol";
import type { DaemonClient } from "./daemon";

export const whenLabels: Record<When, string> = {
  now: "Agora",
  in1h: "Daqui a 1 hora",
  tomorrow: "Amanhã às 8h",
  daily: "Todo dia às 8h",
  weekly: "Toda segunda às 9h",
};
export const toolLabels: Record<ToolMode, string> = {
  both: "Navegador e terminal",
  browser: "Só navegador",
  terminal: "Só terminal",
};
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function greeting(hour = new Date().getHours()) {
  return hour >= 5 && hour < 12
    ? "Bom dia."
    : hour >= 12 && hour < 18
      ? "Boa tarde."
      : "Boa noite.";
}

export function attachmentError(files: File[]): string | null {
  if (files.length > 10) return "Anexe no máximo 10 arquivos.";
  if (files.some((file) => file.name.length > 255 || file.type.length > 255))
    return "O nome ou o tipo de um arquivo é longo demais.";
  if (files.reduce((size, file) => size + file.size, 0) > MAX_ATTACHMENT_BYTES)
    return "Os anexos devem ter no máximo 25 MB no total.";
  return null;
}

async function attachment(file: File) {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("attachment_read_failed"));
    reader.onabort = () => reject(new Error("attachment_read_aborted"));
    reader.readAsDataURL(file);
  });
  return { name: file.name, mime: file.type || "application/octet-stream", dataBase64 };
}

export type NewTaskDraft = {
  agentId: string;
  text: string;
  when: When;
  schedule: string | null;
  toolMode: ToolMode;
  requireApproval: boolean;
  private: boolean;
  templateId?: string | undefined;
  files: File[];
};

export function draftError(draft: NewTaskDraft): string | null {
  if (!draft.text.trim()) return "Descreva a tarefa e o resultado esperado.";
  if (!draft.agentId) return "Escolha um agente para delegar a tarefa.";
  const scheduled = draft.when !== "now" || draft.schedule !== null;
  if (draft.text.trim().length > (scheduled ? 20_000 : 100_000))
    return scheduled
      ? "A tarefa agendada deve ter no máximo 20.000 caracteres."
      : "A tarefa deve ter no máximo 100.000 caracteres.";
  return attachmentError(draft.files);
}

export async function delegateTask(client: DaemonClient, draft: NewTaskDraft) {
  const invalid = draftError(draft);
  if (invalid) throw new Error("invalid_task_draft");
  const policy = {
    agentId: draft.agentId,
    private: draft.private,
    toolMode: draft.toolMode,
    requireApproval: draft.requireApproval,
    ...(draft.templateId ? { templateId: draft.templateId } : {}),
    ...(draft.files.length ? { attachments: await Promise.all(draft.files.map(attachment)) } : {}),
  };
  const timing = draft.schedule
    ? { schedule: draft.schedule, runAt: null }
    : whenToRoutine(draft.when);
  if (timing) {
    const routine = await client.request("routines.create", {
      ...policy,
      name: draft.text.trim().split("\n")[0]?.slice(0, 80) ?? "",
      prompt: draft.text.trim(),
      ...timing,
      webhook: false,
      enabled: true,
      ...(draft.files.length
        ? { attachments: await Promise.all(draft.files.map(attachment)) }
        : {}),
    });
    return { view: "routines", id: routine.id } as const;
  }
  const params: MethodParams<"tasks.create"> = {
    ...policy,
    text: draft.text.trim(),
  };
  const task = await client.request("tasks.create", params);
  return { view: "task", id: task.id } as const;
}
