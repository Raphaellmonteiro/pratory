import type { PoolClient } from 'pg';
import {
  q1,
  qAll,
  qRun,
  qInsert,
  withTx,
  txQ1,
  txQAll,
  txRun,
  txInsert,
} from '../db';
import { gerarCupomHtml } from '../utils/printTemplates';
import type {
  CancelOrderInput,
  ConfirmOrderPaymentInput,
  CreateOrderInput,
  DeleteOrderInput,
  GetOrderHistoryInput,
  GetOrdersFilters,
  OrderHistoryEvent,
  OrderItemInput,
  PaymentInput,
  RefundOrderInput,
  UpdateOrderStatusInput,
} from '../types/order';
import type { Order } from '../types';
import { isOrderFullyPaid } from '../utils/orderCentralBoard';
import { AppError } from '../utils/errors';
import { logError } from '../utils/logger';
import { getProfilePaperWidthMm } from '../utils/printProfiles';
import { resolveRequiresPreparation } from '../utils/preparation';
import { validateSecurityPassword } from '../utils/securityPassword';
import { splitOrderItemDetailLines } from '../utils/orderItemDisplay';
import { requireProductInventoryTargets } from './stockIdentification';
import { parseAutomationFromDeliveryConfigJson, shouldAutoPrintForBalcaoOrder } from './automationConfig';
import { runAutomatedKitchenPrintForOrder } from './operationalAutomationService';
import { createPixPayment } from './paymentsService';
import { revalidatePixPaymentByOrder } from './pixPaymentRevalidationService';
import { touchStoreCustomerPurchase } from './storeCustomerService';
import { tenantHasInventoryFeature } from './tenantPlan';
import { notifyTenantOrderStreams } from '../sse';
import { coerceDeliveryConfigRow } from '../utils/deliveryConfigPersist';
import { validateAuthoritativeComboSelections } from './productComboValidation';
import {
  emitWhatsAppOrderStatusEvent,
  orderCancelledWhatsAppEvent,
  orderCreatedWhatsAppEvent,
  orderPaymentConfirmedWhatsAppEvent,
} from './whatsAppEventsService';

const TZ = 'America/Sao_Paulo';

const ALLOWED_ORDER_STATUSES = new Set([
  'Criado',
  'Aguardando confirmação',
  'Em Preparo',
  'Pronto',
  'Entregue',
  'Concluído',
  'Cancelado',
  'cancelado',
  'Pedido Recebido',
  'Pronto para Entrega',
  'Saiu para Entrega',
]);

/** Chaves canônicas: trim + lowerCase + NFD + sem diacríticos (ex.: Débito/debito/DEBITO → debito). */
function normalizePaymentMethodKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

const ALLOWED_PAYMENT_METHODS = new Set([
  'dinheiro',
  'pix',
  'debito',
  'credito',
  'cartao',
]);

type TenantId = number | string;

const MAX_ITEM_OBSERVATION_LEN = 4000;
const MAX_SELECOES_JSON_LEN = 12000;

/** Persiste mapa de seleções (grupo → opção → qtd) como JSON; usado por balcão, mesa e pode ser reutilizado pelo cardápio. */
export function serializeOrderItemSelecoes(selecoes: unknown): string | null {
  if (selecoes === undefined || selecoes === null) return null;
  if (typeof selecoes !== 'object' || Array.isArray(selecoes)) return null;
  try {
    const j = JSON.stringify(selecoes);
    if (j === '{}') return null;
    return j.length > MAX_SELECOES_JSON_LEN ? j.slice(0, MAX_SELECOES_JSON_LEN) : j;
  } catch {
    return null;
  }
}

export function parseOrderItemSelecoesJson(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw == null || !String(raw).trim()) return null;
  try {
    const o = JSON.parse(String(raw)) as unknown;
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
    return o as Record<string, unknown>;
  } catch {
    return null;
  }
}

type OrderItemRow = {
  order_id: number;
  product_id: number;
  quantity: number;
  type?: string | null;
  price_at_time: number;
  variation_id?: number | null;
  observation?: string | null;
  selecoes_json?: string | null;
  product_name?: string | null;
  product_category?: string | null;
  production_type?: string | null;
  requires_preparation?: number | null;
};

/** Item enriquecido para API (operação, detalhe, integrações) — sempre com preço congelado, sem recálculo. */
export type PublicOrderItem = {
  product_id: number;
  quantity: number;
  type?: string;
  price_at_time: number;
  variation_id: number | null;
  product_name: string;
  product_category?: string | null;
  production_type?: string | null;
  requires_preparation?: number | null;
  name: string;
  observation?: string;
  obs_opcoes?: string;
  selecoes: Record<string, unknown> | null;
  item_display_summary: string;
  item_display_details: string[];
};

export function buildPublicOrderItemFromPersisted(row: OrderItemRow): PublicOrderItem {
  const obs = String(row.observation || '').trim() || undefined;
  const summary = obs || '';
  const lines = splitOrderItemDetailLines(summary);
  const vid = row.variation_id != null ? Number(row.variation_id) : null;
  const pname = row.product_name || 'Produto';
  return {
    product_id: Number(row.product_id),
    quantity: Number(row.quantity),
    type: row.type || undefined,
    price_at_time: Number(row.price_at_time || 0),
    variation_id: Number.isInteger(vid) && vid > 0 ? vid : null,
    product_name: pname,
    product_category: row.product_category ?? null,
    production_type: row.production_type ?? null,
    requires_preparation: row.requires_preparation ?? null,
    name: pname,
    observation: obs,
    obs_opcoes: obs,
    selecoes: parseOrderItemSelecoesJson(row.selecoes_json),
    item_display_summary: summary,
    item_display_details: lines,
  };
}

type NormalizedOrderItem = {
  product_id: number;
  quantity: number;
  type?: string;
  price_at_time: number;
  variation_id: number | null;
  observation: string | null;
  selecoes_json: string | null;
};

type StockAdjustmentItem = Pick<NormalizedOrderItem, 'product_id' | 'quantity' | 'variation_id'>;

type NormalizedPayment = {
  method: string;
  amount_paid: number;
  change_given: number;
};

type NormalizedCreateOrderInput = {
  items: NormalizedOrderItem[];
  payments: NormalizedPayment[];
  observation?: string;
  total_amount: number;
  taxa_total: number;
  tipo_retirada: string;
  canal: string;
  status: string;
  cliente_id: number | null;
};

type OrderRow = {
  id: number;
  order_number: string;
  status: string;
  canal?: string | null;
  total_amount: number;
  subtotal?: number | null;
  pagamento_tipo?: string | null;
  pagamento_status?: string | null;
  pagamento_confirmado_at?: string | null;
  pagamento_confirmado_valor?: number | string | null;
  observation?: string | null;
  receipt_text?: string | null;
  created_at: string;
  tipo_retirada?: string | null;
  senha_pedido?: number | null;
  cancelado_at?: string | null;
  cancelamento_motivo?: string | null;
  cancelado_por?: number | null;
  estoque_reposto?: number | boolean | null;
  estoque_reposto_at?: string | null;
  reembolso_status?: string | null;
  valor_reembolsado?: number | null;
  reembolsado_at?: string | null;
  reembolso_motivo?: string | null;
  reembolsado_por?: number | null;
};

type ProductRow = {
  id: number;
  name: string;
  category?: string | null;
  production_type?: string | null;
  requires_preparation?: number | null;
  codigo_barras?: string | null;
};

type IngredientStockRow = {
  estoque_atual: number | string | null;
};

type StockMovementSummaryRow = {
  ingrediente_id: number;
  quantity: number | string;
};

type PaymentRow = {
  amount_paid: number | string | null;
  change_given: number | string | null;
};

type OrderPaymentAggregateRow = {
  order_id: number | string;
  payment_total_received: number | string | null;
  payment_total_change: number | string | null;
  payment_total_paid: number | string | null;
  payment_count: number | string | null;
};

type LatestPixPaymentStatusRow = {
  order_id: number | string;
  status: string | null;
  paid_at?: string | null;
};

type OrderAutomationFlagsRow = {
  pedido_id: number | string;
  automation_auto_delivery_accept: boolean | null;
  automation_kitchen_failed: boolean | null;
  automation_kitchen_ok: boolean | null;
};

type OrderHistoryEventRow = {
  id: number;
  tipo: string;
  status_anterior?: string | null;
  status_novo?: string | null;
  valor?: number | string | null;
  motivo?: string | null;
  estoque_reposto?: number | boolean | null;
  payload?: string | Record<string, unknown> | null;
  usuario_id?: number | null;
  created_at: string;
};

const MONEY_TOLERANCE_CENTS = 1;
const MAX_GET_ORDERS_LIMIT = 500;

function isCanceledStatus(status?: string | null) {
  return String(status || '').trim().toLowerCase() === 'cancelado';
}

function ensureTenantId(tenantId: TenantId) {
  if (tenantId === null || tenantId === undefined || tenantId === '') {
    throw new AppError('Tenant inválido', 400);
  }
}

function parseOrderId(orderId: number | string) {
  const parsed = Number(orderId);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError('Pedido inválido', 400);
  }

  return parsed;
}

function normalizePaymentStatusKey(status?: string | null) {
  return String(status || '').trim().toLowerCase();
}

function isPixPaymentPaidLike(status?: string | null) {
  const normalized = normalizePaymentStatusKey(status);
  return normalized === 'approved' || normalized === 'paid';
}

