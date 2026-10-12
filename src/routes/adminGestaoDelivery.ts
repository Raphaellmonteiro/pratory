// src/routes/adminGestaoDelivery.ts — Gestão de Delivery + Ganhos gerais (painel admin)
//
// Uso (em createAdminRouter, logo depois de `admin.use(authenticateAdmin)`):
//   registerGestaoDeliveryRoutes(admin);
//
// Regras de cálculo (iguais às da planilha, mas com arredondamento em centavos):
//   base      = líquido 99Food + iFood + outros   (o que o DONO recebeu dos apps)
//   comissão  = base × (%meu + %parceiro)
//   repasse   = base × %parceiro                  (vai pro parceiro)
//   meu       = comissão − repasse                (o que realmente fica comigo)
// Os % ficam congelados em cada semana (snapshot).

import type { Router, Request, Response } from 'express';
import { z } from 'zod';
import { q1, qAll, qRun, qInsert, withTx, txQ1, txRun } from '../db';
import { sendInternalError } from '../utils/internalServerError';
import { invalidateTenantPlanCache } from '../services/tenantPlan';

const TZ = 'America/Sao_Paulo';
const CTX = 'routes/adminGestaoDelivery';

/* ───────────── helpers ───────────── */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (use AAAA-MM-DD).');
const money = z.coerce.number().min(0).max(10_000_000);
const pct = z.coerce.number().min(0).max(100);
const blankToNull = (v: unknown) => (v === '' || v === undefined ? null : v);
const optText = (max = 500) => z.preprocess(blankToNull, z.string().trim().max(max).nullable());
/** Como optText, mas campo ausente continua undefined (PATCH não pode apagar dados sem querer). */
const patchText = (max = 500) =>
  z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(max).nullable().optional());

function fail(res: Response, status: number, error: string) {
  res.status(status).json({ success: false, error });
}

function handler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (e: unknown) {
      if (e instanceof z.ZodError) {
        return fail(res, 400, e.issues[0]?.message || 'Dados inválidos.');
      }
      if (e instanceof Error && e.message.startsWith('HTTP:')) {
        const [, code, ...msg] = e.message.split(':');
        return fail(res, Number(code), msg.join(':'));
      }
      sendInternalError(res, CTX, e);
    }
  };
}
const httpError = (code: number, msg: string) => new Error(`HTTP:${code}:${msg}`);

/** Segunda-feira da semana de uma data AAAA-MM-DD (sem fuso: opera em UTC puro). */
export function weekStartOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // seg=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Fragmento SQL com as colunas calculadas. Alias da tabela: l */
const CALC = `
  (l.valor_99food + l.valor_ifood + l.valor_outros)::float8 AS base,
  ROUND((l.valor_99food + l.valor_ifood + l.valor_outros) * (l.pct_meu_snap + l.pct_parceiro_snap) / 100, 2)::float8 AS comissao,
  ROUND((l.valor_99food + l.valor_ifood + l.valor_outros) * l.pct_parceiro_snap / 100, 2)::float8 AS repasse,
  (ROUND((l.valor_99food + l.valor_ifood + l.valor_outros) * (l.pct_meu_snap + l.pct_parceiro_snap) / 100, 2)
   - ROUND((l.valor_99food + l.valor_ifood + l.valor_outros) * l.pct_parceiro_snap / 100, 2))::float8 AS meu
`;

/** Mesma conta, mas em numeric (para SUM sem erro de ponto flutuante; converter com ::float8 depois). */
const CALC_N = CALC.replace(/::float8/g, '');

const LANC_COLS = `
  l.id, l.estabelecimento_id, l.semana_inicio::text AS semana_inicio, l.semana_fim::text AS semana_fim,
  l.valor_99food::float8 AS valor_99food, l.valor_ifood::float8 AS valor_ifood, l.valor_outros::float8 AS valor_outros,
  l.pct_meu_snap::float8 AS pct_meu_snap, l.pct_parceiro_snap::float8 AS pct_parceiro_snap,
  l.status, l.data_pagamento::text AS data_pagamento, l.repasse_pago, l.repasse_data::text AS repasse_data,
  l.observacoes, ${CALC}
`;

