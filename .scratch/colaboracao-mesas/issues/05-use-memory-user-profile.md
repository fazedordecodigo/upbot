# 05 — `use_memory` off: sessões da mesa sem `<user_profile>`

**What to build:** o hook de prefixo de sessão do `RuntimeManager` passa a
receber o contexto do queue row (ou `collaboration_id`); quando a sessão
pertence a um membro de mesa criada com `use_memory` desligado, o bloco
`<user_profile>` é suprimido do prefixo — o perfil do usuário não vaza para
colaborações que não precisam dele. `<agent_memories>` de cada bot continua
sempre entrando. Default off: mesas existentes migradas passam a não injetar
`<user_profile>` (direção privacy-first deliberada no PRD). Sessões fora de
mesa não são afetadas.

**Blocked by:** 01 — Modo de trabalho da mesa: schema, protocolo e kickoff.

**Status:** ready-for-agent

- [x] Sessão de membro de mesa com `use_memory` off não contém
      `<user_profile>` no prefixo
- [x] Sessão de membro de mesa com `use_memory` on contém `<user_profile>`
- [x] `<agent_memories>` presente nos dois casos
- [x] Sessões de tasks/chats fora de mesa inalteradas
- [x] e2e asserindo presença/ausência de `<user_profile>` nas sessões dos
      membros conforme a flag

## Comments

- 2026-11-12 — `CollaborationService.sessionUsesMemory(turnId)` resolve o queue
  row → `collaboration_id` → `use_memory`; `MemoryStore.promptBlock` ganhou o
  parâmetro `includeProfile` e o hook de sessão em main.ts o alimenta. Sem mesa,
  sempre `true` — sessões fora de mesa não mudam.
