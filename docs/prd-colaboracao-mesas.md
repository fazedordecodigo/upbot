# PRD — Colaboração: várias mesas simultâneas, detalhe e criação assistida

Status: draft local (aguardando destino de publicação). Decisões fechadas em sessão de
grilling com o usuário em 2026-11-12; telas de referência: três mockups anexos
(lista de mesas, "Nova mesa", detalhe "Erro no checkout").

## Problem Statement

Hoje a página Colaboração mostra **uma mesa por vez**, trocada por chips discretos:
não existe visão das várias colaborações acontecendo ao mesmo tempo, nem sinalização
de qual mesa precisa de você. A criação é um modal apertado que só pede problema,
título opcional, membros e líder — sem controle sobre *como* a mesa trabalha
(aprovação de ações externas, paradas entre etapas, uso da memória do usuário,
roteamento das mensagens). E as pendências da mesa (perguntas dos bots, ações
externas aguardando permissão) não aparecem conectadas à conversa da mesa.

## Solution

A Colaboração vira três superfícies, fiéis aos mockups:

1. **Lista ("Mesas")** — grade de cards, um por mesa, com mini-grafo, badge de
   status, progresso de etapa, callout da pendência atual e filtros
   "Todas / Aguardando você / Em discussão / Resolvidas". Sidebar lista as mesas
   aninhadas sob "Colaboração".
2. **"Nova mesa"** — página inteira (não modal) em três seções: o problema (nome
   obrigatório + objetivo + exemplos a partir de mesas recentes), quem participa
   (Boto fixo como coordenador + grid de agentes com disponibilidade de
   instâncias em tempo real e sugestão conforme você digita) e como a mesa
   trabalha (jeito de conversar, aprovação de ações externas, quando parar para
   falar com você, uso de memória). Coluna de prévia ao vivo.
3. **Detalhe em abas** — barra de abas de mesas abertas na sessão; cabeçalho com
   modo de trabalho; card do problema com chips das 5 etapas; stats; grafo da
   conversa com avatares, espessura por volume e cor por tipo de aresta; rail
   "Conversa" à direita mesclando mensagens, perguntas (request) e cards de
   aprovação **reais** com "Aprovar" / "Agora não".

Os quatro controles novos da criação são **enforced pelo daemon**, não cosméticos.

## User Stories

1. Como usuário, quero ver todas as minhas mesas simultâneas numa grade, para
   acompanhar várias colaborações acontecendo ao mesmo tempo.
2. Como usuário, quero ver de relance qual mesa está aguardando uma ação minha,
   para priorizar onde destravar o trabalho.
3. Como usuário, quero filtrar as mesas por "aguardando você", "em discussão" e
   "resolvidas", para focar no que interessa.
4. Como usuário, quero abrir várias mesas em abas e alternar entre elas, para
   comparar discussões sem perder o contexto.
5. Como usuário, quero ir da sidebar direto para uma mesa específica, para chegar
   à conversa em um clique.
6. Como usuário, quero criar uma mesa numa página inteira com prévia ao vivo,
   para entender exatamente o que estou montando antes de abrir.
7. Como usuário, quero reutilizar uma mesa recente como ponto de partida, para
   repetir colaborações recorrentes sem redigitar o problema.
8. Como usuário, quero que o Boto sugira agentes conforme descrevo o problema,
   para escolher os participantes certos mais rápido.
9. Como usuário, quero ver quantas instâncias de cada agente estão livres agora,
   para saber quem entra na mesa já e quem entra quando liberar.
10. Como usuário, quero que o meu bot padrão coordene a mesa sempre, para ter um
    ponto de contato consistente.
11. Como usuário, quero escolher se os agentes conversam direto entre si ou se
    tudo passa pelo Boto, para equilibrar velocidade e controle.
12. Como usuário, quero exigir aprovação antes de ações externas naquela mesa,
    para que nenhum agente envie e-mail, publique ou estorne sem meu aval —
    mesmo agentes que normalmente não pedem permissão.
13. Como usuário, quero que a mesa me mostre o que cada etapa resolveu e espere
    eu liberar a próxima, para manter governança sobre o rumo da discussão.
14. Como usuário, quero decidir se a mesa pode usar a minha memória, para não
    expor meu perfil a colaborações que não precisam dele.
15. Como usuário, quero aprovar ou negar uma ação externa direto no feed da mesa,
    para resolver pendências sem sair da conversa.
16. Como usuário, quero responder perguntas dos bots no feed da mesa, para
    destravar a discussão com resposta livre quando não for aprovação.

## Implementation Decisions

### Modelo de dados e protocolo

