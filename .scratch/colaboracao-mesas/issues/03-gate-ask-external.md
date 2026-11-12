# 03 — Gate `ask_external`: aprovação exigida pela mesa

**What to build:** numa mesa criada com `ask_external` ligado, qualquer ação
externa de qualquer membro (app tools não-read + `page_publish`, mesmo
predicado do `agentApprovalPolicy`) passa a exigir aprovação do usuário —
mesmo de agentes que normalmente não pedem permissão. Implementada como uma
nova `AskPolicy` registrada no `ApprovalService`: se o turn tem
`queue.collaboration_id` de mesa com a flag ligada, o ask é gerado e a
aprovação carrega o `collaborationId` (ticket 01). Policies só adicionam
asks: agentes com `require_approval` próprio continuam pedindo mesmo com a
flag desligada, e mesa sem a flag não ganha ask novo.

**Blocked by:** 01 — Modo de trabalho da mesa: schema, protocolo e kickoff.

**Status:** ready-for-agent

- [ ] Turn de membro em mesa com `ask_external` gera approval para app tool
      não-read e para `page_publish`
- [ ] A approval gerada tem `collaborationId` da mesa
- [ ] Mesa sem a flag não gera asks novos (só os do `require_approval` do
      agente, se houver)
- [ ] Agente com `require_approval` próprio continua pedindo aprovação em
      mesa sem a flag
- [ ] e2e cobrindo ask gerado por mesa e ausência de ask sem flag
