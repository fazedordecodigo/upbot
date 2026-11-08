# Boto · Design system

Referência única da linguagem visual do Boto, para quem desenha ou escreve código novo. Este documento define as regras; os tokens da implementação ficam em `apps/desktop/src/styles/tokens.json`, com CSS gerado por `bun scripts/build-tokens.ts`. Se o código ou os protótipos divergirem desta referência, corrija a implementação.

- Guia de marca visual: `docs/design/identidade.html`
- Protótipo: `docs/design/index.html`
- Arquitetura técnica: `docs/design/system-design.html`

As três páginas usam os tokens e as fontes locais de `apps/desktop/src/styles/tokens.css`, com um adaptador mínimo de componentes em `docs/design/assets/boto-ui.css`. Os assets originais do export não estão disponíveis: os protótipos preservam a navegação e as demonstrações essenciais, não a simulação completa de tarefas e máquinas.

## 1. Conceito

Boto é uma plataforma de agentes de IA autônomos. Cada agente trabalha como um colega virtual, num computador próprio na nuvem, e executa tarefas de ponta a ponta. O nome junta o boto-cor-de-rosa, o golfinho dos rios da Amazônia, com a palavra bot: **bot + o = boto**.

A metáfora visual é o Rio Negro: água escura como fundo, verde-água das margens para o que está em andamento e o rosa do boto como único sinal de destaque.

### Princípios que guiam a interface

1. **Trabalha no próprio computador.** A área de trabalho do agente é parte da interface, não um detalhe escondido.
2. **Mostra o que está fazendo.** Plano, ações e tela ficam à vista. O usuário pode pausar, instruir ou assumir o controle a qualquer momento.
3. **Pede antes de agir fora.** Aprovações e permissões são momentos de destaque. São os únicos lugares onde o rosa chama a ação.

## 2. Cores

O tema escuro é o padrão. O tema claro tem valores próprios, ajustados para manter o contraste; ele não é uma inversão automática.

### Paleta da marca

| Nome | Token | Valor | Papel |
|---|---|---|---|
| Rio Negro | `--rio-negro` | `#0c1416` | Fundo do tema escuro, texto do tema claro |
| Igapó | `--igapo` | `#131d20` | Superfícies (cards) no tema escuro |
| Névoa | `--nevoa` | `#e8eeee` | Texto no tema escuro |
| Boto-rosa | `--boto-rosa` | `#f08aa6` | Destaque no tema escuro: ação principal, foco, aguardando você |
| Boto-rosa fundo | `--boto-rosa-fundo` | `#c2456b` | Destaque no tema claro |
| Água | `--agua` | `#3bb7a5` | Em execução, progresso e sucesso no tema escuro |
| Água fundo | `--agua-fundo` | `#1a7d6f` | Em execução e sucesso no tema claro |
| Praia | `--praia` | `#f6f8f7` | Fundo do tema claro |

Proporção de uso sugerida: 70% Rio Negro e Igapó, 20% Névoa, 6% Boto-rosa, 4% Água.

### Tokens semânticos (anatomia do shadcn/ui)

Use sempre o token semântico no código, nunca o valor da paleta direto.

| Token | Escuro | Claro | Uso |
|---|---|---|---|
| `--background` | `#0c1416` | `#f6f8f7` | Fundo da página |
| `--foreground` | `#e8eeee` | `#0c1416` | Texto principal |
| `--card` | `#131d20` | `#ffffff` | Cards e painéis |
| `--popover` | `#151f22` | `#ffffff` | Menus, diálogos, avisos |
| `--primary` | `#f08aa6` | `#c2456b` | Botão principal, foco, aguardando você |
| `--primary-hover` | `#f4a3b9` | `#a93a5b` | Hover do botão principal |
| `--primary-foreground` | `#0c1416` | `#ffffff` | Texto sobre o primário |
| `--secondary` | `#1c292c` | `#e9eeed` | Botão secundário, avatar |
| `--muted` | `#182326` | `#edf1f0` | Trilhos, fundo de abas |
| `--muted-foreground` | `#93a3a5` | `#55676a` | Texto de apoio, metadados |
| `--accent` | `#1f2d31` | `#e5ebea` | Hover de itens e botões fantasma |
| `--destructive` | `#ef7b6c` | `#b8382a` | Excluir, encerrar, revogar |
| `--success` | `#3bb7a5` | `#1a7d6f` | Em execução, progresso, entregue |
| `--border` | `#243337` | `#dae2e1` | Bordas de cards e divisórias |
| `--input` | `#2c3d41` | `#cad6d5` | Bordas de campos, trilho do switch |
| `--ring` | `#f08aa6` | `#c2456b` | Anel de foco |
| `--sidebar` | `#0f191b` | `#eef2f1` | Barra lateral e Sheet |
| `--overlay` | `rgb(4 8 9 / .66)` | `rgb(12 20 22 / .4)` | Fundo de diálogos |
| `--tabs-active` | `#2a3b3f` | `#ffffff` | Fundo da aba ativa na lista segmentada |
| `--logo-tile` | `#ffffff` | `#ffffff` | Placa de logos de terceiros |

