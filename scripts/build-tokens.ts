import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type ThemeValue = { value: string };
type Themed = { light: ThemeValue; dark: ThemeValue };
type Tokens = {
  font: {
    family: Record<string, ThemeValue>;
    weight: Record<string, ThemeValue>;
    size: Record<string, ThemeValue>;
    lineHeight: Record<string, ThemeValue>;
    letterSpacing: Record<string, ThemeValue>;
  };
  space: Record<string, ThemeValue | string>;
  radius: Record<string, ThemeValue>;
  motion: {
    duration: Record<string, ThemeValue>;
    easing: Record<string, ThemeValue>;
  };
  size: Record<string, ThemeValue>;
  color: Record<string, Themed>;
  colorAlpha: Record<string, Themed>;
  shadow: Record<string, Themed>;
  mix: Record<string, Themed>;
};

const FONT_FACES = `@font-face {
  font-family: 'Host Grotesk';
  src: url('../fonts/host-grotesk-latin.woff2') format('woff2');
  font-weight: 300 800;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: 'DM Mono';
  src: url('../fonts/dm-mono-400-latin.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: 'DM Mono';
  src: url('../fonts/dm-mono-500-latin.woff2') format('woff2');
  font-weight: 500;
  font-style: normal;
  font-display: swap;
}
`;

const LEGACY_VARS: Record<string, string> = {
  bg: "color-bg",
  surface: "color-surface",
  fg: "color-fg",
  muted: "color-fg-muted",
  border: "color-border",
  accent: "color-accent",
  "on-accent": "color-on-accent",
  focus: "color-focus",
  "logo-sym": "color-logo-body",
  side: "color-bg-sidebar",
  "fg-soft": "color-surface-hover",
  "fg-softer": "color-surface-hover",
  "foot-bg": "color-surface-raised",
  "accent-soft": "color-accent-soft",
  scrim: "color-scrim",
  "shadow-pop": "shadow-lg",
  "shadow-icon": "shadow-sm",
  "st-run": "color-status-run",
  "st-wait": "color-status-wait",
  "st-ok": "color-status-ok",
  "st-err": "color-danger",
  "font-display": "font-sans",
  "font-body": "font-sans",
  "font-mono": "font-mono",
  "fs-label": "font-size-label",
  "fs-small": "font-size-label",
  "fs-meta": "font-size-small",
  "fs-ui": "font-size-small",
  "fs-body": "font-size-body",
  "fs-card": "font-size-lead",
  "fs-sec": "font-size-lead",
  "fs-dialog": "font-size-title",
  "fs-page": "font-size-page",
  "fs-home": "font-size-display",
  "gap-xs": "space-2",
  "gap-sm": "space-3",
  "gap-md": "space-5",
  "gap-lg": "space-8",
  "gap-xl": "space-12",
  "gap-2xl": "space-16",
  "radius-xs": "radius-xs",
  "radius-sm": "radius-sm",
  radius: "radius-md",
  "radius-md": "radius-md",
  "radius-lg": "radius-lg",
  "radius-xl": "radius-xl",
  "radius-pill": "radius-pill",
  ease: "easing-standard",
  "dur-fast": "duration-fast",
  "dur-layer": "duration-base",
  "dur-theme": "duration-base",
  "dur-status": "duration-pulse",
  "dur-spin": "duration-pulse",
  "dur-progress": "duration-slow",
  "sidebar-width": "size-sidebar",
  "col-chat": "size-chat-column",
  ink: "color-ink",
  "pill-mix": "mix-pill-bg",
  "pill-ink": "mix-pill-ink",
  "preview-light-bg": "color-preview-light-bg",
  "preview-light-fg": "color-preview-light-fg",
  "preview-light-border": "color-preview-light-border",
  "preview-dark-bg": "color-preview-dark-bg",
  "preview-dark-surface": "color-preview-dark-surface",
  "preview-dark-fg": "color-preview-dark-fg",
  "preview-dark-border": "color-preview-dark-border",
  container: "size-container",
  gutter: "size-gutter",
  "dur-preview": "duration-preview",
  sky: "color-accent-soft",
};

/** JSON.parse sorts integer-like keys, so "0-5" would land after "16". Keep the file order. */
function sourceKeyOrder(raw: string, section: string): string[] {
  const match = new RegExp(`"${section}"\\s*:\\s*\\{`).exec(raw);
  if (!match) return [];
  let depth = 1;
  const keys: string[] = [];
  for (let i = match.index + match[0].length; i < raw.length && depth > 0; i++) {
    const char = raw[i];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === '"' && depth === 1) {
      const end = raw.indexOf('"', i + 1);
      const key = raw.slice(i + 1, end);
      if (/^\s*:/.test(raw.slice(end + 1)) && !key.startsWith("$")) keys.push(key);
      i = end;
    }
  }
  return keys;
}

