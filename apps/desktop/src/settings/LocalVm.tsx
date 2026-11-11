import { useState } from "react";
import { useConfirm } from "../dialogs/ConfirmDialog";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { errorMessage } from "../lib/errors";
import { useDaemon } from "../shell/daemon";
import { Icon } from "../ui/icons";
import { useToast } from "../ui/Toast";
import { BlockHead, QueryState } from "./QueryState";

const stateLabel = {
  absent: "Ainda não criada",
  stopped: "Desligada",
  running: "Ligada",
  broken: "Com problema",
} as const;

export function LocalVm() {
  const { client } = useDaemon();
  const toast = useToast();
  const confirm = useConfirm();
  const status = useDaemonQuery(
    client,
    "localvm.status",
    {},
    {
      events: { "localvm.changed": true, "hosts.changed": true },
    },
  );
  const [acting, setActing] = useState(false);
  const vm = status.data;
  const busy = acting || !!vm?.busy;

  const act = async (
    method: "localvm.create" | "localvm.start" | "localvm.stop" | "localvm.install",
  ) => {
    setActing(true);
    try {
      status.setData(await client.request(method, {}));
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setActing(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    const ok = await confirm({
      title: "Apagar a VM local?",
      description:
        "A máquina virtual e o disco dela são removidos. Os bots que trabalham nela voltam a usar este Mac. A pasta ~/Boto/computer/workspace fica no computador.",
      action: "Apagar VM",
    });
    if (!ok) return;
    setActing(true);
    try {
      status.setData(await client.request("localvm.delete", {}));
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="st-block" aria-busy={!status.loaded && !status.error}>
      <BlockHead
        title="Computador Linux"
        description="Uma máquina virtual Linux completa neste Mac, com área de trabalho, navegador e ferramentas. Bots colocados nela trabalham dentro da VM — veja a tela ao vivo na tarefa. Os arquivos compartilhados ficam em ~/Boto/computer/workspace."
      />
      <QueryState query={status}>
        {vm && !vm.available ? (
          <p className="st-empty">
            <Icon name="circle-alert" />
            {vm.detail ?? "O Lima não está instalado neste Mac."} Instale com{" "}
            <code>brew install lima</code> e recarregue esta página.
          </p>
        ) : vm ? (
          <>
            <div className="st-row od-row">
              <span className="od-field od-fill">
                <span className="st-row-name">VM {vm.name}</span>
                <span className="st-row-help">
                  {vm.busy ??
                    (vm.installed
                      ? "Pronta para receber bots."
                      : vm.state === "running"
                        ? "Ligada, ainda sem o helper do Boto."
                        : (vm.detail ?? ""))}
                </span>
              </span>
              <span className="od-nowrap">{stateLabel[vm.state]}</span>
            </div>
            {vm.detail && !vm.busy && (
              <p className="st-error od-row" role="alert">
                <Icon name="circle-alert" />
                {vm.detail}
              </p>
            )}
            <div className="st-actions">
              {vm.state === "absent" && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void act("localvm.create")}
                >
                  <Icon name="download" />
                  {busy ? (vm.busy ?? "Criando…") : "Criar a VM"}
                </button>
              )}
              {vm.state === "stopped" && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void act("localvm.start")}
                >
                  <Icon name="play" />
                  {busy ? (vm.busy ?? "Ligando…") : "Ligar a VM"}
                </button>
              )}
              {vm.state === "running" && (
                <>
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={busy}
                    onClick={() => void act("localvm.stop")}
                  >
                    <Icon name="power" />
                    {busy ? (vm.busy ?? "Desligando…") : "Desligar"}
                  </button>
                  {!vm.installed && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => void act("localvm.install")}
                    >
                      <Icon name="download" />
                      {busy ? (vm.busy ?? "Instalando…") : "Instalar o Boto nela"}
                    </button>
                  )}
                </>
              )}
              {vm.state !== "absent" && (
                <button
                  type="button"
                  className="btn btn-outline st-danger"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  <Icon name="trash" />
                  Apagar
                </button>
              )}
            </div>
          </>
        ) : null}
      </QueryState>
      <div className="st-note">
        <h3 className="st-subtitle">Como funciona</h3>
        <ul className="st-points">
          <li>
            <Icon name="check" />
            <span>
              No painel do bot, em “Onde ele trabalha”, escolha a VM local. O provedor roda dentro
              dela e a fila continua a mesma.
            </span>
          </li>
          <li>
            <Icon name="check" />
            <span>
              A tela da VM aparece na tarefa como uma máquina ao vivo — dá para assistir e assumir o
              controle.
            </span>
          </li>
          <li>
            <Icon name="check" />
            <span>
              A VM não alcança este Mac pela rede; a ponte com o Boto passa pelo canal SSH dela.
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}
