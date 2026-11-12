# 01 — Modo de trabalho da mesa: schema, protocolo e kickoff

**What to build:** a mesa passa a ter um "modo de trabalho" persistido e declarado.
Uma migration adiciona `topology` (`mesh`|`hub`), `ask_external`,
`checkpoint_phases`, `use_memory` e `phase_pending` (nullable) à tabela
`collaborations`, com defaults neutros que reproduzem o comportamento atual
(`mesh`/off/off/off/null) — mesas existentes migradas mantêm o comportamento
de hoje, exceto `use_memory` off (privacy-first, decisão do PRD).
`Collaboration` e `CollaborationsCreateParams` expõem os quatro campos
(opcionais no protocolo; `title` continua opcional no protocolo para não
quebrar `start_collaboration` do bridge). `Approval` ganha
`collaborationId: string | null`, resolvido no daemon via
`turnId → queue.collaboration_id` — nenhum RPC novo. O bridge
`start_collaboration` cria mesas com defaults neutros. O `framePrompt`/kickoff
do líder descreve o modo de trabalho escolhido para que o coordenador conheça
as regras da mesa.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Migration adiciona as 5 colunas com defaults neutros; daemon sobe sobre
      banco antigo e novo
- [ ] `collaborations.create` aceita os 4 campos e `collaborations.get`/`list`
      os devolvem; omitidos → defaults neutros
- [ ] `approvals.list` devolve `collaborationId` preenchido quando a aprovação
      nasce de um turn de mesa, `null` fora de mesa
- [ ] `start_collaboration` do bridge cria mesa com defaults neutros (sem
      gates que ninguém escolheu)
- [ ] Kickoff do líder menciona o modo de trabalho escolhido (topologia,
      aprovação externa, checkpoints, memória)
- [ ] e2e estendendo `test/collaborations.e2e.test.ts`: round-trip dos campos
      e `collaborationId` na aprovação
