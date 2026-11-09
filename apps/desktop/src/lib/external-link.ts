import { openUrl } from "@tauri-apps/plugin-opener";

export async function openExternalLink(url: string) {
  if ("__TAURI_INTERNALS__" in window) await openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