- Nova migration na tabela `collaborations`: `topology` (`mesh` | `hub`),
  `ask_external`, `checkpoint_phases`, `use_memory`, `phase_pending` (nullable —
  fase requisitada aguardando liberação do usuário). Defaults das novas colunas
  reproduzem o comportamento atual: `mesh`, off, off, off, null.
- `Collaboration` e `CollaborationsCreateParams` ganham os quatro campos
  (opcionais no protocolo). `title` continua **opcional no protocolo** (bridge
  `start_collaboration` depende disso) e passa a ser **obrigatório na UI**.
- `Approval` ganha `collaborationId: string | null`, resolvido no daemon via
  `turnId → queue.collaboration_id`. Nenhum RPC novo: `approvals.list` +
  `approvals.respond` bastam; a UI faz o join.
- Bridge `start_collaboration` cria mesas com defaults neutros
  (`mesh`/off/off/off): mesas abertas por bots não ganham gates que ninguém
  escolheu. Flags de aprovação de cada agente continuam valendo.

### Daemon (`CollaborationService` e adjacentes)

- **Topologia `hub` ("Tudo passa pelo Boto")**: em `tableMessage`, remetente
  não-líder tem o `to` clampado para o líder; a resposta da tool informa que na
  mesa tudo passa pelo líder. Só isso — `send_message`, `share_file` e
  `delegate` entre membros fora da mesa não são afetados (regra de conversa,
  não isolamento).
- **`ask_external`**: nova `AskPolicy` registrada no `ApprovalService` — se o
  turn tem `queue.collaboration_id` de mesa com a flag ligada, exige aprovação
  com o mesmo predicado do `agentApprovalPolicy` (app tools não-read +
  `page_publish`). Policies só adicionam asks: agentes com `require_approval`
  próprio continuam pedindo mesmo com a flag desligada.
- **`checkpoint_phases`**: `table_phase` do líder não avança a fase na hora —
  grava um `request` para o usuário (com o resumo passado pelo líder) e seta
  `phase_pending`. `collaborations.answer` aplica a fase pendente ao responder.
  `table_phase` com pendência ativa → erro "aguardando o usuário liberar a
  etapa". A conversa da mesa **não** congela — só a transição de fase espera.
- **`use_memory`**: o hook de prefixo de sessão do `RuntimeManager` passa a
  receber contexto do queue row (ou `collaboration_id`); quando a mesa tem a
  flag desligada, suprime o bloco `<user_profile>` das sessões dos membros.
  `<agent_memories>` de cada bot continua sempre entrando. Default off.
- `framePrompt`/kickoff do líder descreve o modo de trabalho escolhido para que
  o líder conheça as regras (transparência para o coordenador).

### Derivações de produto

- **"Aguardando você"** = approval pendente **ou** `request` sem resposta naquela
  mesa (vale para badge do card, filtro e status do detalhe).
- **Filtros**: Aguardando = active|paused com pendência; Em discussão =
  active|paused sem pendência; Resolvidas = done; stopped só em "Todas", com
  badge "Encerrada".
- **Etapas**: enum fixo de 5 (entender→investigar→corrigir→verificar→avisar);
  "Etapa N de 5" deriva do índice. Os nomes divergentes dos mockups
  ("Resolver", "Aprovar") são tratados como soltura do mockup.
- **Coordenador**: `leaderId` = `settings.default_bot_id`, sempre; o card mostra
  o nome real do bot. Mínimo: 2 agentes escolhidos (mesa de 3 no total). Sem
  default bot, a página orienta criar um bot primeiro. `MIN_MEMBERS=2` no
  serviço permanece (criações via bridge continuam podendo ter 2).
- **Sugestão de agentes**: scoring no cliente — problema tokenizado (sem
  diacríticos/stopwords) contra nome + role + descrição do agente; acima do
  limiar o card ganha chip "sugerido" e há ação "selecionar sugeridos". Nunca
  marca/desmarca sozinho.
- **Chips "Começar de um exemplo"**: as 3 mesas mais recentes do usuário; clicar
  preenche nome e problema. Sem mesas → a linha some.
