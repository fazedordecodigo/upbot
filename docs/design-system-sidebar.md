# Barra lateral, Início e Agentes

A navegação principal segue o Rio Negro (`DESIGN.md`). A largura padrão é `--boto-size-sidebar` (272 px). O DESIGN.md prevê ajuste de 220 a 400 px, com largura salva no navegador; o app ainda não implementa o redimensionamento. Até 1023 px a barra vira um Sheet com o nome acessível "Barra lateral", aberto por "Abrir barra lateral".

## Barra lateral

`Sidebar.tsx` mostra, nesta ordem:

1. Marca Boto, que volta ao Início.
2. Nova tarefa, Início, Agentes, Rotinas, Modelos, Marketplace e Buscar.
3. Tarefas agrupadas em Em execução, Aguardando você, Pausadas, Com erro e Concluídas, com ícone, tom e texto. Cada linha é o título da tarefa, o nome do agente e a hora; falhas também mostram o erro. Concluídas mostra as oito entregas mais recentes. Não há lista "SEUS AGENTES" nem ponto de status só com cor.
4. Conversas em grupo, quando existem.
5. Rodapé com as iniciais, o nome da pessoa e Configurações.

Agentes mostra a contagem de quem está trabalhando ou aguardando você. Rotinas mostra quantas rotinas existem. Os dois contadores usam selos neutros e texto com contexto para leitores de tela; o rosa fica reservado a Aguardando você. Modelos abre uma tela própria: o catálogo de modelos de tarefa ainda não está disponível, e a tela informa essa limitação e oferece Tarefa em branco. Não há seletor de tema nem botão "Novo bot" nesta barra. O tema fica em Configurações → Geral (Claro, Escuro, Automático). O tema padrão, sem preferência salva, é o escuro.

Nova tarefa abre o agente selecionado. Sem agente selecionado, abre o diálogo Novo agente. Uma sessão nova continua no atalho correspondente; o marcador "Nova sessão" aparece na linha do tempo, não como botão da barra.

## Início

`HomeView.tsx` cumprimenta a pessoa e usa o título "O trabalho do Boto hoje", com o botão Nova tarefa. As faixas são Em andamento, Aguardando você e Entregas recentes. Cada item leva `SituationStatus`: ícone e texto no tom `run`, `wait`, `muted` ou `done`.

O cartão "Áreas de trabalho dos agentes" fica no fim. As miniaturas são ilustração no Rio Negro com o estado real do agente. Sem agentes, o texto é "Nenhum agente ainda."

## Agentes

`AgentsView.tsx` é o cockpit. O resumo conta agentes em atividade, instâncias em uso, tarefas na fila e pedidos esperando você. O filtro usa Todos, Trabalhando, Aguardando você, Livres e Pausados. Cada card mostra o papel, o status com ícone e texto em pílula ao lado das instâncias (0/1) com barra de progresso no tom da situação, as áreas de trabalho ao vivo (miniatura, nome em mono, tarefa e estado como "Pede permissão"), a fila com a próxima tarefa, e as ações Abrir painel e Pausar fila ou Retomar fila.

"Novo agente" abre `CreateAgentDialog`: nome, o que ele faz, provedor e pedir aprovação. A ação principal é "Criar agente".

O painel do agente (`AgentPanel`) é um sheet com instâncias, computadores, o que está em andamento, a fila e as entregas recentes. A tela da tarefa usa o cabeçalho `.task-head` (Pausar ou Retomar, Assumir o controle, Encerrar), não o antigo `.main-head` do chat.