O tema é escolhido por `data-theme="light"` no elemento `html`; sem o atributo vale o escuro.

### Regras de cor

- O rosa é sinal, não superfície. Nunca use `--primary` como fundo de seção, degradê ou área grande.
- Um único botão primário por área da tela. As demais ações usam contorno, secundário ou fantasma.
- O estado nunca depende só da cor: todo status tem ícone e texto.
- Contraste mínimo: 4,5:1 para texto de corpo e 3:1 para texto grande, ícones e gráficos essenciais. Confira os dois temas separadamente.
- A área de trabalho do agente (desktop da VM) usa sempre Rio Negro, nos dois temas, porque representa outra máquina.

## 3. Tipografia

| Papel | Família | Pesos | Token |
|---|---|---|---|
| Títulos e saudações | Bricolage Grotesque | 500 a 700 | `--font-display` |
| Interface e relatos do agente | Inter | 400 a 600 | `--font-sans` |
| Horários, comandos, atalhos, nomes de máquina | JetBrains Mono | 400 a 500 | `--font-mono` |

Pilhas completas, para quando a fonte não carregar:

```css
--font-display: "Bricolage Grotesque", "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
--font-sans: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
--font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
```

### Escala

| Nível | Tamanho / altura de linha | Família | Token |
|---|---|---|---|
| Display | 56 / 1,05, tracking −0,03em | Display 600 | `--text-4xl` |
| Título 1 | 40 / 1,1 | Display 600 | `--text-3xl` |
| Título 2 | 28 / 1,15 | Display 600 | `--text-2xl` |
| Título 3 | 20 / 1,25 | Display 600 | `--text-xl` |
| Destaque | 18 | Sans | `--text-lg` |
| Corpo | 16 / 1,55 a 1,6 | Sans 400 | `--text-base` |
| Apoio e controles | 14 / 1,5 | Sans 500 | `--text-sm` |
| Detalhe | 12, mono, caixa alta, tracking 0,06em | Mono | `--text-xs` |

- Títulos usam `letter-spacing: -0.01em` e peso 600.
- Texto de corpo nunca abaixo de 16 px. Linhas de 65 a 75 caracteres no desktop.
- O nome do produto é escrito "Boto" no texto corrido. Só o logo usa minúsculas.

## 4. Espaçamento, forma e camadas

### Espaçamento (base 4 px)

