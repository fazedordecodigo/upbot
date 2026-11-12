# 09 — Rail "Conversa": feed mesclado com pendências acionáveis

**What to build:** o rail direito do detalhe ("Conversa") vira uma timeline
única mesclando `collaborations.history` + `approvals.list` filtrado por
`collaborationId` (ticket 01), ordenada por `createdAt`. As pendências da
mesa aparecem conectadas à conversa: approvals pendentes renderizam como
cards reais com "Aprovar" → `approve` e "Agora não" → `deny` via
`approvals.respond`; requests seguem com resposta livre que destrava a
discussão; o composer de instrução é preservado. "Ver o pedido" no card da
lista de mesas abre o detalhe ancorado na pendência correspondente. O merge
da timeline (mensagens + approvals) é extraído para `src/lib/` e testado
com client stub.

**Blocked by:** 08 — Detalhe em abas: cabeçalho, etapas e grafo da conversa.

**Status:** ready-for-agent

- [ ] Rail mescla mensagens, requests e approvals da mesa ordenados por
      `createdAt`
- [ ] Approval pendente renderiza "Aprovar"/"Agora não" que chamam
      `approvals.respond` e o card sai da pendência ao resolver
- [ ] Request pendente aceita resposta livre que destrava a mesa
- [ ] Composer de instrução preservado
- [ ] "Ver o pedido" no card da lista ancora o detalhe na pendência
- [ ] Merge da timeline em `src/lib/` com testes de client stub
- [ ] Design system Rio Negro: tokens `--boto-*`, componentes `ui/*`
