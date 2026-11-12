# 07 — "Nova mesa" como página inteira com prévia ao vivo

**What to build:** a criação sai do `Dialog` (`NewTableDialog`) e vira uma
view própria registrada em `ViewName`/views (padrão "Nova tarefa"), em três
seções numeradas com coluna de prévia sticky. Seção 1 — o problema: nome
obrigatório (título vira required na UI, continua opcional no protocolo),
objetivo/problema, e chips "Começar de um exemplo" com as 3 mesas mais
recentes que preenchem nome e problema ao clicar (sem mesas → a linha some).
Seção 2 — quem participa: Boto fixo como coordenador (`leaderId` =
`settings.default_bot_id`, card mostra o nome real) + grid de agentes com
disponibilidade de instâncias em tempo real via `agents.overview`
(`capacity - active`; lotado pode ser selecionado — "entra na mesa quando
uma liberar") e sugestão conforme o usuário digita: scoring client-side do
problema tokenizado (sem diacríticos/stopwords) contra nome+role+descrição;
acima do limiar, chip "sugerido" e ação "selecionar sugeridos" — nunca
marca/desmarca sozinho. Mínimo de 2 agentes escolhidos além do coordenador;
sem default bot, a página orienta criar um bot primeiro. Seção 3 — como a
mesa trabalha: os quatro controles (jeito de conversar mesh/hub, aprovação
de ações externas, quando parar para falar com você, uso de memória) enviados
no create (ticket 01). O scoring é extraído para `src/lib/` e testado.

**Blocked by:** 01 — Modo de trabalho da mesa: schema, protocolo e kickoff.

**Status:** ready-for-agent

- [ ] Criação é uma view inteira com três seções e prévia sticky refletindo
      as escolhas
- [ ] Nome obrigatório; chips de exemplos preenchem nome+problema e somem
      sem mesas recentes
- [ ] Coordenador é sempre o `default_bot_id` (nome real no card); sem
      default bot, orientação para criar um bot
- [ ] Grid de agentes mostra instâncias livres em tempo real; lotado
      selecionável com aviso "entra quando liberar"
- [ ] Scoring marca chip "sugerido" e "selecionar sugeridos" funciona; nada
      é marcado/desmarcado automaticamente
- [ ] Os 4 controles do modo de trabalho são enviados no
      `collaborations.create`
- [ ] Scoring em `src/lib/` com testes (tokenização sem diacríticos,
      stopwords, limiar)
- [ ] Design system Rio Negro: tokens `--boto-*`, componentes `ui/*`