const EST_COLS = `
  e.id, e.nome, e.cliente_id, e.razao_social, e.documento_tipo, e.documento_numero, e.responsavel,
  e.whatsapp, e.email, e.cidade, e.pix_tipo, e.pix_chave, e.pix_titular, e.apps,
  e.pct_meu::float8 AS pct_meu, e.tem_parceiro, e.parceiro_nome, e.parceiro_pix,
  e.pct_parceiro::float8 AS pct_parceiro, e.inicio_em::text AS inicio_em, e.ativo, e.observacoes
`;

const TODAY_SQL = `(NOW() AT TIME ZONE '${TZ}')::date`;

/* ───────────── schemas ───────────── */

const estabelecimentoSchema = z
  .object({
    nome: z.string().trim().min(2, 'Informe o nome do estabelecimento.').max(120),
    cliente_id: z.preprocess(blankToNull, z.coerce.number().int().positive().nullable()),
    razao_social: optText(160),
    documento_tipo: z.preprocess(blankToNull, z.enum(['CPF', 'CNPJ']).nullable()),
    documento_numero: optText(30),
    responsavel: optText(120),
    whatsapp: optText(30),
    email: optText(160),
    cidade: optText(80),
    pix_tipo: z.preprocess(blankToNull, z.enum(['cpf', 'cnpj', 'email', 'telefone', 'aleatoria']).nullable()),
    pix_chave: optText(160),
    pix_titular: optText(120),
    apps: z.array(z.enum(['99food', 'ifood', 'outros'])).default(['99food', 'ifood']),
    pct_meu: pct,
    tem_parceiro: z.coerce.boolean().default(false),
    parceiro_nome: optText(120),
    parceiro_pix: optText(160),
    pct_parceiro: pct.default(0),
    inicio_em: z.preprocess(blankToNull, isoDate.nullable()),
    observacoes: optText(2000),
    recalcular_abertas: z.coerce.boolean().optional(),
  })
  .transform((v) => ({
    ...v,
    // sem parceiro => zera tudo do parceiro (evita % "fantasma")
    pct_parceiro: v.tem_parceiro ? v.pct_parceiro : 0,
    parceiro_nome: v.tem_parceiro ? v.parceiro_nome : null,
    parceiro_pix: v.tem_parceiro ? v.parceiro_pix : null,
  }));

const lancamentoSchema = z.object({
  estabelecimento_id: z.coerce.number().int().positive(),
  semana_inicio: isoDate,
  valor_99food: money.default(0),
  valor_ifood: money.default(0),
  valor_outros: money.default(0),
  observacoes: optText(1000).optional(),
});

const lancamentoPatchSchema = z.object({
  status: z.enum(['em_andamento', 'aguardando', 'pago']).optional(),
  data_pagamento: z.preprocess((v) => (v === '' ? null : v), isoDate.nullable().optional()),
  repasse_pago: z.coerce.boolean().optional(),
  repasse_data: z.preprocess((v) => (v === '' ? null : v), isoDate.nullable().optional()),
  observacoes: patchText(1000),
  pct_meu_snap: pct.optional(),
  pct_parceiro_snap: pct.optional(),
});

/* ───────────── rotas ───────────── */