/** Mesma regra do item de pedido (balcão): observation ou obs_opcoes, trim e limite de tamanho. */
export function normalizeOrderLineObservation(observation?: unknown, obs_opcoes?: unknown): string | null {
  const raw = observation ?? obs_opcoes;
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_ITEM_OBSERVATION_LEN
    ? trimmed.slice(0, MAX_ITEM_OBSERVATION_LEN)
    : trimmed;
}

function normalizeItemObservationField(item: OrderItemInput): string | null {
  return normalizeOrderLineObservation(item.observation, item.obs_opcoes);
}

function normalizeOrderItem(item: OrderItemInput, index: number): NormalizedOrderItem {
  const productId = Number(item.product_id);
  const quantity = Number(item.quantity);
  const priceAtTime = Number(item.price_at_time ?? item.unitPrice);

  if (!Number.isInteger(productId) || productId <= 0) {
    throw new AppError(`Item ${index + 1} com produto inválido`, 400);
  }

  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new AppError(`Item ${index + 1} com quantidade inválida`, 400);
  }

  if (!Number.isFinite(priceAtTime) || priceAtTime < 0) {
    throw new AppError(`Item ${index + 1} com preço inválido`, 400);
  }

  const vid = Number(item.variation_id);
  const variation_id = Number.isInteger(vid) && vid > 0 ? vid : null;

  return {
    product_id: productId,
    quantity,
    type: item.type?.trim() || undefined,
    price_at_time: priceAtTime,
    variation_id,
    observation: normalizeItemObservationField(item),
    selecoes_json: serializeOrderItemSelecoes(item.selecoes),
  };
}

function normalizePayment(payment: PaymentInput, index: number): NormalizedPayment {
  const method = String(payment.method || '').trim();
  const amountPaid = Number(payment.amount_paid ?? payment.amount);
  const changeGiven = Number(payment.change_given || 0);

  if (!method) {
    throw new AppError(`Pagamento ${index + 1} sem método`, 400);
  }

  if (!ALLOWED_PAYMENT_METHODS.has(normalizePaymentMethodKey(method))) {
    throw new AppError(`Método de pagamento inválido: ${method}`, 400);
  }

  if (!Number.isFinite(amountPaid) || amountPaid < 0) {
    throw new AppError(`Pagamento ${index + 1} com valor inválido`, 400);
  }

  if (!Number.isFinite(changeGiven) || changeGiven < 0) {
    throw new AppError(`Pagamento ${index + 1} com troco inválido`, 400);
  }

  if (changeGiven > amountPaid) {
    throw new AppError(`Pagamento ${index + 1} com troco maior que o valor pago`, 400);
  }

  return {
    method,
    amount_paid: amountPaid,
    change_given: changeGiven,
  };
}

function deriveOrderChannel(tipoRetirada?: string | null, currentCanal?: string | null) {
  const canal = String(currentCanal || '').trim().toLowerCase();
  if (canal === 'delivery' || canal === 'mesa' || canal === 'retirada' || canal === 'balcao') {
    return canal;
  }

  return String(tipoRetirada || '').trim().toLowerCase() === 'levar' ? 'retirada' : 'balcao';
}

function toMoneyCents(value: number) {
  return Math.round((value + Number.EPSILON) * 100);
}

function centsToMoney(cents: number) {
  return cents / 100;
}

function summarizePaymentMethod(payments: NormalizedPayment[]): string | null {
  const uniqueMethods = Array.from(
    new Set(
      payments
        .map((payment) => String(payment.method || '').trim())
        .filter(Boolean)
    )
  );
  if (uniqueMethods.length === 0) return null;
  if (uniqueMethods.length === 1) return uniqueMethods[0];
  return 'Misto';
}

function calculateItemsSubtotal(items: NormalizedOrderItem[]): number {
  return items.reduce(
    (sum, item) => sum + Number(item.quantity) * Number(item.price_at_time),
    0
  );
}

function ensureFinancialConsistency(input: {
  items: NormalizedOrderItem[];
  payments: NormalizedPayment[];
  total_amount: number;
  taxa_total: number;
}) {
  const itemsTotalCents = input.items.reduce(
    (sum, item) => sum + toMoneyCents(Number(item.quantity) * Number(item.price_at_time)),
    0
  );
  const paymentsTotalCents = input.payments.reduce(
    (sum, payment) => sum + toMoneyCents(Number(payment.amount_paid) - Number(payment.change_given)),
    0
  );
  const orderTotalCents = toMoneyCents(input.total_amount);
  const feeTotalCents = toMoneyCents(input.taxa_total);
  const expectedOrderTotalCents = itemsTotalCents + feeTotalCents;
  const expectedPaymentsTotalCents = paymentsTotalCents + feeTotalCents;

  if (Math.abs(expectedOrderTotalCents - orderTotalCents) > MONEY_TOLERANCE_CENTS) {
    throw new AppError('Total do pedido divergente da soma dos itens', 400);
  }

  if (Math.abs(expectedPaymentsTotalCents - orderTotalCents) > MONEY_TOLERANCE_CENTS) {
    throw new AppError('Total do pedido divergente da soma dos pagamentos', 400);
  }
}

function extractRawComboSelections(rawItem: OrderItemInput): unknown {
  const sel = rawItem.selecoes;
  if (sel && typeof sel === 'object' && !Array.isArray(sel) && 'combo' in sel) {
    return (sel as { combo?: unknown }).combo;
  }
  return sel;
}

async function applyAuthoritativeComboItemsToOrder(
  tenantId: TenantId,
  items: NormalizedOrderItem[],
  rawItems: OrderItemInput[]
): Promise<NormalizedOrderItem[]> {
  if (items.length !== rawItems.length) {
    throw new AppError('Itens do pedido inconsistentes', 400);
  }
  const tid = Number(tenantId);
  const productIds = [...new Set(items.map((i) => i.product_id))];
  if (productIds.length === 0) return items;

  const rows = await qAll<{ id: number; is_combo: number; price: number }>(
    `SELECT id, COALESCE(is_combo,0) AS is_combo, price
     FROM produtos
     WHERE tenant_id=? AND id IN (${productIds.map(() => '?').join(',')})`,
    [tid, ...productIds]
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));

  const out: NormalizedOrderItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const n = items[i];
    const raw = rawItems[i];
    const meta = byId.get(n.product_id);
    if (!meta) {
      throw new AppError(`Produto ${n.product_id} não encontrado`, 404);
    }
    if (Number(meta.is_combo) !== 1) {
      out.push(n);
      continue;
    }
    const vid = n.variation_id != null ? Number(n.variation_id) : null;
    if (vid !== null && Number.isInteger(vid) && vid > 0) {
      throw new AppError('Combo não aceita variação vendável', 400);
    }
    const { validado: comboValidado, adicionaisTotal } = await validateAuthoritativeComboSelections({
      tenantId: tid,
      comboProductId: n.product_id,
      rawCombo: extractRawComboSelections(raw),
    });
    const price_at_time = Number(meta.price || 0) + Number(adicionaisTotal || 0);
    out.push({
      ...n,
      variation_id: null,
      price_at_time,
      selecoes_json: serializeOrderItemSelecoes({ combo: comboValidado }),
    });
  }
  return out;
}

async function normalizeCreateOrderInput(data: CreateOrderInput, tenantId: TenantId): Promise<NormalizedCreateOrderInput> {
  if (!Array.isArray(data.items) || data.items.length === 0) {
    throw new AppError('Pedido precisa ter pelo menos 1 item', 400);
  }

  if (!Array.isArray(data.payments) || data.payments.length === 0) {
    throw new AppError('Pedido precisa ter pelo menos 1 pagamento', 400);
  }

  const totalAmount = Number(data.total_amount ?? data.total);
  const taxaTotal = Number(data.taxa_total ?? 0);

  if (!Number.isFinite(totalAmount) || totalAmount < 0) {
    throw new AppError('Valor total inválido', 400);
  }

  if (!Number.isFinite(taxaTotal) || taxaTotal < 0) {
    throw new AppError('Taxa total inválida', 400);
  }

  const canal = deriveOrderChannel(data.tipo_retirada);
  const defaultStatus = canal === 'balcao' ? 'Em Preparo' : 'Criado';
  const status = data.status?.trim() || defaultStatus;

  if (!ALLOWED_ORDER_STATUSES.has(status)) {
    throw new AppError('Status inválido', 400);
  }

  let clienteId: number | null = null;
  if (data.cliente_id !== undefined && data.cliente_id !== null && data.cliente_id !== '') {
    const cid = Number(data.cliente_id);
    if (!Number.isInteger(cid) || cid <= 0) {
      throw new AppError('Cliente inválido', 400);
    }
    clienteId = cid;
  }

  const itemsBase = data.items.map(normalizeOrderItem);
  const itemsResolved = await applyAuthoritativeComboItemsToOrder(tenantId, itemsBase, data.items);

  const normalizedInput = {
    items: itemsResolved,
    payments: data.payments.map(normalizePayment),
    observation: data.observation?.trim() || undefined,
    total_amount: totalAmount,
    taxa_total: taxaTotal,
    tipo_retirada: data.tipo_retirada?.trim() || 'local',
    canal: deriveOrderChannel(data.tipo_retirada),
    status,
    cliente_id: clienteId,
  };

  ensureFinancialConsistency(normalizedInput);

  return normalizedInput;
}

function getCurrentOrderDateParts() {
  const dateObj = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  const fullYear = String(dateObj.getFullYear());
  const y = fullYear.slice(-2);
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');

  return {
    dailyKey: `${fullYear}${m}${d}`,
    orderDate: `${y}${m}${d}`,
  };
}

