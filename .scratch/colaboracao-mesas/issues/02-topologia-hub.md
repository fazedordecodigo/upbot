# 02 — Topologia `hub`: mensagens da mesa passam pelo líder

**What to build:** numa mesa criada com `topology: "hub"` ("tudo passa pelo
Boto"), quando um membro não-líder envia `table_message` endereçada a outro
membro, o destino é clampado para o líder — a conversa da mesa vira
estrela. A resposta da tool informa ao remetente que naquela mesa tudo passa
pelo líder, para que ele não repita o erro. Mensagens do líder a membros
seguem diretas. É regra de conversa da mesa, não isolamento:
`send_message`, `share_file` e `delegate` entre membros fora da mesa não são
afetados.

**Blocked by:** 01 — Modo de trabalho da mesa: schema, protocolo e kickoff.

**Status:** ready-for-agent

- [ ] `table_message` de não-líder em mesa `hub` entrega ao líder
      independentemente do `to` pedido (transcript registra a linha entregue
      ao líder)
- [ ] Resposta da tool informa o clamp ("nesta mesa tudo passa pelo líder")
- [ ] Mesa `mesh` (default) não clampa nada
- [ ] `table_message` do líder a membro entrega direto
- [ ] `send_message`/`share_file`/`delegate` fora da mesa inalterados
- [ ] e2e em `test/collaborations.e2e.test.ts` asserindo o transcript
      persistido
