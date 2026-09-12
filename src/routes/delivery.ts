// src/routes/delivery.ts — rotas autenticadas do painel delivery
import type { PoolClient } from 'pg';
import { Router, Request } from 'express';
import fs from 'fs';
import path from 'path';
import {
  buildPublicOrderItemFromPersisted,
  confirmOrderPayment,
  serializeOrderItemSelecoes,
} from '../services/ordersService';
import { q1, qAll, qRun, qInsert, withTx, txQ1, txQAll, txRun, txInsert } from '../db';
import { sendInternalError } from '../utils/internalServerError';
import {
  requireAnyPermission,
  uploadDeliveryCardapioLogo,
  uploadDeliveryCardapioBanner,
  uploadDeliveryCardapioReactivationMedia,
  hardenUploadedImageFile,
} from '../middleware';
import { parseAutomationFromDeliveryConfigJson } from '../services/automationConfig';
import { validateDeliveryItems } from '../services/deliveryItemValidation';
import { createPixPayment } from '../services/paymentsService';
import { ensureItauWebhookRegistered, testItauAuthentication } from '../services/payments/providers';
import { isKitchenDispatchFailure } from '../services/kitchenPrintDispatchService';
import { runAutomatedKitchenPrintForOrder } from '../services/operationalAutomationService';
import { revalidatePixPaymentByOrder } from '../services/pixPaymentRevalidationService';
import {
  emitWhatsAppOrderStatusEvent,
} from '../services/whatsAppEventsService';
import { isAppError } from '../utils/errors';
import { logError } from '../utils/logger';
import { getDeliveryNextStatus } from '../utils/deliveryStatusNext';
import { getCustomerLoyaltyTier } from '../services/customerLoyaltyTier';
import { buildValidOrderSqlClause } from '../services/orderValiditySql';
import {
  findOrCreateStoreCustomerByPhone,
  touchStoreCustomerPurchase,
} from '../services/storeCustomerService';
import { sendWhatsAppMediaMessage, sendWhatsAppMessage } from '../services/whatsAppSenderService';
import { notifyTenantOrderStreams } from '../sse';
import { normalizeCardapioOnlineBannerSlots } from '../utils/deliveryCardapioBannerSlots';
import {
  applyNormalizedBannerSlots,
  coerceDeliveryConfigRow,
  mergeDeliveryConfigClientPut,
} from '../utils/deliveryConfigPersist';
import { UPLOADS_ROOT } from '../uploadsRoot';
import { deleteStoredUpload } from '../services/uploadPersistence';
import { tenantHasFeature } from '../services/tenantPlan';
import {
  forbidClientSuppliedLocalUploadImageUrls,
  isClientSuppliedLocalUploadImageUrl,
  persistMulterImageFile,
} from '../services/imageUploadPolicy';
import {
  isCloudinaryProductUploadEnabled,
  uploadDeliveryBannerToCloudinary,
  uploadDeliveryCardapioLogoToCloudinary,
  uploadDeliveryReactivationMediaToCloudinary,
} from '../services/cloudinaryProduct';

const TZ = 'America/Sao_Paulo';
const MANUAL_DELIVERY_TOTAL_TOLERANCE = 0.01;
const MANUAL_ORDER_NUMBER_RETRY_MAX = 5;
const DELIVERY_FLOW_STATUSES = new Set([
  'Criado',
  'Pedido Recebido',
  'Em Preparo',
  'Pronto para Entrega',
  'Saiu para Entrega',
  'Entregue',
]);

function isPgUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
const ACTIVE_CUSTOMER_DAYS = 30;
const INACTIVE_CUSTOMER_DAYS = 60;

function isCanceledOrder(order?: { status?: string | null; cancelado_at?: string | null } | null) {
  return Boolean(order?.cancelado_at) || String(order?.status || '').trim().toLowerCase() === 'cancelado';
}

function normalizePhone(value: unknown) {
  return String(value || '').replace(/\D/g, '');
}

function isLikelyValidCustomerPhone(value: unknown) {
  const digits = normalizePhone(value);
  if (!digits) return false;
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return true;
  return digits.length === 10 || digits.length === 11;
}

function normalizeOptionalText(value: unknown) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function normalizePaymentProvider(value: unknown) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (!normalized) return null;
  if (normalized === 'mercadopago') return 'mercado_pago';
  return normalized;
}

function normalizePublicBaseUrl(rawValue: unknown) {
  const normalized = normalizeOptionalText(rawValue);
  if (!normalized) return null;

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)
    ? normalized
    : `https://${normalized}`;

  try {
    const url = new URL(withProtocol);
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function resolvePublicBackendBaseUrl() {
  const envCandidates = [
    process.env.FLOWPDV_PUBLIC_URL,
    process.env.PUBLIC_API_BASE_URL,
    process.env.APP_URL,
    process.env.BACKEND_URL,
    process.env.RAILWAY_STATIC_URL,
    process.env.RAILWAY_PUBLIC_DOMAIN,
  ];

  for (const candidate of envCandidates) {
    const normalized = normalizePublicBaseUrl(candidate);
    if (normalized) return normalized;
  }

  return null;
}

type DeliveryOrderEventInput = {
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

function buildDeliveryOrderEventParams(input: DeliveryOrderEventInput) {
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

async function insertDeliveryOrderEventTx(client: PoolClient, input: DeliveryOrderEventInput) {
  await txRun(
    client,
    `INSERT INTO pedido_eventos
      (pedido_id,tenant_id,tipo,status_anterior,status_novo,valor,motivo,estoque_reposto,payload,usuario_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    buildDeliveryOrderEventParams(input)
  );
}

async function insertDeliveryOrderEvent(input: DeliveryOrderEventInput) {
  await qRun(
    `INSERT INTO pedido_eventos
      (pedido_id,tenant_id,tipo,status_anterior,status_novo,valor,motivo,estoque_reposto,payload,usuario_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    buildDeliveryOrderEventParams(input)
  );
}

type TenantWhatsAppConfigSyncRow = {
  whatsapp_enabled?: number | boolean | string | null;
  provider?: string | null;
  provider_config_json?: string | null;
  whatsapp_number?: string | null;
  instance_name?: string | null;
  channel_identifier?: string | null;
  auto_notify_order_accepted?: number | boolean | string | null;
  auto_notify_order_preparing?: number | boolean | string | null;
  auto_notify_order_out_for_delivery?: number | boolean | string | null;
};

const DELIVERY_CONFIG_WHATSAPP_TRANSPORT_KEYS = [
  'evolution_url',
  'evolution_token',
  'evolution_instance',
  'evolution_phone_number',
  'evolution_channel_id',
] as const;

type DeliveryConfigWhatsAppTransportInput = Partial<Record<(typeof DELIVERY_CONFIG_WHATSAPP_TRANSPORT_KEYS)[number], unknown>>;

function normalizeWhatsAppProvider(value: unknown) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (!normalized) return null;
  if (normalized === 'evolution') return 'evolution_api';
  return normalized;
}

function parseConfigJsonObject(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, any>) };
  }

  try {
    const parsed = JSON.parse(String(value));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, any>) };
    }
  } catch {
    /* ignore invalid provider_config_json here */
  }

  return {};
}

function getConfigValueText(record: Record<string, any>, keys: string[]) {
  for (const key of keys) {
    const normalized = normalizeOptionalText(record[key]);
    if (normalized) return normalized;
  }

  return null;
}

function buildEvolutionProviderConfigJson(input: {
  evolutionUrl: string | null;
  evolutionToken: string | null;
  evolutionInstance: string | null;
  whatsappNumber: string | null;
  channelIdentifier: string | null;
}) {
  const providerConfig: Record<string, string> = {};

  if (input.evolutionUrl) providerConfig.base_url = input.evolutionUrl;
  if (input.evolutionToken) providerConfig.apikey = input.evolutionToken;
  if (input.evolutionInstance) {
    providerConfig.instance = input.evolutionInstance;
    providerConfig.instance_name = input.evolutionInstance;
  }
  if (input.whatsappNumber) {
    providerConfig.phone_number = input.whatsappNumber;
    providerConfig.display_number = input.whatsappNumber;
  }
  if (input.channelIdentifier) providerConfig.channel_id = input.channelIdentifier;

  return Object.keys(providerConfig).length > 0 ? JSON.stringify(providerConfig) : null;
}

function toFlag(value: unknown) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;

  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function buildTenantWhatsAppInboundWebhookPath(tenantId: number) {
  return `/api/webhooks/whatsapp/inbound/${tenantId}`;
}

function hasDeliveryConfigWhatsAppTransportInput(input: DeliveryConfigWhatsAppTransportInput) {
  return DELIVERY_CONFIG_WHATSAPP_TRANSPORT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(input, key));
}

function hasTenantWhatsAppTransportState(config: TenantWhatsAppConfigSyncRow | null) {
  return Boolean(
    normalizeWhatsAppProvider(config?.provider) ||
    normalizeOptionalText(config?.provider_config_json) ||
    normalizeOptionalText(config?.whatsapp_number) ||
    normalizeOptionalText(config?.instance_name) ||
    normalizeOptionalText(config?.channel_identifier)
  );
}

function pickDeliveryConfigWhatsAppTransportInput(source: Record<string, any>) {
  const picked: DeliveryConfigWhatsAppTransportInput = {};

  for (const key of DELIVERY_CONFIG_WHATSAPP_TRANSPORT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      picked[key] = source[key];
    }
  }

  return picked;
}

function removeDeliveryConfigWhatsAppTransportFields(source: Record<string, any>) {
  const next = { ...source };

  for (const key of DELIVERY_CONFIG_WHATSAPP_TRANSPORT_KEYS) {
    delete next[key];
  }

  return next;
}

function resolveEvolutionWhatsAppSyncFields(cfg: Record<string, any>, fallbackWhatsapp: unknown) {
  const evolutionUrl = normalizeOptionalText(cfg.evolution_url);
  const evolutionToken = normalizeOptionalText(cfg.evolution_token);
  const evolutionInstance = normalizeOptionalText(cfg.evolution_instance);
  const whatsappNumber =
    normalizeOptionalText(cfg.evolution_phone_number) ||
    normalizeOptionalText(cfg.whatsapp) ||
    normalizeOptionalText(fallbackWhatsapp);
  const channelIdentifier =
    normalizeOptionalText(cfg.evolution_channel_id) ||
    evolutionInstance;
  const providerHinted = Boolean(
    evolutionUrl ||
      evolutionToken ||
      evolutionInstance
  );
  const configured = Boolean(evolutionUrl && evolutionToken && evolutionInstance);
  const provider = providerHinted ? 'evolution_api' : null;
  const providerConfigJson = provider
    ? buildEvolutionProviderConfigJson({
        evolutionUrl,
        evolutionToken,
        evolutionInstance,
        whatsappNumber,
        channelIdentifier,
      })
    : null;

  return {
    evolutionUrl,
    evolutionToken,
    evolutionInstance,
    whatsappNumber,
    channelIdentifier,
    configured,
    provider,
    providerConfigJson,
  };
}

