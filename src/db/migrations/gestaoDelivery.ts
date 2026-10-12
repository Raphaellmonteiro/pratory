/**
 * Migration: gestaoDelivery.ts
 *
 * Módulo "Gestão de Delivery" do painel admin (substitui a planilha
 * CONTROLE_RESTAURANTES).
 *
 * - gd_estabelecimentos: cadastro do restaurante que eu gerencio (dados,
 *   PIX, parceiro opcional e os percentuais combinados).
 * - gd_lancamentos: 1 linha por estabelecimento por semana, com o líquido que
 *   o dono recebeu em cada app. Os percentuais são "congelados" (snapshot) na
 *   criação da semana: mudar o % do restaurante NÃO reescreve o histórico.
 * - renovacoes ganha forma_pagamento/obs/origem (receita do software).
 *
 * Valores monetários em NUMERIC(12,2); percentuais em "pontos" (ex.: 7.5 = 7,5%).
 */

import { query } from '../index';

let promise: Promise<void> | null = null;

export async function ensureGestaoDeliverySchema(): Promise<void> {
  if (!promise) {
    promise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS gd_estabelecimentos (
          id SERIAL PRIMARY KEY,
          nome TEXT NOT NULL,
          cliente_id INTEGER,                       -- vínculo opcional com clientes (usa o software)
          razao_social TEXT,
          documento_tipo TEXT,                      -- CPF | CNPJ
          documento_numero TEXT,
          responsavel TEXT,
          whatsapp TEXT,
          email TEXT,
          cidade TEXT,
          pix_tipo TEXT,                            -- cpf | cnpj | email | telefone | aleatoria
          pix_chave TEXT,
          pix_titular TEXT,
          apps TEXT[] NOT NULL DEFAULT ARRAY['99food','ifood'],
          pct_meu NUMERIC(6,3) NOT NULL DEFAULT 0,       -- minha parte, em pontos
          tem_parceiro BOOLEAN NOT NULL DEFAULT FALSE,
          parceiro_nome TEXT,
          parceiro_pix TEXT,
          pct_parceiro NUMERIC(6,3) NOT NULL DEFAULT 0,  -- parte do parceiro, em pontos
          inicio_em DATE,
          ativo BOOLEAN NOT NULL DEFAULT TRUE,
          observacoes TEXT,                         -- NÃO guardar senhas aqui
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS gd_lancamentos (
          id SERIAL PRIMARY KEY,
          estabelecimento_id INTEGER NOT NULL REFERENCES gd_estabelecimentos(id) ON DELETE CASCADE,
          semana_inicio DATE NOT NULL,
          semana_fim DATE NOT NULL,
          valor_99food NUMERIC(12,2) NOT NULL DEFAULT 0,
          valor_ifood  NUMERIC(12,2) NOT NULL DEFAULT 0,
          valor_outros NUMERIC(12,2) NOT NULL DEFAULT 0,
          pct_meu_snap NUMERIC(6,3) NOT NULL DEFAULT 0,
          pct_parceiro_snap NUMERIC(6,3) NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'em_andamento',   -- em_andamento | aguardando | pago
          data_pagamento DATE,
          repasse_pago BOOLEAN NOT NULL DEFAULT FALSE,
          repasse_data DATE,
          observacoes TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (estabelecimento_id, semana_inicio),
          CHECK (status IN ('em_andamento','aguardando','pago'))
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_gd_lanc_semana ON gd_lancamentos(semana_inicio)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_gd_lanc_status ON gd_lancamentos(status)`);

      // Receita do software: renovacoes já existe; só acrescentamos contexto.
      await query(`ALTER TABLE renovacoes ADD COLUMN IF NOT EXISTS forma_pagamento TEXT`);
      await query(`ALTER TABLE renovacoes ADD COLUMN IF NOT EXISTS observacoes TEXT`);
      await query(`ALTER TABLE renovacoes ADD COLUMN IF NOT EXISTS origem TEXT`); // 'pagamento' | 'edicao' | legado = NULL
    })();
  }
  return promise;
}
