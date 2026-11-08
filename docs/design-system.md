# Design system do app (Rio Negro)

A identidade visual do app desktop é a paleta Rio Negro, descrita em `DESIGN.md`. O produto na interface se chama Boto. A metáfora é o rio: água escura no fundo, verde-água no que está em andamento e o rosa do boto como único sinal de destaque.

## Fonte da verdade

| Arquivo | Papel |
|---|---|
| `DESIGN.md` | Linguagem visual: paleta, tipo, raio, movimento e voz. |
| `apps/desktop/src/styles/tokens.json` | Valores que o app emite. Não edite o CSS à mão. |
| `scripts/build-tokens.ts` | Gerador. Roda com Bun, sem Python. |
| `apps/desktop/src/styles/tokens.css` | Gerado. Namespace `--boto-*`. Único CSS com hex. |
| `apps/desktop/src/styles/legacy-bridge.css` | Gerado. Nomes antigos (`--fg`, `--accent`, `--st-err`…) apontam para `--boto-*`. |

Regerar e conferir que o CSS commitado não muda:

```bash
bun scripts/build-tokens.ts
```

O `apps/desktop/src/index.css` importa `tokens.css` e, em seguida, `legacy-bridge.css`. O tema escuro é `:root`. O claro só entra com `[data-theme="light"]` no `<html>`. Sem preferência salva, `apps/desktop/src/lib/theme.ts` aplica escuro. A opção Automático das Configurações continua seguindo o sistema quando a pessoa a escolhe.

`tailwind.theme.css` (utilitários novos como `bg-surface`) não entra enquanto as telas legadas não usarem essas classes. O `@theme` atual só remapeia `red-*` para a cor de erro.

## Paleta Rio Negro

| Nome | Hex | Papel |
|---|---|---|
| Rio Negro | `#0c1416` | Fundo escuro, texto principal no claro |
| Igapó | `#131d20` | Cards no escuro |
| Névoa | `#e8eeee` | Texto no escuro |
| Boto-rosa | `#f08aa6` | Ação principal, foco e aguardando você no escuro |
| Boto-rosa fundo | `#c2456b` | Ação principal, foco e aguardando você no claro |
| Água | `#3bb7a5` | Em execução e sucesso no escuro |
| Água fundo | `#1a7d6f` | Em execução e sucesso no claro |
| Praia | `#f6f8f7` | Fundo claro |

## Mapeamento Rio Negro → token

O código novo lê o nome semântico. A ponte mantém o nome antigo para `boto.css`.

| Token | Claro | Escuro | Nome antigo |
|---|---|---|---|
| `background` / `bg` | `#f6f8f7` | `#0c1416` | `--bg` |
| `card` / `surface` | `#ffffff` | `#131d20` | `--surface` |
| `foreground` / `fg` | `#0c1416` | `#e8eeee` | `--fg` |
| `muted-foreground` / `fg-muted` | `#55676a` | `#93a3a5` | `--muted` |
| `primary` / `accent` | `#c2456b` | `#f08aa6` | `--accent` |
| `primary-foreground` / `on-accent` | `#ffffff` | `#0c1416` | `--on-accent` |
| `ring` / `focus` | `#c2456b` | `#f08aa6` | `--focus` |
| `destructive` / `danger` | `#b8382a` | `#ef7b6c` | `--st-err` |
| `success` / `status-run` | `#1a7d6f` | `#3bb7a5` | `--st-run` |
| `status-wait` | `#c2456b` | `#f08aa6` | `--st-wait` |
| `status-muted` / `status-idle` | `#55676a` | `#93a3a5` | parado / na fila |
| `status-done` / `status-ok` | `#55676a` | `#93a3a5` | `--st-ok` |
| `sidebar` | `#eef2f1` | `#0f191b` | `--side` |

O nome legado `accent` é a ação principal (`primary`). O hover de item do DESIGN (`--accent`) está em `accent-surface` / `surface-hover`. `--muted` na ponte continua sendo texto de apoio, não a superfície `muted-surface`.

