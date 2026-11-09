export const migrations: string[] = [
  // 1: agents table
  `CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL,
    model TEXT,
    workspace_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  // 2: chat turns, items, provider sessions
  `CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    status TEXT NOT NULL,
    stop_reason TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE TABLE items (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    turn_id TEXT REFERENCES turns(id),
    kind TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX items_agent_seq ON items(agent_id, seq);
  CREATE INDEX turns_agent ON turns(agent_id, started_at);
  CREATE TABLE agent_sessions (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id),
    provider TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // 3: agent config + message queue
  `ALTER TABLE agents ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
  UPDATE agents SET config_json = json_object('model', model) WHERE model IS NOT NULL;
  ALTER TABLE agents ADD COLUMN queue_paused INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE queue (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    text TEXT NOT NULL,
    status TEXT NOT NULL,
    turn_id TEXT REFERENCES turns(id),
    created_at INTEGER NOT NULL,
    started_at INTEGER
  );
  CREATE INDEX queue_agent_status ON queue(agent_id, status, created_at)`,
  // 4: link turns to the queue item that started them
  `ALTER TABLE turns ADD COLUMN queue_id TEXT`,
  // 5: agent-to-agent messages (sender + hop count for loop limits)
  `ALTER TABLE queue ADD COLUMN from_agent_id TEXT;
  ALTER TABLE queue ADD COLUMN hops INTEGER NOT NULL DEFAULT 0`,
  // 6: channels
  `CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_agent_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE channel_members (
    channel_id TEXT NOT NULL REFERENCES channels(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    PRIMARY KEY (channel_id, agent_id)
  );
  CREATE TABLE channel_messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id),
    seq INTEGER NOT NULL,
    author_kind TEXT NOT NULL,
    author_agent_id TEXT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX channel_messages_seq ON channel_messages(channel_id, seq);
  ALTER TABLE queue ADD COLUMN channel_id TEXT;
  ALTER TABLE queue ADD COLUMN prompt TEXT`,
  // 7: per-agent token usage + context
  `CREATE TABLE agent_usage (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id),
    used_tokens INTEGER,
    context_window INTEGER,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    compactions INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  // 8: avatars + per-agent memories
  `ALTER TABLE agents ADD COLUMN avatar_json TEXT;
  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX memories_agent ON memories(agent_id, created_at)`,
  // 9: routines + queue metadata (routine/attachments shown on the user message)
  `ALTER TABLE queue ADD COLUMN meta_json TEXT;
  CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule TEXT,
    webhook_token TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at INTEGER,
    next_run_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE TABLE routine_runs (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES routines(id),
    trigger TEXT NOT NULL,
    queue_id TEXT,
    error TEXT,
    created_at INTEGER NOT NULL
  )`,
  // 10: encrypted vault + key/value settings
  `CREATE TABLE vault (
    name TEXT PRIMARY KEY,
    iv TEXT NOT NULL,
    data TEXT NOT NULL,
    agent_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // 11: messaging gateways (tokens live in the vault)
  `CREATE TABLE gateways (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    allowed_users TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  // 12: paired mobile devices (token stored as sha256)
  `CREATE TABLE mobile_devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  )`,
  // 13: team relay messages (both directions)
  `CREATE TABLE team_messages (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    member_id TEXT NOT NULL,
    member_name TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    text TEXT NOT NULL,
    reply TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX team_messages_request ON team_messages(request_id, direction)`,
  // 14: remote hosts (SSH), per-agent placement/isolation, subagents
  `CREATE TABLE hosts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    target TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    identity_file TEXT,
    root TEXT,
    preflight_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE agent_placement (
    agent_id TEXT PRIMARY KEY,
    host_id TEXT,
    isolation TEXT NOT NULL DEFAULT 'none',
    vcpus INTEGER NOT NULL DEFAULT 2,
    mem_mib INTEGER NOT NULL DEFAULT 2048
  );
  CREATE TABLE subagents (
    agent_id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    task TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    keep INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX subagents_parent ON subagents(parent_id, status);
  CREATE INDEX subagents_batch ON subagents(batch_id)`,
  // 15: email accounts (password in the vault as email.<id>.password) and bot-drafted emails
  `CREATE TABLE email_accounts (
    id TEXT PRIMARY KEY,
    config_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE email_drafts (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    data_json TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX email_drafts_agent ON email_drafts(agent_id, status)`,
  // 16: connected apps (MCP servers; secrets in the vault as app.<id>.<KEY>)
  `CREATE TABLE connected_apps (
    id TEXT PRIMARY KEY,
    catalog_id TEXT NOT NULL,
    config_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )`,
  // 17: pages (bot-published HTML in <workspace>/Pages/<id>/index.html)
  `CREATE TABLE pages (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // 18: replies in group chats
  `ALTER TABLE channel_messages ADD COLUMN reply_to TEXT`,
  `ALTER TABLE connected_apps ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '{"read":"allow","write":"ask","send":"ask","pay":"ask","book":"ask","del":"ask"}'`,
  // 20: turn-scoped item lookups (findToolCallItem, itemsForTurn) without a full table scan
  `CREATE INDEX items_turn_seq ON items(turn_id, seq)`,
  // 21: persistent audit trail for approval decisions and permission/rule changes
  `CREATE TABLE approval_audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    approval_id TEXT,
    agent_id TEXT,
    turn_id TEXT,
    data_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX approval_audit_created ON approval_audit(created_at)`,
  // 22: pending approvals survive a daemon restart as "interrupted" records. Only the
  // approval_audit fields are stored (never args, detail, bot-written titles or secret values).
  `CREATE TABLE approval_records (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    turn_id TEXT,
    status TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    interrupted_at INTEGER
  );
  CREATE INDEX approval_records_status ON approval_records(status, created_at)`,
  // 23: tasks (a unit of work over an agent session) and their deliveries. Queue entries,
  // turns, items and the stored provider session carry the task id; items of private tasks
  // are flagged so they never reach chat.history, search or deliveries.
  `CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    situation TEXT NOT NULL,
    outcome TEXT,
    private INTEGER NOT NULL DEFAULT 0,
    tool_mode TEXT NOT NULL DEFAULT 'both',
    require_approval INTEGER NOT NULL DEFAULT 1,
    session_id TEXT,
    routine_id TEXT,
    template_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX tasks_created ON tasks(created_at, id);
  CREATE INDEX tasks_agent ON tasks(agent_id, situation, created_at);
  CREATE INDEX tasks_situation ON tasks(situation, created_at);
  CREATE TABLE task_deliveries (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT,
    url TEXT,
    mime TEXT,
    size INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX task_deliveries_task ON task_deliveries(task_id, created_at);
  CREATE INDEX task_deliveries_created ON task_deliveries(created_at);
  ALTER TABLE queue ADD COLUMN task_id TEXT;
  ALTER TABLE turns ADD COLUMN task_id TEXT;
  ALTER TABLE items ADD COLUMN task_id TEXT;
  ALTER TABLE items ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE agent_sessions ADD COLUMN task_id TEXT;
  CREATE INDEX queue_task ON queue(task_id, status);
  CREATE INDEX turns_task ON turns(task_id, started_at);
  CREATE INDEX items_task_seq ON items(task_id, seq)`,
  // 24: built-in and user templates
  `CREATE TABLE templates (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
    prompt TEXT NOT NULL, icon TEXT NOT NULL, tool_mode TEXT NOT NULL,
    require_approval INTEGER NOT NULL DEFAULT 0, schedule TEXT, builtin INTEGER NOT NULL DEFAULT 0,
    hidden_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  INSERT INTO templates (id, kind, name, description, prompt, icon, tool_mode, require_approval, schedule, builtin, created_at, updated_at) VALUES
  ('ci', 'task', 'Corrigir o teste que falha no CI e abrir um PR', 'Reproduz a falha no terminal, corrige o código e abre o PR com a descrição da causa.', 'Corrigir o teste que falha no CI e abrir um PR', 'git-pull-request', 'both', 1, NULL, 1, 0, 0),
  ('email', 'task', 'Resumir a reunião de produto e enviar ao time por e-mail', 'Lê a transcrição, escreve as decisões e os próximos passos e prepara o e-mail.', 'Resumir a reunião de produto e enviar ao time por e-mail', 'mail', 'both', 1, NULL, 1, 0, 0),
  ('deps', 'task', 'Atualizar as dependências desatualizadas e abrir um PR', 'Lista o que está velho, atualiza, ajusta a configuração e roda os testes.', 'Atualizar as dependências desatualizadas e abrir um PR', 'terminal', 'both', 1, NULL, 1, 0, 0),
  ('research', 'task', 'Comparar planos de hospedagem e recomendar um', 'Pesquisa as fontes oficiais e entrega um relatório com prós e contras.', 'Comparar planos de hospedagem e recomendar um', 'globe', 'browser', 0, NULL, 1, 0, 0),
  ('sales', 'routine', 'Toda segunda, consolidar as vendas da semana numa planilha', 'Baixa os relatórios do painel, junta os dados e salva a planilha no Drive.', 'Toda segunda, consolidar as vendas da semana numa planilha', 'sheet', 'both', 0, 'weekly mon 09:00', 1, 0, 0),
  ('inbox', 'routine', 'Todo dia, resumir o que chegou na minha caixa de entrada', 'Separa o que pede resposta do que pode esperar e escreve um resumo curto.', 'Todo dia, resumir o que chegou na minha caixa de entrada', 'repeat', 'both', 0, 'daily 08:00', 1, 0, 0)`,
  // 25: routine task defaults and one-shot scheduling
  `ALTER TABLE routines ADD COLUMN run_at INTEGER;
  ALTER TABLE routines ADD COLUMN tool_mode TEXT NOT NULL DEFAULT 'both';
  ALTER TABLE routines ADD COLUMN require_approval INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE routines ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE routines ADD COLUMN template_id TEXT;
  ALTER TABLE routine_runs ADD COLUMN task_id TEXT`,
  // 26: user-scope profile memory and prompt memory provenance
  `CREATE TABLE memories_next (
    id TEXT PRIMARY KEY,
    agent_id TEXT REFERENCES agents(id),
    kind TEXT NOT NULL DEFAULT 'agent' CHECK(kind IN ('profile', 'agent', 'skill')),
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    CHECK((kind = 'profile' AND agent_id IS NULL) OR (kind != 'profile' AND agent_id IS NOT NULL))
  );
  INSERT INTO memories_next (id, agent_id, text, created_at, updated_at, deleted_at)
    SELECT id, agent_id, text, created_at, updated_at, deleted_at FROM memories;
  DROP TABLE memories;
  ALTER TABLE memories_next RENAME TO memories;
  CREATE INDEX memories_agent ON memories(agent_id, created_at);
  CREATE UNIQUE INDEX memories_user_profile ON memories(kind) WHERE kind = 'profile';
  CREATE TABLE turn_memory_usage (
    turn_id TEXT NOT NULL REFERENCES turns(id),
    memory_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('profile', 'agent', 'skill')),
    text TEXT NOT NULL,
    PRIMARY KEY(turn_id, memory_id, kind)
  )`,
  // 27: deterministic machine names (`codigo-01`) for agents placed in a Firecracker microVM
  `CREATE TABLE machines (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE,
    host_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  // 28: agents cockpit — role ("O que ele faz"), per-agent approval policy, parallel instances
  `ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT '';
  ALTER TABLE agents ADD COLUMN require_approval INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE agents ADD COLUMN max_instances INTEGER`,
  // 29: saved routine attachments reused by every run
  `ALTER TABLE routines ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'`,
];
