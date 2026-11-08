# Barra lateral, Início e Agentes

A navegação principal segue o Rio Negro (`DESIGN.md`). A largura é `--boto-size-sidebar` (272 px). Até 759 px a barra vira um painel com o nome acessível "Barra lateral", aberto por "Abrir barra lateral".

## Barra lateral

`Sidebar.tsx` mostra, nesta ordem:

1. Marca Boto, que volta ao Início.
2. Nova tarefa, Início, Agentes, Rotinas, Marketplace e Buscar.
3. Tarefas agrupadas em Em andamento, Aguardando você, Pausadas e Recentes. Cada linha é o título da tarefa, o nome do agente e a hora. Não há lista "SEUS AGENTES" nem ponto de status só com cor.
4. Conversas em grupo, quando existem.
5. Rodapé com as iniciais, o nome da pessoa e Configurações.

Agentes mostra a contagem de quem está trabalhando ou aguardando você. Rotinas mostra quantas rotinas existem. Não há item Modelos, seletor de tema nem botão "Novo bot" nesta barra. O tema fica em Configurações → Geral (Claro, Escuro, Automático). O tema padrão, sem preferência salva, é o escuro.

Nova tarefa abre o agente selecionado. Sem agente selecionado, abre o diálogo Novo agente. Uma sessão nova continua no atalho correspondente; o marcador "Nova sessão" aparece na linha do tempo, não como botão da barra.

## Início

`HomeView.tsx` cumprimenta a pessoa e usa o título "O trabalho do Boto hoje", com o botão Nova tarefa. As faixas são Em andamento, Aguardando você e Entregas recentes. Cada item leva `SituationStatus`: ícone e texto no tom `run`, `wait`, `muted` ou `done`.

O cartão "Áreas de trabalho dos agentes" fica no fim. As miniaturas são ilustração no Rio Negro com o estado real do agente. Sem agentes, o texto é "Nenhum agente ainda."

## Agentes

`AgentsView.tsx` é o cockpit. O título é "Agentes". O resumo conta Trabalhando, Aguardando você, Livres e Fila pausada. O filtro usa esses mesmos cortes, mais Todos. Cada card mostra o papel, o status com ícone e texto, a miniatura, instâncias (0/1), fila e máquina, e as ações Abrir painel, Pausar fila ou Retomar fila, e Ver área.

"Novo agente" abre `CreateAgentDialog`: nome, o que ele faz, provedor e pedir aprovação. A ação principal é "Criar agente".

O painel do agente (`AgentPanel`) é um sheet com instâncias, computadores, o que está em andamento, a fila e as entregas recentes. A tela da tarefa usa o cabeçalho `.task-head` (Pausar ou Retomar, Assumir o controle, Encerrar), não o antigo `.main-head` do chat.
