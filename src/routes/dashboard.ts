// src/routes/dashboard.ts
import { Router, Request } from 'express';
import { q1, qAll, qRun } from '../db';
import { getTenantFeatures } from '../services/tenantPlan';
import { getCommercialInsightsSnapshot } from '../services/commercialInsightsService';
import { sendInternalError } from '../utils/internalServerError';

const TZ = 'America/Sao_Paulo';

function getTodayDateInTimeZone() {
  const today = new Date().toLocaleString('en-US', { timeZone: TZ }).split(',')[0];
  const date = new Date(today);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function buildPeriodFilter(req: Request, column = 'created_at') {
  const { day, month, year, range } = req.query;
  const dateExpr = `(${column} AT TIME ZONE '${TZ}')`;
  const params: any[] = [req.tenantId];

  if (range === 'today') {
    return {
      clause: `WHERE tenant_id=? AND ${dateExpr}::date = (NOW() AT TIME ZONE '${TZ}')::date`,
      params,
    };
  }

  if (range === 'week') {
    return {
      clause: `WHERE tenant_id=? AND ${dateExpr}::date >= (NOW() AT TIME ZONE '${TZ}')::date - INTERVAL '6 days'`,
      params,
    };
  }

  if (range === 'month') {
    return {
      clause: `WHERE tenant_id=? AND TO_CHAR(${dateExpr},'MM')=TO_CHAR(NOW() AT TIME ZONE '${TZ}','MM') AND TO_CHAR(${dateExpr},'YYYY')=TO_CHAR(NOW() AT TIME ZONE '${TZ}','YYYY')`,
      params,
    };
  }

  if (range === 'all') {
    return {
      clause: `WHERE tenant_id=?`,
      params,
    };
  }

  if (day && month && year) {
    params.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    return {
      clause: `WHERE tenant_id=? AND ${dateExpr}::date = ?`,
      params,
    };
  }

  if (month && year) {
    params.push(String(month).padStart(2, '0'), String(year));
    return {
      clause: `WHERE tenant_id=? AND TO_CHAR(${dateExpr},'MM')=? AND TO_CHAR(${dateExpr},'YYYY')=?`,
      params,
    };
  }

  if (year) {
    params.push(String(year));
    return {
      clause: `WHERE tenant_id=? AND TO_CHAR(${dateExpr},'YYYY')=?`,
      params,
    };
  }

  return {
    clause: `WHERE tenant_id=? AND ${dateExpr}::date = (NOW() AT TIME ZONE '${TZ}')::date`,
    params,
  };
}

async function getOpenCaixa(req: Request) {
  const dateStr = getTodayDateInTimeZone();
  let caixa = await q1("SELECT * FROM caixa WHERE data=? AND status='aberto' AND tenant_id=?", [dateStr, req.tenantId]);

  if (!caixa) {
    caixa = await q1("SELECT * FROM caixa WHERE status='aberto' AND tenant_id=? ORDER BY data DESC LIMIT 1", [req.tenantId]);
  }

  return caixa;
}

/**
 * Soma as vendas em dinheiro (amount_paid - change_given) restritas à JANELA da sessão
 * de caixa atual: do momento em que ESTE caixa foi aberto (created_at) até agora.
 *
 * Importante: isso é diferente de filtrar por dia inteiro. Como pode haver várias
 * aberturas/fechamentos de caixa no mesmo dia (ex: abre de manhã, fecha, abre pro
 * almoço, fecha de novo), filtrar só pela data do caixa somava as vendas do dia
 * TODO, inclusive de sessões já fechadas anteriormente — fazendo o "Total Esperado"
 * do fechamento da tarde já vir com o dinheiro da manhã embutido.
 */
async function getSessionCashSales(caixa: any, tenantId: any) {
  const row = await q1(
    `SELECT COALESCE(SUM(amount_paid-change_given),0) as total
     FROM pagamentos
     WHERE method='Dinheiro' AND tenant_id=? AND created_at >= ? AND created_at <= COALESCE(?, NOW())`,
    [tenantId, caixa.created_at, caixa.closed_at]
  );
  return Number(row?.total || 0);
}

async function getSessionTotals(caixa: any, tenantId: any) {
  const [pd, dd] = await Promise.all([
    q1(
      `SELECT COALESCE(SUM(amount_paid),0) as total FROM pagamentos
       WHERE tenant_id=? AND created_at >= ? AND created_at <= COALESCE(?, NOW())`,
      [tenantId, caixa.created_at, caixa.closed_at]
    ),
    q1(
      `SELECT COALESCE(SUM(amount),0) as total FROM despesas
       WHERE tenant_id=? AND created_at >= ? AND created_at <= COALESCE(?, NOW())`,
      [tenantId, caixa.created_at, caixa.closed_at]
    ),
  ]);
  return { total_vendas: Number(pd?.total || 0), total_despesas: Number(dd?.total || 0) };
}

/** Rotas de caixa (abrir/fechar/hoje/histórico). Usado em `/api/caixa` e, por compatibilidade, também em `/api/dashboard`. */
function registerCaixaRoutes(router: Router) {
  const getCaixaHandler = async (req: Request, res: any) => {
    const caixa = await getOpenCaixa(req);
    if (!caixa) return res.json({ status: 'fechado' });

    const [{ total_vendas, total_despesas }, totalVendasDinheiro] = await Promise.all([
      getSessionTotals(caixa, req.tenantId),
      getSessionCashSales(caixa, req.tenantId),
    ]);
    const fundo = Number(caixa.fundo_inicial || 0);

    return res.json({
      ...caixa,
      total_vendas,
      total_despesas,
      total_vendas_dinheiro: totalVendasDinheiro,
      total_esperado: fundo + totalVendasDinheiro,
    });
  };

  router.get('/caixa', getCaixaHandler);
  router.get('/hoje', getCaixaHandler);

  const openCaixaHandler = async (req: Request, res: any) => {
    const { fundo_inicial, observacao } = req.body;
    const dateStr = getTodayDateInTimeZone();

    const ex = await q1("SELECT * FROM caixa WHERE data=? AND status='aberto' AND tenant_id=?", [dateStr, req.tenantId]);
    if (ex) return res.status(400).json({ success: false, message: 'Ja existe um caixa aberto hoje.' });

    await qRun(
      "INSERT INTO caixa (data,fundo_inicial,observacao,status,tenant_id) VALUES (?,?,?,'aberto',?)",
      [dateStr, fundo_inicial, observacao, req.tenantId]
    );

    return res.json({ success: true });
  };

  router.post('/abrir-caixa', openCaixaHandler);
  router.post('/abrir', openCaixaHandler);

  const closeCaixaHandler = async (req: Request, res: any) => {
    const { valor_contado, observacao } = req.body;

    const caixa = await getOpenCaixa(req);
    if (!caixa) return res.status(400).json({ success: false, message: 'Nenhum caixa aberto encontrado.' });

    // Fecha a janela da sessão em NOW() antes de somar, e usa esse mesmo instante
    // no UPDATE abaixo, para que o valor calculado e o `closed_at` gravado sejam
    // exatamente da mesma sessão (evita pegar vendas de uma sessão futura/anterior).
    const fundo = Number(caixa.fundo_inicial || 0);
    const totalVD = await getSessionCashSales(caixa, req.tenantId);
    const totalEsperado = fundo + totalVD;
    const diferenca = Number(valor_contado) - totalEsperado;

    await qRun(
      `UPDATE caixa
       SET valor_contado=?, status='fechado', observacao=?, closed_at=NOW(),
           total_vendas_dinheiro=?, total_esperado=?, diferenca=?
       WHERE id=? AND tenant_id=?`,
      [valor_contado, observacao || caixa.observacao, totalVD, totalEsperado, diferenca, caixa.id, req.tenantId]
    );

    return res.json({
      success: true,
      total_vendas_dinheiro: totalVD,
      total_esperado: totalEsperado,
      diferenca,
    });
  };

  router.post('/fechar-caixa', closeCaixaHandler);
  router.post('/fechar', closeCaixaHandler);

  router.get('/historico', async (req: Request, res) => {
    const history = await qAll(
      `SELECT * FROM caixa c WHERE c.tenant_id=? ORDER BY c.data DESC, c.created_at DESC LIMIT 30`,
      [req.tenantId]
    );

    // Caixas já fechados têm total_vendas_dinheiro/total_esperado/diferenca gravados
    // no momento do fechamento (janela exata daquela sessão). Caixas ainda abertos
    // (não deveria ter mais de um, mas por segurança) calculam ao vivo pela mesma janela.
    const enriched = await Promise.all(
      history.map(async (h: any) => {
        const fundo = Number(h.fundo_inicial || 0);

        if (h.status === 'aberto') {
          const totalVD = await getSessionCashSales(h, req.tenantId);
          return {
            ...h,
            fundo_inicial: fundo,
            valor_contado: Number(h.valor_contado || 0),
            total_vendas_dinheiro: totalVD,
            total_esperado: fundo + totalVD,
            diferenca: 0,
          };
        }

        return {
          ...h,
          fundo_inicial: fundo,
          valor_contado: Number(h.valor_contado || 0),
          total_vendas_dinheiro: Number(h.total_vendas_dinheiro || 0),
          total_esperado: Number(h.total_esperado ?? fundo),
          diferenca: Number(h.diferenca || 0),
        };
      })
    );

    res.json(enriched);
  });
}

/** Apenas caixa: montado em `/api/caixa` (plan feature `caixa`, permissão `finance`). */
export function createCaixaRouter() {
  const router = Router();
  registerCaixaRoutes(router);
  return router;
}

export function createDashboardRouter() {
  const router = Router();

  router.get('/commercial-insights', async (req: Request, res) => {
    try {
      const tenantId = Number(req.tenantId);
      const features = await getTenantFeatures(tenantId);
      const snapshot = await getCommercialInsightsSnapshot({ tenantId, features });
      res.json(snapshot);
    } catch (e: any) {
      sendInternalError(res, 'routes/dashboard/commercial-insights', e);
    }
  });

  router.get('/stats', async (req: Request, res) => {
    try {
      const ordersFilter = buildPeriodFilter(req, 'created_at');
      const refundsFilter = buildPeriodFilter(req, 'reembolsado_at');
      const expensesFilter = buildPeriodFilter(req, 'created_at');
      const activeOrdersClause = `${ordersFilter.clause} AND status != 'Cancelado'`;

      const pedidosJoinFilter = buildPeriodFilter(req, 'p.created_at');
      const pedidosItemSalesWhere =
        `${pedidosJoinFilter.clause.replace(/^WHERE tenant_id=\?/, 'WHERE p.tenant_id=?')} AND p.status != 'Cancelado'`;

      const [today, week, monthTotal, filteredTotal, refundedTotal, totalExpenses, productSalesRows] = await Promise.all([
        q1(`SELECT COUNT(*) as pedidos, COALESCE(SUM(total_amount),0) as faturamento FROM pedidos WHERE tenant_id=? AND (created_at AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date AND status != 'Cancelado'`, [req.tenantId]),
        q1(`SELECT COUNT(*) as pedidos, COALESCE(SUM(total_amount),0) as faturamento FROM pedidos WHERE tenant_id=? AND (created_at AT TIME ZONE '${TZ}')::date >= (NOW() AT TIME ZONE '${TZ}')::date - INTERVAL '6 days' AND status != 'Cancelado'`, [req.tenantId]),
        q1(`SELECT COUNT(*) as pedidos, COALESCE(SUM(total_amount),0) as faturamento FROM pedidos WHERE tenant_id=? AND TO_CHAR(created_at AT TIME ZONE '${TZ}','MM')=TO_CHAR(NOW() AT TIME ZONE '${TZ}','MM') AND TO_CHAR(created_at AT TIME ZONE '${TZ}','YYYY')=TO_CHAR(NOW() AT TIME ZONE '${TZ}','YYYY') AND status != 'Cancelado'`, [req.tenantId]),
        q1(`SELECT COUNT(*) as pedidos, COALESCE(SUM(total_amount),0) as faturamento FROM pedidos ${activeOrdersClause}`, ordersFilter.params),
        q1(
          `SELECT COALESCE(SUM(valor_reembolsado),0) as total
           FROM pedidos
           ${refundsFilter.clause}
             AND COALESCE(reembolso_status,'nenhum') != 'nenhum'
             AND COALESCE(valor_reembolsado,0) > 0`,
          refundsFilter.params
        ),
        q1(`SELECT COALESCE(SUM(amount),0) as v FROM despesas ${expensesFilter.clause}`, expensesFilter.params),
        qAll(
          `SELECT COALESCE(MAX(pr.name), 'Produto') AS name,
                  SUM(ip.quantity) AS quantity,
                  COALESCE(SUM(ip.quantity * ip.price_at_time), 0) AS total
             FROM itens_pedido ip
             INNER JOIN pedidos p ON p.id = ip.order_id AND p.tenant_id = ip.tenant_id
             LEFT JOIN produtos pr ON pr.id = ip.product_id AND pr.tenant_id = ip.tenant_id
             ${pedidosItemSalesWhere}
             GROUP BY ip.product_id
             ORDER BY SUM(ip.quantity) DESC
             LIMIT 12`,
          pedidosJoinFilter.params
        ),
      ]);

      const totalPedidos = Number(filteredTotal?.pedidos || 0);
      const receitaOperacional = Number(filteredTotal?.faturamento || 0);
      const totalRefunded = Number(refundedTotal?.total || 0);
      const netRevenue = receitaOperacional - totalRefunded;
      const totalExpensesValue = Number(totalExpenses?.v || 0);

      res.json({
        hoje: { pedidos: Number(today?.pedidos || 0), faturamento: Number(today?.faturamento || 0) },
        semana: { pedidos: Number(week?.pedidos || 0), faturamento: Number(week?.faturamento || 0) },
        mes: { pedidos: Number(monthTotal?.pedidos || 0), faturamento: Number(monthTotal?.faturamento || 0) },
        totalFiltrado: { pedidos: totalPedidos, faturamento: receitaOperacional },
        despesas: totalExpensesValue,
        today: Number(today?.faturamento || 0),
        week: Number(week?.faturamento || 0),
        month: Number(monthTotal?.faturamento || 0),
        filteredTotal: receitaOperacional,
        totalPedidos,
        ticketMedio: totalPedidos > 0 ? receitaOperacional / totalPedidos : 0,
        totalExpenses: totalExpensesValue,
        totalRefunded,
        netRevenue,
        totalRepassesPagos: 0,
        productSales: (productSalesRows || []).map((r: any) => ({
          name: String(r.name || 'Produto'),
          quantity: Number(r.quantity || 0),
          total: Number(r.total || 0),
        })),
      });
    } catch (e: any) {
      sendInternalError(res, 'routes/dashboard', e);
    }
  });

  router.get('/weekly', async (req: Request, res) => {
    try {
      const rows = await qAll(
        `SELECT
           TO_CHAR((created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') as dia,
           COUNT(*) as pedidos,
           COALESCE(SUM(total_amount),0) as total
         FROM pedidos
         WHERE tenant_id=?
           AND status != 'Cancelado'
           AND (created_at AT TIME ZONE '${TZ}')::date >= (NOW() AT TIME ZONE '${TZ}')::date - INTERVAL '6 days'
         GROUP BY 1
         ORDER BY 1 ASC`,
        [req.tenantId]
      );

      const rowMap = new Map(
        rows.map((row: any) => [
          row.dia,
          {
            pedidos: Number(row.pedidos || 0),
            total: Number(row.total || 0),
          },
        ])
      );

      const baseDate = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
      baseDate.setHours(0, 0, 0, 0);

      const result = Array.from({ length: 7 }, (_, index) => {
        const date = new Date(baseDate);
        date.setDate(baseDate.getDate() - (6 - index));

        const dia = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        const row = rowMap.get(dia);

        return {
          dia,
          label: date.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', ''),
          pedidos: row?.pedidos ?? 0,
          total: row?.total ?? 0,
        };
      });

      res.json(result);
    } catch (e: any) {
      sendInternalError(res, 'routes/dashboard', e);
    }
  });

  router.get('/cash-report', async (req: Request, res) => {
    try {
      const paymentsFilter = buildPeriodFilter(req, 'created_at');
      const totals = await q1(
        `SELECT
           COALESCE(SUM(
             CASE
               WHEN LOWER(COALESCE(method,'')) = 'dinheiro'
               THEN amount_paid - COALESCE(change_given,0)
               ELSE amount_paid
             END
           ),0) as total,
           COALESCE(SUM(
             CASE
               WHEN LOWER(COALESCE(method,'')) = 'dinheiro'
               THEN amount_paid - COALESCE(change_given,0)
               ELSE 0
             END
           ),0) as cash,
           COALESCE(SUM(CASE WHEN LOWER(COALESCE(method,'')) = 'pix' THEN amount_paid ELSE 0 END),0) as pix,
           COALESCE(SUM(CASE WHEN LOWER(COALESCE(method,'')) IN ('debito','débito') THEN amount_paid ELSE 0 END),0) as debit,
           COALESCE(SUM(CASE WHEN LOWER(COALESCE(method,'')) IN ('credito','crédito') THEN amount_paid ELSE 0 END),0) as credit
         FROM pagamentos
         ${paymentsFilter.clause}`,
        paymentsFilter.params
      );

      res.json({
        total: Number(totals?.total || 0),
        cash: Number(totals?.cash || 0),
        pix: Number(totals?.pix || 0),
        debit: Number(totals?.debit || 0),
        credit: Number(totals?.credit || 0),
      });
    } catch (e: any) {
      sendInternalError(res, 'routes/dashboard', e);
    }
  });

  registerCaixaRoutes(router);

  return router;
}