async function generateOrderNumber(client: PoolClient, tenantId: TenantId) {
  const { dailyKey, orderDate } = getCurrentOrderDateParts();

  await txQ1(
    client,
    'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))',
    [String(tenantId), dailyKey]
  );

  const todayRow = await txQ1<{ last_number: string | number | null }>(
    client,
    `SELECT COALESCE(MAX(senha_pedido), COUNT(*), 0) as last_number
     FROM pedidos
     WHERE (created_at AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date
       AND tenant_id=?`,
    [tenantId]
  );

  const nextNumber = Number(todayRow?.last_number || 0) + 1;

  return {
    nextNumber,
    orderNumber: `${orderDate}-${tenantId}-${nextNumber.toString().padStart(3, '0')}`,
  };
}

async function ensureProductsExist(items: NormalizedOrderItem[], tenantId: TenantId) {
  const productIds = [...new Set(items.map((item) => item.product_id))];

  if (productIds.length === 0) {
    throw new AppError('Pedido sem produtos', 400);
  }

  const rows = await qAll<{ id: number }>(
    `SELECT id
     FROM produtos
     WHERE tenant_id=?
       AND id IN (${productIds.map(() => '?').join(',')})`,
    [tenantId, ...productIds]
  );

  const foundIds = new Set(rows.map((row) => Number(row.id)));
  const missingId = productIds.find((id) => !foundIds.has(id));

  if (missingId) {
    throw new AppError(`Produto ${missingId} não encontrado`, 404);
  }
}

async function orderHasPreparationItems(client: PoolClient, orderId: number, tenantId: TenantId) {
  const items = await txQAll<{
    product_name?: string | null;
    product_category?: string | null;
    production_type?: string | null;
    requires_preparation?: number | null;
  }>(
    client,
    `SELECT p.name AS product_name, p.category AS product_category, p.requires_preparation, p.production_type
     FROM itens_pedido ip
     JOIN produtos p ON p.id=ip.product_id
     WHERE ip.order_id=? AND ip.tenant_id=?`,
    [orderId, tenantId]
  );

  return items.some((item) =>
    resolveRequiresPreparation({
      name: item.product_name,
      category: item.product_category,
      requires_preparation: item.requires_preparation,
      production_type: item.production_type,
    })
  );
}

async function insertOrderItems(
  client: PoolClient,
  orderId: number,
  items: NormalizedOrderItem[],
  tenantId: TenantId
) {
  for (const item of items) {
    await txRun(
      client,
      'INSERT INTO itens_pedido (order_id,product_id,quantity,type,price_at_time,tenant_id,variation_id,observation,selecoes_json) VALUES (?,?,?,?,?,?,?,?,?)',
      [
        orderId,
        item.product_id,
        item.quantity,
        item.type,
        item.price_at_time,
        tenantId,
        item.variation_id,
        item.observation,
        item.selecoes_json,
      ]
    );
  }
}

async function savePayments(
  client: PoolClient,
  orderId: number,
  payments: NormalizedPayment[],
  tenantId: TenantId
) {
  for (const payment of payments) {
    await txRun(
      client,
      'INSERT INTO pagamentos (order_id,method,amount_paid,change_given,tenant_id) VALUES (?,?,?,?,?)',
      [orderId, payment.method, payment.amount_paid, payment.change_given, tenantId]
    );
  }
}

function buildStockMovementReason(direction: 'saida' | 'entrada', orderId?: number) {
  const baseReason = direction === 'saida' ? 'Venda automática' : 'Exclusão de pedido';

  return orderId ? `${baseReason} | pedido:${orderId}` : baseReason;
}

async function applyIngredientStockChange(
  client: PoolClient,
  ingredientId: number,
  tenantId: TenantId,
  requestedQuantity: number,
  direction: 'saida' | 'entrada'
) {
  if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
    return 0;
  }

  const ingredientStock = await txQ1<IngredientStockRow>(
    client,
    `SELECT COALESCE(estoque_atual, 0) AS estoque_atual
     FROM ingredientes
     WHERE id=? AND tenant_id=?
     FOR UPDATE`,
    [ingredientId, tenantId]
  );

  if (!ingredientStock) {
    return 0;
  }

  const currentStock = Math.max(Number(ingredientStock.estoque_atual || 0), 0);

  if (direction === 'saida') {
    const deductedQuantity = Math.min(currentStock, requestedQuantity);

    if (deductedQuantity > 0) {
      await txRun(
        client,
        'UPDATE ingredientes SET estoque_atual=? WHERE id=? AND tenant_id=?',
        [currentStock - deductedQuantity, ingredientId, tenantId]
      );
    }

    return deductedQuantity;
  }

  await txRun(
    client,
    'UPDATE ingredientes SET estoque_atual=? WHERE id=? AND tenant_id=?',
    [currentStock + requestedQuantity, ingredientId, tenantId]
  );

  return requestedQuantity;
}

async function adjustStockForItem(
  client: PoolClient,
  item: StockAdjustmentItem,
  tenantId: TenantId,
  direction: 'saida' | 'entrada',
  failOnMissingProduct = true,
  orderId?: number
) {
  const product = await txQ1<ProductRow>(
    client,
    'SELECT id, name, codigo_barras FROM produtos WHERE id=? AND tenant_id=?',
    [item.product_id, tenantId]
  );

  if (!product) {
    if (failOnMissingProduct) {
      throw new AppError(`Produto ${item.product_id} não encontrado`, 404);
    }

    return;
  }

  const movementLabel = buildStockMovementReason(direction, orderId);

  const resolution = await requireProductInventoryTargets({
    client,
    tenantId,
    productId: item.product_id,
    variationId: item.variation_id,
    context: 'ordersService.adjustStockForItem',
    orderId,
    direction,
  });

  for (const target of resolution?.targets || []) {
    const requestedQuantity = Number(target.quantityMultiplier) * Number(item.quantity);
    const movedQuantity = await applyIngredientStockChange(
      client,
      Number(target.ingredientId),
      tenantId,
      requestedQuantity,
      direction
    );

    if (movedQuantity > 0) {
      await txRun(
        client,
        `INSERT INTO estoque_movimentacoes (ingrediente_id,tipo,quantidade,motivo,tenant_id)
         VALUES (?,?,?,?,?)`,
        [target.ingredientId, direction, movedQuantity, movementLabel, tenantId]
      );
    }
  }
}

async function processStockDeduction(
  client: PoolClient,
  items: NormalizedOrderItem[],
  tenantId: TenantId,
  orderId: number,
  inventoryEnabled: boolean
) {
  if (!inventoryEnabled) {
    return;
  }

  for (const item of items) {
    await adjustStockForItem(client, item, tenantId, 'saida', true, orderId);
  }
}

async function restoreStockFromRecordedMovements(
  client: PoolClient,
  orderId: number,
  tenantId: TenantId,
  entryContext: 'delete' | 'cancel' = 'delete'
) {
  const outgoingReason = buildStockMovementReason('saida', orderId);
  const incomingReason =
    entryContext === 'cancel'
      ? `Cancelamento de pedido | pedido:${orderId}`
      : buildStockMovementReason('entrada', orderId);

  const movementTotals = await txQAll<StockMovementSummaryRow>(
    client,
    `SELECT ingrediente_id, SUM(quantidade) AS quantity
     FROM estoque_movimentacoes
     WHERE tenant_id=?
       AND tipo='saida'
       AND motivo=?
     GROUP BY ingrediente_id`,
    [tenantId, outgoingReason]
  );

  if (movementTotals.length === 0) {
    return false;
  }

  for (const movement of movementTotals) {
    const quantity = Number(movement.quantity || 0);

    if (quantity <= 0) {
      continue;
    }

    await applyIngredientStockChange(
      client,
      Number(movement.ingrediente_id),
      tenantId,
      quantity,
      'entrada'
    );

    await txRun(
      client,
      `INSERT INTO estoque_movimentacoes (ingrediente_id,tipo,quantidade,motivo,tenant_id)
       VALUES (?,?,?,?,?)`,
      [movement.ingrediente_id, 'entrada', quantity, incomingReason, tenantId]
    );
  }

  return true;
}

async function restoreStockForOrder(
  client: PoolClient,
  orderId: number,
  tenantId: TenantId,
  entryContext: 'delete' | 'cancel' = 'delete',
  inventoryEnabled = true
) {
  const restoredFromMovements = await restoreStockFromRecordedMovements(
    client,
    orderId,
    tenantId,
    entryContext
  );

  if (restoredFromMovements || !inventoryEnabled) {
    return;
  }

  const items = await txQAll<OrderItemRow>(
    client,
    `SELECT order_id, product_id, quantity, type, price_at_time, variation_id
     FROM itens_pedido
     WHERE order_id=?`,
    [orderId]
  );

  for (const item of items) {
    const vid = item.variation_id != null ? Number(item.variation_id) : null;
    await adjustStockForItem(
      client,
      {
        product_id: Number(item.product_id),
        quantity: Number(item.quantity),
        variation_id: Number.isInteger(vid) && vid > 0 ? vid : null,
      },
      tenantId,
      'entrada',
      false,
      orderId
    );
  }
}

