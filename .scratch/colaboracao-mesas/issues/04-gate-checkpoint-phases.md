# 04 — Gate `checkpoint_phases`: etapa só avança com liberação do usuário

**What to build:** numa mesa criada com `checkpoint_phases` ligado, quando o
líder chama `table_phase` a fase não avança na hora — o daemon grava um
`request` na conversa da mesa (com o resumo passado pelo líder) e seta
`phase_pending`. Quando o usuário responde via `collaborations.answer`, a
fase pendente é aplicada. Uma nova chamada de `table_phase` enquanto há
pendência ativa retorna erro ("aguardando o usuário liberar a etapa"). A
conversa da mesa não congela — só a transição de fase espera. A pendência
sobrevive a restart do daemon (é coluna persistida).

**Blocked by:** 01 — Modo de trabalho da mesa: schema, protocolo e kickoff.

**Status:** ready-for-agent

- [ ] `table_phase` em mesa flagada grava `request` com resumo do líder e
      seta `phase_pending`; `phase` não muda ainda
- [ ] `collaborations.answer` aplica a fase pendente ao responder
- [ ] `table_phase` com pendência ativa → erro informando a espera
- [ ] Membros continuam conversando com pendência ativa (só a transição
      espera)
- [ ] `phase_pending` persiste através de restart do daemon
- [ ] Mesa sem a flag avança fase na hora, como hoje
- [ ] e2e cobrindo request + phase_pending + aplicação no answer + erro ao
      re-tentar + persistência em restart (prior art:
      `approvals-restart.e2e.test.ts`)
