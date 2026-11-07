# Design system do app (Eco)

A identidade visual do app desktop é a paleta Eco. O produto na interface se chama Boto. O símbolo, o ícone do app e a migração das telas Tailwind ficam fora deste documento.

Este texto parte do design system do Versace (31/10/2026) e descreve o que está no repositório.

## Fonte da verdade

| Arquivo | Papel |
|---|---|
| `apps/desktop/src/styles/tokens.json` | Fonte. Fórmulas e valores. Não edite o CSS à mão. |
| `scripts/build-tokens.ts` | Gerador. Roda com Bun, sem Python. |
| `apps/desktop/src/styles/tokens.css` | Gerado. Namespace `--boto-*`. Único CSS com hex. |
| `apps/desktop/src/styles/legacy-bridge.css` | Gerado. Nomes antigos (`--fg`, `--accent`, `--st-err`…) apontam para `--boto-*`. |

Regerar e conferir que o CSS commitado não muda:

```bash
bun scripts/build-tokens.ts
```

O `apps/desktop/src/index.css` importa `tokens.css` e, em seguida, `legacy-bridge.css`. O tema claro é `:root`; o escuro é `[data-theme="dark"]` no `<html>` (`apps/desktop/src/lib/theme.ts`).

`tailwind.theme.css` (utilitários novos como `bg-surface`) não entra enquanto as telas legadas não usarem essas classes. O `@theme` atual só remapeia `red-*` para a cor de erro.

## Paleta Eco

| Nome | Hex | Papel |
|---|---|---|
| Água preta | `#110E12` | Fundo escuro, texto principal no claro |
| Rosa boto | `#F29BB2` | Destaque no escuro, foco no escuro |
| Rosa fundo | `#C2557B` | Foco no claro, eco do símbolo no escuro |
| Ametista | `#7A4A6E` | Botão principal no claro, texto secundário no claro |
| Névoa | `#EDE6EA` | Fundo claro, texto no escuro |

Toda outra cor é `mix(A, B, p) = round(A·p + B·(1−p))` em cada canal R, G e B. O branco `#FFFFFF` só entra como ingrediente para clarear superfícies do claro (por exemplo `surface`). Ele não aparece puro.

## Mapeamento Eco → token

| Token | Claro | Escuro | Nome antigo |
|---|---|---|---|
| `bg` | `#EDE6EA` | `#110E12` | `--bg` |
| `surface` | `#F8F5F7` | `#201D21` | `--surface` |
| `fg` | `#110E12` | `#EDE6EA` | `--fg` |
| `fg-muted` | `#7A4A6E` | `#ABA5A9` | `--muted` |
| `accent` | `#7A4A6E` | `#F29BB2` | `--accent` |
| `on-accent` | `#EDE6EA` | `#110E12` | `--on-accent` |
| `focus` | `#C2557B` | `#F29BB2` | `--focus` |
| `danger` | `#9F4766` | `#DA7896` | `--st-err` |
| `danger-text` | `#90415E` | `#E68AA4` | texto de erro nas telas antigas |
| `status-run` | `#7A4A6E` | `#AE90A6` | `--st-run` |
| `status-wait` | `#40293B` | `#EEDBE2` | `--st-wait` |
| `status-ok` | `#656064` | `#999498` | `--st-ok` |
| `status-idle` | `#7F7A7E` | `#837E82` | parado / na fila |

O botão principal usa `accent` com texto `on-accent`: ametista com Névoa no claro (5,64:1) e rosa com Água preta no escuro (9,23:1).

Status não usa verde, âmbar nem vermelho. Cada estado tem cor da paleta, uma forma e um texto: ponto que pulsa, relógio, check, triângulo e anel vazio. O item selecionado da barra usa `surface-selected`, não a inversão de `--fg` com `--bg`.

Erros nas telas que ainda usam classes Tailwind `red-*`, e as classes `.err`, `.errlog` e `.channel-error`, leem `danger-text` / `danger`. Isso é token, não uma reescrita dessas telas.

A ponte também define as variáveis que o app já usava e que não tinham nome novo óbvio: `--ink`, `--pill-mix`, `--pill-ink`, `--container`, `--gutter`, `--dur-preview` e os `--preview-*` das miniaturas de tema.

## Tipografia

| Uso | Família | Peso / tamanho |
|---|---|---|
| Texto e títulos | Host Grotesk | 400 no corpo, 600 nos títulos |
| Rótulos, dados, código | DM Mono | 400 e 500 |
| Corpo | `--fs-body` | 16px |

As faces estão em `apps/desktop/src/fonts/` (woff2, subset latin + latin-ext), com `OFL-HostGrotesk.txt` e `OFL-DMMono.txt`. Não há CDN. O `@font-face` fica no `tokens.css` gerado.

Alguns módulos ainda declaram peso 700 ou 800 por cima da regra global (`AgentConfigScreen`, `AppsView`, `Approvals`, `MenuBar`). A coluna da conversa usa `var(--col-chat)` em `boto.css`; o token `size-chat-column` é 760px.

## O que o kit mostra

`#/kit` lista os papéis da paleta e os controles. Os testes em `apps/desktop/test/design-system.test.ts` exigem:

- nenhum hex fora de `tokens.css`;
- contraste AA a partir do estilo computado (`--fg`/`--bg`, `--fg`/`--surface`, `--muted`/`--bg` e `--on-accent`/`--accent` ≥ 4,5:1; `--focus`/`--bg` ≥ 3:1);
- anel de foco de 2px com folga de 3px;
- alvo de pelo menos 44px;
- `bun scripts/build-tokens.ts` sem diff no CSS commitado.

## Integrações secundárias

Servidores (`HostsView.tsx`) e E-mail (`EmailView.tsx`) usam os controles de `components/ds/` e seus próprios CSS Modules com tokens `--boto-*`, sem layouts utilitários Tailwind, com textos em pt-BR. Os rascunhos do compositor mantêm sua apresentação existente; a apresentação Eco é ativada apenas nas configurações de E-mail. As telas de `Library.tsx` são migradas em um PR separado.