async function createOrderEvent(
  client: PoolClient,
  input: {
    pedidoId: number;
    tenantId: TenantId;
    tipo: string;
    statusAnterior?: string | null;
    statusNovo?: string | null;
    valor?: number;
    motivo?: string | null;
    estoqueReposto?: boolean;
    payload?: Record<string, unknown>;
    usuarioId?: number;
  }
) {
  await txRun(
    client,
    `INSERT INTO pedido_eventos
      (pedido_id,tenant_id,tipo,status_anterior,status_novo,valor,motivo,estoque_reposto,payload,usuario_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      input.pedidoId,
      input.tenantId,
      input.tipo,
      input.statusAnterior || null,
      input.statusNovo || null,
      Number(input.valor || 0),
      input.motivo || null,
      input.estoqueReposto ? 1 : 0,
      input.payload ? JSON.stringify(input.payload) : null,
      input.usuarioId || null,
    ]
  );
}

function parseEventPayload(
  payload: OrderHistoryEventRow['payload']
): Record<string, unknown> | null {
  if (!payload) return null;
  if (typeof payload === 'object') return payload;

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function mapOrderHistoryEvent(row: OrderHistoryEventRow): OrderHistoryEvent {
  return {
    id: row.id,
    tipo: row.tipo,
    status_anterior: row.status_anterior || null,
    status_novo: row.status_novo || null,
    valor: row.valor === null || row.valor === undefined ? null : Number(row.valor),
    motivo: row.motivo || null,
    estoque_reposto: Boolean(Number(row.estoque_reposto || 0)),
    payload: parseEventPayload(row.payload),
    usuario_id: row.usuario_id || null,
    created_at: row.created_at,
    synthetic: false,
  };
}

async function generateReceipt(
  client: PoolClient,
  {
    items,
    payments,
    observation,
    total_amount,
    orderNumber,
    orderId,
    tenantId,
    canal,
    tipoRetirada,
  }: {
    items: NormalizedOrderItem[];
    payments: NormalizedPayment[];
    observation?: string;
    total_amount: number;
    orderNumber: string;
    orderId: number;
    tenantId: TenantId;
    canal: string;
    tipoRetirada: string;
  }
) {
  const now = new Date().toLocaleString('pt-BR', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const clientRow = await txQ1<{ nome_estabelecimento: string; printer_config?: string | null }>(
    client,
    'SELECT nome_estabelecimento, printer_config FROM clientes WHERE id=?',
    [tenantId]
  );

  const productIds = items.map((item) => item.product_id);
  const productMap: Record<number, string> = {};

  if (productIds.length > 0) {
    const productRows = await txQAll<ProductRow>(
      client,
      `SELECT id, name, category, requires_preparation, production_type
       FROM produtos
       WHERE id IN (${productIds.map(() => '?').join(',')})
         AND tenant_id=?`,
      [...productIds, tenantId]
    );

    for (const product of productRows) {
      productMap[product.id] = product.name;
    }
  }

  const receiptHtml = gerarCupomHtml({
    titulo: 'RECIBO',
    estabelecimento: clientRow?.nome_estabelecimento || 'FlowPDV',
    orderNumber,
    data: now,
    variant: 'receipt',
    canal: canal === 'retirada' ? 'retirada' : 'balcao',
    paperWidthMm: getProfilePaperWidthMm(clientRow?.printer_config, 'caixa'),
    metadata: [{
      label: 'Operacao',
      value: tipoRetirada === 'levar' ? 'Retirada no local' : 'Venda de balcao',
    }],
    itens: items.map((item) => ({
      qtd: item.quantity,
      nome: productMap[item.product_id] || 'Produto',
      valor: Number(item.price_at_time) * Number(item.quantity),
      obs: item.observation || undefined,
    })),
    totais: [{ label: 'TOTAL', valor: total_amount, destaque: true }],
    pagamentos: payments.map((payment) => ({
      metodo: payment.method,
      valor: payment.amount_paid,
      troco: payment.change_given > 0 ? payment.change_given : undefined,
    })),
    observacao: observation || undefined,
  });

  await txRun(
    client,
    'UPDATE pedidos SET receipt_text=? WHERE id=? AND tenant_id=?',
    [receiptHtml, orderId, tenantId]
  );

  return receiptHtml;
}

function buildOrderFilters(filters: GetOrdersFilters) {
  const clauses = ['tenant_id=?'];
  const params: unknown[] = [filters.tenantId];

  if (filters.status) {
    clauses.push('status=?');
    params.push(filters.status);
  }

  if (filters.canal) {
    clauses.push('canal=?');
    params.push(filters.canal);
  }

  if (filters.excludeCanal) {
    clauses.push("COALESCE(canal, '')<>?");
    params.push(filters.excludeCanal);
  }

  if (filters.activeOnly) {
    clauses.push('cancelado_at IS NULL');
    clauses.push("LOWER(COALESCE(status,'')) <> 'entregue'");
    clauses.push("LOWER(COALESCE(status,'')) <> 'cancelado'");
    clauses.push("LOWER(COALESCE(status,'')) NOT LIKE 'conclu%'");
    // Pedidos ativos: mostrar apenas do dia atual (fuso BR) para não congestionar a tela.
    // Pedidos de dias anteriores ainda abertos ficam acessíveis na aba Histórico.
    if (filters.todayOnly !== false) {
      clauses.push(`(created_at AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date`);
    }
  }

  if (filters.from) {
    clauses.push(`(created_at AT TIME ZONE '${TZ}')::date >= ?`);
    params.push(filters.from);
  }

  if (filters.to) {
    clauses.push(`(created_at AT TIME ZONE '${TZ}')::date <= ?`);
    params.push(filters.to);
  }

  if (filters.day) {
    clauses.push(`TO_CHAR(created_at AT TIME ZONE '${TZ}', 'DD')=?`);
    params.push(String(filters.day).padStart(2, '0'));
  }

  if (filters.month) {
    clauses.push(`TO_CHAR(created_at AT TIME ZONE '${TZ}', 'MM')=?`);
    params.push(String(filters.month).padStart(2, '0'));
  }

  if (filters.year) {
    clauses.push(`TO_CHAR(created_at AT TIME ZONE '${TZ}', 'YYYY')=?`);
    params.push(String(filters.year));
  }

  return { clauses, params };
}

export async function createOrder(data: CreateOrderInput, tenantId: TenantId) {
  ensureTenantId(tenantId);

  const input = await normalizeCreateOrderInput(data, tenantId);

  try {
    await ensureProductsExist(input.items, tenantId);
    const inventoryEnabled = await tenantHasInventoryFeature(tenantId);

    const result = await withTx(async (client) => {
      const { nextNumber, orderNumber } = await generateOrderNumber(client, tenantId);
      const senhaPedido = nextNumber;
      const paymentMethod = summarizePaymentMethod(input.payments);
      const subtotal = calculateItemsSubtotal(input.items);

      let clienteNome: string | null = null;
      let clienteTel: string | null = null;
      let resolvedClienteId: number | null = input.cliente_id;
      if (resolvedClienteId) {
        const cust = await txQ1<{ id: number; nome: string | null; telefone: string | null }>(
          client,
          `SELECT id, nome, telefone FROM delivery_clientes
           WHERE id=? AND tenant_id=? AND COALESCE(ativo,1)=1`,
          [resolvedClienteId, tenantId]
        );
        if (!cust) {
          throw new AppError('Cliente não encontrado', 404);
        }
        clienteNome = String(cust.nome || '').trim() || null;
        clienteTel = cust.telefone ? String(cust.telefone) : null;
      }

      const orderId = Number(
        await txInsert(
          client,
          `INSERT INTO pedidos
            (order_number,status,total_amount,observation,tenant_id,senha_pedido,tipo_retirada,canal,pagamento_tipo,pagamento_status,subtotal,cliente_id,cliente_nome,cliente_tel)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            orderNumber,
            input.status,
            input.total_amount,
            input.observation || null,
            tenantId,
            senhaPedido,
            input.tipo_retirada,
            input.canal,
            paymentMethod,
            'pago',
            subtotal,
            resolvedClienteId,
            clienteNome,
            clienteTel,
          ]
        )
      );

      await insertOrderItems(client, orderId, input.items, tenantId);
      await processStockDeduction(client, input.items, tenantId, orderId, inventoryEnabled);
      await savePayments(client, orderId, input.payments, tenantId);
      await createOrderEvent(client, {
        pedidoId: orderId,
        tenantId,
        tipo: 'CRIACAO',
        statusNovo: input.status,
        valor: input.total_amount,
        payload: {
          origem: 'ordersService.createOrder',
          itens: input.items.length,
          pagamentos: input.payments.length,
          tipo_retirada: input.tipo_retirada,
          canal: input.canal,
        },
      });

      const receipt = await generateReceipt(client, {
        items: input.items,
        payments: input.payments,
        observation: input.observation,
        total_amount: input.total_amount,
        orderNumber,
        orderId,
        tenantId,
        canal: input.canal,
        tipoRetirada: input.tipo_retirada,
      });

      return {
        orderId,
        orderNumber,
        receipt,
        senhaPedido,
        resolvedClienteId,
        paymentMethod,
        customerName: clienteNome,
        status: input.status,
      };
    });

    let paymentPix: Awaited<ReturnType<typeof createPixPayment>> = null;
    if (result.resolvedClienteId) {
      void touchStoreCustomerPurchase({
        clienteId: result.resolvedClienteId,
        tenantId: Number(tenantId),
        origemCadastro: 'balcao',
      }).catch((err) => logError('ordersService.createOrder.touchCliente', err, { tenantId, orderId: result.orderId }));
    }

    await orderCreatedWhatsAppEvent({
      tenantId,
      orderId: result.orderId,
      source: 'ordersService.createOrder',
    });
    await emitWhatsAppOrderStatusEvent({
      tenantId,
      orderId: result.orderId,
      status: result.status,
      source: 'ordersService.createOrder.initialStatus',
    });

    try {
      const cfgRow = await q1<{ delivery_config: string | null }>('SELECT delivery_config FROM clientes WHERE id=?', [tenantId]);
      const parsed = coerceDeliveryConfigRow(cfgRow?.delivery_config ?? null);
      const isPixOrder = normalizePaymentMethodKey(result.paymentMethod || '') === 'pix';

      if (isPixOrder) {
        try {
          paymentPix = await createPixPayment({
            tenant_id: tenantId,
            order_id: result.orderId,
            amount: input.total_amount,
            customer_name: result.customerName,
            external_reference: result.orderNumber,
            description: `Pedido #${result.orderNumber} - FlowPDV`,
            metadata: {
              channel: input.canal,
              order_number: result.orderNumber,
              source: 'ordersService.createOrder',
            },
          });
        } catch (err) {
          logError('ordersService.createOrder.createPixPayment', err, {
            tenantId,
            orderId: result.orderId,
            orderNumber: result.orderNumber,
          });
        }
      }

      const automation = parseAutomationFromDeliveryConfigJson(parsed);
      if (shouldAutoPrintForBalcaoOrder(automation, input.canal, input.tipo_retirada)) {
        void runAutomatedKitchenPrintForOrder(Number(tenantId), result.orderId, { trigger: 'balcao_order_create' }).catch(
          (err) => logError('ordersService.createOrder.autoKitchenPrintUnhandled', err, { tenantId, orderId: result.orderId })
        );
      }
    } catch (e) {
      logError('ordersService.createOrder.autoKitchenPrintConfig', e, { tenantId });
    }

    notifyTenantOrderStreams(Number(tenantId), 'new', { orderId: result.orderId });

    return {
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      receipt: result.receipt,
      senhaPedido: result.senhaPedido,
      payment_pix: paymentPix,
    };
  } catch (error) {
    logError('ordersService.createOrder', error, { tenantId });
    throw error;
  }
}