O botão principal usa `accent` com texto `on-accent`: Boto-rosa fundo com branco no claro (4,82:1) e Boto-rosa com Rio Negro no escuro (7,89:1). Texto de apoio sobre o fundo passa de 4,5:1 nos dois temas.

Situação usa os tons `run`, `wait`, `muted` e `done`. `run` é Água, `wait` é Boto-rosa, `muted` e `done` usam o texto de apoio. Cada status leva ícone e texto: `run` usa o loader, `wait` o alerta, `muted` pausa ou alerta de erro, `done` o visto. `queue` usa o tom `wait` com o texto "Na fila"; `err` usa o tom `muted` com o texto "Com erro". A cor sozinha não comunica estado.

A ponte também define `--ink`, `--pill-mix`, `--pill-ink`, `--container`, `--gutter`, `--dur-preview` e os `--preview-*` das miniaturas de tema.

## Forma, medida e movimento

| Token | Valor |
|---|---|
| Raios `sm` / `md` / `lg` / `xl` | 6 / 8 / 12 / 16 px |
| `radius-full` | 999 px |
| Durações `fast` / `base` / `panel` / `exit` | 150 / 200 / 260 / 170 ms |
| Entrada | `cubic-bezier(0.16, 1, 0.3, 1)` |
| Saída | `cubic-bezier(0.55, 0, 1, 0.45)` |
| Barra lateral | 272 px |
| Início | 1160 px |
| Coluna do chat | 760 px |

`prefers-reduced-motion: reduce` zera as durações e para as animações.

## Tipografia

| Uso | Família | Peso |
|---|---|---|
| Títulos e saudações | Bricolage Grotesque | 500 a 700 |
| Interface e relatos | Inter | 400 a 600 |
| Horários, comandos, código | JetBrains Mono | 400 a 500 |
| Corpo | `--fs-body` | 16 px |

As faces estão em `apps/desktop/src/fonts/` (woff2 variável, subset latin e latin-ext), com `OFL-BricolageGrotesque.txt`, `OFL-Inter.txt` e `OFL-JetBrainsMono.txt`. Não há CDN. O `@font-face` fica no `tokens.css` gerado. `--font-display` aponta para Bricolage Grotesque; `--font-body` aponta para Inter.

Alguns módulos ainda declaram peso 700 ou 800 por cima da regra global (`AgentConfigScreen`, `AppsView`, `Approvals`, `MenuBar`). A coluna da conversa usa `var(--col-chat)` em `boto.css`; o token `size-chat-column` é 760 px.

## O que o kit mostra

`#/kit` lista os papéis da paleta e os controles. Os testes em `apps/desktop/test/design-system.test.ts` exigem:

- nenhum hex fora de `tokens.css`;
- contraste AA a partir do estilo computado (`--fg`/`--bg`, `--fg`/`--surface`, `--muted`/`--bg` e `--on-accent`/`--accent` ≥ 4,5:1; `--focus`/`--bg` ≥ 3:1);
- anel de foco de 2 px com folga de 3 px (`--boto-size-focus-ring` e `--boto-size-focus-offset`);
- altura de controle de 36 px (`--boto-size-control`; a pequena é 32 px) e 44 px em `pointer: coarse`;
- `bun scripts/build-tokens.ts` sem diff no CSS commitado.

A barra lateral, o Início e o cockpit de agentes estão em [design-system-sidebar.md](design-system-sidebar.md).

## Integrações secundárias

Habilidades, Navegador, Cofre, Gateways, Marketplace, Celular e Equipe (`Library.tsx`), Servidores (`HostsView.tsx`) e E-mail (`EmailView.tsx`) usam os controles de `components/ds/`, com textos em pt-BR e os controles e RPCs existentes preservados. Os estilos ficam em `Library.module.css`, `HostsView.module.css` e `EmailView.module.css`, com tokens `--boto-*`, sem layouts utilitários Tailwind nessas nove telas. Os rascunhos do compositor (`DraftCards`) mantêm sua apresentação e comportamento existentes; a apresentação dos rascunhos nas configurações de E-mail usa os mesmos controles.