function buildTenantWhatsAppConfigState(
  tenantWhatsAppConfig: TenantWhatsAppConfigSyncRow,
  fallbackWhatsapp: unknown
) {
  const provider = normalizeWhatsAppProvider(tenantWhatsAppConfig.provider);
  const providerConfig = parseConfigJsonObject(tenantWhatsAppConfig.provider_config_json);
  const evolutionInstance =
    provider === 'evolution_api'
      ? normalizeOptionalText(tenantWhatsAppConfig.instance_name) ||
        getConfigValueText(providerConfig, ['instance', 'instance_name', 'instanceName'])
      : null;
  const whatsappNumber =
    normalizeOptionalText(tenantWhatsAppConfig.whatsapp_number) ||
    getConfigValueText(providerConfig, ['phone_number', 'display_number', 'whatsapp_number']) ||
    normalizeOptionalText(fallbackWhatsapp);
  const channelIdentifier =
    normalizeOptionalText(tenantWhatsAppConfig.channel_identifier) ||
    getConfigValueText(providerConfig, ['channel_id', 'channel_identifier']) ||
    evolutionInstance;

  return {
    provider,
    evolutionUrl:
      provider === 'evolution_api'
        ? getConfigValueText(providerConfig, ['base_url', 'baseUrl', 'url', 'api_url'])
        : null,
    evolutionToken:
      provider === 'evolution_api'
        ? getConfigValueText(providerConfig, ['apikey', 'api_key', 'apiKey', 'token'])
        : null,
    evolutionInstance,
    whatsappNumber,
    channelIdentifier,
    autoNotifyOrderAccepted: toFlag(tenantWhatsAppConfig.auto_notify_order_accepted),
    autoNotifyOrderPreparing: toFlag(tenantWhatsAppConfig.auto_notify_order_preparing),
    autoNotifyOrderOutForDelivery: toFlag(tenantWhatsAppConfig.auto_notify_order_out_for_delivery),
  };
}

function buildDeliveryConfigWhatsAppTransportResponse(
  deliveryConfig: Record<string, any>,
  tenantWhatsAppConfig: TenantWhatsAppConfigSyncRow | null,
  fallbackWhatsapp: unknown
) {
  const legacy = resolveEvolutionWhatsAppSyncFields(deliveryConfig, fallbackWhatsapp);
  const tenantState = tenantWhatsAppConfig
    ? buildTenantWhatsAppConfigState(tenantWhatsAppConfig, fallbackWhatsapp)
    : null;

  if (tenantState?.provider && tenantState.provider !== 'evolution_api') {
    return {};
  }

  const transportSource =
    tenantState?.provider === 'evolution_api'
      ? {
          evolution_url: tenantState.evolutionUrl || legacy.evolutionUrl,
          evolution_token: tenantState.evolutionToken || legacy.evolutionToken,
          evolution_instance: tenantState.evolutionInstance || legacy.evolutionInstance,
          evolution_phone_number: tenantState.whatsappNumber || legacy.whatsappNumber,
          evolution_channel_id: tenantState.channelIdentifier || legacy.channelIdentifier,
        }
      : {
          evolution_url: legacy.evolutionUrl,
          evolution_token: legacy.evolutionToken,
          evolution_instance: legacy.evolutionInstance,
          evolution_phone_number: legacy.whatsappNumber,
          evolution_channel_id: legacy.channelIdentifier,
        };

  const response: Record<string, string> = {};

  if (transportSource.evolution_url) response.evolution_url = transportSource.evolution_url;
  if (transportSource.evolution_token) response.evolution_token = transportSource.evolution_token;
  if (transportSource.evolution_instance) response.evolution_instance = transportSource.evolution_instance;
  if (transportSource.evolution_phone_number) response.evolution_phone_number = transportSource.evolution_phone_number;
  if (transportSource.evolution_channel_id) response.evolution_channel_id = transportSource.evolution_channel_id;

  return response;
}

async function upsertTenantWhatsAppConfigFromDeliveryTransport(
  tenantId: number,
  transportInput: DeliveryConfigWhatsAppTransportInput,
  current: TenantWhatsAppConfigSyncRow | null,
  fallbackWhatsapp: unknown
) {
  const hasTransportInput = hasDeliveryConfigWhatsAppTransportInput(transportInput);
  const currentProvider = normalizeWhatsAppProvider(current?.provider);

  if (!hasTransportInput && currentProvider !== 'evolution_api') {
    return;
  }

  const currentTransportSource =
    currentProvider === 'evolution_api'
      ? buildDeliveryConfigWhatsAppTransportResponse({}, current, fallbackWhatsapp)
      : {};
  const resolved = resolveEvolutionWhatsAppSyncFields(
    {
      ...currentTransportSource,
      ...transportInput,
    },
    fallbackWhatsapp
  );

  if (!current && !resolved.provider) {
    return;
  }

  await qRun(
    `INSERT INTO tenant_whatsapp_config (
        tenant_id,
        whatsapp_enabled,
        provider,
        provider_config_json,
        whatsapp_number,
        instance_name,
        channel_identifier,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
      ON CONFLICT (tenant_id) DO UPDATE SET
        whatsapp_enabled=EXCLUDED.whatsapp_enabled,
        provider=EXCLUDED.provider,
        provider_config_json=EXCLUDED.provider_config_json,
        whatsapp_number=EXCLUDED.whatsapp_number,
        instance_name=EXCLUDED.instance_name,
        channel_identifier=EXCLUDED.channel_identifier,
        updated_at=NOW()`,
    [
      tenantId,
      resolved.configured ? 1 : 0,
      resolved.provider,
      resolved.providerConfigJson,
      resolved.whatsappNumber,
      resolved.evolutionInstance,
      resolved.channelIdentifier,
    ]
  );
}

function pedidoVinculoCliente(aliasP = 'p', aliasC = 'c') {
  return `${aliasP}.tenant_id = ${aliasC}.tenant_id AND (${aliasP}.cliente_id = ${aliasC}.id OR ${aliasP}.delivery_cliente_id = ${aliasC}.id)`;
}

function classifyCustomerActivity(totalValidOrders: number, daysWithoutPurchase: number | null) {
  if (totalValidOrders <= 0 || daysWithoutPurchase === null) return 'sem_compra';
  if (daysWithoutPurchase <= ACTIVE_CUSTOMER_DAYS) return 'ativo';
  if (daysWithoutPurchase <= INACTIVE_CUSTOMER_DAYS) return 'em_risco';
  return 'inativo';
}

const DELIVERY_UPLOAD_URL_PREFIX = '/uploads/delivery/';
const DELIVERY_UPLOAD_DIR = path.join(UPLOADS_ROOT, 'delivery');

function bannerSlotsFromCfg(cfg: Record<string, any>): string[] {
  return [...normalizeCardapioOnlineBannerSlots(
    cfg.cardapio_online_banner_urls != null ? cfg.cardapio_online_banner_urls : cfg.cardapio_banner_slots
  )];
}

async function mergeDeliveryConfigJson(tenantId: number, patch: (c: Record<string, any>) => void) {
  const row = await q1<{ delivery_config: string | null }>('SELECT delivery_config FROM clientes WHERE id=?', [tenantId]);
  const cfg = coerceDeliveryConfigRow(row?.delivery_config ?? null);
  patch(cfg);
  applyNormalizedBannerSlots(cfg);
  await qRun('UPDATE clientes SET delivery_config=? WHERE id=?', [JSON.stringify(cfg), tenantId]);
  return cfg;
}

function deliveryUploadBasename(url: string): string {
  const u = String(url || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) {
    try {
      return path.basename(new URL(u).pathname) || '';
    } catch {
      return '';
    }
  }
  return path.basename(u.split('?')[0]) || '';
}

async function unlinkDeliveryUploadIfOwned(url: string, tenantId: number) {
  const u = String(url || '').trim();
  if (!u) return;
  if (/^https?:\/\//i.test(u) && /res\.cloudinary\.com\//i.test(u)) {
    await deleteStoredUpload(u);
    return;
  }
  const pathOk =
    u.startsWith(DELIVERY_UPLOAD_URL_PREFIX) ||
    (/^https?:\/\//i.test(u) &&
      (() => {
        try {
          return new URL(u).pathname.replace(/\/+/g, '/').includes('/uploads/delivery/');
        } catch {
          return false;
        }
      })());
  if (!pathOk) return;
  const base = deliveryUploadBasename(u);
  const match = /^delivery_(\d+)_/.exec(base);
  if (!match || Number(match[1]) !== Number(tenantId)) return;
  await deleteStoredUpload(u);
}

function removeOtherDeliveryLogoVariants(tenantId: number, keepFilename: string) {
  const dir = DELIVERY_UPLOAD_DIR;
  if (!fs.existsSync(dir)) return;
  const prefix = `delivery_${tenantId}_cardapio_logo`;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(prefix) && f !== keepFilename) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {}
    }
  }
}

function removeAllDeliveryCardapioLogoFiles(tenantId: number) {
  const dir = DELIVERY_UPLOAD_DIR;
  if (!fs.existsSync(dir)) return;
  const prefix = `delivery_${tenantId}_cardapio_logo`;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(prefix)) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {}
    }
  }
}

function removeOtherDeliveryBannerVariants(tenantId: number, index: number, keepFilename: string) {
  const dir = DELIVERY_UPLOAD_DIR;
  if (!fs.existsSync(dir)) return;
  const prefix = `delivery_${tenantId}_banner_${index}.`;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(prefix) && f !== keepFilename) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {}
    }
  }
}

function removeAllDeliveryBannerFilesForSlot(tenantId: number, index: number) {
  const dir = DELIVERY_UPLOAD_DIR;
  if (!fs.existsSync(dir)) return;
  const prefix = `delivery_${tenantId}_banner_${index}.`;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(prefix)) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {}
    }
  }
}

function removeOtherDeliveryReactivationMediaVariants(tenantId: number, keepFilename: string) {
  const dir = DELIVERY_UPLOAD_DIR;
  if (!fs.existsSync(dir)) return;
  const prefix = `delivery_${tenantId}_reativacao_cardapio`;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(prefix) && f !== keepFilename) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {}
    }
  }
}

function removeAllDeliveryReactivationMediaFiles(tenantId: number) {
  const dir = DELIVERY_UPLOAD_DIR;
  if (!fs.existsSync(dir)) return;
  const prefix = `delivery_${tenantId}_reativacao_cardapio`;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(prefix)) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {}
    }
  }
}

