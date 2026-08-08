// src/routes/mesas.ts — mesas, comandas e sincronização KDS
import { Router, Request } from 'express';
import { q1, qAll, qRun, qInsert, withTx, txQ1, txQAll, txRun, txInsert } from '../db';
import { pool } from '../db/pool';
import { requireProductInventoryTargets } from '../services/stockIdentification';
import { isAppError } from '../utils/errors';
import { logError } from '../utils/logger';
import { INTERNAL_SERVER_MESSAGE, sendInternalError } from '../utils/internalServerError';
import {
  buildMesaComandaPayload as buildMesaComandaPayloadShared,
  buildMesaFinanceSnapshot as buildMesaFinanceSnapshotShared,
  buildMesaReceiptTotals as buildMesaReceiptTotalsShared,
  normalizeComandaExtras as normalizeComandaExtrasShared,
} from '../utils/mesaFinance';
import { getProfilePaperWidthMm } from '../utils/printProfiles';
import { gerarCupomHtml } from '../utils/printTemplates';
import { resolveRequiresPreparation } from '../utils/preparation';
import { addItemToMesaComanda } from '../services/ordersService';
import { buildKitchenReceiptHtml, filterKitchenPreparationItems } from '../services/kitchenPrintService';
import { parseAutomationFromDeliveryConfigJson } from '../services/automationConfig';
import { runAutomatedKitchenPrintForMesa } from '../services/operationalAutomationService';
import { tenantHasInventoryFeature } from '../services/tenantPlan';
import { notifyTenantOrderStreams } from '../sse';
import { coerceDeliveryConfigRow } from '../utils/deliveryConfigPersist';
import { signGarcomTempToken } from '../middleware';

const TZ = 'America/Sao_Paulo';

type ComandaExtrasInput = import('../utils/mesaFinance').ComandaExtrasInput;
type MesaFinanceSnapshot = import('../utils/mesaFinance').MesaFinanceSnapshot;
type ComandaTotals = Omit<MesaFinanceSnapshot, 'subtotal'>;

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFlag(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'sim', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'nao', 'não', 'no', 'off'].includes(normalized)) return false;

  return fallback;
}

function formatPercentLabel(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace('.', ',');
}

function normalizeComandaExtras(input: ComandaExtrasInput = {}) {
  return {
    taxa_servico_ativa: toFlag(input.taxa_servico_ativa, true) ? 1 : 0,
    taxa_servico_percentual: Math.max(0, toNumber(input.taxa_servico_percentual, 10)),
    couvert_ativo: toFlag(input.couvert_ativo, false) ? 1 : 0,
    couvert_valor_unitario: Math.max(0, toNumber(input.couvert_valor_unitario, 15)),
    couvert_quantidade_pessoas: Math.max(1, Math.round(toNumber(input.couvert_quantidade_pessoas, 1))),
  };
}

function buildComandaTotals(comanda: ComandaExtrasInput | null | undefined, subtotal: number): ComandaTotals {
  const extrasConfig = normalizeComandaExtras(comanda || {});
  const percentualLabel = formatPercentLabel(extrasConfig.taxa_servico_percentual);
  const valorTaxaServico = extrasConfig.taxa_servico_ativa
    ? subtotal * (extrasConfig.taxa_servico_percentual / 100)
    : 0;
  const valorCouvert = extrasConfig.couvert_ativo
    ? extrasConfig.couvert_valor_unitario * extrasConfig.couvert_quantidade_pessoas
    : 0;
  const extras = [];

  if (valorTaxaServico > 0) {
    extras.push({
      name: `Taxa de Serviço (${percentualLabel}%)`,
      value: valorTaxaServico,
    });
  }

  if (valorCouvert > 0) {
    extras.push({
      name: `Couvert Artístico (${extrasConfig.couvert_quantidade_pessoas} pessoa${extrasConfig.couvert_quantidade_pessoas > 1 ? 's' : ''})`,
      value: valorCouvert,
    });
  }

  return {
    taxaServicoAtiva: extrasConfig.taxa_servico_ativa === 1,
    taxaServicoPercentual: extrasConfig.taxa_servico_percentual,
    couvertAtivo: extrasConfig.couvert_ativo === 1,
    couvertValorUnitario: extrasConfig.couvert_valor_unitario,
    couvertQuantidadePessoas: extrasConfig.couvert_quantidade_pessoas,
    valorTaxaServico,
    valorCouvert,
    totalExtras: valorTaxaServico + valorCouvert,
    total: subtotal + valorTaxaServico + valorCouvert,
    extras,
  };
}

function buildMesaFinanceSnapshot(
  comanda: ComandaExtrasInput | null | undefined,
  subtotal: number
): MesaFinanceSnapshot {
  return {
    subtotal,
    ...buildComandaTotals(comanda, subtotal),
  };
}

function buildMesaReceiptTotals(snapshot: MesaFinanceSnapshot) {
  return [
    ...(snapshot.total !== snapshot.subtotal ? [{ label: 'Subtotal', valor: snapshot.subtotal }] : []),
    ...snapshot.extras.map((extra) => ({ label: extra.name, valor: extra.value })),
    { label: 'Total', valor: snapshot.total, destaque: true },
  ];
}

function buildMesaComandaPayload(comanda: any, itens: any[]) {
  const normalizedItems = itens.map((item: any) => ({
    ...item,
    quantity: Number(item.quantity || 0),
    price_at_time: Number(item.price_at_time || 0),
  }));
  const subtotal = normalizedItems.reduce(
    (acc: number, item: any) => acc + Number(item.quantity) * Number(item.price_at_time),
    0
  );
  const totals = buildMesaFinanceSnapshot(comanda, subtotal);

  return {
    ...comanda,
    taxa_servico_ativa: totals.taxaServicoAtiva ? 1 : 0,
    taxa_servico_percentual: totals.taxaServicoPercentual,
    couvert_ativo: totals.couvertAtivo ? 1 : 0,
    couvert_valor_unitario: totals.couvertValorUnitario,
    couvert_quantidade_pessoas: totals.couvertQuantidadePessoas,
    subtotal,
    valor_taxa_servico: totals.valorTaxaServico,
    valor_couvert: totals.valorCouvert,
    total_extras: totals.totalExtras,
    total_com_extras: totals.total,
    itens: normalizedItems,
  };
}

function buildActiveKdsOrderClause(alias?: string) {
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}cancelado_at IS NULL AND COALESCE(${prefix}status,'') NOT IN ('Entregue','cancelado','Cancelado','Concluído','Concluido','concluido')`;
}

// ── Helper: baixa/estorno de estoque por produto ──────────────────────────
function buildOperationalKdsOrderClause(alias?: string) {
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}cancelado_at IS NULL AND LOWER(COALESCE(${prefix}status,'')) <> 'entregue' AND LOWER(COALESCE(${prefix}status,'')) <> 'cancelado' AND LOWER(COALESCE(${prefix}status,'')) NOT LIKE 'conclu%'`;
}