export async function cancelOrder(input: CancelOrderInput) {
  ensureTenantId(input.tenantId);

  const orderId = parseOrderId(input.orderId);
  const subsenha = String(input.subsenha || '').trim();
  const motivo = String(input.motivo || '').trim();
  const shouldRestoreStock = Boolean(input.estoque_reposto);

  if (motivo.length < 3) {
    throw new AppError('Motivo do cancelamento Ã© obrigatÃ³rio', 400);
  }

  try {
    await validateSecurityPassword({
      tenantId: input.tenantId,
      userId: input.userId,
      password: subsenha,
      type: 'admin',
      requiredMessage: 'Subsenha obrigatÃ³ria',
      invalidMessage: 'Subsenha invÃ¡lida',
    });

    const inventoryEnabled = await tenantHasInventoryFeature(input.tenantId);

    const updatedOrder = await withTx(async (client) => {
      const order = await txQ1<OrderRow>(
        client,
        `SELECT *
         FROM pedidos
         WHERE id=? AND tenant_id=?
         FOR UPDATE`,
        [orderId, input.tenantId]
      );

      if (!order) {
        throw new AppError('Pedido nÃ£o encontrado', 404);
      }

      if (isCanceledStatus(order.status)) {
        throw new AppError('Pedido cancelado não pode ser alterado', 400);
      } 

      if (shouldRestoreStock) {
        await restoreStockForOrder(client, orderId, input.tenantId, 'cancel', inventoryEnabled);
      }

      await txRun(
        client,
        `UPDATE pedidos
         SET status='Cancelado',
             cancelado_at=NOW(),
             cancelamento_motivo=?,
             cancelado_por=?,
             estoque_reposto=?,
             estoque_reposto_at=CASE WHEN ?=1 THEN NOW() ELSE NULL END
         WHERE id=? AND tenant_id=?`,
        [
          motivo,
          input.userId || null,
          shouldRestoreStock ? 1 : 0,
          shouldRestoreStock ? 1 : 0,
          orderId,
          input.tenantId,
        ]
      );

      await createOrderEvent(client, {
        pedidoId: orderId,
        tenantId: input.tenantId,
        tipo: 'CANCELAMENTO',
        statusAnterior: order.status,
        statusNovo: 'Cancelado',
        motivo,
        estoqueReposto: shouldRestoreStock,
        payload: {
          origem: 'ordersService.cancelOrder',
        },
        usuarioId: input.userId,
      });

      return await txQ1<OrderRow>(
        client,
        'SELECT * FROM pedidos WHERE id=? AND tenant_id=?',
        [orderId, input.tenantId]
      );
    });
    await orderCancelledWhatsAppEvent({
      tenantId: input.tenantId,
      orderId,
      source: 'ordersService.cancelOrder',
    });
    notifyTenantOrderStreams(Number(input.tenantId), 'status', { orderId });
    return updatedOrder;
  } catch (error) {
    logError('ordersService.cancelOrder', error, {
      orderId,
      userId: input.userId,
      tenantId: input.tenantId,
      estoque_reposto: shouldRestoreStock,
    });
    throw error;
  }
}

export async function deleteOrder(input: DeleteOrderInput) {
  ensureTenantId(input.tenantId);

  const orderId = parseOrderId(input.orderId);
  const subsenha = String(input.subsenha || '').trim();

  try {
    await validateSecurityPassword({
      tenantId: input.tenantId,
      userId: input.userId,
      password: subsenha,
      type: 'admin',
      requiredMessage: 'Subsenha obrigatória',
      invalidMessage: 'Subsenha inválida',
    });

    const inventoryEnabled = await tenantHasInventoryFeature(input.tenantId);

    await withTx(async (client) => {
      const order = await txQ1<{ id: number }>(
        client,
        'SELECT id FROM pedidos WHERE id=? AND tenant_id=?',
        [orderId, input.tenantId]
      );

      if (!order) {
        throw new AppError('Pedido não encontrado', 404);
      }

      await restoreStockForOrder(client, orderId, input.tenantId, 'delete', inventoryEnabled);

      await txRun(client, 'DELETE FROM pagamentos WHERE order_id=?', [orderId]);
      await txRun(client, 'DELETE FROM itens_pedido WHERE order_id=?', [orderId]);
      await txRun(client, 'DELETE FROM pedidos WHERE id=? AND tenant_id=?', [orderId, input.tenantId]);

      return { success: true };
    });
    notifyTenantOrderStreams(Number(input.tenantId), 'status', { orderId });
    return { success: true };
  } catch (error) {
    logError('ordersService.deleteOrder', error, {
      orderId,
      userId: input.userId,
      tenantId: input.tenantId,
    });
    throw error;
  }
}

export async function refundOrder(input: RefundOrderInput) {
  ensureTenantId(input.tenantId);

  const orderId = parseOrderId(input.orderId);
  const subsenha = String(input.subsenha || '').trim();
  const motivo = String(input.motivo || '').trim();
  const refundValue = Number(input.valor);

  if (motivo.length < 3) {
    throw new AppError('Motivo do reembolso e obrigatorio', 400);
  }

  if (!Number.isFinite(refundValue) || refundValue <= 0) {
    throw new AppError('Valor do reembolso invalido', 400);
  }

  try {
    await validateSecurityPassword({
      tenantId: input.tenantId,
      userId: input.userId,
      password: subsenha,
      type: 'admin',
      requiredMessage: 'Subsenha obrigatoria',
      invalidMessage: 'Subsenha invalida',
    });

    const updatedOrder = await withTx(async (client) => {
      const order = await txQ1<OrderRow>(
        client,
        `SELECT *
         FROM pedidos
         WHERE id=? AND tenant_id=?
         FOR UPDATE`,
        [orderId, input.tenantId]
      );

      if (!order) {
        throw new AppError('Pedido nao encontrado', 404);
      }

      const payments = await txQAll<PaymentRow>(
        client,
        `SELECT amount_paid, change_given
         FROM pagamentos
         WHERE order_id=? AND tenant_id=?
         FOR UPDATE`,
        [orderId, input.tenantId]
      );

      if (payments.length === 0) {
        throw new AppError('Pedido sem pagamentos para reembolso', 400);
      }

      const totalPaidCents = payments.reduce(
        (sum, payment) =>
          sum +
          toMoneyCents(Number(payment.amount_paid || 0) - Number(payment.change_given || 0)),
        0
      );

      if (totalPaidCents <= 0) {
        throw new AppError('Pedido sem valor pago disponivel para reembolso', 400);
      }

      const alreadyRefundedCents = toMoneyCents(Number(order.valor_reembolsado || 0));
      const refundValueCents = toMoneyCents(refundValue);
      const availableRefundCents = Math.max(totalPaidCents - alreadyRefundedCents, 0);

      if (availableRefundCents <= 0) {
        throw new AppError('Pedido ja foi totalmente reembolsado', 400);
      }

      if (refundValueCents - availableRefundCents > MONEY_TOLERANCE_CENTS) {
        throw new AppError('Reembolso nao pode exceder o valor pago', 400);
      }

      const nextRefundedCents = alreadyRefundedCents + refundValueCents;
      const isTotalRefund = totalPaidCents - nextRefundedCents <= MONEY_TOLERANCE_CENTS;
      const persistedRefundedCents = isTotalRefund ? totalPaidCents : nextRefundedCents;
      const refundStatus = isTotalRefund ? 'total' : 'parcial';

      await txRun(
        client,
        `UPDATE pedidos
         SET reembolso_status=?,
             valor_reembolsado=?,
             reembolsado_at=NOW(),
             reembolso_motivo=?,
             reembolsado_por=?
         WHERE id=? AND tenant_id=?`,
        [
          refundStatus,
          centsToMoney(persistedRefundedCents),
          motivo,
          input.userId || null,
          orderId,
          input.tenantId,
        ]
      );

      await createOrderEvent(client, {
        pedidoId: orderId,
        tenantId: input.tenantId,
        tipo: 'REEMBOLSO',
        statusAnterior: order.status,
        statusNovo: order.status,
        valor: centsToMoney(refundValueCents),
        motivo,
        payload: {
          origem: 'ordersService.refundOrder',
          reembolso_status: refundStatus,
          valor_pago: centsToMoney(totalPaidCents),
          valor_reembolsado_anterior: centsToMoney(alreadyRefundedCents),
          valor_reembolsado_atual: centsToMoney(persistedRefundedCents),
        },
        usuarioId: input.userId,
      });

      return await txQ1<OrderRow>(
        client,
        'SELECT * FROM pedidos WHERE id=? AND tenant_id=?',
        [orderId, input.tenantId]
      );
    });
    notifyTenantOrderStreams(Number(input.tenantId), 'status', { orderId });
    return updatedOrder;
  } catch (error) {
    logError('ordersService.refundOrder', error, {
      orderId,
      userId: input.userId,
      tenantId: input.tenantId,
      valor: refundValue,
    });
    throw error;
  }
}

