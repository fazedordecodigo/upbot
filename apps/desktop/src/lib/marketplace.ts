import type { MarketplaceItem } from "@boto/protocol";
import type { IconName } from "../ui/icons";

export const marketplaceTabs = [
  { value: "apps", label: "Apps", kind: "app" },
  { value: "plugins", label: "Plugins", kind: "plugin" },
  { value: "skills", label: "Skills", kind: "skill" },
  { value: "mcp", label: "Servidores MCP", kind: "mcp" },
  { value: "agents", label: "Agentes", kind: "agent" },
] as const;

const brands: Record<string, string> = {
  notion: "notion-icon.svg",
  github: "github-icon.svg",
  stripe: "stripe-icon.svg",
  slack: "slack-icon.svg",
  linear: "linear-icon.svg",
  figma: "figma.svg",
  "google-drive": "google-drive.svg",
  gmail: "google-gmail.svg",
  jira: "jira.svg",
  playwright: "playwright.svg",
  postgresql: "postgresql.svg",
  sentry: "sentry-icon.svg",
  vercel: "vercel-icon.svg",
  context7: "context7.png",
};
const icons: IconName[] = [
  "app-window",
  "arrow-left",
  "arrow-right",
  "arrow-up",
  "arrow-up-right",
  "book-open",
  "calendar",
  "check",
  "chevron-down",
  "chevron-up-down",
  "circle-alert",
  "circle-check",
  "circle-pause",
  "circle-slash",
  "clock",
  "cpu",
  "download",
  "eye-off",
  "file-code",
  "file-text",
  "folder",
  "git-pull-request",
  "globe",
  "home",
  "info",
  "keyboard",
  "layout-template",
  "list-checks",
  "loader",
  "mail",
  "menu",
  "monitor",
  "moon",
  "mouse-pointer",
  "palette",
  "panel-left",
  "paperclip",
  "pause",
  "play",
  "plus",
  "power",
  "refresh-cw",
  "repeat",
  "search",
  "send",
  "settings",
  "sheet",
  "shield-check",
  "store",
  "sun",
  "terminal",
  "trash",
  "user-check",
  "users",
  "x",
];

export function marketplaceLogo(item: MarketplaceItem) {
  const file = brands[item.catalogId ?? item.id];
  return file ? `/assets/brands/${file}` : null;
}

export function marketplaceIcon(icon: string | null): IconName {
  return icons.find((name) => `i-${name}` === icon) ?? "store";
}

export function sortMarketplace(items: MarketplaceItem[]) {
  return [...items].sort(
    (a, b) => Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name, "pt-BR"),
  );
}
