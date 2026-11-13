# 08 — Detalhe em abas: cabeçalho, etapas e grafo da conversa

**What to build:** o detalhe da mesa vira um conjunto de abas na sessão. Uma
barra de abas lista as mesas abertas — "Mesas" volta ao grid sem fechar
abas, "+" abre a criação; `navigate("collaboration", { id })` é o deep-link
de uma mesa (os itens aninhados da sidebar do ticket 06 abrem/focam a aba).
O conjunto de abas vive em memória na view — não persiste entre reloads. O
detalhe mantém o `TablePanel` retrabalhado: cabeçalho com a meta do modo de
trabalho ("Boto e N agentes · Conversam direto entre si · Pede aprovação ·
Aberta às HH:MM"), card do problema com chips das 5 etapas fixas
(entender→investigar→corrigir→verificar→avisar; "Etapa N de 5" deriva do
índice) e stats com rótulo "ações em andamento". O grafo grande da conversa
mantém arestas reais ponderadas por contagem e passa a colorir por tipo
(agente↔agente vs pedido para você), com avatares reais e legenda.

**Blocked by:** 06 — Lista "Mesas": grade de cards, filtros e sidebar
aninhada.

**Status:** ready-for-human

- [x] Barra de abas de mesas abertas; abrir mesa cria/foca aba; "Mesas"
      volta ao grid preservando abas; "+" abre criação
- [x] `navigate("collaboration", { id })` abre/foca a aba da mesa — usado
      pelos itens da sidebar
- [x] Cabeçalho mostra a meta do modo de trabalho da mesa
- [x] Card do problema com chips das 5 etapas e "Etapa N de 5" pelo índice
- [x] Stats com rótulo "ações em andamento"
- [x] Grafo com arestas ponderadas por volume, coloridas por tipo, avatares
      reais e legenda
- [x] Abas não persistem entre reloads (decisão do PRD)
- [x] Design system Rio Negro: tokens `--boto-*`, componentes `ui/*`

## Comments

- 2026-11-12 — `.cb-tabs` em `CollaborationView` (useState, não persiste);
  fechar a aba atual foca a última restante ou volta ao grid. Header ganha
  `.cb-mode` com líder+topologia+aprovação+etapas+memória+hora de abertura.
  `ConversationGraph`: arestas com strokeWidth ∝ count, classes
  `cb-edge-bots|you|request` (pedido = tom de espera), círculos com cor do
  avatar/emoji real, legenda com 4 itens.