export async function updateOrderStatus(input: UpdateOrderStatusInput) {
  ensureTenantId(input.tenantId);
  
  const orderId = parseOrderId(input.orderId);
  const status = String(input.status || '').trim();

  if (!status) {
    throw new AppError('Status é obrigatório', 400);
  }

  if (!ALLOWED_ORDER_STATUSES.has(status)) {
    throw new AppError('Status inválido', 400);
  }

  if (isCanceledStatus(status)) {
    throw new AppError('Use o fluxo de cancelamento para cancelar pedidos', 400);
  }

  try {
    const result = await withTx(async (client) => {
      const order = await txQ1<OrderRow>(
        client,
        `SELECT *
         FROM pedidos
         WHERE id=? AND tenant_id=?
         FOR UPDATE`,
        [orderId, input.tenantId]
      );

      if (!order) {
        throw new AppError('Pedido não encontrado', 404);
      }
      
      if (order.status === 'Aguardando confirmação') {
        throw new AppError('Pedido via QR Code precisa ser confirmado antes de alterar o status', 400);
      }

      if (isCanceledStatus(order.status) || order.cancelado_at) {
        throw new AppError('Pedido cancelado nao pode ter status alterado', 400);
      }

      if (order.status === status) {
        return {
          updatedOrder: order,
          statusChanged: false,
        };
      }

      if (String(order.canal || '').trim().toLowerCase() === 'delivery') {
        throw new AppError(
          'Pedido de delivery nao pode ser avancado por aqui. Use a aba Delivery para continuar o fluxo e definir o motoboy.',
          400
        );
      }

      const effectiveStatus =
        status === 'Em Preparo' && !(await orderHasPreparationItems(client, orderId, input.tenantId))
          ? 'Pronto'
          : status;

      await txRun(
        client,
        'UPDATE pedidos SET status=? WHERE id=? AND tenant_id=?',
        [effectiveStatus, orderId, input.tenantId]
      );

      await createOrderEvent(client, {
        pedidoId: orderId,
        tenantId: input.tenantId,
        tipo: 'STATUS',
        statusAnterior: order.status,
        statusNovo: effectiveStatus,
        payload: {
          origem: 'ordersService.updateOrderStatus',
          requested_status: status,
        },
        usuarioId: input.userId,
      });

      const updatedOrder = await txQ1<OrderRow>(
        client,
        'SELECT * FROM pedidos WHERE id=? AND tenant_id=?',
        [orderId, input.tenantId]
      );

      if (!updatedOrder) {
        throw new AppError('Pedido nao encontrado apos atualizar status', 500);
      }

      return {
        updatedOrder,
        statusChanged: String(order.status || '').trim() !== String(effectiveStatus || '').trim(),
      };
    });

    if (result.statusChanged) {
      await emitWhatsAppOrderStatusEvent({
        tenantId: input.tenantId,
        orderId,
        status: result.updatedOrder?.status,
        source: 'ordersService.updateOrderStatus',
      });
    }

    notifyTenantOrderStreams(Number(input.tenantId), 'status', { orderId });
    return result.updatedOrder;
  } catch (error) {
    logError('ordersService.updateOrderStatus', error, {
      orderId,
      status,
      tenantId: input.tenantId,
    });
    throw error;
  }
}

export async function getOrderHistory(input: GetOrderHistoryInput) {
  ensureTenantId(input.tenantId);

  const orderId = parseOrderId(input.orderId);

  try {
    const order = await q1<Pick<OrderRow, 'id' | 'created_at' | 'status' | 'total_amount'>>(
      `SELECT id, created_at, status, total_amount
       FROM pedidos
       WHERE id=? AND tenant_id=?`,
      [orderId, input.tenantId]
    );

    if (!order) {
      throw new AppError('Pedido não encontrado', 404);
    }

    const rows = await qAll<OrderHistoryEventRow>(
      `SELECT id, tipo, status_anterior, status_novo, valor, motivo, estoque_reposto, payload, usuario_id, created_at
       FROM pedido_eventos
       WHERE pedido_id=? AND tenant_id=?
       ORDER BY created_at ASC, id ASC`,
      [orderId, input.tenantId]
    );

    const events = rows.map(mapOrderHistoryEvent);

    if (!events.some((event) => event.tipo === 'CRIACAO')) {
      events.unshift({
        id: `synthetic-created-${orderId}`,
        tipo: 'CRIACAO',
        status_anterior: null,
        status_novo: null,
        valor: Number(order.total_amount || 0),
        motivo: null,
        estoque_reposto: false,
        payload: {
          origem: 'ordersService.getOrderHistory',
        },
        usuario_id: null,
        created_at: order.created_at,
        synthetic: true,
      });
    }

    return events;
  } catch (error) {
    logError('ordersService.getOrderHistory', error, {
      orderId,
      tenantId: input.tenantId,
    });
    throw error;
  }
}

