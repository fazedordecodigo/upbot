# 06 — Lista "Mesas": grade de cards, filtros e sidebar aninhada

**What to build:** a superfície Colaboração passa a mostrar todas as mesas ao
mesmo tempo. Grade de cards, um por mesa, cada um com mini-grafo estrutural
(spokes líder↔membros, aresta para "Você" destacada quando há pendência — sem
pesos, a lista não carrega mensagens), badge de status, progresso "Etapa N de
5" e callout da pendência atual. Filtros "Todas / Aguardando você / Em
discussão / Resolvidas": Aguardando = active|paused com pendência; Em
discussão = active|paused sem pendência; Resolvidas = done; stopped só em
"Todas", com badge "Encerrada". "Aguardando você" = approval pendente naquela
mesa (join de `approvals.list` por `collaborationId`, ticket 01) **ou**
`request` sem resposta no history. Na sidebar, mesas não-encerradas ficam
aninhadas sob "Colaboração" com badge = total delas (padrão `routines.list`)
e "ver todas as mesas" navega ao grid. As derivações (filtros, pendência,
"aguardando você") são extraídas para `src/lib/` e testadas com client stub.

**Blocked by:** 01 — Modo de trabalho da mesa: schema, protocolo e kickoff.

**Status:** ready-for-agent

- [ ] Grade mostra um card por mesa com mini-grafo, badge de status, etapa
      e callout da pendência
- [ ] Aresta para "Você" destacada no mini-grafo quando a mesa tem pendência
- [ ] Quatro filtros aplicam a derivação correta, incluindo stopped só em
      "Todas" com badge "Encerrada"
- [ ] "Aguardando você" acende por approval pendente OU request sem resposta
- [ ] Sidebar aninha mesas não-encerradas sob "Colaboração" com badge de
      total; "ver todas as mesas" abre o grid
- [ ] Derivação de filtros/pendência em `src/lib/` com testes de client stub
      (prior art: `approval-decisions.test.ts`)
- [ ] Design system Rio Negro: tokens `--boto-*`, componentes `ui/*`, ícones
      de `ui/icons.tsx`