// ── Solicitações de conta (chamado do garçom via QR ou do cliente) ────────────
// Quando o garçom (pelo celular, usando o QR temporário) ou o cliente pedem a
// conta, é criado um aviso aqui e um evento é disparado por SSE para quem
// estiver com o painel de Mesas aberto (o "balcão"/notebook). A pessoa no
// balcão confirma e imprime a comanda a partir desse aviso.
// Guardado em memória (por processo): é uma notificação efêmera, não histórico
// fiscal — some sozinha em 30 min, ao ser confirmada ou ao a mesa ser fechada.
// Obs.: se o back-end rodar em múltiplas instâncias, esse Map não é
// compartilhado entre elas; para esse cenário, migrar para uma tabela.
type SolicitacaoConta = {
  mesaId: number;
  mesaNumero: number;
  solicitadoPor: string;
  solicitadoEm: number;
};
const SOLICITACAO_CONTA_TTL_MS = 30 * 60 * 1000;
const solicitacoesContaPorTenant = new Map<number, Map<number, SolicitacaoConta>>();

function getSolicitacoesContaDoTenant(tenantId: number) {
  let mapa = solicitacoesContaPorTenant.get(tenantId);
  if (!mapa) {
    mapa = new Map();
    solicitacoesContaPorTenant.set(tenantId, mapa);
  }
  return mapa;
}

function listarSolicitacoesContaAtivas(tenantId: number): SolicitacaoConta[] {
  const mapa = getSolicitacoesContaDoTenant(tenantId);
  const agora = Date.now();
  const ativas: SolicitacaoConta[] = [];
  for (const [mesaId, item] of mapa.entries()) {
    if (agora - item.solicitadoEm > SOLICITACAO_CONTA_TTL_MS) {
      mapa.delete(mesaId);
      continue;
    }
    ativas.push(item);
  }
  return ativas.sort((a, b) => a.solicitadoEm - b.solicitadoEm);
}

function handleMesasRouteError(res: any, error: unknown, context: string, meta: Record<string, unknown> = {}) {
  logError(context, error, meta);

  if (isAppError(error)) {
    return res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
  }

  if (!res.headersSent) {
    return res.status(500).json({ success: false, message: INTERNAL_SERVER_MESSAGE });
  }
}

async function ajustarEstoque(
  tenantId: number,
  productId: number,
  qtd: number,
  motivo: string,
  variationId?: number | null
) {
  if (!(await tenantHasInventoryFeature(tenantId))) return;

  const prod = await q1('SELECT * FROM produtos WHERE id=? AND tenant_id=?', [productId, tenantId]);
  if (!prod) return;
  const tipo = qtd > 0 ? 'saida' : 'entrada';
  const abs  = Math.abs(qtd);
  const resolution = await requireProductInventoryTargets({
    client: pool,
    tenantId,
    productId,
    variationId: variationId ?? undefined,
    context: 'mesas.ajustarEstoque',
    direction: tipo,
  });
  for (const target of resolution.targets) {
    const total = Number(target.quantityMultiplier) * abs;
    if (tipo === 'saida') await qRun('UPDATE ingredientes SET estoque_atual=GREATEST(0,estoque_atual-?) WHERE id=? AND tenant_id=?', [total, target.ingredientId, tenantId]);
    else await qRun('UPDATE ingredientes SET estoque_atual=estoque_atual+? WHERE id=? AND tenant_id=?', [total, target.ingredientId, tenantId]);
    await qRun('INSERT INTO estoque_movimentacoes (ingrediente_id,tipo,quantidade,motivo,tenant_id) VALUES (?,?,?,?,?)', [target.ingredientId, tipo, total, motivo, tenantId]);
  }
}

/** Identidade de linha alinhada a `itens_comanda` / `addItemToMesaComanda` (merge por produto + variação + obs + seleções). */
type KdsSyncLine = {
  product_id: number;
  variation_id: number | null;
  observation: string | null;
  selecoes_json: string | null;
};

function kdsLineFromComandaRow(row: {
  product_id: number | string;
  variation_id?: number | string | null;
  observation?: string | null;
  selecoes_json?: string | null;
}): KdsSyncLine {
  const vid = row.variation_id != null ? Number(row.variation_id) : null;
  return {
    product_id: Number(row.product_id),
    variation_id: Number.isInteger(vid) && vid > 0 ? vid : null,
    observation: row.observation ?? null,
    selecoes_json: row.selecoes_json ?? null,
  };
}

// ── Sincroniza item entre comanda e pedido KDS ─────────────────────────────
const KDS_SYNC_ERROR_TIPO = 'KDS_SYNC_ERROR';