export async function getOrders(filters: GetOrdersFilters) {
  ensureTenantId(filters.tenantId);

  try {
    const { clauses, params } = buildOrderFilters(filters);
    let sql = `
      SELECT *
      FROM pedidos
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
    `;

    if (filters.limit !== undefined && filters.limit !== '') {
      const parsedLimit = Number(filters.limit);
      const safeLimit = Number.isFinite(parsedLimit)
        ? Math.min(Math.max(parsedLimit, 1), MAX_GET_ORDERS_LIMIT)
        : 20;

      sql += ` LIMIT ${safeLimit}`;
    }

    const orders = await qAll<OrderRow>(sql, params);

    if (orders.length === 0) {
      return [];
    }

    const orderIds = orders.map((order) => order.id);
    const latestPixPaymentRows = await qAll<LatestPixPaymentStatusRow>(
      `SELECT DISTINCT ON (order_id) order_id, status, paid_at
       FROM pedido_pagamentos
       WHERE tenant_id=? AND order_id IN (${orderIds.map(() => '?').join(',')}) AND LOWER(method)='pix'
       ORDER BY order_id, created_at DESC, id DESC`,
      [filters.tenantId, ...orderIds]
    );
    const latestPixPaymentByOrder = new Map<number, LatestPixPaymentStatusRow>();

    for (const row of latestPixPaymentRows) {
      latestPixPaymentByOrder.set(Number(row.order_id), row);
    }

    const pixOrdersToConfirm = orders.filter((order) => {
      if (String(order.pagamento_tipo || '').trim().toLowerCase() !== 'pix') return false;
      if (normalizePaymentStatusKey(order.pagamento_status) === 'pago') return false;
      return isPixPaymentPaidLike(latestPixPaymentByOrder.get(Number(order.id))?.status);
    });

    if (pixOrdersToConfirm.length > 0) {
      const pixConfirmationResults = await Promise.allSettled(
        pixOrdersToConfirm.map((order) =>
          confirmOrderPayment({
            orderId: order.id,
            tenantId: filters.tenantId,
          })
        )
      );

      pixConfirmationResults.forEach((result, index) => {
        const order = pixOrdersToConfirm[index];
        if (result.status === 'fulfilled') {
          order.pagamento_status = result.value.pagamento_status;
          order.pagamento_confirmado_at = result.value.paid_at;
          order.pagamento_confirmado_valor = result.value.amount_paid;
          return;
        }
        logError('ordersService.getOrders.confirmPendingPix', result.reason, {
          tenantId: filters.tenantId,
          orderId: order.id,
        });
      });
    }

    const pendingRetiradaPixOrders = orders.filter((order) => {
      if (String(order.canal || '').trim().toLowerCase() !== 'retirada') return false;
      if (String(order.pagamento_tipo || '').trim().toLowerCase() !== 'pix') return false;
      if (normalizePaymentStatusKey(order.pagamento_status) === 'pago') return false;
      return true;
    });

    if (pendingRetiradaPixOrders.length > 0) {
      const pixRevalidationResults = await Promise.allSettled(
        pendingRetiradaPixOrders.map((order) =>
          revalidatePixPaymentByOrder({
            orderId: order.id,
            tenantId: filters.tenantId,
          })
        )
      );

      pixRevalidationResults.forEach((result, index) => {
        const order = pendingRetiradaPixOrders[index];
        if (result.status === 'fulfilled') {
          const approvedLike =
            normalizePaymentStatusKey(result.value.externalStatus) === 'approved' ||
            normalizePaymentStatusKey(result.value.externalStatus) === 'paid';
          if (approvedLike || result.value.orderUpdated) {
            order.pagamento_status = 'pago';
            if (result.value.paidAt) {
              order.pagamento_confirmado_at = result.value.paidAt;
            }
          }
          return;
        }
        logError('ordersService.getOrders.revalidatePendingRetiradaPix', result.reason, {
          tenantId: filters.tenantId,
          orderId: order.id,
        });
      });
    }

    const items = await qAll<OrderItemRow>(
      `SELECT ip.order_id, ip.product_id, ip.quantity, ip.type, ip.price_at_time,
              ip.observation, ip.selecoes_json,
              p.name AS product_name, p.category AS product_category,
              p.production_type, p.requires_preparation
       FROM itens_pedido ip
       LEFT JOIN produtos p ON p.id=ip.product_id
       WHERE ip.order_id IN (${orderIds.map(() => '?').join(',')})
       ORDER BY ip.id ASC`,
      orderIds
    );
    const paymentAggRows = await qAll<OrderPaymentAggregateRow>(
      `SELECT order_id,
              COALESCE(SUM(amount_paid), 0) AS payment_total_received,
              COALESCE(SUM(change_given), 0) AS payment_total_change,
              COALESCE(SUM(amount_paid - change_given), 0) AS payment_total_paid,
              COUNT(*) AS payment_count
       FROM pagamentos
       WHERE order_id IN (${orderIds.map(() => '?').join(',')})
       GROUP BY order_id`,
      orderIds
    );

    const automationRows = await qAll<OrderAutomationFlagsRow>(
      `SELECT pedido_id,
              BOOL_OR(tipo = 'AUTOMATION_DELIVERY_ACEITE_AUTO') AS automation_auto_delivery_accept,
              BOOL_OR(tipo = 'AUTOMATION_COZINHA_FALHA') AS automation_kitchen_failed,
              BOOL_OR(tipo = 'AUTOMATION_COZINHA_OK') AS automation_kitchen_ok
       FROM pedido_eventos
       WHERE tenant_id = ? AND pedido_id IN (${orderIds.map(() => '?').join(',')})
       GROUP BY pedido_id`,
      [filters.tenantId, ...orderIds]
    );

    const itemsByOrder = new Map<number, OrderItemRow[]>();
    const paymentsByOrder = new Map<
      number,
      { totalReceived: number; totalChange: number; totalPaid: number; count: number }
    >();
    const automationByOrder = new Map<
      number,
      { autoDeliveryAccept: boolean; kitchenFailed: boolean; kitchenOk: boolean }
    >();

    for (const row of automationRows) {
      automationByOrder.set(Number(row.pedido_id), {
        autoDeliveryAccept: Boolean(row.automation_auto_delivery_accept),
        kitchenFailed: Boolean(row.automation_kitchen_failed),
        kitchenOk: Boolean(row.automation_kitchen_ok),
      });
    }

    for (const item of items) {
      const bucket = itemsByOrder.get(Number(item.order_id)) || [];
      bucket.push(item);
      itemsByOrder.set(Number(item.order_id), bucket);
    }

    for (const payment of paymentAggRows) {
      paymentsByOrder.set(Number(payment.order_id), {
        totalReceived: Number(payment.payment_total_received || 0),
        totalChange: Number(payment.payment_total_change || 0),
        totalPaid: Number(payment.payment_total_paid || 0),
        count: Number(payment.payment_count || 0),
      });
    }

    return orders.map((order) => {
      const orderItems = (itemsByOrder.get(Number(order.id)) || []).map((item) =>
        buildPublicOrderItemFromPersisted(item)
      );
      const derivedSubtotal = orderItems.reduce(
        (sum, item) => sum + Number(item.quantity) * Number(item.price_at_time || 0),
        0
      );
      const auto = automationByOrder.get(Number(order.id));
      const payAgg = paymentsByOrder.get(Number(order.id));

      const base = {
        ...order,
        estoque_reposto: Boolean(Number(order.estoque_reposto || 0)),
        subtotal: Number(order.subtotal || 0) > 0 ? Number(order.subtotal) : derivedSubtotal,
        payment_total_received: payAgg?.totalReceived || 0,
        payment_total_change: payAgg?.totalChange || 0,
        payment_total_paid: payAgg?.totalPaid || 0,
        payment_count: payAgg?.count || 0,
        items: orderItems,
        automation_auto_delivery_accept: auto?.autoDeliveryAccept ?? false,
        automation_kitchen_failed: auto?.kitchenFailed ?? false,
        automation_kitchen_ok: auto?.kitchenOk ?? false,
      };

      const settled = isOrderFullyPaid(base as unknown as Order);

      return {
        ...base,
        payment_status: settled ? ('paid' as const) : ('pending' as const),
        payment_method: order.pagamento_tipo ?? null,
        paid_at: order.pagamento_confirmado_at ?? null,
        amount_paid: settled
          ? Number(
              order.pagamento_confirmado_valor ??
                payAgg?.totalPaid ??
                order.total_amount ??
                0
            )
          : null,
      };
    });
  } catch (error) {
    logError('ordersService.getOrders', error, {
      tenantId: filters.tenantId,
      status: filters.status,
      from: filters.from,
      to: filters.to,
    });
    throw error;
  }

}

export async function confirmQrOrder(input: { orderId: number | string; tenantId: TenantId; userId?: number }) {
  ensureTenantId(input.tenantId);
  const orderId = parseOrderId(input.orderId);

  try {
    const novoStatus = await withTx(async (client) => {
      // 1. Busca o pedido travando a linha (FOR UPDATE)
      const order = await txQ1<OrderRow>(
        client,
        `SELECT * FROM pedidos WHERE id=? AND tenant_id=? FOR UPDATE`,
        [orderId, input.tenantId]
      );

      if (!order) {
        throw new AppError('Pedido não encontrado', 404);
      }

      if (order.status !== 'Aguardando confirmação') {
        throw new AppError('Pedido não está aguardando confirmação', 400);
      }

      // 2. Verifica se algum item precisa de preparo na cozinha
      const requiresPrep = await orderHasPreparationItems(client, orderId, input.tenantId);
      const nextStatus = requiresPrep ? 'Em Preparo' : 'Pronto';

      // 3. Atualiza o status
      await txRun(
        client,
        'UPDATE pedidos SET status=? WHERE id=? AND tenant_id=?',
        [nextStatus, orderId, input.tenantId]
      );

      // 4. Registra no histórico do pedido
      await createOrderEvent(client, {
        pedidoId: orderId,
        tenantId: input.tenantId,
        tipo: 'STATUS',
        statusAnterior: order.status,
        statusNovo: nextStatus,
        payload: { origem: 'ordersService.confirmQrOrder' },
        usuarioId: input.userId,
      });

      return nextStatus;
    });
    await emitWhatsAppOrderStatusEvent({
      tenantId: input.tenantId,
      orderId,
      status: novoStatus,
      source: 'ordersService.confirmQrOrder',
    });
    notifyTenantOrderStreams(Number(input.tenantId), 'status', { orderId });
    return novoStatus;
  } catch (error) {
    logError('ordersService.confirmQrOrder', error, { orderId, tenantId: input.tenantId });
    throw error;
  }
}

function paymentMethodLabelFromPedidoTipo(pagamentoTipo: string | null | undefined): string {
  const t = String(pagamentoTipo || '').trim().toLowerCase();
  if (t === 'dinheiro') return 'Dinheiro';
  if (t === 'pix') return 'PIX';
  if (t === 'cartao' || t === 'cartão') return 'Cartão';
  return String(pagamentoTipo || '').trim() || 'Pagamento';
}

export type ConfirmOrderPaymentResult = {
  payment_status: 'paid';
  pagamento_status: 'pago';
  paid_at: string | null;
  amount_paid: number;
  payment_total_paid: number;
};

/**
 * Confirma pagamento na retirada/entrega (ou completa registro financeiro): `pagamento_status = pago`,
 * grava `pagamento_confirmado_*` e insere linha em `pagamentos` quando o caixa ainda não refletia o total.
 */
