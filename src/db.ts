// src/db.ts - reexport e migrações
import { Client } from 'pg';
import { resolveNodePgSslConfig } from './db/pgSsl';
import { normalizeProductProductionInput } from './utils/preparation';

export * from './db/index';

/** Conexão direta ao Postgres (recomendado: host db.* :5432). Evita Session pooler no boot das migrações. */
export function resolveMigrationConnectionString(): string {
  const dedicated = process.env.DATABASE_MIGRATION_URL?.trim();
  if (dedicated) return dedicated;
  const fallback = process.env.DATABASE_URL?.trim();
  if (fallback) return fallback;
  throw new Error('Defina DATABASE_URL ou DATABASE_MIGRATION_URL para executar migrações.');
}

// Backup: não há rotina automática neste servidor — use pg_dump + cron ou o backup nativo do provedor.

export async function runMigrations() {
  const client = new Client({
    connectionString: resolveMigrationConnectionString(),
    connectionTimeoutMillis: 30000,
    ssl: resolveNodePgSslConfig(),
  });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE,
        password TEXT,
        ativo INTEGER DEFAULT 1,
        token_version INTEGER DEFAULT 1,
        cliente_id INTEGER,
        cargo TEXT DEFAULT 'dono',
        permissoes TEXT DEFAULT NULL,
        nome TEXT DEFAULT NULL
      );
      CREATE TABLE IF NOT EXISTS produtos (
        id SERIAL PRIMARY KEY,
        name TEXT, price REAL, category TEXT, active INTEGER DEFAULT 1,
        color TEXT DEFAULT 'zinc', photo_url TEXT, codigo_barras TEXT,
        marca TEXT, descricao TEXT, custo REAL DEFAULT 0,
        destaque INTEGER DEFAULT 0, em_promocao INTEGER DEFAULT 0, preco_original REAL,
        ordem INTEGER DEFAULT 0,
        disponivel_de TEXT, disponivel_ate TEXT, tenant_id INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS categorias (
        id SERIAL PRIMARY KEY,
        nome TEXT NOT NULL, tenant_id INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY,
        order_number TEXT UNIQUE, status TEXT DEFAULT 'Criado',
        total_amount REAL, observation TEXT, receipt_text TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        tenant_id INTEGER DEFAULT 1,
        senha_pedido INTEGER DEFAULT 0,
        tipo_retirada TEXT DEFAULT 'local',
        canal TEXT DEFAULT 'balcao',
        cliente_nome TEXT, cliente_tel TEXT, endereco TEXT,
        pagamento_tipo TEXT, pagamento_status TEXT DEFAULT 'pendente',
        taxa_entrega REAL DEFAULT 0, motoboy_id INTEGER,
        saiu_entrega_at TIMESTAMPTZ, entregue_at TIMESTAMPTZ,
        pix_txid TEXT, pix_external_reference TEXT, delivery_cliente_id INTEGER,
        cancelado_at TIMESTAMPTZ,
        cancelamento_motivo TEXT,
        cancelado_por INTEGER,
        estoque_reposto INTEGER DEFAULT 0,
        estoque_reposto_at TIMESTAMPTZ,
        reembolso_status TEXT DEFAULT 'nenhum',
        valor_reembolsado REAL DEFAULT 0,
        reembolsado_at TIMESTAMPTZ,
        reembolso_motivo TEXT,
        reembolsado_por INTEGER
      );
      CREATE TABLE IF NOT EXISTS itens_pedido (
        id SERIAL PRIMARY KEY,
        order_id INTEGER, product_id INTEGER, quantity INTEGER,
        type TEXT, price_at_time REAL, tenant_id INTEGER DEFAULT 1,
        FOREIGN KEY(order_id) REFERENCES pedidos(id),
        FOREIGN KEY(product_id) REFERENCES produtos(id)
      );
      CREATE TABLE IF NOT EXISTS pagamentos (
        id SERIAL PRIMARY KEY,
        order_id INTEGER, method TEXT, amount_paid REAL, change_given REAL,
        created_at TIMESTAMPTZ DEFAULT NOW(), tenant_id INTEGER DEFAULT 1,
        FOREIGN KEY(order_id) REFERENCES pedidos(id)
      );
      CREATE TABLE IF NOT EXISTS pedido_pagamentos (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER DEFAULT 1,
        order_id INTEGER NOT NULL,
        method TEXT NOT NULL,
        provider TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        amount REAL NOT NULL DEFAULT 0,
        external_id TEXT,
        external_reference TEXT,
        qr_code_text TEXT,
        qr_code_image_base64 TEXT,
        paid_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        metadata_json TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY(order_id) REFERENCES pedidos(id)
      );
      CREATE TABLE IF NOT EXISTS despesas (
        id SERIAL PRIMARY KEY,
        description TEXT, amount REAL, category TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(), tenant_id INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS caixa (
        id SERIAL PRIMARY KEY,
        data TEXT NOT NULL, fundo_inicial REAL NOT NULL,
        valor_contado REAL, status TEXT DEFAULT 'aberto',
        observacao TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        closed_at TIMESTAMPTZ,
        tenant_id INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS ingredientes (
        id SERIAL PRIMARY KEY,
        nome TEXT NOT NULL, unidade TEXT NOT NULL,
        estoque_atual REAL DEFAULT 0, estoque_minimo REAL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(), tenant_id INTEGER DEFAULT 1,
        codigo_barras TEXT, custo_unitario REAL DEFAULT 0,
        fornecedor TEXT, unidade_compra TEXT
      );
      CREATE TABLE IF NOT EXISTS estoque_movimentacoes (
        id SERIAL PRIMARY KEY,
        ingrediente_id INTEGER NOT NULL, tipo TEXT NOT NULL,
        quantidade REAL NOT NULL, motivo TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(), tenant_id INTEGER DEFAULT 1,
        FOREIGN KEY(ingrediente_id) REFERENCES ingredientes(id)
      );
      CREATE TABLE IF NOT EXISTS solicitacoes (
        id SERIAL PRIMARY KEY,
        nome_estabelecimento TEXT NOT NULL, razao_social TEXT,
        documento_tipo TEXT NOT NULL, documento_numero TEXT NOT NULL,
        nome_responsavel TEXT NOT NULL, email TEXT NOT NULL,
        whatsapp TEXT NOT NULL, cidade TEXT NOT NULL,
        status TEXT DEFAULT 'pendente',
        segmento TEXT DEFAULT 'Restaurante/Food',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS clientes (
        id SERIAL PRIMARY KEY,
        solicitacao_id INTEGER, nome_estabelecimento TEXT NOT NULL,
        razao_social TEXT, documento_tipo TEXT NOT NULL, documento_numero TEXT NOT NULL,
        nome_responsavel TEXT NOT NULL, email TEXT NOT NULL,
        whatsapp TEXT NOT NULL, cidade TEXT NOT NULL,
        usuario TEXT UNIQUE NOT NULL, senha TEXT NOT NULL,
        status TEXT DEFAULT 'ativo',
        trial_inicio TIMESTAMPTZ DEFAULT NOW(),
        trial_fim TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        ultimo_acesso TIMESTAMPTZ,
        segmento TEXT DEFAULT 'Restaurante/Food',
        taxa_debito REAL DEFAULT 0, taxa_credito REAL DEFAULT 0, taxa_pix REAL DEFAULT 0,
        senha_admin TEXT, senha_caixa TEXT,
        printer_config TEXT DEFAULT NULL,
        plano TEXT DEFAULT 'trial', valor_plano REAL DEFAULT 0,
        vencimento TIMESTAMPTZ,
        delivery_ativo INTEGER DEFAULT 0, delivery_config TEXT DEFAULT NULL,
        FOREIGN KEY(solicitacao_id) REFERENCES solicitacoes(id)
      );
      CREATE TABLE IF NOT EXISTS mesas (
        id SERIAL PRIMARY KEY,
        numero INTEGER NOT NULL, status TEXT DEFAULT 'fechada',
        tenant_id INTEGER NOT NULL, opened_at TIMESTAMPTZ,
        UNIQUE(numero, tenant_id)
      );
      CREATE TABLE IF NOT EXISTS comandas (
        id SERIAL PRIMARY KEY,
        mesa_id INTEGER NOT NULL, tenant_id INTEGER NOT NULL,
        status TEXT DEFAULT 'aberta',
        created_at TIMESTAMPTZ DEFAULT NOW(), closed_at TIMESTAMPTZ,
        FOREIGN KEY(mesa_id) REFERENCES mesas(id)
      );
      CREATE TABLE IF NOT EXISTS itens_comanda (
        id SERIAL PRIMARY KEY,
        comanda_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
        product_name TEXT NOT NULL, quantity INTEGER DEFAULT 1,
        price_at_time REAL NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        tenant_id INTEGER NOT NULL,
        FOREIGN KEY(comanda_id) REFERENCES comandas(id)
      );
      CREATE TABLE IF NOT EXISTS renovacoes (
        id SERIAL PRIMARY KEY,
        cliente_id INTEGER NOT NULL, plano TEXT NOT NULL,
        valor REAL NOT NULL,
        data_pagamento TIMESTAMPTZ DEFAULT NOW(),
        vencimento_anterior TIMESTAMPTZ, novo_vencimento TIMESTAMPTZ,
        FOREIGN KEY(cliente_id) REFERENCES clientes(id)
      );
      CREATE TABLE IF NOT EXISTS system_logs (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER, usuario_nome TEXT NOT NULL,
        cargo TEXT DEFAULT 'dono', acao TEXT NOT NULL, detalhes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS admin_audit_events (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER,
        scope_type TEXT,
        scope_id TEXT,
        actor_type TEXT NOT NULL DEFAULT 'platform_admin',
        actor_id TEXT,
        actor_name TEXT NOT NULL DEFAULT 'Admin',
        actor_role TEXT NOT NULL DEFAULT 'admin',
        action TEXT NOT NULL,
        legacy_action TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        reason TEXT,
        request_id TEXT,
        session_fingerprint TEXT,
        request_method TEXT,
        request_path TEXT,
        summary TEXT,
        metadata_json JSONB,
        before_json JSONB,
        after_json JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS pedido_eventos (
        id SERIAL PRIMARY KEY,
        pedido_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        tipo TEXT NOT NULL,
        status_anterior TEXT,
        status_novo TEXT,
        valor REAL DEFAULT 0,
        motivo TEXT,
        estoque_reposto INTEGER DEFAULT 0,
        payload TEXT,
        usuario_id INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY(pedido_id) REFERENCES pedidos(id)
      );
      CREATE TABLE IF NOT EXISTS ai_avisos (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL, tipo TEXT NOT NULL,
        titulo TEXT NOT NULL, mensagem TEXT NOT NULL,
        acao TEXT, acao_rota TEXT, prioridade INTEGER DEFAULT 1,
        lido INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expira_em TIMESTAMPTZ, chave TEXT
      );
      CREATE TABLE IF NOT EXISTS ai_cache (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL, tipo TEXT NOT NULL,
        resultado TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS produto_ingrediente (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL, ingrediente_id INTEGER NOT NULL,
        quantidade_usada REAL NOT NULL DEFAULT 1,
        tenant_id INTEGER NOT NULL,
        unidade TEXT DEFAULT 'unidade'
      );
      CREATE TABLE IF NOT EXISTS produto_grupos_opcao (
        id SERIAL PRIMARY KEY,
        produto_id INTEGER NOT NULL, tenant_id INTEGER NOT NULL,
        nome TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'radio',
        min_selecoes INTEGER NOT NULL DEFAULT 0,
        max_selecoes INTEGER NOT NULL DEFAULT 1,
        obrigatorio INTEGER NOT NULL DEFAULT 0,
        ordem INTEGER NOT NULL DEFAULT 0,
        ativo INTEGER NOT NULL DEFAULT 1,
        modo_preco TEXT NOT NULL DEFAULT 'adicional',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS produto_opcao_itens (
        id SERIAL PRIMARY KEY,
        grupo_id INTEGER NOT NULL, tenant_id INTEGER NOT NULL,
        nome TEXT NOT NULL, preco_adicional REAL NOT NULL DEFAULT 0,
        ordem INTEGER NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS delivery_motoboys (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        nome TEXT NOT NULL,
        telefone TEXT, veiculo TEXT,
        ativo INTEGER DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(tenant_id, nome)
      );
      CREATE TABLE IF NOT EXISTS delivery_clientes (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        nome TEXT NOT NULL, telefone TEXT NOT NULL, email TEXT,
        favoritos TEXT DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        ultimo_acesso TIMESTAMPTZ,
        origem_cadastro TEXT DEFAULT 'delivery_online',
        observacoes TEXT,
        primeira_compra_at TIMESTAMPTZ,
        ultima_compra_at TIMESTAMPTZ,
        whatsapp_reativacao_last_sent_at TIMESTAMPTZ,
        whatsapp_reativacao_last_status TEXT,
        whatsapp_reativacao_last_operator_id INTEGER,
        UNIQUE(tenant_id, telefone)
      );
      CREATE TABLE IF NOT EXISTS delivery_enderecos (
        id SERIAL PRIMARY KEY, tenant_id INTEGER NOT NULL,
        cliente_id INTEGER NOT NULL, label TEXT NOT NULL DEFAULT 'Casa',
        logradouro TEXT NOT NULL, numero TEXT, complemento TEXT, bairro TEXT,
        referencia TEXT, principal INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS delivery_cupons (
        id SERIAL PRIMARY KEY, tenant_id INTEGER NOT NULL,
        codigo TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'percentual',
        valor REAL NOT NULL DEFAULT 0, min_pedido REAL DEFAULT 0,
        limite_uso INTEGER DEFAULT NULL, uso_atual INTEGER DEFAULT 0,
        ativo INTEGER DEFAULT 1, validade TEXT DEFAULT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(tenant_id, codigo)
      );
      CREATE TABLE IF NOT EXISTS produto_variacoes_vendaveis (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        produto_id INTEGER NOT NULL,
        nome TEXT NOT NULL,
        preco REAL NOT NULL DEFAULT 0,
        codigo_barras TEXT,
        ativo INTEGER NOT NULL DEFAULT 1,
        ordem INTEGER NOT NULL DEFAULT 0,
        ingrediente_id INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(tenant_id, produto_id, nome)
      );
    `);

    await client.query(`

    CREATE TABLE IF NOT EXISTS produto_sugestoes (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        produto_id INTEGER NOT NULL,
        produto_sugerido_id INTEGER NOT NULL,
        prioridade INTEGER NOT NULL DEFAULT 0,
        ativo INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(tenant_id, produto_id, produto_sugerido_id)
      );
      CREATE INDEX IF NOT EXISTS idx_produto_sugestoes_produto ON produto_sugestoes (tenant_id, produto_id);
      CREATE INDEX IF NOT EXISTS idx_produto_sugestoes_sugerido ON produto_sugestoes (tenant_id, produto_sugerido_id);

      CREATE TABLE IF NOT EXISTS sugestoes_eventos (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        produto_origem_id INTEGER NOT NULL,
        produto_sugerido_id INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_sugestoes_eventos_tenant ON sugestoes_eventos (tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_sugestoes_eventos_sugerido ON sugestoes_eventos (tenant_id, produto_sugerido_id);

      CREATE TABLE IF NOT EXISTS funcionarios (
        id SERIAL PRIMARY KEY, tenant_id INTEGER NOT NULL,
        nome TEXT NOT NULL, cargo TEXT NOT NULL DEFAULT '',
        salario_base REAL NOT NULL DEFAULT 0,
        horario_entrada TEXT DEFAULT '08:00',
        horario_saida TEXT DEFAULT '17:00',
        carga_horaria REAL DEFAULT 8,
        dias_semana TEXT DEFAULT '1,2,3,4,5',
        tolerancia_minutos INTEGER DEFAULT 10,
        dias_trabalho_mes INTEGER DEFAULT 26,
        data_admissao TEXT, telefone TEXT, cpf TEXT,
        pin TEXT, foto_url TEXT, face_descriptor TEXT,
        status TEXT NOT NULL DEFAULT 'ativo',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS func_pontos (
        id SERIAL PRIMARY KEY, tenant_id INTEGER NOT NULL,
        funcionario_id INTEGER NOT NULL, data TEXT NOT NULL,
        hora TEXT NOT NULL, tipo TEXT NOT NULL,
        ip TEXT, user_agent TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS func_eventos (
        id SERIAL PRIMARY KEY, tenant_id INTEGER NOT NULL,
        funcionario_id INTEGER NOT NULL, data TEXT NOT NULL,
        tipo TEXT NOT NULL, horas_ausentes REAL DEFAULT 0,
        observacao TEXT, arquivo_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS func_adiantamentos (
        id SERIAL PRIMARY KEY, tenant_id INTEGER NOT NULL,
        funcionario_id INTEGER NOT NULL, valor REAL NOT NULL DEFAULT 0,
        motivo TEXT, data TEXT DEFAULT CURRENT_DATE::text,
        descontado INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS func_ajustes_salario (
        id SERIAL PRIMARY KEY, tenant_id INTEGER NOT NULL,
        funcionario_id INTEGER NOT NULL, tipo TEXT NOT NULL,
        valor REAL NOT NULL DEFAULT 0, motivo TEXT,
        data TEXT DEFAULT CURRENT_DATE::text,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS func_horas_extras (
        id SERIAL PRIMARY KEY, tenant_id INTEGER NOT NULL,
        funcionario_id INTEGER NOT NULL, data TEXT NOT NULL,
        minutos INTEGER NOT NULL DEFAULT 0, observacao TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS func_pagamentos_folha (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        funcionario_id INTEGER NOT NULL,
        referencia TEXT NOT NULL,
        tipo TEXT NOT NULL,
        valor REAL NOT NULL,
        observacao TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        created_by TEXT,
        recibo_numero TEXT,
        metadata_json TEXT,
        despesas_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_func_pag_folha_lookup
        ON func_pagamentos_folha (tenant_id, funcionario_id, referencia);
    `);

    await client.query(`
      ALTER TABLE system_logs ALTER COLUMN tenant_id DROP NOT NULL;
      ALTER TABLE admin_audit_events ALTER COLUMN tenant_id DROP NOT NULL;
      ALTER TABLE admin_audit_events ADD COLUMN IF NOT EXISTS scope_type TEXT;
      ALTER TABLE admin_audit_events ADD COLUMN IF NOT EXISTS scope_id TEXT;

      ALTER TABLE clientes ADD COLUMN IF NOT EXISTS logo_url TEXT;
      ALTER TABLE clientes ALTER COLUMN senha_admin DROP DEFAULT;
      ALTER TABLE clientes ALTER COLUMN senha_caixa DROP DEFAULT;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pix_external_reference TEXT;
      ALTER TABLE func_horas_extras ADD COLUMN IF NOT EXISTS minutos_pago_folha INTEGER NULL;
      ALTER TABLE func_horas_extras ADD COLUMN IF NOT EXISTS destino_pendente INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE funcionarios ADD COLUMN IF NOT EXISTS tipo_contrato TEXT DEFAULT 'fixo';

      CREATE TABLE IF NOT EXISTS func_banco_horas_mov (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        funcionario_id INTEGER NOT NULL,
        data_referencia TEXT NOT NULL,
        tipo TEXT NOT NULL,
        minutos INTEGER NOT NULL,
        origem TEXT NOT NULL,
        observacao TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        created_by TEXT,
        metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_banco_horas_tenant_func_data
        ON func_banco_horas_mov (tenant_id, funcionario_id, data_referencia);

      ALTER TABLE func_decimo_terceiro ADD COLUMN IF NOT EXISTS calculo_modo TEXT DEFAULT 'automatico';
      ALTER TABLE func_decimo_terceiro ADD COLUMN IF NOT EXISTS valor_total_manual REAL NULL;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS func_ferias (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        funcionario_id INTEGER NOT NULL,
        data_inicio_aquisitivo TEXT NOT NULL,
        data_fim_aquisitivo TEXT NOT NULL,
        dias_disponiveis INTEGER NOT NULL DEFAULT 30,
        dias_usados INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'available',
        data_inicio_gozo TEXT,
        data_fim_gozo TEXT,
        valor_pago REAL NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_func_ferias_tenant_func
        ON func_ferias (tenant_id, funcionario_id, status);
      CREATE TABLE IF NOT EXISTS func_decimo_terceiro (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        funcionario_id INTEGER NOT NULL,
        ano INTEGER NOT NULL,
        meses_trabalhados INTEGER NOT NULL DEFAULT 0,
        valor_total REAL NOT NULL DEFAULT 0,
        valor_primeira_parcela REAL NOT NULL DEFAULT 0,
        valor_segunda_parcela REAL NOT NULL DEFAULT 0,
        pago_primeira INTEGER NOT NULL DEFAULT 0,
        pago_segunda INTEGER NOT NULL DEFAULT 0,
        primeira_pago_em TEXT,
        segunda_pago_em TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (tenant_id, funcionario_id, ano)
      );
      CREATE INDEX IF NOT EXISTS idx_func_decimo_tenant_func_ano
        ON func_decimo_terceiro (tenant_id, funcionario_id, ano);
      CREATE TABLE IF NOT EXISTS func_beneficios (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        funcionario_id INTEGER NOT NULL,
        tipo TEXT NOT NULL,
        valor REAL NOT NULL DEFAULT 0,
        tipo_valor TEXT NOT NULL DEFAULT 'fixo',
        ativo INTEGER NOT NULL DEFAULT 1,
        efeito TEXT NOT NULL DEFAULT 'acrescimo',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (tenant_id, funcionario_id, tipo)
      );
      CREATE INDEX IF NOT EXISTS idx_func_beneficios_tenant_func
        ON func_beneficios (tenant_id, funcionario_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_pix_config (
        tenant_id INTEGER NOT NULL,
        pix_enabled INTEGER NOT NULL DEFAULT 0,
        pix_mode TEXT NOT NULL DEFAULT 'manual',
        provider TEXT,
        provider_config_json TEXT,
        auto_confirm INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE tenant_pix_config ADD COLUMN IF NOT EXISTS tenant_id INTEGER;
      ALTER TABLE tenant_pix_config ADD COLUMN IF NOT EXISTS pix_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tenant_pix_config ADD COLUMN IF NOT EXISTS pix_mode TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE tenant_pix_config ADD COLUMN IF NOT EXISTS provider TEXT;
      ALTER TABLE tenant_pix_config ADD COLUMN IF NOT EXISTS provider_config_json TEXT;
      ALTER TABLE tenant_pix_config ADD COLUMN IF NOT EXISTS auto_confirm INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tenant_pix_config ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
      ALTER TABLE tenant_pix_config ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

      CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_pix_config_tenant
        ON tenant_pix_config (tenant_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_whatsapp_config (
        tenant_id INTEGER NOT NULL,
        whatsapp_enabled INTEGER NOT NULL DEFAULT 0,
        provider TEXT,
        provider_config_json TEXT,
        whatsapp_number TEXT,
        instance_name TEXT,
        channel_identifier TEXT,
        auto_notify_order_created INTEGER NOT NULL DEFAULT 0,
        auto_notify_order_accepted INTEGER NOT NULL DEFAULT 0,
        auto_notify_order_preparing INTEGER NOT NULL DEFAULT 0,
        auto_notify_order_out_for_delivery INTEGER NOT NULL DEFAULT 0,
        auto_notify_order_delivered INTEGER NOT NULL DEFAULT 0,
        auto_notify_order_cancelled INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE tenant_whatsapp_config ADD COLUMN IF NOT EXISTS tenant_id INTEGER;
      ALTER TABLE tenant_whatsapp_config ADD COLUMN IF NOT EXISTS whatsapp_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tenant_whatsapp_config ADD COLUMN IF NOT EXISTS provider TEXT;
      ALTER TABLE tenant_whatsapp_config ADD COLUMN IF NOT EXISTS provider_config_json TEXT;
      ALTER TABLE tenant_whatsapp_config ADD COLUMN IF NOT EXISTS whatsapp_number TEXT;
      ALTER TABLE tenant_whatsapp_config ADD COLUMN IF NOT EXISTS instance_name TEXT;
      ALTER TABLE tenant_whatsapp_config ADD COLUMN IF NOT EXISTS channel_identifier TEXT;
      ALTER TABLE tenant_whatsapp_config ADD COLUMN IF NOT EXISTS auto_notify_order_created INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tenant_whatsapp_config ADD COLUMN IF NOT EXISTS auto_notify_order_accepted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tenant_whatsapp_config ADD COLUMN IF NOT EXISTS auto_notify_order_preparing INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tenant_whatsapp_config ADD COLUMN IF NOT EXISTS auto_notify_order_out_for_delivery INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tenant_whatsapp_config ADD COLUMN IF NOT EXISTS auto_notify_order_delivered INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tenant_whatsapp_config ADD COLUMN IF NOT EXISTS auto_notify_order_cancelled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tenant_whatsapp_config ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
      ALTER TABLE tenant_whatsapp_config ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

      CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_whatsapp_config_tenant
        ON tenant_whatsapp_config (tenant_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_whatsapp_chatbot_config (
        tenant_id INTEGER NOT NULL,
        chatbot_enabled INTEGER NOT NULL DEFAULT 0,
        provider TEXT NOT NULL DEFAULT 'groq',
        model TEXT,
        system_prompt TEXT,
        provider_config_json TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE tenant_whatsapp_chatbot_config ADD COLUMN IF NOT EXISTS tenant_id INTEGER;
      ALTER TABLE tenant_whatsapp_chatbot_config ADD COLUMN IF NOT EXISTS chatbot_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tenant_whatsapp_chatbot_config ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'groq';
      ALTER TABLE tenant_whatsapp_chatbot_config ADD COLUMN IF NOT EXISTS model TEXT;
      ALTER TABLE tenant_whatsapp_chatbot_config ADD COLUMN IF NOT EXISTS system_prompt TEXT;
      ALTER TABLE tenant_whatsapp_chatbot_config ADD COLUMN IF NOT EXISTS provider_config_json TEXT;
      ALTER TABLE tenant_whatsapp_chatbot_config ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
      ALTER TABLE tenant_whatsapp_chatbot_config ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

      CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_whatsapp_chatbot_config_tenant
        ON tenant_whatsapp_chatbot_config (tenant_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_inbound_messages (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        provider_message_id TEXT,
        customer_phone TEXT NOT NULL,
        customer_name TEXT,
        message_text TEXT NOT NULL,
        payload_json TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE whatsapp_inbound_messages ADD COLUMN IF NOT EXISTS tenant_id INTEGER;
      ALTER TABLE whatsapp_inbound_messages ADD COLUMN IF NOT EXISTS provider TEXT;
      ALTER TABLE whatsapp_inbound_messages ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
      ALTER TABLE whatsapp_inbound_messages ADD COLUMN IF NOT EXISTS customer_phone TEXT;
      ALTER TABLE whatsapp_inbound_messages ADD COLUMN IF NOT EXISTS customer_name TEXT;
      ALTER TABLE whatsapp_inbound_messages ADD COLUMN IF NOT EXISTS message_text TEXT;
      ALTER TABLE whatsapp_inbound_messages ADD COLUMN IF NOT EXISTS payload_json TEXT;
      ALTER TABLE whatsapp_inbound_messages ADD COLUMN IF NOT EXISTS intent TEXT;
      ALTER TABLE whatsapp_inbound_messages ADD COLUMN IF NOT EXISTS auto_reply_text TEXT;
      ALTER TABLE whatsapp_inbound_messages ADD COLUMN IF NOT EXISTS auto_reply_status TEXT;
      ALTER TABLE whatsapp_inbound_messages ADD COLUMN IF NOT EXISTS auto_reply_error TEXT;
      ALTER TABLE whatsapp_inbound_messages ADD COLUMN IF NOT EXISTS auto_reply_provider TEXT;
      ALTER TABLE whatsapp_inbound_messages ADD COLUMN IF NOT EXISTS auto_reply_external_id TEXT;
      ALTER TABLE whatsapp_inbound_messages ADD COLUMN IF NOT EXISTS auto_reply_attempted_at TIMESTAMPTZ;
      ALTER TABLE whatsapp_inbound_messages ADD COLUMN IF NOT EXISTS auto_reply_sent_at TIMESTAMPTZ;
      ALTER TABLE whatsapp_inbound_messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
      ALTER TABLE whatsapp_inbound_messages ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ DEFAULT NOW();
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_human_handoffs (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        customer_phone TEXT NOT NULL,
        human_handoff_active INTEGER NOT NULL DEFAULT 1,
        handoff_reason TEXT,
        handoff_created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE whatsapp_human_handoffs ADD COLUMN IF NOT EXISTS tenant_id INTEGER;
      ALTER TABLE whatsapp_human_handoffs ADD COLUMN IF NOT EXISTS customer_phone TEXT;
      ALTER TABLE whatsapp_human_handoffs ADD COLUMN IF NOT EXISTS human_handoff_active INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE whatsapp_human_handoffs ADD COLUMN IF NOT EXISTS handoff_reason TEXT;
      ALTER TABLE whatsapp_human_handoffs ADD COLUMN IF NOT EXISTS handoff_created_at TIMESTAMPTZ DEFAULT NOW();
      ALTER TABLE whatsapp_human_handoffs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
    `);

    await client.query(`
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cancelado_at TIMESTAMPTZ;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cancelamento_motivo TEXT;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cancelado_por INTEGER;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS estoque_reposto INTEGER DEFAULT 0;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS estoque_reposto_at TIMESTAMPTZ;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS reembolso_status TEXT DEFAULT 'nenhum';
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS valor_reembolsado REAL DEFAULT 0;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS reembolsado_at TIMESTAMPTZ;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS reembolso_motivo TEXT;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS reembolsado_por INTEGER;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS mesa_id INTEGER;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS comanda_id INTEGER;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS subtotal REAL DEFAULT 0;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS delivery_checkout_snapshot TEXT;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS taxa_servico_ativa INTEGER DEFAULT 0;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS taxa_servico_percentual REAL DEFAULT 0;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS valor_taxa_servico REAL DEFAULT 0;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS couvert_ativo INTEGER DEFAULT 0;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS couvert_valor_unitario REAL DEFAULT 0;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS couvert_quantidade_pessoas INTEGER DEFAULT 1;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS valor_couvert REAL DEFAULT 0;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS total_extras REAL DEFAULT 0;
      ALTER TABLE produtos ADD COLUMN IF NOT EXISTS public_id TEXT;
      ALTER TABLE produtos ADD COLUMN IF NOT EXISTS requires_preparation INTEGER;
      ALTER TABLE produtos ADD COLUMN IF NOT EXISTS production_type TEXT;
      ALTER TABLE produtos ADD COLUMN IF NOT EXISTS em_promocao INTEGER DEFAULT 0;
      ALTER TABLE produtos ADD COLUMN IF NOT EXISTS preco_original REAL;
      ALTER TABLE produtos ADD COLUMN IF NOT EXISTS mais_vendido INTEGER DEFAULT 0;
      ALTER TABLE ingredientes ADD COLUMN IF NOT EXISTS public_id TEXT;
      ALTER TABLE itens_pedido ADD COLUMN IF NOT EXISTS variation_id INTEGER;
      ALTER TABLE itens_pedido ADD COLUMN IF NOT EXISTS observation TEXT;
      CREATE TABLE IF NOT EXISTS pedido_eventos (
        id SERIAL PRIMARY KEY,
        pedido_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        tipo TEXT NOT NULL,
        status_anterior TEXT,
        status_novo TEXT,
        valor REAL DEFAULT 0,
        motivo TEXT,
        estoque_reposto INTEGER DEFAULT 0,
        payload TEXT,
        usuario_id INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY(pedido_id) REFERENCES pedidos(id)
      );
      ALTER TABLE delivery_clientes ADD COLUMN IF NOT EXISTS origem_cadastro TEXT DEFAULT 'delivery_online';
      ALTER TABLE delivery_clientes ADD COLUMN IF NOT EXISTS observacoes TEXT;
      ALTER TABLE delivery_clientes ADD COLUMN IF NOT EXISTS primeira_compra_at TIMESTAMPTZ;
      ALTER TABLE delivery_clientes ADD COLUMN IF NOT EXISTS ultima_compra_at TIMESTAMPTZ;
      ALTER TABLE comandas ADD COLUMN IF NOT EXISTS taxa_servico_ativa INTEGER DEFAULT 1;
      ALTER TABLE comandas ADD COLUMN IF NOT EXISTS taxa_servico_percentual REAL DEFAULT 10;
      ALTER TABLE comandas ADD COLUMN IF NOT EXISTS couvert_ativo INTEGER DEFAULT 0;
      ALTER TABLE comandas ADD COLUMN IF NOT EXISTS couvert_valor_unitario REAL DEFAULT 15;
      ALTER TABLE comandas ADD COLUMN IF NOT EXISTS couvert_quantidade_pessoas INTEGER DEFAULT 1;
      ALTER TABLE itens_comanda ADD COLUMN IF NOT EXISTS observation TEXT;
      ALTER TABLE itens_comanda ADD COLUMN IF NOT EXISTS variation_id INTEGER;
      ALTER TABLE itens_pedido ADD COLUMN IF NOT EXISTS selecoes_json TEXT;
      ALTER TABLE itens_comanda ADD COLUMN IF NOT EXISTS selecoes_json TEXT;
      ALTER TABLE delivery_clientes ADD COLUMN IF NOT EXISTS ativo INTEGER DEFAULT 1;
      ALTER TABLE delivery_clientes ADD COLUMN IF NOT EXISTS cpf TEXT;
      ALTER TABLE delivery_clientes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
      ALTER TABLE delivery_clientes ADD COLUMN IF NOT EXISTS whatsapp_reativacao_last_sent_at TIMESTAMPTZ;
      ALTER TABLE delivery_clientes ADD COLUMN IF NOT EXISTS whatsapp_reativacao_last_status TEXT;
      ALTER TABLE delivery_clientes ADD COLUMN IF NOT EXISTS whatsapp_reativacao_last_operator_id INTEGER;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cliente_id INTEGER;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS delivery_endereco_id INTEGER;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pagamento_confirmado_at TIMESTAMPTZ;
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pagamento_confirmado_valor REAL;
    `);

    await client.query(`
      UPDATE pedidos SET cliente_id = delivery_cliente_id
      WHERE delivery_cliente_id IS NOT NULL AND cliente_id IS NULL;
    `);

    await client.query(`
      UPDATE comandas
      SET taxa_servico_ativa = COALESCE(taxa_servico_ativa, 1),
          taxa_servico_percentual = COALESCE(taxa_servico_percentual, 10),
          couvert_ativo = COALESCE(couvert_ativo, 0),
          couvert_valor_unitario = COALESCE(couvert_valor_unitario, 15),
          couvert_quantidade_pessoas = GREATEST(1, COALESCE(couvert_quantidade_pessoas, 1));

      UPDATE produtos
      SET public_id = CONCAT('prd_', SUBSTRING(MD5(CONCAT(tenant_id::text, '-', id::text, '-produto')), 1, 24))
      WHERE public_id IS NULL OR BTRIM(public_id) = '';

      UPDATE pedidos
      SET canal = 'retirada'
      WHERE LOWER(COALESCE(tipo_retirada, '')) = 'levar'
        AND LOWER(COALESCE(canal, 'balcao')) = 'balcao';

      UPDATE ingredientes
      SET public_id = CONCAT('ing_', SUBSTRING(MD5(CONCAT(tenant_id::text, '-', id::text, '-ingrediente')), 1, 24))
      WHERE public_id IS NULL OR BTRIM(public_id) = '';

      UPDATE produtos
      SET codigo_barras = UPPER(REGEXP_REPLACE(BTRIM(codigo_barras), '\\s+', '', 'g'))
      WHERE codigo_barras IS NOT NULL
        AND codigo_barras <> UPPER(REGEXP_REPLACE(BTRIM(codigo_barras), '\\s+', '', 'g'));

      UPDATE ingredientes
      SET codigo_barras = UPPER(REGEXP_REPLACE(BTRIM(codigo_barras), '\\s+', '', 'g'))
      WHERE codigo_barras IS NOT NULL
        AND codigo_barras <> UPPER(REGEXP_REPLACE(BTRIM(codigo_barras), '\\s+', '', 'g'));
    `);

    const productsMissingProduction = await client.query<{
      id: number;
      name: string | null;
      category: string | null;
      requires_preparation: number | null;
      production_type: string | null;
    }>(
      `SELECT id, name, category, requires_preparation, production_type
       FROM produtos
       WHERE requires_preparation IS NULL
          OR production_type IS NULL
          OR BTRIM(COALESCE(production_type, '')) = ''`
    );

    for (const product of productsMissingProduction.rows) {
      const normalized = normalizeProductProductionInput(
        {
          requires_preparation: product.requires_preparation,
          production_type: product.production_type,
        },
        product
      );

      await client.query(
        'UPDATE produtos SET requires_preparation=$1, production_type=$2 WHERE id=$3',
        [normalized.requiresPreparation, normalized.productionType, product.id]
      );
    }

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pedidos_tenant_date      ON pedidos(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_pagamentos_tenant_date   ON pagamentos(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_pedido_pagamentos_tenant ON pedido_pagamentos(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_pedido_pagamentos_order  ON pedido_pagamentos(order_id);
      CREATE INDEX IF NOT EXISTS idx_pedido_pagamentos_status ON pedido_pagamentos(status);
      CREATE INDEX IF NOT EXISTS idx_despesas_tenant_date     ON despesas(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_estoque_mov_tenant_date  ON estoque_movimentacoes(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_system_logs_tenant_date  ON system_logs(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_events_tenant_date ON admin_audit_events(tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_events_tenant_action_date ON admin_audit_events(tenant_id, action, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_events_request_id ON admin_audit_events(request_id);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_events_tenant_entity_date ON admin_audit_events(tenant_id, entity_type, entity_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_events_tenant_session_date ON admin_audit_events(tenant_id, session_fingerprint, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_events_scope_date ON admin_audit_events(scope_type, scope_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pedido_eventos_pedido    ON pedido_eventos(pedido_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_pedido_eventos_tenant    ON pedido_eventos(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_itens_pedido_tenant      ON itens_pedido(tenant_id, order_id);
      CREATE INDEX IF NOT EXISTS idx_caixa_tenant_data        ON caixa(tenant_id, data);
      CREATE INDEX IF NOT EXISTS idx_produtos_barcode         ON produtos(codigo_barras, tenant_id);
      CREATE INDEX IF NOT EXISTS idx_ing_barcode              ON ingredientes(codigo_barras, tenant_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_produtos_public_id ON produtos(public_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ingredientes_public_id ON ingredientes(public_id);
      CREATE INDEX IF NOT EXISTS idx_prod_grupos              ON produto_grupos_opcao(produto_id, tenant_id);
      CREATE INDEX IF NOT EXISTS idx_prod_opcao_itens         ON produto_opcao_itens(grupo_id, tenant_id);
      CREATE INDEX IF NOT EXISTS idx_delivery_motoboys_tenant ON delivery_motoboys(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_delivery_clientes_recencia ON delivery_clientes(tenant_id, ultima_compra_at DESC);
      CREATE INDEX IF NOT EXISTS idx_delivery_clientes_wa_reativacao ON delivery_clientes(tenant_id, whatsapp_reativacao_last_sent_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pedidos_delivery_cliente ON pedidos(tenant_id, delivery_cliente_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pedidos_tenant_cliente_loja ON pedidos(tenant_id, cliente_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prod_var_vend_produto ON produto_variacoes_vendaveis(tenant_id, produto_id, ativo, ordem);
      CREATE INDEX IF NOT EXISTS idx_prod_var_vend_barcode ON produto_variacoes_vendaveis(tenant_id, codigo_barras);
      CREATE INDEX IF NOT EXISTS idx_ai_avisos_tenant_lido ON ai_avisos(tenant_id, lido);
      CREATE INDEX IF NOT EXISTS idx_ai_cache_tenant_tipo_dt ON ai_cache(tenant_id, tipo, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_whatsapp_inbound_messages_tenant ON whatsapp_inbound_messages(tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_whatsapp_inbound_messages_phone ON whatsapp_inbound_messages(tenant_id, customer_phone, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_inbound_messages_provider_msg
        ON whatsapp_inbound_messages(tenant_id, provider, provider_message_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_human_handoffs_tenant_phone
        ON whatsapp_human_handoffs(tenant_id, customer_phone);
      CREATE INDEX IF NOT EXISTS idx_whatsapp_human_handoffs_active
        ON whatsapp_human_handoffs(tenant_id, human_handoff_active, handoff_created_at DESC);
    `);

    await client.query(`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY tenant_id, chave
                 ORDER BY created_at DESC NULLS LAST, id DESC
               ) AS rn
        FROM ai_avisos
        WHERE chave IS NOT NULL
          AND expira_em IS NULL
      )
      UPDATE ai_avisos a
      SET expira_em = NOW()
      FROM ranked r
      WHERE a.id = r.id AND r.rn > 1
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_avisos_tenant_chave_unexpired
      ON ai_avisos (tenant_id, chave)
      WHERE chave IS NOT NULL AND expira_em IS NULL
    `);

    await client.query(`
      UPDATE delivery_clientes
      SET origem_cadastro = 'delivery_online'
      WHERE origem_cadastro IS NULL OR BTRIM(origem_cadastro) = ''
    `);

    await client.query(`
      UPDATE delivery_clientes dc
      SET primeira_compra_at = stats.primeira_compra_at,
          ultima_compra_at = stats.ultima_compra_at
      FROM (
        SELECT
          COALESCE(cliente_id, delivery_cliente_id) AS cliente_loja_id,
          tenant_id,
          MIN(created_at) FILTER (
            WHERE cancelado_at IS NULL
              AND LOWER(COALESCE(status, '')) <> 'cancelado'
          ) AS primeira_compra_at,
          MAX(created_at) FILTER (
            WHERE cancelado_at IS NULL
              AND LOWER(COALESCE(status, '')) <> 'cancelado'
          ) AS ultima_compra_at
        FROM pedidos
        WHERE cliente_id IS NOT NULL OR delivery_cliente_id IS NOT NULL
        GROUP BY COALESCE(cliente_id, delivery_cliente_id), tenant_id
      ) stats
      WHERE dc.id = stats.cliente_loja_id
        AND dc.tenant_id = stats.tenant_id
        AND (
          dc.primeira_compra_at IS DISTINCT FROM stats.primeira_compra_at
          OR dc.ultima_compra_at IS DISTINCT FROM stats.ultima_compra_at
        )
    `);

    await client.query(`
      UPDATE comandas SET status='fechada', closed_at=NOW()
      WHERE status='aberta'
        AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date < CURRENT_DATE
    `);

    await client.query(`
      UPDATE mesas SET status='fechada', opened_at=NULL
      WHERE status='aberta'
        AND (opened_at AT TIME ZONE 'America/Sao_Paulo')::date < CURRENT_DATE
    `);

    await client.query(`
      ALTER TABLE solicitacoes ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pendente'
    `);

    await client.query(`
      ALTER TABLE produtos ADD COLUMN IF NOT EXISTS is_combo INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS produto_combo_grupos (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        produto_id INTEGER NOT NULL,
        nome TEXT NOT NULL,
        ordem INTEGER NOT NULL DEFAULT 0,
        obrigatorio INTEGER NOT NULL DEFAULT 0,
        qtd_min INTEGER NOT NULL DEFAULT 0,
        qtd_max INTEGER NOT NULL DEFAULT 1,
        ativo INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (produto_id) REFERENCES produtos(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS produto_combo_grupo_produtos (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        grupo_id INTEGER NOT NULL,
        produto_componente_id INTEGER NOT NULL,
        ordem INTEGER NOT NULL DEFAULT 0,
        ativo INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (grupo_id) REFERENCES produto_combo_grupos(id) ON DELETE CASCADE,
        FOREIGN KEY (produto_componente_id) REFERENCES produtos(id) ON DELETE CASCADE,
        UNIQUE (tenant_id, grupo_id, produto_componente_id)
      );
      CREATE INDEX IF NOT EXISTS idx_combo_grupos_produto ON produto_combo_grupos(tenant_id, produto_id, ativo);
      CREATE INDEX IF NOT EXISTS idx_combo_grupo_prod ON produto_combo_grupo_produtos(tenant_id, grupo_id, ativo);
    `);

    await client.query(`DELETE FROM usuarios WHERE username='admin'`);

    await client.query(`
      ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS legal_bundle_version TEXT;
      ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS legal_accepted_at TIMESTAMPTZ;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS lgpd_solicitacoes (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        tipo TEXT NOT NULL,
        entidade_id INTEGER NOT NULL,
        motivo TEXT,
        status TEXT NOT NULL DEFAULT 'pendente',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);


// WhatsApp IA — novas tabelas
const { ensureOrdersSourceColumns }       = await import('./db/migrations/ordersSource');
const { ensureWhatsAppCampaignsTable }    = await import('./db/migrations/whatsappCampaigns');
const { ensureWhatsAppIntegrationsTable } = await import('./db/migrations/whatsappIntegrations');
const { ensureWhatsAppAiUsageColumns }    = await import('./db/migrations/whatsappAiUsage');
const { ensureGarconsSchema }             = await import('./db/migrations/garcons');
await ensureOrdersSourceColumns();
await ensureWhatsAppCampaignsTable();
await ensureWhatsAppIntegrationsTable();
await ensureWhatsAppAiUsageColumns();
await ensureGarconsSchema();

    console.log('Migracoes PostgreSQL concluidas.');
  } catch (err: any) {
    console.error('Erro nas migracoes:', err.message);
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}
