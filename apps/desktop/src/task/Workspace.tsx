import type { ChatItem } from "@boto/protocol";
import { useState } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import type { MachineSession } from "../hooks/useMachine";
import type { DaemonClient } from "../lib/daemon";
import { Icon, type IconName } from "../ui/icons";
import { LiveDesk, machineStatus } from "./LiveDesk";
import "./Workspace.css";

type DeskView = "screen" | "terminal" | "files" | "browser";
type ToolCallItem = Extract<ChatItem, { kind: "tool_call" }>;

const VIEWS: { id: DeskView; icon: IconName; label: string }[] = [
  { id: "screen", icon: "monitor", label: "Tela" },
  { id: "terminal", icon: "terminal", label: "Terminal" },
  { id: "files", icon: "file-code", label: "Editor" },
  { id: "browser", icon: "globe", label: "Navegador" },
];

const running = (call: ToolCallItem) => call.status === "pending" || call.status === "in_progress";

const toolCalls = (items: ChatItem[], kinds: Set<string>): ToolCallItem[] =>
  items.filter(
    (i): i is ToolCallItem =>
      i.kind === "tool_call" && i.toolKind !== null && kinds.has(i.toolKind),
  );

/** While a call runs, `detail` carries the tool's JSON input; once done it is the result text. */
function runningInput(call: ToolCallItem): Record<string, unknown> | null {
  if (!running(call) || !call.detail) return null;
  try {
    const parsed = JSON.parse(call.detail) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const stripPrefix = (title: string) =>
  title.replace(/^(?:Bash|Run|Shell|Terminal|exec|execute|cmd|command):\s*/i, "");

function StepStatus({ call }: { call: ToolCallItem }) {
  return (
    <span className="ws-step-status" data-status={call.status} aria-hidden="true">
      <Icon
        name={running(call) ? "loader" : call.status === "failed" ? "circle-alert" : "circle-check"}
      />
    </span>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="ws-empty">{children}</p>;
}

function TerminalPane({ items }: { items: ChatItem[] }) {
  const calls = toolCalls(items, new Set(["execute"]));
  if (!calls.length) return <Empty>Os comandos que o Boto rodar no terminal aparecem aqui.</Empty>;
  return (
    <div className="ws-pane ws-term od-scroll" role="log" aria-label="Terminal">
      {calls.map((call) => {
        const input = runningInput(call);
        const command =
          (typeof input?.command === "string" && input.command) || stripPrefix(call.title);
        const output = input ? null : call.detail;
        return (
          <div className="ws-term-block" data-status={call.status} key={call.id}>
            <p className="ws-term-cmd">
              <span className="ws-term-prompt" aria-hidden="true">
                $
              </span>{" "}
              {command || "comando"}
            </p>
            {output ? (
              <pre className="ws-term-out">{output}</pre>
            ) : running(call) ? (
              <p className="ws-term-out ws-dim">Em andamento…</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

const FILE_ICONS: Record<string, IconName> = {
  edit: "file-code",
  read: "file-text",
  move: "folder",
  delete: "trash",
  search: "search",
};
const FILE_KINDS = new Set(["edit", "read", "move", "delete", "search"]);
const FILE_LABEL: Record<string, string> = {
  edit: "Edição",
  read: "Leitura",
  move: "Arquivos",
  delete: "Exclusão",
  search: "Busca",
};

function fileTarget(call: ToolCallItem): string {
  const input = runningInput(call);
  const fromInput =
    input?.file_path ?? input?.path ?? input?.notebook_path ?? input?.source ?? input?.destination;
  if (typeof fromInput === "string" && fromInput) return fromInput;
  const named = stripPrefix(call.title).replace(/^[A-Za-z]{2,16}:\s+/, "");
  const verb = named.match(/^(?:Edit|MultiEdit|Read|Write|View|Delete|Move|Glob|Grep)\s+(.*)$/);
  return verb?.[1] || named;
}

function FilesPane({ items }: { items: ChatItem[] }) {
  const calls = toolCalls(items, FILE_KINDS);
  if (!calls.length) return <Empty>Os arquivos que o Boto ler e editar aparecem aqui.</Empty>;
  return (
    <ul className="ws-pane ws-files od-scroll" aria-label="Editor">
      {calls.map((call) => {
        const input = runningInput(call);
        const output = input ? null : call.detail;
        return (
          <li className="ws-file" data-status={call.status} key={call.id}>
            <Icon name={FILE_ICONS[call.toolKind ?? ""] ?? "file-text"} />
            <div className="ws-file-body">
              <p className="ws-file-name">
                <span className="ws-file-kind">{FILE_LABEL[call.toolKind ?? ""] ?? "Editor"}</span>
                {" · "}
                {fileTarget(call)}
              </p>
              {output && <pre className="ws-file-detail">{output}</pre>}
            </div>
            <StepStatus call={call} />
          </li>
        );
      })}
    </ul>
  );
}

function BrowserPane({
  client,
  agentId,
  items,
}: {
  client: DaemonClient;
  agentId: string | undefined;
  items: ChatItem[];
}) {
  const browser = useDaemonQuery(
    client,
    "browser.status",
    {},
    {
      events: { "browser.updated": true },
    },
  );
  const tabs = (browser.data?.tabs ?? []).filter((t) => t.agentId === agentId);
  const fetches = toolCalls(items, new Set(["fetch"]));
  if (!tabs.length && !fetches.length)
    return <Empty>As páginas que o Boto abrir aparecem aqui.</Empty>;
  return (
    <div className="ws-pane ws-browse od-scroll" role="log" aria-label="Navegador">
      {tabs.length > 0 && (
        <>
          <p className="ws-section">Abas abertas</p>
          {tabs.map((tab) => (
            <div className="ws-browse-row" key={`${tab.agentId}-${tab.url}`}>
              <Icon name="globe" />
              <div className="ws-browse-body">
                <p className="ws-browse-title">{tab.title || tab.url}</p>
                {tab.title && <p className="ws-browse-url">{tab.url}</p>}
              </div>
            </div>
          ))}
        </>
      )}
      {fetches.length > 0 && (
        <>
          <p className="ws-section">Páginas acessadas</p>
          {fetches.map((call) => {
            const input = runningInput(call);
            const target =
              (typeof input?.url === "string" && input.url) ||
              (typeof input?.query === "string" && input.query) ||
              stripPrefix(call.title);
            const output = input ? null : call.detail;
            return (
              <div className="ws-browse-row" data-status={call.status} key={call.id}>
                <Icon name="globe" />
                <div className="ws-browse-body">
                  <p className="ws-browse-title">{target}</p>
                  {output && <pre className="ws-file-detail">{output}</pre>}
                </div>
                <StepStatus call={call} />
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

export function Workspace({
  client,
  session,
  available,
  items,
  agentId,
  status,
  icon,
  tone,
  onExpand,
  onRelease,
}: {
  client: DaemonClient;
  session: MachineSession;
  available: boolean;
  items: ChatItem[];
  agentId: string | undefined;
  status: string;
  icon: IconName;
  tone: string;
  onExpand?: (() => void) | undefined;
  onRelease: () => void;
}) {
  const [view, setView] = useState<DeskView>("screen");
  const machine = session.machine;
  return (
    <div className="ws">
      <div className="ws-head">
        <span className="status ws-status" data-tone={tone}>
          <Icon name={icon} />
          {status}
        </span>
        <span className="ws-machine od-truncate">
          {machine && (
            <>
              <Icon name="monitor" />
              {machine.name}
              <span className="ws-machine-status">{machineStatus[machine.status]}</span>
            </>
          )}
        </span>
      </div>
      <div className="ws-bar">
        <div className="ws-tabs" role="tablist" aria-label="Visualizações da área de trabalho">
          {VIEWS.map((v, index) => (
            <button
              type="button"
              role="tab"
              className="ws-tab"
              key={v.id}
              id={`ws-tab-${v.id}`}
              aria-controls="ws-view"
              aria-selected={view === v.id}
              tabIndex={view === v.id ? 0 : -1}
              aria-label={v.label}
              data-tip={v.label}
              title={v.label}
              onClick={() => setView(v.id)}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? VIEWS.length - 1
                      : event.key === "ArrowLeft"
                        ? (index + VIEWS.length - 1) % VIEWS.length
                        : (index + 1) % VIEWS.length;
                setView(VIEWS[next]!.id);
                document.getElementById(`ws-tab-${VIEWS[next]!.id}`)?.focus();
              }}
            >
              <Icon name={v.icon} />
            </button>
          ))}
        </div>
        {onExpand && available && (
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            aria-label="Abrir em tela cheia"
            data-tip="Abrir em tela cheia"
            onClick={onExpand}
          >
            <Icon name="arrow-up-right" />
          </button>
        )}
      </div>
      <div className="ws-view" id="ws-view">
        {view === "screen" && (
          <LiveDesk
            session={session}
            available={available}
            bar={false}
            onExpand={onExpand}
            onRelease={onRelease}
          />
        )}
        {view === "terminal" && <TerminalPane items={items} />}
        {view === "files" && <FilesPane items={items} />}
        {view === "browser" && <BrowserPane client={client} agentId={agentId} items={items} />}
      </div>
    </div>
  );
}