export async function confirmOrderPayment(input: ConfirmOrderPaymentInput): Promise<ConfirmOrderPaymentResult> {
  ensureTenantId(input.tenantId);
  const orderId = parseOrderId(input.orderId);

  try {
    const result = await withTx(async (client) => {
      const order = await txQ1<OrderRow>(
        client,
        `SELECT * FROM pedidos WHERE id=? AND tenant_id=? FOR UPDATE`,
        [orderId, input.tenantId]
      );

      if (!order) {
        throw new AppError('Pedido não encontrado', 404);
      }

      if (order.cancelado_at) {
        throw new AppError('Pedido cancelado não pode ter pagamento confirmado', 400);
      }

      const total = Number(order.total_amount || 0);
      const paymentRows = await txQAll<PaymentRow>(
        client,
        `SELECT amount_paid, change_given FROM pagamentos WHERE order_id=? AND tenant_id=?`,
        [orderId, input.tenantId]
      );

      const paidCents = paymentRows.reduce(
        (sum, p) => sum + toMoneyCents(Number(p.amount_paid || 0) - Number(p.change_given || 0)),
        0
      );
      const totalCents = toMoneyCents(total);
      const shortfallCents = totalCents - paidCents;

      if (String(order.pagamento_status || '').trim().toLowerCase() === 'pago' && shortfallCents <= MONEY_TOLERANCE_CENTS) {
        const snap = await txQ1<{ pagamento_confirmado_at: string | null; pagamento_confirmado_valor: number | string | null }>(
          client,
          `SELECT pagamento_confirmado_at, pagamento_confirmado_valor FROM pedidos WHERE id=? AND tenant_id=?`,
          [orderId, input.tenantId]
        );
        return {
          skipNotify: true as const,
          isPixPayment: normalizePaymentMethodKey(String(order.pagamento_tipo || '')) === 'pix',
          paid_at: snap?.pagamento_confirmado_at || null,
          amount_paid: Number(snap?.pagamento_confirmado_valor ?? total),
          payment_total_paid: centsToMoney(paidCents),
        };
      }

      if (shortfallCents > MONEY_TOLERANCE_CENTS) {
        const method = paymentMethodLabelFromPedidoTipo(order.pagamento_tipo);
        const amountToInsert = centsToMoney(shortfallCents);
        await txRun(
          client,
          `INSERT INTO pagamentos (order_id, method, amount_paid, change_given, tenant_id) VALUES (?,?,?,?,?)`,
          [orderId, method, amountToInsert, 0, input.tenantId]
        );
      }

      await txRun(
        client,
        `UPDATE pedidos
         SET pagamento_status='pago',
             pagamento_confirmado_at=NOW(),
             pagamento_confirmado_valor=?
         WHERE id=? AND tenant_id=?`,
        [total, orderId, input.tenantId]
      );

      const snap = await txQ1<{ pagamento_confirmado_at: string | null; pagamento_confirmado_valor: number | string | null }>(
        client,
        `SELECT pagamento_confirmado_at, pagamento_confirmado_valor FROM pedidos WHERE id=? AND tenant_id=?`,
        [orderId, input.tenantId]
      );

      const paidRowsAfter = await txQAll<PaymentRow>(
        client,
        `SELECT amount_paid, change_given FROM pagamentos WHERE order_id=? AND tenant_id=?`,
        [orderId, input.tenantId]
      );
      const totalPaidAfterCents = paidRowsAfter.reduce(
        (sum, p) => sum + toMoneyCents(Number(p.amount_paid || 0) - Number(p.change_given || 0)),
        0
      );

      await createOrderEvent(client, {
        pedidoId: orderId,
        tenantId: input.tenantId,
        tipo: 'PAGAMENTO_CONFIRMADO',
        valor: total,
        payload: {
          origem: 'ordersService.confirmOrderPayment',
          amount_paid: total,
          metodo_resumo: order.pagamento_tipo || null,
        },
        usuarioId: input.userId,
      });

      return {
        skipNotify: false as const,
        isPixPayment: normalizePaymentMethodKey(String(order.pagamento_tipo || '')) === 'pix',
        paid_at: snap?.pagamento_confirmado_at || null,
        amount_paid: total,
        payment_total_paid: centsToMoney(totalPaidAfterCents),
      };
    });

    if (!result.skipNotify) {
      notifyTenantOrderStreams(Number(input.tenantId), 'status', { orderId });
    }

    if (!result.skipNotify && result.isPixPayment && input.emitWhatsAppPaymentConfirmed) {
      await orderPaymentConfirmedWhatsAppEvent({
        tenantId: input.tenantId,
        orderId,
        source: input.source || 'ordersService.confirmOrderPayment',
      });
    }

    const { skipNotify: _sn, ...rest } = result;
    return {
      payment_status: 'paid',
      pagamento_status: 'pago',
      paid_at: rest.paid_at,
      amount_paid: rest.amount_paid,
      payment_total_paid: rest.payment_total_paid,
    };
  } catch (error) {
    logError('ordersService.confirmOrderPayment', error, { orderId, tenantId: input.tenantId });
    throw error;
  }
}

/** Corpo da API POST /mesas/:id/comanda/adicionar — preço e observação vêm do cliente (como no balcão), sem recálculo. */
export type MesaComandaAddItemBody = {
  product_id?: unknown;
  product_name?: unknown;
  quantity?: unknown;
  price_at_time?: unknown;
  observation?: unknown;
  obs_opcoes?: unknown;
  variation_id?: unknown;
  selecoes?: unknown;
};

export type MesaComandaAddItemResult = {
  comanda_id: number;
  mesa_id: number;
  quantity_added: number;
  product_id: number;
  price_at_time: number;
  variation_id: number | null;
  observation: string | null;
  selecoes_json: string | null;
};

function parseMesaComandaAddItem(body: MesaComandaAddItemBody, indexLabel: string) {
  const productId = Number(body.product_id);
  const productName = String(body.product_name ?? '').trim();
  const quantity = Number(body.quantity);
  const priceAtTime = Number(body.price_at_time);

  if (!Number.isInteger(productId) || productId <= 0) {
    throw new AppError(`${indexLabel}: produto inválido`, 400);
  }
  if (!productName) {
    throw new AppError(`${indexLabel}: nome do produto obrigatório`, 400);
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new AppError(`${indexLabel}: quantidade inválida`, 400);
  }
  if (!Number.isFinite(priceAtTime) || priceAtTime < 0) {
    throw new AppError(`${indexLabel}: preço inválido`, 400);
  }

  const vid = Number(body.variation_id);
  const variation_id = Number.isInteger(vid) && vid > 0 ? vid : null;
  const observation = normalizeOrderLineObservation(body.observation, body.obs_opcoes);
  const selecoes_json = serializeOrderItemSelecoes(body.selecoes);

  return {
    product_id: productId,
    product_name: productName,
    quantity,
    price_at_time: priceAtTime,
    variation_id,
    observation,
    selecoes_json,
  };
}

/**
 * Abre comanda na mesa se necessário e insere/atualiza linha distinguindo adicionais (observation + variation_id).
 * Não consulta preço em produtos.
 */
export async function addItemToMesaComanda(input: {
  tenantId: TenantId;
  mesaId: number;
  body: MesaComandaAddItemBody;
}): Promise<MesaComandaAddItemResult> {
  ensureTenantId(input.tenantId);
  const tenantId = Number(input.tenantId);
  const mesaId = Number(input.mesaId);
  if (!Number.isInteger(mesaId) || mesaId <= 0) {
    throw new AppError('Mesa inválida', 400);
  }

  const item = parseMesaComandaAddItem(input.body, 'Item');

  // CORREÇÃO: todo o "achar/abrir comanda da mesa + achar linha existente +
  // somar quantidade" roda dentro de uma transação com lock na linha da mesa
  // (`FOR UPDATE`). Sem isso, dois lançamentos quase simultâneos pro mesmo
  // item (dois toques em "adicionar" em sequência rápida, ou um retry de
  // rede duplicando a requisição) podiam cada um checar "já existe essa
  // linha na comanda?" antes do outro terminar de gravar, os dois não
  // acharem nada, e os dois criarem uma linha nova em vez de uma só linha
  // com a quantidade somada — ou, dependendo da ordem de commit, uma
  // sobrescrever silenciosamente o incremento da outra. O lock serializa
  // essas chamadas pra mesma mesa e fecha essa corrida.
  const comandaId = await withTx(async (client) => {
    const mesa = await txQ1<{ id: number }>(client, 'SELECT id FROM mesas WHERE id=? AND tenant_id=? FOR UPDATE', [
      mesaId,
      tenantId,
    ]);
    if (!mesa) {
      throw new AppError('Mesa não encontrada', 404);
    }

    let comanda = await txQ1<{ id: number }>(
      client,
      "SELECT id FROM comandas WHERE mesa_id=? AND status='aberta' AND tenant_id=? LIMIT 1",
      [mesaId, tenantId]
    );
    if (!comanda) {
      await txRun(client, "UPDATE mesas SET status='aberta', opened_at=NOW() WHERE id=? AND tenant_id=?", [
        mesaId,
        tenantId,
      ]);
      const cid = await txInsert(client, "INSERT INTO comandas (mesa_id,tenant_id,status) VALUES (?,?,'aberta')", [
        mesaId,
        tenantId,
      ]);
      comanda = await txQ1<{ id: number }>(client, 'SELECT id FROM comandas WHERE id=?', [cid]);
      if (!comanda) {
        throw new AppError('Falha ao abrir comanda', 500);
      }
    }

    const ex = await txQ1<{ id: number }>(
      client,
      `SELECT id FROM itens_comanda
       WHERE comanda_id=? AND product_id=? AND tenant_id=?
         AND observation IS NOT DISTINCT FROM ?
         AND variation_id IS NOT DISTINCT FROM ?
         AND selecoes_json IS NOT DISTINCT FROM ?
       FOR UPDATE`,
      [comanda.id, item.product_id, tenantId, item.observation, item.variation_id, item.selecoes_json]
    );

    if (ex) {
      await txRun(client, 'UPDATE itens_comanda SET quantity=quantity+? WHERE id=? AND tenant_id=?', [
        item.quantity,
        ex.id,
        tenantId,
      ]);
    } else {
      await txInsert(
        client,
        'INSERT INTO itens_comanda (comanda_id,product_id,product_name,quantity,price_at_time,tenant_id,observation,variation_id,selecoes_json) VALUES (?,?,?,?,?,?,?,?,?)',
        [
          comanda.id,
          item.product_id,
          item.product_name,
          item.quantity,
          item.price_at_time,
          tenantId,
          item.observation,
          item.variation_id,
          item.selecoes_json,
        ]
      );
    }

    return comanda.id;
  });

  return {
    comanda_id: comandaId,
    mesa_id: mesaId,
    quantity_added: item.quantity,
    product_id: item.product_id,
    price_at_time: item.price_at_time,
    variation_id: item.variation_id,
    observation: item.observation,
    selecoes_json: item.selecoes_json,
  };
}

export {
  resolveKitchenChannelUi,
  buildKitchenReceiptHtml,
  filterKitchenPreparationItems,
  buildKitchenEscPosPlainText,
  KITCHEN_PRINT_FEATURE_FLAGS,
} from './kitchenPrintService';