export function createDeliveryRouter() {
  const router = Router();

  router.use((req, res, next) => {
    if (req.method === 'GET' && req.path === '/motoboys') {
      return requireAnyPermission('delivery', 'orders')(req, res, next);
    }

    return requireAnyPermission('delivery')(req, res, next);
  });

  router.get('/config', async (req: Request, res) => {
    try {
      const row = await q1<{ delivery_ativo?: number | boolean | null; delivery_config?: string | null; whatsapp?: string | null }>(
        'SELECT delivery_ativo, delivery_config, whatsapp FROM clientes WHERE id=?',
        [req.tenantId]
      );
      const base = coerceDeliveryConfigRow(row?.delivery_config ?? null);
      const tenantWhatsAppConfig = await q1<TenantWhatsAppConfigSyncRow>(
        `SELECT whatsapp_enabled,
                provider,
                provider_config_json,
                whatsapp_number,
                instance_name,
                channel_identifier,
                auto_notify_order_accepted,
                auto_notify_order_preparing,
                auto_notify_order_out_for_delivery
           FROM tenant_whatsapp_config
          WHERE tenant_id=?`,
        [req.tenantId]
      );
      applyNormalizedBannerSlots(base);
      const deliveryBase = removeDeliveryConfigWhatsAppTransportFields(base);
      const transportConfig = buildDeliveryConfigWhatsAppTransportResponse(base, tenantWhatsAppConfig, row?.whatsapp);
      const resolvedProvider = normalizeWhatsAppProvider(tenantWhatsAppConfig?.provider);
      const tenantWhatsAppState = tenantWhatsAppConfig
        ? buildTenantWhatsAppConfigState(tenantWhatsAppConfig, row?.whatsapp)
        : null;
      const resolvedWhatsApp = resolveEvolutionWhatsAppSyncFields(
        {
          ...transportConfig,
          whatsapp: base.whatsapp,
        },
        row?.whatsapp
      );
      res.json({
        ativo: !!row?.delivery_ativo,
        ...deliveryBase,
        ...transportConfig,
        whatsapp_provider: resolvedProvider,
        whatsapp_enabled: toFlag(tenantWhatsAppConfig?.whatsapp_enabled),
        whatsapp_order_notifications_enabled: tenantWhatsAppState
          ? (tenantWhatsAppState.autoNotifyOrderAccepted ||
            tenantWhatsAppState.autoNotifyOrderPreparing ||
            tenantWhatsAppState.autoNotifyOrderOutForDelivery)
          : false,
        whatsapp_active_number: tenantWhatsAppState?.whatsappNumber || resolvedWhatsApp.whatsappNumber,
        whatsapp_inbound_webhook_path: buildTenantWhatsAppInboundWebhookPath(Number(req.tenantId)),
      });
    } catch (e: unknown) { sendInternalError(res, 'routes/delivery', e); }
  });

  router.put('/config', async (req: Request, res) => {
    try {
      const {
        ativo,
        whatsapp_provider: _whatsappProvider,
        whatsapp_enabled: _whatsappEnabled,
        whatsapp_order_notifications_enabled: whatsappOrderNotificationsEnabledRaw,
        whatsapp_active_number: _whatsappActiveNumber,
        whatsapp_inbound_webhook_path: _whatsappInboundWebhookPath,
        ...rest
      } = req.body;
      const whatsappOrderNotificationsEnabled =
        whatsappOrderNotificationsEnabledRaw === undefined
          ? undefined
          : toFlag(whatsappOrderNotificationsEnabledRaw);
      const [row, tenantWhatsAppConfig] = await Promise.all([
        q1<{ delivery_config: string | null; whatsapp?: string | null }>(
          'SELECT delivery_config, whatsapp FROM clientes WHERE id=?',
          [req.tenantId]
        ),
        q1<TenantWhatsAppConfigSyncRow>(
          `SELECT whatsapp_enabled,
                  provider,
                  provider_config_json,
                  whatsapp_number,
                  instance_name,
                  channel_identifier,
                  auto_notify_order_accepted,
                  auto_notify_order_preparing,
                  auto_notify_order_out_for_delivery
             FROM tenant_whatsapp_config
            WHERE tenant_id=?`,
          [req.tenantId]
        ),
      ]);
      const existing = coerceDeliveryConfigRow(row?.delivery_config ?? null);
      const restConfig =
        rest && typeof rest === 'object' && !Array.isArray(rest)
          ? { ...(rest as Record<string, any>) }
          : {};
      const transportInput = pickDeliveryConfigWhatsAppTransportInput(restConfig);
      const hasTransportInput = hasDeliveryConfigWhatsAppTransportInput(transportInput);
      const sanitizedRestConfig = removeDeliveryConfigWhatsAppTransportFields(restConfig);
      if (
        !Object.prototype.hasOwnProperty.call(sanitizedRestConfig, 'cardapio_online_banner_urls') &&
        Object.prototype.hasOwnProperty.call(sanitizedRestConfig, 'cardapio_banner_slots')
      ) {
        sanitizedRestConfig.cardapio_online_banner_urls = sanitizedRestConfig.cardapio_banner_slots;
      }
      let merged = mergeDeliveryConfigClientPut(existing, sanitizedRestConfig);
      if (hasTenantWhatsAppTransportState(tenantWhatsAppConfig) || hasTransportInput) {
        merged = removeDeliveryConfigWhatsAppTransportFields(merged);
      }
      const normalizedCardapioShortLink = normalizeOptionalText(merged.cardapio_link_curto);
      if (normalizedCardapioShortLink) merged.cardapio_link_curto = normalizedCardapioShortLink;
      else delete merged.cardapio_link_curto;
      if (forbidClientSuppliedLocalUploadImageUrls()) {
        if (isClientSuppliedLocalUploadImageUrl(merged.cardapio_online_logo_url)) {
          return res.status(400).json({
            success: false,
            message:
              'cardapio_online_logo_url não pode apontar para /uploads. Use o upload em Cardápio visual ou uma URL HTTPS externa.',
          });
        }
        const bannerSlots = bannerSlotsFromCfg(merged);
        for (let i = 0; i < bannerSlots.length; i++) {
          if (isClientSuppliedLocalUploadImageUrl(bannerSlots[i])) {
            return res.status(400).json({
              success: false,
              message: `Banner ${i}: não use caminho /uploads. Use o upload em Cardápio visual ou URL HTTPS externa.`,
            });
          }
        }
        if (isClientSuppliedLocalUploadImageUrl(merged.cardapio_reactivation_image_url)) {
          return res.status(400).json({
            success: false,
            message:
              'cardapio_reactivation_image_url não pode apontar para /uploads. Use o upload em Cardápio visual ou uma URL HTTPS externa.',
          });
        }
      }
      await qRun('UPDATE clientes SET delivery_ativo=?, delivery_config=? WHERE id=?', [ativo?1:0, JSON.stringify(merged), req.tenantId]);
      await upsertTenantWhatsAppConfigFromDeliveryTransport(
        Number(req.tenantId),
        transportInput,
        tenantWhatsAppConfig,
        row?.whatsapp
      );
      if (whatsappOrderNotificationsEnabled !== undefined) {
        await qRun(
          `INSERT INTO tenant_whatsapp_config (
              tenant_id,
              whatsapp_enabled,
              auto_notify_order_accepted,
              auto_notify_order_preparing,
              auto_notify_order_out_for_delivery,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, NOW())
            ON CONFLICT (tenant_id) DO UPDATE SET
              auto_notify_order_accepted=EXCLUDED.auto_notify_order_accepted,
              auto_notify_order_preparing=EXCLUDED.auto_notify_order_preparing,
              auto_notify_order_out_for_delivery=EXCLUDED.auto_notify_order_out_for_delivery,
              updated_at=NOW()`,
          [
            Number(req.tenantId),
            tenantWhatsAppConfig?.whatsapp_enabled ? 1 : 0,
            whatsappOrderNotificationsEnabled ? 1 : 0,
            whatsappOrderNotificationsEnabled ? 1 : 0,
            whatsappOrderNotificationsEnabled ? 1 : 0,
          ]
        );
      }
      res.json({ success: true });
    } catch (e: unknown) { sendInternalError(res, 'routes/delivery', e); }
  });

  router.post('/config/pix/test', async (req: Request, res) => {
    try {
      const row = await q1<{ delivery_config: string | null }>('SELECT delivery_config FROM clientes WHERE id=?', [req.tenantId]);
      const existing = coerceDeliveryConfigRow(row?.delivery_config ?? null);
      const patch =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, any>)
          : {};
      const merged = mergeDeliveryConfigClientPut(existing, patch);

      if (!merged.provider_enabled) {
        return res.json({
          success: true,
          mode: 'manual',
          status: 'manual',
          message: 'QR manual selecionado. O teste do provider automatico nao e necessario.',
        });
      }

      const provider = normalizePaymentProvider(merged.payment_provider);
      const accessToken = normalizeOptionalText(merged.access_token);
      const apiKey = normalizeOptionalText(merged.api_key);
      const pixKey = normalizeOptionalText(merged.pix_key);

      if (!provider) {
        return res.status(400).json({
          success: false,
          mode: 'automatic',
          status: 'invalid',
          message: 'Informe o provider do PIX automatico para validar a configuracao.',
        });
      }

      if (provider !== 'mercado_pago' && provider !== 'itau') {
        return res.status(400).json({
          success: false,
          mode: 'automatic',
          status: 'invalid',
          provider,
          message: 'Provider ainda nao suportado neste fluxo. Use mercado_pago ou itau.',
        });
      }

      if (provider === 'mercado_pago') {
        if (!accessToken) {
          return res.status(400).json({
            success: false,
            mode: 'automatic',
            status: 'invalid',
            provider,
            message: 'Access token ausente. Preencha o token do provider para continuar.',
          });
        }

        return res.json({
          success: true,
          mode: 'automatic',
          status: 'ready',
          provider,
          sandbox: Boolean(merged.provider_sandbox),
          message: 'Configuracao pronta para teste em pedido PIX. Salve e gere um pedido para validar o fluxo automatico.',
        });
      }

      // provider === 'itau'
      if (!apiKey || !accessToken || !pixKey) {
        return res.status(400).json({
          success: false,
          mode: 'automatic',
          status: 'invalid',
          provider,
          message:
            'Campos obrigatorios ausentes para Itaú: api_key (client_id), access_token (client_secret) e pix_key (chave Pix).',
        });
      }

      const sandbox = Boolean(merged.provider_sandbox);
      const certPem = normalizeOptionalText(merged.itau_tls_cert_pem);
      const keyPem = normalizeOptionalText(merged.itau_tls_key_pem);

      if (!sandbox && (!certPem || !keyPem)) {
        return res.status(400).json({
          success: false,
          mode: 'automatic',
          status: 'invalid',
          provider,
          message:
            'Produção Itaú exige mTLS: preencha itau_tls_cert_pem e itau_tls_key_pem (PEM ou caminho do arquivo).',
        });
      }

      // Teste seguro: valida autenticação (token) e, se possível, registra webhook.
      await testItauAuthentication({
        clientId: apiKey,
        clientSecret: accessToken,
        pixKey,
        sandbox,
        apiBaseUrl: normalizeOptionalText(merged.itau_api_base_url),
        tokenUrl: normalizeOptionalText(merged.itau_token_url),
        tls: {
          certPem,
          keyPem,
          caPem: normalizeOptionalText(merged.itau_tls_ca_pem),
        },
      });

      const publicBaseUrl = resolvePublicBackendBaseUrl();
      let webhookMessage: string | null = null;

      if (publicBaseUrl) {
        const webhookBaseUrl = `${publicBaseUrl}/api/webhooks/payments/itau`;
        const webhookResult = await ensureItauWebhookRegistered({
          config: {
            clientId: apiKey,
            clientSecret: accessToken,
            pixKey,
            sandbox,
            apiBaseUrl: normalizeOptionalText(merged.itau_api_base_url),
            tokenUrl: normalizeOptionalText(merged.itau_token_url),
            tls: {
              certPem,
              keyPem,
              caPem: normalizeOptionalText(merged.itau_tls_ca_pem),
            },
          },
          webhookBaseUrl,
        });
        webhookMessage = webhookResult.message;
      }

      return res.json({
        success: true,
        mode: 'automatic',
        status: 'ready',
        provider,
        sandbox,
        message: webhookMessage
          ? `Configuracao Itaú validada. ${webhookMessage}`
          : 'Configuracao Itaú validada (token OK). Defina FLOWPDV_PUBLIC_URL para registrar o webhook automaticamente.',
      });
    } catch (e: unknown) {
      sendInternalError(res, 'routes/delivery.pixTest', e);
    }
  });

  router.post(
    '/cardapio-visual/logo',
    uploadDeliveryCardapioLogo.single('logo'),
    hardenUploadedImageFile({ allowGif: false }),
    async (req: any, res) => {
      try {
        if (!req.file) return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado' });
        const tenantId = req.tenantId as number;
        const row = await q1<{ delivery_config: string | null }>('SELECT delivery_config FROM clientes WHERE id=?', [tenantId]);
        const prev = coerceDeliveryConfigRow(row?.delivery_config ?? null);
        const oldUrl = String(prev.cardapio_online_logo_url || '').trim();
        const newName = req.file.filename;
        const useCloud = isCloudinaryProductUploadEnabled();
        if (oldUrl && (useCloud || deliveryUploadBasename(oldUrl) !== newName)) {
          await unlinkDeliveryUploadIfOwned(oldUrl, tenantId);
        }
        if (!useCloud) {
          removeOtherDeliveryLogoVariants(tenantId, newName);
        }
        let publicUrl: string;
        try {
          publicUrl = await persistMulterImageFile({
            file: req.file,
            uploadToCloudinary: () =>
              uploadDeliveryCardapioLogoToCloudinary({ buffer: req.file.buffer as Buffer, tenantId }),
            localPublicPath: `${DELIVERY_UPLOAD_URL_PREFIX}${req.file.filename}`,
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : '';
          if (msg === 'EMPTY_IMAGE_BUFFER') {
            return res.status(400).json({ success: false, message: 'Arquivo vazio ou não recebido' });
          }
          throw e;
        }
        await mergeDeliveryConfigJson(tenantId, (c) => {
          c.cardapio_online_logo_url = publicUrl;
        });
        res.json({ success: true, url: publicUrl });
      } catch (e: any) {
        sendInternalError(res, 'routes/delivery', e);
      }
    }
  );

  router.delete('/cardapio-visual/logo', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as number;
      const row = await q1<{ delivery_config: string | null }>('SELECT delivery_config FROM clientes WHERE id=?', [tenantId]);
      const prev = coerceDeliveryConfigRow(row?.delivery_config ?? null);
      const oldUrl = String(prev.cardapio_online_logo_url || '').trim();
      if (oldUrl) await unlinkDeliveryUploadIfOwned(oldUrl, tenantId);
      removeAllDeliveryCardapioLogoFiles(tenantId);
      await mergeDeliveryConfigJson(tenantId, (c) => {
        delete c.cardapio_online_logo_url;
      });
      res.json({ success: true });
    } catch (e: any) {
      sendInternalError(res, 'routes/delivery', e);
    }
  });

  router.post(
    '/cardapio-visual/banner/:index',
    uploadDeliveryCardapioBanner.single('banner'),
    hardenUploadedImageFile({ allowGif: false }),
    async (req: any, res) => {
      try {
        const idx = parseInt(String(req.params.index), 10);
        if (!Number.isFinite(idx) || idx < 0 || idx > 3) {
          return res.status(400).json({ success: false, message: 'Use índice 0 a 3' });
        }
        if (!req.file) return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado' });
        const tenantId = req.tenantId as number;
        const row = await q1<{ delivery_config: string | null }>('SELECT delivery_config FROM clientes WHERE id=?', [tenantId]);
        const cfg = coerceDeliveryConfigRow(row?.delivery_config ?? null);
        const slots = bannerSlotsFromCfg(cfg);
        const oldUrl = slots[idx];
        const newName = req.file.filename;
        const useCloud = isCloudinaryProductUploadEnabled();
        if (oldUrl && (useCloud || deliveryUploadBasename(oldUrl) !== newName)) {
          await unlinkDeliveryUploadIfOwned(oldUrl, tenantId);
        }
        if (!useCloud) {
          removeOtherDeliveryBannerVariants(tenantId, idx, newName);
        }
        let publicUrl: string;
        try {
          publicUrl = await persistMulterImageFile({
            file: req.file,
            uploadToCloudinary: () =>
              uploadDeliveryBannerToCloudinary({
                buffer: req.file.buffer as Buffer,
                tenantId,
                bannerIndex: idx,
              }),
            localPublicPath: `${DELIVERY_UPLOAD_URL_PREFIX}${req.file.filename}`,
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : '';
          if (msg === 'EMPTY_IMAGE_BUFFER') {
            return res.status(400).json({ success: false, message: 'Arquivo vazio ou não recebido' });
          }
          throw e;
        }
        slots[idx] = publicUrl;
        await mergeDeliveryConfigJson(tenantId, (c) => {
          c.cardapio_online_banner_urls = slots;
        });
        res.json({ success: true, url: publicUrl, index: idx });
      } catch (e: any) {
        sendInternalError(res, 'routes/delivery', e);
      }
    }
  );

  router.delete('/cardapio-visual/banner/:index', async (req: any, res) => {
    try {
      const idx = parseInt(String(req.params.index), 10);
      if (!Number.isFinite(idx) || idx < 0 || idx > 3) {
        return res.status(400).json({ success: false, message: 'Índice inválido' });
      }
      const tenantId = req.tenantId as number;
      const row = await q1<{ delivery_config: string | null }>('SELECT delivery_config FROM clientes WHERE id=?', [tenantId]);
      const cfg = coerceDeliveryConfigRow(row?.delivery_config ?? null);
      const slots = bannerSlotsFromCfg(cfg);
      const oldUrl = slots[idx];
      if (oldUrl) await unlinkDeliveryUploadIfOwned(oldUrl, tenantId);
      removeAllDeliveryBannerFilesForSlot(tenantId, idx);
      slots[idx] = '';
      await mergeDeliveryConfigJson(tenantId, (c) => {
        c.cardapio_online_banner_urls = slots;
      });
      res.json({ success: true });
    } catch (e: any) {
      sendInternalError(res, 'routes/delivery', e);
    }
  });

  router.post(
    '/cardapio-visual/reativacao-imagem',
    uploadDeliveryCardapioReactivationMedia.single('imagem'),
    hardenUploadedImageFile({ allowGif: false }),
    async (req: any, res) => {
      try {
        if (!req.file) return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado' });
        const tenantId = req.tenantId as number;
        const row = await q1<{ delivery_config: string | null }>('SELECT delivery_config FROM clientes WHERE id=?', [tenantId]);
        const prev = coerceDeliveryConfigRow(row?.delivery_config ?? null);
        const oldUrl = String(prev.cardapio_reactivation_image_url || '').trim();
        const newName = req.file.filename;
        const useCloud = isCloudinaryProductUploadEnabled();
        if (oldUrl && (useCloud || deliveryUploadBasename(oldUrl) !== newName)) {
          await unlinkDeliveryUploadIfOwned(oldUrl, tenantId);
        }
        if (!useCloud) {
          removeOtherDeliveryReactivationMediaVariants(tenantId, newName);
        }

        let publicUrl: string;
        try {
          publicUrl = await persistMulterImageFile({
            file: req.file,
            uploadToCloudinary: () =>
              uploadDeliveryReactivationMediaToCloudinary({ buffer: req.file.buffer as Buffer, tenantId }),
            localPublicPath: `${DELIVERY_UPLOAD_URL_PREFIX}${req.file.filename}`,
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : '';
          if (msg === 'EMPTY_IMAGE_BUFFER') {
            return res.status(400).json({ success: false, message: 'Arquivo vazio ou não recebido' });
          }
          throw e;
        }

        await mergeDeliveryConfigJson(tenantId, (c) => {
          c.cardapio_reactivation_image_url = publicUrl;
        });
        res.json({ success: true, url: publicUrl });
      } catch (e: any) {
        sendInternalError(res, 'routes/delivery.reactivationImageUpload', e);
      }
    }
  );

  router.delete('/cardapio-visual/reativacao-imagem', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as number;
      const row = await q1<{ delivery_config: string | null }>('SELECT delivery_config FROM clientes WHERE id=?', [tenantId]);
      const prev = coerceDeliveryConfigRow(row?.delivery_config ?? null);
      const oldUrl = String(prev.cardapio_reactivation_image_url || '').trim();
      if (oldUrl) await unlinkDeliveryUploadIfOwned(oldUrl, tenantId);
      removeAllDeliveryReactivationMediaFiles(tenantId);
      await mergeDeliveryConfigJson(tenantId, (c) => {
        delete c.cardapio_reactivation_image_url;
      });
      res.json({ success: true });
    } catch (e: any) {
      sendInternalError(res, 'routes/delivery.reactivationImageDelete', e);
    }
  });

router.get('/pedidos', async (req: Request, res) => {
    try {
      const { status, limit = 100, date } = req.query;
      let q = `SELECT p.*, dc.nome as motoboy_nome,
        (SELECT STRING_AGG(pr.name || ' x' || ip.quantity::text, ', ')
         FROM itens_pedido ip JOIN produtos pr ON pr.id=ip.product_id AND pr.tenant_id=ip.tenant_id WHERE ip.order_id=p.id AND ip.tenant_id=p.tenant_id) as resumo_itens,
        (SELECT COALESCE(
          JSON_AGG(
            json_build_object(
              'product_id', ip.product_id,
              'product_name', pr.name,
              'quantity', ip.quantity,
              'price_at_time', ip.price_at_time,
              'observation', ip.observation,
              'obs_opcoes', ip.observation,
              'selecoes_json', ip.selecoes_json
            ) ORDER BY ip.id ASC
          ),
          '[]'::json
        )
        FROM itens_pedido ip
        INNER JOIN produtos pr ON pr.id=ip.product_id AND pr.tenant_id=ip.tenant_id
        WHERE ip.order_id=p.id AND ip.tenant_id=p.tenant_id) as itens,
        EXISTS (
          SELECT 1 FROM pedido_eventos pe
          WHERE pe.pedido_id = p.id AND pe.tenant_id = p.tenant_id
            AND pe.tipo = 'AUTOMATION_DELIVERY_ACEITE_AUTO'
        ) AS automation_auto_delivery_accept,
        EXISTS (
          SELECT 1 FROM pedido_eventos pe
          WHERE pe.pedido_id = p.id AND pe.tenant_id = p.tenant_id
            AND pe.tipo = 'AUTOMATION_COZINHA_FALHA'
        ) AS automation_kitchen_failed,
        EXISTS (
          SELECT 1 FROM pedido_eventos pe
          WHERE pe.pedido_id = p.id AND pe.tenant_id = p.tenant_id
            AND pe.tipo = 'AUTOMATION_COZINHA_OK'
        ) AS automation_kitchen_ok
        FROM pedidos p LEFT JOIN delivery_motoboys dc ON dc.id=p.motoboy_id AND dc.tenant_id=p.tenant_id
        WHERE p.tenant_id=? AND p.canal='delivery'`;
      const params: any[] = [req.tenantId];

      // Filtro de data: por padrão mostra apenas pedidos do dia atual (fuso BR),
      // igual ao comportamento da tela de Operações. Passa ?date=YYYY-MM-DD para
      // consultar um dia específico (ex.: histórico de ontem).
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
        q += ` AND (p.created_at AT TIME ZONE '${TZ}')::date = ?`;
        params.push(String(date));
      } else {
        q += ` AND (p.created_at AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date`;
      }

      if (status) {
        const statusList = String(status).split(',');
        const mapped: string[] = [];
        
        // Mapeia os status que a tela pede para os status reais do Banco de Dados
        for (const s of statusList) {
          const tr = s.trim();
          mapped.push(tr);
          if (tr === 'Recebido') mapped.push('Criado', 'Pedido Recebido');
          if (tr === 'Pronto') mapped.push('Pronto para Entrega');
          if (tr === 'Em Rota') mapped.push('Saiu para Entrega');
        }
        
        const uniqueStatus = [...new Set(mapped)];
        const placeholders = uniqueStatus.map(() => '?').join(',');
        q += ` AND p.status IN (${placeholders})`;
        params.push(...uniqueStatus);
      }
      q += ' ORDER BY p.created_at DESC LIMIT ?'; params.push(Number(limit));

      const rows = await qAll(q, params);

      await Promise.allSettled(
        rows
          .filter(
            (row: any) =>
              String(row.pagamento_tipo || '').trim().toLowerCase() === 'pix' &&
              String(row.pagamento_status || '').trim().toLowerCase() !== 'pago'
          )
          .map(async (row: any) => {
            try {
              const result = await revalidatePixPaymentByOrder({
                orderId: Number(row.id),
                tenantId: Number(req.tenantId),
              });

              if (
                String(result.externalStatus || '').trim().toLowerCase() === 'approved' ||
                String(result.externalStatus || '').trim().toLowerCase() === 'paid' ||
                result.orderUpdated
              ) {
                row.pagamento_status = 'pago';
              }
            } catch (error) {
              if (isAppError(error) && error.statusCode === 404) return;
              logError('routes/delivery.getPedidos.revalidatePix', error, {
                orderId: row.id,
                tenantId: req.tenantId,
              });
            }
          })
      );

      res.json(
        rows.map((p: any) => {
          let itens = p.itens;
          if (typeof itens === 'string') {
            try {
              itens = JSON.parse(itens || '[]');
            } catch {
              itens = [];
            }
          }
          if (!Array.isArray(itens)) itens = [];
          const itensPublic = itens.map((it: Record<string, unknown>) =>
            buildPublicOrderItemFromPersisted({
              order_id: Number(p.id),
              product_id: Number(it.product_id),
              quantity: Number(it.quantity),
              type: 'Delivery',
              price_at_time: Number(it.price_at_time || 0),
              variation_id: it.variation_id != null ? Number(it.variation_id) : null,
              observation: (it.observation as string | null) ?? null,
              selecoes_json: (it.selecoes_json as string | null) ?? null,
              product_name: (it.product_name as string | null) ?? null,
              product_category: null,
              production_type: null,
              requires_preparation: null,
            })
          );
          return {
            ...p,
            itens: itensPublic,
            total_amount: Number(p.total_amount || 0),
            taxa_entrega: Number(p.taxa_entrega || 0),
            automation_auto_delivery_accept: Boolean(p.automation_auto_delivery_accept),
            automation_kitchen_failed: Boolean(p.automation_kitchen_failed),
            automation_kitchen_ok: Boolean(p.automation_kitchen_ok),
          };
        })
      );
    } catch (e: unknown) { sendInternalError(res, 'routes/delivery', e); }
  });

  router.patch('/pedidos/:id/status', async (req: Request, res) => {
    try {
      const order = await q1('SELECT status, cancelado_at, canal FROM pedidos WHERE id=? AND tenant_id=?', [req.params.id, req.tenantId]);
      if (!order) return res.status(404).json({ error: 'Pedido nao encontrado' });
      if (isCanceledOrder(order)) return res.status(400).json({ error: 'Pedido cancelado nao pode voltar ao fluxo operacional' });
      if (String(order.canal || '').trim().toLowerCase() !== 'delivery') {
        return res.status(400).json({ error: 'Este fluxo aceita apenas pedidos de delivery' });
      }

      const previousStatus = String(order.status || '').trim();
      const { status, motoboy_id } = req.body;
      const nextStatus = String(status || '').trim();
      const requiresMotoboy = await tenantHasFeature(req.tenantId, 'funcionarios');
      const clienteRow = await q1<{ delivery_config?: string | null }>(
        'SELECT delivery_config FROM clientes WHERE id=?',
        [req.tenantId]
      );
      const motoboySobDemanda = !!coerceDeliveryConfigRow(clienteRow?.delivery_config ?? null).motoboy_sob_demanda;
      const normalizedMotoboyId = motoboy_id == null || motoboy_id === ''
        ? null
        : Number(motoboy_id);

      if (!nextStatus) {
        return res.status(400).json({ error: 'Status obrigatorio' });
      }

      if (!DELIVERY_FLOW_STATUSES.has(nextStatus)) {
        return res.status(400).json({ error: 'Status de delivery invalido' });
      }

      const expectedNextStatus = getDeliveryNextStatus(previousStatus);
      if (nextStatus !== previousStatus && expectedNextStatus !== nextStatus) {
        return res.status(400).json({
          error: expectedNextStatus
            ? `Transicao invalida. Proximo status esperado: ${expectedNextStatus}`
            : 'Pedido ja esta encerrado no fluxo de delivery',
        });
      }

      if (
        requiresMotoboy &&
        !motoboySobDemanda &&
        nextStatus === 'Saiu para Entrega' &&
        (!Number.isInteger(normalizedMotoboyId) || normalizedMotoboyId <= 0)
      ) {
        return res.status(400).json({ error: 'Motoboy é obrigatório para enviar o pedido para entrega' });
      }

      const updates: string[] = ['status=?'];
      const params: any[] = [nextStatus];
      if (Number.isInteger(normalizedMotoboyId) && normalizedMotoboyId > 0) {
        updates.push('motoboy_id=?');
        params.push(normalizedMotoboyId);
      }
      if (nextStatus === 'Saiu para Entrega') { updates.push('saiu_entrega_at=NOW()'); }
      if (nextStatus === 'Entregue')          { updates.push('entregue_at=NOW()'); }
      params.push(req.params.id, req.tenantId);
      await qRun(`UPDATE pedidos SET ${updates.join(',')} WHERE id=? AND tenant_id=?`, params);
      if (previousStatus !== nextStatus) {
        await insertDeliveryOrderEvent({
          pedidoId: Number(req.params.id),
          tenantId: Number(req.tenantId),
          tipo: 'STATUS',
          statusAnterior: previousStatus,
          statusNovo: nextStatus,
          payload: {
            origem: 'routes.delivery.patchStatus',
            motoboy_id:
              Number.isInteger(normalizedMotoboyId) && normalizedMotoboyId > 0
                ? normalizedMotoboyId
                : null,
          },
          usuarioId: (req as Request & { user?: { id?: number } }).user?.id,
        });
        await emitWhatsAppOrderStatusEvent({
          tenantId: req.tenantId,
          orderId: req.params.id,
          status: nextStatus,
          source: 'routes.delivery.patchStatus',
        });
      }
      notifyTenantOrderStreams(Number(req.tenantId), 'status', { orderId: Number(req.params.id) });

      let kitchenPrintAutomation: { ok: boolean; message?: string; reason?: string } | undefined;
      if (previousStatus === 'Criado' && nextStatus === 'Pedido Recebido') {
        const cfgRow = await q1<{ delivery_config: string | null }>('SELECT delivery_config FROM clientes WHERE id=?', [req.tenantId]);
        const parsed = coerceDeliveryConfigRow(cfgRow?.delivery_config ?? null);
        const automation = parseAutomationFromDeliveryConfigJson(parsed);
        if (automation.delivery_auto_print_production) {
          const pr = await runAutomatedKitchenPrintForOrder(Number(req.tenantId), Number(req.params.id), {
            trigger: 'delivery_manual_accept',
          });
          if (pr.ok) {
            kitchenPrintAutomation = { ok: true };
          } else if (isKitchenDispatchFailure(pr)) {
            kitchenPrintAutomation = { ok: false, message: pr.message || pr.reason, reason: pr.reason };
          }
        }
      }

      res.json({ success: true, automation: kitchenPrintAutomation ? { kitchen_print: kitchenPrintAutomation } : undefined });
    } catch (e: unknown) { sendInternalError(res, 'routes/delivery', e); }
  });

  router.patch('/pedidos/:id/pagamento', async (req: Request, res) => {
    try {
      const order = await q1('SELECT status, cancelado_at FROM pedidos WHERE id=? AND tenant_id=?', [req.params.id, req.tenantId]);
      if (!order) return res.status(404).json({ error: 'Pedido nao encontrado' });
      if (isCanceledOrder(order)) return res.status(400).json({ error: 'Pedido cancelado nao pode ter pagamento alterado aqui' });

      const ps = String(req.body?.pagamento_status || '').trim().toLowerCase();
      if (ps === 'pago') {
        const userId = (req as Request & { user?: { id?: number } }).user?.id;
        await confirmOrderPayment({ orderId: req.params.id, tenantId: req.tenantId, userId });
        return res.json({ success: true });
      }

      await qRun('UPDATE pedidos SET pagamento_status=? WHERE id=? AND tenant_id=?', [req.body.pagamento_status, req.params.id, req.tenantId]);
      notifyTenantOrderStreams(Number(req.tenantId), 'status', { orderId: Number(req.params.id) });
      res.json({ success: true });
    } catch (e: unknown) {
      if (isAppError(e)) return res.status(e.statusCode).json({ error: e.message });
      sendInternalError(res, 'routes/delivery', e);
    }
  });

  router.get('/motoboys', async (req: Request, res) => {
    try {
      const funcMotoboys = await qAll("SELECT id,nome,telefone FROM funcionarios WHERE tenant_id=? AND status='ativo' AND LOWER(cargo) LIKE '%motoboy%'", [req.tenantId]);
      if (funcMotoboys.length > 0) {
        for (const f of funcMotoboys) {
          await qRun(
            `INSERT INTO delivery_motoboys (tenant_id, nome, telefone, ativo) VALUES (?,?,?,1) ON CONFLICT(tenant_id, nome) DO UPDATE SET ativo=1, telefone=EXCLUDED.telefone`,
            [req.tenantId, f.nome, f.telefone||null]
          );
        }
      }
      res.json(await qAll('SELECT * FROM delivery_motoboys WHERE tenant_id=? AND ativo=1 ORDER BY nome', [req.tenantId]));
    } catch (e: unknown) { sendInternalError(res, 'routes/delivery', e); }
  });

  router.get('/motoboys/relatorio', async (req: Request, res) => {
    try {
      const { month, year, inicio, fim } = req.query;
      let dataInicio: string, dataFim: string;
      if (month && year) {
        const m = String(month).padStart(2, '0'), y = String(year);
        const lastDay = new Date(Number(year), Number(month), 0).getDate();
        dataInicio = `${y}-${m}-01`; dataFim = `${y}-${m}-${String(lastDay).padStart(2,'0')}`;
      } else {
        dataInicio = String(inicio || '1900-01-01'); dataFim = String(fim || '2100-12-31');
      }
      const cfgRow = await q1('SELECT delivery_config FROM clientes WHERE id=?', [req.tenantId]);
      const cfg = coerceDeliveryConfigRow(cfgRow?.delivery_config ?? null);
      const valorPorEntrega = Number(cfg.valor_por_entrega) || 0;
      const rows = await qAll(
        `SELECT m.id, m.nome, COUNT(p.id) as total_entregas,
          COALESCE(AVG(CASE WHEN p.saiu_entrega_at IS NOT NULL AND p.entregue_at IS NOT NULL
            THEN EXTRACT(EPOCH FROM (p.entregue_at - p.saiu_entrega_at))/60 END),0) as tempo_medio_min
         FROM delivery_motoboys m
         LEFT JOIN pedidos p ON p.motoboy_id=m.id AND p.tenant_id=m.tenant_id
           AND p.status='Entregue' AND (p.entregue_at AT TIME ZONE '${TZ}')::date BETWEEN ? AND ?
         WHERE m.tenant_id=? GROUP BY m.id ORDER BY total_entregas DESC`,
        [dataInicio, dataFim, req.tenantId]
      );
      res.json(rows.map((r: any) => ({ ...r, valor_por_entrega: valorPorEntrega, total_a_pagar: r.total_entregas * valorPorEntrega })));
    } catch (e: unknown) { sendInternalError(res, 'routes/delivery', e); }
  });

router.get('/dashboard', async (req: Request, res) => {
    try {
      // Usamos a data do banco (Postgres) para evitar diferença de fuso horário com o Node.js
      const notCanceledOrderClause = buildValidOrderSqlClause();
      const [pedidosHoje, emPreparo, emRota, ticketMedio, topMotoboy] = await Promise.all([
        q1(`SELECT COUNT(*) as n, COALESCE(SUM(total_amount),0) as fat FROM pedidos WHERE tenant_id=? AND canal='delivery' AND ${notCanceledOrderClause} AND (created_at AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date`, [req.tenantId]),
        q1(`SELECT COUNT(*) as n FROM pedidos WHERE tenant_id=? AND canal='delivery' AND ${notCanceledOrderClause} AND status IN ('Criado','Pedido Recebido','Em Preparo')`, [req.tenantId]),
        q1(`SELECT COUNT(*) as n FROM pedidos WHERE tenant_id=? AND canal='delivery' AND ${notCanceledOrderClause} AND status='Saiu para Entrega'`, [req.tenantId]),
        q1(`SELECT COALESCE(AVG(total_amount),0) as v FROM pedidos WHERE tenant_id=? AND canal='delivery' AND ${notCanceledOrderClause} AND (created_at AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date`, [req.tenantId]),
        q1(`SELECT m.nome, COUNT(p.id) as entregas FROM delivery_motoboys m JOIN pedidos p ON p.motoboy_id=m.id AND p.tenant_id=m.tenant_id WHERE m.tenant_id=? AND p.cancelado_at IS NULL AND LOWER(COALESCE(p.status,'')) <> 'cancelado' AND (p.entregue_at AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date GROUP BY m.id ORDER BY entregas DESC LIMIT 1`, [req.tenantId]),
      ]);

      // Conversão obrigatória para Number porque o Postgres retorna SUM/COUNT como String
      res.json({
        pedidos_hoje: Number(pedidosHoje?.n || 0),
        faturamento_hoje: Number(pedidosHoje?.fat || 0),
        em_preparo: Number(emPreparo?.n || 0),
        em_rota: Number(emRota?.n || 0),
        ticket_medio: Number(ticketMedio?.v || 0),
        top_motoboy: topMotoboy || null
      });
    } catch (e: unknown) { sendInternalError(res, 'routes/delivery', e); }
  });

router.get('/clientes', async (req: Request, res) => {
    try {
      const { search } = req.query;
      const notCanceledOrderClauseSummary = buildValidOrderSqlClause('p');
      let summaryQuery = `
        SELECT c.*,
          metrics.total_pedidos,
          metrics.total_pedidos_validos,
          metrics.total_gasto,
          COALESCE(c.primeira_compra_at, metrics.primeira_compra_at) as primeira_compra_at_calc,
          COALESCE(c.ultima_compra_at, metrics.ultima_compra_at) as ultima_compra_at_calc,
          CASE
            WHEN COALESCE(c.ultima_compra_at, metrics.ultima_compra_at) IS NULL THEN NULL
            ELSE FLOOR(
              EXTRACT(
                EPOCH FROM (
                  (NOW() AT TIME ZONE '${TZ}')
                  - (COALESCE(c.ultima_compra_at, metrics.ultima_compra_at) AT TIME ZONE '${TZ}')
                )
              ) / 86400
            )::int
          END as dias_sem_comprar
        FROM delivery_clientes c
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) as total_pedidos,
            COUNT(*) FILTER (WHERE ${notCanceledOrderClauseSummary}) as total_pedidos_validos,
            COALESCE(SUM(CASE WHEN ${notCanceledOrderClauseSummary} THEN total_amount ELSE 0 END), 0) as total_gasto,
            MIN(created_at) FILTER (WHERE ${notCanceledOrderClauseSummary}) as primeira_compra_at,
            MAX(created_at) FILTER (WHERE ${notCanceledOrderClauseSummary}) as ultima_compra_at
          FROM pedidos p
          WHERE ${pedidoVinculoCliente('p', 'c')}
        ) metrics ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*) > 0 AS tem_pix_pendente
          FROM pedidos p
          WHERE ${pedidoVinculoCliente('p', 'c')}
            AND p.pagamento_tipo = 'pix'
            AND COALESCE(p.pagamento_status, '') <> 'pago'
            AND COALESCE(p.status, '') <> 'Cancelado'
        ) pix_check ON TRUE
        WHERE c.tenant_id=?
      `;
      const summaryParams: any[] = [req.tenantId];
      if (search) {
        summaryQuery += ' AND (c.nome ILIKE ? OR c.telefone ILIKE ? OR COALESCE(c.email, \'\') ILIKE ? OR COALESCE(c.observacoes, \'\') ILIKE ?)';
        const term = `%${search}%`;
        summaryParams.push(term, term, term, term);
      }
      summaryQuery += ' ORDER BY COALESCE(c.ultima_compra_at, metrics.ultima_compra_at) DESC NULLS LAST, c.nome ASC LIMIT 200';
      const summaryRows = await qAll(summaryQuery, summaryParams);
      return res.json(summaryRows.map((row: any) => {
        const totalPedidos = Number(row.total_pedidos || 0);
        const totalPedidosValidos = Number(row.total_pedidos_validos || 0);
        const diasSemComprar = row.dias_sem_comprar === null || row.dias_sem_comprar === undefined
          ? null
          : Number(row.dias_sem_comprar);
        const ultimaCompraAt = row.ultima_compra_at_calc || null;

        const fidelizacao = getCustomerLoyaltyTier(totalPedidosValidos);
        return {
          ...row,
          total_pedidos: totalPedidos,
          total_pedidos_validos: totalPedidosValidos,
          total_gasto: Number(row.total_gasto || 0),
          primeira_compra_at: row.primeira_compra_at_calc || null,
          ultima_compra_at: ultimaCompraAt,
          ultimo_pedido: ultimaCompraAt,
          dias_sem_comprar: diasSemComprar,
          cliente_recorrente: totalPedidosValidos >= 3,
          fidelizacao,
          status_atividade: classifyCustomerActivity(totalPedidosValidos, diasSemComprar),
          sem_historico: totalPedidos <= 0,
          tem_pix_pendente: Boolean(row.tem_pix_pendente),
        };
      }));
    } catch (e: unknown) { sendInternalError(res, 'routes/delivery', e); }
  });

  router.get('/clientes/resumo', async (req: Request, res) => {
    try {
      const { search } = req.query;
      const notCanceledOrderClause = buildValidOrderSqlClause('p');
      let q = `
        SELECT c.*,
          metrics.total_pedidos,
          metrics.total_pedidos_validos,
          metrics.total_gasto,
          COALESCE(c.primeira_compra_at, metrics.primeira_compra_at) as primeira_compra_at_calc,
          COALESCE(c.ultima_compra_at, metrics.ultima_compra_at) as ultima_compra_at_calc,
          CASE
            WHEN COALESCE(c.ultima_compra_at, metrics.ultima_compra_at) IS NULL THEN NULL
            ELSE FLOOR(
              EXTRACT(
                EPOCH FROM (
                  (NOW() AT TIME ZONE '${TZ}')
                  - (COALESCE(c.ultima_compra_at, metrics.ultima_compra_at) AT TIME ZONE '${TZ}')
                )
              ) / 86400
            )::int
          END as dias_sem_comprar
        FROM delivery_clientes c
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) as total_pedidos,
            COUNT(*) FILTER (WHERE ${notCanceledOrderClause}) as total_pedidos_validos,
            COALESCE(SUM(CASE WHEN ${notCanceledOrderClause} THEN total_amount ELSE 0 END), 0) as total_gasto,
            MIN(created_at) FILTER (WHERE ${notCanceledOrderClause}) as primeira_compra_at,
            MAX(created_at) FILTER (WHERE ${notCanceledOrderClause}) as ultima_compra_at
          FROM pedidos p
          WHERE ${pedidoVinculoCliente('p', 'c')}
        ) metrics ON TRUE
        WHERE c.tenant_id=?
      `;
      const params: any[] = [req.tenantId];
      if (search) {
        q += ' AND (c.nome ILIKE ? OR c.telefone ILIKE ? OR COALESCE(c.email, \'\') ILIKE ? OR COALESCE(c.observacoes, \'\') ILIKE ?)';
        const t = `%${search}%`;
        params.push(t, t, t, t);
      }
      q += ' ORDER BY COALESCE(c.ultima_compra_at, metrics.ultima_compra_at) DESC NULLS LAST, c.nome ASC LIMIT 200';
      const rows = await qAll(q, params);

      res.json(rows.map((r: any) => {
        const totalPedidos = Number(r.total_pedidos || 0);
        const totalPedidosValidos = Number(r.total_pedidos_validos || 0);
        const diasSemComprar = r.dias_sem_comprar === null || r.dias_sem_comprar === undefined
          ? null
          : Number(r.dias_sem_comprar);
        const ultimaCompraAt = r.ultima_compra_at_calc || null;

        const fidelizacao = getCustomerLoyaltyTier(totalPedidosValidos);
        return {
          ...r,
          total_pedidos: totalPedidos,
          total_pedidos_validos: totalPedidosValidos,
          total_gasto: Number(r.total_gasto || 0),
          primeira_compra_at: r.primeira_compra_at_calc || null,
          ultima_compra_at: ultimaCompraAt,
          ultimo_pedido: ultimaCompraAt,
          dias_sem_comprar: diasSemComprar,
          cliente_recorrente: totalPedidosValidos >= 3,
          fidelizacao,
          status_atividade: classifyCustomerActivity(totalPedidosValidos, diasSemComprar),
          sem_historico: totalPedidos <= 0,
        };
      }));
    } catch (e: unknown) { sendInternalError(res, 'routes/delivery', e); }
  });

  router.patch('/clientes/:id/resumo', async (req: Request, res) => {
    try {
      const current = await q1(
        'SELECT id, nome, email, origem_cadastro, observacoes FROM delivery_clientes WHERE id=? AND tenant_id=?',
        [req.params.id, req.tenantId]
      );
      if (!current) return res.status(404).json({ error: 'Cliente nao encontrado' });

      const nome = typeof req.body.nome === 'string' && req.body.nome.trim()
        ? req.body.nome.trim()
        : current.nome;
      const email = req.body.email === undefined
        ? current.email
        : (String(req.body.email || '').trim() || null);
      const origemCadastroInput = req.body.origem_cadastro === undefined
        ? current.origem_cadastro
        : String(req.body.origem_cadastro || '').trim();
      const origemCadastro = origemCadastroInput || current.origem_cadastro || 'delivery_online';
      const observacoes = req.body.observacoes === undefined
        ? current.observacoes
        : (String(req.body.observacoes || '').trim() || null);

      await qRun(
        `UPDATE delivery_clientes
         SET nome=?, email=?, origem_cadastro=?, observacoes=?, updated_at=NOW()
         WHERE id=? AND tenant_id=?`,
        [nome, email, origemCadastro, observacoes, req.params.id, req.tenantId]
      );

      res.json({ success: true });
    } catch (e: unknown) { sendInternalError(res, 'routes/delivery', e); }
  });

  router.post('/clientes/reativacao/whatsapp', async (req: Request, res) => {
    try {
      const customerIdsRaw = Array.isArray(req.body?.customer_ids) ? req.body.customer_ids : [];
      const customerIds: number[] = [...new Set<number>(
        customerIdsRaw
          .map((id: unknown) => Number(id))
          .filter((id): id is number => Number.isInteger(id) && id > 0)
      )].slice(0, 100);
      const sendWithMenuImage = toFlag(req.body?.send_with_menu_image);
      const operatorId = (req as Request & { user?: { id?: number } }).user?.id || null;

      if (customerIds.length === 0) {
        return res.status(400).json({ success: false, error: 'Selecione pelo menos um cliente valido' });
      }

      const whatsappConfig = await q1<{
        whatsapp_enabled?: boolean | number | string | null;
        provider?: string | null;
        provider_config_json?: string | null;
      }>(
        `SELECT whatsapp_enabled, provider, provider_config_json
           FROM tenant_whatsapp_config
          WHERE tenant_id=?`,
        [req.tenantId]
      );

      const enabled = toFlag(whatsappConfig?.whatsapp_enabled);
      if (!whatsappConfig || !enabled) {
        return res.status(409).json({
          success: false,
          error: 'WhatsApp nao esta configurado ou habilitado para este tenant',
        });
      }

      const tenantDeliveryCfgRow = await q1<{ delivery_config: string | null }>(
        'SELECT delivery_config FROM clientes WHERE id=?',
        [req.tenantId]
      );
      const tenantDeliveryCfg = coerceDeliveryConfigRow(tenantDeliveryCfgRow?.delivery_config ?? null);
      const cardapioLink = normalizeOptionalText(tenantDeliveryCfg.cardapio_link_curto) || null;
      const cardapioReactivationImageUrl =
        normalizeOptionalText(tenantDeliveryCfg.cardapio_reactivation_image_url) || null;

      const placeholders = customerIds.map(() => '?').join(',');
      const customers = await qAll<{
        id: number;
        nome: string | null;
        telefone: string | null;
        whatsapp_reativacao_last_sent_at?: string | null;
        whatsapp_reativacao_last_status?: string | null;
      }>(
        `SELECT id, nome, telefone, whatsapp_reativacao_last_sent_at, whatsapp_reativacao_last_status
           FROM delivery_clientes
          WHERE tenant_id=?
            AND id IN (${placeholders})
          ORDER BY nome ASC, id ASC`,
        [req.tenantId, ...customerIds]
      );

      const foundIds = new Set(customers.map((customer) => Number(customer.id)));
      const results: Array<{
        customer_id: number;
        nome: string;
        telefone: string | null;
        status: 'sent' | 'failed' | 'ignored_no_phone' | 'ignored_invalid_phone' | 'ignored_not_found';
        error?: string | null;
      }> = [];

      for (const originalId of customerIds) {
        if (!foundIds.has(originalId)) {
          results.push({
            customer_id: originalId,
            nome: '',
            telefone: null,
            status: 'ignored_not_found',
            error: 'Cliente nao encontrado no tenant',
          });
        }
      }

      for (const customer of customers) {
        const customerId = Number(customer.id);
        const customerName = normalizeOptionalText(customer.nome) || 'cliente';
        const customerPhone = normalizeOptionalText(customer.telefone);

        if (!customerPhone) {
          results.push({
            customer_id: customerId,
            nome: customerName,
            telefone: null,
            status: 'ignored_no_phone',
            error: 'Cliente sem telefone cadastrado',
          });
          continue;
        }

        if (!isLikelyValidCustomerPhone(customerPhone)) {
          results.push({
            customer_id: customerId,
            nome: customerName,
            telefone: customerPhone,
            status: 'ignored_invalid_phone',
            error: 'Telefone invalido para envio',
          });
          continue;
        }

        const message =
          `Oi, ${customerName}! 😊 Sentimos sua falta por aqui.\n` +
          `Estamos abertos hoje e sera um prazer receber seu pedido novamente 🍽️\n` +
          (cardapioLink
            ? `Peca pelo cardapio oficial: ${cardapioLink}`
            : 'Se preferir, responda esta mensagem e ajudamos no seu pedido.');

        try {
          const sendResult = await sendWhatsAppMessage({
            provider: whatsappConfig.provider || null,
            providerConfigJson: whatsappConfig.provider_config_json || null,
            to: customerPhone,
            message,
          });
          let mediaSendError: string | null = null;
          let mediaSent = false;
          if (sendWithMenuImage && cardapioReactivationImageUrl) {
            try {
              await sendWhatsAppMediaMessage({
                provider: whatsappConfig.provider || null,
                providerConfigJson: whatsappConfig.provider_config_json || null,
                to: customerPhone,
                mediaUrl: cardapioReactivationImageUrl,
                caption: 'Cardapio da loja',
              });
              mediaSent = true;
            } catch (mediaError) {
              mediaSendError = mediaError instanceof Error ? mediaError.message : String(mediaError);
            }
          }

          await qRun(
            `INSERT INTO whatsapp_inbound_messages
              (
                tenant_id,
                provider,
                provider_message_id,
                customer_phone,
                customer_name,
                message_text,
                payload_json,
                intent,
                auto_reply_text,
                auto_reply_status,
                auto_reply_error,
                auto_reply_provider,
                auto_reply_external_id,
                auto_reply_attempted_at,
                auto_reply_sent_at,
                created_at,
                received_at
              )
             VALUES (?, ?, NULL, ?, ?, ?, ?, 'reativacao_manual', ?, ?, ?, ?, ?, NOW(), NOW(), NOW(), NOW())`,
            [
              req.tenantId,
              sendResult.provider || null,
              sendResult.recipient,
              customerName,
              message,
              JSON.stringify({
                source: 'delivery_customers_reactivation',
                customer_id: customerId,
                send_with_menu_image: sendWithMenuImage,
                menu_image_url: sendWithMenuImage ? cardapioReactivationImageUrl : null,
                menu_image_sent: mediaSent,
                menu_image_error: mediaSendError,
              }),
              message,
              'sent',
              null,
              sendResult.provider || null,
              sendResult.externalId || null,
            ]
          );
          await qRun(
            `UPDATE delivery_clientes
                SET whatsapp_reativacao_last_sent_at = NOW(),
                    whatsapp_reativacao_last_status = 'sent',
                    whatsapp_reativacao_last_operator_id = ?,
                    updated_at = NOW()
              WHERE tenant_id=? AND id=?`,
            [operatorId, req.tenantId, customerId]
          );

          results.push({
            customer_id: customerId,
            nome: customerName,
            telefone: customerPhone,
            status: 'sent',
            error: null,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          await qRun(
            `INSERT INTO whatsapp_inbound_messages
              (
                tenant_id,
                provider,
                provider_message_id,
                customer_phone,
                customer_name,
                message_text,
                payload_json,
                intent,
                auto_reply_text,
                auto_reply_status,
                auto_reply_error,
                auto_reply_provider,
                auto_reply_external_id,
                auto_reply_attempted_at,
                auto_reply_sent_at,
                created_at,
                received_at
              )
             VALUES (?, ?, NULL, ?, ?, ?, ?, 'reativacao_manual', ?, ?, ?, ?, NULL, NOW(), NULL, NOW(), NOW())`,
            [
              req.tenantId,
              whatsappConfig.provider || null,
              customerPhone,
              customerName,
              message,
              JSON.stringify({
                source: 'delivery_customers_reactivation',
                customer_id: customerId,
              }),
              message,
              'error',
              errorMessage,
              whatsappConfig.provider || null,
            ]
          );
          await qRun(
            `UPDATE delivery_clientes
                SET whatsapp_reativacao_last_sent_at = NOW(),
                    whatsapp_reativacao_last_status = 'failed',
                    whatsapp_reativacao_last_operator_id = ?,
                    updated_at = NOW()
              WHERE tenant_id=? AND id=?`,
            [operatorId, req.tenantId, customerId]
          );

          results.push({
            customer_id: customerId,
            nome: customerName,
            telefone: customerPhone,
            status: 'failed',
            error: errorMessage,
          });
        }
      }

      const sent = results.filter((item) => item.status === 'sent').length;
      const failed = results.filter((item) => item.status === 'failed').length;
      const ignored = results.filter((item) => item.status.startsWith('ignored_')).length;

      return res.json({
        success: true,
        summary: {
          requested: customerIds.length,
          processed: results.length,
          sent,
          failed,
          ignored,
        },
        message_template:
          'Oi, {nome}! 😊 Sentimos sua falta por aqui.\nEstamos abertos hoje e sera um prazer receber seu pedido novamente 🍽️\nPeca pelo cardapio oficial: {link_loja}',
        link_loja: cardapioLink,
        send_with_menu_image: sendWithMenuImage && Boolean(cardapioReactivationImageUrl),
        cardapio_reactivation_image_url: cardapioReactivationImageUrl,
        results,
      });
    } catch (e: unknown) {
      sendInternalError(res, 'routes/delivery:clientesReativacaoWhatsapp', e);
    }
  });

  router.get('/clientes/:id/pedidos', async (req: Request, res) => {
    try {
      res.json(await qAll(
        `SELECT p.*, (SELECT STRING_AGG(pr.name||' x'||ip.quantity::text,', ') FROM itens_pedido ip JOIN produtos pr ON pr.id=ip.product_id WHERE ip.order_id=p.id) as resumo_itens
         FROM pedidos p WHERE p.tenant_id=? AND (p.cliente_id=? OR p.delivery_cliente_id=?) ORDER BY p.created_at DESC LIMIT 50`,
        [req.tenantId, req.params.id, req.params.id]
      ));
    } catch (e: unknown) { sendInternalError(res, 'routes/delivery', e); }
  });

  router.post('/pedidos', async (req: Request, res) => {
    try {
      const {
        items,
        cliente_nome,
        cliente_tel,
        endereco,
        pagamento_tipo,
        total_amount,
        taxa_entrega,
        observation,
        tipo_retirada,
      } = req.body;
      const tenantId = Number(req.tenantId);

      const tipoRetirada =
        String(tipo_retirada || 'delivery').trim().toLowerCase() === 'retirada' ? 'retirada' : 'delivery';

      let subtotal: number;
      let itensValidados: any[];
      try {
        const v = await validateDeliveryItems(tenantId, items || []);
        subtotal = v.subtotal;
        itensValidados = v.itensValidados;
      } catch (e) {
        if (isAppError(e)) return res.status(e.statusCode).json({ success: false, error: e.message });
        throw e;
      }

      const taxa = tipoRetirada === 'retirada' ? 0 : Number(taxa_entrega) || 0;
      const serverTotal = subtotal + taxa;
      const clientTotal = Number(total_amount);
      if (!Number.isFinite(clientTotal) || Math.abs(serverTotal - clientTotal) > MANUAL_DELIVERY_TOTAL_TOLERANCE) {
        return res.status(400).json({
          success: false,
          error: 'Total do pedido diverge do calculo no servidor',
        });
      }

      const clienteTelNormalizado = normalizePhone(cliente_tel);
      const deliveryClienteId = await findOrCreateStoreCustomerByPhone({
        tenantId,
        nome: cliente_nome,
        telefone: clienteTelNormalizado,
        origemCadastro: 'pedido_manual',
      });

      const dateObj = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
      const y = String(dateObj.getFullYear()).slice(-2);
      const m = String(dateObj.getMonth() + 1).padStart(2, '0');
      const d = String(dateObj.getDate()).padStart(2, '0');
      const prefix = `D${y}${m}${d}`;

      let orderId = 0;
      let on = '';
      let inserted = false;
      for (let attempt = 0; attempt < MANUAL_ORDER_NUMBER_RETRY_MAX; attempt++) {
        try {
          const r = await withTx(async (client) => {
            const todayCount = await txQ1<{ c: number }>(
              client,
              `SELECT COUNT(*)::int as c FROM pedidos WHERE tenant_id=? AND order_number LIKE ?`,
              [tenantId, `${prefix}-%`]
            );
            const n = Number(todayCount?.c || 0) + 1;
            const ordNum = `${prefix}-${String(n).padStart(3, '0')}`;
            const enderecoFinal =
              tipoRetirada === 'retirada' ? null : normalizeOptionalText(endereco);

            const oid = await txInsert(
              client,
              `INSERT INTO pedidos (order_number,total_amount,taxa_entrega,observation,tenant_id,canal,tipo_retirada,cliente_nome,cliente_tel,endereco,pagamento_tipo,pagamento_status,status,delivery_cliente_id,cliente_id) VALUES (?,?,?,?,?,'delivery',?,?,?,?,?,?,?,?,?,?)`,
              [
                ordNum,
                serverTotal,
                taxa,
                observation || null,
                tenantId,
                tipoRetirada,
                cliente_nome || null,
                clienteTelNormalizado || null,
                enderecoFinal,
                pagamento_tipo || 'dinheiro',
                pagamento_tipo === 'pix' ? 'aguardando_confirmacao' : 'pendente',
                'Pedido Recebido',
                deliveryClienteId,
                deliveryClienteId,
              ]
            );
            for (const item of itensValidados) {
              const lineObsRaw = item?.obs_opcoes ?? item?.observation;
              const lineObs =
                lineObsRaw === undefined || lineObsRaw === null
                  ? null
                  : (() => {
                      const s = String(lineObsRaw).trim();
                      if (!s) return null;
                      return s.length > 4000 ? s.slice(0, 4000) : s;
                    })();
              const selecoesJson = serializeOrderItemSelecoes(item?.selecoes);
              const vidRaw = item?.variation_id;
              const vidNum = vidRaw != null ? Number(vidRaw) : null;
              const variationIdForDb = Number.isInteger(vidNum) && vidNum! > 0 ? vidNum : null;
              await txRun(
                client,
                'INSERT INTO itens_pedido (order_id,product_id,quantity,type,price_at_time,tenant_id,variation_id,observation,selecoes_json) VALUES (?,?,?,?,?,?,?,?,?)',
                [oid, item.product_id, item.quantity, 'Delivery', item.price_at_time, tenantId, variationIdForDb, lineObs, selecoesJson]
              );
            }
            await insertDeliveryOrderEventTx(client, {
              pedidoId: Number(oid),
              tenantId,
              tipo: 'CRIACAO',
              statusNovo: 'Pedido Recebido',
              valor: serverTotal,
              payload: {
                origem: 'routes.delivery.createOrder',
                canal: 'delivery',
              },
            });
            return { orderId: Number(oid), orderNumber: ordNum };
          });
          orderId = r.orderId;
          on = r.orderNumber;
          inserted = true;
          break;
        } catch (e) {
          if (isPgUniqueViolation(e) && attempt < MANUAL_ORDER_NUMBER_RETRY_MAX - 1) continue;
          throw e;
        }
      }
      if (!inserted) {
        sendInternalError(
          res,
          'routes/delivery:manualOrderNumber',
          new Error('Nao foi possivel gerar numero do pedido')
        );
        return;
      }

      if (deliveryClienteId) {
        await touchStoreCustomerPurchase({
          clienteId: Number(deliveryClienteId),
          tenantId,
          origemCadastro: 'pedido_manual',
        });
      }

      const cfgRow = await q1<{ delivery_config: string | null }>('SELECT delivery_config FROM clientes WHERE id=?', [req.tenantId]);
      const parsed = coerceDeliveryConfigRow(cfgRow?.delivery_config ?? null);
      const automation = parseAutomationFromDeliveryConfigJson(parsed);
      let kitchenPrintAutomation: { ok: boolean; message?: string; reason?: string } | undefined;
      if (automation.delivery_auto_print_production) {
        const pr = await runAutomatedKitchenPrintForOrder(Number(req.tenantId), Number(orderId), {
          trigger: 'delivery_manual_post',
        });
        if (pr.ok) {
          kitchenPrintAutomation = { ok: true };
        } else if (isKitchenDispatchFailure(pr)) {
          kitchenPrintAutomation = { ok: false, message: pr.message || pr.reason, reason: pr.reason };
        }
      }

      notifyTenantOrderStreams(tenantId, 'new', { orderId });

      let paymentPix: Awaited<ReturnType<typeof createPixPayment>> = null;
      if (String(pagamento_tipo || '').trim().toLowerCase() === 'pix') {
        try {
          paymentPix = await createPixPayment({
            tenant_id: tenantId,
            order_id: orderId,
            amount: serverTotal,
            customer_name: cliente_nome || null,
            external_reference: on,
            description: `Pedido delivery #${on}`,
            metadata: {
              channel: 'delivery_manual',
              order_number: on,
            },
          });
        } catch (error) {
          logError('routes/delivery.createPixPayment', error, {
            tenantId,
            orderId,
            orderNumber: on,
          });
        }
      }

      res.json({
        success: true,
        orderId,
        orderNumber: on,
        payment_pix: paymentPix,
        automation: kitchenPrintAutomation ? { kitchen_print: kitchenPrintAutomation } : undefined,
      });
    } catch (e: any) {
      if (isAppError(e)) return res.status(e.statusCode).json({ success: false, error: e.message });
      sendInternalError(res, 'routes/delivery', e);
    }
  });

  router.get('/cupons', async (req: Request, res) => {
    try { res.json(await qAll('SELECT * FROM delivery_cupons WHERE tenant_id=? ORDER BY created_at DESC', [req.tenantId])); }
    catch (e: unknown) { sendInternalError(res, 'routes/delivery', e); }
  });

  router.post('/cupons', async (req: Request, res) => {
    try {
      const { codigo, tipo, valor, min_pedido, limite_uso, validade } = req.body;
      if (!codigo?.trim() || !tipo) return res.status(400).json({ error: 'codigo e tipo obrigatórios' });
      const id = await qInsert('INSERT INTO delivery_cupons (tenant_id,codigo,tipo,valor,min_pedido,limite_uso,validade) VALUES (?,?,?,?,?,?,?)',
        [req.tenantId, String(codigo).toUpperCase().trim(), tipo, valor||0, min_pedido||0, limite_uso||null, validade||null]);
      res.json({ success: true, id });
    } catch (e: unknown) { sendInternalError(res, 'routes/delivery', e); }
  });

  router.patch('/cupons/:id', async (req: Request, res) => {
    try {
      await qRun('UPDATE delivery_cupons SET ativo=? WHERE id=? AND tenant_id=?', [req.body.ativo?1:0, req.params.id, req.tenantId]);
      res.json({ success: true });
    } catch (e: unknown) { sendInternalError(res, 'routes/delivery', e); }
  });

  router.delete('/cupons/:id', async (req: Request, res) => {
    try {
      await qRun('DELETE FROM delivery_cupons WHERE id=? AND tenant_id=?', [req.params.id, req.tenantId]);
      res.json({ success: true });
    } catch (e: unknown) { sendInternalError(res, 'routes/delivery', e); }
  });
  // ── Relatório ───────────────────────────────────────────────
// ── Relatório ─────────────────────────────────────────────────────────────
  router.get('/relatorio', async (req: Request, res) => {
    try {
      const { periodo = 'hoje' } = req.query;
      
      // Limpa a string para evitar erros se o Front mandar "7 dias" ou "7_dias"
      let pKey = String(periodo).toLowerCase().replace(/ /g, '').replace('_', '');
      if (pKey === '7dias') pKey = '7d';
      if (pKey === '30dias') pKey = '30d';
      if (pKey === 'estemes') pKey = 'mes';

      const periodoMap: Record<string, string> = {
        hoje: `(created_at AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date`,
        '7d': `(created_at AT TIME ZONE '${TZ}')::date >= (NOW() AT TIME ZONE '${TZ}')::date - INTERVAL '6 days'`,
        '30d': `(created_at AT TIME ZONE '${TZ}')::date >= (NOW() AT TIME ZONE '${TZ}')::date - INTERVAL '29 days'`,
        mes: `DATE_TRUNC('month', created_at AT TIME ZONE '${TZ}') = DATE_TRUNC('month', NOW() AT TIME ZONE '${TZ}')`,
      };
      const dateCond = periodoMap[pKey] || periodoMap.hoje;
      const dateCondP = dateCond.replace(/created_at/g, 'p.created_at');

      const baseFilter = `tenant_id=? AND canal='delivery' AND ${dateCond}`;
      const baseFilterP = `p.tenant_id=? AND p.canal='delivery' AND ${dateCondP}`;
      const notCanceledCondition = buildValidOrderSqlClause();
      const operationalFilter = `${baseFilter} AND ${notCanceledCondition}`;
      const operationalFilterP = `${baseFilterP} AND ${buildValidOrderSqlClause('p')}`;
      const canceledCondition = `LOWER(COALESCE(status,'')) = 'cancelado' OR cancelado_at IS NOT NULL`;
      const deliveredOperationalCondition = `status='Entregue' AND ${notCanceledCondition}`;

      const [stats, porDia, porHora, topProdutos, porPagamento] = await Promise.all([
        q1(
          `SELECT SUM(CASE WHEN ${notCanceledCondition} THEN 1 ELSE 0 END) as total_pedidos,
                  COALESCE(SUM(CASE WHEN ${notCanceledCondition} THEN total_amount ELSE 0 END),0) as faturamento_total,
                  COALESCE(AVG(CASE WHEN ${notCanceledCondition} THEN total_amount END),0) as ticket_medio,
                  COUNT(DISTINCT CASE WHEN ${notCanceledCondition} THEN COALESCE(cliente_id, delivery_cliente_id) END) as clientes_unicos,
                  SUM(CASE WHEN ${deliveredOperationalCondition} THEN 1 ELSE 0 END) as entregues,
                  SUM(CASE WHEN ${canceledCondition} THEN 1 ELSE 0 END) as cancelados
           FROM pedidos WHERE ${baseFilter}`,
          [req.tenantId]
        ),
        qAll(
          `SELECT TO_CHAR((created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') as dia,
                  COUNT(*) as pedidos, COALESCE(SUM(total_amount),0) as faturamento
           FROM pedidos WHERE ${operationalFilter} GROUP BY 1 ORDER BY 1 ASC`,
          [req.tenantId]
        ),
        qAll(
          `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE '${TZ}') as hora, COUNT(*) as pedidos
           FROM pedidos WHERE ${operationalFilter} GROUP BY 1 ORDER BY 1 ASC`,
          [req.tenantId]
        ),
        qAll(
          `SELECT pr.name, SUM(ip.quantity) as qtd, SUM(ip.quantity*ip.price_at_time) as receita
           FROM itens_pedido ip
           JOIN produtos pr ON pr.id=ip.product_id
           JOIN pedidos p ON p.id=ip.order_id
           WHERE ${operationalFilterP}
           GROUP BY pr.id, pr.name ORDER BY qtd DESC LIMIT 10`,
          [req.tenantId]
        ),
        qAll(
          `SELECT pagamento_tipo, COUNT(*) as qtd, COALESCE(SUM(total_amount),0) as total
           FROM pedidos WHERE ${operationalFilter} AND pagamento_tipo IS NOT NULL
           GROUP BY 1`,
          [req.tenantId]
        ),
      ]);

      // Envia a estrutura exata que o DeliveryScreen.tsx espera!
      res.json({ 
        resumo: {
          total_pedidos: Number(stats?.total_pedidos || 0),
          faturamento_total: Number(stats?.faturamento_total || 0),
          ticket_medio: Number(stats?.ticket_medio || 0),
          clientes_unicos: Number(stats?.clientes_unicos || 0),
          entregues: Number(stats?.entregues || 0),
          cancelados: Number(stats?.cancelados || 0),
        },
        porDia: porDia.map((d:any) => ({ ...d, pedidos: Number(d.pedidos), faturamento: Number(d.faturamento) })), 
        porHora: porHora.map((h:any) => ({ ...h, hora: Number(h.hora), pedidos: Number(h.pedidos) })), 
        topProdutos: topProdutos.map((p:any) => ({ ...p, qtd: Number(p.qtd), receita: Number(p.receita) })), 
        porPagamento: porPagamento.map((p:any) => ({ ...p, qtd: Number(p.qtd), total: Number(p.total) })) 
      });
    } catch (e: any) { 
      console.error('Erro no relatorio:', e);
      sendInternalError(res, 'routes/delivery', e); 
    }
  });

  return router;
}