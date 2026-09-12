// src/routes/delivery-public.ts - rotas publicas sem autenticacao de tenant
import type { PoolClient } from 'pg';
import { Router, type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { q1, qAll, qRun, qInsert, withTx, txQ1, txQAll, txRun, txInsert } from '../db';
import {
  publicRateLimit,
  deliveryPublicPedidoCreateRateLimit,
  deliveryPublicPedidoResumoRateLimit,
  authDeliveryCliente,
  optionalAuthDeliveryCliente,
  JWT_SECRET,
  requireTrustedBrowserOrigin,
} from '../middleware';
import { type PlanFeature } from '../config/planFeatures';
import { resolveProductInventoryTargets } from '../services/stockIdentification';
import { serializeOrderItemSelecoes } from '../services/ordersService';
import { getTenantFeaturesBySlug, tenantHasInventoryFeature } from '../services/tenantPlan';
import { AppError, isAppError } from '../utils/errors';
import { logError } from '../utils/logger';
import { sendInternalError } from '../utils/internalServerError';
import { parseAutomationFromDeliveryConfigJson } from '../services/automationConfig';
import {
  recordDeliveryAutoAcceptOnline,
  runAutomatedKitchenPrintForOrder,
} from '../services/operationalAutomationService';
import { validateDeliveryItems } from '../services/deliveryItemValidation';
import { createPixPayment, getPaymentByOrderId } from '../services/paymentsService';
import { revalidatePixPaymentByOrder } from '../services/pixPaymentRevalidationService';
import { batchLoadComboGruposForCardapio } from '../services/productComboValidation';
import { notifyTenantOrderStreams } from '../sse';
import { normalizeCardapioOnlineBannerSlots } from '../utils/deliveryCardapioBannerSlots';
import { applyNormalizedBannerSlots, coerceDeliveryConfigRow } from '../utils/deliveryConfigPersist';
import {
  computeOperatingStatusFromLegacy,
  computeOperatingStatusFromWeeklySchedule,
  type DeliveryOperatingStatus,
  type WeekdayJs,
} from '../utils/deliveryOperatingHours';
import {
  findDeliveryZoneByBairro,
  MENSAGEM_ENTREGA_FORA_DA_AREA,
} from '../utils/deliveryBairroZona';
import { resolveTenantLogoPublicUrl } from '../utils/tenantLogoUpload';
import { normalizeProductPhotoPublicUrl } from '../utils/productPhotoUrl';
import {
  PRIMEIRA_COMPRA_PEDIDO_VALIDO_SQL,
  buildDeliveryAddressAntiFraudSignature,
  normalizeBrazilDeliveryPhoneDigits,
  signatureFromPedidoEnderecoFields,
} from '../utils/deliveryFirstPurchaseEligibility';
import { parseBodyOrReply, replyZod400ErrorKey } from '../validation/zodHttp';
import {
  deliveryCadastrarBodySchema,
  deliveryIdentificarBodySchema,
  deliveryPerfilPutBodySchema,
} from '../validation/schemas/publicForms';

const TZ = 'America/Sao_Paulo';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

type DeliveryPublicOrderEventInput = {
  pedidoId: number;
  tenantId: number;
  tipo: string;
  statusAnterior?: string | null;
  statusNovo?: string | null;
  valor?: number;
  motivo?: string | null;
  estoqueReposto?: boolean;
  payload?: Record<string, unknown>;
  usuarioId?: number;
};

function buildDeliveryPublicOrderEventParams(input: DeliveryPublicOrderEventInput) {
  return [
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
  ];
}

async function insertDeliveryPublicOrderEventTx(
  client: PoolClient,
  input: DeliveryPublicOrderEventInput
) {
  await txRun(
    client,
    `INSERT INTO pedido_eventos
      (pedido_id,tenant_id,tipo,status_anterior,status_novo,valor,motivo,estoque_reposto,payload,usuario_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    buildDeliveryPublicOrderEventParams(input)
  );
}

type DeliveryZone = { nome: string; taxa: number };
type OrderChannel = 'delivery' | 'retirada';
type FirstCustomerDiscountType = 'percentual' | 'fixo' | 'frete_gratis';
type FirstCustomerDiscountReason =
  | 'inativo'
  | 'cliente_nao_identificado'
  | 'pedido_abaixo_minimo'
  /** Já existe pedido válido (cardápio) para este cadastro `delivery_cliente_id`. */
  | 'existing_customer_history'
  /** Pedido válido anterior com o mesmo telefone normalizado (conta diferente ou legado). */
  | 'same_phone_previous_order'
  /** Pedido válido anterior com mesma assinatura de endereço (logradouro+número+bairro). */
  | 'same_address_previous_order'
  | 'sem_valor_configurado'
  | 'sem_taxa_entrega'
  | 'frete_ja_bonificado'
  | 'aplicado';

type DeliveryConfig = {
  taxa_entrega?: number;
  pedido_minimo?: number;
  tempo_preparo?: number;
  pix_chave?: string;
  pix_nome?: string;
  pix_cidade?: string;
  pix_payload_estatico?: string;
  whatsapp?: string;
  horario_abertura?: string;
  horario_fechamento?: string;
  /** Se true, usa `horarios_semana` (janelas por dia) em vez do modelo legado. */
  horarios_semana_ativo?: boolean;
  /** Agenda semanal: por dia (0=dom ... 6=sáb), até 2 janelas. */
  horarios_semana?: unknown;
  desconto_pix?: number;
  valor_por_entrega?: number;
  zonas_entrega?: DeliveryZone[];
  desconto_primeiro_cliente_ativo?: boolean;
  desconto_primeiro_cliente_tipo?: FirstCustomerDiscountType;
  desconto_primeiro_cliente_valor?: number;
  desconto_primeiro_cliente_min_pedido?: number;
  /** Cardápio online: `dark_premium` (padrão) | `light_red` */
  theme_mode?: string;
  /** Logo exclusiva do cardápio (sobrepõe logo em Configurações / uploads/logo). */
  cardapio_online_logo_url?: string;
  /** Até 4 URLs de banner do topo (`/uploads/delivery/...`), índices 0–3. */
  cardapio_online_banner_urls?: string[];
  cardapio_banner_slots?: string[] | Record<string, string> | string;
  /** Dias da semana sem delivery (0=domingo … 6=sábado, mesmo critério de `Date#getDay`). */
  dias_folga_entrega?: number[];
  /** Restaurante sem motoboy próprio: usa entregador avulso/por demanda. Quando true, o
   *  checkout só libera Pix (sem troco/maquininha para o entregador levar). */
  motoboy_sob_demanda?: boolean;
};

type DeliveryAddressRecord = {
  id: number;
  label?: string | null;
  logradouro?: string | null;
  numero?: string | null;
  complemento?: string | null;
  bairro?: string | null;
  referencia?: string | null;
  principal?: number;
};

type CheckoutSummary = {
  modelo_entrega: 'bairro_fixo';
  bairro_entrega: string | null;
  subtotal: number;
  desconto_pix: number;
  subtotal_apos_desconto_pix: number;
  taxa_entrega: number;
  zona_entrega: DeliveryZone | null;
  /** Quando há zonas cadastradas e o bairro informado não casa com nenhuma. */
  entrega_bloqueada_por_zona?: boolean;
  mensagem_entrega_bloqueada?: string;
  desconto_cupom: number;
  cupom_aplicado: any | null;
  cupom_invalido?: string;
  desconto_primeiro_cliente: number;
  primeiro_cliente: {
    ativo: boolean;
    elegivel: boolean;
    aplicado: boolean;
    tipo: FirstCustomerDiscountType;
    valor_configurado: number;
    min_pedido: number;
    descricao: string;
    motivo: FirstCustomerDiscountReason;
    mensagem: string;
  };
  total: number;
  itensValidados: any[];
};

const MAX_ITEM_OBSERVATION_LEN = 4000;
const MAX_PEDIDO_OBSERVATION_LEN = 8000;
const MAX_CONTATO_RECEBIMENTO_RAW = 40;

function normalizeItemObservationForDb(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.length > MAX_ITEM_OBSERVATION_LEN ? s.slice(0, MAX_ITEM_OBSERVATION_LEN) : s;
}

/** Telefone opcional de quem recebe/atende o pedido (não altera `cliente_tel` da conta). */
function normalizeOptionalContatoRecebimentoTel(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().slice(0, MAX_CONTATO_RECEBIMENTO_RAW);
  if (!s) return null;
  const d = normalizeBrazilDeliveryPhoneDigits(s);
  if (d.length < 10 || d.length > 11) return null;
  return d;
}

function mergeDeliveryPublicOrderObservation(clienteObservation: unknown, contatoDigits: string | null): string | null {
  const base = String(clienteObservation ?? '').trim();
  if (!contatoDigits) return base.length ? base : null;
  const tag = `[Contato no local] ${contatoDigits}`;
  if (!base) return tag.length > MAX_PEDIDO_OBSERVATION_LEN ? tag.slice(0, MAX_PEDIDO_OBSERVATION_LEN) : tag;
  const merged = `${tag}\n${base}`;
  return merged.length > MAX_PEDIDO_OBSERVATION_LEN ? merged.slice(0, MAX_PEDIDO_OBSERVATION_LEN) : merged;
}

function normalizeOptionalEmail(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  return EMAIL_REGEX.test(normalized) ? normalized : null;
}

function parseDeliveryConfig(rawConfig?: unknown): DeliveryConfig {
  const cfg = coerceDeliveryConfigRow(rawConfig ?? null) as DeliveryConfig & Record<string, any>;
  applyNormalizedBannerSlots(cfg);
  return cfg;
}

function normalizeDeliveryPublicMediaUrl(raw: unknown): string | null {
  return normalizeProductPhotoPublicUrl(raw);
}

function buildPublicPixConfig(
  config: DeliveryConfig,
  fallbackWhatsapp: string | null | undefined,
  paymentPix?: {
    provider?: string | null;
    external_id?: string | null;
    external_reference?: string | null;
    status?: string | null;
    qr_code_text?: string | null;
    qr_code_base64?: string | null;
    expires_at?: string | null;
  } | null
) {
  return {
    pix_chave: config.pix_chave,
    pix_nome: config.pix_nome,
    pix_cidade: config.pix_cidade,
    pix_payload_estatico: paymentPix?.qr_code_text || config.pix_payload_estatico,
    qr_code_image_base64: paymentPix?.qr_code_base64 || null,
    payment_provider: paymentPix?.provider || null,
    payment_external_id: paymentPix?.external_id || null,
    payment_external_reference: paymentPix?.external_reference || null,
    payment_status: paymentPix?.status || null,
    payment_expires_at: paymentPix?.expires_at || null,
    whatsapp: config.whatsapp || fallbackWhatsapp || undefined,
    desconto_pix: config.desconto_pix,
  };
}

function buildPublicPixPayment(
  payment?: {
    provider?: string | null;
    external_id?: string | null;
    external_reference?: string | null;
    status?: string | null;
    qr_code_text?: string | null;
    qr_code_base64?: string | null;
    qr_code_image_base64?: string | null;
    expires_at?: string | null;
  } | null
) {
  if (!payment) return null;

  const qrCodeBase64 =
    payment.qr_code_base64 || payment.qr_code_image_base64 || null;
  const paymentId = payment.external_id || null;

  return {
    id: paymentId,
    payment_id: paymentId,
    provider: payment.provider || null,
    external_id: paymentId,
    external_reference: payment.external_reference || null,
    status: payment.status || null,
    qr_code_text: payment.qr_code_text || null,
    qr_code_base64: qrCodeBase64,
    qr_code_image_base64: qrCodeBase64,
    expires_at: payment.expires_at || null,
  };
}

async function tryRevalidatePendingPixOrder(input: {
  orderId: number;
  tenantId: number;
  paymentMethod?: unknown;
  paymentStatus?: unknown;
  context: string;
}) {
  if (String(input.paymentMethod || '').trim().toLowerCase() !== 'pix') return;
  if (String(input.paymentStatus || '').trim().toLowerCase() === 'pago') return;

  try {
    await revalidatePixPaymentByOrder({
      orderId: input.orderId,
      tenantId: input.tenantId,
    });
  } catch (error) {
    if (isAppError(error) && error.statusCode === 404) return;
    logError(input.context, error, {
      orderId: input.orderId,
      tenantId: input.tenantId,
    });
  }
}

function parseOptionalIsoDate(value: unknown) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isPixPaymentExpired(payment?: {
  status?: string | null;
  expires_at?: string | null;
} | null) {
  if (!payment) return false;

  const status = String(payment.status || '').trim().toLowerCase();
  if (status === 'expired') return true;

  const expiresAt = parseOptionalIsoDate(payment.expires_at);
  return Boolean(expiresAt && expiresAt.getTime() <= Date.now());
}

function getCurrentDateInTimeZone() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function getCurrentMinutesInTimeZone() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  return (hour * 60) + minute;
}

const WEEKDAY_SHORT_TO_JS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getCurrentWeekdayJsInTimeZone(): number {
  const short = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' })
    .formatToParts(new Date())
    .find((p) => p.type === 'weekday')?.value;
  if (short && Object.prototype.hasOwnProperty.call(WEEKDAY_SHORT_TO_JS, short)) {
    return WEEKDAY_SHORT_TO_JS[short];
  }
  return new Date().getDay();
}

function normalizeDiasFolgaEntrega(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<number>();
  for (const x of raw) {
    const n = Number(x);
    if (Number.isInteger(n) && n >= 0 && n <= 6) out.add(n);
  }
  return Array.from(out).sort((a, b) => a - b);
}

/** Normaliza método de pagamento (trim + lower + NFD sem diacríticos). */
function normalizePaymentMethodKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

type CanonicalPaymentMethod = 'dinheiro' | 'pix' | 'cartao' | 'debito' | 'credito';

/**
 * Normaliza variações do checkout público para chaves canônicas persistidas.
 * - `cartao_credito` / `cartao_debito` → `cartao` (checkout público não discrimina no fluxo operacional)
 */
function normalizeDeliveryPublicPaymentMethod(value: unknown): CanonicalPaymentMethod | null {
  const k = normalizePaymentMethodKey(value);
  if (k === 'pix') return 'pix';
  if (k === 'dinheiro') return 'dinheiro';
  if (k === 'cartao' || k === 'cartao_credito' || k === 'cartao_debito') return 'cartao';
  if (k === 'debito') return 'debito';
  if (k === 'credito') return 'credito';
  return null;
}

/** Horário de funcionamento no fuso `TZ` (legado ou janelas por dia). */
function computeDeliveryCardapioAberto(dcfg: DeliveryConfig): DeliveryOperatingStatus {
  const nowWeekday = getCurrentWeekdayJsInTimeZone() as WeekdayJs;
  const nowMinutes = getCurrentMinutesInTimeZone();

  const weeklyActive = Boolean(dcfg.horarios_semana_ativo);
  if (weeklyActive) {
    const weekly = computeOperatingStatusFromWeeklySchedule({
      nowWeekday,
      nowMinutes,
      scheduleRaw: dcfg.horarios_semana,
    });
    if (weekly) return weekly;
    // Se a agenda semanal estiver inválida, cai no legado para não derrubar a operação.
  }

  return computeOperatingStatusFromLegacy({
    nowWeekday,
    nowMinutes,
    horario_abertura: dcfg.horario_abertura,
    horario_fechamento: dcfg.horario_fechamento,
    dias_folga_entrega: dcfg.dias_folga_entrega,
  });
}

function validateCupom(
  cupom: any,
  total: number
): { valido: boolean; mensagem?: string; desconto: number } {
  if (!cupom) {
    return { valido: false, mensagem: 'Cupom invalido ou expirado', desconto: 0 };
  }

  if (cupom.validade) {
    const hoje = getCurrentDateInTimeZone();
    const validade = String(cupom.validade).slice(0, 10);
    if (hoje > validade) {
      return { valido: false, mensagem: 'Cupom expirado', desconto: 0 };
    }
  }

  if (cupom.limite_uso !== null && Number(cupom.uso_atual || 0) >= Number(cupom.limite_uso || 0)) {
    return { valido: false, mensagem: 'Cupom esgotado', desconto: 0 };
  }

  if (Number(cupom.min_pedido || 0) > 0 && total < Number(cupom.min_pedido || 0)) {
    return {
      valido: false,
      mensagem: `Pedido minimo para este cupom: R$ ${Number(cupom.min_pedido || 0).toFixed(2).replace('.', ',')}`,
      desconto: 0,
    };
  }

  const desconto = cupom.tipo === 'percentual'
    ? total * Number(cupom.valor || 0) / 100
    : cupom.tipo === 'fixo'
      ? Number(cupom.valor || 0)
      : 0;

  return { valido: true, desconto };
}

function describeFirstCustomerDiscount(config: DeliveryConfig) {
  const tipo = String(config.desconto_primeiro_cliente_tipo || 'percentual').toLowerCase() as FirstCustomerDiscountType;
  const valor = Number(config.desconto_primeiro_cliente_valor || 0);

  if (tipo === 'frete_gratis') return 'Frete gratis na primeira compra';
  if (tipo === 'fixo') return `R$ ${valor.toFixed(2).replace('.', ',')} na primeira compra`;
  return `${valor}% na primeira compra`;
}

function buildFirstCustomerDiscountMessage(params: {
  ativo: boolean;
  tipo: FirstCustomerDiscountType;
  valorConfigurado: number;
  minPedido: number;
  motivo: FirstCustomerDiscountReason;
}) {
  if (!params.ativo) return 'Desconto de primeira compra desativado.';
  if (params.motivo === 'cliente_nao_identificado') return 'Identifique o cliente para validar a primeira compra.';
  if (params.motivo === 'pedido_abaixo_minimo') {
    return `Disponivel a partir de R$ ${params.minPedido.toFixed(2).replace('.', ',')} no subtotal do pedido.`;
  }
  /** Legado em snapshots de pedidos (`delivery_checkout_snapshot`). */
  if ((params.motivo as string) === 'nao_primeira_compra') {
    return 'Beneficio valido somente na primeira compra do cliente.';
  }
  if (params.motivo === 'existing_customer_history') {
    return 'Beneficio valido somente na primeira compra. Ja existe historico de pedidos para esta conta.';
  }
  if (params.motivo === 'same_phone_previous_order') {
    return 'Beneficio valido somente na primeira compra. Ja identificamos pedido anterior com este telefone.';
  }
  if (params.motivo === 'same_address_previous_order') {
    return 'Beneficio valido somente na primeira compra. Ja identificamos pedido anterior para este endereco.';
  }
  if (params.motivo === 'sem_valor_configurado') return 'Configure um valor valido para o desconto de primeira compra.';
  if (params.motivo === 'sem_taxa_entrega') return 'Este pedido ja esta com entrega gratis.';
  if (params.motivo === 'frete_ja_bonificado') return 'O frete deste pedido ja foi zerado por outro beneficio.';
  if (params.tipo === 'frete_gratis') return 'Frete gratis aplicado na primeira compra.';
  if (params.tipo === 'fixo') {
    return `Desconto de R$ ${params.valorConfigurado.toFixed(2).replace('.', ',')} aplicado na primeira compra.`;
  }
  return `Desconto de ${params.valorConfigurado}% aplicado na primeira compra.`;
}

async function resolveDeliveryCustomerId(tenantId: number, clienteToken?: unknown) {
  if (!clienteToken) return null;

  try {
    const dec: any = jwt.verify(String(clienteToken), JWT_SECRET);
    if (dec.tipo === 'delivery_cliente' && Number(dec.tenantId) === Number(tenantId)) {
      return Number(dec.clienteId);
    }
  } catch {}

  return null;
}

async function resolveSavedDeliveryAddress(params: {
  tenantId: number;
  clienteId: number | null;
  enderecoId?: unknown;
}) {
  if (params.enderecoId === undefined || params.enderecoId === null || String(params.enderecoId).trim() === '') {
    return null;
  }

  const enderecoId = Number(params.enderecoId);
  if (!Number.isInteger(enderecoId) || enderecoId <= 0) {
    throw new AppError('Endereco invalido', 400, 'DELIVERY_ENDERECO_INVALIDO');
  }

  if (!params.clienteId) {
    throw new AppError('Endereco salvo requer cliente autenticado', 401, 'DELIVERY_CLIENTE_NAO_AUTENTICADO');
  }

  const endereco = await q1(
    `SELECT id, label, logradouro, numero, complemento, bairro, referencia, principal
     FROM delivery_enderecos
     WHERE id=? AND tenant_id=? AND cliente_id=?`,
    [enderecoId, params.tenantId, params.clienteId]
  );

  if (!endereco) {
    throw new AppError('Endereco invalido para este cliente', 400, 'DELIVERY_ENDERECO_INVALIDO');
  }

  return endereco as DeliveryAddressRecord;
}

function formatSavedDeliveryAddress(endereco: DeliveryAddressRecord) {
  return [
    [endereco.logradouro, endereco.numero].filter(Boolean).join(', '),
    endereco.complemento ? `Compl: ${endereco.complemento}` : '',
    endereco.bairro ? `Bairro: ${endereco.bairro}` : '',
    endereco.referencia ? `Ref: ${endereco.referencia}` : '',
  ].filter(Boolean).join(' - ');
}

async function resolveDeliveryFee(params: {
  tenantId: number;
  clienteId: number | null;
  endereco?: DeliveryAddressRecord | null;
  bairro?: unknown;
  config: DeliveryConfig;
  canalPedido?: OrderChannel;
}): Promise<{
  taxa: number;
  zona: DeliveryZone | null;
  bairro: string | null;
  entrega_bloqueada_por_zona?: boolean;
}> {
  if (params.canalPedido === 'retirada') {
    return { taxa: 0, zona: null as DeliveryZone | null, bairro: null as string | null };
  }

  const defaultFee = Number(params.config.taxa_entrega || 0);
  const zonas = (Array.isArray(params.config.zonas_entrega) ? params.config.zonas_entrega : []).filter((z) =>
    String(z?.nome || '').trim()
  );
  const bairroInformado = String(params.bairro || '').trim();
  const bairroEndereco = String(params.endereco?.bairro || '').trim();
  const effectiveBairro = bairroInformado || bairroEndereco;

  if (zonas.length === 0) {
    if (effectiveBairro) {
      return { taxa: defaultFee, zona: null, bairro: effectiveBairro };
    }
    return { taxa: defaultFee, zona: null, bairro: null };
  }

  if (!effectiveBairro) {
    return { taxa: 0, zona: null, bairro: null };
  }

  const zona = findDeliveryZoneByBairro(zonas, effectiveBairro);
  if (!zona) {
    return {
      taxa: 0,
      zona: null,
      bairro: effectiveBairro,
      entrega_bloqueada_por_zona: true,
    };
  }

  return {
    taxa: Number(zona.taxa || 0),
    zona,
    bairro: effectiveBairro,
  };
}

async function resolveFirstCustomerDiscount(params: {
  tenantId: number;
  clienteId: number | null;
  config: DeliveryConfig;
  subtotalAfterPix: number;
  taxaEntrega: number;
  cupomAplicado: any | null;
  totalBeforeFirstCustomerDiscount: number;
  enderecoSalvo: DeliveryAddressRecord | null;
  enderecoElegibilidadePreview: { logradouro: string; numero: string; bairro: string } | null;
  canalPedido: OrderChannel;
}) {
  const ativo = Boolean(params.config.desconto_primeiro_cliente_ativo);
  const tipo = String(params.config.desconto_primeiro_cliente_tipo || 'percentual').toLowerCase() as FirstCustomerDiscountType;
  const valorConfigurado = Number(params.config.desconto_primeiro_cliente_valor || 0);
  const minPedido = Number(params.config.desconto_primeiro_cliente_min_pedido || 0);
  const descricao = describeFirstCustomerDiscount(params.config);
  const finalize = (input: {
    desconto: number;
    elegivel: boolean;
    aplicado: boolean;
    motivo: FirstCustomerDiscountReason;
  }) => ({
    desconto: input.desconto,
    ativo,
    elegivel: input.elegivel,
    aplicado: input.aplicado,
    tipo,
    valor_configurado: valorConfigurado,
    min_pedido: minPedido,
    descricao,
    motivo: input.motivo,
    mensagem: buildFirstCustomerDiscountMessage({
      ativo,
      tipo,
      valorConfigurado,
      minPedido,
      motivo: input.motivo,
    }),
  });

  if (!ativo || !params.clienteId) {
    return finalize({
      desconto: 0,
      elegivel: false,
      aplicado: false,
      motivo: ativo ? 'cliente_nao_identificado' : 'inativo',
    });
  }

  if (tipo !== 'frete_gratis' && valorConfigurado <= 0) {
    return finalize({
      desconto: 0,
      elegivel: false,
      aplicado: false,
      motivo: 'sem_valor_configurado',
    });
  }

  if (minPedido > 0 && params.subtotalAfterPix < minPedido) {
    return finalize({
      desconto: 0,
      elegivel: false,
      aplicado: false,
      motivo: 'pedido_abaixo_minimo',
    });
  }

  const existingOrderSameCliente = await q1(
    `SELECT p.id
     FROM pedidos p
     WHERE p.tenant_id=?
       AND (p.delivery_cliente_id = ? OR p.cliente_id = ?)
       AND ${PRIMEIRA_COMPRA_PEDIDO_VALIDO_SQL}
     LIMIT 1`,
    [params.tenantId, params.clienteId, params.clienteId]
  );

  if (existingOrderSameCliente) {
    return finalize({
      desconto: 0,
      elegivel: false,
      aplicado: false,
      motivo: 'existing_customer_history',
    });
  }

  const clienteRow = await q1(
    'SELECT telefone FROM delivery_clientes WHERE id=? AND tenant_id=?',
    [params.clienteId, params.tenantId]
  );
  const phoneNorm = normalizeBrazilDeliveryPhoneDigits(clienteRow?.telefone ?? '');

  const currentAddressSig =
    params.canalPedido === 'delivery'
      ? params.enderecoSalvo
        ? buildDeliveryAddressAntiFraudSignature({
            logradouro: params.enderecoSalvo.logradouro,
            numero: params.enderecoSalvo.numero,
            bairro: params.enderecoSalvo.bairro,
          })
        : params.enderecoElegibilidadePreview
          ? buildDeliveryAddressAntiFraudSignature(params.enderecoElegibilidadePreview)
          : null
      : null;

  const priorRows = await qAll(
    `SELECT p.id, p.delivery_cliente_id, p.cliente_id, p.cliente_tel, p.delivery_endereco_id, p.endereco
     FROM pedidos p
     WHERE p.tenant_id=?
       AND ${PRIMEIRA_COMPRA_PEDIDO_VALIDO_SQL}
     ORDER BY p.id DESC
     LIMIT 3000`,
    [params.tenantId]
  );

  const enderecoIds = [
    ...new Set(
      priorRows
        .map((row: { delivery_endereco_id?: unknown }) =>
          row.delivery_endereco_id != null ? Number(row.delivery_endereco_id) : null
        )
        .filter((id): id is number => id != null && Number.isInteger(id) && id > 0)
    ),
  ];

  let enderecoById = new Map<number, { logradouro?: string | null; numero?: string | null; bairro?: string | null }>();
  if (enderecoIds.length) {
    const ph = enderecoIds.map(() => '?').join(',');
    const addrRows = await qAll(
      `SELECT id, logradouro, numero, bairro FROM delivery_enderecos WHERE tenant_id=? AND id IN (${ph})`,
      [params.tenantId, ...enderecoIds]
    );
    enderecoById = new Map(
      addrRows.map((e: { id: number; logradouro?: string | null; numero?: string | null; bairro?: string | null }) => [
        Number(e.id),
        e,
      ])
    );
  }

  let hitPhone = false;
  let hitAddress = false;

  for (const row of priorRows as Array<{
    id: number;
    delivery_cliente_id?: number | null;
    cliente_id?: number | null;
    cliente_tel?: string | null;
    delivery_endereco_id?: number | null;
    endereco?: string | null;
  }>) {
    if (
      Number(row.delivery_cliente_id) === Number(params.clienteId) ||
      Number(row.cliente_id) === Number(params.clienteId)
    ) {
      continue;
    }

    const orderTel = normalizeBrazilDeliveryPhoneDigits(row.cliente_tel);
    if (phoneNorm.length >= 10 && orderTel.length >= 10 && orderTel === phoneNorm) {
      hitPhone = true;
    }

    if (currentAddressSig) {
      const eid = row.delivery_endereco_id != null ? Number(row.delivery_endereco_id) : null;
      const linked = eid && enderecoById.has(eid) ? enderecoById.get(eid)! : null;
      const sig = linked
        ? signatureFromPedidoEnderecoFields({
            logradouro: linked.logradouro,
            numero: linked.numero,
            bairro: linked.bairro,
          })
        : signatureFromPedidoEnderecoFields({ endereco: row.endereco });
      if (sig && sig === currentAddressSig) {
        hitAddress = true;
      }
    }
  }

  if (hitPhone) {
    return finalize({
      desconto: 0,
      elegivel: false,
      aplicado: false,
      motivo: 'same_phone_previous_order',
    });
  }
  if (hitAddress) {
    return finalize({
      desconto: 0,
      elegivel: false,
      aplicado: false,
      motivo: 'same_address_previous_order',
    });
  }

  let desconto = 0;
  let motivo: FirstCustomerDiscountReason = 'aplicado';
  if (tipo === 'frete_gratis') {
    const freteJaBonificado = params.cupomAplicado?.tipo === 'frete_gratis';
    if (freteJaBonificado) {
      motivo = 'frete_ja_bonificado';
      desconto = 0;
    } else if (params.taxaEntrega <= 0) {
      motivo = 'sem_taxa_entrega';
      desconto = 0;
    } else {
      desconto = params.taxaEntrega;
    }
  } else if (tipo === 'fixo') {
    desconto = Math.min(valorConfigurado, params.subtotalAfterPix);
  } else {
    desconto = params.subtotalAfterPix * (valorConfigurado / 100);
  }

  desconto = Math.max(0, Math.min(desconto, params.totalBeforeFirstCustomerDiscount));

  return finalize({
    desconto,
    elegivel: true,
    aplicado: desconto > 0,
    motivo,
  });
}

async function buildCheckoutSummary(params: {
  tenantId: number;
  config: DeliveryConfig;
  items: any[];
  pagamentoTipo?: unknown;
  enderecoId?: unknown;
  bairro?: unknown;
  clienteToken?: unknown;
  cupomCodigo?: unknown;
  canalPedido?: OrderChannel;
  /** Endereço em digitação (cardápio) — mesma regra do pedido final quando ainda não há `endereco_id`. */
  enderecoElegibilidadePreview?: {
    logradouro?: unknown;
    numero?: unknown;
    bairro?: unknown;
  } | null;
}) {
  const clienteId = await resolveDeliveryCustomerId(params.tenantId, params.clienteToken);
  const canalPedido: OrderChannel = params.canalPedido === 'retirada' ? 'retirada' : 'delivery';

  const rawPv = params.enderecoElegibilidadePreview;
  let enderecoElegibilidadePreview: { logradouro: string; numero: string; bairro: string } | null = null;
  if (canalPedido === 'delivery' && rawPv && typeof rawPv === 'object') {
    const o = rawPv as Record<string, unknown>;
    const log = String(o.logradouro ?? '').trim();
    const num = String(o.numero ?? '').trim();
    const bai = String(o.bairro ?? '').trim();
    if (log && num && bai) enderecoElegibilidadePreview = { logradouro: log, numero: num, bairro: bai };
  }

  const enderecoSalvo = await resolveSavedDeliveryAddress({
    tenantId: params.tenantId,
    clienteId,
    enderecoId: params.enderecoId,
  });
  const { subtotal, itensValidados } = await validateDeliveryItems(params.tenantId, params.items);
  const pagamentoTipo = normalizeDeliveryPublicPaymentMethod(params.pagamentoTipo);
  const fee = await resolveDeliveryFee({
    tenantId: params.tenantId,
    clienteId,
    endereco: enderecoSalvo,
    bairro: params.bairro,
    config: params.config,
    canalPedido,
  });

  const descontoPixPercent = pagamentoTipo === 'pix' ? Number(params.config.desconto_pix || 0) : 0;
  const descontoPix = descontoPixPercent > 0 ? subtotal * (descontoPixPercent / 100) : 0;
  const subtotalAposPix = Math.max(0, subtotal - descontoPix);
  const totalAntesDoCupom = subtotalAposPix + fee.taxa;

  let cupomAplicado: any = null;
  let descontoCupom = 0;
  let cupomInvalido: string | undefined;
  const cupomCodigo = String(params.cupomCodigo || '').trim().toUpperCase();

  if (cupomCodigo) {
    const cupom = await q1(
      'SELECT * FROM delivery_cupons WHERE tenant_id=? AND codigo=? AND ativo=1',
      [params.tenantId, cupomCodigo]
    );
    const resultadoCupom = validateCupom(cupom, totalAntesDoCupom);
    if (resultadoCupom.valido) {
      cupomAplicado = cupom;
      descontoCupom = cupom?.tipo === 'frete_gratis'
        ? fee.taxa
        : Math.min(resultadoCupom.desconto, totalAntesDoCupom);
    } else {
      cupomInvalido = resultadoCupom.mensagem || 'Cupom invalido ou expirado';
    }
  }

  const totalAntesDoPrimeiroCliente = Math.max(0, totalAntesDoCupom - descontoCupom);
  const primeiroCliente = await resolveFirstCustomerDiscount({
    tenantId: params.tenantId,
    clienteId,
    config: params.config,
    subtotalAfterPix: subtotalAposPix,
    taxaEntrega: fee.taxa,
    cupomAplicado,
    totalBeforeFirstCustomerDiscount: totalAntesDoPrimeiroCliente,
    enderecoSalvo,
    enderecoElegibilidadePreview,
    canalPedido,
  });

  const total = Math.max(0, totalAntesDoPrimeiroCliente - primeiroCliente.desconto);

  const summary: CheckoutSummary = {
    modelo_entrega: 'bairro_fixo',
    bairro_entrega: fee.bairro,
    subtotal,
    desconto_pix: descontoPix,
    subtotal_apos_desconto_pix: subtotalAposPix,
    taxa_entrega: fee.taxa,
    zona_entrega: fee.zona,
    entrega_bloqueada_por_zona: Boolean(fee.entrega_bloqueada_por_zona),
    mensagem_entrega_bloqueada: fee.entrega_bloqueada_por_zona
      ? MENSAGEM_ENTREGA_FORA_DA_AREA
      : undefined,
    desconto_cupom: descontoCupom,
    cupom_aplicado: cupomAplicado,
    desconto_primeiro_cliente: primeiroCliente.desconto,
    primeiro_cliente: {
      ativo: primeiroCliente.ativo,
      elegivel: primeiroCliente.elegivel,
      aplicado: primeiroCliente.aplicado,
      tipo: primeiroCliente.tipo,
      valor_configurado: primeiroCliente.valor_configurado,
      min_pedido: primeiroCliente.min_pedido,
      descricao: primeiroCliente.descricao,
      motivo: primeiroCliente.motivo,
      mensagem: primeiroCliente.mensagem,
    },
    total,
    itensValidados,
  };

  if (cupomInvalido) {
    summary.cupom_invalido = cupomInvalido;
  }

  return summary;
}

/** Limite conservador de placeholders por query SQLite (evita SQLITE_MAX_VARIABLE_NUMBER). */
const CARDAPIO_IN_CHUNK = 400;

function chunkIds<T>(arr: T[], size: number): T[][] {
  if (!arr.length) return [];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Monta `grupos_opcao` + `variacoes_vendaveis` para todos os produtos em poucas queries,
 * em vez de N+1 por produto/grupo (principal gargalo do GET /delivery/:slug/cardapio).
 */
async function buildProdutosComOpcoesBatched(tenantId: number, produtos: any[]): Promise<any[]> {
  if (!produtos.length) return [];

  const tid = Number(tenantId);
  const produtoIds = produtos.map((p) => Number(p.id));

  const allGrupos: any[] = [];
  for (const ids of chunkIds(produtoIds, CARDAPIO_IN_CHUNK)) {
    const ph = ids.map(() => '?').join(',');
    const rows = await qAll(
      `SELECT * FROM produto_grupos_opcao WHERE produto_id IN (${ph}) AND tenant_id=? AND ativo=1 ORDER BY produto_id ASC, ordem ASC`,
      [...ids, tid]
    );
    allGrupos.push(...rows);
  }

  const allItens: any[] = [];
  for (const gids of chunkIds(
    allGrupos.map((g) => Number(g.id)),
    CARDAPIO_IN_CHUNK
  )) {
    if (!gids.length) continue;
    const ph = gids.map(() => '?').join(',');
    const rows = await qAll(
      `SELECT * FROM produto_opcao_itens WHERE grupo_id IN (${ph}) AND tenant_id=? AND ativo=1 ORDER BY grupo_id ASC, ordem ASC`,
      [...gids, tid]
    );
    allItens.push(...rows);
  }

  const itensByGrupo = new Map<number, any[]>();
  for (const it of allItens) {
    const gid = Number(it.grupo_id);
    if (!itensByGrupo.has(gid)) itensByGrupo.set(gid, []);
    itensByGrupo.get(gid)!.push(it);
  }

  const gruposByProduto = new Map<number, any[]>();
  for (const g of allGrupos) {
    const pid = Number(g.produto_id);
    if (!gruposByProduto.has(pid)) gruposByProduto.set(pid, []);
    const itens = itensByGrupo.get(Number(g.id)) || [];
    gruposByProduto.get(pid)!.push({ ...g, itens });
  }

  const allVariacoes: any[] = [];
  for (const ids of chunkIds(produtoIds, CARDAPIO_IN_CHUNK)) {
    const ph = ids.map(() => '?').join(',');
    const rows = await qAll(
      `SELECT id, nome, preco, produto_id FROM produto_variacoes_vendaveis WHERE produto_id IN (${ph}) AND tenant_id=? AND ativo=1 ORDER BY produto_id ASC, ordem ASC, nome ASC`,
      [...ids, tid]
    );
    allVariacoes.push(...rows);
  }

  const variacoesByProduto = new Map<number, any[]>();
  for (const v of allVariacoes) {
    const pid = Number(v.produto_id);
    if (!variacoesByProduto.has(pid)) variacoesByProduto.set(pid, []);
    variacoesByProduto.get(pid)!.push({ id: v.id, nome: v.nome, preco: Number(v.preco) });
  }

  const comboByProduto = await batchLoadComboGruposForCardapio(tid, produtoIds);

  return produtos.map((p) => {
    const id = Number(p.id);
    return {
      ...p,
      photo_url: normalizeProductPhotoPublicUrl(p.photo_url),
      description: p.descricao || null,
      em_promocao: Number(p.em_promocao || 0),
      preco_original: p.preco_original == null ? null : Number(p.preco_original),
      is_combo: Number(p.is_combo || 0) === 1 ? 1 : 0,
      grupos_opcao: gruposByProduto.get(id) || [],
      variacoes_vendaveis: variacoesByProduto.get(id) || [],
      combo_grupos: comboByProduto.get(id) || [],
    };
  });
}

export function createDeliveryPublicRouter() {
  const router = Router();
  const requireBrowserOrigin = requireTrustedBrowserOrigin();

  async function getTenant(slug: string) {
    return q1('SELECT * FROM clientes WHERE usuario=? AND status=?', [slug, 'ativo']);
  }

  function requireSlugPlanFeature(feature: PlanFeature) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const features = await getTenantFeaturesBySlug(String(req.params.slug || ''));
        if (!features) {
          return res.status(404).json({ error: 'Loja nao encontrada' });
        }

        if (features.includes(feature)) {
          return next();
        }

        return res.status(403).json({ error: 'Plano não inclui este recurso', feature });
      } catch (e: unknown) {
        sendInternalError(res, 'delivery-public:requireSlugPlanFeature', e);
        return;
      }
    };
  }

  const requireDeliveryPublicPlan = requireSlugPlanFeature('delivery_public');
  const requireDeliveryTrackingPlan = requireSlugPlanFeature('delivery_tracking');

  /** Endpoint leve para o cardápio revalidar aberto/fechado sem baixar produtos. */
  router.get('/:slug/status', publicRateLimit, requireDeliveryPublicPlan, async (req, res) => {
    try {
      const tenant = await getTenant(req.params.slug);
      if (!tenant) return res.status(404).json({ error: 'Loja nao encontrada' });
      const dcfg = parseDeliveryConfig(tenant.delivery_config);

      if (!tenant.delivery_ativo) {
        return res.json({
          ativo: false,
          aberto: false,
          dia_folga_hoje: false,
          proxima_abertura: null,
          proximo_fechamento: null,
          proximo_evento_em_minutos: null,
          motivo: 'Delivery nao esta ativo',
        });
      }

      const status = computeDeliveryCardapioAberto(dcfg);
      return res.json({
        ativo: status.aberto,
        aberto: status.aberto,
        dia_folga_hoje: status.dia_folga_hoje,
        proxima_abertura: status.proxima_abertura ?? null,
        proximo_fechamento: status.proximo_fechamento ?? null,
        proximo_evento_em_minutos: status.proximo_evento_em_minutos ?? null,
        horarios_semana_ativo: dcfg.horarios_semana_ativo ?? false,
      });
    } catch (e: unknown) {
      sendInternalError(res, 'delivery-public:status', e);
      return;
    }
  });

  router.get('/:slug/cardapio', publicRateLimit, requireDeliveryPublicPlan, async (req, res) => {
    try {
      const tenant = await getTenant(req.params.slug);
      if (!tenant) return res.status(404).json({ error: 'Loja nao encontrada' });
      const dcfg = parseDeliveryConfig(tenant.delivery_config);
      if (!tenant.delivery_ativo) return res.status(403).json({ error: 'Delivery nao esta ativo', aberto: false });

      const { aberto, dia_folga_hoje, proxima_abertura, proximo_fechamento } = computeDeliveryCardapioAberto(dcfg);
      const diasFolgaCfg = normalizeDiasFolgaEntrega(dcfg.dias_folga_entrega);

      const produtos = await qAll('SELECT * FROM produtos WHERE tenant_id=? AND active=1 ORDER BY COALESCE(ordem,0) ASC, name ASC', [tenant.id]);
      let produtosComOpcoes: any[];
      try {
        produtosComOpcoes = await buildProdutosComOpcoesBatched(tenant.id, produtos);
      } catch (error) {
        console.warn('[delivery-public] fallback para payload basico de produtos', {
          tenantId: Number(tenant.id),
          slug: String(req.params.slug || ''),
          error: error instanceof Error ? error.message : String(error),
        });
        produtosComOpcoes = produtos.map((p) => ({
          ...p,
          photo_url: normalizeProductPhotoPublicUrl(p.photo_url),
          description: p.descricao || null,
          em_promocao: Number(p.em_promocao || 0),
          preco_original: p.preco_original == null ? null : Number(p.preco_original),
          is_combo: Number(p.is_combo || 0) === 1 ? 1 : 0,
          grupos_opcao: [],
          variacoes_vendaveis: [],
          combo_grupos: [],
        }));
      }

      const logoPadrao = normalizeDeliveryPublicMediaUrl(await resolveTenantLogoPublicUrl(tenant.id));
      const logoCustom = normalizeDeliveryPublicMediaUrl(dcfg.cardapio_online_logo_url);
      const logo_url = logoCustom || logoPadrao;
      const cardapioOnlineLogoUrl = logoCustom || undefined;

      const categoriasMap: Record<string, any[]> = {};
      for (const p of produtosComOpcoes) {
        const cat = p.category || 'Geral';
        if (!categoriasMap[cat]) categoriasMap[cat] = [];
        categoriasMap[cat].push(p);
      }
      const categorias = Object.entries(categoriasMap).map(([nome, itens]) => ({ nome, itens }));

      const cardapioBannerSlots = normalizeCardapioOnlineBannerSlots(
        dcfg.cardapio_online_banner_urls != null ? dcfg.cardapio_online_banner_urls : dcfg.cardapio_banner_slots
      ).map(
        (url) => normalizeDeliveryPublicMediaUrl(url) || ''
      );

      res.json({
        estabelecimento: tenant.nome_estabelecimento,
        nome_estabelecimento: tenant.nome_estabelecimento,
        logo_url,
        ativo: aberto,
        aberto,
        dia_folga_hoje,
        config: {
          taxa_entrega: dcfg.taxa_entrega ?? 0,
          modelo_entrega: 'bairro_fixo',
          pedido_minimo: dcfg.pedido_minimo ?? 0,
          tempo_preparo: dcfg.tempo_preparo ?? 30,
          pix_chave: dcfg.pix_chave,
          pix_nome: dcfg.pix_nome,
          pix_cidade: dcfg.pix_cidade,
          pix_payload_estatico: dcfg.pix_payload_estatico,
          whatsapp: dcfg.whatsapp || tenant.whatsapp,
          horario_abertura: dcfg.horario_abertura,
          horario_fechamento: dcfg.horario_fechamento,
          horarios_semana_ativo: dcfg.horarios_semana_ativo ?? false,
          horarios_semana: dcfg.horarios_semana,
          proxima_abertura,
          proximo_fechamento,
          desconto_pix: dcfg.desconto_pix ?? 0,
          desconto_primeiro_cliente_ativo: dcfg.desconto_primeiro_cliente_ativo ?? false,
          desconto_primeiro_cliente_tipo: dcfg.desconto_primeiro_cliente_tipo ?? 'percentual',
          desconto_primeiro_cliente_valor: dcfg.desconto_primeiro_cliente_valor ?? 0,
          desconto_primeiro_cliente_min_pedido: dcfg.desconto_primeiro_cliente_min_pedido ?? 0,
          zonas_entrega: Array.isArray(dcfg.zonas_entrega) ? dcfg.zonas_entrega : [],
          theme_mode: dcfg.theme_mode === 'light_red' ? 'light_red' : 'dark_premium',
          cardapio_online_logo_url: cardapioOnlineLogoUrl,
          cardapio_online_banner_urls: cardapioBannerSlots,
          cardapio_banner_slots: cardapioBannerSlots,
          dias_folga_entrega: diasFolgaCfg,
          motoboy_sob_demanda: !!dcfg.motoboy_sob_demanda,
        },
        categorias,
      });
    } catch (e: any) {
      sendInternalError(res, 'delivery-public', e);
    }
  });

  /** Lista pedidos do cliente — apenas com token JWT do delivery (mesma base que /cliente/pedidos) */
  router.get('/:slug/orders', publicRateLimit, requireDeliveryTrackingPlan, authDeliveryCliente, async (req: any, res) => {
    try {
      const tenant = await getTenant(req.params.slug);
      if (!tenant) return res.status(404).json({ error: 'Loja nao encontrada' });
      if (Number(tenant.id) !== Number(req.tenantId)) {
        return res.status(403).json({ error: 'Token nao corresponde a esta loja' });
      }

      const rows = await qAll<{
        id: number;
        status: string;
        total_amount: number;
        created_at: string;
        order_number: string;
      }>(
        `SELECT p.id, p.status, p.total_amount, p.created_at, p.order_number
         FROM pedidos p
         WHERE p.tenant_id = ?
           AND p.canal IN ('delivery', 'retirada')
           AND (p.cliente_id = ? OR p.delivery_cliente_id = ?)
         ORDER BY p.created_at DESC
         LIMIT 50`,
        [tenant.id, req.clienteId, req.clienteId]
      );

      res.json(
        rows.map((r) => ({
          id: r.id,
          status: r.status,
          total: Number(r.total_amount || 0),
          created_at: r.created_at,
          order_number: r.order_number,
        }))
      );
    } catch (e: any) {
      sendInternalError(res, 'delivery-public', e);
    }
  });

  /** Detalhe de um pedido — apenas se pertencer ao cliente autenticado */
  router.get('/:slug/orders/:orderId', publicRateLimit, requireDeliveryTrackingPlan, authDeliveryCliente, async (req: any, res) => {
    try {
      const orderId = Number(req.params.orderId);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return res.status(400).json({ error: 'Pedido invalido' });
      }
      const tenant = await getTenant(req.params.slug);
      if (!tenant) return res.status(404).json({ error: 'Loja nao encontrada' });
      if (Number(tenant.id) !== Number(req.tenantId)) {
        return res.status(403).json({ error: 'Token nao corresponde a esta loja' });
      }

      const pedido = await q1<{
        id: number;
        status: string;
        total_amount: number;
        created_at: string;
        order_number: string;
      }>(
        `SELECT p.id, p.status, p.total_amount, p.created_at, p.order_number
         FROM pedidos p
         WHERE p.id = ?
           AND p.tenant_id = ?
           AND p.canal IN ('delivery', 'retirada')
           AND (p.cliente_id = ? OR p.delivery_cliente_id = ?)`,
        [orderId, tenant.id, req.clienteId, req.clienteId]
      );

      if (!pedido) {
        return res.status(404).json({ error: 'Pedido nao encontrado' });
      }

      const itens = await qAll<{
        product_id: number;
        product_name: string;
        quantity: number;
        price_at_time: number;
      }>(
        `SELECT ip.product_id, pr.name AS product_name, ip.quantity, ip.price_at_time
         FROM itens_pedido ip
         JOIN produtos pr ON pr.id = ip.product_id
         WHERE ip.order_id = ?
         ORDER BY ip.id ASC`,
        [orderId]
      );

      res.json({
        id: pedido.id,
        status: pedido.status,
        total: Number(pedido.total_amount || 0),
        created_at: pedido.created_at,
        order_number: pedido.order_number,
        itens: itens.map((i) => ({
          product_id: i.product_id,
          name: i.product_name,
          quantity: i.quantity,
          price_at_time: Number(i.price_at_time || 0),
        })),
      });
    } catch (e: any) {
      sendInternalError(res, 'delivery-public', e);
    }
  });

  router.get('/:slug/pedido/:id', requireDeliveryTrackingPlan, async (req, res) => {
    try {
      const tenant = await getTenant(req.params.slug);
      if (!tenant) return res.status(404).json({ error: 'Loja nao encontrada' });
      const dcfg = parseDeliveryConfig(tenant.delivery_config);

      let pedido = await q1(
        `SELECT p.*, m.nome as motoboy_nome,
          (SELECT STRING_AGG(pr.name||' x'||ip.quantity::text,', ') FROM itens_pedido ip JOIN produtos pr ON pr.id=ip.product_id WHERE ip.order_id=p.id) as resumo_itens
         FROM pedidos p LEFT JOIN delivery_motoboys m ON m.id=p.motoboy_id AND m.tenant_id=p.tenant_id
         WHERE p.id=? AND p.tenant_id=?`,
        [req.params.id, tenant.id]
      );

      if (!pedido) return res.status(404).json({ error: 'Pedido nao encontrado' });

      pedido.total_amount = Number(pedido.total_amount || 0);
      pedido.taxa_entrega = Number(pedido.taxa_entrega || 0);
      try {
        pedido.delivery_checkout_snapshot = pedido.delivery_checkout_snapshot
          ? JSON.parse(pedido.delivery_checkout_snapshot)
          : null;
      } catch {
        pedido.delivery_checkout_snapshot = null;
      }

      await tryRevalidatePendingPixOrder({
        orderId: Number(pedido.id),
        tenantId: Number(tenant.id),
        paymentMethod: pedido.pagamento_tipo,
        paymentStatus: pedido.pagamento_status,
        context: 'delivery-public.track.revalidatePix',
      });

      pedido = await q1(
        `SELECT p.*, m.nome as motoboy_nome,
          (SELECT STRING_AGG(pr.name||' x'||ip.quantity::text,', ') FROM itens_pedido ip JOIN produtos pr ON pr.id=ip.product_id WHERE ip.order_id=p.id) as resumo_itens
         FROM pedidos p LEFT JOIN delivery_motoboys m ON m.id=p.motoboy_id AND m.tenant_id=p.tenant_id
         WHERE p.id=? AND p.tenant_id=?`,
        [req.params.id, tenant.id]
      );

      if (!pedido) return res.status(404).json({ error: 'Pedido nao encontrado' });

      pedido.total_amount = Number(pedido.total_amount || 0);
      pedido.taxa_entrega = Number(pedido.taxa_entrega || 0);
      try {
        pedido.delivery_checkout_snapshot = pedido.delivery_checkout_snapshot
          ? JSON.parse(pedido.delivery_checkout_snapshot)
          : null;
      } catch {
        pedido.delivery_checkout_snapshot = null;
      }

      const persistedPayments = await getPaymentByOrderId({
        orderId: Number(pedido.id),
        tenantId: Number(tenant.id),
      });

      const latestPixPayment = persistedPayments.find(
        (payment) => String(payment.method || '').trim().toLowerCase() === 'pix'
      );

      res.json({
        pedido,
        nome_estabelecimento: tenant.nome_estabelecimento,
        payment_pix: buildPublicPixPayment(
          latestPixPayment
            ? {
                provider: latestPixPayment.provider,
                external_id: latestPixPayment.external_id,
                external_reference: latestPixPayment.external_reference,
                status: latestPixPayment.status,
                qr_code_text: latestPixPayment.qr_code_text,
                qr_code_base64: latestPixPayment.qr_code_image_base64,
                qr_code_image_base64: latestPixPayment.qr_code_image_base64,
                expires_at: latestPixPayment.expires_at,
              }
            : null
        ),
        config_pix: buildPublicPixConfig(
          dcfg,
          tenant.whatsapp,
          latestPixPayment
            ? {
                provider: latestPixPayment.provider,
                external_id: latestPixPayment.external_id,
                external_reference: latestPixPayment.external_reference,
                status: latestPixPayment.status,
                qr_code_text: latestPixPayment.qr_code_text,
                qr_code_base64: latestPixPayment.qr_code_image_base64,
                expires_at: latestPixPayment.expires_at,
              }
            : null
        ),
      });
    } catch (e: any) {
      sendInternalError(res, 'delivery-public', e);
    }
  });

  router.post('/:slug/cupom/validar', publicRateLimit, requireBrowserOrigin, requireDeliveryPublicPlan, async (req, res) => {
    try {
      const tenant = await getTenant(req.params.slug);
      if (!tenant) return res.status(404).json({ error: 'Loja nao encontrada' });
      const { codigo, total } = req.body;
      const cupom = await q1(
        'SELECT * FROM delivery_cupons WHERE tenant_id=? AND codigo=? AND ativo=1',
        [tenant.id, String(codigo).toUpperCase().trim()]
      );
      const resultado = validateCupom(cupom, Number(total || 0));
      if (!resultado.valido) return res.json({ valido: false, mensagem: resultado.mensagem });
      res.json({ valido: true, cupom, desconto: resultado.desconto });
    } catch (e: any) {
      sendInternalError(res, 'delivery-public', e);
    }
  });

  router.post('/:slug/pedido/resumo', deliveryPublicPedidoResumoRateLimit, requireBrowserOrigin, requireDeliveryPublicPlan, async (req, res) => {
    try {
      const tenant = await getTenant(req.params.slug);
      if (!tenant) return res.status(404).json({ error: 'Loja nao encontrada' });

      const dcfg = parseDeliveryConfig(tenant.delivery_config);
      const { aberto: deliveryAberto } = computeDeliveryCardapioAberto(dcfg);
      if (!deliveryAberto) {
        return res.status(403).json({
          success: false,
          error: 'Delivery fechado no momento',
          aberto: false,
          code: 'DELIVERY_FECHADO',
        });
      }
      const summary = await buildCheckoutSummary({
        tenantId: tenant.id,
        config: dcfg,
        items: req.body?.items || [],
        pagamentoTipo: req.body?.pagamento_tipo,
        enderecoId: req.body?.endereco_id,
        bairro: req.body?.bairro_temporario,
        clienteToken: req.body?.clienteToken,
        cupomCodigo: req.body?.cupom_codigo,
        canalPedido: String(req.body?.canal || '').trim().toLowerCase() === 'retirada' ? 'retirada' : 'delivery',
        enderecoElegibilidadePreview: req.body?.endereco_eligibilidade ?? null,
      });

      res.json({ success: true, resumo: summary });
    } catch (e: any) {
      if (isAppError(e)) {
        return res.status(e.statusCode).json({ success: false, error: e.message, code: e.code });
      }

      sendInternalError(res, 'delivery-public', e);
    }
  });

  router.post('/:slug/auth/identificar', publicRateLimit, requireBrowserOrigin, requireDeliveryPublicPlan, async (req, res) => {
    try {
      const tenant = await getTenant(req.params.slug);
      if (!tenant) return res.status(404).json({ error: 'Loja nao encontrada' });
      const parsed = parseBodyOrReply(res, deliveryIdentificarBodySchema, req.body, replyZod400ErrorKey);
      if (!parsed) return;
      const tel = parsed.telefone;
      const cliente = await q1('SELECT * FROM delivery_clientes WHERE tenant_id=? AND telefone=?', [tenant.id, tel]);
      if (cliente) {
        await qRun('UPDATE delivery_clientes SET ultimo_acesso=NOW() WHERE id=?', [cliente.id]);
        const token = jwt.sign({ clienteId: cliente.id, tenantId: tenant.id, tipo: 'delivery_cliente' }, JWT_SECRET, { expiresIn: '15d' });
        return res.json({
          success: true,
          novo: false,
          token,
          cliente: {
            id: cliente.id,
            nome: cliente.nome,
            telefone: cliente.telefone,
            email: cliente.email,
            favoritos: JSON.parse(cliente.favoritos || '[]'),
          },
        });
      }
      res.json({ success: true, novo: true, telefone: tel });
    } catch (e: any) {
      sendInternalError(res, 'delivery-public', e);
    }
  });

  router.post('/:slug/auth/cadastrar', publicRateLimit, requireBrowserOrigin, requireDeliveryPublicPlan, async (req, res) => {
    try {
      const tenant = await getTenant(req.params.slug);
      if (!tenant) return res.status(404).json({ error: 'Loja nao encontrada' });
      const body = parseBodyOrReply(res, deliveryCadastrarBodySchema, req.body, replyZod400ErrorKey);
      if (!body) return;
      const { telefone: tel, nome, email } = body;
      const existe = await q1('SELECT * FROM delivery_clientes WHERE tenant_id=? AND telefone=?', [tenant.id, tel]);
      if (existe) {
        const token = jwt.sign({ clienteId: existe.id, tenantId: tenant.id, tipo: 'delivery_cliente' }, JWT_SECRET, { expiresIn: '15d' });
        return res.json({
          success: true,
          token,
          cliente: {
            id: existe.id,
            nome: existe.nome,
            telefone: existe.telefone,
            email: existe.email,
            favoritos: JSON.parse(existe.favoritos || '[]'),
          },
        });
      }
      const clienteId = await qInsert(
        'INSERT INTO delivery_clientes (tenant_id,nome,telefone,email,origem_cadastro) VALUES (?,?,?,?,?)',
        [tenant.id, nome, tel, email ?? null, 'delivery_online']
      );
      const token = jwt.sign({ clienteId, tenantId: tenant.id, tipo: 'delivery_cliente' }, JWT_SECRET, { expiresIn: '15d' });
      res.json({ success: true, token, cliente: { id: clienteId, nome, telefone: tel, email: email ?? null, favoritos: [] } });
    } catch (e: any) {
      sendInternalError(res, 'delivery-public', e);
    }
  });

  router.get('/:slug/cliente/perfil', requireDeliveryPublicPlan, authDeliveryCliente, async (req: any, res) => {
    try {
      const cliente = await q1('SELECT id,nome,telefone,email,favoritos FROM delivery_clientes WHERE id=? AND tenant_id=?', [req.clienteId, req.tenantId]);
      if (!cliente) return res.status(404).json({ error: 'Cliente nao encontrado' });
      res.json({ ...cliente, favoritos: JSON.parse(cliente.favoritos || '[]') });
    } catch (e: any) {
      sendInternalError(res, 'delivery-public', e);
    }
  });

  router.put('/:slug/cliente/perfil', requireDeliveryPublicPlan, authDeliveryCliente, async (req: any, res) => {
    try {
      const body = parseBodyOrReply(res, deliveryPerfilPutBodySchema, req.body, replyZod400ErrorKey);
      if (!body) return;
      await qRun('UPDATE delivery_clientes SET nome=?,email=? WHERE id=? AND tenant_id=?', [
        body.nome,
        body.email,
        req.clienteId,
        req.tenantId,
      ]);
      res.json({ success: true });
    } catch (e: any) {
      sendInternalError(res, 'delivery-public', e);
    }
  });

  router.put('/:slug/cliente/favoritos', requireDeliveryPublicPlan, authDeliveryCliente, async (req: any, res) => {
    try {
      await qRun('UPDATE delivery_clientes SET favoritos=? WHERE id=? AND tenant_id=?', [JSON.stringify(req.body.favoritos || []), req.clienteId, req.tenantId]);
      res.json({ success: true });
    } catch (e: any) {
      sendInternalError(res, 'delivery-public', e);
    }
  });

  router.get('/:slug/cliente/enderecos', requireDeliveryPublicPlan, authDeliveryCliente, async (req: any, res) => {
    try {
      res.json(await qAll('SELECT * FROM delivery_enderecos WHERE cliente_id=? AND tenant_id=? ORDER BY principal DESC, id DESC', [req.clienteId, req.tenantId]));
    } catch (e: any) {
      sendInternalError(res, 'delivery-public', e);
    }
  });

  router.post('/:slug/cliente/enderecos', requireDeliveryPublicPlan, authDeliveryCliente, async (req: any, res) => {
    try {
      const { label, logradouro, numero, complemento, bairro, referencia, principal } = req.body;
      if (!logradouro?.trim()) return res.status(400).json({ error: 'Logradouro obrigatorio' });
      if (!String(numero || '').trim()) return res.status(400).json({ error: 'Numero obrigatorio' });
      if (!String(bairro || '').trim()) return res.status(400).json({ error: 'Bairro obrigatorio' });
      const tenantCfgRow = await q1<{ delivery_config?: unknown }>(
        'SELECT delivery_config FROM clientes WHERE id=?',
        [req.tenantId]
      );
      const dcfgEnd = parseDeliveryConfig(tenantCfgRow?.delivery_config);
      const zonasEnd = (Array.isArray(dcfgEnd.zonas_entrega) ? dcfgEnd.zonas_entrega : []).filter((z) =>
        String(z?.nome || '').trim()
      );
      if (zonasEnd.length > 0 && !findDeliveryZoneByBairro(zonasEnd, bairro)) {
        return res.status(400).json({ success: false, error: MENSAGEM_ENTREGA_FORA_DA_AREA });
      }
      if (principal) await qRun('UPDATE delivery_enderecos SET principal=0 WHERE cliente_id=? AND tenant_id=?', [req.clienteId, req.tenantId]);
      const id = await qInsert(
        'INSERT INTO delivery_enderecos (tenant_id,cliente_id,label,logradouro,numero,complemento,bairro,referencia,principal) VALUES (?,?,?,?,?,?,?,?,?)',
        [req.tenantId, req.clienteId, label || 'Casa', logradouro.trim(), numero || null, complemento || null, bairro || null, referencia || null, principal ? 1 : 0]
      );
      res.json({ success: true, id });
    } catch (e: any) {
      sendInternalError(res, 'delivery-public', e);
    }
  });

  router.delete('/:slug/cliente/enderecos/:id', requireDeliveryPublicPlan, authDeliveryCliente, async (req: any, res) => {
    try {
      await qRun('DELETE FROM delivery_enderecos WHERE id=? AND cliente_id=? AND tenant_id=?', [req.params.id, req.clienteId, req.tenantId]);
      res.json({ success: true });
    } catch (e: any) {
      sendInternalError(res, 'delivery-public', e);
    }
  });

  router.get('/:slug/cliente/pedidos', requireDeliveryTrackingPlan, authDeliveryCliente, async (req: any, res) => {
    try {
      const rows = await qAll(
        `SELECT p.*,
          (SELECT STRING_AGG(pr.name||' x'||ip.quantity::text,', ') FROM itens_pedido ip JOIN produtos pr ON pr.id=ip.product_id WHERE ip.order_id=p.id) as resumo_itens,
          (SELECT COALESCE(JSON_AGG(json_build_object('product_id', ip.product_id, 'quantity', ip.quantity, 'price_at_time', ip.price_at_time, 'variation_id', ip.variation_id)), '[]') FROM itens_pedido ip WHERE ip.order_id=p.id) as itens
         FROM pedidos p WHERE p.tenant_id=? AND (p.cliente_id=? OR p.delivery_cliente_id=?) ORDER BY p.created_at DESC LIMIT 30`,
        [req.tenantId, req.clienteId, req.clienteId]
      );
      const parsed = rows.map((r: any) => ({ ...r, itens: Array.isArray(r.itens) ? r.itens : (typeof r.itens === 'string' ? JSON.parse(r.itens || '[]') : []) }));
      res.json(parsed);
    } catch (e: any) {
      sendInternalError(res, 'delivery-public', e);
    }
  });

  router.post('/:slug/pedido', deliveryPublicPedidoCreateRateLimit, requireBrowserOrigin, requireDeliveryPublicPlan, async (req: any, res) => {
    try {
      const tenant = await getTenant(req.params.slug);
      if (!tenant) return res.status(404).json({ error: 'Loja nao encontrada' });
      const dcfg = parseDeliveryConfig(tenant.delivery_config);
      const { aberto: deliveryAberto } = computeDeliveryCardapioAberto(dcfg);
      if (!deliveryAberto) {
        return res.status(403).json({
          success: false,
          error: 'Delivery fechado no momento',
          aberto: false,
          code: 'DELIVERY_FECHADO',
        });
      }
      const automation = parseAutomationFromDeliveryConfigJson(dcfg as Record<string, unknown>);
      const {
        items,
        pagamento_tipo,
        observation,
        cliente_nome,
        cliente_tel,
        endereco,
        clienteToken,
        cupom_codigo,
        endereco_id,
        bairro_temporario,
      } = req.body;
      const contatoRecebimentoTel = normalizeOptionalContatoRecebimentoTel(req.body?.contato_recebimento_tel);
      const observationGravada = mergeDeliveryPublicOrderObservation(observation, contatoRecebimentoTel);
      const canalPedido: OrderChannel = String(req.body?.canal || '').trim().toLowerCase() === 'retirada' ? 'retirada' : 'delivery';
      /** Delivery continua com tipo_retirada `local` (legado do PDV). Retirada: `levar` = buscar no balcão; `local` = consumo no estabelecimento. */
      let tipoRetirada: string;
      if (canalPedido === 'delivery') {
        tipoRetirada = 'local';
      } else {
        const bodyTr = String(req.body?.tipo_retirada || '').trim().toLowerCase();
        if (bodyTr === 'local' || bodyTr === 'levar') {
          tipoRetirada = bodyTr;
        } else {
          const modo = String(req.body?.modo_recebimento || '').trim().toLowerCase();
          tipoRetirada = modo === 'consumo_local' ? 'local' : 'levar';
        }
      }
      const clienteId = await resolveDeliveryCustomerId(tenant.id, clienteToken);
      const customerEmailFromBody = normalizeOptionalEmail(
        req.body?.customer_email ?? req.body?.cliente_email
      );
      let customerEmail = customerEmailFromBody;

      if (!customerEmail && clienteId) {
        const deliveryCustomer = await q1<{ email?: string | null }>(
          'SELECT email FROM delivery_clientes WHERE id=? AND tenant_id=?',
          [clienteId, tenant.id]
        );
        customerEmail = normalizeOptionalEmail(deliveryCustomer?.email);
      }

      const enderecoSalvo = await resolveSavedDeliveryAddress({
        tenantId: tenant.id,
        clienteId,
        enderecoId: endereco_id,
      });
      if (canalPedido === 'delivery' && clienteId && !enderecoSalvo) {
        throw new AppError(
          'Informe um endereco completo e salvo (endereco_id).',
          400,
          'DELIVERY_ENDERECO_ID_OBRIGATORIO'
        );
      }
      const checkoutSummary = await buildCheckoutSummary({
        tenantId: tenant.id,
        config: dcfg,
        items: items || [],
        pagamentoTipo: pagamento_tipo,
        enderecoId: endereco_id,
        bairro: bairro_temporario,
        clienteToken,
        cupomCodigo: cupom_codigo,
        canalPedido,
        enderecoElegibilidadePreview: req.body?.endereco_eligibilidade ?? null,
      });

      if (canalPedido === 'delivery' && checkoutSummary.entrega_bloqueada_por_zona) {
        return res.status(400).json({
          success: false,
          error: checkoutSummary.mensagem_entrega_bloqueada || MENSAGEM_ENTREGA_FORA_DA_AREA,
          code: 'DELIVERY_BAIRRO_FORA_DA_AREA',
        });
      }

      if (cupom_codigo && !checkoutSummary.cupom_aplicado) {
        return res.status(400).json({
          success: false,
          error: checkoutSummary.cupom_invalido || 'Cupom invalido ou expirado',
        });
      }

      const enderecoFinal = canalPedido === 'retirada'
        ? null
        : enderecoSalvo
          ? formatSavedDeliveryAddress(enderecoSalvo)
          : String(endereco || '').trim();

      if (canalPedido === 'delivery' && !enderecoFinal) {
        throw new AppError('Endereco de entrega obrigatorio', 400, 'DELIVERY_ENDERECO_OBRIGATORIO');
      }

      const itensValidados = checkoutSummary.itensValidados;
      const taxaEntrega = checkoutSummary.taxa_entrega;
      const totalFinal = checkoutSummary.total;
      const cupom = checkoutSummary.cupom_aplicado;
      const checkoutSnapshot = {
        modelo_entrega: checkoutSummary.modelo_entrega,
        bairro_entrega: checkoutSummary.bairro_entrega,
        subtotal: checkoutSummary.subtotal,
        desconto_pix: checkoutSummary.desconto_pix,
        subtotal_apos_desconto_pix: checkoutSummary.subtotal_apos_desconto_pix,
        taxa_entrega: checkoutSummary.taxa_entrega,
        zona_entrega: checkoutSummary.zona_entrega,
        desconto_cupom: checkoutSummary.desconto_cupom,
        cupom_aplicado: checkoutSummary.cupom_aplicado
          ? {
              codigo: checkoutSummary.cupom_aplicado.codigo,
              tipo: checkoutSummary.cupom_aplicado.tipo,
            }
          : null,
        desconto_primeiro_cliente: checkoutSummary.desconto_primeiro_cliente,
        primeiro_cliente: checkoutSummary.primeiro_cliente,
        total: checkoutSummary.total,
        delivery_endereco_id: enderecoSalvo?.id ?? null,
        ...(contatoRecebimentoTel ? { contato_recebimento_tel: contatoRecebimentoTel } : {}),
      };

      const dateObj = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
      const y = String(dateObj.getFullYear()).slice(-2);
      const m = String(dateObj.getMonth() + 1).padStart(2, '0');
      const d = String(dateObj.getDate()).padStart(2, '0');
      const prefix = `D${y}${m}${d}`;

      const pagamentoTipoCanon = normalizeDeliveryPublicPaymentMethod(pagamento_tipo);

      if (canalPedido === 'delivery' && dcfg.motoboy_sob_demanda && pagamentoTipoCanon !== 'pix') {
        return res.status(400).json({
          success: false,
          error: 'Este estabelecimento aceita apenas Pix para entregas no momento.',
          code: 'DELIVERY_PAGAMENTO_SOMENTE_PIX',
        });
      }

      const pagamentoStatusInicial =
        pagamentoTipoCanon === 'pix' ? 'aguardando_confirmacao' : 'pendente';

      const initialOrderStatus =
        canalPedido === 'delivery' && automation.delivery_auto_accept_orders ? 'Pedido Recebido' : 'Criado';
      const inventoryEnabled = await tenantHasInventoryFeature(tenant.id);

      const result = await withTx(async (client) => {
        // order_number tem constraint UNIQUE (global) no Postgres.
        // O padrão anterior (COUNT por tenant + 1) falha por concorrência e pode colidir entre tenants no mesmo dia.
        // Serializamos a geração por prefixo (dia) e calculamos o próximo número global por prefixo.
        await txRun(client, 'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [prefix]);
        const r = await txQ1<{ n: number | string | null }>(
          client,
          `SELECT COALESCE(MAX((substring(order_number from '(\\d+)$'))::int), 0) as n
             FROM pedidos
            WHERE order_number LIKE ?`,
          [`${prefix}-%`]
        );
        const num = Number(r?.n || 0) + 1;
        const orderNumber = `${prefix}-${String(num).padStart(3, '0')}`;

        const deliveryEnderecoId =
          canalPedido === 'delivery' && enderecoSalvo?.id != null ? Number(enderecoSalvo.id) : null;

        const orderId = await txInsert(
          client,
          `INSERT INTO pedidos (order_number,total_amount,taxa_entrega,observation,tenant_id,canal,tipo_retirada,cliente_nome,cliente_tel,endereco,pagamento_tipo,pagamento_status,status,delivery_cliente_id,cliente_id,delivery_checkout_snapshot,delivery_endereco_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            orderNumber,
            totalFinal,
            taxaEntrega,
            observationGravada,
            tenant.id,
            canalPedido,
            tipoRetirada,
            cliente_nome || null,
            String(cliente_tel || '').replace(/\D/g, '') || null,
            enderecoFinal,
            pagamentoTipoCanon,
            pagamentoStatusInicial,
            initialOrderStatus,
            clienteId,
            clienteId,
            JSON.stringify(checkoutSnapshot),
            deliveryEnderecoId,
          ]
        );

          for (const item of itensValidados) {
            const lineObs = normalizeItemObservationForDb(item.obs_opcoes ?? item.observation);
            const selecoesJson = serializeOrderItemSelecoes(item.selecoes);
            await txRun(
              client,
              'INSERT INTO itens_pedido (order_id,product_id,quantity,type,price_at_time,tenant_id,variation_id,observation,selecoes_json) VALUES (?,?,?,?,?,?,?,?,?)',
              [
                orderId,
                item.product_id,
                item.quantity,
                canalPedido === 'retirada' ? 'Retirada' : 'Delivery',
                item.price_at_time,
                tenant.id,
                item.variation_id ?? null,
                lineObs,
                selecoesJson,
              ]
            );
            if (inventoryEnabled) {
              const resolution = await resolveProductInventoryTargets({
                client,
                tenantId: tenant.id,
                productId: item.product_id,
                variationId: item.variation_id ?? null,
              });
              if (resolution && resolution.targets.length > 0) {
                for (const target of resolution.targets) {
                  const qtd = Number(target.quantityMultiplier) * Number(item.quantity);
                  await txRun(client, 'UPDATE ingredientes SET estoque_atual=GREATEST(0,estoque_atual-?) WHERE id=? AND tenant_id=?', [qtd, target.ingredientId, tenant.id]);
                  await txRun(client, "INSERT INTO estoque_movimentacoes (ingrediente_id,tipo,quantidade,motivo,tenant_id) VALUES (?,'saida',?,'Venda delivery automatica',?)", [target.ingredientId, qtd, tenant.id]);
                }
              } else {
                console.warn('[delivery-estoque] Pedido autorizado sem baixa de estoque - produto sem vinculo', {
                  tenantId: tenant.id,
                  orderId,
                  productId: item.product_id,
                  variationId: item.variation_id ?? null,
                  productName: resolution?.product?.name ?? '?',
                });
              }
            }
          }

        if (cupom) await txRun(client, 'UPDATE delivery_cupons SET uso_atual=uso_atual+1 WHERE id=?', [cupom.id]);
        if (clienteId) {
          await txRun(
            client,
            `UPDATE delivery_clientes
             SET primeira_compra_at = COALESCE(primeira_compra_at, NOW()),
                 ultima_compra_at = NOW(),
                 ultimo_acesso = NOW(),
                 updated_at = NOW(),
                 origem_cadastro = COALESCE(NULLIF(BTRIM(origem_cadastro), ''), 'delivery_online')
             WHERE id=? AND tenant_id=?`,
            [clienteId, tenant.id]
          );
        }

        await insertDeliveryPublicOrderEventTx(client, {
          pedidoId: Number(orderId),
          tenantId: Number(tenant.id),
          tipo: 'CRIACAO',
          statusNovo: initialOrderStatus,
          valor: totalFinal,
          payload: {
            origem: 'routes.deliveryPublic.createOrder',
            canal: canalPedido,
            tipo_retirada: tipoRetirada,
            auto_accept:
              canalPedido === 'delivery' && Boolean(automation.delivery_auto_accept_orders),
            pagamento_tipo_raw: pagamento_tipo ?? null,
            pagamento_tipo_normalized: pagamentoTipoCanon,
            pagamento_status_initial: pagamentoStatusInicial,
          },
        });

        return { orderId, orderNumber };
      });

      const isPixPayment = pagamentoTipoCanon === 'pix';
      const hasStaticPixFallback = Boolean(
        String(dcfg.pix_payload_estatico || '').trim() || String(dcfg.pix_chave || '').trim()
      );
      let paymentPix: Awaited<ReturnType<typeof createPixPayment>> = null;
      let paymentPixError: unknown = null;

      if (isPixPayment) {
        try {
          paymentPix = await createPixPayment({
            tenant_id: tenant.id,
            order_id: Number(result.orderId),
            amount: totalFinal,
            customer_name: cliente_nome || null,
            customer_email: customerEmail,
            external_reference: result.orderNumber,
            description: `${canalPedido === 'retirada' ? 'Pedido retirada' : 'Pedido delivery'} #${result.orderNumber}`,
            metadata: {
              channel: canalPedido,
              order_number: result.orderNumber,
            },
          });
        } catch (error) {
          paymentPixError = isAppError(error)
            ? new AppError(
                `${error.message}. Pedido nao foi confirmado.`,
                error.statusCode >= 500 ? error.statusCode : 502,
                'DELIVERY_PIX_CREATE_FAILED'
              )
            : new AppError(
                'Nao foi possivel gerar o Pix deste pedido agora. Pedido nao foi confirmado.',
                502,
                'DELIVERY_PIX_CREATE_FAILED'
              );
          logError('delivery-public.createPixPayment', error, {
            tenantId: tenant.id,
            orderId: result.orderId,
            orderNumber: result.orderNumber,
            customerEmailPreview: customerEmail
              ? customerEmail.replace(/(^..).+(@.*$)/, '$1***$2')
              : null,
          });
        }

        if (paymentPixError) {
          throw paymentPixError;
        }

        if (!paymentPix && !hasStaticPixFallback) {
          throw new AppError(
            'Nao foi possivel gerar o Pix deste pedido e nao ha configuracao estatica para fallback. Pedido nao foi confirmado.',
            502,
            'DELIVERY_PIX_UNAVAILABLE'
          );
        }
      }

      notifyTenantOrderStreams(Number(tenant.id), 'new', { orderId: Number(result.orderId) });

      const waNumber = (dcfg.whatsapp || tenant.whatsapp || '').replace(/\D/g, '');
      const listaItens = await Promise.all(itensValidados.map(async (item: any) => {
        const name = item.name || (await q1('SELECT name FROM produtos WHERE id=?', [item.product_id]))?.name || 'Produto';
        const det = normalizeItemObservationForDb(item.obs_opcoes ?? item.observation);
        const detSuffix = det ? ` — ${det}` : '';
        return `- ${item.quantity}x ${name}${detSuffix} - R$ ${(item.price_at_time * item.quantity).toFixed(2).replace('.', ',')}`;
      }));
      const pagLabel: Record<string, string> = { pix: 'PIX', dinheiro: 'Dinheiro', cartao: 'Cartao', debito: 'Debito', credito: 'Credito' };
      const paymentLabelKey = pagamentoTipoCanon || normalizePaymentMethodKey(pagamento_tipo);
      const paymentLabel = pagLabel[paymentLabelKey] || String(pagamento_tipo ?? '').trim() || 'Pagamento';
      const mapsUrl = canalPedido === 'delivery'
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(enderecoFinal || '')}`
        : null;
      const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const data = new Date().toLocaleDateString('pt-BR');
      const msg = canalPedido === 'retirada'
        ? `NOVO PEDIDO RETIRADA #${result.orderNumber}\n\n${data} as ${hora}\n\nCliente: ${cliente_nome || 'Cliente'}\nTelefone: ${cliente_tel || '-'}\n\nITENS:\n${listaItens.join('\n')}\n\n${paymentLabel}\nTotal: R$ ${totalFinal.toFixed(2).replace('.', ',')}`
        : `NOVO PEDIDO DELIVERY #${result.orderNumber}\n\n${data} as ${hora}\n\nCliente: ${cliente_nome || 'Cliente'}\nTelefone: ${cliente_tel || '-'}\nEndereco: ${enderecoFinal || '-'}\nMapa: ${mapsUrl}\n\nITENS:\n${listaItens.join('\n')}\n\n${paymentLabel}\nTotal: R$ ${totalFinal.toFixed(2).replace('.', ',')}`;
      const waLink = waNumber ? `https://wa.me/55${waNumber}?text=${encodeURIComponent(msg)}` : null;

      if (canalPedido === 'delivery' && automation.delivery_auto_accept_orders && pagamentoTipoCanon !== 'pix') {
        void recordDeliveryAutoAcceptOnline(tenant.id, Number(result.orderId)).catch((err) =>
          logError('delivery-public.recordDeliveryAutoAcceptOnline.unhandled', err, { tenantId: tenant.id, orderId: result.orderId })
        );
      }

      if (canalPedido === 'retirada' && automation.retirada_auto_print_production) {
        void runAutomatedKitchenPrintForOrder(tenant.id, Number(result.orderId), { trigger: 'retirada_public_create' }).catch((err) =>
          logError('delivery-public.autoKitchenPrint.unhandled', err, {
            tenantId: tenant.id,
            orderId: result.orderId,
            trigger: 'retirada_public_create',
          })
        );
      }
      if (
        canalPedido === 'delivery' &&
        automation.delivery_auto_print_production &&
        automation.delivery_auto_accept_orders
      ) {
        void runAutomatedKitchenPrintForOrder(tenant.id, Number(result.orderId), { trigger: 'delivery_public_create' }).catch((err) =>
          logError('delivery-public.autoKitchenPrint.unhandled', err, {
            tenantId: tenant.id,
            orderId: result.orderId,
            trigger: 'delivery_public_create',
          })
        );
      }

      res.json({
        success: true,
        orderId: result.orderId,
        orderNumber: result.orderNumber,
        total: totalFinal,
        canal: canalPedido,
        pagamento_status: pagamentoTipoCanon === 'pix' ? 'aguardando_confirmacao' : 'pendente',
        waLink,
        mapsUrl,
        payment_pix: buildPublicPixPayment(
          paymentPix
            ? {
                ...paymentPix,
                qr_code_image_base64: paymentPix.qr_code_base64,
              }
            : null
        ),
        config_pix: buildPublicPixConfig(dcfg, tenant.whatsapp, paymentPix),
        resumo_checkout: {
          taxa_entrega: checkoutSummary.taxa_entrega,
          desconto_pix: checkoutSummary.desconto_pix,
          desconto_cupom: checkoutSummary.desconto_cupom,
          desconto_primeiro_cliente: checkoutSummary.desconto_primeiro_cliente,
          total: checkoutSummary.total,
        },
      });
      } catch (e: any) {
        logError('delivery-public.createOrder', e, {
          slug: req.params.slug,
        });

        if (isAppError(e)) {
          return res.status(e.statusCode).json({ success: false, error: e.message, code: e.code });
        }

        console.error('POST /public/delivery/:slug/pedido:', e.message);
        sendInternalError(res, 'delivery-public', e);
      }
    });

  router.post(
    '/:slug/pedido/:pedidoId/gerar-novo-pix',
    publicRateLimit,
    requireBrowserOrigin,
    requireDeliveryTrackingPlan,
    optionalAuthDeliveryCliente,
    async (req: any, res) => {
      try {
        const pedidoId = Number(req.params.pedidoId);
        if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
          return res.status(400).json({ error: 'Pedido invalido' });
        }

        const tenant = await getTenant(req.params.slug);
        if (!tenant) return res.status(404).json({ error: 'Estabelecimento nao encontrado' });
        const dcfg = parseDeliveryConfig(tenant.delivery_config);

        let pedido = await q1<{
          id: number;
          order_number: string;
          total_amount: number | string;
          cliente_nome: string | null;
          pagamento_tipo: string | null;
          pagamento_status: string | null;
          canal: string | null;
          delivery_cliente_id: number | null;
          cliente_id: number | null;
        }>(
          `SELECT id, order_number, total_amount, cliente_nome, pagamento_tipo, pagamento_status,
                  canal, delivery_cliente_id, cliente_id
             FROM pedidos
            WHERE id=? AND tenant_id=?`,
          [pedidoId, tenant.id]
        );
        if (!pedido) return res.status(404).json({ error: 'Pedido nao encontrado' });
        if (pedido.canal !== 'delivery' && pedido.canal !== 'retirada') {
          return res.status(400).json({ error: 'Canal do pedido nao permite gerar Pix por aqui' });
        }
        if (String(pedido.pagamento_tipo || '').trim().toLowerCase() !== 'pix') {
          return res.status(400).json({ error: 'Este pedido nao usa pagamento Pix' });
        }

        const ownerClienteId = Number(pedido.delivery_cliente_id || pedido.cliente_id || 0);
        if (ownerClienteId > 0) {
          if (req.clienteId == null) {
            return res.status(401).json({
              error: 'Identifique-se para gerar um novo Pix deste pedido',
              code: 'DELIVERY_REGERAR_PIX_AUTH',
            });
          }
          if (Number(req.tenantId) !== Number(tenant.id)) {
            return res.status(403).json({ error: 'Token nao corresponde a esta loja' });
          }
          if (Number(req.clienteId) !== ownerClienteId) {
            return res.status(403).json({ error: 'Pedido nao pertence a esta conta' });
          }
        }

        await tryRevalidatePendingPixOrder({
          orderId: Number(pedido.id),
          tenantId: Number(tenant.id),
          paymentMethod: pedido.pagamento_tipo,
          paymentStatus: pedido.pagamento_status,
          context: 'delivery-public.regeneratePix.revalidateBeforeCreate',
        });

        pedido = await q1<{
          id: number;
          order_number: string;
          total_amount: number | string;
          cliente_nome: string | null;
          pagamento_tipo: string | null;
          pagamento_status: string | null;
          canal: string | null;
          delivery_cliente_id: number | null;
          cliente_id: number | null;
        }>(
          `SELECT id, order_number, total_amount, cliente_nome, pagamento_tipo, pagamento_status,
                  canal, delivery_cliente_id, cliente_id
             FROM pedidos
            WHERE id=? AND tenant_id=?`,
          [pedidoId, tenant.id]
        );
        if (!pedido) return res.status(404).json({ error: 'Pedido nao encontrado' });

        const pagamentoStatus = String(pedido.pagamento_status || '').trim().toLowerCase();
        if (pagamentoStatus === 'pago') {
          return res.status(409).json({ error: 'O pagamento deste pedido ja foi confirmado' });
        }

        const persistedPayments = await getPaymentByOrderId({
          orderId: Number(pedido.id),
          tenantId: Number(tenant.id),
        });

        const latestPixPayment = persistedPayments.find(
          (payment) => String(payment.method || '').trim().toLowerCase() === 'pix'
        );

        if (!latestPixPayment) {
          return res.status(404).json({ error: 'Nenhuma cobranca Pix foi encontrada para este pedido' });
        }

        if (!isPixPaymentExpired(latestPixPayment)) {
          return res.status(409).json({ error: 'Ainda existe um Pix valido para este pedido' });
        }

        const previousPaymentKey = String(latestPixPayment.id);
        const orderNumber = String(pedido.order_number || pedido.id).trim() || String(pedido.id);
        const amount = Number(pedido.total_amount || 0);

        const paymentPix = await createPixPayment({
          tenant_id: tenant.id,
          order_id: Number(pedido.id),
          amount: Number.isFinite(amount) ? amount : 0,
          customer_name: pedido.cliente_nome || null,
          external_reference: `${orderNumber}-repix-${previousPaymentKey}`,
          description: `${pedido.canal === 'retirada' ? 'Pedido retirada' : 'Pedido delivery'} #${orderNumber} (novo Pix)`,
          metadata: {
            channel: pedido.canal || null,
            order_number: orderNumber,
            previous_payment_id: Number(latestPixPayment.id),
            source: 'routes.deliveryPublic.regeneratePix',
          },
          force_new: true,
          idempotency_key: `${tenant.id}-${pedido.id}-pix-refresh-${previousPaymentKey}`,
        });

        if (!paymentPix) {
          return res.status(502).json({ error: 'Nao foi possivel gerar um novo Pix para este pedido agora' });
        }

        if (pagamentoStatus !== 'aguardando_confirmacao') {
          await qRun("UPDATE pedidos SET pagamento_status='aguardando_confirmacao' WHERE id=? AND tenant_id=?", [
            pedido.id,
            tenant.id,
          ]);
          notifyTenantOrderStreams(Number(tenant.id), 'status', { orderId: Number(pedido.id) });
        }

        return res.json({
          success: true,
          pagamento_status: 'aguardando_confirmacao',
          payment_pix: buildPublicPixPayment({
            ...paymentPix,
            qr_code_image_base64: paymentPix.qr_code_base64,
          }),
          config_pix: buildPublicPixConfig(dcfg, tenant.whatsapp, paymentPix),
        });
      } catch (e: any) {
        if (isAppError(e)) {
          return res.status(e.statusCode).json({ success: false, error: e.message, code: e.code });
        }
        sendInternalError(res, 'delivery-public', e);
      }
    }
  );

  router.post(
    '/:slug/pedido/:pedidoId/confirmar-pix',
    publicRateLimit,
    requireBrowserOrigin,
    requireDeliveryTrackingPlan,
    optionalAuthDeliveryCliente,
    async (req: any, res) => {
      try {
        const pedidoId = Number(req.params.pedidoId);
        if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
          return res.status(400).json({ error: 'Pedido invalido' });
        }

        const tenant = await q1('SELECT id FROM clientes WHERE usuario=? AND status=?', [req.params.slug, 'ativo']);
        if (!tenant) return res.status(404).json({ error: 'Estabelecimento nao encontrado' });

        const pedido = await q1<{
          id: number;
          pagamento_status: string | null;
          canal: string | null;
          delivery_cliente_id: number | null;
          cliente_id: number | null;
        }>(
          'SELECT id, pagamento_status, canal, delivery_cliente_id, cliente_id FROM pedidos WHERE id=? AND tenant_id=?',
          [pedidoId, tenant.id]
        );
        if (!pedido) return res.status(404).json({ error: 'Pedido nao encontrado' });
        if (pedido.canal !== 'delivery' && pedido.canal !== 'retirada') {
          return res.status(400).json({ error: 'Canal do pedido nao permite confirmacao por aqui' });
        }

        const ownerClienteId = Number(pedido.delivery_cliente_id || pedido.cliente_id || 0);
        if (ownerClienteId > 0) {
          if (req.clienteId == null) {
            return res.status(401).json({
              error: 'Identifique-se para confirmar o pagamento deste pedido',
              code: 'DELIVERY_CONFIRMAR_PIX_AUTH',
            });
          }
          if (Number(req.tenantId) !== Number(tenant.id)) {
            return res.status(403).json({ error: 'Token nao corresponde a esta loja' });
          }
          if (Number(req.clienteId) !== ownerClienteId) {
            return res.status(403).json({ error: 'Pedido nao pertence a esta conta' });
          }
        }

        const ps = String(pedido.pagamento_status || '').trim().toLowerCase();
        if (ps === 'pago') {
          return res.json({ success: true, pagamento_status: 'pago' });
        }
        if (ps === 'aguardando_confirmacao') {
          return res.json({ success: true, pagamento_status: 'aguardando_confirmacao' });
        }

        await qRun("UPDATE pedidos SET pagamento_status='aguardando_confirmacao' WHERE id=? AND tenant_id=?", [
          pedido.id,
          tenant.id,
        ]);
        notifyTenantOrderStreams(Number(tenant.id), 'status', { orderId: Number(pedido.id) });
        res.json({ success: true, pagamento_status: 'aguardando_confirmacao' });
      } catch (e: any) {
        sendInternalError(res, 'delivery-public', e);
      }
    }
  );

  router.post('/:slug/suggestions', publicRateLimit, requireBrowserOrigin, requireDeliveryPublicPlan, async (req, res) => {
    try {
      const tenant = await getTenant(req.params.slug);
      if (!tenant) return res.status(404).json({ error: 'Loja nao encontrada' });

      const rawIds = Array.isArray(req.body?.productIds) ? req.body.productIds : [];
      const productIds = [...new Set(
        rawIds
          .map((id: any) => Number(id))
          .filter((id: number) => Number.isInteger(id) && id > 0)
      )];
      if (!productIds.length) {
        return res.json([]);
      }

      const sourcePlaceholders = productIds.map(() => '?').join(',');
      const excludePlaceholders = productIds.map(() => '?').join(',');
      const manualRows = await qAll(
        `SELECT
           p.id,
           p.name,
           p.price,
           p.category,
           p.photo_url,
           MAX(ps.prioridade) AS prioridade,
           COALESCE(MAX(se.total_eventos), 0) AS total_eventos,
           (array_agg(ps.produto_id ORDER BY ps.prioridade DESC, ps.produto_id ASC))[1] AS source_product_id,
           (SELECT COALESCE(JSON_AGG(json_build_object('id', pvv.id, 'nome', pvv.nome, 'preco', pvv.preco) ORDER BY pvv.ordem, pvv.nome), '[]') FROM produto_variacoes_vendaveis pvv WHERE pvv.produto_id=p.id AND pvv.tenant_id=p.tenant_id AND pvv.ativo=1) AS variacoes_vendaveis
         FROM produto_sugestoes ps
         JOIN produtos p
           ON p.id = ps.produto_sugerido_id
          AND p.tenant_id = ps.tenant_id
         LEFT JOIN (
           SELECT produto_sugerido_id, COUNT(id) AS total_eventos
           FROM sugestoes_eventos
           WHERE tenant_id = ?
           GROUP BY produto_sugerido_id
         ) se ON se.produto_sugerido_id = p.id
         WHERE ps.tenant_id = ?
           AND ps.ativo = 1
           AND p.active = 1
           AND ps.produto_id IN (${sourcePlaceholders})
           AND ps.produto_id <> ps.produto_sugerido_id
           AND ps.produto_sugerido_id NOT IN (${excludePlaceholders})
         GROUP BY p.id, p.name, p.price, p.category, p.photo_url
         ORDER BY MAX(ps.prioridade) DESC, COALESCE(MAX(se.total_eventos), 0) DESC, p.name ASC
         LIMIT 3`,
        [tenant.id, tenant.id, ...productIds, ...productIds]
      );

      const suggestions = [...manualRows];
      if (suggestions.length < 3) {
        const cartProfile = await qAll(
          `SELECT production_type, category
           FROM produtos
           WHERE tenant_id = ?
             AND id IN (${sourcePlaceholders})`,
          [tenant.id, ...productIds]
        );

        const hasKitchen = cartProfile.some((p: any) => String(p.production_type || '').toLowerCase() === 'kitchen');
        const hasDrink = cartProfile.some((p: any) => {
          const productionType = String(p.production_type || '').toLowerCase();
          const category = String(p.category || '').toLowerCase();
          return productionType === 'bar' || category.includes('bebida');
        });

        if (hasKitchen || hasDrink) {
          const alreadySuggestedIds = suggestions.map((s: any) => Number(s.id)).filter((id: number) => Number.isInteger(id) && id > 0);
          const excludedIds = [...new Set([...productIds, ...alreadySuggestedIds])];
          const excludedPlaceholders = excludedIds.map(() => '?').join(',');
          const fallbackFilters: string[] = [];

          if (hasKitchen) {
            fallbackFilters.push(`(LOWER(COALESCE(p.production_type, '')) = 'bar' OR LOWER(COALESCE(p.category, '')) LIKE '%bebida%')`);
          }
          if (hasDrink) {
            fallbackFilters.push(`LOWER(COALESCE(p.production_type, '')) = 'kitchen'`);
          }

          if (fallbackFilters.length > 0) {
            const missing = 3 - suggestions.length;
            const fallbackRows = await qAll(
              `SELECT
                 p.id,
                 p.name,
                 p.price,
                 p.category,
                 p.photo_url,
                 0 AS prioridade,
                 0 AS total_eventos,
                 CAST(NULL AS INTEGER) AS source_product_id,
                 (SELECT COALESCE(JSON_AGG(json_build_object('id', pvv.id, 'nome', pvv.nome, 'preco', pvv.preco) ORDER BY pvv.ordem, pvv.nome), '[]') FROM produto_variacoes_vendaveis pvv WHERE pvv.produto_id=p.id AND pvv.tenant_id=p.tenant_id AND pvv.ativo=1) AS variacoes_vendaveis
               FROM produtos p
               WHERE p.tenant_id = ?
                 AND p.active = 1
                 AND p.id NOT IN (${excludedPlaceholders})
                 AND (${fallbackFilters.join(' OR ')})
               ORDER BY COALESCE(p.destaque, 0) DESC, COALESCE(p.em_promocao, 0) DESC, p.price ASC, p.name ASC
               LIMIT ?`,
              [tenant.id, ...excludedIds, missing]
            );
            suggestions.push(...fallbackRows);
          }
        }
      }

      return res.json(
        suggestions.slice(0, 3).map((row: { photo_url?: unknown }) => ({
          ...row,
          photo_url: normalizeProductPhotoPublicUrl(row.photo_url),
        }))
      );
    } catch (error: unknown) {
      sendInternalError(res, 'delivery-public:suggestions', error);
    }
  });

  return router;
}