`--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 · `--space-5` 20 · `--space-6` 24 · `--space-8` 32 · `--space-10` 40 · `--space-12` 48 · `--space-16` 64 · `--space-20` 80

### Raios

| Token | Valor | Onde |
|---|---|---|
| `--radius-sm` | 6px | Abas, itens de menu, tooltip |
| `--radius-md` | 8px | Botões, campos, lista de abas |
| `--radius-lg` | 12px | Cards, menus, avisos |
| `--radius-xl` | 16px | Diálogos |
| `--radius-full` | 999px | Selos, status, switch, avatar, botão de envio |

### Bordas e sombras

- Bordas de 1 px em `--border`. Separe regiões com bordas finas e espaço, não com sombras pesadas.
- `--shadow-sm` só em elementos elevados pequenos (aba ativa, botão do switch).
- `--shadow-lg` só em camadas sobrepostas: menus, diálogos, Sheet e avisos.

### Controles

- Altura padrão `--control-h` 36 px; pequena `--control-h-sm` 32 px.
- Em telas de toque (`pointer: coarse`) os dois passam para 44 px.

## 5. Layout do app

| Medida | Valor |
|---|---|
| Barra lateral | `--sidebar-w` 272 px, ajustável de 220 a 400 px, largura salva no navegador |
| Largura máxima do Início | `--home-w` 1160 px |
| Largura do chat de nova tarefa | `--chat-w` 760 px |
| Navegação das Configurações | coluna de 220 px |

### Pontos de quebra

- **Até 1023 px:** a barra lateral vira Sheet (painel deslizante). A tela da tarefa troca as duas colunas pelas abas Atividade e Área de trabalho.
- **Até 767 px:** diálogos grandes (onboarding, máquina livre) ocupam a tela inteira.
- **Até 479 px e 380 px:** ajustes finos de densidade.

### Estrutura das telas

- **Barra lateral:** logo, Nova tarefa, Início, Agentes, Rotinas, Modelos, Marketplace, busca, tarefas agrupadas por situação e, no rodapé, a pessoa (iniciais e nome) com atalho para Configurações. Não há plano nem conta.
- **Início:** saudação curta, título e botão Nova tarefa; depois Em andamento, Aguardando você e Entregas recentes; o cartão das áreas de trabalho ativas fica no fim.
- **Tela da tarefa:** linha do tempo à esquerda; área de trabalho ao vivo à direita, opcional, com divisória arrastável. Controles no topo: Pausar ou Retomar, Assumir o controle, Encerrar.
- **Agentes (cockpit):** resumo numérico, filtro por situação e um card por agente com instâncias, tarefas em execução, fila e miniaturas das máquinas.

### Mecânica de layout

- Regiões de conteúdo em fluxo normal, com grid ou flex. Posicionamento absoluto só para sobreposições decorativas e para as janelas e o cursor dentro da área de trabalho.
- Texto de tamanho variável sempre com destino definido: quebra com limite de linhas, uma linha com reticências (`.od-truncate`) ou detalhe atrás de um botão de abrir.
- Horários, comandos e números com unidade levam `white-space: nowrap`.

## 6. Componentes

Os componentes seguem a anatomia e os nomes de variáveis do shadcn/ui. Nos protótipos, `docs/design/assets/boto-ui.css` adapta esses nomes aos tokens `--boto-*` da implementação.

| Componente | Classes | Notas |
|---|---|---|
| Button | `.btn` + `.btn-primary`, `.btn-secondary`, `.btn-outline`, `.btn-ghost`, `.btn-destructive`, `.btn-link` | Tamanhos `.btn-sm`, `.btn-lg`, `.btn-icon`; `.btn-pill` só no envio de tarefa. Um primário por área |
| Badge | `.badge`, `.badge-secondary`, `.badge-outline`, `.badge-success` | Altura 22 px, pílula, 12 px peso 600 |
| Status | `.status[data-tone]` | Ver seção 7 |
| Progress | `.progress > span` com `--p` de 0 a 1 | Variável local, sem unidade: fração concluída (padrão 0), não uma cor. Trilho de 4 px em `--muted`, preenchimento em `--success` |
| Input, Textarea, Label | `.input`, `.textarea`, `.label` | Campo de 40 px; foco troca a borda para `--ring` e mostra halo de 3 px |
| Card | `.card`, `.card-header`, `.card-title`, `.card-description`, `.card-content`, `.card-footer` | Raio 12 px, padding 20 px |
| Tabs | `.tabs-list`, `.tabs-trigger` | Lista segmentada; a aba ativa ganha `--tabs-active` e sombra pequena |
| Switch | `.switch[role=switch][aria-checked]` | 40 × 22 px; ligado em `--primary`; sempre com label e texto de estado |
| Avatar | `.avatar` | 32 px, iniciais da pessoa ou símbolo do Boto |
| Separator | `.separator` | 1 px em `--border` |
| Kbd | `.kbd` | Atalhos em mono 11 px |
| Tooltip | `.tooltip` | Cores invertidas, máximo 240 px, 13 px |
| Dropdown Menu | `.dropdown-menu`, `.dropdown-item` | Mínimo 224 px; itens de 36 px (44 px em toque) |
| Dialog | `.dialog` (elemento `dialog` nativo) | Até 520 px, raio 16 px; usado na paleta ⌘K e nas confirmações destrutivas |
| Sheet | `.sheet` | Painel lateral de até 320 px; barra lateral no celular e painéis de detalhe |
| Toast | `.toaster`, `.toast` | Canto inferior direito, até 360 px |

### Padrões próprios do Boto

- **Cartão de aprovação:** descreve a ação externa exata (destinatários, repositório, arquivo) e oferece Aprovar como primário e Recusar como contorno.
- **Cartão de permissão:** aparece no primeiro uso de uma ferramenta na sessão. Mostra o ícone ou logo da ferramenta, o que ela faz e a etapa. Botões: Permitir nesta sessão, Permitir em todas as sessões e Não permitir. Depois da resposta, mostra a decisão e a hora.
- **Indicador de memória:** abaixo de cada resposta do agente, um botão compacto "Usou N itens da memória · Tipo e Tipo" que abre a lista com link para editar.
- **Área de trabalho do agente:** desktop em Rio Negro com a marca do Boto a 16% de opacidade, barra de apps embaixo, janelas com minimizar, maximizar e fechar, e o nome da máquina em mono (por exemplo `codigo-01`). O cursor do agente é uma seta Boto-rosa com contorno Rio Negro e o rótulo "Boto"; cada clique mostra uma onda. Quando o usuário assume o controle, a borda da área passa a `--primary` e aparece a faixa "Você está no controle".
- **Logos de terceiros:** ícones de apps, CLIs e provedores ficam sobre uma placa branca (`--logo-tile`) para funcionar nos dois temas. Os arquivos estão em `assets/brands/`.

## 7. Situação de tarefas e agentes

Cada situação combina tom, ícone e texto. A cor sozinha nunca comunica estado.

| Situação | `data-tone` | Cor | Ícone |
|---|---|---|---|
| Em execução, Trabalhando | `run` | `--success` | `loader` |
| Aguardando você (aprovação ou permissão) | `wait` | `--primary` | `circle-alert` |
| Pausada, Fila pausada | `muted` | `--muted-foreground` | `circle-pause` |
| Concluída, Livre | `done` | `--muted-foreground` | `circle-check` |

O olho do símbolo segue a mesma lógica: apagado quando o agente está parado, aceso em Água e pulsando devagar quando está trabalhando.

## 8. Movimento

| Token | Valor | Uso |
|---|---|---|
| `--dur-fast` | 150ms | Cor, borda, hover, tooltip, menu |
| `--dur` | 200ms | Diálogos, switch, avisos |
| `--dur-panel` | 260ms | Sheet e painéis laterais |
| `--dur-exit` | 170ms | Saídas (cerca de 65% da entrada) |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entradas |
| `--ease-in` | `cubic-bezier(0.55, 0, 1, 0.45)` | Saídas |

- Movimento só para mostrar estado, hierarquia ou causa: progresso, olho de status, cursor do agente, painel entrando.
- A barra de progresso anima em 400 ms.
- Com `prefers-reduced-motion`, todas as animações e transições caem para 1 ms e o cursor do agente pula direto ao destino.

## 9. Ícones

- Uma única família, Lucide, a mesma do shadcn: contorno de 2 px, pontas e junções arredondadas, nunca preenchidos.
- Sprite Lucide dos protótipos em `docs/design/assets/icons.svg`, usado com `<svg class="od-icon" aria-hidden="true"><use href="assets/icons.svg#i-nome"></use></svg>`.
- Tamanho controlado por `--od-icon-size`: 16 px em botões, 12 px em selos, 13 px em status.
- Ícones decorativos levam `aria-hidden="true"`. Botões só com ícone levam `aria-label` e tooltip.
- Nada de emoji no lugar de ícone, e nada de ícone ao lado de todo título.

O prefixo `od-` identifica apenas as primitivas de layout dos protótipos (`.od-truncate`, `.od-icon`, `--od-gap`, `--od-icon-size`). Não é uma segunda escala de tokens: elas usam os tokens semânticos acima, adaptados aos `--boto-*` do app pelo CSS local.

## 10. Logo

| Arquivo | Uso |
|---|---|
| `apps/desktop/public/assets/boto-logo.svg` | Principal, fundo escuro (Boto-rosa e Névoa) |
| `apps/desktop/public/assets/boto-logo-claro.svg` | Fundo claro (Boto-rosa fundo e Rio Negro) |
| `apps/desktop/public/assets/boto-simbolo.svg` | Avatar, ícone de app, espaços pequenos |
| `apps/desktop/public/assets/favicon.svg` | Favicon, placa Rio Negro com raio 14/64 |

- O símbolo é a cabeça do boto formando um balão de relato: o focinho é a ponta do balão e o olho é o indicador de status.
- O nome "boto" é desenhado em minúsculas, com o "o" final na cor do símbolo.
- Respiro ao redor igual à altura do "o". Mínimo de 20 px de altura para o símbolo e 72 px de largura para o logo completo.
- Não aplique degradê, sombra, brilho ou contorno. Não gire, distorça nem redesenhe o boto. Não escreva o nome com maiúscula dentro do logo.

## 11. Imagens

- A interface do produto é a imagem principal: linha do tempo, área de trabalho, PRs, planilhas e e-mails simulados com conteúdo plausível.
- Logos de apps e provedores são os arquivos oficiais, nunca redesenhados. Fontes e licenças em `assets/brands/credits.json`, não na interface.
- Evite: fotos de banco de pessoas no notebook, robôs, cérebros brilhantes, circuitos neon, degradê roxo, pessoas desenhadas à mão e caricaturas do boto (chapéu, folclore literal).

## 12. Voz e tom

O Boto relata como um bom colega. Trata o leitor por "você" e diz o que fez, o que vai fazer e o que precisa de você, nessa ordem.

- **Primeiro o resultado.** Começa pelo que mudou; as etapas ficam abaixo.
- **Pergunta antes de enviar.** Diz exatamente o que vai fazer fora do computador dele e espera o sim.
- **Honesto sobre limites.** Diz quando travou ou falhou. Não inventa números nem esconde erro.

| Diga | Evite |
|---|---|
| Abri o PR com a correção do teste. Falta a sua aprovação para fazer o merge. | Pronto!!! Resolvi TUDO de forma revolucionária, pode confiar! |
| Vou enviar o resumo para as 4 pessoas do time comercial. Posso enviar? | Parecia urgente, então já mandei para a lista inteira da empresa. |
| Não consegui entrar no painel de vendas porque a senha expirou. Pausei a tarefa até você atualizar o acesso. | Ops! Algo deu muito errado :( |

Regras de texto:

- Português do Brasil, frases curtas, títulos em caixa de sentença.
- Sem pontos de exclamação, sem emoji, sem hype ("revolucionário", "mágico", "10x").
- Sem métricas inventadas. Limites e números desconhecidos aparecem como "a definir".
- Rótulos de ação com verbo: Aprovar, Pausar, Assumir o controle, Devolver ao Boto, Permitir nesta sessão.

## 13. Acessibilidade

- Link "Pular para o conteúdo" (`.skip-link`) em toda página.
- Foco visível em todos os controles: contorno de 2 px em `--ring` com afastamento de 2 px.
- Alvos de toque de 44 px em telas de toque.
- Switches, abas e menus com os papéis e atributos ARIA corretos (`role="switch"`, `aria-checked`, `aria-selected`, `aria-controls`).
- Barras de progresso com `role="progressbar"` e `aria-valuetext` legível ("3 de 5 etapas").
- Ações do agente na área de trabalho anunciadas para leitores de tela.
- Tudo funciona pelo teclado, incluindo a alça da barra lateral (setas e Enter), a divisória da tarefa e as janelas da área de trabalho (Tab e Esc).

## 14. Não fazer

- Fundos bege, creme ou pêssego; degradê roxo; degradê em toda camada.
- Rosa como fundo de área grande ou mais de um botão primário por área.
- Card arredondado com borda colorida à esquerda como destaque.
- Hover que deixa o texto mais claro ou cinza.
- Estado comunicado só por cor.
- Valores de cor, tamanho, espaço ou duração soltos no CSS: use os tokens.
- Emoji como ícone, ilustração de pessoas desenhadas à mão, números de desempenho inventados.