- **Instâncias**: `agents.overview` (já existe RPC + evento) dá
  `instances.capacity - instances.active` por agente; agente lotado pode ser
  selecionado — entra na mesa quando uma instância liberar ("Entra na mesa
  quando uma liberar").
- **Abas do detalhe**: conjunto aberto na sessão (estado em memória na view);
  "Mesas" volta ao grid sem fechar abas; "+" abre a criação.
  `navigate("collaboration", { id })` faz deep-link de uma mesa — usado pelos
  itens aninhados da sidebar.
- **Card de aprovação no feed**: approvals pendentes da mesa renderizam com
  "Aprovar" → `approve` e "Agora não" → `deny` via `approvals.respond`.
  Requests seguem com resposta livre. Timeline do feed mescla
  `collaborations.history` + `approvals.list` filtrado por `collaborationId`,
  ordenada por `createdAt`. "Ver o pedido" no card da lista abre o detalhe
  ancorado na pendência.
- **Mini-grafo dos cards**: estrutural (spokes líder↔membros + aresta para
  "Você" destacada quando há pendência) — sem pesos, pois a lista não carrega
  mensagens por mesa. O grafo grande do detalhe mantém arestas reais ponderadas
  por contagem e coloridas por tipo (agente↔agente vs pedido para você), com
  avatares reais e legenda.
- **Sidebar**: mesas não-encerradas aninhadas sob "Colaboração", badge = total
  delas (mesmo padrão do `routines.list` já usado na sidebar); "ver todas as
  mesas" navega ao grid.

### Estrutura de UI

- Criação sai do `Dialog` (`NewTableDialog`) e vira **view própria** registrada
  em `ViewName`/views (mesmo padrão da "Nova tarefa"), com três seções
  numeradas e prévia sticky.
- Detalhe mantém o `TablePanel` retrabalhado: barra de abas, meta do modo de
  trabalho no cabeçalho ("Boto e N agentes · Conversam direto entre si · Pede
  aprovação · Aberta às HH:MM"), stats com rótulo "ações em andamento", rail
  direito "Conversa" e composer de instrução preservado.
- Design system Rio Negro: estilos via tokens `--boto-*`/`tokens.json`
  (bun scripts/build-tokens.ts) e componentes `ui/*` existentes; ícones em
  `ui/icons.tsx`.

## Testing Decisions

Bons testes aqui verificam **comportamento externo** — linhas do transcript
persistido, payloads emitidos, resultados de derivação — nunca internals do
service ou do React.

- **Seam 1 — daemon e2e (principal)**: estender
  `test/collaborations.e2e.test.ts`, que já sobe o daemon real com `FAKE_AGENT`
  e assertra no transcript via `collaborations.history`. Cobre: clamp de
  `table_message` em mesa `hub`; ask policy por mesa gerando approval ligado a
  `collaborationId`; gate de `table_phase` (request + `phase_pending` +
  aplicação no `answer` + erro ao re-tentar); presença/ausência de
  `<user_profile>` nas sessões dos membros conforme `use_memory`; defaults
  neutros no `start_collaboration`. Prior art: o próprio arquivo,
  `approvals.e2e.test.ts`, `approvals-restart.e2e.test.ts` (persistência do
  `phase_pending` através de restart) e `default-bot.e2e.test.ts`.
- **Seam 2 — lógica pura do desktop**: extrair para `src/lib/` a derivação de
  filtros/"aguardando você", o scoring de sugestão e o merge da timeline
  (mensagens + approvals), testadas com client stub. Prior art:
  `approval-decisions.test.ts`, `new-task-lib.test.ts`, `routines-format.test.ts`.
- Uma única seam nova não é necessária: as duas existentes cobrem daemon e
  derivações de UI; a fidelidade visual aos mockups é verificação manual.

## Out of Scope

- Planos de etapa dinâmicos por mesa (o enum fixo de 5 permanece).
- Isolamento de side-channels entre membros em mesa `hub` (`send_message`,
  `share_file`, `delegate` fora da mesa não são bloqueados).
- Supressão das `<agent_memories>` de cada bot — o toggle cobre só
  `<user_profile>` (e memórias já não podem ser *gravadas* em tasks privadas).
- Persistir o conjunto de abas entre sessões/reloads.
- Mudanças em mobile/relay/gateways consumindo `collaborations.*`.
- Fidelidade de mockup como requisito de pixel — o desenho segue estrutura,
  hierarquia e textos das imagens dentro do design system Rio Negro.

## Further Notes

- Mesas existentes migradas passam a ter os defaults neutros das novas colunas;
  a única mudança retroativa é `use_memory` off deixando de injetar
  `<user_profile>` em mesas antigas — direção privacy-first desejada.
- `MIN_MEMBERS`/`MAX_MEMBERS`, cap de mensagens, `retireMembers`, `recover` e o
  fluxo de conclusão (`conclude` devolvendo resumo à task/chat de origem) não
  mudam.
- A badge "3" da sidebar no mockup é o total de mesas não-encerradas; o
  "Aguardando você" por mesa vive nos cards, não na sidebar.
- Traduções do mockup: "Aprovar envio" vira "Aprovar" (botão estático), já que o
  verbo não é derivável com segurança do título do approval.