async function persistKdsSyncFailureAudit(params: {
  tenantId: number;
  mesaId: string | number;
  pedidoKdsId: number | null;
  productId: number;
  errMessage: string;
}) {
  const payload = {
    tipo: KDS_SYNC_ERROR_TIPO,
    message: params.errMessage,
    mesa_id: Number(params.mesaId),
    product_id: params.productId,
    pedido_kds_id: params.pedidoKdsId,
    momento: new Date().toISOString(),
  };
  try {
    if (params.pedidoKdsId != null) {
      await qRun(
        `INSERT INTO pedido_eventos
          (pedido_id,tenant_id,tipo,status_anterior,status_novo,valor,motivo,estoque_reposto,payload,usuario_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          params.pedidoKdsId,
          params.tenantId,
          KDS_SYNC_ERROR_TIPO,
          null,
          null,
          0,
          params.errMessage,
          0,
          JSON.stringify(payload),
          null,
        ]
      );
    } else {
      await qRun(
        'INSERT INTO system_logs (tenant_id,usuario_nome,cargo,acao,detalhes) VALUES (?,?,?,?,?)',
        [params.tenantId, 'Sistema', 'automacao', KDS_SYNC_ERROR_TIPO, JSON.stringify(payload)]
      );
    }
  } catch (logErr) {
    logError('mesas.persistKdsSyncFailureAudit', logErr, { tenantId: params.tenantId, mesaId: params.mesaId });
  }
}

/**
 * Log operacional de ação do garçom (QR temporário) em `system_logs` —
 * mesma tabela já lida pela tela de logs no admin. O nome é autodeclarado
 * (ver `req.garcomNome` em middleware.ts), não é autenticação: serve pra
 * responder "quem abriu/fechou essa mesa" no turno.
 */
async function logGarcomAction(tenantId: number | string, garcomNome: string, acao: string, detalhes: string) {
  try {
    await qRun(
      'INSERT INTO system_logs (tenant_id,usuario_nome,cargo,acao,detalhes) VALUES (?,?,?,?,?)',
      [tenantId, garcomNome, 'garcom', acao, detalhes]
    );
  } catch (logErr) {
    logError('mesas.logGarcomAction', logErr, { tenantId, acao });
  }
}

async function syncKdsItem(
  tenantId: number,
  mesaId: string | number,
  line: KdsSyncLine,
  diffQtd: number,
  priceAtTime: number,
  mode: 'add' | 'remove'
) {
  let pedidoKdsId: number | null = null;
  try {
    const productId = line.product_id;
    const produto = await q1('SELECT * FROM produtos WHERE id=? AND tenant_id=?', [productId, tenantId]);
    const needsPrep = produto ? resolveRequiresPreparation(produto) : true;
    if (!needsPrep) return;
    const mesa = await q1('SELECT numero FROM mesas WHERE id=? AND tenant_id=?', [mesaId, tenantId]);
    if (!mesa) return;
    const mesaLabel = `Mesa ${mesa.numero}`;
    let kdsOrder = await q1(`SELECT * FROM pedidos WHERE tenant_id=? AND observation=? AND ${buildOperationalKdsOrderClause()} ORDER BY id DESC LIMIT 1`, [tenantId, mesaLabel]);
    if (kdsOrder) pedidoKdsId = Number(kdsOrder.id);
    if (!kdsOrder && mode === 'remove') return;
    if (!kdsOrder) {
      // CORREÇÃO: Data baseada no fuso de SP para o order_number do KDS
      const dateObj = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
      const y = String(dateObj.getFullYear()).slice(-2);
      const m = String(dateObj.getMonth() + 1).padStart(2, '0');
      const d = String(dateObj.getDate()).padStart(2, '0');
      const dateStr = `${y}${m}${d}`;
      
      const maxOrd = await q1('SELECT MAX(id) as maxId FROM pedidos WHERE tenant_id=?', [tenantId]);
      const on = `${dateStr}-${tenantId}-KDS-${((maxOrd?.maxId||0)+1).toString().padStart(4,'0')}-${Date.now()}`;
      const newId = await qInsert("INSERT INTO pedidos (order_number,total_amount,observation,tenant_id,senha_pedido,tipo_retirada,canal,status) VALUES (?,?,?,?,?,'mesa','mesa','Criado')", [on, priceAtTime*Math.abs(diffQtd), mesaLabel, tenantId, mesa.numero]);
      pedidoKdsId = Number(newId);
      await qRun(
        "INSERT INTO itens_pedido (order_id,product_id,quantity,type,price_at_time,tenant_id,variation_id,observation,selecoes_json) VALUES (?,?,?,'Mesa',?,?,?,?,?)",
        [newId, productId, Math.abs(diffQtd), priceAtTime, tenantId, line.variation_id, line.observation, line.selecoes_json]
      );
      notifyTenantOrderStreams(tenantId, 'new', { orderId: Number(newId) });
      return;
    }
    const existing = await q1(
      `SELECT * FROM itens_pedido WHERE order_id=? AND product_id=? AND tenant_id=?
         AND observation IS NOT DISTINCT FROM ?
         AND variation_id IS NOT DISTINCT FROM ?
         AND selecoes_json IS NOT DISTINCT FROM ?`,
      [kdsOrder.id, productId, tenantId, line.observation, line.variation_id, line.selecoes_json]
    );
    if (existing) {
      const nq = Number(existing.quantity)+diffQtd;
      if (nq<=0) {
        await qRun('DELETE FROM itens_pedido WHERE id=? AND tenant_id=?', [existing.id, tenantId]);
        const rem = await q1('SELECT COUNT(*) as c FROM itens_pedido WHERE order_id=? AND tenant_id=?', [kdsOrder.id, tenantId]);
        if (Number(rem?.c||0)===0) await qRun("UPDATE pedidos SET status='Entregue' WHERE id=? AND tenant_id=?", [kdsOrder.id, tenantId]);
      } else {
        await qRun(
          'UPDATE itens_pedido SET quantity=?, variation_id=?, observation=?, selecoes_json=? WHERE id=? AND tenant_id=?',
          [nq, line.variation_id, line.observation, line.selecoes_json, existing.id, tenantId]
        );
      }
    } else if (diffQtd>0) {
      await qRun(
        "INSERT INTO itens_pedido (order_id,product_id,quantity,type,price_at_time,tenant_id,variation_id,observation,selecoes_json) VALUES (?,?,?,'Mesa',?,?,?,?,?)",
        [kdsOrder.id, productId, diffQtd, priceAtTime, tenantId, line.variation_id, line.observation, line.selecoes_json]
      );
    }
    await qRun('UPDATE pedidos SET total_amount=total_amount+? WHERE id=? AND tenant_id=?', [priceAtTime*diffQtd, kdsOrder.id, tenantId]);
    notifyTenantOrderStreams(tenantId, 'status', { orderId: Number(kdsOrder.id) });
  } catch (e: unknown) {
    const errMessage = e instanceof Error ? e.message : String(e);
    logError(
      'mesas.syncKdsItem',
      e instanceof Error ? e : new Error(errMessage),
      { tenantId, mesaId, productId: line.product_id, mode, pedidoKdsId }
    );
    await persistKdsSyncFailureAudit({
      tenantId,
      mesaId,
      pedidoKdsId,
      productId: line.product_id,
      errMessage,
    });
  }
}

export function createMesasRouter() {
  const router = Router();

  router.get('/', async (req: Request, res) => {
    try {
      const rows = await qAll(`
        SELECT m.*,
          (SELECT id FROM comandas WHERE mesa_id=m.id AND status='aberta' AND tenant_id=m.tenant_id LIMIT 1) as comanda_id,
          COALESCE((SELECT COUNT(*) FROM itens_comanda ic JOIN comandas c ON ic.comanda_id=c.id WHERE c.mesa_id=m.id AND c.status='aberta' AND c.tenant_id=m.tenant_id),0) as total_itens,
          COALESCE((SELECT SUM(ic.quantity*ic.price_at_time) FROM itens_comanda ic JOIN comandas c ON ic.comanda_id=c.id WHERE c.mesa_id=m.id AND c.status='aberta' AND c.tenant_id=m.tenant_id),0) as subtotal_valor,
          COALESCE((SELECT c.taxa_servico_ativa FROM comandas c WHERE c.mesa_id=m.id AND c.status='aberta' AND c.tenant_id=m.tenant_id ORDER BY c.created_at DESC LIMIT 1),1) as taxa_servico_ativa,
          COALESCE((SELECT c.taxa_servico_percentual FROM comandas c WHERE c.mesa_id=m.id AND c.status='aberta' AND c.tenant_id=m.tenant_id ORDER BY c.created_at DESC LIMIT 1),10) as taxa_servico_percentual,
          COALESCE((SELECT c.couvert_ativo FROM comandas c WHERE c.mesa_id=m.id AND c.status='aberta' AND c.tenant_id=m.tenant_id ORDER BY c.created_at DESC LIMIT 1),0) as couvert_ativo,
          COALESCE((SELECT c.couvert_valor_unitario FROM comandas c WHERE c.mesa_id=m.id AND c.status='aberta' AND c.tenant_id=m.tenant_id ORDER BY c.created_at DESC LIMIT 1),15) as couvert_valor_unitario,
          COALESCE((SELECT c.couvert_quantidade_pessoas FROM comandas c WHERE c.mesa_id=m.id AND c.status='aberta' AND c.tenant_id=m.tenant_id ORDER BY c.created_at DESC LIMIT 1),1) as couvert_quantidade_pessoas
        FROM mesas m WHERE m.tenant_id=? ORDER BY m.numero ASC
      `, [req.tenantId]);
      
      // CORREÇÃO: Converte valores de COUNT e SUM para Number
      res.json(rows.map((m: any) => {
        const subtotal = Number(m.subtotal_valor || 0);
        const totals = buildMesaFinanceSnapshotShared(m, subtotal);

        return {
          ...m,
          total_itens: Number(m.total_itens || 0),
          subtotal_valor: subtotal,
          valor_taxa_servico: totals.valorTaxaServico,
          valor_couvert: totals.valorCouvert,
          total_extras: totals.totalExtras,
          total_valor: totals.total
        };
      }));
    } catch (e: any) { sendInternalError(res, 'routes/mesas', e); }
  });

  // POST /api/mesas/gerar-qr-garcom — gera um QR temporário (6h) para o garçom
  // abrir mesas, lançar pedidos e fechar mesa pelo celular, sem precisar de
  // login pessoal. Só quem já está autenticado normalmente (dono/gerente com
  // acesso a "mesas") pode gerar; o token resultante tem escopo restrito
  // (ver restrictGarcomTempScope).
  router.post('/gerar-qr-garcom', async (req: Request, res) => {
    try {
      if ((req as any).isGarcomTemp) {
        return res.status(403).json({ error: 'Sessão de garçom não pode gerar novo QR.' });
      }
      const token = signGarcomTempToken(req.tenantId as number);
      const baseUrl = String(req.body?.base_url || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
      res.json({
        success: true,
        token,
        url: `${baseUrl}/m/garcom/${token}`,
        expires_in_minutes: 360,
      });
    } catch (e: any) { sendInternalError(res, 'routes/mesas', e); }
  });

  // POST /api/mesas/:id/solicitar-conta — o garçom (pelo QR temporário no
  // celular) avisa que o cliente pediu a conta. Não fecha a mesa nem lança
  // pagamento: só dispara um aviso para quem estiver no painel de Mesas
  // (balcão/notebook) confirmar e imprimir a comanda.
  router.post('/:id/solicitar-conta', async (req: Request, res) => {
    try {
      const mesa = await q1('SELECT id, numero, status FROM mesas WHERE id=? AND tenant_id=?', [req.params.id, req.tenantId]);
      if (!mesa) return res.status(404).json({ success:false, message:'Mesa não encontrada' });
      if (mesa.status !== 'aberta') {
        return res.status(400).json({ success:false, message:'Mesa não está aberta' });
      }

      const solicitadoPor = (req as any).isGarcomTemp
        ? String((req as any).garcomNome || 'Garçom')
        : (String(req.body?.solicitadoPor || '').trim().slice(0, 60) || 'Cliente');

      const mapa = getSolicitacoesContaDoTenant(req.tenantId as number);
      mapa.set(mesa.id, {
        mesaId: mesa.id,
        mesaNumero: mesa.numero,
        solicitadoPor,
        solicitadoEm: Date.now(),
      });

      notifyTenantOrderStreams(Number(req.tenantId), 'conta_solicitada', {
        mesaId: mesa.id,
        mesaNumero: mesa.numero,
        solicitadoPor,
      });

      if ((req as any).isGarcomTemp) {
        void logGarcomAction(req.tenantId as number, (req as any).garcomNome, 'PEDIU_CONTA', `Mesa ${mesa.numero}`);
      }

      res.json({ success:true });
    } catch (e: any) { sendInternalError(res, 'routes/mesas', e); }
  });

  // GET /api/mesas/solicitacoes-conta — painel de Mesas (balcão/notebook)
  // consulta periodicamente para saber se alguma mesa pediu a conta.
  router.get('/solicitacoes-conta', async (req: Request, res) => {
    try {
      res.json(listarSolicitacoesContaAtivas(req.tenantId as number));
    } catch (e: any) { sendInternalError(res, 'routes/mesas', e); }
  });

  // POST /api/mesas/:id/solicitar-conta/confirmar — quem está no balcão
  // confirmou o aviso (normalmente depois de imprimir a comanda). Remove o
  // aviso da lista de pendentes.
  router.post('/:id/solicitar-conta/confirmar', async (req: Request, res) => {
    try {
      const mapa = getSolicitacoesContaDoTenant(req.tenantId as number);
      mapa.delete(Number(req.params.id));
      res.json({ success:true });
    } catch (e: any) { sendInternalError(res, 'routes/mesas', e); }
  });

  // DELETE /api/mesas/:id/solicitar-conta — dispensa o aviso sem confirmar
  // (ex.: pedido duplicado, mesa já foi atendida pessoalmente).
  router.delete('/:id/solicitar-conta', async (req: Request, res) => {
    try {
      const mapa = getSolicitacoesContaDoTenant(req.tenantId as number);
      mapa.delete(Number(req.params.id));
      res.json({ success:true });
    } catch (e: any) { sendInternalError(res, 'routes/mesas', e); }
  });

  // GET /api/mesas/produtos-garcom?q=... — busca de produtos para o garçom
  // adicionar itens à comanda pelo QR temporário (mesmo formato usado em
  // /api/atendimento/produtos, restrito ao essencial para o cardápio rápido).
  router.get('/produtos-garcom', async (req: Request, res) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const term = `%${q}%`;
      const rows = q.length >= 2
        ? await qAll(
            `SELECT id, name, price, category, COALESCE(is_combo,0) AS is_combo
             FROM produtos
             WHERE tenant_id=?
               AND COALESCE(active,0)=1
               AND (name ILIKE ? OR category ILIKE ?)
             ORDER BY category ASC, name ASC
             LIMIT 60`,
            [req.tenantId, term, term]
          )
        : await qAll(
            `SELECT id, name, price, category, COALESCE(is_combo,0) AS is_combo
             FROM produtos
             WHERE tenant_id=?
               AND COALESCE(active,0)=1
             ORDER BY category ASC, name ASC
             LIMIT 300`,
            [req.tenantId]
          );
      res.json(rows);
    } catch (e: any) { sendInternalError(res, 'routes/mesas', e); }
  });

  router.post('/configurar', async (req: Request, res) => {
    try {
      const { quantidade } = req.body;
      if (!quantidade||quantidade<1||quantidade>200) return res.status(400).json({ success:false, message:'Quantidade deve ser entre 1 e 200' });
      const existing = await qAll('SELECT numero FROM mesas WHERE tenant_id=? ORDER BY numero ASC', [req.tenantId]);
      const currentMax = existing.length>0 ? Math.max(...existing.map((m:any)=>m.numero)) : 0;
      if (quantidade>currentMax) {
        for (let i=currentMax+1; i<=quantidade; i++) {
          await qRun("INSERT INTO mesas (numero,tenant_id,status) VALUES (?,?,'fechada') ON CONFLICT(numero,tenant_id) DO NOTHING", [i, req.tenantId]);
        }
      } else {
        for (let i=currentMax; i>quantidade; i--) {
          const m = await q1("SELECT * FROM mesas WHERE numero=? AND tenant_id=? AND status='fechada'", [i, req.tenantId]);
          if (m) await qRun('DELETE FROM mesas WHERE id=? AND tenant_id=?', [m.id, req.tenantId]);
        }
      }
      res.json({ success:true, total:quantidade });
    } catch (e: any) { sendInternalError(res, 'routes/mesas', e); }
  });

  router.delete('/comanda/item/:itemId', async (req: Request, res) => {
    try {
      const item = await q1('SELECT ic.*, c.mesa_id FROM itens_comanda ic JOIN comandas c ON c.id=ic.comanda_id WHERE ic.id=? AND ic.tenant_id=?', [req.params.itemId, req.tenantId]);
      await qRun('DELETE FROM itens_comanda WHERE id=? AND tenant_id=?', [req.params.itemId, req.tenantId]);
      if (item) {
        await ajustarEstoque(req.tenantId, item.product_id, -Number(item.quantity), 'Estorno Mesa', item.variation_id);
        await syncKdsItem(
          req.tenantId,
          String(item.mesa_id),
          kdsLineFromComandaRow(item),
          -(Number(item.quantity)),
          item.price_at_time,
          'remove'
        );
      }
      res.json({ success:true });
    } catch (e: any) {
      return handleMesasRouteError(res, e, 'mesas.deleteComandaItem', {
        tenantId: req.tenantId,
        itemId: req.params.itemId,
      });
    }
  });

  router.put('/comanda/item/:itemId', async (req: Request, res) => {
    try {
      const { quantity } = req.body;
      const novaQtd = Number(quantity)||0;
      const itemAtual = await q1('SELECT * FROM itens_comanda WHERE id=? AND tenant_id=?', [req.params.itemId, req.tenantId]);
      if (!itemAtual) return res.status(404).json({ success:false, message:'Item não encontrado' });
      const qtdAnt = Number(itemAtual.quantity)||0;
      const diff = novaQtd-qtdAnt;
      const cmd = await q1('SELECT c.mesa_id FROM comandas c JOIN itens_comanda ic ON ic.comanda_id=c.id WHERE ic.id=? AND ic.tenant_id=?', [req.params.itemId, req.tenantId]);
      if (novaQtd<=0) {
        await qRun('DELETE FROM itens_comanda WHERE id=? AND tenant_id=?', [req.params.itemId, req.tenantId]);
        await ajustarEstoque(req.tenantId, itemAtual.product_id, -qtdAnt, 'Estorno Mesa', itemAtual.variation_id);
        if (cmd) {
          await syncKdsItem(
            req.tenantId,
            String(cmd.mesa_id),
            kdsLineFromComandaRow(itemAtual),
            -qtdAnt,
            itemAtual.price_at_time,
            'remove'
          );
        }
      } else {
        await qRun('UPDATE itens_comanda SET quantity=? WHERE id=? AND tenant_id=?', [novaQtd, req.params.itemId, req.tenantId]);
        if (diff !== 0) {
          await ajustarEstoque(
            req.tenantId,
            itemAtual.product_id,
            diff,
            diff > 0 ? 'Venda Mesa' : 'Estorno Mesa',
            itemAtual.variation_id
          );
        }
        if (cmd && diff !== 0) {
          await syncKdsItem(
            req.tenantId,
            String(cmd.mesa_id),
            kdsLineFromComandaRow(itemAtual),
            diff,
            itemAtual.price_at_time,
            diff > 0 ? 'add' : 'remove'
          );
        }
      }
      res.json({ success:true });
    } catch (e: any) {
      return handleMesasRouteError(res, e, 'mesas.updateComandaItem', {
        tenantId: req.tenantId,
        itemId: req.params.itemId,
      });
    }
  });

  router.put('/:id/abrir', async (req: Request, res) => {
    try {
      const mesa = await q1('SELECT * FROM mesas WHERE id=? AND tenant_id=?', [req.params.id, req.tenantId]);
      if (!mesa) return res.status(404).json({ success:false, message:'Mesa não encontrada' });
      if (mesa.status==='aberta') return res.json({ success:true, message:'Mesa já estava aberta' });
      await withTx(async (client) => {
        await txRun(client, "UPDATE mesas SET status='aberta', opened_at=NOW() WHERE id=? AND tenant_id=?", [req.params.id, req.tenantId]);
        await txRun(client, "INSERT INTO comandas (mesa_id,tenant_id,status) VALUES (?,?,'aberta')", [req.params.id, req.tenantId]);
      });
      if ((req as any).isGarcomTemp) {
        void logGarcomAction(req.tenantId as number, (req as any).garcomNome, 'ABRIU_MESA', `Mesa ${mesa.numero}`);
      }
      res.json({ success:true });
    } catch (e: any) { sendInternalError(res, 'routes/mesas', e); }
  });

  router.put('/:id/fechar', async (req: Request, res) => {
    try {
      await withTx(async (client) => {
        await txRun(client, "UPDATE comandas SET status='fechada', closed_at=NOW() WHERE mesa_id=? AND status='aberta' AND tenant_id=?", [req.params.id, req.tenantId]);
        await txRun(client, "UPDATE mesas SET status='fechada', opened_at=NULL WHERE id=? AND tenant_id=?", [req.params.id, req.tenantId]);
      });
      getSolicitacoesContaDoTenant(req.tenantId as number).delete(Number(req.params.id));
      res.json({ success:true });
    } catch (e: any) { sendInternalError(res, 'routes/mesas', e); }
  });

  router.get('/:id/comanda', async (req: Request, res) => {
    try {
      const comanda = await q1("SELECT * FROM comandas WHERE mesa_id=? AND status='aberta' AND tenant_id=? ORDER BY created_at DESC LIMIT 1", [req.params.id, req.tenantId]);
      if (!comanda) return res.json({ comanda:null, itens:[] });
      const itens = await qAll('SELECT ic.* FROM itens_comanda ic WHERE ic.comanda_id=? AND ic.tenant_id=? ORDER BY ic.created_at ASC', [comanda.id, req.tenantId]);
      
      // CORREÇÃO: Converte quantidades e preços de cada item para Number
      const payload = buildMesaComandaPayloadShared(comanda, itens);

      res.json({
        comanda: { ...payload, itens: undefined },
        itens: payload.itens
      });
    } catch (e: any) { sendInternalError(res, 'routes/mesas', e); }
  });

  router.put('/:id/comanda/extras', async (req: Request, res) => {
    try {
      const comanda = await q1(
        "SELECT * FROM comandas WHERE mesa_id=? AND status='aberta' AND tenant_id=? ORDER BY created_at DESC LIMIT 1",
        [req.params.id, req.tenantId]
      );
      if (!comanda) return res.status(404).json({ success:false, message:'Nenhuma comanda aberta para esta mesa' });

      const extras = normalizeComandaExtrasShared(req.body || {});
      await qRun(
        `UPDATE comandas
         SET taxa_servico_ativa=?,
             taxa_servico_percentual=?,
             couvert_ativo=?,
             couvert_valor_unitario=?,
             couvert_quantidade_pessoas=?
         WHERE id=? AND tenant_id=?`,
        [
          extras.taxa_servico_ativa,
          extras.taxa_servico_percentual,
          extras.couvert_ativo,
          extras.couvert_valor_unitario,
          extras.couvert_quantidade_pessoas,
          comanda.id,
          req.tenantId
        ]
      );

      const itens = await qAll(
        'SELECT ic.* FROM itens_comanda ic WHERE ic.comanda_id=? AND ic.tenant_id=? ORDER BY ic.created_at ASC',
        [comanda.id, req.tenantId]
      );
      const payload = buildMesaComandaPayloadShared({ ...comanda, ...extras }, itens);

      res.json({
        success:true,
        comanda: { ...payload, itens: undefined },
        itens: payload.itens
      });
    } catch (e: any) { sendInternalError(res, 'routes/mesas', e); }
  });

  router.get('/:id/comanda-html', async (req: Request, res) => {
    try {
      const mesa = await q1('SELECT id, numero, status FROM mesas WHERE id=? AND tenant_id=?', [req.params.id, req.tenantId]);
      if (!mesa) return res.status(404).send('<h1>Mesa nao encontrada</h1>');

      const comanda = await q1(
        "SELECT * FROM comandas WHERE mesa_id=? AND status='aberta' AND tenant_id=? ORDER BY created_at DESC LIMIT 1",
        [req.params.id, req.tenantId]
      );
      if (!comanda) return res.status(404).send('<h1>Nenhuma comanda aberta</h1>');

      const itens = await qAll(
        'SELECT ic.* FROM itens_comanda ic WHERE ic.comanda_id=? AND ic.tenant_id=? ORDER BY ic.created_at ASC',
        [comanda.id, req.tenantId]
      );
      if (!itens.length) return res.status(404).send('<h1>Comanda vazia</h1>');

      const subtotal = itens.reduce((acc:number, item:any) => acc + Number(item.quantity) * Number(item.price_at_time), 0);
      const totals = buildMesaFinanceSnapshotShared(comanda, subtotal);
      const rawCreatedAt = String(comanda.created_at || '');
      const createdAt = new Date(rawCreatedAt.includes('Z') ? rawCreatedAt : `${rawCreatedAt}-03:00`);
      const openedAt = createdAt.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: TZ,
      });
      const now = new Date().toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: TZ,
      });
      const cliente = await q1('SELECT nome_estabelecimento, printer_config FROM clientes WHERE id=?', [req.tenantId]);

      res.send(gerarCupomHtml({
        titulo:`Mesa ${mesa.numero}`,
        estabelecimento:cliente?.nome_estabelecimento || undefined,
        orderNumber:`Mesa-${mesa.numero}`,
        data:now,
        variant:'table-slip',
        canal:'mesa',
        metadata:[
          { label:'Mesa', value:String(mesa.numero) },
          { label:'Abertura', value:openedAt },
          { label:'Status', value:String(mesa.status || 'aberta') },
        ],
        paperWidthMm:getProfilePaperWidthMm(cliente?.printer_config, 'mesa'),
        itens:itens.map((item:any)=>({
          qtd:Number(item.quantity),
          nome: item.observation
            ? `${item.product_name} (${item.observation})`
            : item.product_name,
          valor:Number(item.quantity) * Number(item.price_at_time),
        })),
        totais:[
          ...buildMesaReceiptTotalsShared(totals).map((total) => ({
            ...total,
            label: total.destaque ? 'Total da mesa' : total.label,
          }))
        ],
      }));
    } catch (e: any) { sendInternalError(res, 'routes/mesas', e); }
  });

  /** Comanda de produção para a mesa: usa o mesmo pedido KDS/operacional quando existir (mesmo order_number do painel/KDS); senão sintetiza ref. Mesa-N. */
  router.get('/:id/producao-html', async (req: Request, res) => {
    try {
      const mesa = await q1('SELECT id, numero, status FROM mesas WHERE id=? AND tenant_id=?', [req.params.id, req.tenantId]);
      if (!mesa) return res.status(404).send('<h1>Mesa nao encontrada</h1>');

      const comanda = await q1(
        "SELECT * FROM comandas WHERE mesa_id=? AND status='aberta' AND tenant_id=? ORDER BY created_at DESC LIMIT 1",
        [req.params.id, req.tenantId]
      );
      if (!comanda) return res.status(404).send('<h1>Nenhuma comanda aberta</h1>');

      const cliente = await q1('SELECT nome_estabelecimento, printer_config FROM clientes WHERE id=?', [req.tenantId]);
      const mesaLabel = `Mesa ${mesa.numero}`;
      const kdsOrder = await q1(
        `SELECT * FROM pedidos WHERE tenant_id=? AND observation=? AND ${buildOperationalKdsOrderClause()} ORDER BY id DESC LIMIT 1`,
        [req.tenantId, mesaLabel]
      );

      if (kdsOrder) {
        if (kdsOrder.cancelado_at || String(kdsOrder.status || '').trim().toLowerCase() === 'cancelado') {
          return res.status(409).send('<h1>Pedido operacional cancelado</h1>');
        }
        const rows = await qAll(
          `SELECT p.name, p.category, p.requires_preparation, p.production_type, ip.quantity, ip.observation
           FROM itens_pedido ip
           JOIN produtos p ON p.id=ip.product_id
           WHERE ip.order_id=? AND ip.tenant_id=?`,
          [kdsOrder.id, req.tenantId]
        );
        const kitchenItems = rows.map((row: any) => ({
          quantity: Number(row.quantity),
          name: row.name,
          observation: row.observation,
          category: row.category,
          requires_preparation: row.requires_preparation,
          production_type: row.production_type,
        }));
        if (filterKitchenPreparationItems(kitchenItems).length === 0) {
          return res.send('<h1>Nenhum item de preparo nesta comanda.</h1>');
        }
        return res.send(
          buildKitchenReceiptHtml({
            order: {
              order_number: String(kdsOrder.order_number),
              canal: kdsOrder.canal,
              tipo_retirada: kdsOrder.tipo_retirada,
              observation: mesaLabel,
              created_at: kdsOrder.created_at,
            },
            items: kitchenItems,
            estabelecimento: cliente?.nome_estabelecimento,
            paperWidthMm: getProfilePaperWidthMm(cliente?.printer_config, 'cozinha'),
          })
        );
      }

      const rows = await qAll(
        `SELECT ic.quantity, ic.observation, ic.product_name, p.name AS pname, p.category, p.requires_preparation, p.production_type
         FROM itens_comanda ic
         JOIN produtos p ON p.id=ic.product_id AND p.tenant_id=ic.tenant_id
         WHERE ic.comanda_id=? AND ic.tenant_id=?
         ORDER BY ic.created_at ASC`,
        [comanda.id, req.tenantId]
      );
      const kitchenItems = rows.map((row: any) => ({
        quantity: Number(row.quantity),
        name: row.pname || row.product_name || 'Produto',
        observation: row.observation,
        category: row.category,
        requires_preparation: row.requires_preparation,
        production_type: row.production_type,
      }));
      if (filterKitchenPreparationItems(kitchenItems).length === 0) {
        return res.send('<h1>Nenhum item de preparo nesta comanda.</h1>');
      }

      res.send(
        buildKitchenReceiptHtml({
          order: {
            order_number: `Mesa-${mesa.numero}`,
            canal: 'mesa',
            tipo_retirada: 'mesa',
            observation: mesaLabel,
            created_at: comanda.created_at,
          },
          items: kitchenItems,
          estabelecimento: cliente?.nome_estabelecimento,
          paperWidthMm: getProfilePaperWidthMm(cliente?.printer_config, 'cozinha'),
        })
      );
    } catch (e: any) {
      sendInternalError(res, 'routes/mesas', e);
    }
  });

  router.post('/:id/comanda/adicionar', async (req: Request, res) => {
    try {
      const result = await addItemToMesaComanda({
        tenantId: req.tenantId as number,
        mesaId: Number(req.params.id),
        body: req.body,
      });
      await ajustarEstoque(req.tenantId, result.product_id, result.quantity_added, 'Venda Mesa', result.variation_id);
      await syncKdsItem(
        req.tenantId,
        req.params.id,
        {
          product_id: result.product_id,
          variation_id: result.variation_id,
          observation: result.observation,
          selecoes_json: result.selecoes_json,
        },
        result.quantity_added,
        result.price_at_time,
        'add'
      );

      const cfgRow = await q1<{ delivery_config: string | null }>('SELECT delivery_config FROM clientes WHERE id=?', [req.tenantId]);
      const parsed = coerceDeliveryConfigRow(cfgRow?.delivery_config ?? null);
      const automation = parseAutomationFromDeliveryConfigJson(parsed);
      if (automation.mesa_auto_print_production) {
        void runAutomatedKitchenPrintForMesa(Number(req.tenantId), Number(req.params.id), {
          trigger: 'mesa_comanda_item',
          printEvenWithKds: automation.print_production_even_with_kds,
        }).catch((err) =>
          logError('mesas.autoKitchenPrintMesa.unhandled', err, { tenantId: req.tenantId, mesaId: req.params.id })
        );
      }

      res.json({ success:true, comanda_id: result.comanda_id });
    } catch (e: any) {
      return handleMesasRouteError(res, e, 'mesas.addComandaItem', {
        tenantId: req.tenantId,
        mesaId: req.params.id,
        productId: req.body?.product_id,
      });
    }
  });

  router.post('/:id/comanda/finalizar', async (req: Request, res) => {
    try {
      const payments = Array.isArray(req.body?.payments) ? req.body.payments : [];
      const observation = String(req.body?.observation || '').trim();
      const requestedExtras = req.body?.extras ? normalizeComandaExtrasShared(req.body.extras) : null;
      const cli = await q1('SELECT nome_estabelecimento, printer_config FROM clientes WHERE id=?', [req.tenantId]);

      const result = await withTx(async (client) => {
        const mesa = await txQ1(
          client,
          'SELECT id, numero FROM mesas WHERE id=? AND tenant_id=? FOR UPDATE',
          [req.params.id, req.tenantId]
        );
        if (!mesa) return { status: 404, body: { success:false, message:'Mesa não encontrada' } };

        const openComanda = await txQ1(
          client,
          "SELECT * FROM comandas WHERE mesa_id=? AND status='aberta' AND tenant_id=? ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
          [req.params.id, req.tenantId]
        );
        if (!openComanda) {
          return { status: 404, body: { success:false, message:'Nenhuma comanda aberta para esta mesa' } };
        }

        const itens = await txQAll(
          client,
          'SELECT * FROM itens_comanda WHERE comanda_id=? AND tenant_id=? ORDER BY created_at ASC',
          [openComanda.id, req.tenantId]
        );
        if (!itens.length) return { status: 400, body: { success:false, message:'Comanda vazia' } };

        const effectiveComanda = requestedExtras ? { ...openComanda, ...requestedExtras } : openComanda;
        const subtotal = itens.reduce(
          (acc:number, item:any) => acc + Number(item.quantity) * Number(item.price_at_time),
          0
        );
        const snapshot = buildMesaFinanceSnapshotShared(effectiveComanda, subtotal);
        const normalizedPayments = payments
          .map((payment: any) => ({
            method: String(payment?.method || '').trim() || 'Dinheiro',
            amount_paid: Number(payment?.amount_paid || 0),
          }))
          .filter((payment) => payment.amount_paid > 0);

        if (!normalizedPayments.length) {
          return { status: 400, body: { success:false, message:'Informe ao menos um pagamento' } };
        }

        const totalPago = normalizedPayments.reduce((acc:number, payment) => acc + payment.amount_paid, 0);
        if (totalPago < snapshot.total - 0.01) {
          return { status: 400, body: { success:false, message:'Pagamento insuficiente' } };
        }

        const troco = Math.max(0, totalPago - snapshot.total);
        const paymentMethod =
          Array.from(new Set(normalizedPayments.map((payment) => payment.method))).length === 1
            ? normalizedPayments[0].method
            : 'Misto';
        const orderNumber = `M${mesa.numero}-${Date.now()}`;
        const now = new Date().toLocaleString('pt-BR', {
          day:'2-digit',
          month:'2-digit',
          year:'2-digit',
          hour:'2-digit',
          minute:'2-digit'
        });
        const receiptHtml = gerarCupomHtml({
          titulo:`Mesa ${mesa.numero}`,
          estabelecimento:cli?.nome_estabelecimento,
          orderNumber,
          data:now,
          variant:'receipt',
          canal:'mesa',
          metadata:[
            { label:'Mesa', value:String(mesa.numero) },
            { label:'Operacao', value:'Fechamento de comanda' }
          ],
          paperWidthMm:getProfilePaperWidthMm(cli?.printer_config, 'caixa'),
        itens:itens.map((item:any)=>({
          qtd:Number(item.quantity),
          nome: item.observation
            ? `${item.product_name} (${item.observation})`
            : item.product_name,
          valor:Number(item.quantity) * Number(item.price_at_time)
        })),
          totais:buildMesaReceiptTotalsShared(snapshot),
          pagamentos:normalizedPayments.map((payment, index)=>({
            metodo:payment.method,
            valor:payment.amount_paid,
            troco:index===normalizedPayments.length-1 && troco>0 ? troco : undefined
          })),
          observacao:observation || undefined,
        });
        const finalObservation = observation || `[Fechado] Mesa ${mesa.numero} - ${orderNumber}`;

        const pedidoId = await txInsert(
          client,
           `INSERT INTO pedidos (
              order_number,status,total_amount,observation,receipt_text,tenant_id,canal,tipo_retirada,
              pagamento_tipo,pagamento_status,mesa_id,comanda_id,subtotal,taxa_servico_ativa,taxa_servico_percentual,valor_taxa_servico,
              couvert_ativo,couvert_valor_unitario,couvert_quantidade_pessoas,valor_couvert,total_extras
            ) VALUES (
             ?,
             'Concluido',
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?
            )`,
          [
            orderNumber,
            snapshot.total,
            finalObservation,
            receiptHtml,
            req.tenantId,
            'mesa',
            'mesa',
            paymentMethod,
            'pago',
            mesa.id,
            openComanda.id,
            snapshot.subtotal,
            snapshot.taxaServicoAtiva ? 1 : 0,
            snapshot.taxaServicoPercentual,
            snapshot.valorTaxaServico,
            snapshot.couvertAtivo ? 1 : 0,
            snapshot.couvertValorUnitario,
            snapshot.couvertQuantidadePessoas,
            snapshot.valorCouvert,
            snapshot.totalExtras,
          ]
        );

        for (const item of itens) {
          await txRun(
            client,
            "INSERT INTO itens_pedido (order_id,product_id,quantity,type,price_at_time,tenant_id,variation_id,observation,selecoes_json) VALUES (?,?,?,'Mesa',?,?,?,?,?)",
            [
              pedidoId,
              item.product_id,
              item.quantity,
              item.price_at_time,
              req.tenantId,
              item.variation_id ?? null,
              item.observation ?? null,
              item.selecoes_json ?? null,
            ]
          );
        }

        for (let index = 0; index < normalizedPayments.length; index++) {
          await txRun(
            client,
            "INSERT INTO pagamentos (order_id,method,amount_paid,change_given,tenant_id) VALUES (?,?,?,?,?)",
            [
              pedidoId,
              normalizedPayments[index].method,
              normalizedPayments[index].amount_paid,
              index === normalizedPayments.length - 1 ? troco : 0,
              req.tenantId
            ]
          );
        }

        await txRun(
          client,
          `UPDATE comandas
           SET status='fechada',
               closed_at=NOW(),
               taxa_servico_ativa=?,
               taxa_servico_percentual=?,
               couvert_ativo=?,
               couvert_valor_unitario=?,
               couvert_quantidade_pessoas=?
           WHERE id=? AND tenant_id=?`,
          [
            snapshot.taxaServicoAtiva ? 1 : 0,
            snapshot.taxaServicoPercentual,
            snapshot.couvertAtivo ? 1 : 0,
            snapshot.couvertValorUnitario,
            snapshot.couvertQuantidadePessoas,
            openComanda.id,
            req.tenantId
          ]
        );
        await txRun(client, "UPDATE mesas SET status='fechada', opened_at=NULL WHERE id=? AND tenant_id=?", [req.params.id, req.tenantId]);
        const kdsOpen = await txQ1<{ id: number }>(
          client,
          `SELECT id FROM pedidos WHERE tenant_id=? AND observation=? AND ${buildOperationalKdsOrderClause()} ORDER BY id DESC LIMIT 1`,
          [req.tenantId, `Mesa ${mesa.numero}`]
        );
        await txRun(
          client,
          `UPDATE pedidos SET status='Entregue' WHERE tenant_id=? AND observation=? AND ${buildOperationalKdsOrderClause()}`,
          [req.tenantId, `Mesa ${mesa.numero}`]
        );

        return {
          status: 200,
          body: { success:true, orderNumber, change:troco, receipt:receiptHtml },
          kdsSseOrderId: kdsOpen ? Number(kdsOpen.id) : undefined,
          garcomLog: (req as any).isGarcomTemp
            ? {
                mesaNumero: mesa.numero,
                orderNumber,
                total: snapshot.total,
                paymentMethod,
              }
            : undefined,
        };
      });

      if (result.status === 200) {
        getSolicitacoesContaDoTenant(req.tenantId as number).delete(Number(req.params.id));
      }
      if (result.status === 200 && 'kdsSseOrderId' in result && result.kdsSseOrderId) {
        notifyTenantOrderStreams(Number(req.tenantId), 'status', { orderId: result.kdsSseOrderId });
      }
      if (result.status === 200 && 'garcomLog' in result && result.garcomLog) {
        const { mesaNumero, orderNumber: logOrderNumber, total, paymentMethod: logPaymentMethod } = result.garcomLog;
        void logGarcomAction(
          req.tenantId as number,
          (req as any).garcomNome,
          'FECHOU_MESA',
          `Mesa ${mesaNumero} — ${logOrderNumber} — R$ ${total.toFixed(2)} via ${logPaymentMethod}`
        );
      }
      return res.status(result.status).json(result.body);
    } catch (e: any) {
      return handleMesasRouteError(res, e, 'mesas.finalizarComanda', {
        tenantId: req.tenantId,
        mesaId: req.params.id,
        paymentCount: Array.isArray(req.body?.payments) ? req.body.payments.length : 0,
      });
    }
  });

  return router;
}