export function registerGestaoDeliveryRoutes(admin: Router) {
  /* ---------- Estabelecimentos ---------- */

  admin.get('/gestao-delivery/estabelecimentos', handler(async (_req, res) => {
    const rows = await qAll(
      `SELECT ${EST_COLS},
              COALESCE(s.total_semanas, 0)::int AS total_semanas,
              COALESCE(s.total_meu, 0)::float8 AS meu_acumulado
         FROM gd_estabelecimentos e
         LEFT JOIN (
           SELECT estabelecimento_id, COUNT(*) AS total_semanas,
                  SUM(ROUND((valor_99food+valor_ifood+valor_outros)*(pct_meu_snap+pct_parceiro_snap)/100,2)
                    - ROUND((valor_99food+valor_ifood+valor_outros)*pct_parceiro_snap/100,2)) AS total_meu
             FROM gd_lancamentos GROUP BY estabelecimento_id
         ) s ON s.estabelecimento_id = e.id
        ORDER BY e.ativo DESC, LOWER(e.nome)`,
      []
    );
    res.json(rows);
  }));

  admin.post('/gestao-delivery/estabelecimentos', handler(async (req, res) => {
    const b = estabelecimentoSchema.parse(req.body);
    const id = await qInsert(
      `INSERT INTO gd_estabelecimentos
        (nome,cliente_id,razao_social,documento_tipo,documento_numero,responsavel,whatsapp,email,cidade,
         pix_tipo,pix_chave,pix_titular,apps,pct_meu,tem_parceiro,parceiro_nome,parceiro_pix,pct_parceiro,inicio_em,observacoes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?::text[],?,?,?,?,?,?,?)`,
      [b.nome, b.cliente_id, b.razao_social, b.documento_tipo, b.documento_numero, b.responsavel, b.whatsapp, b.email,
       b.cidade, b.pix_tipo, b.pix_chave, b.pix_titular, b.apps, b.pct_meu, b.tem_parceiro, b.parceiro_nome,
       b.parceiro_pix, b.pct_parceiro, b.inicio_em, b.observacoes]
    );
    res.status(201).json({ success: true, id });
  }));

  admin.put('/gestao-delivery/estabelecimentos/:id', handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const b = estabelecimentoSchema.parse(req.body);
    await withTx(async (client) => {
      const ant = await txQ1<{ id: number }>(client, 'SELECT id FROM gd_estabelecimentos WHERE id=?', [id]);
      if (!ant) throw httpError(404, 'Estabelecimento não encontrado.');
      await txRun(
        client,
        `UPDATE gd_estabelecimentos SET nome=?,cliente_id=?,razao_social=?,documento_tipo=?,documento_numero=?,responsavel=?,
           whatsapp=?,email=?,cidade=?,pix_tipo=?,pix_chave=?,pix_titular=?,apps=?::text[],pct_meu=?,tem_parceiro=?,
           parceiro_nome=?,parceiro_pix=?,pct_parceiro=?,inicio_em=?,observacoes=?,updated_at=NOW()
         WHERE id=?`,
        [b.nome, b.cliente_id, b.razao_social, b.documento_tipo, b.documento_numero, b.responsavel, b.whatsapp, b.email,
         b.cidade, b.pix_tipo, b.pix_chave, b.pix_titular, b.apps, b.pct_meu, b.tem_parceiro, b.parceiro_nome,
         b.parceiro_pix, b.pct_parceiro, b.inicio_em, b.observacoes, id]
      );
      // Só reescreve semanas ainda NÃO pagas, e só se o admin pediu explicitamente.
      if (b.recalcular_abertas) {
        await txRun(
          client,
          `UPDATE gd_lancamentos SET pct_meu_snap=?, pct_parceiro_snap=?, updated_at=NOW()
            WHERE estabelecimento_id=? AND status <> 'pago'`,
          [b.pct_meu, b.pct_parceiro, id]
        );
      }
    });
    res.json({ success: true });
  }));

  // Arquiva (se tiver histórico) ou exclui (se nunca teve lançamento).
  admin.delete('/gestao-delivery/estabelecimentos/:id', handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const tem = await q1<{ c: number }>('SELECT COUNT(*)::int AS c FROM gd_lancamentos WHERE estabelecimento_id=?', [id]);
    if ((tem?.c ?? 0) > 0) {
      await qRun('UPDATE gd_estabelecimentos SET ativo=FALSE, updated_at=NOW() WHERE id=?', [id]);
      return res.json({ success: true, arquivado: true });
    }
    await qRun('DELETE FROM gd_estabelecimentos WHERE id=?', [id]);
    res.json({ success: true, arquivado: false });
  }));

  admin.post('/gestao-delivery/estabelecimentos/:id/reativar', handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    await qRun('UPDATE gd_estabelecimentos SET ativo=TRUE, updated_at=NOW() WHERE id=?', [id]);
    res.json({ success: true });
  }));

  /* ---------- Lançamentos (tela "Lançar semana") ---------- */

  // Uma linha por estabelecimento ativo, com o lançamento da semana (ou null).
  admin.get('/gestao-delivery/semana', handler(async (req, res) => {
    const ini = weekStartOf(isoDate.parse(String(req.query.inicio || '')));
    const rows = await qAll(
      `SELECT ${EST_COLS},
              (SELECT row_to_json(x) FROM (SELECT ${LANC_COLS} FROM gd_lancamentos l
                 WHERE l.estabelecimento_id = e.id AND l.semana_inicio = ?::date) x) AS lancamento
         FROM gd_estabelecimentos e
        WHERE e.ativo = TRUE
           OR EXISTS (SELECT 1 FROM gd_lancamentos l WHERE l.estabelecimento_id = e.id AND l.semana_inicio = ?::date)
        ORDER BY LOWER(e.nome)`,
      [ini, ini]
    );
    res.json({ semana_inicio: ini, semana_fim: addDays(ini, 6), itens: rows });
  }));

  // Upsert dos valores da semana. Cria com snapshot dos % atuais do estabelecimento.
  admin.put('/gestao-delivery/lancamentos', handler(async (req, res) => {
    const b = lancamentoSchema.parse(req.body);
    const ini = weekStartOf(b.semana_inicio);
    const fim = addDays(ini, 6);
    const est = await q1<{ pct_meu: number; pct_parceiro: number }>(
      'SELECT pct_meu::float8 AS pct_meu, pct_parceiro::float8 AS pct_parceiro FROM gd_estabelecimentos WHERE id=?',
      [b.estabelecimento_id]
    );
    if (!est) return fail(res, 404, 'Estabelecimento não encontrado.');
    const row = await q1(
      `INSERT INTO gd_lancamentos
         (estabelecimento_id,semana_inicio,semana_fim,valor_99food,valor_ifood,valor_outros,pct_meu_snap,pct_parceiro_snap,observacoes)
       VALUES (?,?::date,?::date,?,?,?,?,?,?)
       ON CONFLICT (estabelecimento_id, semana_inicio) DO UPDATE SET
         valor_99food = EXCLUDED.valor_99food, valor_ifood = EXCLUDED.valor_ifood, valor_outros = EXCLUDED.valor_outros,
         observacoes = COALESCE(EXCLUDED.observacoes, gd_lancamentos.observacoes), updated_at = NOW()
       RETURNING id`,
      [b.estabelecimento_id, ini, fim, b.valor_99food, b.valor_ifood, b.valor_outros, est.pct_meu, est.pct_parceiro,
       b.observacoes ?? null]
    );
    const l = await q1(`SELECT ${LANC_COLS} FROM gd_lancamentos l WHERE l.id=?`, [(row as any).id]);
    res.json({ success: true, lancamento: l });
  }));

  admin.patch('/gestao-delivery/lancamentos/:id', handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const b = lancamentoPatchSchema.parse(req.body);
    const atual = await q1<{ status: string }>('SELECT status FROM gd_lancamentos WHERE id=?', [id]);
    if (!atual) return fail(res, 404, 'Lançamento não encontrado.');

    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => { sets.push(`${col}=?`); vals.push(v); };

    if (b.status !== undefined) {
      add('status', b.status);
      if (b.status === 'pago') add('data_pagamento', b.data_pagamento ?? new Date().toLocaleDateString('en-CA', { timeZone: TZ }));
      else add('data_pagamento', null);
      if (b.status !== 'pago') { add('repasse_pago', false); add('repasse_data', null); } // voltou atrás: repasse também
    } else if (b.data_pagamento !== undefined) add('data_pagamento', b.data_pagamento);

    if (b.repasse_pago !== undefined) {
      add('repasse_pago', b.repasse_pago);
      add('repasse_data', b.repasse_pago ? b.repasse_data ?? new Date().toLocaleDateString('en-CA', { timeZone: TZ }) : null);
    }
    if (b.observacoes !== undefined) add('observacoes', b.observacoes);
    if (b.pct_meu_snap !== undefined) add('pct_meu_snap', b.pct_meu_snap);
    if (b.pct_parceiro_snap !== undefined) add('pct_parceiro_snap', b.pct_parceiro_snap);
    if (!sets.length) return fail(res, 400, 'Nada para atualizar.');

    await qRun(`UPDATE gd_lancamentos SET ${sets.join(', ')}, updated_at=NOW() WHERE id=?`, [...vals, id]);
    const l = await q1(`SELECT ${LANC_COLS} FROM gd_lancamentos l WHERE l.id=?`, [id]);
    res.json({ success: true, lancamento: l });
  }));

  // Restaurante pagou várias semanas de uma vez (um PIX só): marca em lote.
  admin.post('/gestao-delivery/lancamentos/pagar-lote', handler(async (req, res) => {
    const b = z.object({
      ids: z.array(z.coerce.number().int().positive()).min(1).max(200),
      data_pagamento: isoDate.optional(),
    }).parse(req.body);
    const data = b.data_pagamento ?? new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    const rows = await qRun(
      `UPDATE gd_lancamentos SET status='pago', data_pagamento=?::date, updated_at=NOW()
        WHERE id = ANY(?::int[]) AND status <> 'pago' RETURNING id`,
      [data, b.ids]
    );
    res.json({ success: true, atualizados: rows.length });
  }));

  // Fecha a semana: em andamento -> aguardando pagamento (pronto para cobrar).
  admin.post('/gestao-delivery/semanas/:inicio/fechar', handler(async (req, res) => {
    const ini = weekStartOf(isoDate.parse(req.params.inicio));
    const rows = await qRun(
      `UPDATE gd_lancamentos SET status='aguardando', updated_at=NOW()
        WHERE semana_inicio=?::date AND status='em_andamento'
          AND (valor_99food + valor_ifood + valor_outros) > 0
        RETURNING id`,
      [ini]
    );
    res.json({ success: true, fechados: rows.length });
  }));

  admin.delete('/gestao-delivery/lancamentos/:id', handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const l = await q1<{ status: string }>('SELECT status FROM gd_lancamentos WHERE id=?', [id]);
    if (!l) return fail(res, 404, 'Lançamento não encontrado.');
    if (l.status === 'pago') return fail(res, 409, 'Lançamento já pago. Volte o status antes de excluir.');
    await qRun('DELETE FROM gd_lancamentos WHERE id=?', [id]);
    res.json({ success: true });
  }));

  // Planilha: todos os lançamentos de todos os restaurantes, juntos (a tela filtra no navegador).
  admin.get('/gestao-delivery/lancamentos', handler(async (_req, res) => {
    const rows = await qAll(
      `SELECT ${LANC_COLS}, e.nome, e.tem_parceiro, e.parceiro_nome, e.ativo
         FROM gd_lancamentos l JOIN gd_estabelecimentos e ON e.id = l.estabelecimento_id
        ORDER BY l.semana_inicio DESC, LOWER(e.nome) LIMIT 3000`,
      []
    );
    res.json(rows);
  }));

  // Todas as semanas de um estabelecimento (usado para cobrar/baixar várias de uma vez).
  admin.get('/gestao-delivery/estabelecimentos/:id/lancamentos', handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const rows = await qAll(
      `SELECT ${LANC_COLS} FROM gd_lancamentos l WHERE l.estabelecimento_id=? ORDER BY l.semana_inicio DESC LIMIT 120`, [id]
    );
    res.json(rows);
  }));

  /* ---------- Resumo (dashboard da gestão) ---------- */

  admin.get('/gestao-delivery/resumo', handler(async (req, res) => {
    const semanaQ = String(req.query.semana || 'todas');
    const estId = req.query.estabelecimento ? z.coerce.number().int().positive().parse(req.query.estabelecimento) : null;
    const semana = semanaQ === 'todas' ? null : weekStartOf(isoDate.parse(semanaQ));

    // filtros opcionais (sempre com tipos explícitos p/ o Postgres inferir)
    const F = `(?::date IS NULL OR l.semana_inicio = ?::date) AND (?::int IS NULL OR l.estabelecimento_id = ?::int)`;
    const fp = [semana, semana, estId, estId];

    const totalsSql = `
      SELECT COALESCE(SUM(base),0)::float8 AS gerenciado,
             COALESCE(SUM(comissao),0)::float8 AS comissao_bruta,
             COALESCE(SUM(repasse),0)::float8 AS repasse_parceiro,
             COALESCE(SUM(meu),0)::float8 AS meu_liquido,
             COALESCE(SUM(meu) FILTER (WHERE status='pago'),0)::float8 AS recebido,
             COALESCE(SUM(meu) FILTER (WHERE status='aguardando'),0)::float8 AS a_receber,
             COALESCE(SUM(meu) FILTER (WHERE status='em_andamento'),0)::float8 AS em_andamento,
             COALESCE(SUM(repasse) FILTER (WHERE NOT repasse_pago AND status IN ('aguardando','pago')),0)::float8 AS repasse_a_pagar
        FROM (SELECT l.status, l.repasse_pago, ${CALC_N} FROM gd_lancamentos l WHERE ${F}) t`;

    const porEstSql = `
      SELECT e.id AS estabelecimento_id, e.nome, e.ativo, e.tem_parceiro,
             e.pct_meu::float8 AS pct_meu, e.pct_parceiro::float8 AS pct_parceiro,
             COALESCE(SUM(t.base),0)::float8 AS gerenciado,
             COALESCE(SUM(t.comissao),0)::float8 AS comissao_bruta,
             COALESCE(SUM(t.repasse),0)::float8 AS repasse_parceiro,
             COALESCE(SUM(t.meu),0)::float8 AS meu_liquido,
             COALESCE(SUM(t.meu) FILTER (WHERE t.status='pago'),0)::float8 AS recebido,
             COALESCE(SUM(t.meu) FILTER (WHERE t.status='aguardando'),0)::float8 AS a_receber,
             COALESCE(SUM(t.meu) FILTER (WHERE t.status='em_andamento'),0)::float8 AS em_andamento,
             COALESCE(SUM(t.repasse) FILTER (WHERE NOT t.repasse_pago AND t.status IN ('aguardando','pago')),0)::float8 AS repasse_a_pagar,
             CASE WHEN COUNT(*) FILTER (WHERE t.status='aguardando') > 0 THEN 'aguardando'
                  WHEN COUNT(*) FILTER (WHERE t.status='em_andamento') > 0 THEN 'em_andamento'
                  WHEN COUNT(t.*) > 0 THEN 'pago' ELSE 'sem_lancamento' END AS status
        FROM gd_estabelecimentos e
        LEFT JOIN (SELECT l.estabelecimento_id, l.status, l.repasse_pago, ${CALC_N}
                     FROM gd_lancamentos l WHERE ${F}) t ON t.estabelecimento_id = e.id
       WHERE (?::int IS NULL OR e.id = ?::int) AND (e.ativo OR t.estabelecimento_id IS NOT NULL)
       GROUP BY e.id ORDER BY meu_liquido DESC, LOWER(e.nome)`;

    const semanasSql = `
      SELECT semana_inicio::text AS semana_inicio, semana_fim::text AS semana_fim,
             SUM(base)::float8 AS gerenciado, SUM(comissao)::float8 AS comissao_bruta,
             SUM(repasse)::float8 AS repasse_parceiro, SUM(meu)::float8 AS meu_liquido,
             SUM(meu) FILTER (WHERE status='pago')::float8 AS recebido,
             COUNT(*) FILTER (WHERE status='aguardando')::int AS n_aguardando,
             COUNT(*) FILTER (WHERE status='em_andamento')::int AS n_andamento,
             COUNT(*)::int AS n,
             json_agg(json_build_object('estabelecimento_id', estabelecimento_id, 'meu', meu, 'status', status)) AS por_estabelecimento
        FROM (SELECT l.semana_inicio, l.semana_fim, l.estabelecimento_id, l.status, ${CALC_N}
                FROM gd_lancamentos l WHERE (?::int IS NULL OR l.estabelecimento_id = ?::int)) t
       GROUP BY semana_inicio, semana_fim ORDER BY semana_inicio DESC LIMIT 60`;

    const alertasSql = `
      SELECT 'atrasado' AS tipo, e.nome, l.semana_inicio::text AS semana_inicio,
             ((${TODAY_SQL}) - l.semana_fim)::int AS dias, t.meu
        FROM gd_lancamentos l
        JOIN gd_estabelecimentos e ON e.id = l.estabelecimento_id
        JOIN LATERAL (SELECT ${CALC.replace(/\bl\./g, 'x.')} FROM gd_lancamentos x WHERE x.id = l.id) t ON TRUE
       WHERE l.status='aguardando' AND (${TODAY_SQL}) - l.semana_fim > 7
      UNION ALL
      SELECT 'fechar_semana', e.nome, l.semana_inicio::text, ((${TODAY_SQL}) - l.semana_fim)::int, NULL
        FROM gd_lancamentos l JOIN gd_estabelecimentos e ON e.id = l.estabelecimento_id
       WHERE l.status='em_andamento' AND l.semana_fim < ${TODAY_SQL}
      UNION ALL
      SELECT 'sem_lancamento', e.nome, (date_trunc('week', ${TODAY_SQL}::timestamp)::date - 7)::text,
             NULL, NULL
        FROM gd_estabelecimentos e
       WHERE e.ativo AND (e.inicio_em IS NULL OR e.inicio_em <= date_trunc('week', ${TODAY_SQL}::timestamp)::date - 1)
         AND NOT EXISTS (SELECT 1 FROM gd_lancamentos l
                          WHERE l.estabelecimento_id = e.id
                            AND l.semana_inicio = date_trunc('week', ${TODAY_SQL}::timestamp)::date - 7)
       ORDER BY 1, 5 DESC NULLS LAST`;

    const [totais, porEst, semanas, alertas] = await Promise.all([
      q1(totalsSql, fp),
      qAll(porEstSql, [...fp, estId, estId]),
      qAll(semanasSql, [estId, estId]),
      qAll(alertasSql, []),
    ]);

    const semanasList = await qAll(
      `SELECT DISTINCT semana_inicio::text AS semana_inicio, semana_fim::text AS semana_fim FROM gd_lancamentos ORDER BY 1 DESC`, []
    );
    res.json({ filtro: { semana: semana ?? 'todas', estabelecimento: estId }, totais, por_estabelecimento: porEst,
               semanas, semanas_disponiveis: semanasList, alertas });
  }));

  /* ---------- Ganhos gerais (software + gestão de delivery) ---------- */

  admin.get('/ganhos', handler(async (req, res) => {
    const meses = z.coerce.number().int().min(1).max(24).catch(6).parse(req.query.meses);
    const lancMeu = `ROUND((valor_99food+valor_ifood+valor_outros)*(pct_meu_snap+pct_parceiro_snap)/100,2)
                     - ROUND((valor_99food+valor_ifood+valor_outros)*pct_parceiro_snap/100,2)`;
    const [serie, mrr, inadimplentes, aVencer, delivery, topClientes] = await Promise.all([
      qAll(
        `WITH m AS (
           SELECT to_char(d,'YYYY-MM') AS mes
             FROM generate_series(
               date_trunc('month', (NOW() AT TIME ZONE '${TZ}')) - make_interval(months => ?::int - 1),
               date_trunc('month', (NOW() AT TIME ZONE '${TZ}')), interval '1 month') d)
         SELECT m.mes,
           COALESCE((SELECT SUM(valor) FROM renovacoes r
                      WHERE r.origem IS DISTINCT FROM 'edicao'
                        AND to_char(r.data_pagamento AT TIME ZONE '${TZ}','YYYY-MM') = m.mes),0)::float8 AS software_recebido,
           COALESCE((SELECT SUM(${lancMeu}) FROM gd_lancamentos
                      WHERE status='pago' AND to_char(COALESCE(data_pagamento, semana_fim),'YYYY-MM') = m.mes),0)::float8 AS delivery_recebido,
           COALESCE((SELECT SUM(${lancMeu}) FROM gd_lancamentos
                      WHERE to_char(semana_fim,'YYYY-MM') = m.mes),0)::float8 AS delivery_competencia
         FROM m ORDER BY m.mes`,
        [meses]
      ),
      q1(
        `SELECT COALESCE(SUM(valor_plano),0)::float8 AS mrr, COUNT(*)::int AS pagantes
           FROM clientes WHERE status='ativo' AND (trial_fim IS NULL OR trial_fim < NOW()) AND COALESCE(valor_plano,0) > 0`, []
      ),
      qAll(
        `SELECT id, nome_estabelecimento, whatsapp, plano, valor_plano::float8 AS valor_plano, vencimento,
                (${TODAY_SQL} - (vencimento AT TIME ZONE '${TZ}')::date)::int AS dias_atraso
           FROM clientes WHERE status='ativo' AND COALESCE(valor_plano,0) > 0
            AND (trial_fim IS NULL OR trial_fim < NOW()) AND vencimento IS NOT NULL AND vencimento < NOW()
          ORDER BY vencimento`, []
      ),
      qAll(
        `SELECT id, nome_estabelecimento, whatsapp, plano, valor_plano::float8 AS valor_plano, vencimento,
                CEIL(EXTRACT(EPOCH FROM (vencimento - NOW())) / 86400)::int AS dias
           FROM clientes WHERE status='ativo' AND COALESCE(valor_plano,0) > 0
            AND vencimento >= NOW() AND vencimento <= NOW() + INTERVAL '7 days' ORDER BY vencimento`, []
      ),
      q1(
        `SELECT COALESCE(SUM(${lancMeu}) FILTER (WHERE status='aguardando'),0)::float8 AS a_receber,
                COALESCE(SUM(${lancMeu}) FILTER (WHERE status='em_andamento'),0)::float8 AS em_andamento,
                COALESCE(SUM(ROUND((valor_99food+valor_ifood+valor_outros)*pct_parceiro_snap/100,2))
                         FILTER (WHERE NOT repasse_pago AND status IN ('aguardando','pago')),0)::float8 AS repasse_a_pagar
           FROM gd_lancamentos`, []
      ),
      qAll(
        `SELECT e.nome, SUM(${lancMeu.replace(/valor_/g, 'l.valor_').replace(/pct_/g, 'l.pct_')})::float8 AS meu_liquido
           FROM gd_lancamentos l JOIN gd_estabelecimentos e ON e.id = l.estabelecimento_id
          WHERE l.semana_fim >= (${TODAY_SQL} - 90) GROUP BY e.nome ORDER BY 2 DESC LIMIT 5`, []
      ),
    ]);

    const mesAtual = serie[serie.length - 1] ?? { software_recebido: 0, delivery_recebido: 0, delivery_competencia: 0 };
    const mrrV = (mrr as any)?.mrr ?? 0;
    const d = (delivery as any) ?? { a_receber: 0, em_andamento: 0, repasse_a_pagar: 0 };

    res.json({
      meses: serie.map((r: any) => ({ ...r, total_recebido: +(r.software_recebido + r.delivery_recebido).toFixed(2) })),
      software: {
        mrr: mrrV, pagantes: (mrr as any)?.pagantes ?? 0,
        inadimplentes, inadimplencia_total: inadimplentes.reduce((s: number, c: any) => s + (c.valor_plano || 0), 0),
        a_vencer_7d: aVencer,
      },
      delivery: { ...d, top_90d: topClientes },
      mes_atual: {
        recebido: +(mesAtual.software_recebido + mesAtual.delivery_recebido).toFixed(2),
        previsto: +(mrrV + mesAtual.delivery_competencia).toFixed(2),
      },
      a_receber_total: +(d.a_receber + d.em_andamento + inadimplentes.reduce((s: number, c: any) => s + (c.valor_plano || 0), 0)).toFixed(2),
    });
  }));

  /* ---------- Software: registrar pagamento da mensalidade ---------- */

  // Substitui "editar vencimento na mão": grava o pagamento de verdade (valor, forma, data)
  // e estende o vencimento a partir do maior entre hoje e o vencimento atual.
  admin.post('/gestao-delivery/software/:clienteId/pagamento', handler(async (req, res) => {
    const clienteId = z.coerce.number().int().positive().parse(req.params.clienteId);
    const b = z.object({
      valor: money.optional(),
      dias: z.coerce.number().int().min(1).max(366).default(30),
      forma: optText(40).optional(),
      data_pagamento: isoDate.optional(),
      observacoes: optText(500).optional(),
    }).parse(req.body);

    const novo = await withTx(async (client) => {
      const c = await txQ1<{ plano: string; valor_plano: number; vencimento: string | null }>(
        client, 'SELECT plano, valor_plano::float8 AS valor_plano, vencimento FROM clientes WHERE id=?', [clienteId]
      );
      if (!c) throw httpError(404, 'Cliente não encontrado.');
      const base = c.vencimento && new Date(c.vencimento) > new Date() ? new Date(c.vencimento) : new Date();
      base.setDate(base.getDate() + b.dias);
      await txRun(
        client,
        `INSERT INTO renovacoes (cliente_id,plano,valor,data_pagamento,vencimento_anterior,novo_vencimento,forma_pagamento,observacoes,origem)
         VALUES (?,?,?,COALESCE(?::date, NOW()),?,?,?,?,'pagamento')`,
        [clienteId, c.plano, b.valor ?? c.valor_plano ?? 0, b.data_pagamento ?? null, c.vencimento, base.toISOString(),
         b.forma ?? null, b.observacoes ?? null]
      );
      await txRun(client, "UPDATE clientes SET vencimento=?, status='ativo' WHERE id=?", [base.toISOString(), clienteId]);
      return base.toISOString();
    });
    invalidateTenantPlanCache(String(clienteId));
    res.json({ success: true, novo_vencimento: novo });
  }));
}
