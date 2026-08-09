/**
 * Migration: garcons.ts
 *
 * Cadastro de garçons "de salão" — separado de `funcionarios` (RH/folha de
 * pagamento) de propósito: o dono pode querer colocar um garçom pra abrir
 * mesas pelo QR sem necessariamente cadastrá-lo na folha de pagamento.
 *
 * - `garcons`: nome + PIN (hash bcrypt, mesmo padrão de `funcionarios.pin`)
 *   + percentual de taxa de serviço individual (opcional — se nulo, usa a
 *   divisão geral configurada em `clientes.taxa_servico_modo_divisao`).
 * - `mesas`/`comandas`/`pedidos` ganham `garcom_id`/`garcom_nome` pra saber
 *   quem abriu a mesa e, no fechamento, pra quem contabilizar a taxa de
 *   serviço nos relatórios.
 */

import { query } from '../index';

let promise: Promise<void> | null = null;

export async function ensureGarconsSchema(): Promise<void> {
  if (!promise) {
    promise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS garcons (
          id SERIAL PRIMARY KEY,
          tenant_id INTEGER NOT NULL,
          nome TEXT NOT NULL,
          pin TEXT NOT NULL,
          taxa_percentual_override REAL,
          ativo INTEGER NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_garcons_tenant ON garcons(tenant_id, ativo)`);

      await query(`ALTER TABLE mesas ADD COLUMN IF NOT EXISTS garcom_id INTEGER`);
      await query(`ALTER TABLE mesas ADD COLUMN IF NOT EXISTS garcom_nome TEXT`);

      await query(`ALTER TABLE comandas ADD COLUMN IF NOT EXISTS garcom_id INTEGER`);
      await query(`ALTER TABLE comandas ADD COLUMN IF NOT EXISTS garcom_nome TEXT`);

      await query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS garcom_id INTEGER`);
      await query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS garcom_nome TEXT`);

      // 'individual': cada garçom recebe a taxa das mesas que ele fechou.
      // 'geral': o total arrecadado de taxa de serviço no período é somado e
      // dividido igualmente entre os garçons ativos (pra não ter garçom em
      // vantagem só por conseguir abrir mais mesas).
      await query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS taxa_servico_modo_divisao TEXT DEFAULT 'individual'`);

      await query(`CREATE INDEX IF NOT EXISTS idx_pedidos_garcom ON pedidos(tenant_id, garcom_id)`);
    })().catch((err) => {
      promise = null;
      throw err;
    });
  }
  return promise;
}