function flatStatic(tokens: Tokens, raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const font = tokens.font;
  for (const [key, value] of Object.entries(font.family)) out.push([`font-${key}`, value.value]);
  for (const [key, value] of Object.entries(font.weight))
    out.push([`font-weight-${key}`, value.value]);
  for (const [key, value] of Object.entries(font.size)) out.push([`font-size-${key}`, value.value]);
  for (const [key, value] of Object.entries(font.lineHeight))
    out.push([`line-height-${key}`, value.value]);
  for (const [key, value] of Object.entries(font.letterSpacing))
    out.push([`letter-spacing-${key}`, value.value]);
  const space = tokens.space as Record<string, ThemeValue>;
  for (const key of sourceKeyOrder(raw, "space")) out.push([`space-${key}`, space[key].value]);
  for (const [key, value] of Object.entries(tokens.radius))
    out.push([`radius-${key}`, value.value]);
  for (const [key, value] of Object.entries(tokens.motion.duration))
    out.push([`duration-${key}`, value.value]);
  for (const [key, value] of Object.entries(tokens.motion.easing))
    out.push([`easing-${key}`, value.value]);
  for (const [key, value] of Object.entries(tokens.size)) out.push([`size-${key}`, value.value]);
  return out;
}

function themed(tokens: Tokens, theme: "light" | "dark"): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(tokens.color))
    out.push([`color-${key}`, value[theme].value]);
  for (const [key, value] of Object.entries(tokens.colorAlpha))
    out.push([`color-${key}`, value[theme].value]);
  for (const [key, value] of Object.entries(tokens.shadow))
    out.push([`shadow-${key}`, value[theme].value]);
  for (const [key, value] of Object.entries(tokens.mix))
    out.push([`mix-${key}`, value[theme].value]);
  return out;
}

export function renderTokensCss(tokens: Tokens, raw: string): string {
  const lines = [
    "/* Boto — tokens de design. GERADO por scripts/build-tokens.ts a partir de tokens.json. Não edite à mão. */",
    '/* Tema claro em :root; escuro em [data-theme="dark"] no <html> (apps/desktop/src/lib/theme.ts). */',
    "",
    FONT_FACES.trimEnd(),
    "",
    ":root {",
    "  color-scheme: light;",
  ];
  for (const [name, value] of flatStatic(tokens, raw)) lines.push(`  --boto-${name}: ${value};`);
  for (const [name, value] of themed(tokens, "light")) lines.push(`  --boto-${name}: ${value};`);
  lines.push("}", "", '[data-theme="dark"] {', "  color-scheme: dark;");
  for (const [name, value] of themed(tokens, "dark")) lines.push(`  --boto-${name}: ${value};`);
  lines.push(
    "}",
    "",
    "/* Movimento reduzido (WCAG 2.3.3, preferência do sistema): durações zeradas e animações paradas. */",
    "@media (prefers-reduced-motion: reduce) {",
    "  :root {",
  );
  for (const key of Object.keys(tokens.motion.duration))
    lines.push(`    --boto-duration-${key}: 0ms;`);
  lines.push(
    "  }",
    "  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }",
    "}",
    "",
  );
  return lines.join("\n");
}

export function renderLegacyBridge(): string {
  const lines = [
    "/* Ponte de migração: nomes antigos do UpBot apontando para os tokens do Boto. GERADO por scripts/build-tokens.ts.",
    " * Permite trocar apps/desktop/src/styles/tokens.css sem reescrever upbot.css de uma vez. Remover quando ninguém mais usar os nomes antigos. */",
    ':root, [data-theme="dark"] {',
  ];
  for (const [name, token] of Object.entries(LEGACY_VARS))
    lines.push(`  --${name}: var(--boto-${token});`);
  lines.push("}", "");
  return lines.join("\n");
}

/** Keep the checkout's newline so Windows (core.autocrlf) does not see a false diff. */
function writeIfChanged(path: string, text: string) {
  const lf = text.replaceAll("\r\n", "\n");
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = "";
  }
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const next = lf.replaceAll("\n", newline);
  if (current === next) return;
  writeFileSync(path, next);
}

if (import.meta.main) {
  const stylesDir = process.argv[2] ?? join(import.meta.dir, "../apps/desktop/src/styles");
  const raw = readFileSync(join(stylesDir, "tokens.json"), "utf8");
  const tokens = JSON.parse(raw) as Tokens;
  writeIfChanged(join(stylesDir, "tokens.css"), renderTokensCss(tokens, raw));
  writeIfChanged(join(stylesDir, "legacy-bridge.css"), renderLegacyBridge());
}
