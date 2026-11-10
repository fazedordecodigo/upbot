import type { ToolMode, When } from "@boto/protocol";
import { toolLabels, whenLabels } from "../../lib/new-task";
import { composerScheduleLabel } from "../../lib/templates";
import { Dropdown, DropdownItem, DropdownLabel, DropdownSeparator } from "../../ui/Dropdown";
import { Icon } from "../../ui/icons";

export function WhenPicker({
  when,
  schedule,
  disabled,
  onChange,
}: {
  when: When;
  schedule: string | null;
  disabled: boolean;
  onChange: (when: When) => void;
}) {
  const item = (value: When, description?: string) => (
    <DropdownItem
      role="menuitemradio"
      aria-checked={!schedule && when === value}
      data-when={value}
      onClick={() => onChange(value)}
    >
      <Icon name="check" className="item-check" />
      <span className="od-field od-fill">
        <span className="item-name">{whenLabels[value]}</span>
        {description && <span className="item-desc">{description}</span>}
      </span>
    </DropdownItem>
  );
  return (
    <Dropdown
      label="Quando executar"
      trigger={
        <button
          type="button"
          className="btn btn-ghost btn-sm opt-trigger"
          id="when-trigger"
          disabled={disabled}
        >
          <Icon name="clock" />
          <span className="opt-key">Quando</span>
          <span className="opt-value" id="when-label">
            {schedule ? composerScheduleLabel(schedule) : whenLabels[when]}
          </span>
          <Icon name="chevron-down" className="opt-chevron" />
        </button>
      }
    >
      <DropdownLabel>Quando executar</DropdownLabel>
      {item("now", "O Boto começa assim que você delegar")}
      <DropdownSeparator />
      <DropdownLabel>Uma vez</DropdownLabel>
      {item("in1h")}
      {item("tomorrow")}
      <DropdownSeparator />
      <DropdownLabel>Repetir</DropdownLabel>
      {item("daily")}
      {item("weekly")}
    </Dropdown>
  );
}

const descriptions: Record<ToolMode, string> = {
  both: "O Boto escolhe o que cada etapa pede",
  browser: "Sites, e-mail, painéis e planilhas online",
  terminal: "Código, scripts e arquivos",
};
export function ToolPicker({
  value,
  disabled,
  onChange,
}: {
  value: ToolMode;
  disabled: boolean;
  onChange: (value: ToolMode) => void;
}) {
  return (
    <Dropdown
      label="Onde trabalhar"
      trigger={
        <button
          type="button"
          className="btn btn-ghost btn-sm opt-trigger"
          id="where-trigger"
          disabled={disabled}
        >
          <Icon name="monitor" />
          <span className="opt-key">Onde</span>
          <span className="opt-value" id="where-label">
            {toolLabels[value]}
          </span>
          <Icon name="chevron-down" className="opt-chevron" />
        </button>
      }
    >
      <DropdownLabel>Ferramentas do computador</DropdownLabel>
      {(["both", "browser", "terminal"] as const).map((mode) => (
        <DropdownItem
          key={mode}
          role="menuitemradio"
          aria-checked={value === mode}
          data-where={mode}
          onClick={() => onChange(mode)}
        >
          <Icon name="check" className="item-check" />
          <span className="od-field od-fill">
            <span className="item-name">{toolLabels[mode]}</span>
            <span className="item-desc">{descriptions[mode]}</span>
          </span>
        </DropdownItem>
      ))}
    </Dropdown>
  );
}
