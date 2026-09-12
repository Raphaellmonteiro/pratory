import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Bike, Package, Clock, CheckCircle2, XCircle, MapPin,
  Phone, Settings, RefreshCw, ChevronRight,
  User, CreditCard, Banknote, Smartphone, Check,
  Truck, AlertCircle, DollarSign, TrendingUp, Users, Search,
  Printer, Navigation, MessageCircle, BarChart2, Tag, Plus, Trash2, ChefHat,
  Zap, Globe, Bell, BellOff, Map, Palette, ListTree, Image, Upload,
} from 'lucide-react';
import { openPrintPreview } from '../utils/print';
import { getOrderItemDetailText, orderHasAnyItemCustomization, splitOrderItemDetailLines } from '../utils/orderItemDisplay';
import { getDeliveryNextStatus } from '../utils/deliveryStatusNext';
import { playNewOrderSound } from '../utils/sound';
import { DEFAULT_TENANT_AUTOMATION, type TenantAutomationConfig } from '../services/automationConfig';
import { OrderAutomationBadges } from '../components/OrderAutomationBadges';
import { EmptyState } from '../components/ui/EmptyState';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { Spinner } from '../components/ui/Spinner';
import { StatusChip } from '../components/ui/StatusChip';
import { adminOpsDashedWellClass, adminOpsInsetPanelClass, adminOpsSurfaceCardClass } from '../components/ui/screenChrome';
import { normalizeCardapioOnlineBannerSlots } from '../utils/deliveryCardapioBannerSlots';
import WhatsAppConnectionPanel from './WhatsAppConnectionPanel';

// ─── Tipos ───────────────────────────────────────────────────────────────────
interface DeliveryPedidoItem {
  product_id: number;
  product_name: string;
  quantity: number;
  price_at_time: number;
  observation?: string | null;
}
interface Pedido {
  id: number; order_number: string; status: string; total_amount: number;
  cliente_nome?: string; cliente_tel?: string; endereco?: string;
  pagamento_tipo?: string; pagamento_status?: string; taxa_entrega?: number;
  motoboy_id?: number; saiu_entrega_at?: string; entregue_at?: string;
  created_at: string; resumo_itens?: string; observation?: string;
  /** Lista estruturada (API GET /delivery/pedidos); fallback para `resumo_itens`. */
  itens?: DeliveryPedidoItem[];
  delivery_checkout_snapshot?: DeliveryCheckoutSnapshot | string | null;
  /** Sinais de automação (GET /api/delivery/pedidos — subconsultas em `pedido_eventos`). */
  automation_auto_delivery_accept?: boolean;
  automation_kitchen_failed?: boolean;
  automation_kitchen_ok?: boolean;
}
interface Motoboy { id: number; nome: string; cargo: string; }
interface DeliveryConfig {
  ativo: boolean; taxa_entrega?: number; pedido_minimo?: number;
  tempo_preparo?: number; whatsapp?: string; pix_chave?: string;
  cardapio_link_curto?: string;
  pix_nome?: string; pix_cidade?: string; pix_payload_estatico?: string;
  desconto_pix?: number; horario_abertura?: string; horario_fechamento?: string;
  /** Se true, usa `horarios_semana` (múltiplas janelas por dia). */
  horarios_semana_ativo?: boolean;
  /** Agenda semanal: por dia (0=dom ... 6=sáb), até 2 janelas. */
  horarios_semana?: Record<string, Array<{ abertura?: string; fechamento?: string }>> | unknown;
  /** 0=domingo … 6=sábado (`Date#getDay`). Dias em que o cardápio não aceita pedidos. */
  dias_folga_entrega?: number[];
  payment_provider?: string;
  provider_enabled?: boolean;
  api_key?: string;
  access_token?: string;
  webhook_secret?: string;
  pix_key?: string;
  provider_sandbox?: boolean;
  itau_tls_cert_pem?: string;
  itau_tls_key_pem?: string;
  itau_tls_ca_pem?: string;
  itau_api_base_url?: string;
  itau_token_url?: string;
  modelo_entrega?: 'bairro_fixo';
  bairros_atendidos?: string; valor_por_entrega?: number;
  zonas_entrega?: Array<{ nome: string; taxa: number }>;
  desconto_primeiro_cliente_ativo?: boolean;
  desconto_primeiro_cliente_tipo?: 'percentual'|'fixo'|'frete_gratis';
  desconto_primeiro_cliente_valor?: number;
  desconto_primeiro_cliente_min_pedido?: number;
  evolution_url?: string; evolution_token?: string; evolution_instance?: string;
  evolution_phone_number?: string;
  evolution_channel_id?: string;
  whatsapp_provider?: string | null;
  whatsapp_enabled?: boolean;
  whatsapp_order_notifications_enabled?: boolean;
  whatsapp_active_number?: string | null;
  whatsapp_inbound_webhook_path?: string | null;
  theme_mode?: 'dark_premium' | 'light_red';
  automation?: Partial<TenantAutomationConfig>;
  /** Logo só do cardápio online (`/uploads/delivery/...`). Vazio = logo geral (Configurações). */
  cardapio_online_logo_url?: string;
  /** Quatro banners do topo; índices 0–3. */
  cardapio_online_banner_urls?: string[];
  /** Imagem opcional usada na reativação de clientes via WhatsApp. */
  cardapio_reactivation_image_url?: string;
}
interface Dashboard {
  pedidos_hoje: number; faturamento_hoje: number;
  em_preparo: number; em_rota: number;
  top_motoboy: { nome: string; entregas: number } | null;
  ticket_medio: number;
}
interface Cupom {
  id: number; codigo: string; tipo: 'percentual'|'fixo'|'frete_gratis';
  valor: number; min_pedido: number; limite_uso: number|null;
  uso_atual: number; ativo: number; validade: string|null; created_at: string;
}
interface DeliveryCheckoutSnapshot {
  modelo_entrega?: 'bairro_fixo';
  bairro_entrega?: string | null;
  taxa_entrega?: number;
  zona_entrega?: { nome: string; taxa: number } | null;
  desconto_pix?: number;
  desconto_cupom?: number;
  desconto_primeiro_cliente?: number;
  total?: number;
  primeiro_cliente?: {
    descricao?: string;
    mensagem?: string;
  } | null;
}
interface DeliveryCustomer {
  id: number;
  nome: string;
  telefone: string;
  email?: string | null;
  observacoes?: string | null;
  origem_cadastro?: string | null;
  primeira_compra_at?: string | null;
  ultima_compra_at?: string | null;
  ultimo_pedido?: string | null;
  dias_sem_comprar?: number | null;
  status_atividade?: string | null;
  cliente_recorrente?: boolean;
  fidelizacao?: { tier: string; label: string };
  total_pedidos?: number;
  total_pedidos_validos?: number;
  total_gasto?: number;
  sem_historico?: boolean;
  tem_pix_pendente?: boolean;
  whatsapp_reativacao_last_sent_at?: string | null;
  whatsapp_reativacao_last_status?: 'sent' | 'failed' | string | null;
  whatsapp_reativacao_last_operator_id?: number | null;
}
interface CustomerOrderHistory {
  id: number;
  order_number: string;
  created_at: string;
  total_amount: number;
  resumo_itens?: string | null;
  pagamento_tipo?: string | null;
  pagamento_status?: string | null;
  status?: string | null;
}

// ─── Config de status (toneClass para light/dark nativo) ───────────────────────
const STATUS_CFG: Record<string, { label: string; color: string; bg: string; toneClass: string; icon: React.ReactNode; next?: string }> = {
  'Criado':              { label: 'Recebido',     color: '#3b82f6', bg: '#eff6ff', toneClass: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-500/30', icon: <Package size={14}/>,      next: getDeliveryNextStatus('Criado') },
  'Pedido Recebido':     { label: 'Recebido',     color: '#3b82f6', bg: '#eff6ff', toneClass: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-500/30', icon: <Package size={14}/>,      next: getDeliveryNextStatus('Pedido Recebido') },
  'Em Preparo':          { label: 'Em Preparo',   color: '#f59e0b', bg: '#fffbeb', toneClass: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-500/30', icon: <Clock size={14}/>,         next: getDeliveryNextStatus('Em Preparo') },
  'Pronto para Entrega': { label: 'Pronto',       color: '#8b5cf6', bg: '#f5f3ff', toneClass: 'bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-500/30', icon: <CheckCircle2 size={14}/>,  next: getDeliveryNextStatus('Pronto para Entrega') },
  'Saiu para Entrega':   { label: 'Em Rota',      color: '#f97316', bg: '#fff7ed', toneClass: 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-500/30', icon: <Bike size={14}/>,          next: getDeliveryNextStatus('Saiu para Entrega') },
  'Entregue':            { label: 'Entregue',     color: '#10b981', bg: '#ecfdf5', toneClass: 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/30', icon: <CheckCircle2 size={14}/>,  next: getDeliveryNextStatus('Entregue') },
  'Cancelado':           { label: 'Cancelado',    color: '#ef4444', bg: '#fef2f2', toneClass: 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-300 border-red-200 dark:border-red-500/30', icon: <XCircle size={14}/>,       next: getDeliveryNextStatus('Cancelado') },
};

/** Rótulo curto do próximo passo (evita mostrar nome técnico de status). */
function deliveryNextActionTitle(next: string): string {
  if (next === 'Pedido Recebido') return 'aceitar o pedido';
  if (next === 'Em Preparo') return 'preparo';
  if (next === 'Pronto para Entrega') return 'pronto para entrega';
  if (next === 'Saiu para Entrega') return 'rota de entrega';
  if (next === 'Entregue') return 'entregue';
  return next;
}

function deliveryNextPrimaryLabel(next: string): string {
  if (next === 'Pedido Recebido') return 'Aceitar';
  if (next === 'Em Preparo') return 'Preparar';
  if (next === 'Pronto para Entrega') return 'Pronto';
  if (next === 'Saiu para Entrega') return 'Despachar';
  if (next === 'Entregue') return 'Entregar';
  return 'Avançar';
}

const PAGS: Record<string, { label: string; icon: React.ReactNode }> = {
  pix:      { label: 'Pix',            icon: <Smartphone size={12}/> },
  dinheiro: { label: 'Dinheiro',       icon: <Banknote size={12}/>   },
  cartao:   { label: 'Cartão entrega', icon: <CreditCard size={12}/> },
};

const fmt      = (v: number) => `R$ ${(v||0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
const fmtHour  = (d?: string) => d ? new Date(d.includes('T')?d:d.replace(' ','T')).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) : '—';

function deliveryPedidoTemItensDetalhe(p: Pedido): boolean {
  return Array.isArray(p.itens) && p.itens.length > 0;
}

function deliveryPedidoTemCustomizacaoItens(p: Pedido): boolean {
  if (!Array.isArray(p.itens)) return false;
  return orderHasAnyItemCustomization({ items: p.itens as any });
}

function formatDeliveryItensResumoWhatsApp(p: Pedido): string {
  if (deliveryPedidoTemItensDetalhe(p)) {
    return p
      .itens!.map((it) => {
        const d = getOrderItemDetailText(it);
        const base = `- ${it.quantity}x ${it.product_name}`;
        return d ? `${base} (${d})` : base;
      })
      .join('\n');
  }
  return p.resumo_itens || '';
}
const parseDeliveryCheckoutSnapshot = (value: Pedido['delivery_checkout_snapshot']) => {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as DeliveryCheckoutSnapshot;
    } catch {
      return null;
    }
  }
  return value;
};
const CUSTOMER_ACTIVITY_CFG: Record<string, { label: string; tone: string; helper: string }> = {
  ativo:      { label: 'Ativo',      tone: 'bg-emerald-50 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/30', helper: 'Comprou recentemente' },
  em_risco:   { label: 'Em risco',   tone: 'bg-amber-50 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-500/30', helper: 'Vale acompanhar' },
  inativo:    { label: 'Inativo',    tone: 'bg-rose-50 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-500/30', helper: 'Bom candidato a reativacao' },
  sem_compra: { label: 'Sem compra', tone: 'bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-600', helper: 'Ainda sem historico valido' },
};
const CUSTOMER_ORIGIN_LABELS: Record<string, string> = {
  delivery_online: 'Cardapio online',
  pedido_manual: 'Pedido manual',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  telefone: 'Telefone',
  balcao: 'Balcao',
};
const parseDateValue = (d?: string | null) => {
  if (!d) return null;
  const value = String(d);
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date;
};
const fmtDate = (d?: string | null) => {
  const value = parseDateValue(d);
  return value ? value.toLocaleDateString('pt-BR') : '—';
};
const getCustomerActivityMeta = (status?: string | null) =>
  CUSTOMER_ACTIVITY_CFG[String(status || '').trim()] || CUSTOMER_ACTIVITY_CFG.sem_compra;
const getCustomerOriginLabel = (origem?: string | null) => {
  const normalized = String(origem || '').trim().toLowerCase();
  if (!normalized) return 'Nao informado';
  if (CUSTOMER_ORIGIN_LABELS[normalized]) return CUSTOMER_ORIGIN_LABELS[normalized];
  return normalized
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
};
const getDaysWithoutPurchaseLabel = (dias?: number | null) => {
  if (dias === null || dias === undefined) return 'Sem historico';
  if (dias <= 0) return 'Comprou hoje';
  if (dias === 1) return '1 dia sem comprar';
  return `${dias} dias sem comprar`;
};
const getCustomerPurchaseSummary = (customer: DeliveryCustomer) =>
  customer.ultima_compra_at || customer.ultimo_pedido ? getDaysWithoutPurchaseLabel(customer.dias_sem_comprar) : 'Sem compras registradas';
const fmtDateTime = (d?: string | null) => {
  const value = parseDateValue(d);
  if (!value) return '—';
  return value.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};
const isSameCalendarDay = (left: Date, right: Date) =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();
const getReactivationStatusMeta = (customer: DeliveryCustomer) => {
  const sentAt = parseDateValue(customer.whatsapp_reativacao_last_sent_at);
  const status = String(customer.whatsapp_reativacao_last_status || '').trim().toLowerCase();
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  if (status === 'failed') {
    return {
      key: 'failed',
      label: 'Falhou',
      detail: sentAt ? `Ultimo envio: ${fmtDateTime(customer.whatsapp_reativacao_last_sent_at)}` : 'Falha sem horario registrado',
      tone: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/20 dark:text-rose-300 dark:border-rose-500/30',
    };
  }
  if (!sentAt) {
    return {
      key: 'never',
      label: 'Nunca enviado',
      detail: 'Sem disparo de reativacao',
      tone: 'bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-700 dark:text-zinc-300 dark:border-zinc-600',
    };
  }
  if (isSameCalendarDay(sentAt, now)) {
    return {
      key: 'sent_today',
      label: 'Enviado hoje',
      detail: `Ultimo envio: ${fmtDateTime(customer.whatsapp_reativacao_last_sent_at)}`,
      tone: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/20 dark:text-emerald-300 dark:border-emerald-500/30',
    };
  }
  if (isSameCalendarDay(sentAt, yesterday)) {
    return {
      key: 'sent_yesterday',
      label: 'Enviado ontem',
      detail: `Ultimo envio: ${fmtDateTime(customer.whatsapp_reativacao_last_sent_at)}`,
      tone: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/20 dark:text-blue-300 dark:border-blue-500/30',
    };
  }
  return {
    key: 'sent_before',
    label: `Ultimo envio: ${fmtDateTime(customer.whatsapp_reativacao_last_sent_at)}`,
    detail: status === 'sent' ? 'Reativacao enviada com sucesso' : 'Historico de reativacao',
    tone: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/20 dark:text-blue-300 dark:border-blue-500/30',
  };
};
const wasReactivationSentInLastDays = (customer: DeliveryCustomer, days: number) => {
  const sentAt = parseDateValue(customer.whatsapp_reativacao_last_sent_at);
  if (!sentAt || days <= 0) return false;
  const threshold = new Date();
  threshold.setHours(0, 0, 0, 0);
  threshold.setDate(threshold.getDate() - (days - 1));
  return sentAt >= threshold;
};
const hasCustomerPhoneForWhatsApp = (customer: DeliveryCustomer) =>
  String(customer.telefone || '').replace(/\D/g, '').length >= 10;
const isReadyForReactivation = (customer: DeliveryCustomer) => {
  const activity = String(customer.status_atividade || '').trim();
  if (!['em_risco', 'inativo'].includes(activity)) return false;
  if (!hasCustomerPhoneForWhatsApp(customer)) return false;
  return getReactivationStatusMeta(customer).key !== 'sent_today';
};

const deliverySecondaryButtonActiveClass = 'bg-zinc-900 dark:bg-zinc-700 text-white';
const deliverySecondaryButtonInactiveClass =
  'bg-zinc-50 border border-zinc-200 text-zinc-600 hover:bg-zinc-100 hover:border-zinc-300 dark:bg-zinc-800 dark:border-zinc-700 dark:text-white dark:hover:bg-zinc-700 dark:hover:border-zinc-600';
type DeliveryRootTab = 'painel' | 'motoboys' | 'relatorio' | 'config';
type DeliveryConfigSection = 'loja' | 'zonas' | 'cupons' | 'evolution';
type DeliveryScreenMode = 'default' | 'whatsapp-ia';

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function DeliveryScreen({
  token,
  hasMotoboyFeature = true,
  slug,
  mode = 'default',
}: {
  token: string;
  hasMotoboyFeature?: boolean;
  slug?: string;
  mode?: DeliveryScreenMode;
}) {
  const isWhatsAppIAMode = mode === 'whatsapp-ia';
  const [tab, setTab] = useState<DeliveryRootTab>(isWhatsAppIAMode ? 'config' : 'painel');
  useEffect(() => {
    if (!hasMotoboyFeature && tab === 'motoboys') {
      setTab('painel');
    }
  }, [hasMotoboyFeature, tab]);

  return (
    <motion.div initial={{ opacity:0, y:8 }} animate={{ opacity:1, y:0 }} className="h-full min-h-0 overflow-y-auto bg-fp-secondary">
      <div className="mx-auto w-full min-w-0 space-y-4 p-3 sm:space-y-5 sm:p-4 lg:p-6 2xl:max-w-[1800px]">
        <ScreenHeader
          titleAs="h1"
          titleClassName="flex items-center gap-2 flex-wrap"
          title={
            <>
              {isWhatsAppIAMode ? <Zap size={24} className="shrink-0" /> : <Bike size={24} className="shrink-0" />}
              {isWhatsAppIAMode ? 'WhatsApp IA' : 'Delivery'}
            </>
          }
          subtitle={isWhatsAppIAMode ? 'Canal dedicado da IA, configuracao do provider e webhook inbound' : 'Canal delivery, motoboys e configuracoes'}
          actions={
            !isWhatsAppIAMode && slug ? (
              <a
                href={`/delivery/${slug}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-center gap-2 px-4 py-3 min-h-[44px] bg-zinc-900 text-white rounded-xl text-sm font-bold hover:bg-zinc-700 transition-colors shrink-0"
              >
                <MapPin size={14} /> Ver Cardápio Online
              </a>
            ) : null
          }
        />

        {isWhatsAppIAMode ? (
          <DeliveryConfigPanel token={token} slug={slug} initialSection="evolution" standaloneSection="evolution" />
        ) : (
          <>
            {/* Tabs — mobile: scroll horizontal, toque confortável; desktop: inline */}
            <div className="flex bg-fp-card border border-fp-border rounded-xl p-1 gap-0.5 w-full sm:w-fit overflow-x-auto overflow-y-hidden snap-x snap-mandatory scroll-pl-1 scroll-pr-1 sm:scroll-pl-0 sm:scroll-pr-0 [-webkit-overflow-scrolling:touch]">
              {([
                { key: 'painel', label: 'Painel', icon: <Package size={14} /> },
                { key: 'motoboys', label: 'Motoboys', icon: <Truck size={14} /> },
                { key: 'relatorio', label: 'Relatório', icon: <BarChart2 size={14} /> },
                { key: 'config', label: 'Configurações', icon: <Settings size={14} /> },
              ] as const).map((t) => {
                if (t.key === 'motoboys' && !hasMotoboyFeature) return null;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTab(t.key)}
                    className={`flex items-center gap-2 px-3 sm:px-4 py-2.5 min-h-[44px] rounded-lg text-sm font-bold transition-all shrink-0 snap-start whitespace-nowrap ${
                      tab === t.key
                        ? 'bg-zinc-900 text-white dark:bg-zinc-800'
                        : 'text-fptext-muted hover:bg-fp-hover active:bg-fp-active'
                    }`}
                  >
                    {t.icon}
                    {t.label}
                  </button>
                );
              })}
            </div>

            {tab === 'painel' && <TabPainel token={token} hasMotoboyFeature={hasMotoboyFeature} />}
            {tab === 'motoboys'  && hasMotoboyFeature && <TabMotoboys token={token} />}
            {tab === 'relatorio' && <TabRelatorio token={token} />}
            {tab === 'config'    && <DeliveryConfigPanel token={token} slug={slug} />}
          </>
        )}
      </div>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SSE autenticado: `EventSource` não envia `Authorization`; usamos `fetch` + stream com `Bearer` (sem token na URL).
// ═══════════════════════════════════════════════════════════════════════════════
function subscribeAuthorizedSse(
  url: string,
  token: string,
  handlers: {
    onConnected?: () => void;
    onPing?: () => void;
    onNovoPedido?: () => void;
    onStatusPedido?: () => void;
  },
  signal: AbortSignal
): Promise<void> {
  return (async () => {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) throw new Error(`sse ${res.status}`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('sse sem body');
    const dec = new TextDecoder();
    let buf = '';
    let eventName = 'message';
    let dataLines: string[] = [];

    const dispatch = () => {
      const ev = eventName;
      eventName = 'message';
      if (dataLines.length === 0) return;
      dataLines = [];
      if (ev === 'connected') handlers.onConnected?.();
      else if (ev === 'ping') handlers.onPing?.();
      else if (ev === 'novo_pedido') handlers.onNovoPedido?.();
      else if (ev === 'status_pedido') handlers.onStatusPedido?.();
    };

    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (;;) {
        const i = buf.indexOf('\n');
        if (i < 0) break;
        let line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          dispatch();
          continue;
        }
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
    }
  })();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ABA PAINEL — com SSE + som + reimprimir
// ═══════════════════════════════════════════════════════════════════════════════
function TabPainel({ token, hasMotoboyFeature = true }: { token: string; hasMotoboyFeature?: boolean }) {
  const DELIVERY_POLLING_INTERVAL_MS = 10000;
  const [pedidos, setPedidos]           = useState<Pedido[]>([]);
  const [motoboys, setMotoboys]         = useState<Motoboy[]>([]);
  const [loading, setLoading]           = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('ativos');
  const [selectedPedido, setSelectedPedido] = useState<Pedido | null>(null);
  const [sseConectado, setSseConectado] = useState(false);
  const [somAtivo, setSomAtivo]         = useState(() => localStorage.getItem('delivery_som') !== 'false');
  const [opsToast, setOpsToast]         = useState<{ msg: string; ok: boolean } | null>(null);
  const sseAbortRef                     = useRef<AbortController | null>(null);
  const reconnRef                       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFetchingRef                   = useRef(false);
  const hasLoadedPedidosRef             = useRef(false);
  const pedidosRef                      = useRef<Pedido[]>([]);
  const selectedPedidoRef               = useRef<Pedido | null>(null);
  pedidosRef.current                    = pedidos;
  selectedPedidoRef.current             = selectedPedido;
  const hdrs = { Authorization: `Bearer ${token}` };

  const fetchAll = useCallback(async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      const [pRes, mRes] = await Promise.all([
        fetch('/api/delivery/pedidos', { headers: hdrs }),
        hasMotoboyFeature ? fetch('/api/delivery/motoboys', { headers: hdrs }) : Promise.resolve(null),
      ]);
      if (pRes.ok) {
        const d = await pRes.json();
        if (Array.isArray(d)) {
          const previousIds = new Set(pedidosRef.current.map((pedido) => Number(pedido.id)));
          const hasLoadedBefore = hasLoadedPedidosRef.current;
          const hasNewOrder = hasLoadedBefore && d.some((pedido) => !previousIds.has(Number(pedido.id)));
          setPedidos(d);
          if (selectedPedidoRef.current) {
            const updatedSelectedPedido = d.find((pedido) => Number(pedido.id) === Number(selectedPedidoRef.current?.id));
            if (updatedSelectedPedido) setSelectedPedido(updatedSelectedPedido);
          }
          hasLoadedPedidosRef.current = true;
          if (hasNewOrder && somAtivo && localStorage.getItem('delivery_som') !== 'false') {
            playNewOrderSound();
          }
        }
      }
      if (hasMotoboyFeature && mRes?.ok) {
        const d = await mRes.json();
        if (Array.isArray(d)) setMotoboys(d);
      } else if (!hasMotoboyFeature) {
        setMotoboys([]);
      }
    } catch {}
    finally {
      isFetchingRef.current = false;
      setLoading(false);
    }
  }, [token, somAtivo, hasMotoboyFeature]);

  // ── SSE complementar: hoje serve como keep-alive/aceleração quando houver
  // eventos úteis, mas o polling continua sendo a fonte confiável do painel.
  const connectSSE = useCallback(() => {
    sseAbortRef.current?.abort();
    const ac = new AbortController();
    sseAbortRef.current = ac;
    void subscribeAuthorizedSse(
      '/api/events',
      token,
      {
        onConnected: () => setSseConectado(true),
        onPing: () => setSseConectado(true),
        onNovoPedido: () => {
          setSseConectado(true);
          fetchAll();
        },
        onStatusPedido: () => {
          setSseConectado(true);
          fetchAll();
        },
      },
      ac.signal
    ).catch(() => {
      if (ac.signal.aborted) return;
      setSseConectado(false);
      reconnRef.current = setTimeout(connectSSE, 5000);
    });
  }, [token, fetchAll]);

  useEffect(() => {
    fetchAll();
    connectSSE();
    // Polling principal para manter o painel confiável mesmo sem eventos úteis.
    const iv = setInterval(fetchAll, DELIVERY_POLLING_INTERVAL_MS);
    return () => {
      clearInterval(iv);
      sseAbortRef.current?.abort();
      sseAbortRef.current = null;
      if (reconnRef.current) clearTimeout(reconnRef.current);
    };
  }, [fetchAll, connectSSE, DELIVERY_POLLING_INTERVAL_MS]);

  const toggleSom = () => {
    const novo = !somAtivo;
    setSomAtivo(novo);
    localStorage.setItem('delivery_som', String(novo));
    if (novo) playNewOrderSound();
  };

  const mudarStatus = async (id: number, status: string, motoboyId?: number) => {
    const body: any = { status };
    if (motoboyId) body.motoboy_id = motoboyId;
    const res = await fetch(`/api/delivery/pedidos/${id}/status`, {
      method: 'PATCH', headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data: { automation?: { kitchen_print?: { ok?: boolean; message?: string } } } = {};
    try {
      data = await res.json();
    } catch {
      /* ignore */
    }
    if (data?.automation?.kitchen_print && data.automation.kitchen_print.ok === false) {
      setOpsToast({
        msg:
          data.automation.kitchen_print.message ||
          'Produção não foi impressa automaticamente. Use o botão Produção ou verifique a impressora.',
        ok: false,
      });
      window.setTimeout(() => setOpsToast(null), 8000);
    }
    fetchAll();
    if (selectedPedido?.id === id) setSelectedPedido((p) => (p ? { ...p, status } : null));
  };

  const marcarPago = async (id: number) => {
    await fetch(`/api/delivery/pedidos/${id}/pagamento`, {
      method: 'PATCH', headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pagamento_status: 'pago' }),
    });
    fetchAll();
  };

  const reimprimir = async (pedidoId: number) => {
    try {
      const r = await fetch(`/api/print/cupom-html/${pedidoId}`, { headers: hdrs });
      const html = await r.text();
      openPrintPreview(html, 'width=420,height=700,toolbar=0,menubar=0,location=0');
    } catch { alert('Erro ao reimprimir'); }
  };

  const imprimirProducao = async (pedidoId: number) => {
    try {
      const r = await fetch(`/api/print/comanda-html/${pedidoId}`, { headers: hdrs });
      const html = await r.text();
      if (html.trim().toLowerCase().includes('nenhum item de preparo')) {
        alert('Nenhum item de preparo neste pedido.');
        return;
      }
      openPrintPreview(html, 'width=420,height=700,toolbar=0,menubar=0,location=0');
    } catch {
      alert('Erro ao imprimir produção.');
    }
  };

  const ATIVOS  = ['Criado','Pedido Recebido','Em Preparo','Pronto para Entrega','Saiu para Entrega'];
  const filtrados = statusFilter === 'ativos' ? pedidos.filter(p => ATIVOS.includes(p.status))
    : statusFilter === 'todos'           ? pedidos
    : statusFilter === 'Pedido Recebido' ? pedidos.filter(p => p.status==='Criado'||p.status==='Pedido Recebido')
    : pedidos.filter(p => p.status === statusFilter);
  const COLUNAS = ['Criado','Em Preparo','Pronto para Entrega','Saiu para Entrega'];
  const selectedPedidoSnapshot = parseDeliveryCheckoutSnapshot(selectedPedido?.delivery_checkout_snapshot);

  return (
    <div className="min-w-0 space-y-4 lg:space-y-5">
      {opsToast && (
        <div
          className={`rounded-xl border px-4 py-3 text-xs font-semibold shadow-sm ${
            opsToast.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100'
              : 'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100'
          }`}
          role="status"
        >
          {opsToast.msg}
        </div>
      )}
      {/* Barra de controles — mobile: filtros em faixa rolável; tools em linha própria */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-2">
        <div className="flex items-center gap-2 overflow-x-auto overflow-y-hidden pb-0.5 -mx-1 px-1 sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible touch-pan-x overscroll-x-contain scroll-pl-1 scroll-pr-1 [-webkit-overflow-scrolling:touch]">
          {[
            { key:'ativos',  label:'Ativos' },
            { key:'todos',   label:'Todos'  },
            ...Object.entries(STATUS_CFG).filter(([k]) => k !== 'Pedido Recebido').map(([k,v]) => ({ key:k, label:v.label })),
          ].map(f => (
            <button key={f.key} type="button" onClick={() => setStatusFilter(f.key)}
              className={`shrink-0 snap-start px-3 py-2 min-h-[40px] rounded-xl text-xs font-bold transition-all whitespace-nowrap ${statusFilter===f.key ? deliverySecondaryButtonActiveClass : `${deliverySecondaryButtonInactiveClass} active:opacity-90`}`}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 sm:ml-auto sm:justify-end shrink-0">
          <div className={`flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-xl text-xs font-bold ${sseConectado?'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300':'bg-zinc-100 dark:bg-zinc-800 text-fptext-muted'}`}>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${sseConectado?'bg-emerald-500 animate-pulse':'bg-zinc-400'}`}/>
            {`Polling ${Math.floor(DELIVERY_POLLING_INTERVAL_MS / 1000)}s${sseConectado ? ' + SSE' : ''}`}
          </div>
          <button type="button" onClick={toggleSom} title={somAtivo?'Desativar som':'Ativar som'}
            className={`p-2.5 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-xs font-bold transition-all ${somAtivo?'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300':'bg-zinc-100 dark:bg-zinc-800 text-fptext-muted'}`}>
            {somAtivo ? <Bell size={18}/> : <BellOff size={18}/>}
          </button>
          <button type="button" onClick={fetchAll} className="p-2.5 min-h-[44px] min-w-[44px] flex items-center justify-center bg-fp-card border border-fp-border rounded-xl text-fptext-muted active:bg-fp-active">
            <RefreshCw size={18}/>
          </button>
        </div>
      </div>

      {/* Kanban */}
      {loading ? (
        <div className="flex justify-center py-12 sm:py-16 2xl:py-20" role="status" aria-label="Carregando pedidos">
          <Spinner className="h-8 w-8" />
        </div>
      ) : statusFilter === 'ativos' ? (
        <div
          className="
            flex max-md:flex-row max-md:overflow-x-auto max-md:overflow-y-hidden
            max-md:snap-x max-md:snap-mandatory max-md:touch-pan-x max-md:overscroll-x-contain
            max-md:gap-3 max-md:pb-3 max-md:pt-0.5 max-md:-mx-1 max-md:px-1
            max-md:scroll-pl-3 max-md:scroll-pr-3
            [-webkit-overflow-scrolling:touch]
            md:grid md:min-w-0 md:grid-cols-2 md:gap-3 md:overflow-visible md:scroll-pl-0 md:scroll-pr-0 lg:grid-cols-2 xl:grid-cols-4 xl:gap-4
          "
        >
          {COLUNAS.map(col => {
            const colPedidos = col==='Criado'
              ? pedidos.filter(p => p.status==='Criado'||p.status==='Pedido Recebido')
              : pedidos.filter(p => p.status===col);
            const cfg = STATUS_CFG[col];
            return (
              <div
                key={col}
                className={`${adminOpsSurfaceCardClass} overflow-hidden flex flex-col max-md:w-[min(85vw,20rem)] max-md:max-w-[85vw] max-md:flex-shrink-0 max-md:snap-center md:min-w-0 md:w-auto md:max-w-none`}
              >
                <div className="flex shrink-0 items-center gap-2 border-b border-zinc-100 px-3 py-2.5 dark:border-zinc-800 sm:px-4 lg:py-3" style={{ borderLeftWidth:3, borderLeftColor:cfg.color }}>
                  <span className="shrink-0" style={{ color:cfg.color }}>{cfg.icon}</span>
                  <span className="font-black text-sm text-fptext-primary truncate min-w-0">{cfg.label}</span>
                  <span className={`ml-auto shrink-0 text-xs font-black px-2.5 py-1 rounded-full tabular-nums ${cfg.toneClass}`}>{colPedidos.length}</span>
                </div>
                <div className="min-h-[100px] space-y-1.5 overflow-y-auto overflow-x-hidden overscroll-y-contain p-1.5 touch-pan-y max-md:max-h-[min(52vh,28rem)] max-h-[min(58vh,26rem)] md:max-h-[min(62vh,30rem)] lg:space-y-2 lg:p-2 xl:max-h-[65vh]">
                  {colPedidos.length===0 ? (
                    <div className={`mx-1 ${adminOpsDashedWellClass}`}>
                      <EmptyState
                        icon={Package}
                        title="Nenhum pedido"
                        description="Pedidos neste status aparecem aqui."
                        className="!py-8 sm:!py-10 px-2"
                      />
                    </div>
                  ) : colPedidos.map(p => (
                    <PedidoCard key={p.id} pedido={p} motoboys={motoboys} requiresMotoboy={hasMotoboyFeature}
                      onDetail={() => setSelectedPedido(p)}
                      onAvancar={(mbId) => cfg.next && mudarStatus(p.id, cfg.next!, mbId)}
                      onReimprimir={() => reimprimir(p.id)}
                      onImprimirProducao={() => imprimirProducao(p.id)}
                      cfg={cfg}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <>
        <div className={`hidden md:block ${adminOpsSurfaceCardClass} overflow-hidden -mx-1 sm:mx-0`}>
          <div className="overflow-x-auto overscroll-x-contain touch-pan-x [-webkit-overflow-scrolling:touch]">
          <table className="w-full text-sm min-w-[640px]">
            <thead><tr className="bg-zinc-50 dark:bg-zinc-800 border-b border-zinc-100 dark:border-zinc-700">
              <th className="text-left px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Pedido</th>
              <th className="text-left px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Cliente</th>
              <th className="text-left px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Status</th>
              <th className="text-left px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Pagamento</th>
              <th className="text-right px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Total</th>
              <th className="px-4 py-3"/>
            </tr></thead>
            <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800">
              {filtrados.map(p => {
                const cfg = STATUS_CFG[p.status] || STATUS_CFG['Pedido Recebido'];
                return (
                  <tr key={p.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800 cursor-pointer" onClick={() => setSelectedPedido(p)}>
                    <td className="px-4 py-3 font-mono font-bold text-zinc-800 dark:text-zinc-200">
                      <span className="inline-flex items-center gap-1">
                        #{p.order_number}
                        {deliveryPedidoTemCustomizacaoItens(p) && (
                          <span className="text-violet-500 dark:text-violet-400" title="Itens com observações ou adicionais">
                            ●
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{p.cliente_nome || '—'}</td>
                    <td className="px-4 py-3"><span className={`px-2.5 py-1 rounded-full text-[11px] font-black uppercase tracking-wide ${cfg.toneClass}`}>{cfg.label}</span></td>
                    <td className="px-4 py-3 text-fptext-muted text-xs">{PAGS[p.pagamento_tipo||'']?.label || p.pagamento_tipo}</td>
                    <td className="px-4 py-3 font-bold text-zinc-800 dark:text-zinc-200 text-right">{fmt(p.total_amount)}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1 justify-end">
                        <button type="button" onClick={(e) => { e.stopPropagation(); reimprimir(p.id); }}
                          className="p-2 min-h-[40px] min-w-[40px] inline-flex items-center justify-center hover:bg-emerald-100 dark:hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 rounded-lg" title="Cupom (cliente)">
                          <Printer size={14}/>
                        </button>
                        <button type="button" onClick={(e) => { e.stopPropagation(); imprimirProducao(p.id); }}
                          className="p-2 min-h-[40px] min-w-[40px] inline-flex items-center justify-center hover:bg-amber-100 dark:hover:bg-amber-500/20 text-amber-800 dark:text-amber-200 rounded-lg" title="Produção (cozinha)">
                          <ChefHat size={14}/>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
        <div className="md:hidden space-y-3 -mx-1 px-1 sm:mx-0 sm:px-0">
          {filtrados.map((p) => {
            const cfg = STATUS_CFG[p.status] || STATUS_CFG['Pedido Recebido'];
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedPedido(p)}
                className={`w-full ${adminOpsSurfaceCardClass} p-4 text-left transition-colors active:bg-zinc-50 active:bg-fp-active/80`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-black text-fptext-primary">
                      #{p.order_number}
                      {deliveryPedidoTemCustomizacaoItens(p) && (
                        <span className="ml-1 text-violet-500 dark:text-violet-400" title="Personalização">●</span>
                      )}
                    </p>
                    <p className="mt-1 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-300">{p.cliente_nome || '—'}</p>
                    <p className="mt-2 text-xs text-fptext-muted">{PAGS[p.pagamento_tipo || '']?.label || p.pagamento_tipo || '—'}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className={`inline-block px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wide ${cfg.toneClass}`}>{cfg.label}</span>
                    <p className="mt-2 text-base font-black tabular-nums text-fptext-primary">{fmt(p.total_amount)}</p>
                  </div>
                </div>
                <div className="mt-3 flex gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                  <span className="text-xs font-bold text-fptext-muted">Abrir detalhes</span>
                  <ChevronRight size={16} className="ml-auto text-zinc-400" />
                </div>
              </button>
            );
          })}
        </div>
        </>
      )}

      {/* Modal de detalhe do pedido */}
      <AnimatePresence>
        {selectedPedido && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm p-0 sm:items-center sm:p-6" onClick={() => setSelectedPedido(null)}>
            <motion.div onClick={e=>e.stopPropagation()}
              initial={{ scale:0.9, opacity:0 }} animate={{ scale:1, opacity:1 }} exit={{ scale:0.9, opacity:0 }}
              className="flex max-h-[min(92dvh,100svh)] w-full max-w-lg min-h-0 flex-col overflow-hidden rounded-t-2xl border border-fp-border bg-fp-card shadow-2xl sm:rounded-2xl">
              <div className="shrink-0 border-b border-fp-border-soft px-5 pb-4 pt-5 sm:px-6 sm:pb-4 sm:pt-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <h3 className="text-lg font-black text-fptext-primary">Pedido #{selectedPedido.order_number}</h3>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <button type="button" onClick={() => reimprimir(selectedPedido.id)}
                    className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-100 px-4 py-2.5 text-sm font-bold text-emerald-700 transition-all hover:bg-emerald-200 dark:bg-emerald-500/20 dark:text-emerald-300 dark:hover:bg-emerald-500/30 sm:flex-initial sm:px-3 sm:py-2 sm:text-xs">
                    <Printer size={14}/> Cupom
                  </button>
                  <button type="button" onClick={() => imprimirProducao(selectedPedido.id)}
                    className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl bg-amber-100 px-4 py-2.5 text-sm font-bold text-amber-900 transition-all hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-100 dark:hover:bg-amber-500/30 sm:flex-initial sm:px-3 sm:py-2 sm:text-xs">
                    <ChefHat size={14}/> Produção
                  </button>
                  <button type="button" onClick={() => setSelectedPedido(null)} className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl p-2 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800" aria-label="Fechar">✕</button>
                </div>
              </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 sm:px-6 sm:pb-6">
              {(() => {
                const cfg = STATUS_CFG[selectedPedido.status] || STATUS_CFG['Pedido Recebido'];
                return (
                  <div className={`flex items-center gap-2 px-3 py-2 rounded-xl mb-4 border ${cfg.toneClass}`}>
                    <span style={{ color:cfg.color }}>{cfg.icon}</span>
                    <span className="font-black text-sm" style={{ color:cfg.color }}>{cfg.label}</span>
                    <span className="text-xs text-fptext-muted ml-auto">{fmtHour(selectedPedido.created_at)}</span>
                  </div>
                );
              })()}

              {(selectedPedido.automation_auto_delivery_accept ||
                selectedPedido.automation_kitchen_ok ||
                selectedPedido.automation_kitchen_failed) && (
                <div className="mb-4 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60 px-3 py-2 space-y-1">
                  <p className="text-[10px] font-black uppercase tracking-wider text-fptext-muted">Automação</p>
                  <ul className="text-[11px] text-zinc-600 dark:text-zinc-300 space-y-0.5">
                    {selectedPedido.automation_auto_delivery_accept && (
                      <li>Aceite automático pelo cardápio online (Pedido Recebido).</li>
                    )}
                    {selectedPedido.automation_kitchen_ok && <li>Produção impressa automaticamente ao menos uma vez.</li>}
                    {selectedPedido.automation_kitchen_failed && (
                      <li className="text-amber-800 dark:text-amber-200">
                        Registro de falha na auto-impressão — use Produção ou revise a impressora de cozinha.
                      </li>
                    )}
                  </ul>
                </div>
              )}

              <div className="space-y-3 text-sm">
                <div className="bg-zinc-50 dark:bg-zinc-800 rounded-xl p-3 space-y-1">
                  <p className="text-[10px] font-black text-fptext-muted uppercase tracking-wider">Cliente</p>
                  <p className="font-bold text-fptext-primary">{selectedPedido.cliente_nome || '—'}</p>
                  {selectedPedido.cliente_tel && <p className="text-fptext-muted flex items-center gap-1"><Phone size={12}/>{selectedPedido.cliente_tel}</p>}
                  {selectedPedido.endereco && <p className="text-fptext-muted flex items-center gap-1"><MapPin size={12}/>{selectedPedido.endereco}</p>}
                  {selectedPedido.endereco && (
                    <div className="flex gap-2 mt-2 flex-wrap">
                      <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(selectedPedido.endereco)}`}
                        target="_blank" rel="noreferrer"
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-100 dark:bg-blue-500/20 border border-blue-200 dark:border-blue-500/30 text-blue-700 dark:text-blue-300 rounded-lg text-xs font-bold hover:bg-blue-200 dark:hover:bg-blue-500/30 transition-all">
                        <Navigation size={12}/> Ver no Maps
                      </a>
                      {selectedPedido.cliente_tel && (
                        <a href={`https://wa.me/${selectedPedido.cliente_tel.replace(/\D/g,'')}?text=${encodeURIComponent(`🛵 *Seu pedido #${selectedPedido.order_number} saiu para entrega!*\n\n📍 ${selectedPedido.endereco}\n💰 Total: ${fmt(selectedPedido.total_amount)}\n\nPrevisão: em breve ✅`)}`}
                          target="_blank" rel="noreferrer"
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-green-100 dark:bg-green-500/20 border border-green-200 dark:border-green-500/30 text-green-700 dark:text-green-300 rounded-lg text-xs font-bold hover:bg-green-200 dark:hover:bg-green-500/30 transition-all">
                          <MessageCircle size={12}/> Avisar cliente
                        </a>
                      )}
                    </div>
                  )}
                </div>

                {(deliveryPedidoTemItensDetalhe(selectedPedido) || selectedPedido.resumo_itens) && (
                  <div className="bg-zinc-50 dark:bg-zinc-800 rounded-xl p-3">
                    <p className="text-[10px] font-black text-fptext-muted uppercase tracking-wider mb-2">Itens</p>
                    {deliveryPedidoTemItensDetalhe(selectedPedido) ? (
                      <ul className="space-y-3">
                        {selectedPedido.itens!.map((it, idx) => {
                          const ext = it as typeof it & { item_display_details?: string[] };
                          const detail = getOrderItemDetailText(it);
                          const lines =
                            Array.isArray(ext.item_display_details) && ext.item_display_details.length > 0
                              ? ext.item_display_details
                              : splitOrderItemDetailLines(detail);
                          const unit = Number(it.price_at_time || 0);
                          const lineTotal = unit * Number(it.quantity);
                          return (
                            <li
                              key={`${it.product_id}-${idx}`}
                              className="border-b border-zinc-200 dark:border-zinc-700 pb-3 last:border-0 last:pb-0"
                            >
                              <div className="flex justify-between gap-2 text-sm">
                                <span className="font-bold text-fptext-primary min-w-0">
                                  {it.product_name} ×{it.quantity}
                                </span>
                                <span className="font-bold text-fptext-primary tabular-nums shrink-0">
                                  {fmt(lineTotal)}
                                </span>
                              </div>
                              {lines.length > 0 ? (
                                <>
                                  <ul className="mt-1.5 ml-1 space-y-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                                    {lines.map((line, j) => (
                                      <li key={j} className="flex gap-1.5">
                                        <span className="text-zinc-400 shrink-0" aria-hidden>–</span>
                                        <span className="min-w-0">{line}</span>
                                      </li>
                                    ))}
                                  </ul>
                                  <p className="mt-1 text-[10px] leading-snug text-fptext-muted">
                                    Unit. {fmt(unit)} (congelado); à direita, total da linha.
                                  </p>
                                </>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="text-zinc-700 dark:text-zinc-300">{selectedPedido.resumo_itens}</p>
                    )}
                    {selectedPedido.observation && (
                      <div className="mt-2 space-y-0.5">
                        {selectedPedido.observation.split('\n').filter((l:string) => !l.startsWith('🛵')).map((l:string,i:number) => (
                          <p key={i} className="text-fptext-muted text-xs">{l}</p>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="bg-zinc-50 dark:bg-zinc-800 rounded-xl p-3 flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-black text-fptext-muted uppercase tracking-wider mb-0.5">Pagamento</p>
                    <p className="font-bold text-fptext-primary">{PAGS[selectedPedido.pagamento_tipo||'']?.label || selectedPedido.pagamento_tipo}</p>
                    {selectedPedido.taxa_entrega > 0 && <p className="text-xs text-zinc-400">Taxa: {fmt(selectedPedido.taxa_entrega)}</p>}
                    {selectedPedido.observation && (() => {
                      const m = selectedPedido.observation.match(/Troco para R\$\s*([\d,\.]+)/i);
                      return m ? <p className="text-xs font-bold text-amber-600 mt-0.5">💰 Troco p/ R${m[1]}</p> : null;
                    })()}
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-black text-fptext-primary">{fmt(selectedPedido.total_amount)}</p>
                    <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${selectedPedido.pagamento_status==='pago'?'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300':'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300'}`}>
                      {selectedPedido.pagamento_status==='pago'?'✓ Pago':'Aguardando'}
                    </span>
                  </div>
                </div>

                {selectedPedidoSnapshot && (
                  <div className="bg-zinc-50 dark:bg-zinc-800 rounded-xl p-3 space-y-1.5">
                    <p className="text-[10px] font-black text-zinc-400 uppercase tracking-wider">Resumo comercial</p>
                    <p className="text-xs text-zinc-500">
                      Modelo atual: bairro com taxa fixa
                      {selectedPedidoSnapshot.zona_entrega?.nome
                        ? ` · ${selectedPedidoSnapshot.zona_entrega.nome}`
                        : selectedPedidoSnapshot.bairro_entrega
                          ? ` · ${selectedPedidoSnapshot.bairro_entrega}`
                          : ''}
                    </p>
                    {Number(selectedPedidoSnapshot.desconto_pix || 0) > 0 && (
                      <div className="flex items-center justify-between text-xs text-emerald-600 font-semibold">
                        <span>Desconto Pix</span>
                        <span>-{fmt(Number(selectedPedidoSnapshot.desconto_pix || 0))}</span>
                      </div>
                    )}
                    {Number(selectedPedidoSnapshot.desconto_cupom || 0) > 0 && (
                      <div className="flex items-center justify-between text-xs text-emerald-600 font-semibold">
                        <span>Cupom</span>
                        <span>-{fmt(Number(selectedPedidoSnapshot.desconto_cupom || 0))}</span>
                      </div>
                    )}
                    {Number(selectedPedidoSnapshot.desconto_primeiro_cliente || 0) > 0 && (
                      <div className="flex items-center justify-between text-xs text-amber-600 font-semibold">
                        <span>Primeira compra</span>
                        <span>-{fmt(Number(selectedPedidoSnapshot.desconto_primeiro_cliente || 0))}</span>
                      </div>
                    )}
                    {selectedPedidoSnapshot.primeiro_cliente?.mensagem && (
                      <p className="text-[11px] text-zinc-500">{selectedPedidoSnapshot.primeiro_cliente.mensagem}</p>
                    )}
                  </div>
                )}

                {/* Mapa para motoboy */}
                {selectedPedido.endereco && (() => {
                  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(selectedPedido.endereco)}`;
                  const pagInfo = selectedPedido.pagamento_status==='pago' ? '✅ JÁ PAGO'
                    : selectedPedido.pagamento_tipo==='dinheiro' ? `💵 COBRAR R$ ${selectedPedido.total_amount.toFixed(2).replace('.',',')} em dinheiro`
                    : `💳 COBRAR R$ ${selectedPedido.total_amount.toFixed(2).replace('.',',')} no cartão`;
                  const msg = `🛵 *ENTREGA #${selectedPedido.order_number}*\n\n👤 ${selectedPedido.cliente_nome}\n📱 ${selectedPedido.cliente_tel||'—'}\n\n📍 *Endereço:*\n${selectedPedido.endereco}\n🗺️ ${mapsUrl}\n\n${pagInfo}\n\n${formatDeliveryItensResumoWhatsApp(selectedPedido)}`;
                  return (
                    <div className="bg-orange-50 border border-orange-200 rounded-xl p-3">
                      <p className="text-[10px] font-black text-orange-600 uppercase tracking-wider mb-2">📦 Enviar rota para motoboy</p>
                      <a href={`https://wa.me/?text=${encodeURIComponent(msg)}`} target="_blank" rel="noreferrer"
                        className="flex items-center justify-center gap-2 w-full py-2.5 bg-green-500 hover:bg-green-600 text-white rounded-xl text-sm font-bold transition-all">
                        <MessageCircle size={14}/> Enviar pelo WhatsApp
                      </a>
                    </div>
                  );
                })()}

                {selectedPedido.pagamento_tipo==='pix' && selectedPedido.pagamento_status!=='pago' && (
                  <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-center">
                    <p className="text-xs font-bold text-blue-700 mb-2">Pagamento via Pix pendente</p>
                    <button onClick={() => marcarPago(selectedPedido.id)}
                      className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-700 transition-colors">
                      ✓ Confirmar Pagamento Pix
                    </button>
                  </div>
                )}

                {/* Link de rastreamento para o cliente */}
                {(() => {
                  try {
                    const slug = JSON.parse(atob(token.split('.')[1])).username;
                    const url  = `${window.location.origin}/delivery/${slug}/pedido/${selectedPedido.id}`;
                    return (
                      <div className="bg-zinc-50 rounded-xl p-3">
                        <p className="text-[10px] font-black text-zinc-400 uppercase tracking-wider mb-1">🔗 Link de rastreamento</p>
                        <div className="flex items-center gap-2">
                          <input readOnly value={url}
                            className="flex-1 text-xs text-zinc-600 dark:text-zinc-400 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2 font-mono"/>
                          <button onClick={() => { navigator.clipboard.writeText(url); }}
                            className="p-2 bg-zinc-100 dark:bg-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-600 rounded-lg text-fptext-muted transition-colors flex-shrink-0" title="Copiar">
                            <Check size={13}/>
                          </button>
                        </div>
                      </div>
                    );
                  } catch { return null; }
                })()}

                {/* Ações de status */}
                {(() => {
                  const cfg = STATUS_CFG[selectedPedido.status] || STATUS_CFG['Pedido Recebido'];
                  if (!cfg.next) return null;
                  return (
                    <button onClick={() => { mudarStatus(selectedPedido.id, cfg.next!); }}
                      className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm transition-all hover:opacity-90 active:scale-95"
                      style={{ background:cfg.color, color:'#fff' }}>
                      <ChevronRight size={16}/> {deliveryNextPrimaryLabel(cfg.next!)} — {deliveryNextActionTitle(cfg.next!)}
                    </button>
                  );
                })()}
              </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── PedidoCard ───────────────────────────────────────────────────────────────
function PedidoCard({ pedido, motoboys, requiresMotoboy = true, onDetail, onAvancar, onReimprimir, onImprimirProducao, cfg }: {
  key?: React.Key;
  pedido: Pedido; motoboys: Motoboy[];
  requiresMotoboy?: boolean;
  onDetail: () => void; onAvancar: (mbId?: number) => void | Promise<void>;
  onReimprimir: () => void | Promise<void>;
  onImprimirProducao: () => void | Promise<void>;
  cfg: any;
}) {
  const [selectedMotoboy, setSelectedMotoboy] = useState<number | ''>('');
  const elapsed = Math.max(0, Math.floor((Date.now() - new Date(pedido.created_at).getTime()) / 60000));
  return (
    <div
      className={`${adminOpsSurfaceCardClass} cursor-pointer p-2.5 transition-all hover:border-zinc-300 hover:shadow-md dark:hover:border-zinc-700 max-md:active:bg-zinc-50/80 dark:max-md:active:bg-zinc-800/40`}
      onClick={onDetail}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="min-w-0 flex-1 pr-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="font-black text-fptext-primary text-sm leading-tight">#{pedido.order_number}</p>
            {deliveryPedidoTemCustomizacaoItens(pedido) && (
              <StatusChip
                size="sm"
                icon={ListTree}
                toneClassName="border-violet-200 dark:border-violet-500/40 bg-violet-50 dark:bg-violet-500/15 text-violet-800 dark:text-violet-200"
                title="Itens com observações ou adicionais"
              >
                Pers.
              </StatusChip>
            )}
            <OrderAutomationBadges order={pedido} compact />
          </div>
          {pedido.cliente_nome && <p className="text-xs text-zinc-600 dark:text-zinc-300 mt-0.5 truncate">{pedido.cliente_nome}</p>}
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <span className={`text-[11px] font-bold tabular-nums px-1 ${elapsed>=20?'text-red-500':'text-zinc-400 dark:text-zinc-500'}`}>{elapsed===0?'agora':`${elapsed}min`}</span>
          <button type="button" onClick={(e) => { e.stopPropagation(); onReimprimir(); }} className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg text-emerald-600 hover:bg-emerald-100 active:scale-95 dark:text-emerald-400 dark:hover:bg-emerald-500/20" title="Cupom (cliente)"><Printer size={15}/></button>
          <button type="button" onClick={(e) => { e.stopPropagation(); onImprimirProducao(); }} className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg text-amber-800 hover:bg-amber-100 active:scale-95 dark:text-amber-200 dark:hover:bg-amber-500/20" title="Produção (cozinha)"><ChefHat size={15}/></button>
          <ChevronRight size={16} className="text-zinc-300 dark:text-zinc-600 shrink-0" aria-hidden />
        </div>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-snug truncate mb-1.5">
        {pedido.resumo_itens || '—'}
      </p>
      <div className="flex items-center justify-between gap-2">
        <span className="font-black text-sm text-zinc-800 dark:text-zinc-200 tabular-nums">{fmt(pedido.total_amount)}</span>
        <StatusChip
          size="sm"
          variant={pedido.pagamento_status === 'pago' ? 'success' : 'warning'}
          className="shrink-0 tabular-nums"
        >
          {pedido.pagamento_status === 'pago' ? 'Pago' : 'Aguardando'}
        </StatusChip>
      </div>
      {cfg.next && (
        <div className="mt-2 space-y-1.5" onClick={(e) => e.stopPropagation()}>
          {cfg.next==='Saiu para Entrega' && requiresMotoboy && (
            <select value={selectedMotoboy} onChange={e=>setSelectedMotoboy(e.target.value?Number(e.target.value):'')}
              className={`w-full text-xs px-2.5 py-2 min-h-[38px] border rounded-lg bg-white dark:bg-zinc-800 transition-all ${!selectedMotoboy?'border-amber-400 dark:border-amber-500/50 bg-amber-50 dark:bg-amber-500/10':'border-zinc-200 dark:border-zinc-700'}`}>
              <option value="">⚠️ Selecione o motoboy...</option>
              {motoboys.length===0
                ? <option disabled>Nenhum motoboy cadastrado</option>
                : motoboys.map(m=><option key={m.id} value={m.id}>{m.nome}</option>)
              }
            </select>
          )}
          {(() => {
            const precisaMotoboy = cfg.next==='Saiu para Entrega' && requiresMotoboy;
            const bloqueado = precisaMotoboy && (!selectedMotoboy || motoboys.length===0);
            return (
              <button
                type="button"
                onClick={() => { if (!bloqueado) onAvancar(selectedMotoboy||undefined); }}
                disabled={bloqueado}
                title={bloqueado ? 'Selecione um motoboy antes de despachar' : undefined}
                className={`w-full flex items-center justify-center gap-1.5 py-2 min-h-[38px] rounded-lg text-xs font-bold transition-all ${
                  bloqueado
                    ? 'bg-zinc-100 dark:bg-zinc-800 text-fptext-muted cursor-not-allowed border border-zinc-200 dark:border-zinc-700'
                    : 'hover:opacity-90 active:scale-[0.98]'
                }`}
                style={!bloqueado ? { background:cfg.color, color:'#fff' } : {}}>
                <ChevronRight size={14}/>
                {bloqueado
                  ? 'Selecione o motoboy'
                  : deliveryNextPrimaryLabel(cfg.next!)}
              </button>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ─── DCard ────────────────────────────────────────────────────────────────────
function DCard({ label, value, color, icon }: { label:string; value:string; color:string; icon:React.ReactNode }) {
  const C: Record<string,{bg:string;text:string}> = {
    blue:{'bg':'bg-blue-100 dark:bg-blue-500/20','text':'text-blue-700 dark:text-blue-300'}, emerald:{'bg':'bg-emerald-100 dark:bg-emerald-500/20','text':'text-emerald-700 dark:text-emerald-300'},
    amber:{'bg':'bg-amber-100 dark:bg-amber-500/20','text':'text-amber-700 dark:text-amber-300'}, orange:{'bg':'bg-orange-100 dark:bg-orange-500/20','text':'text-orange-700 dark:text-orange-300'},
    purple:{'bg':'bg-purple-100 dark:bg-purple-500/20','text':'text-purple-700 dark:text-purple-300'}, zinc:{'bg':'bg-zinc-200 dark:bg-zinc-700','text':'text-zinc-700 dark:text-zinc-300'},
  };
  const c = C[color]||C.zinc;
  return (
    <div className={`${adminOpsSurfaceCardClass} min-w-0 p-2.5 transition-shadow hover:shadow-md sm:p-3.5`}>
      <div className={`mb-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl sm:mb-2 sm:h-10 sm:w-10 ${c.bg} ${c.text}`}>{icon}</div>
      <p className="text-xl sm:text-2xl font-black text-fptext-primary leading-none tabular-nums break-words">{value}</p>
      <p className="text-[10px] sm:text-[11px] text-fptext-muted mt-1 sm:mt-1.5 font-bold uppercase tracking-wide leading-tight">{label}</p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ABA CLIENTES
// ═══════════════════════════════════════════════════════════════════════════════
export function TabClientes({ token }: { token: string }) {
  const [clientes, setClientes]   = useState<DeliveryCustomer[]>([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [selected, setSelected]   = useState<DeliveryCustomer|null>(null);
  const [pedidos, setPedidos]     = useState<CustomerOrderHistory[]>([]);
  const [quickFilter, setQuickFilter] = useState<
    | 'all'
    | 'comprou_hoje'
    | 'd1_3'
    | 'd4_7'
    | 'd8_15'
    | 'd15_plus'
    | 'sem_compra'
    | 'recorrentes'
    | 'em_risco'
    | 'mais_pedidos'
    | 'maior_gasto'
    | 'wa_never_sent'
    | 'wa_sent_today'
    | 'wa_sent_7d'
    | 'wa_failed'
    | 'wa_ready'
    | 'inadimplentes'
  >('all');
  const [sortBy, setSortBy] = useState<'recent_purchase' | 'long_without_purchase' | 'most_orders' | 'highest_spend'>('recent_purchase');
  const [waFiltersExpanded, setWaFiltersExpanded] = useState(false);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;

  // Se um filtro WA estiver ativo, mantém o grupo expandido
  useEffect(() => {
    if (['wa_never_sent', 'wa_sent_today', 'wa_sent_7d', 'wa_failed', 'wa_ready'].includes(quickFilter)) {
      setWaFiltersExpanded(true);
    }
  }, [quickFilter]);

  // Volta pra página 1 quando filtro ou busca muda
  useEffect(() => { setPage(1); }, [quickFilter, sortBy, search]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [sendingWhatsapp, setSendingWhatsapp] = useState(false);
  const [sendWithCardapioImage, setSendWithCardapioImage] = useState(false);
  const [cardapioReactivationImageUrl, setCardapioReactivationImageUrl] = useState<string | null>(null);
  const [sendFeedback, setSendFeedback] = useState<{
    tone: 'success' | 'error';
    sent: number;
    failed: number;
    ignored: number;
    message: string;
  } | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const hdrs = { Authorization: `Bearer ${token}` };

  const fetchClientes = useCallback(async () => {
    setLoading(true);
    try {
      const q = search ? `?search=${encodeURIComponent(search)}` : '';
      const res = await fetch(`/api/delivery/clientes${q}`, { headers: hdrs });
      if (res.ok) {
        const d = await res.json();
        const nextClientes = Array.isArray(d) ? d : [];
        setClientes(nextClientes);
        setSelectedIds((prev) => {
          const existing = new Set(nextClientes.map((c: DeliveryCustomer) => Number(c.id)));
          return new Set([...prev].filter((id) => existing.has(id)));
        });
      }
    } catch {}
    setLoading(false);
  }, [token, search]);

  const fetchPedidos = async (id: number) => {
    setPedidos([]);
    try {
      const res = await fetch(`/api/delivery/clientes/${id}/pedidos`, { headers: hdrs });
      if (res.ok) {
        const d = await res.json();
        setPedidos(Array.isArray(d) ? d : []);
      }
    } catch {}
  };

  useEffect(() => { fetchClientes(); }, [fetchClientes]);
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/delivery/config', { headers: hdrs });
        if (!res.ok) return;
        const payload = await res.json().catch(() => ({}));
        const imageUrl = String(payload?.cardapio_reactivation_image_url || '').trim();
        setCardapioReactivationImageUrl(imageUrl || null);
      } catch {}
    })();
  }, [token]);

  const ativos = clientes.filter((c) => c.status_atividade === 'ativo').length;
  const emRisco = clientes.filter((c) => c.status_atividade === 'em_risco').length;
  const inativos = clientes.filter((c) => c.status_atividade === 'inativo').length;
  const semCompra = clientes.filter((c) => c.status_atividade === 'sem_compra').length;
  const recorrentes = clientes.filter((c) => c.cliente_recorrente).length;
  const dateToTimestamp = (value?: string | null) => {
    if (!value) return 0;
    const date = parseDateValue(value);
    return date ? date.getTime() : 0;
  };
  const matchesQuickFilter = useCallback((customer: DeliveryCustomer) => {
    const dias = customer.dias_sem_comprar;
    const totalPedidos = Number(customer.total_pedidos || 0);
    const totalGasto = Number(customer.total_gasto || 0);
    switch (quickFilter) {
      case 'comprou_hoje':
        return dias === 0;
      case 'd1_3':
        return dias !== null && dias !== undefined && dias >= 1 && dias <= 3;
      case 'd4_7':
        return dias !== null && dias !== undefined && dias >= 4 && dias <= 7;
      case 'd8_15':
        return dias !== null && dias !== undefined && dias >= 8 && dias <= 15;
      case 'd15_plus':
        return dias !== null && dias !== undefined && dias >= 15;
      case 'sem_compra':
        return customer.status_atividade === 'sem_compra' || customer.sem_historico || dias === null || dias === undefined;
      case 'recorrentes':
        return Boolean(customer.cliente_recorrente);
      case 'em_risco':
        return customer.status_atividade === 'em_risco';
      case 'mais_pedidos':
        return totalPedidos > 0;
      case 'maior_gasto':
        return totalGasto > 0;
      case 'wa_never_sent':
        return getReactivationStatusMeta(customer).key === 'never';
      case 'wa_sent_today':
        return getReactivationStatusMeta(customer).key === 'sent_today';
      case 'wa_sent_7d':
        return wasReactivationSentInLastDays(customer, 7);
      case 'wa_failed':
        return getReactivationStatusMeta(customer).key === 'failed';
      case 'wa_ready':
        return isReadyForReactivation(customer);
      case 'inadimplentes':
        return Boolean(customer.tem_pix_pendente);
      case 'all':
      default:
        return true;
    }
  }, [quickFilter]);
  const sortedFilteredClientes = useMemo(() => {
    const filtered = clientes.filter(matchesQuickFilter);
    return [...filtered].sort((a, b) => {
      if (sortBy === 'recent_purchase') {
        const diff = dateToTimestamp(b.ultima_compra_at || b.ultimo_pedido) - dateToTimestamp(a.ultima_compra_at || a.ultimo_pedido);
        if (diff !== 0) return diff;
      }
      if (sortBy === 'long_without_purchase') {
        const aDias = a.dias_sem_comprar ?? -1;
        const bDias = b.dias_sem_comprar ?? -1;
        if (bDias !== aDias) return bDias - aDias;
      }
      if (sortBy === 'most_orders' || quickFilter === 'mais_pedidos') {
        const diff = Number(b.total_pedidos || 0) - Number(a.total_pedidos || 0);
        if (diff !== 0) return diff;
      }
      if (sortBy === 'highest_spend' || quickFilter === 'maior_gasto') {
        const diff = Number(b.total_gasto || 0) - Number(a.total_gasto || 0);
        if (diff !== 0) return diff;
      }
      return String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR');
    });
  }, [clientes, matchesQuickFilter, sortBy, quickFilter]);
  const selectedCount = selectedIds.size;
  const totalPages = Math.max(1, Math.ceil(sortedFilteredClientes.length / PAGE_SIZE));
  const pagedClientes = sortedFilteredClientes.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const allVisibleSelected = pagedClientes.length > 0 && pagedClientes.every((c) => selectedIds.has(c.id));
  const someVisibleSelected = pagedClientes.some((c) => selectedIds.has(c.id)) && !allVisibleSelected;
  const selectedSentTodayCount = clientes.filter((customer) => selectedIds.has(customer.id) && getReactivationStatusMeta(customer).key === 'sent_today').length;
  const waSentTodayCount = clientes.filter((customer) => getReactivationStatusMeta(customer).key === 'sent_today').length;
  const waNeverSentCount = clientes.filter((customer) => getReactivationStatusMeta(customer).key === 'never').length;
  const waFailedCount = clientes.filter((customer) => getReactivationStatusMeta(customer).key === 'failed').length;
  const waReadyCount = clientes.filter(isReadyForReactivation).length;
  const inadimplenteCount = clientes.filter((c) => Boolean(c.tem_pix_pendente)).length;
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someVisibleSelected;
    }
  }, [someVisibleSelected]);
  const toggleSelectCustomer = (customerId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(customerId)) next.delete(customerId);
      else next.add(customerId);
      return next;
    });
  };
  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        pagedClientes.forEach((customer) => next.delete(customer.id));
      } else {
        pagedClientes.forEach((customer) => next.add(customer.id));
      }
      return next;
    });
  };
  const sendReactivationMessages = async () => {
    if (selectedIds.size === 0 || sendingWhatsapp) return;
    const confirmed = window.confirm(
      `Enviar mensagem de reativacao por WhatsApp para ${selectedIds.size} cliente(s)?` +
        (selectedSentTodayCount > 0 ? `\nAtencao: ${selectedSentTodayCount} selecionado(s) ja receberam reativacao hoje.` : '') +
        (sendWithCardapioImage && cardapioReactivationImageUrl ? '\nA imagem de cardapio sera enviada junto.' : '')
    );
    if (!confirmed) return;
    setSendFeedback(null);
    setSendingWhatsapp(true);
    try {
      const res = await fetch('/api/delivery/clientes/reativacao/whatsapp', {
        method: 'POST',
        headers: {
          ...hdrs,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          customer_ids: [...selectedIds],
          send_with_menu_image: sendWithCardapioImage,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload?.success) {
        setSendFeedback({
          tone: 'error',
          sent: 0,
          failed: 0,
          ignored: 0,
          message: payload?.error || 'Nao foi possivel enviar as mensagens',
        });
        return;
      }
      const summary = payload?.summary || {};
      setSendFeedback({
        tone: Number(summary.failed || 0) > 0 ? 'error' : 'success',
        sent: Number(summary.sent || 0),
        failed: Number(summary.failed || 0),
        ignored: Number(summary.ignored || 0),
        message: 'Disparo concluido',
      });
      fetchClientes();
    } catch {
      setSendFeedback({
        tone: 'error',
        sent: 0,
        failed: 0,
        ignored: 0,
        message: 'Erro ao enviar mensagens de reativacao',
      });
    } finally {
      setSendingWhatsapp(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="h-full min-h-0 overflow-y-auto bg-fp-secondary">
      <div className="mx-auto max-w-7xl min-w-0 space-y-4 p-3 sm:space-y-5 sm:p-4 lg:p-6">
      <ScreenHeader
        titleAs="h1"
        titleClassName="flex items-center gap-2"
        title={<><Users size={22} className="shrink-0" /> Clientes</>}
        subtitle="Histórico de clientes, filtros de reengajamento e disparo WhatsApp"
      />
      <div className="flex flex-wrap gap-3 items-start">
        <div className="relative w-full flex-1 min-w-0 sm:min-w-[240px] sm:max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none"/>
          <input value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>e.key==='Enter'&&fetchClientes()}
            placeholder="Buscar por nome, telefone ou observacoes..."
            className="w-full min-h-[44px] pl-9 pr-4 py-2.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 text-fptext-primary"/>
        </div>
        <button onClick={fetchClientes} className="w-full min-h-[44px] px-4 py-2.5 bg-zinc-900 text-white rounded-xl text-sm font-bold hover:bg-zinc-700 transition-colors sm:w-auto">Buscar</button>
        <button
          type="button"
          onClick={sendReactivationMessages}
          disabled={selectedCount === 0 || sendingWhatsapp}
          aria-busy={sendingWhatsapp}
          className={`w-full min-h-[44px] px-4 py-2.5 rounded-xl text-sm font-bold transition-colors sm:w-auto ${
            selectedCount === 0 || sendingWhatsapp
              ? 'bg-zinc-100 text-zinc-400 border border-zinc-200 cursor-not-allowed dark:bg-zinc-800 dark:text-zinc-500 dark:border-zinc-700'
              : 'bg-emerald-600 text-white hover:bg-emerald-500'
          }`}
        >
          {sendingWhatsapp ? 'Enviando...' : 'Enviar no WhatsApp'}
        </button>
        <label className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-xs font-semibold text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={sendWithCardapioImage}
            onChange={(e) => setSendWithCardapioImage(e.target.checked)}
            className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
          />
          Enviar com imagem do cardapio
        </label>
      </div>
      {sendWithCardapioImage && !cardapioReactivationImageUrl ? (
        <p className="text-xs text-zinc-500">Nenhuma imagem de divulgação cadastrada no Cardápio. O envio seguirá só com mensagem.</p>
      ) : null}

      {sendFeedback && (
        <div
          className={`rounded-xl border px-3 py-2.5 text-sm ${
            sendFeedback.tone === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300'
              : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
          }`}
          role="status"
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-bold">{sendFeedback.message}</span>
            <span>Enviados: <strong>{sendFeedback.sent}</strong></span>
            <span>Ignorados: <strong>{sendFeedback.ignored}</strong></span>
            <span>Falhados: <strong>{sendFeedback.failed}</strong></span>
          </div>
        </div>
      )}

      <div className={`${adminOpsSurfaceCardClass} p-3 space-y-3`}>
        {/* Filtros principais */}
        <div className="flex flex-wrap items-center gap-2">
          {[
            ['all', 'Todos'],
            ['comprou_hoje', 'Comprou hoje'],
            ['d1_3', '1 a 3 dias'],
            ['d4_7', '4 a 7 dias'],
            ['d8_15', '8 a 15 dias'],
            ['d15_plus', '15+ dias'],
            ['sem_compra', 'Sem compra'],
            ['recorrentes', 'Recorrentes'],
            ['em_risco', 'Em risco'],
            ['mais_pedidos', 'Mais pedidos'],
            ['maior_gasto', 'Maior gasto'],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setQuickFilter(key as typeof quickFilter)}
              className={`min-h-[36px] px-3 rounded-full text-xs font-bold border transition-colors ${
                quickFilter === key
                  ? 'bg-zinc-900 text-white border-zinc-900 dark:bg-zinc-700 dark:border-zinc-700'
                  : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700 dark:hover:bg-zinc-700'
              }`}
            >
              {label}
            </button>
          ))}
          {/* Filtro inadimplentes — destaque vermelho separado */}
          <button
            type="button"
            onClick={() => setQuickFilter('inadimplentes')}
            className={`min-h-[36px] px-3 rounded-full text-xs font-bold border transition-colors ${
              quickFilter === 'inadimplentes'
                ? 'bg-red-600 text-white border-red-600'
                : inadimplenteCount > 0
                ? 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30 dark:hover:bg-red-500/20'
                : 'bg-white text-zinc-400 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-500 dark:border-zinc-700'
            }`}
          >
            {inadimplenteCount > 0 ? `⚠ Inadimplentes (${inadimplenteCount})` : 'Inadimplentes'}
          </button>
        </div>

        {/* Filtros WhatsApp — grupo recolhível */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setWaFiltersExpanded((v) => !v)}
            className={`inline-flex items-center gap-1.5 min-h-[32px] px-3 rounded-full text-xs font-bold border transition-colors ${
              ['wa_never_sent', 'wa_sent_today', 'wa_sent_7d', 'wa_failed', 'wa_ready'].includes(quickFilter)
                ? 'bg-emerald-600 text-white border-emerald-600'
                : 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30 dark:hover:bg-emerald-500/20'
            }`}
          >
            <span>📲 WhatsApp</span>
            <span className="opacity-70">{waFiltersExpanded ? '▲' : '▼'}</span>
          </button>
          {waFiltersExpanded && (
            <>
              {[
                ['wa_never_sent', 'Nunca enviados'],
                ['wa_sent_today', 'Enviados hoje'],
                ['wa_sent_7d', 'Enviados 7 dias'],
                ['wa_failed', 'Falharam'],
                ['wa_ready', 'Prontos reativacao'],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setQuickFilter(key as typeof quickFilter)}
                  className={`min-h-[32px] px-3 rounded-full text-xs font-bold border transition-colors ${
                    quickFilter === key
                      ? 'bg-emerald-700 text-white border-emerald-700 dark:bg-emerald-600 dark:border-emerald-600'
                      : 'bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50 dark:bg-zinc-800 dark:text-emerald-300 dark:border-emerald-700/50 dark:hover:bg-zinc-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs font-bold text-zinc-500">Ordenar por</label>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            className="min-h-[36px] px-3 py-1.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg text-xs font-semibold text-fptext-primary focus:outline-none"
          >
            <option value="recent_purchase">Ultima compra mais recente</option>
            <option value="long_without_purchase">Ha mais tempo sem comprar</option>
            <option value="most_orders">Mais pedidos</option>
            <option value="highest_spend">Maior gasto</option>
          </select>

          {/* Paginação no topo */}
          {sortedFilteredClientes.length > PAGE_SIZE && (
            <div className="flex items-center gap-1.5 ml-auto">
              <span className="text-xs text-zinc-500 mr-1">
                <strong className="text-zinc-700 dark:text-zinc-300">{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, sortedFilteredClientes.length)}</strong>
                {' '}de{' '}
                <strong className="text-zinc-700 dark:text-zinc-300">{sortedFilteredClientes.length}</strong>
              </span>
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="min-h-[32px] min-w-[32px] flex items-center justify-center rounded-lg border border-zinc-200 bg-white text-sm font-bold text-zinc-600 disabled:opacity-40 hover:bg-zinc-50 transition-colors dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                aria-label="Página anterior"
              >‹</button>
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1)
                .reduce<(number | '...')[]>((acc, p, idx, arr) => {
                  if (idx > 0 && p - (arr[idx - 1] as number) > 1) acc.push('...');
                  acc.push(p);
                  return acc;
                }, [])
                .map((p, idx) =>
                  p === '...' ? (
                    <span key={`ellipsis-${idx}`} className="px-1 text-xs text-zinc-400">…</span>
                  ) : (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPage(p as number)}
                      className={`min-h-[32px] min-w-[32px] flex items-center justify-center rounded-lg border text-xs font-bold transition-colors ${
                        page === p
                          ? 'bg-zinc-900 text-white border-zinc-900 dark:bg-zinc-700 dark:border-zinc-700'
                          : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
                      }`}
                    >{p}</button>
                  )
                )}
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="min-h-[32px] min-w-[32px] flex items-center justify-center rounded-lg border border-zinc-200 bg-white text-sm font-bold text-zinc-600 disabled:opacity-40 hover:bg-zinc-50 transition-colors dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                aria-label="Próxima página"
              >›</button>
            </div>
          )}

          {/* Contador e seleção global quando não há paginação */}
          {sortedFilteredClientes.length <= PAGE_SIZE && (
            <span className="text-xs text-zinc-500 ml-auto">
              <strong className="text-zinc-700 dark:text-zinc-300">{sortedFilteredClientes.length}</strong> cliente{sortedFilteredClientes.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Barra de seleção — aparece quando há clientes filtrados */}
        {sortedFilteredClientes.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 dark:border-zinc-800 pt-3">
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={selectedIds.size > 0 && sortedFilteredClientes.every((c) => selectedIds.has(c.id))}
                ref={(el) => {
                  if (el) el.indeterminate = selectedIds.size > 0 && !sortedFilteredClientes.every((c) => selectedIds.has(c.id)) && sortedFilteredClientes.some((c) => selectedIds.has(c.id));
                }}
                onChange={() => {
                  const allSelected = sortedFilteredClientes.every((c) => selectedIds.has(c.id));
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (allSelected) sortedFilteredClientes.forEach((c) => next.delete(c.id));
                    else sortedFilteredClientes.forEach((c) => next.add(c.id));
                    return next;
                  });
                }}
                className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-500"
              />
              <span className="text-xs font-bold text-zinc-600 dark:text-zinc-400">
                {sortedFilteredClientes.every((c) => selectedIds.has(c.id)) && selectedIds.size > 0
                  ? `✓ Todos os ${sortedFilteredClientes.length} selecionados`
                  : `Selecionar todos os ${sortedFilteredClientes.length}`}
              </span>
            </label>
            {selectedCount > 0 && (
              <>
                <span className="text-xs text-zinc-400">·</span>
                <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300">
                  {selectedCount} selecionado{selectedCount !== 1 ? 's' : ''}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="text-xs font-semibold text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 underline underline-offset-2 transition-colors"
                >
                  Limpar seleção
                </button>
              </>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="inline-flex items-center rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 font-semibold text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">Enviados hoje: {waSentTodayCount}</span>
          <span className="inline-flex items-center rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 font-semibold text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">Nunca enviados: {waNeverSentCount}</span>
          <span className="inline-flex items-center rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 font-semibold text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">Falharam: {waFailedCount}</span>
          <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 font-semibold text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">Prontos: {waReadyCount}</span>
          {inadimplenteCount > 0 && (
            <button
              type="button"
              onClick={() => setQuickFilter('inadimplentes')}
              className="inline-flex items-center rounded-full border border-red-200 bg-red-50 px-2.5 py-1 font-semibold text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300 hover:bg-red-100 transition-colors"
            >
              ⚠ PIX pendente: {inadimplenteCount}
            </button>
          )}
        </div>
      </div>

      {!loading && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <DCard label="Ativos" value={String(ativos)} color="emerald" icon={<CheckCircle2 size={16}/>}/>
          <DCard label="Em risco" value={String(emRisco)} color="amber" icon={<AlertCircle size={16}/>}/>
          <DCard label="Inativos" value={String(inativos)} color="orange" icon={<Clock size={16}/>}/>
          <DCard label="Sem compra" value={String(semCompra)} color="zinc" icon={<Package size={16}/>}/>
          <DCard label="Recorrentes" value={String(recorrentes)} color="blue" icon={<TrendingUp size={16}/>}/>
          {inadimplenteCount > 0 && (
            <button type="button" onClick={() => setQuickFilter('inadimplentes')} className="col-span-2 lg:col-span-1 flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-left hover:bg-red-100 transition-colors dark:border-red-500/30 dark:bg-red-500/10 dark:hover:bg-red-500/20">
              <span className="text-lg">⚠️</span>
              <div>
                <p className="text-xl font-black text-red-700 dark:text-red-300">{inadimplenteCount}</p>
                <p className="text-xs text-red-500 dark:text-red-400 mt-0.5">PIX Pendente</p>
              </div>
            </button>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-10 sm:py-12" role="status" aria-label="Carregando clientes">
          <Spinner className="h-7 w-7" />
        </div>
      ) : (
        <div className={`${adminOpsSurfaceCardClass} overflow-hidden`}>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm min-w-[1020px]">
              <thead><tr className="bg-zinc-50 dark:bg-zinc-800 border-b border-zinc-100 dark:border-zinc-700">
                <th className="px-4 py-3">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-500"
                    aria-label="Selecionar clientes visiveis"
                  />
                </th>
                <th className="text-left px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Cliente</th>
                <th className="text-left px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Telefone</th>
                <th className="text-left px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Relacionamento</th>
                <th className="text-left px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Reativacao WA</th>
                <th className="text-right px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Pedidos</th>
                <th className="text-right px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Total gasto</th>
                <th className="text-right px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Ticket médio</th>
                <th className="text-left px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Ultima compra</th>
                <th className="px-4 py-3"/>
              </tr></thead>
              <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800">
                {pagedClientes.map(c => (
                  <tr key={c.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800">
                    <td className="px-4 py-3 align-top">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(c.id)}
                        onChange={() => toggleSelectCustomer(c.id)}
                        className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-500"
                        aria-label={`Selecionar ${c.nome}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-bold text-zinc-800 dark:text-zinc-200">{c.nome}</p>
                        {c.tem_pix_pendente && (
                          <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-black text-red-700 border border-red-200 dark:bg-red-500/20 dark:text-red-300 dark:border-red-500/30">
                            ⚠ PIX pendente
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        <StatusChip variant="info" size="md">
                          {getCustomerOriginLabel(c.origem_cadastro)}
                        </StatusChip>
                        {c.fidelizacao?.label ? (
                          <StatusChip
                            variant="neutral"
                            size="md"
                            uppercase={false}
                            emphasis="semibold"
                            title="Fidelização"
                          >
                            {c.fidelizacao.label}
                          </StatusChip>
                        ) : (
                          c.cliente_recorrente && (
                            <StatusChip
                              size="md"
                              toneClassName="border-violet-100 bg-violet-50 text-violet-700 dark:border-violet-500/25 dark:bg-violet-500/15 dark:text-violet-200"
                            >
                              Recorrente
                            </StatusChip>
                          )
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-zinc-600 dark:text-zinc-400 font-mono text-xs">{c.telefone || '—'}</p>
                      {c.observacoes && (
                        <p className="text-[11px] text-zinc-400 mt-1 max-w-[220px] truncate" title={c.observacoes}>
                          {c.observacoes}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        const status = getCustomerActivityMeta(c.status_atividade);
                        return (
                          <>
                            <StatusChip size="md" toneClassName={status.tone}>
                              {status.label}
                            </StatusChip>
                            <p className="text-[11px] text-fptext-muted mt-1">{getDaysWithoutPurchaseLabel(c.dias_sem_comprar)}</p>
                          </>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        const reactivation = getReactivationStatusMeta(c);
                        return (
                          <>
                            <StatusChip size="md" toneClassName={reactivation.tone}>
                              {reactivation.label}
                            </StatusChip>
                            <p className="text-[11px] text-fptext-muted mt-1">{reactivation.detail}</p>
                          </>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300 font-bold text-right">{c.total_pedidos||0}</td>
                    <td className="px-4 py-3 font-bold text-emerald-700 text-right">{fmt(c.total_gasto||0)}</td>
                    <td className="px-4 py-3 font-bold text-violet-700 dark:text-violet-400 text-right">
                      {Number(c.total_pedidos||0) > 0 ? fmt(Number(c.total_gasto||0) / Number(c.total_pedidos)) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-zinc-600 dark:text-zinc-400 text-xs font-semibold">{fmtDate(c.ultima_compra_at || c.ultimo_pedido)}</p>
                      <p className="text-[11px] text-zinc-400 mt-1">{getCustomerPurchaseSummary(c)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <button onClick={() => { setSelected(c); fetchPedidos(c.id); }}
                        className="px-3 py-1.5 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded-lg text-xs font-bold text-zinc-600 dark:text-zinc-400 transition-all">
                        Ver historico
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="md:hidden space-y-3 p-3">
            {pagedClientes.map(c => {
              const status = getCustomerActivityMeta(c.status_atividade);
              return (
                <div
                  key={c.id}
                  className={`w-full ${adminOpsSurfaceCardClass} p-4`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <label className="inline-flex items-center gap-2 text-xs text-zinc-500">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(c.id)}
                        onChange={() => toggleSelectCustomer(c.id)}
                        className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-500"
                      />
                      Selecionar
                    </label>
                    <button
                      type="button"
                      onClick={() => { setSelected(c); fetchPedidos(c.id); }}
                      className="inline-flex items-center gap-1 text-xs font-bold text-zinc-600 dark:text-zinc-300"
                    >
                      Ver historico <ChevronRight size={14} className="shrink-0 text-zinc-400" />
                    </button>
                  </div>
                  <div className="mt-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-bold text-zinc-800 dark:text-zinc-200">{c.nome}</p>
                        {c.tem_pix_pendente && (
                          <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-black text-red-700 border border-red-200 dark:bg-red-500/20 dark:text-red-300 dark:border-red-500/30">
                            ⚠ PIX pendente
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs font-mono text-fptext-muted">{c.telefone || '—'}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <StatusChip variant="info" size="md">
                      {getCustomerOriginLabel(c.origem_cadastro)}
                    </StatusChip>
                    <StatusChip size="md" toneClassName={status.tone}>
                      {status.label}
                    </StatusChip>
                    {c.fidelizacao?.label ? (
                      <StatusChip variant="neutral" size="md" uppercase={false} emphasis="semibold">
                        {c.fidelizacao.label}
                      </StatusChip>
                    ) : (
                      c.cliente_recorrente && (
                        <StatusChip
                          size="md"
                          toneClassName="border-violet-100 bg-violet-50 text-violet-700 dark:border-violet-500/25 dark:bg-violet-500/15 dark:text-violet-200"
                        >
                          Recorrente
                        </StatusChip>
                      )
                    )}
                    <StatusChip size="md" toneClassName={getReactivationStatusMeta(c).tone}>
                      {getReactivationStatusMeta(c).label}
                    </StatusChip>
                  </div>
                  <p className="mt-2 text-[11px] text-fptext-muted">{getReactivationStatusMeta(c).detail}</p>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <div className={`${adminOpsInsetPanelClass} px-3 py-2`}>
                      <p className="text-zinc-400">Pedidos</p>
                      <p className="mt-1 font-black text-zinc-800 dark:text-zinc-100">{c.total_pedidos || 0}</p>
                    </div>
                    <div className={`${adminOpsInsetPanelClass} px-3 py-2`}>
                      <p className="text-zinc-400">Total gasto</p>
                      <p className="mt-1 font-black text-emerald-700">{fmt(c.total_gasto || 0)}</p>
                    </div>
                    <div className={`${adminOpsInsetPanelClass} px-3 py-2`}>
                      <p className="text-zinc-400">Ticket médio</p>
                      <p className="mt-1 font-black text-violet-700 dark:text-violet-400">
                        {Number(c.total_pedidos || 0) > 0 ? fmt(Number(c.total_gasto || 0) / Number(c.total_pedidos)) : '—'}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {sortedFilteredClientes.length===0 && (
            <div className={adminOpsDashedWellClass}>
              <EmptyState
                icon={Users}
                title="Nenhum cliente encontrado"
                description="Tente outro termo de busca ou limpe o filtro."
              />
            </div>
          )}
        </div>
      )}

      <AnimatePresence>
        {selected && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm p-0 sm:items-center sm:p-6" onClick={()=>setSelected(null)}>
            <motion.div onClick={e=>e.stopPropagation()}
              initial={{scale:0.9,opacity:0}} animate={{scale:1,opacity:1}} exit={{scale:0.9,opacity:0}}
              className="max-h-[min(88dvh,100%)] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-zinc-200 bg-white p-6 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl dark:border-zinc-800 dark:bg-zinc-900 sm:rounded-2xl sm:pb-6">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-black text-fptext-primary">{selected.nome}</h3>
                  <p className="text-sm text-zinc-400 font-mono">{selected.telefone}</p>
                </div>
                <button type="button" onClick={()=>setSelected(null)} className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800" aria-label="Fechar">✕</button>
              </div>

              <div className="flex flex-wrap gap-2 mb-4">
                {(() => {
                  const status = getCustomerActivityMeta(selected.status_atividade);
                  return (
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-black border ${status.tone}`}>
                      {status.label}
                    </span>
                  );
                })()}
                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-black bg-blue-50 text-blue-700 border border-blue-100 dark:bg-blue-500/15 dark:text-blue-200 dark:border-blue-500/25">
                  {getCustomerOriginLabel(selected.origem_cadastro)}
                </span>
                {selected.fidelizacao?.label ? (
                  <span
                    className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-zinc-100 text-zinc-600 border border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-600"
                    title="Fidelização"
                  >
                    {selected.fidelizacao.label}
                  </span>
                ) : (
                  selected.cliente_recorrente && (
                    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-black bg-violet-50 text-violet-700 border border-violet-100 dark:bg-violet-500/15 dark:text-violet-200 dark:border-violet-500/25">
                      Cliente recorrente
                    </span>
                  )
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
                <div className="bg-zinc-50 dark:bg-zinc-800 rounded-xl p-3 text-center">
                  <p className="text-xl font-black text-fptext-primary">{selected.total_pedidos||0}</p>
                  <p className="text-xs text-zinc-400 mt-0.5">Pedidos</p>
                </div>
                <div className="bg-emerald-50 rounded-xl p-3 text-center">
                  <p className="text-xl font-black text-emerald-700">{fmt(selected.total_gasto||0)}</p>
                  <p className="text-xs text-zinc-400 mt-0.5">Total gasto</p>
                </div>
                <div className="bg-violet-50 dark:bg-violet-500/10 rounded-xl p-3 text-center">
                  <p className="text-xl font-black text-violet-700 dark:text-violet-300">
                    {Number(selected.total_pedidos||0) > 0 ? fmt(Number(selected.total_gasto||0) / Number(selected.total_pedidos)) : '—'}
                  </p>
                  <p className="text-xs text-zinc-400 mt-0.5">Ticket médio</p>
                </div>
                <div className="bg-blue-50 rounded-xl p-3 text-center">
                  <p className="text-sm font-black text-blue-700">{fmtDate(selected.ultima_compra_at || selected.ultimo_pedido)}</p>
                  <p className="text-xs text-zinc-400 mt-0.5">Ultima compra</p>
                </div>
                <div className="bg-amber-50 rounded-xl p-3 text-center">
                  <p className="text-sm font-black text-amber-700">{getDaysWithoutPurchaseLabel(selected.dias_sem_comprar)}</p>
                  <p className="text-xs text-zinc-400 mt-0.5">Recencia</p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-5">
                <div className="bg-zinc-50 dark:bg-zinc-800 rounded-xl p-4 space-y-2">
                  <p className="text-[10px] font-black text-zinc-400 uppercase tracking-wider">Leitura operacional</p>
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-xs text-zinc-500">Status</span>
                    <span className="text-sm font-bold text-zinc-800 dark:text-zinc-200 text-right">{getCustomerActivityMeta(selected.status_atividade).helper}</span>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-xs text-zinc-500">Primeira compra</span>
                    <span className="text-sm font-bold text-zinc-800 dark:text-zinc-200 text-right">{fmtDate(selected.primeira_compra_at)}</span>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-xs text-zinc-500">Origem</span>
                    <span className="text-sm font-bold text-zinc-800 dark:text-zinc-200 text-right">{getCustomerOriginLabel(selected.origem_cadastro)}</span>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-xs text-zinc-500">Perfil</span>
                    <span className="text-sm font-bold text-zinc-800 dark:text-zinc-200 text-right">
                      {selected.fidelizacao?.label ??
                        (selected.cliente_recorrente ? 'Recorrente' : 'Pontual')}
                    </span>
                  </div>
                </div>

                <div className="bg-zinc-50 dark:bg-zinc-800 rounded-xl p-4">
                  <p className="text-[10px] font-black text-zinc-400 uppercase tracking-wider mb-2">Observacoes</p>
                  {selected.observacoes ? (
                    <p className="text-sm text-zinc-700 whitespace-pre-wrap break-words">{selected.observacoes}</p>
                  ) : (
                    <p className="text-sm text-zinc-400">Nenhuma observacao cadastrada.</p>
                  )}
                </div>
              </div>

              {(() => {
                const pixPendentes = pedidos.filter(
                  (p) => p.pagamento_tipo === 'pix' && p.pagamento_status !== 'pago' && p.status !== 'Cancelado'
                );
                if (pixPendentes.length > 0) {
                  return (
                    <div className="mb-4 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 dark:border-red-500/30 dark:bg-red-500/10">
                      <span className="text-lg leading-none">⚠️</span>
                      <div>
                        <p className="text-sm font-black text-red-700 dark:text-red-300">
                          Cliente inadimplente
                        </p>
                        <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">
                          {pixPendentes.length === 1
                            ? 'Este cliente possui 1 pedido com PIX gerado e não confirmado.'
                            : `Este cliente possui ${pixPendentes.length} pedidos com PIX gerado e não confirmados.`}{' '}
                          Verifique antes de aceitar novos pedidos.
                        </p>
                      </div>
                    </div>
                  );
                }
                return null;
              })()}

              <p className="text-xs font-black text-zinc-400 uppercase tracking-wider mb-3">Historico de pedidos</p>
              <div className="space-y-2">
                {pedidos.map((p) => {
                  const isPixPendente = p.pagamento_tipo === 'pix' && p.pagamento_status !== 'pago' && p.status !== 'Cancelado';
                  const isCancelado = p.status === 'Cancelado';
                  return (
                    <div key={p.id} className={`flex flex-col gap-2 rounded-xl p-3 sm:flex-row sm:items-center ${isPixPendente ? 'bg-red-50 border border-red-200 dark:bg-red-500/10 dark:border-red-500/30' : 'bg-zinc-50 dark:bg-zinc-800'}`}>
                      <div className="flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-bold text-zinc-800 dark:text-zinc-200">#{p.order_number}</p>
                          {p.pagamento_tipo === 'pix' && (
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-black border ${
                              p.pagamento_status === 'pago'
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30'
                                : isCancelado
                                ? 'bg-zinc-100 text-zinc-500 border-zinc-200 dark:bg-zinc-700 dark:text-zinc-400 dark:border-zinc-600'
                                : 'bg-red-100 text-red-700 border-red-200 dark:bg-red-500/20 dark:text-red-300 dark:border-red-500/30'
                            }`}>
                              {p.pagamento_status === 'pago' ? '✓ PIX Pago' : isCancelado ? 'PIX / Cancelado' : '⚠ PIX Pendente'}
                            </span>
                          )}
                          {p.pagamento_tipo && p.pagamento_tipo !== 'pix' && (
                            <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-500 border border-zinc-200 dark:bg-zinc-700 dark:text-zinc-400 dark:border-zinc-600">
                              {p.pagamento_tipo === 'dinheiro' ? 'Dinheiro' : p.pagamento_tipo === 'cartao' ? 'Cartão' : p.pagamento_tipo}
                              {p.pagamento_status === 'pago' ? ' ✓' : ''}
                            </span>
                          )}
                          {isCancelado && (
                            <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-600 border border-red-200 dark:bg-red-500/15 dark:text-red-400 dark:border-red-500/25">
                              Cancelado
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-zinc-400 mt-1">{p.resumo_itens||'—'}</p>
                        <p className="text-[10px] text-zinc-300 mt-0.5">{fmtDate(p.created_at)}</p>
                      </div>
                      <span className="font-black text-sm text-zinc-700 dark:text-zinc-300">{fmt(p.total_amount)}</span>
                    </div>
                  );
                })}
                {pedidos.length===0 && <p className="text-center text-zinc-300 text-sm py-6">Sem pedidos anteriores</p>}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      </div>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ABA MOTOBOYS
// ═══════════════════════════════════════════════════════════════════════════════
function TabMotoboys({ token }: { token: string }) {
  const [relatorio, setRelatorio] = useState<any[]>([]);
  const [loading, setLoading]     = useState(true);
  const [mes, setMes]             = useState(new Date().getMonth()+1);
  const [ano, setAno]             = useState(new Date().getFullYear());
  const hdrs = { Authorization: `Bearer ${token}` };

  const fetch_relatorio = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/delivery/motoboys/relatorio?month=${mes}&year=${ano}`, { headers: hdrs });
      if (res.ok) setRelatorio(await res.json());
    } catch {}
    setLoading(false);
  }, [token, mes, ano]);

  useEffect(() => { fetch_relatorio(); }, [fetch_relatorio]);

  const total_entregas = relatorio.reduce((a,r)=>a+(r.total_entregas||0),0);
  const total_pagar    = relatorio.reduce((a,r)=>a+(r.total_a_pagar||0),0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select value={mes} onChange={e=>setMes(Number(e.target.value))}
          className="min-h-[44px] px-3 py-2 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm focus:outline-none text-fptext-primary">
          {Array.from({length:12},(_,i)=><option key={i+1} value={i+1}>{new Date(0,i).toLocaleString('pt-BR',{month:'long'})}</option>)}
        </select>
        <input type="number" value={ano} onChange={e=>setAno(Number(e.target.value))}
          className="w-full min-h-[44px] px-3 py-2 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm focus:outline-none text-fptext-primary sm:w-24"/>
        <button onClick={fetch_relatorio} className="w-full min-h-[44px] px-4 py-2 bg-zinc-900 text-white rounded-xl text-sm font-bold hover:bg-zinc-700 transition-colors sm:w-auto">Filtrar</button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className={`${adminOpsSurfaceCardClass} p-5`}>
          <p className="text-3xl font-black text-fptext-primary">{total_entregas}</p>
          <p className="text-sm text-zinc-400 mt-1">Total de entregas</p>
        </div>
        <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-5">
          <p className="text-3xl font-black text-emerald-700">{fmt(total_pagar)}</p>
          <p className="text-sm text-zinc-400 mt-1">Total a pagar</p>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-10" role="status" aria-label="Carregando relatório de motoboys">
          <Spinner className="h-7 w-7" />
        </div>
      ) : (
        <div className={`${adminOpsSurfaceCardClass} overflow-hidden`}>
          <table className="w-full text-sm">
            <thead><tr className="bg-zinc-50 dark:bg-zinc-800 border-b border-zinc-100 dark:border-zinc-700">
              <th className="text-left px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Motoboy</th>
              <th className="text-right px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Entregas</th>
              <th className="text-right px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Valor/entrega</th>
              <th className="text-right px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Total</th>
            </tr></thead>
            <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800">
              {relatorio.map((r:any) => (
                <tr key={r.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800">
                  <td className="px-4 py-3 font-bold text-zinc-800 dark:text-zinc-200">{r.nome}</td>
                  <td className="px-4 py-3 text-zinc-700 font-bold text-right">{r.total_entregas||0}</td>
                  <td className="px-4 py-3 text-zinc-500 text-right">{fmt(r.valor_por_entrega||0)}</td>
                  <td className="px-4 py-3 font-black text-emerald-700 text-right">{fmt(r.total_a_pagar||0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {relatorio.length===0&&(
            <div className={adminOpsDashedWellClass}>
              <EmptyState
                icon={Truck}
                title="Nenhum motoboy com entregas no período"
                description="Altere o mês/ano ou aguarde novas entregas."
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ABA RELATÓRIO — faturamento, produtos, horários
// ═══════════════════════════════════════════════════════════════════════════════
function TabRelatorio({ token }: { token: string }) {
  const [periodo, setPeriodo] = useState<string>('7d');
  const [data, setData]       = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [liveDash, setLiveDash] = useState<Dashboard | null>(null);
  const [sugestoesAceitas, setSugestoesAceitas] = useState<
    { produto_origem_id: number; produto_sugerido_id: number; total: number; origem_name: string | null; sugerido_name: string | null }[]
  >([]);
  const [loadingSugestoes, setLoadingSugestoes] = useState(true);
  const hdrs = { Authorization: `Bearer ${token}` };

  const fetchRelatorio = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/delivery/relatorio?periodo=${periodo}`, { headers: hdrs });
      if (res.ok) setData(await res.json());
    } catch {}
    setLoading(false);
  }, [token, periodo]);

  useEffect(() => { fetchRelatorio(); }, [fetchRelatorio]);

  // Indicadores ao vivo (movidos do Painel para não poluir o quadro operacional)
  useEffect(() => {
    let cancelled = false;
    const fetchLive = async () => {
      try {
        const res = await fetch('/api/delivery/dashboard', { headers: hdrs });
        if (res.ok && !cancelled) setLiveDash(await res.json());
      } catch {}
    };
    fetchLive();
    const iv = setInterval(fetchLive, 15000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingSugestoes(true);
      try {
        const res = await fetch(
          `/api/products/suggestions/events/summary?periodo=${encodeURIComponent(periodo)}`,
          { headers: hdrs }
        );
        if (res.ok && !cancelled) {
          const d = await res.json();
          setSugestoesAceitas(Array.isArray(d) ? d : []);
        }
      } catch {}
      if (!cancelled) setLoadingSugestoes(false);
    })();
    return () => { cancelled = true; };
  }, [token, periodo]);

  const periodos = [
    { key:'hoje', label:'Hoje' },
    { key:'7d',   label:'7 dias' },
    { key:'30d',  label:'30 dias' },
    { key:'mes',  label:'Este mês' },
  ];

  if (loading) {
    return (
      <div className="flex justify-center py-12 sm:py-16 2xl:py-20" role="status" aria-label="Carregando relatório">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  const resumo = data?.resumo || {};
  const topProdutos: any[] = data?.topProdutos || [];
  const porDia: any[]      = data?.porDia       || [];
  const porHora: any[]     = data?.porHora      || [];
  const porPag: any[]      = data?.porPagamento || [];

  const maxFat  = Math.max(...porDia.map((d:any)=>d.faturamento||0), 1);
  const maxHora = Math.max(...porHora.map((h:any)=>h.pedidos||0), 1);

  return (
    <div className="space-y-5">
      {/* Ao vivo (agora) — o que antes ficava no topo do Painel */}
      {liveDash && (
        <div>
          <h3 className="mb-2 text-[11px] font-black uppercase tracking-wider text-fptext-muted">Agora (tempo real)</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-6">
            <DCard label="Pedidos Hoje"  value={String(liveDash.pedidos_hoje)}   color="blue"    icon={<Package size={16}/>} />
            <DCard label="Faturamento"   value={fmt(liveDash.faturamento_hoje)}  color="emerald" icon={<DollarSign size={16}/>} />
            <DCard label="Em Preparo"    value={String(liveDash.em_preparo)}     color="amber"   icon={<Clock size={16}/>} />
            <DCard label="Em Rota"       value={String(liveDash.em_rota)}        color="orange"  icon={<Bike size={16}/>} />
            <DCard label="Ticket Médio"  value={fmt(liveDash.ticket_medio)}      color="purple"  icon={<TrendingUp size={16}/>} />
            <DCard label="Top Motoboy"   value={liveDash.top_motoboy ? `${liveDash.top_motoboy.nome.split(' ')[0]} (${liveDash.top_motoboy.entregas})` : '—'} color="zinc" icon={<User size={16}/>} />
          </div>
        </div>
      )}

      {/* Filtro período */}
      <div className="flex gap-1.5">
        {periodos.map(p=>(
          <button key={p.key} onClick={()=>setPeriodo(p.key)}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${periodo===p.key ? deliverySecondaryButtonActiveClass : deliverySecondaryButtonInactiveClass}`}>
            {p.label}
          </button>
        ))}
      </div>

      {/* Cards resumo */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <DCard label="Pedidos"         value={String(resumo.total_pedidos||0)}                  color="blue"    icon={<Package size={16}/>}/>
        <DCard label="Faturamento"     value={fmt(resumo.faturamento_total||0)}                  color="emerald" icon={<DollarSign size={16}/>}/>
        <DCard label="Ticket médio"    value={fmt(resumo.ticket_medio||0)}                       color="purple"  icon={<TrendingUp size={16}/>}/>
        <DCard label="Clientes únicos" value={String(resumo.clientes_unicos||0)}                 color="amber"   icon={<Users size={16}/>}/>
        <DCard label="Entregues"       value={String(resumo.entregues||0)}                       color="zinc"    icon={<CheckCircle2 size={16}/>}/>
        <DCard label="Cancelados"      value={String(resumo.cancelados||0)}                      color="zinc"    icon={<XCircle size={16}/>}/>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Faturamento por dia */}
        <div className={`${adminOpsSurfaceCardClass} p-5`}>
          <h3 className="text-sm font-black text-fptext-primary mb-4">Faturamento por dia</h3>
          {porDia.length===0 ? (
            <div className={adminOpsDashedWellClass}>
              <EmptyState
                icon={BarChart2}
                title="Sem dados"
                description="Não há faturamento registrado neste período."
                className="!py-8 !sm:py-10"
              />
            </div>
          ) : (
            <div className="space-y-2">
              {porDia.map((d:any,i:number)=>(
                <div key={i} className="flex items-center gap-3">
                  <span className="text-xs text-zinc-400 w-20 shrink-0">
                    {new Date(d.dia+'T12:00:00').toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})}
                  </span>
                  <div className="flex-1 bg-zinc-100 dark:bg-zinc-800 rounded-full h-6 overflow-hidden">
                    <div className="h-full bg-emerald-500 rounded-full flex items-center pl-2 transition-all"
                      style={{ width:`${Math.max((d.faturamento/maxFat)*100, 4)}%` }}>
                      <span className="text-[9px] font-bold text-white whitespace-nowrap">{fmt(d.faturamento)}</span>
                    </div>
                  </div>
                  <span className="text-xs font-bold text-zinc-500 w-8 text-right shrink-0">{d.pedidos}p</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Horário de pico */}
        <div className={`${adminOpsSurfaceCardClass} p-5`}>
          <h3 className="text-sm font-black text-fptext-primary mb-4">Horário de pico</h3>
          {porHora.length===0 ? (
            <div className={adminOpsDashedWellClass}>
              <EmptyState
                icon={BarChart2}
                title="Sem dados"
                description="Não há pedidos por hora neste período."
                className="!py-8 !sm:py-10"
              />
            </div>
          ) : (
            <div className="flex items-end gap-1 h-40">
              {Array.from({length:24},(_,h)=>{
                const entry = porHora.find((x:any)=>x.hora===h);
                const count = entry?.pedidos||0;
                const height = count ? Math.max((count/maxHora)*100, 8) : 0;
                return (
                  <div key={h} className="flex-1 flex flex-col items-center gap-0.5" title={`${h}h: ${count} pedido${count!==1?'s':''}`}>
                    <div className="w-full rounded-sm transition-all"
                      style={{ height:`${height}%`, background:count>0?'#3b82f6':'#f4f4f5', minHeight:count?4:0 }}/>
                    {h%4===0&&<span className="text-[10px] tabular-nums text-zinc-400">{h}h</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Top produtos */}
        <div className={`${adminOpsSurfaceCardClass} p-5`}>
          <h3 className="text-sm font-black text-fptext-primary mb-4">Produtos mais vendidos</h3>
          {topProdutos.length===0 ? (
            <div className={adminOpsDashedWellClass}>
              <EmptyState
                icon={Package}
                title="Sem dados"
                description="Nenhuma venda de produto no período selecionado."
                className="!py-8 !sm:py-10"
              />
            </div>
          ) : (
            <div className="space-y-2">
              {topProdutos.slice(0,8).map((p:any,i:number)=>(
                <div key={i} className="flex items-center gap-3">
                  <span className="w-5 h-5 rounded-full bg-zinc-100 dark:bg-zinc-700 text-fptext-muted text-[10px] font-black flex items-center justify-center shrink-0">{i+1}</span>
                  <span className="flex-1 text-sm text-zinc-700 font-medium truncate">{p.name}</span>
                  <span className="text-xs font-bold text-zinc-500 shrink-0">{p.qtd}x</span>
                  <span className="text-xs font-black text-emerald-600 shrink-0">{fmt(p.receita)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Formas de pagamento */}
        <div className={`${adminOpsSurfaceCardClass} p-5`}>
          <h3 className="text-sm font-black text-fptext-primary mb-4">Formas de pagamento</h3>
          {porPag.length===0 ? (
            <div className={adminOpsDashedWellClass}>
              <EmptyState
                icon={CreditCard}
                title="Sem dados"
                description="Não há pagamentos registrados neste período."
                className="!py-8 !sm:py-10"
              />
            </div>
          ) : (
            <div className="space-y-3">
              {porPag.map((p:any,i:number)=>{
                const label: Record<string,string> = { pix:'Pix', dinheiro:'Dinheiro', cartao:'Cartão' };
                const colors = ['bg-blue-500','bg-emerald-500','bg-amber-500','bg-purple-500'];
                const totalGeral = porPag.reduce((a:number,x:any)=>a+(x.qtd||0),0)||1;
                return (
                  <div key={i} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-zinc-700">{label[p.pagamento_tipo]||p.pagamento_tipo}</span>
                      <span className="font-bold text-zinc-500">{p.qtd} · {fmt(p.total)}</span>
                    </div>
                    <div className="h-2 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${colors[i%colors.length]}`}
                        style={{ width:`${(p.qtd/totalGeral)*100}%` }}/>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="bg-fp-card border border-fp-border rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-100 flex items-center gap-2">
          <Tag size={16} className="text-emerald-600 shrink-0"/>
          <div>
            <h3 className="text-sm font-black text-fptext-primary">Sugestões aceitas (complementos)</h3>
            <p className="text-[11px] text-zinc-400 mt-0.5">Pares origem → sugerido no cardápio online, no mesmo período dos botões acima</p>
          </div>
        </div>
        {loadingSugestoes ? (
          <div className="flex justify-center py-10" role="status" aria-label="Carregando sugestões">
            <Spinner className="h-7 w-7" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[520px]">
              <thead>
                <tr className="bg-zinc-50 dark:bg-zinc-800 border-b border-zinc-100 dark:border-zinc-700">
                  <th className="text-left px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Produto de origem</th>
                  <th className="text-left px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Sugerido</th>
                  <th className="text-right px-4 py-3 text-[11px] font-black text-zinc-400 uppercase tracking-wider">Aceitações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800">
                {sugestoesAceitas.map((row) => (
                  <tr key={`${row.produto_origem_id}-${row.produto_sugerido_id}`} className="hover:bg-zinc-50">
                    <td className="px-4 py-3 text-zinc-800 dark:text-zinc-200">
                      <span className="font-medium">{row.origem_name || `Produto #${row.produto_origem_id}`}</span>
                    </td>
                    <td className="px-4 py-3 text-zinc-800 dark:text-zinc-200">
                      <span className="font-medium">{row.sugerido_name || `Produto #${row.produto_sugerido_id}`}</span>
                    </td>
                    <td className="px-4 py-3 text-right font-black text-emerald-700">{row.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sugestoesAceitas.length === 0 && (
              <EmptyState
                icon={Tag}
                title="Nenhum evento registrado ainda"
                description="Quando clientes aceitarem sugestões no cardápio, os pares aparecerão aqui."
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ABA CONFIG — zonas, cupons, evolution API, opções gerais
// ═══════════════════════════════════════════════════════════════════════════════
export function DeliveryConfigPanel({
  token,
  slug,
  initialSection = 'loja',
  standaloneSection = null,
}: {
  token: string;
  slug?: string;
  initialSection?: DeliveryConfigSection;
  standaloneSection?: DeliveryConfigSection | null;
}) {
  const [cfg, setCfg]         = useState<DeliveryConfig>({ ativo: false });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [activeSection, setActiveSection] = useState<DeliveryConfigSection>(standaloneSection ?? initialSection);
  type LojaSubTab = 'operacao' | 'entrega' | 'financeiro' | 'pagamentos' | 'comunicacao' | 'aparencia';
  const [lojaSub, setLojaSub] = useState<LojaSubTab>('operacao');
  const hasStandaloneSection = standaloneSection != null;

  // Cupons
  const [cupons, setCupons]     = useState<Cupom[]>([]);
  const [novoCupom, setNovoCupom] = useState({ codigo:'', tipo:'percentual' as const, valor:'', min_pedido:'', limite_uso:'', validade:'' });
  const [addingCupom, setAddingCupom] = useState(false);

  // Zonas
  const [zonas, setZonas]         = useState<Array<{nome:string;taxa:number}>>([]);
  const [novaZona, setNovaZona]   = useState({ nome:'', taxa:'' });

  const hdrs = { Authorization: `Bearer ${token}` };

  const logoFileRef = useRef<HTMLInputElement>(null);
  const bannerInputRefs = useRef<(HTMLInputElement | null)[]>([null, null, null, null]);
  const [fallbackLogoUrl, setFallbackLogoUrl] = useState<string | null>(null);
  const [cvBusy, setCvBusy] = useState<'logo' | number | null>(null);
  const [testingPixConfig, setTestingPixConfig] = useState(false);
  const [pixTestResult, setPixTestResult] = useState<null | {
    ok: boolean;
    status: 'manual' | 'ready' | 'invalid';
    message: string;
    provider?: string | null;
  }>(null);
  const normalizeOptionalHttpUrl = (value: unknown) => {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    try {
      const parsed = new URL(normalized);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return parsed.toString();
    } catch {
      return null;
    }
  };
  const defaultCardapioPublicUrl = slug ? `${window.location.origin}/delivery/${slug}` : '';
  const shortCardapioPublicUrl = normalizeOptionalHttpUrl(cfg.cardapio_link_curto);
  const preferredCardapioPublicUrl = shortCardapioPublicUrl || defaultCardapioPublicUrl;

  useEffect(() => {
    if (lojaSub !== 'aparencia') return;
    fetch('/api/settings/logo', { headers: hdrs })
      .then((r) => r.json())
      .then((d) => setFallbackLogoUrl(d.logo_url || null))
      .catch(() => {});
  }, [lojaSub, token]);

  const onCardapioLogoFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setCvBusy('logo');
    try {
      const fd = new FormData();
      fd.append('logo', f);
      const res = await fetch('/api/delivery/cardapio-visual/logo', { method: 'POST', headers: hdrs, body: fd });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.url) setCfg((c) => ({ ...c, cardapio_online_logo_url: d.url }));
      else alert(d.message || d.error || 'Falha no envio da logo');
    } catch {}
    setCvBusy(null);
  };

  const removeCardapioLogo = async () => {
    setCvBusy('logo');
    try {
      const res = await fetch('/api/delivery/cardapio-visual/logo', { method: 'DELETE', headers: hdrs });
      if (res.ok) setCfg((c) => ({ ...c, cardapio_online_logo_url: undefined }));
    } catch {}
    setCvBusy(null);
  };

  const handleBannerUpload = useCallback(
    async (slotIndex: number, e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      setCvBusy(slotIndex);
      try {
        const fd = new FormData();
        fd.append('banner', file);
        const res = await fetch(`/api/delivery/cardapio-visual/banner/${slotIndex}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        });
        const d = (await res.json().catch(() => ({}))) as {
          url?: string;
          message?: string;
          error?: string;
        };
        if (res.ok && typeof d.url === 'string' && d.url.length > 0) {
          const uploadedUrl = d.url;
          setCfg((c) => {
            const slots = [...normalizeCardapioOnlineBannerSlots(c.cardapio_online_banner_urls)];
            slots[slotIndex] = uploadedUrl;
            return { ...c, cardapio_online_banner_urls: slots };
          });
        } else {
          alert(d.message || d.error || 'Falha no envio do banner');
        }
      } catch {
        /* ignore */
      }
      setCvBusy(null);
    },
    [token]
  );

  const removeBannerSlot = async (idx: number) => {
    setCvBusy(idx);
    try {
      const res = await fetch(`/api/delivery/cardapio-visual/banner/${idx}`, { method: 'DELETE', headers: hdrs });
      if (res.ok) {
        setCfg((c) => {
          const slots = [...normalizeCardapioOnlineBannerSlots(c.cardapio_online_banner_urls)];
          slots[idx] = '';
          return { ...c, cardapio_online_banner_urls: slots };
        });
      }
    } catch {}
    setCvBusy(null);
  };

  useEffect(() => {
    (async () => {
      try {
        const [cfgRes, cuponsRes] = await Promise.all([
          fetch('/api/delivery/config',  { headers: hdrs }),
          fetch('/api/delivery/cupons',  { headers: hdrs }),
        ]);
        if (cfgRes.ok) {
          const d = await cfgRes.json();
          setCfg({
            ...d,
            automation: { ...DEFAULT_TENANT_AUTOMATION, ...(d.automation && typeof d.automation === 'object' ? d.automation : {}) },
          });
          setZonas(Array.isArray(d.zonas_entrega) ? d.zonas_entrega : []);
        }
        if (cuponsRes.ok) setCupons(await cuponsRes.json());
      } catch {}
      setLoading(false);
    })();
  }, [token]);

  useEffect(() => {
    setPixTestResult(null);
  }, [
    cfg.provider_enabled,
    cfg.payment_provider,
    cfg.api_key,
    cfg.access_token,
    cfg.webhook_secret,
    cfg.pix_key,
    cfg.provider_sandbox,
    cfg.itau_tls_cert_pem,
    cfg.itau_tls_key_pem,
    cfg.itau_tls_ca_pem,
    cfg.itau_api_base_url,
    cfg.itau_token_url,
    cfg.pix_chave,
    cfg.pix_payload_estatico,
    cfg.pix_nome,
    cfg.pix_cidade,
  ]);

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        ...cfg,
        zonas_entrega: zonas,
        cardapio_online_banner_urls: [...normalizeCardapioOnlineBannerSlots(cfg.cardapio_online_banner_urls)],
      };
      await fetch('/api/delivery/config', {
        method:'PUT', headers:{...hdrs,'Content-Type':'application/json'},
        body: JSON.stringify(body),
      });
      setSaved(true); setTimeout(()=>setSaved(false), 2000);
    } catch {}
    setSaving(false);
  };

  const testPixConfig = async () => {
    setTestingPixConfig(true);
    setPixTestResult(null);
    try {
      const res = await fetch('/api/delivery/config/pix/test', {
        method:'POST',
        headers:{...hdrs,'Content-Type':'application/json'},
        body: JSON.stringify({
          provider_enabled: cfg.provider_enabled,
          payment_provider: cfg.payment_provider,
          api_key: cfg.api_key,
          access_token: cfg.access_token,
          webhook_secret: cfg.webhook_secret,
          pix_key: cfg.pix_key,
          provider_sandbox: cfg.provider_sandbox,
          itau_tls_cert_pem: cfg.itau_tls_cert_pem,
          itau_tls_key_pem: cfg.itau_tls_key_pem,
          itau_tls_ca_pem: cfg.itau_tls_ca_pem,
          itau_api_base_url: cfg.itau_api_base_url,
          itau_token_url: cfg.itau_token_url,
          pix_chave: cfg.pix_chave,
          pix_payload_estatico: cfg.pix_payload_estatico,
        }),
      });
      const data = await res.json().catch(() => ({} as any));
      setPixTestResult({
        ok: res.ok && Boolean(data.success),
        status: data.status === 'manual' ? 'manual' : res.ok ? 'ready' : 'invalid',
        message:
          typeof data.message === 'string' && data.message.trim()
            ? data.message
            : res.ok
              ? 'Configuracao validada.'
              : 'Falha ao validar a configuracao.',
        provider: typeof data.provider === 'string' ? data.provider : null,
      });
    } catch {
      setPixTestResult({
        ok: false,
        status: 'invalid',
        message: 'Nao foi possivel validar a configuracao agora.',
      });
    }
    setTestingPixConfig(false);
  };

  const addCupom = async () => {
    if (!novoCupom.codigo.trim()) return;
    setAddingCupom(true);
    try {
      const res = await fetch('/api/delivery/cupons', {
        method:'POST', headers:{...hdrs,'Content-Type':'application/json'},
        body: JSON.stringify({
          codigo:     novoCupom.codigo,
          tipo:       novoCupom.tipo,
          valor:      parseFloat(novoCupom.valor||'0'),
          min_pedido: parseFloat(novoCupom.min_pedido||'0'),
          limite_uso: novoCupom.limite_uso ? parseInt(novoCupom.limite_uso) : null,
          validade:   novoCupom.validade||null,
        }),
      });
      if (res.ok) {
        setNovoCupom({ codigo:'', tipo:'percentual', valor:'', min_pedido:'', limite_uso:'', validade:'' });
        const r = await fetch('/api/delivery/cupons', { headers: hdrs });
        if (r.ok) setCupons(await r.json());
      } else { const e = await res.json(); alert(e.error); }
    } catch {}
    setAddingCupom(false);
  };

  const toggleCupom = async (id: number, ativo: number) => {
    await fetch(`/api/delivery/cupons/${id}`, {
      method:'PATCH', headers:{...hdrs,'Content-Type':'application/json'},
      body: JSON.stringify({ ativo: ativo?0:1 }),
    });
    setCupons(prev => prev.map(c => c.id===id ? {...c,ativo:ativo?0:1} : c));
  };

  const deleteCupom = async (id: number) => {
    if (!confirm('Excluir cupom?')) return;
    await fetch(`/api/delivery/cupons/${id}`, { method:'DELETE', headers: hdrs });
    setCupons(prev => prev.filter(c => c.id!==id));
  };

  const addZona = () => {
    if (!novaZona.nome.trim()) return;
    setZonas(prev => [...prev, { nome: novaZona.nome.trim(), taxa: parseFloat(novaZona.taxa||'0') }]);
    setNovaZona({ nome:'', taxa:'' });
  };

  if (loading) {
    return (
      <div className="flex justify-center py-10 sm:py-12" role="status" aria-label="Carregando configurações">
        <Spinner className="h-7 w-7" />
      </div>
    );
  }

  const SectionBtn = ({ k, label, icon }: { k: typeof activeSection; label: string; icon: React.ReactNode }) => (
    <button onClick={() => setActiveSection(k)}
      className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all ${activeSection===k ? deliverySecondaryButtonActiveClass : deliverySecondaryButtonInactiveClass}`}>
      {icon}{label}
    </button>
  );

  const LojaSubBtn = ({ id, label }: { id: LojaSubTab; label: string }) => (
    <button
      type="button"
      onClick={() => setLojaSub(id)}
      className={`px-3 py-2 rounded-xl text-xs font-bold transition-all ${
        lojaSub === id
          ? deliverySecondaryButtonActiveClass
          : deliverySecondaryButtonInactiveClass
      }`}
    >
      {label}
    </button>
  );

  const isAutomaticPix = Boolean(cfg.provider_enabled);
  const normalizedPaymentProvider = String(cfg.payment_provider || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const providerSupported =
    !normalizedPaymentProvider ||
    normalizedPaymentProvider === 'mercado_pago' ||
    normalizedPaymentProvider === 'mercadopago' ||
    normalizedPaymentProvider === 'itau';
  const providerLabel =
    normalizedPaymentProvider === 'mercado_pago' || normalizedPaymentProvider === 'mercadopago'
      ? 'Mercado Pago'
      : normalizedPaymentProvider === 'itau'
        ? 'Itaú'
      : (cfg.payment_provider || 'Nao definido');
  const manualPixConfigured = Boolean(
    String(cfg.pix_payload_estatico || '').trim() ||
    String(cfg.pix_chave || '').trim()
  );
  const automaticMissingFields: string[] = [];
  if (isAutomaticPix) {
    if (!normalizedPaymentProvider) automaticMissingFields.push('provider');
    if (normalizedPaymentProvider === 'mercado_pago' || normalizedPaymentProvider === 'mercadopago') {
      if (!String(cfg.access_token || '').trim()) automaticMissingFields.push('access token');
    } else if (normalizedPaymentProvider === 'itau') {
      if (!String(cfg.api_key || '').trim()) automaticMissingFields.push('api_key (client_id)');
      if (!String(cfg.access_token || '').trim()) automaticMissingFields.push('access_token (client_secret)');
      if (!String(cfg.pix_key || '').trim()) automaticMissingFields.push('pix_key (chave Pix)');
      if (!cfg.provider_sandbox) {
        if (!String(cfg.itau_tls_cert_pem || '').trim()) automaticMissingFields.push('itau_tls_cert_pem');
        if (!String(cfg.itau_tls_key_pem || '').trim()) automaticMissingFields.push('itau_tls_key_pem');
      }
    }
  }

  let pixStatusVariant: 'success' | 'warning' | 'error' | 'info' = 'info';
  let pixStatusLabel = 'QR manual ativo';
  let pixStatusDescription = manualPixConfigured
    ? 'O checkout segue usando o QR manual salvo para pedidos PIX.'
    : 'Selecione QR manual e preencha uma chave Pix ou payload estatico para exibir o QR no checkout.';

  if (isAutomaticPix) {
    if (!providerSupported) {
      pixStatusVariant = 'error';
      pixStatusLabel = 'Provider nao suportado';
      pixStatusDescription = 'Este modo automatico aceita Mercado Pago ou Itaú (por tenant).';
    } else if (automaticMissingFields.length > 0) {
      pixStatusVariant = 'warning';
      pixStatusLabel = 'Integracao incompleta';
      pixStatusDescription = `Faltando: ${automaticMissingFields.join(', ')}.`;
    } else {
      pixStatusVariant = 'success';
      pixStatusLabel = 'Integracao pronta';
      pixStatusDescription = `Novos pedidos PIX vao tentar gerar cobranca automatica via ${providerLabel}.`;
    }
  }

  const normalizedWhatsAppProvider = String(cfg.whatsapp_provider || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const whatsappProviderLabel =
    normalizedWhatsAppProvider === 'evolution_api' || normalizedWhatsAppProvider === 'evolution'
      ? 'Evolution API'
      : (cfg.whatsapp_provider || 'Nao configurado');
  const whatsappAiNumber = String(
    cfg.whatsapp_active_number ||
    cfg.evolution_phone_number ||
    cfg.whatsapp ||
    ''
  ).trim();
  const whatsappAiInstance = String(cfg.evolution_instance || '').trim();
  const whatsappChannelIdentifier = String(cfg.evolution_channel_id || cfg.evolution_instance || '').trim();
  const whatsappInboundWebhookPath = String(cfg.whatsapp_inbound_webhook_path || '').trim();
  const whatsappConfigured = Boolean(
    String(cfg.evolution_url || '').trim() &&
    String(cfg.evolution_token || '').trim() &&
    whatsappAiInstance
  );

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Seções principais */}
      {!hasStandaloneSection && (
        <div className="flex gap-2 flex-wrap">
          <SectionBtn k="loja"      label="Loja"        icon={<Settings size={14}/>}/>
          <SectionBtn k="zonas"     label="Zonas"       icon={<Map size={14}/>}/>
          <SectionBtn k="cupons"    label="Cupons"      icon={<Tag size={14}/>}/>
        </div>
      )}

      {/* ── LOJA (subdomínios) ───────────────────────────────────── */}
      {activeSection === 'loja' && (
        <div className="bg-fp-card border border-fp-border rounded-2xl p-6 space-y-6">
          <div>
            <h3 className="text-base font-black text-fptext-primary">Configurações da loja</h3>
            <p className="text-xs text-fptext-muted mt-1">Organizado por área do negócio. Os dados continuam no mesmo JSON de sempre — apenas a visualização mudou.</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <LojaSubBtn id="operacao" label="Geral / Operação" />
            <LojaSubBtn id="entrega" label="Entrega" />
            <LojaSubBtn id="financeiro" label="Financeiro" />
            <LojaSubBtn id="pagamentos" label="Pagamentos" />
            <LojaSubBtn id="comunicacao" label="Comunicação" />
            <LojaSubBtn id="aparencia" label="Aparência" />
          </div>

          {lojaSub === 'operacao' && (
            <div className="space-y-5 pt-1 border-t border-zinc-100 dark:border-zinc-800">
              <h4 className="text-sm font-black text-zinc-800 dark:text-zinc-200 flex items-center gap-2"><Clock size={16} className="text-zinc-500"/>Geral / Operação</h4>
              <div className="rounded-2xl border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/10 p-4">
                <p className="font-bold text-blue-900 dark:text-blue-300">Modelo atual da entrega</p>
                <p className="text-xs text-blue-700 dark:text-blue-400 mt-1">
                  O Pratory calcula o delivery por bairro com taxa fixa. A taxa padrão (aba Entrega) entra quando nenhum bairro cadastrado casar com o endereço. Zonas são editadas na aba <strong>Zonas</strong>.
                </p>
              </div>
              <div className="rounded-2xl border border-zinc-200 bg-zinc-50/70 p-4 dark:border-zinc-700 dark:bg-zinc-900/40">
                <div className="flex items-center gap-2 text-sm font-black text-zinc-800 dark:text-zinc-100">
                  <Globe size={16} className="text-zinc-500" />
                  Identidade pública
                </div>
                <div className="mt-3">
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5">Link curto do cardápio</label>
                  <input value={cfg.cardapio_link_curto||''} onChange={e=>setCfg(c=>({...c,cardapio_link_curto:e.target.value}))}
                    placeholder="https://bit.ly/4t1mNgi" className="w-full px-3 py-2.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 text-fptext-primary"/>
                  <p className="mt-1 text-[11px] text-zinc-500">
                    Opcional. Se preenchido, este link será usado como link público principal do cardápio.
                  </p>
                </div>
                <div className="mt-3">
                  <p className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5">Link público principal</p>
                  <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm text-fptext-primary dark:border-zinc-700 dark:bg-zinc-800">
                    <span className="font-mono break-all">{preferredCardapioPublicUrl || '—'}</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-bold text-zinc-800 dark:text-zinc-200">Delivery ativo</p>
                  <p className="text-xs text-zinc-400">Permite receber pedidos online</p>
                </div>
                <button onClick={() => setCfg(c=>({...c,ativo:!c.ativo}))}
                  className={`w-12 h-6 rounded-full transition-all relative ${cfg.ativo?'bg-emerald-500':'bg-zinc-200'}`}>
                  <span className={`absolute top-0.5 w-5 h-5 bg-white dark:bg-zinc-200 rounded-full shadow transition-all ${cfg.ativo?'left-6':'left-0.5'}`}/>
                </button>
              </div>

              <div className="rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-amber-50/80 dark:bg-amber-500/10 p-4 space-y-4">
                <div className="flex items-start gap-2">
                  <ChefHat size={18} className="text-amber-700 dark:text-amber-300 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-bold text-fptext-primary text-sm">Automação operacional</p>
                    <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5 leading-relaxed">
                      Impressão automática usa a impressora de cozinha (perfil cozinha). Aceite automático só vale para pedidos criados pelo cardápio online. Eventos ficam no histórico do pedido (Pedidos) e em sinais no painel.
                    </p>
                  </div>
                </div>
                {([
                  { key: 'delivery_auto_accept_orders' as const, label: 'Delivery: aceitar pedidos automaticamente', hint: 'Cardápio online entra como Pedido Recebido. Fica registrado no pedido; impressão automática (abaixo) só dispara junto se estiver ligada.' },
                  { key: 'delivery_auto_print_production' as const, label: 'Delivery: imprimir produção ao aceitar', hint: 'Ao aceitar (painel), ao criar já aceito (manual) ou na criação online quando o aceite automático está ligado.' },
                  { key: 'balcao_auto_print_production' as const, label: 'Balcão: imprimir produção ao finalizar', hint: 'Pedidos do PDV (consumo no local ou padrão balcão).' },
                  { key: 'consumo_local_auto_print_production' as const, label: 'Consumo local: imprimir produção', hint: 'Quando o PDV envia tipo de retirada “local”.' },
                  { key: 'retirada_auto_print_production' as const, label: 'Retirada / levar: imprimir produção', hint: 'PDV levar ou pedido retirada no cardápio.' },
                  { key: 'mesa_auto_print_production' as const, label: 'Mesa: imprimir ao lançar item', hint: 'Cada inclusão na comanda dispara a cozinha (se houver itens de preparo).' },
                  { key: 'print_production_even_with_kds' as const, label: 'Mesa: imprimir mesmo com KDS ativo', hint: 'Desligado: com pedido KDS na mesa, a auto-impressão não manda térmica (fica registrado). Ligado: imprime mesmo assim.' },
                ]).map((row) => {
                  const merged = { ...DEFAULT_TENANT_AUTOMATION, ...cfg.automation };
                  const on = Boolean(merged[row.key]);
                  return (
                    <div key={row.key} className="flex items-center justify-between gap-3 border-t border-amber-200/60 dark:border-amber-500/20 pt-3 first:border-t-0 first:pt-0">
                      <div className="min-w-0">
                        <p className="font-bold text-sm text-zinc-800 dark:text-zinc-200">{row.label}</p>
                        <p className="text-[11px] text-fptext-muted mt-0.5 leading-snug">{row.hint}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setCfg((c) => ({
                            ...c,
                            automation: { ...DEFAULT_TENANT_AUTOMATION, ...c.automation, [row.key]: !on },
                          }))
                        }
                        className={`w-12 h-6 rounded-full transition-all relative shrink-0 ${on ? 'bg-emerald-500' : 'bg-zinc-200 dark:bg-zinc-600'}`}
                        aria-pressed={on}
                      >
                        <span className={`absolute top-0.5 w-5 h-5 bg-white dark:bg-zinc-200 rounded-full shadow transition-all ${on ? 'left-6' : 'left-0.5'}`} />
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Horário abertura" value={cfg.horario_abertura||''} onChange={v=>setCfg(c=>({...c,horario_abertura:v}))} type="time"/>
                <Field label="Horário fechamento" value={cfg.horario_fechamento||''} onChange={v=>setCfg(c=>({...c,horario_fechamento:v}))} type="time"/>
                <Field label="Tempo de preparo (min)" value={String(cfg.tempo_preparo||'')} onChange={v=>setCfg(c=>({...c,tempo_preparo:parseInt(v)||0}))} type="number" placeholder="40"/>
                <Field label="Pedido mínimo (R$)" value={String(cfg.pedido_minimo||'')} onChange={v=>setCfg(c=>({...c,pedido_minimo:parseFloat(v)||0}))} type="number" placeholder="0"/>
              </div>

              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50/70 dark:bg-zinc-900/40 p-4 space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-black text-zinc-800 dark:text-zinc-100">Horario por dia (2 janelas)</p>
                    <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                      Opcional. Se ativado, permite ate 2 janelas por dia e substitui o horario unico + folga fixa.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCfg((c) => ({ ...c, horarios_semana_ativo: !c.horarios_semana_ativo }))}
                    className={`w-12 h-6 rounded-full transition-all relative shrink-0 ${cfg.horarios_semana_ativo ? 'bg-emerald-500' : 'bg-zinc-200 dark:bg-zinc-600'}`}
                    aria-pressed={Boolean(cfg.horarios_semana_ativo)}
                  >
                    <span className={`absolute top-0.5 w-5 h-5 bg-white dark:bg-zinc-200 rounded-full shadow transition-all ${cfg.horarios_semana_ativo ? 'left-6' : 'left-0.5'}`} />
                  </button>
                </div>

                {cfg.horarios_semana_ativo ? (
                  <div className="space-y-3">
                    {[
                      { value: 1, label: 'Seg' },
                      { value: 2, label: 'Ter' },
                      { value: 3, label: 'Qua' },
                      { value: 4, label: 'Qui' },
                      { value: 5, label: 'Sex' },
                      { value: 6, label: 'Sab' },
                      { value: 0, label: 'Dom' },
                    ].map((dia) => {
                      const scheduleObj =
                        cfg.horarios_semana && typeof cfg.horarios_semana === 'object' && !Array.isArray(cfg.horarios_semana)
                          ? (cfg.horarios_semana as Record<string, any>)
                          : {};
                      const windows = Array.isArray(scheduleObj[String(dia.value)]) ? scheduleObj[String(dia.value)] : [];
                      const closed = windows.length === 0;
                      const w1 = windows[0] && typeof windows[0] === 'object' ? windows[0] : {};
                      const w2 = windows[1] && typeof windows[1] === 'object' ? windows[1] : {};

                      const setWindowField = (idx: number, key: 'abertura' | 'fechamento', value: string) => {
                        setCfg((c) => {
                          const prevObj =
                            c.horarios_semana && typeof c.horarios_semana === 'object' && !Array.isArray(c.horarios_semana)
                              ? (c.horarios_semana as Record<string, any>)
                              : {};
                          const prevDay = Array.isArray(prevObj[String(dia.value)]) ? [...prevObj[String(dia.value)]] : [];
                          while (prevDay.length <= idx) prevDay.push({ abertura: '', fechamento: '' });
                          prevDay[idx] = { ...(prevDay[idx] || {}), [key]: value };
                          return {
                            ...c,
                            horarios_semana: {
                              ...prevObj,
                              [String(dia.value)]: prevDay.slice(0, 2),
                            },
                          };
                        });
                      };

                      const setClosed = (nextClosed: boolean) => {
                        setCfg((c) => {
                          const prevObj =
                            c.horarios_semana && typeof c.horarios_semana === 'object' && !Array.isArray(c.horarios_semana)
                              ? (c.horarios_semana as Record<string, any>)
                              : {};
                          return {
                            ...c,
                            horarios_semana: {
                              ...prevObj,
                              [String(dia.value)]: nextClosed ? [] : [{ abertura: '', fechamento: '' }],
                            },
                          };
                        });
                      };

                      return (
                        <div key={dia.value} className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white/70 dark:bg-zinc-900/20 p-3 space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-sm font-black text-zinc-800 dark:text-zinc-100">{dia.label}</p>
                            <button
                              type="button"
                              onClick={() => setClosed(!closed)}
                              className={`min-h-[36px] rounded-xl border px-3 py-2 text-xs font-bold transition-colors shrink-0 ${
                                closed
                                  ? 'border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:border-zinc-500'
                                  : 'border-rose-400 bg-rose-100 text-rose-900 dark:border-rose-500/50 dark:bg-rose-500/20 dark:text-rose-100'
                              }`}
                            >
                              {closed ? 'Fechado' : 'Aberto'}
                            </button>
                          </div>

                          <div className={`grid grid-cols-1 gap-3 ${closed ? 'opacity-50' : ''} sm:grid-cols-2`}>
                            <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-3">
                              <p className="text-[11px] font-black text-zinc-500 uppercase tracking-wider">Janela 1</p>
                              <div className="mt-2 grid grid-cols-2 gap-2">
                                <input type="time" disabled={closed} value={String(w1.abertura || '')} onChange={e=>setWindowField(0,'abertura',e.target.value)}
                                  className="w-full px-3 py-2 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 text-fptext-primary"/>
                                <input type="time" disabled={closed} value={String(w1.fechamento || '')} onChange={e=>setWindowField(0,'fechamento',e.target.value)}
                                  className="w-full px-3 py-2 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 text-fptext-primary"/>
                              </div>
                            </div>
                            <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-3">
                              <p className="text-[11px] font-black text-zinc-500 uppercase tracking-wider">Janela 2</p>
                              <div className="mt-2 grid grid-cols-2 gap-2">
                                <input type="time" disabled={closed} value={String(w2.abertura || '')} onChange={e=>setWindowField(1,'abertura',e.target.value)}
                                  className="w-full px-3 py-2 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 text-fptext-primary"/>
                                <input type="time" disabled={closed} value={String(w2.fechamento || '')} onChange={e=>setWindowField(1,'fechamento',e.target.value)}
                                  className="w-full px-3 py-2 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 text-fptext-primary"/>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50/70 dark:bg-zinc-900/40 p-4 space-y-3">
                <div>
                  <p className="text-sm font-black text-zinc-800 dark:text-zinc-100">Folga fixa na semana</p>
                  <p className="text-xs text-zinc-500 mt-1">Marque os dias em que o cardápio online fica fechado (ex.: quarta e domingo). Mesmo horário que você configurar acima: nesses dias não aceita pedido.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {[
                    { value: 1, label: 'Seg' },
                    { value: 2, label: 'Ter' },
                    { value: 3, label: 'Qua' },
                    { value: 4, label: 'Qui' },
                    { value: 5, label: 'Sex' },
                    { value: 6, label: 'Sáb' },
                    { value: 0, label: 'Dom' },
                  ].map((dia) => {
                    const marcados = new Set<number>(cfg.dias_folga_entrega || []);
                    const on = marcados.has(dia.value);
                    return (
                      <button
                        key={dia.value}
                        type="button"
                        onClick={() =>
                          setCfg((c) => {
                            const s = new Set<number>(c.dias_folga_entrega || []);
                            if (s.has(dia.value)) s.delete(dia.value);
                            else s.add(dia.value);
                            return { ...c, dias_folga_entrega: Array.from(s).sort((a, b) => a - b) };
                          })
                        }
                        className={`min-h-[40px] rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${
                          on
                            ? 'border-rose-400 bg-rose-100 text-rose-900 dark:border-rose-500/50 dark:bg-rose-500/20 dark:text-rose-100'
                            : 'border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:border-zinc-500'
                        }`}
                      >
                        {dia.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {lojaSub === 'entrega' && (
            <div className="space-y-5 pt-1 border-t border-zinc-100 dark:border-zinc-800">
              <h4 className="text-sm font-black text-zinc-800 dark:text-zinc-200 flex items-center gap-2"><Truck size={16} className="text-zinc-500"/>Entrega (logística)</h4>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Taxa padrão (R$)" value={String(cfg.taxa_entrega||'')} onChange={v=>setCfg(c=>({...c,taxa_entrega:parseFloat(v)||0}))} type="number" placeholder="0"/>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5">Valor por entrega (motoboy) R$</label>
                  <input type="number" value={cfg.valor_por_entrega||''} onChange={e=>setCfg(c=>({...c,valor_por_entrega:parseFloat(e.target.value)||0}))}
                    placeholder="0" className="w-full px-3 py-2.5 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 text-fptext-primary"/>
                </div>
              </div>
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 p-4 space-y-2">
                <p className="text-sm font-bold text-zinc-800 dark:text-zinc-200">Zonas (bairros e taxas)</p>
                <p className="text-xs text-zinc-500 leading-relaxed">
                  Cadastre bairros com taxa fixa na aba <strong>Zonas</strong>. Se o bairro do cliente não casar, usa a taxa padrão acima.
                </p>
                <button type="button" onClick={() => { setActiveSection('zonas'); }}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-xs font-bold hover:opacity-90">
                  Abrir aba Zonas <ChevronRight size={14}/>
                </button>
              </div>
            </div>
          )}

          {lojaSub === 'financeiro' && (
            <div className="space-y-5 pt-1 border-t border-zinc-100 dark:border-zinc-800">
              <h4 className="text-sm font-black text-zinc-800 dark:text-zinc-200 flex items-center gap-2"><DollarSign size={16} className="text-zinc-500"/>Financeiro</h4>
              <Field label="Desconto Pix (%)" value={String(cfg.desconto_pix||'')} onChange={v=>setCfg(c=>({...c,desconto_pix:parseFloat(v)||0}))} type="number" placeholder="0"/>
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 p-4 space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="font-bold text-zinc-800 dark:text-zinc-200">Desconto automático de primeira compra</p>
                    <p className="text-xs text-zinc-500">Calculado no backend na primeira compra válida.</p>
                  </div>
                  <button
                    onClick={() => setCfg(c=>({...c,desconto_primeiro_cliente_ativo:!c.desconto_primeiro_cliente_ativo}))}
                    className={`w-12 h-6 rounded-full transition-all relative ${cfg.desconto_primeiro_cliente_ativo?'bg-emerald-500':'bg-zinc-200'}`}
                  >
                    <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${cfg.desconto_primeiro_cliente_ativo?'left-6':'left-0.5'}`}/>
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5">Tipo do desconto</label>
                    <select
                      value={cfg.desconto_primeiro_cliente_tipo || 'percentual'}
                      disabled={!cfg.desconto_primeiro_cliente_ativo}
                      onChange={e=>setCfg(c=>({...c,desconto_primeiro_cliente_tipo:e.target.value as DeliveryConfig['desconto_primeiro_cliente_tipo']}))}
                      className="w-full px-3 py-2.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 disabled:bg-zinc-100 dark:disabled:bg-zinc-800 disabled:text-zinc-400 text-fptext-primary"
                    >
                      <option value="percentual">% Percentual</option>
                      <option value="fixo">R$ Valor fixo</option>
                      <option value="frete_gratis">Frete grátis</option>
                    </select>
                  </div>
                  {cfg.desconto_primeiro_cliente_tipo !== 'frete_gratis' ? (
                    <Field
                      label={cfg.desconto_primeiro_cliente_tipo === 'fixo' ? 'Valor do desconto (R$)' : 'Valor do desconto (%)'}
                      value={String(cfg.desconto_primeiro_cliente_valor||'')}
                      onChange={v=>setCfg(c=>({...c,desconto_primeiro_cliente_valor:parseFloat(v)||0}))}
                      type="number"
                      placeholder="0"
                    />
                  ) : (
                    <div className="rounded-xl border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-700 dark:text-emerald-300 flex items-center">
                      O frete da primeira compra será zerado quando houver taxa.
                    </div>
                  )}
                  <Field
                    label="Pedido mínimo para aplicar (R$)"
                    value={String(cfg.desconto_primeiro_cliente_min_pedido||'')}
                    onChange={v=>setCfg(c=>({...c,desconto_primeiro_cliente_min_pedido:parseFloat(v)||0}))}
                    type="number"
                    placeholder="0"
                  />
                </div>
              </div>
            </div>
          )}

          {lojaSub === 'pagamentos' && (
            <div className="space-y-5 pt-1 border-t border-zinc-100 dark:border-zinc-800">
              <h4 className="text-sm font-black text-zinc-800 dark:text-zinc-200 flex items-center gap-2"><CreditCard size={16} className="text-zinc-500"/>Pagamentos</h4>
              <div className="rounded-2xl border border-blue-200 dark:border-blue-500/30 bg-blue-50/80 dark:bg-blue-500/10 p-4 space-y-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <p className="text-xs font-black uppercase tracking-wider text-blue-900 dark:text-blue-300">Modo atual do PIX</p>
                    <p className="text-sm font-black text-zinc-900 dark:text-zinc-100 mt-1">{isAutomaticPix ? 'PIX automático' : 'QR manual'}</p>
                    <p className="text-[11px] text-blue-900/80 dark:text-blue-100/80 mt-1">
                      {isAutomaticPix
                        ? 'O Pratory tenta gerar o PIX do pedido usando o provider configurado.'
                        : 'O checkout mostra o QR manual salvo para o cliente pagar.'}
                    </p>
                  </div>
                  <StatusChip variant={pixStatusVariant} size="md" rounded="xl" uppercase={false} emphasis="bold">
                    {pixStatusLabel}
                  </StatusChip>
                </div>
                <p className="text-[11px] text-zinc-600 dark:text-zinc-300">{pixStatusDescription}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setCfg(c => ({ ...c, provider_enabled: false }))}
                    className={`rounded-2xl border p-4 text-left transition-all ${
                      !isAutomaticPix
                        ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                        : 'border-zinc-200 bg-white text-zinc-800 hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:border-zinc-600'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-black text-sm">QR manual</span>
                      {!isAutomaticPix ? <CheckCircle2 size={16} /> : <Smartphone size={16} />}
                    </div>
                    <p className={`text-[11px] mt-2 ${!isAutomaticPix ? 'text-white/80 dark:text-zinc-700' : 'text-zinc-500 dark:text-zinc-400'}`}>
                      Usa chave Pix ou payload estático já salvo no checkout.
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setCfg(c => ({ ...c, provider_enabled: true }))}
                    className={`rounded-2xl border p-4 text-left transition-all ${
                      isAutomaticPix
                        ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                        : 'border-zinc-200 bg-white text-zinc-800 hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:border-zinc-600'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-black text-sm">PIX automático</span>
                      {isAutomaticPix ? <CheckCircle2 size={16} /> : <RefreshCw size={16} />}
                    </div>
                    <p className={`text-[11px] mt-2 ${isAutomaticPix ? 'text-white/80 dark:text-zinc-700' : 'text-zinc-500 dark:text-zinc-400'}`}>
                      Gera cobrança Pix automaticamente nos novos pedidos.
                    </p>
                  </button>
                </div>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  Alternar o modo não apaga o QR manual nem as credenciais do provider já salvas.
                </p>
              </div>

              {!isAutomaticPix && (
                <div className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60 p-4 space-y-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <p className="text-sm font-black text-zinc-900 dark:text-zinc-100">QR manual</p>
                      <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1">
                        Mesmo fluxo atual do checkout público. Preencha a chave Pix ou o payload fixo.
                      </p>
                    </div>
                    <StatusChip
                      variant={manualPixConfigured ? 'success' : 'warning'}
                      size="md"
                      rounded="xl"
                      uppercase={false}
                      emphasis="bold"
                    >
                      {manualPixConfigured ? 'QR manual configurado' : 'QR manual incompleto'}
                    </StatusChip>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Chave Pix" value={cfg.pix_chave||''} onChange={v=>setCfg(c=>({...c,pix_chave:v}))} placeholder="email@ou.cpf"/>
                    <Field label="Nome Pix" value={cfg.pix_nome||''} onChange={v=>setCfg(c=>({...c,pix_nome:v}))} placeholder="Nome do recebedor"/>
                    <Field label="Cidade Pix" value={cfg.pix_cidade||''} onChange={v=>setCfg(c=>({...c,pix_cidade:v}))} placeholder="Cidade"/>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5">Payload PIX estático (QR Code fixo)</label>
                    <textarea
                      value={cfg.pix_payload_estatico||''}
                      onChange={e=>setCfg(c=>({...c,pix_payload_estatico:e.target.value}))}
                      placeholder="00020126580014BR.GOV.BCB.PIX..."
                      rows={3}
                      className="w-full px-3 py-2.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-xs font-mono focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 text-fptext-primary resize-none"
                    />
                    <p className="text-[10px] text-zinc-400 mt-1">
                      Quando preenchido, o cliente vê o QR com o valor do carrinho, como hoje.
                    </p>
                  </div>
                </div>
              )}

              {isAutomaticPix && (
                <div className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60 p-4 space-y-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <p className="text-sm font-black text-zinc-900 dark:text-zinc-100">PIX automático</p>
                      <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1">
                        As credenciais abaixo são usadas para gerar o PIX automático sem alterar o restante da configuração.
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <StatusChip variant={providerSupported ? 'info' : 'error'} size="md" rounded="xl" uppercase={false} emphasis="bold">
                        Provider: {providerLabel}
                      </StatusChip>
                      <StatusChip variant={cfg.provider_sandbox ? 'warning' : 'success'} size="md" rounded="xl" uppercase={false} emphasis="bold">
                        {cfg.provider_sandbox ? 'Sandbox' : 'Produção'}
                      </StatusChip>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5">Provider</label>
                      <select
                        value={
                          normalizedPaymentProvider === 'mercadopago'
                            ? 'mercado_pago'
                            : normalizedPaymentProvider || ''
                        }
                        onChange={(e) =>
                          setCfg((c) => ({
                            ...c,
                            payment_provider: e.target.value || '',
                          }))
                        }
                        className="w-full px-3 py-2.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 text-fptext-primary"
                      >
                        <option value="">Selecione</option>
                        <option value="mercado_pago">Mercado Pago</option>
                        <option value="itau">Itaú</option>
                      </select>
                      <p className="text-[10px] text-zinc-400 mt-1 leading-snug">
                        Mercado Pago permanece inalterado; Itaú só impacta tenants com provider=itau.
                      </p>
                    </div>
                    <Field
                      label={normalizedPaymentProvider === 'itau' ? 'pix_key (chave Pix)' : 'pix_key'}
                      value={cfg.pix_key||''}
                      onChange={v=>setCfg(c=>({...c,pix_key:v}))}
                      placeholder={normalizedPaymentProvider === 'itau' ? 'Chave Pix (DICT) do recebedor' : 'Chave PIX do provider'}
                    />
                    <Field
                      label={normalizedPaymentProvider === 'itau' ? 'api_key (client_id)' : 'api_key'}
                      value={cfg.api_key||''}
                      onChange={v=>setCfg(c=>({...c,api_key:v}))}
                      type="password"
                      placeholder={normalizedPaymentProvider === 'itau' ? 'Client ID do Itaú' : 'Opcional'}
                    />
                    <Field
                      label={normalizedPaymentProvider === 'itau' ? 'access_token (client_secret)' : 'Access token'}
                      value={cfg.access_token||''}
                      onChange={v=>setCfg(c=>({...c,access_token:v}))}
                      type="password"
                      placeholder={normalizedPaymentProvider === 'itau' ? 'Client Secret do Itaú' : 'Obrigatório para Mercado Pago'}
                    />
                    <Field
                      label={normalizedPaymentProvider === 'itau' ? 'webhook_secret (opcional)' : 'webhook_secret'}
                      value={cfg.webhook_secret||''}
                      onChange={v=>setCfg(c=>({...c,webhook_secret:v}))}
                      type="password"
                      placeholder="Opcional"
                    />
                    {normalizedPaymentProvider === 'itau' && !cfg.provider_sandbox && (
                      <>
                        <div className="sm:col-span-2">
                          <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5">itau_tls_cert_pem (produção)</label>
                          <textarea
                            value={cfg.itau_tls_cert_pem||''}
                            onChange={e=>setCfg(c=>({...c,itau_tls_cert_pem:e.target.value}))}
                            placeholder="Cole o certificado PEM ou informe o caminho do arquivo (.pem/.crt)"
                            rows={3}
                            className="w-full px-3 py-2.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-xs font-mono focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 text-fptext-primary resize-none"
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5">itau_tls_key_pem (produção)</label>
                          <textarea
                            value={cfg.itau_tls_key_pem||''}
                            onChange={e=>setCfg(c=>({...c,itau_tls_key_pem:e.target.value}))}
                            placeholder="Cole a chave privada PEM ou informe o caminho do arquivo (.pem/.key)"
                            rows={3}
                            className="w-full px-3 py-2.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-xs font-mono focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 text-fptext-primary resize-none"
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5">itau_tls_ca_pem (opcional)</label>
                          <textarea
                            value={cfg.itau_tls_ca_pem||''}
                            onChange={e=>setCfg(c=>({...c,itau_tls_ca_pem:e.target.value}))}
                            placeholder="Opcional (CA chain). Cole o PEM ou informe caminho do arquivo."
                            rows={2}
                            className="w-full px-3 py-2.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-xs font-mono focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 text-fptext-primary resize-none"
                          />
                        </div>
                        <Field
                          label="itau_api_base_url (opcional)"
                          value={cfg.itau_api_base_url||''}
                          onChange={v=>setCfg(c=>({...c,itau_api_base_url:v}))}
                          placeholder="Override do base URL da API Pix Recebimentos"
                        />
                        <Field
                          label="itau_token_url (opcional)"
                          value={cfg.itau_token_url||''}
                          onChange={v=>setCfg(c=>({...c,itau_token_url:v}))}
                          placeholder="Override do token URL (OAuth2)"
                        />
                      </>
                    )}
                    <div>
                      <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5">Ambiente</label>
                      <select
                        value={cfg.provider_sandbox ? 'sandbox' : 'production'}
                        onChange={e=>setCfg(c=>({...c,provider_sandbox:e.target.value === 'sandbox'}))}
                        className="w-full px-3 py-2.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 text-fptext-primary"
                      >
                        <option value="production">Produção</option>
                        <option value="sandbox">Sandbox</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <button
                      type="button"
                      onClick={testPixConfig}
                      disabled={testingPixConfig}
                      className="inline-flex items-center gap-2 rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
                    >
                      <RefreshCw size={14} className={testingPixConfig ? 'animate-spin' : ''} />
                      {testingPixConfig ? 'Validando...' : 'Testar configuração'}
                    </button>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      Teste simples e seguro: valida o modo automático e os campos obrigatórios sem gerar cobrança real.
                    </p>
                  </div>
                  {pixTestResult && (
                    <div className={`rounded-xl border px-3 py-3 text-sm ${
                      pixTestResult.ok
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200'
                        : 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200'
                    }`}>
                      <div className="flex items-center gap-2 font-bold">
                        {pixTestResult.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                        {pixTestResult.ok ? 'Teste concluído' : 'Ajuste necessário'}
                      </div>
                      <p className="mt-1 text-xs leading-relaxed">{pixTestResult.message}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {false && lojaSub === 'pagamentos' && (
            <div className="space-y-5 pt-1 border-t border-zinc-100 dark:border-zinc-800">
              <h4 className="text-sm font-black text-zinc-800 dark:text-zinc-200 flex items-center gap-2"><CreditCard size={16} className="text-zinc-500"/>Pagamentos</h4>
              <div className="rounded-2xl border border-blue-200 dark:border-blue-500/30 bg-blue-50/80 dark:bg-blue-500/10 p-4 space-y-2">
                <p className="text-sm font-black text-blue-950 dark:text-blue-300">PIX automÃ¡tico (preparaÃ§Ã£o)</p>
                <p className="text-[11px] text-blue-800/80 dark:text-blue-200/80">
                  O QR manual abaixo continua valendo normalmente. Esta Ã¡rea apenas salva credenciais e preferÃªncias por tenant para uma integraÃ§Ã£o futura.
                </p>
                <div className="flex items-center justify-between gap-4 pt-1">
                  <div>
                    <p className="font-bold text-zinc-800 dark:text-zinc-200">provider_enabled</p>
                    <p className="text-[11px] text-zinc-500">Liga ou desliga o provider automÃ¡tico quando ele existir.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCfg(c=>({...c,provider_enabled:!c.provider_enabled}))}
                    className={`w-12 h-6 rounded-full transition-all relative shrink-0 ${cfg.provider_enabled?'bg-emerald-500':'bg-zinc-200 dark:bg-zinc-600'}`}
                    aria-pressed={!!cfg.provider_enabled}
                  >
                    <span className={`absolute top-0.5 w-5 h-5 bg-white dark:bg-zinc-200 rounded-full shadow transition-all ${cfg.provider_enabled?'left-6':'left-0.5'}`}/>
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="payment_provider" value={cfg.payment_provider||''} onChange={v=>setCfg(c=>({...c,payment_provider:v}))} placeholder="mercadopago"/>
                  <Field label="pix_key" value={cfg.pix_key||''} onChange={v=>setCfg(c=>({...c,pix_key:v}))} placeholder="Chave PIX do provider"/>
                  <Field label="api_key" value={cfg.api_key||''} onChange={v=>setCfg(c=>({...c,api_key:v}))} type="password" placeholder="Opcional"/>
                  <Field label="access_token" value={cfg.access_token||''} onChange={v=>setCfg(c=>({...c,access_token:v}))} type="password" placeholder="Opcional"/>
                  <Field label="webhook_secret" value={cfg.webhook_secret||''} onChange={v=>setCfg(c=>({...c,webhook_secret:v}))} type="password" placeholder="Opcional"/>
                  <div>
                    <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5">Ambiente</label>
                    <select
                      value={cfg.provider_sandbox ? 'sandbox' : 'production'}
                      onChange={e=>setCfg(c=>({...c,provider_sandbox:e.target.value === 'sandbox'}))}
                      className="w-full px-3 py-2.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 text-fptext-primary"
                    >
                      <option value="production">ProduÃ§Ã£o</option>
                      <option value="sandbox">Sandbox</option>
                    </select>
                  </div>
                </div>
              </div>
              <p className="text-xs text-zinc-500">Mesma lógica de Pix do checkout público (payload estático ou chave + EMV). Não altere sem testar o fechamento do pedido.</p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Chave Pix" value={cfg.pix_chave||''} onChange={v=>setCfg(c=>({...c,pix_chave:v}))} placeholder="email@ou.cpf"/>
                <Field label="Nome Pix" value={cfg.pix_nome||''} onChange={v=>setCfg(c=>({...c,pix_nome:v}))} placeholder="Nome do recebedor"/>
                <Field label="Cidade Pix" value={cfg.pix_cidade||''} onChange={v=>setCfg(c=>({...c,pix_cidade:v}))} placeholder="Cidade"/>
              </div>
              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5">Payload PIX estático (QR Code fixo)</label>
                <textarea
                  value={cfg.pix_payload_estatico||''}
                  onChange={e=>setCfg(c=>({...c,pix_payload_estatico:e.target.value}))}
                  placeholder="00020126580014BR.GOV.BCB.PIX..."
                  rows={3}
                  className="w-full px-3 py-2.5 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-xs font-mono focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 text-fptext-primary resize-none"
                />
                <p className="text-[10px] text-zinc-400 mt-1">
                  Quando preenchido, o cliente vê o QR com o valor do carrinho (mesma rotina de sempre).
                </p>
              </div>
            </div>
          )}

          {lojaSub === 'comunicacao' && (
            <div className="space-y-5 pt-1 border-t border-zinc-100 dark:border-zinc-800">
              <h4 className="text-sm font-black text-zinc-800 dark:text-zinc-200 flex items-center gap-2"><MessageCircle size={16} className="text-zinc-500"/>Comunicação</h4>
              <p className="text-xs text-zinc-500">WhatsApp usado nos links do cardápio e confirmações. Mensagens automáticas futuras podem usar este número como referência.</p>
              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5">WhatsApp do restaurante</label>
                <input value={cfg.whatsapp||''} onChange={e=>setCfg(c=>({...c,whatsapp:e.target.value}))}
                  placeholder="55119XXXXXXXX" className="w-full px-3 py-2.5 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 text-fptext-primary"/>
              </div>
            </div>
          )}

          {lojaSub === 'aparencia' && (
            <div className="space-y-5 pt-1 border-t border-zinc-100 dark:border-zinc-800">
              <h4 className="text-sm font-black text-zinc-800 dark:text-zinc-200 flex items-center gap-2"><Palette size={16} className="text-zinc-500"/>Aparência da loja</h4>
              <p className="text-xs text-zinc-500">Visual do cardápio online público. Tema e textos abaixo: use Salvar no fim da página. Logo e banners são gravados ao enviar ou remover.</p>
              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5">Tema do cardápio</label>
                <select
                  value={cfg.theme_mode === 'light_red' ? 'light_red' : 'dark_premium'}
                  onChange={e => setCfg(c => ({ ...c, theme_mode: e.target.value as 'dark_premium' | 'light_red' }))}
                  className="w-full px-3 py-2.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm focus:outline-none focus:border-zinc-400 text-fptext-primary"
                >
                  <option value="dark_premium">Dark premium (padrão atual)</option>
                  <option value="light_red">Claro com vermelho (light red)</option>
                </select>
              </div>

              <input ref={logoFileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={onCardapioLogoFile} />

              <div>
                <p className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1">Logo do cardápio online</p>
                <p className="text-[11px] text-fptext-muted mb-3">Opcional. Sem logo aqui, o cardápio usa a imagem de Configurações (identidade da loja).</p>
                <div className="flex flex-wrap items-start gap-4">
                  <div className="h-24 w-24 shrink-0 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-800 flex items-center justify-center">
                    {cfg.cardapio_online_logo_url || fallbackLogoUrl ? (
                      <img
                        src={cfg.cardapio_online_logo_url || fallbackLogoUrl || ''}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <Image size={28} className="text-zinc-400" aria-hidden />
                    )}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    {!cfg.cardapio_online_logo_url && fallbackLogoUrl ? (
                      <p className="text-[11px] text-zinc-500">Preview: logo padrão da loja (Configurações).</p>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={cvBusy === 'logo'}
                        onClick={() => logoFileRef.current?.click()}
                        className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-bold text-zinc-800 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
                      >
                        <Upload size={14} />
                        {cvBusy === 'logo' ? 'Enviando…' : 'Enviar logo'}
                      </button>
                      {cfg.cardapio_online_logo_url ? (
                        <button
                          type="button"
                          disabled={cvBusy === 'logo'}
                          onClick={removeCardapioLogo}
                          className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
                        >
                          <Trash2 size={14} />
                          Remover logo do cardápio
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <p className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1">Banners do topo (4 imagens)</p>
                <p className="text-[11px] text-fptext-muted mb-3">Cada quadrante do topo do cardápio. Vazio = fotos de destaque ou logo, como antes.</p>
                <div className="grid grid-cols-2 gap-3 sm:max-w-md">
                  {[...normalizeCardapioOnlineBannerSlots(cfg.cardapio_online_banner_urls)].map((url, idx) => (
                    <div
                      key={idx}
                      className="overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800"
                    >
                      <input
                        ref={(el) => {
                          bannerInputRefs.current[idx] = el;
                        }}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="sr-only"
                        aria-hidden
                        tabIndex={-1}
                        onChange={(ev) => handleBannerUpload(idx, ev)}
                      />
                      <div className="relative aspect-[4/3] w-full bg-zinc-200 dark:bg-zinc-900">
                        {url ? (
                          <img src={url} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-zinc-400">
                            <Image size={22} aria-hidden />
                            <span className="text-[10px] font-bold uppercase tracking-wide">Slot {idx + 1}</span>
                          </div>
                        )}
                      </div>
                      <div className="flex gap-1 p-2">
                        <button
                          type="button"
                          disabled={cvBusy === idx}
                          onClick={() => bannerInputRefs.current[idx]?.click()}
                          className="flex-1 rounded-lg bg-zinc-900 py-1.5 text-[10px] font-black text-white dark:bg-zinc-100 dark:text-zinc-900 disabled:opacity-50"
                        >
                          {cvBusy === idx ? '…' : 'Trocar'}
                        </button>
                        <button
                          type="button"
                          disabled={cvBusy === idx || !url}
                          onClick={() => removeBannerSlot(idx)}
                          className="rounded-lg border border-zinc-200 px-2 py-1.5 text-[10px] font-bold text-zinc-600 disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300"
                        >
                          Remover
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {slug && (
                <div className="bg-zinc-50 dark:bg-zinc-800 rounded-xl p-3">
                  <p className="text-[10px] font-black text-fptext-muted uppercase tracking-wider mb-1">Link do cardápio</p>
                  <p className="text-xs text-zinc-600 dark:text-zinc-400 font-mono">{window.location.origin}/delivery/{slug}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── ZONAS ─────────────────────────────────────────────────── */}
      {activeSection === 'zonas' && (
        <div className="bg-white border border-zinc-200 rounded-2xl p-6 space-y-4">
          <div>
            <h3 className="text-base font-black text-fptext-primary">Bairros e taxas fixas</h3>
            <p className="text-xs text-zinc-400 mt-0.5">Com bairros cadastrados aqui, o cardápio só aceita entrega se o bairro do cliente casar com uma zona (comparação inteligente de nome). Fora disso, o cliente precisa escolher retirada. Se você não cadastrar nenhuma zona, continua valendo só a taxa padrão de entrega. Sem km/raio nesta fase.</p>
          </div>

          {/* Lista de zonas */}
          {zonas.length > 0 && (
            <div className="space-y-2">
              {zonas.map((z,i) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-zinc-50 dark:bg-zinc-800 rounded-xl">
                  <span className="flex-1 font-medium text-zinc-800 dark:text-zinc-200 text-sm">{z.nome}</span>
                  <span className="text-sm text-zinc-500">{fmt(z.taxa)}</span>
                  <button onClick={() => setZonas(prev=>prev.filter((_,j)=>j!==i))}
                    className="p-1.5 hover:bg-red-50 dark:hover:bg-red-500/20 text-red-500 dark:text-red-400 rounded-lg transition-colors">
                    <Trash2 size={13}/>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Adicionar zona */}
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1">Bairro atendido</label>
              <input value={novaZona.nome} onChange={e=>setNovaZona(v=>({...v,nome:e.target.value}))}
                placeholder="Ex: Centro, Vila X..."
                className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:border-zinc-400"/>
            </div>
            <div className="w-28">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1">Taxa R$</label>
              <input type="number" value={novaZona.taxa} onChange={e=>setNovaZona(v=>({...v,taxa:e.target.value}))}
                placeholder="0"
                className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:border-zinc-400"/>
            </div>
            <button onClick={addZona}
              className="flex items-center gap-1.5 px-4 py-2.5 bg-zinc-900 text-white rounded-xl text-sm font-bold hover:bg-zinc-700 transition-colors flex-shrink-0">
              <Plus size={14}/> Adicionar
            </button>
          </div>
          {zonas.length===0&&<p className="text-xs text-zinc-400">Nenhuma zona cadastrada: a taxa padrão de entrega vale para qualquer bairro informado no cardápio.</p>}
        </div>
      )}

      {/* ── CUPONS ─────────────────────────────────────────────────── */}
      {activeSection === 'cupons' && (
        <div className="bg-white border border-zinc-200 rounded-2xl p-6 space-y-4">
          <div>
            <h3 className="text-base font-black text-fptext-primary">Cupons de desconto</h3>
            <p className="text-xs text-zinc-400 mt-0.5">Clientes digitam o código no cardápio online para ganhar desconto.</p>
          </div>

          {/* Novo cupom */}
          <div className="bg-zinc-50 dark:bg-zinc-800 rounded-xl p-4 space-y-3 border border-zinc-100 dark:border-zinc-700">
            <p className="text-xs font-black text-zinc-500 uppercase tracking-wider">Novo cupom</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1">Código</label>
                <input value={novoCupom.codigo} onChange={e=>setNovoCupom(v=>({...v,codigo:e.target.value.toUpperCase()}))}
                  placeholder="PROMO10" maxLength={20}
                  className="w-full px-3 py-2 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm font-mono focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 text-fptext-primary"/>
              </div>
              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1">Tipo</label>
                <select value={novoCupom.tipo} onChange={e=>setNovoCupom(v=>({...v,tipo:e.target.value as any}))}
                  className="w-full px-3 py-2 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 text-fptext-primary">
                  <option value="percentual">% Percentual</option>
                  <option value="fixo">R$ Valor fixo</option>
                  <option value="frete_gratis">Frete grátis</option>
                </select>
              </div>
              {novoCupom.tipo !== 'frete_gratis' && (
                <Field label={novoCupom.tipo==='percentual'?'Desconto (%)':'Desconto (R$)'}
                  value={novoCupom.valor} onChange={v=>setNovoCupom(x=>({...x,valor:v}))} type="number" placeholder="0"/>
              )}
              <Field label="Mínimo do pedido R$" value={novoCupom.min_pedido} onChange={v=>setNovoCupom(x=>({...x,min_pedido:v}))} type="number" placeholder="0"/>
              <Field label="Limite de usos (vazio=∞)" value={novoCupom.limite_uso} onChange={v=>setNovoCupom(x=>({...x,limite_uso:v}))} type="number" placeholder="∞"/>
              <Field label="Validade" value={novoCupom.validade} onChange={v=>setNovoCupom(x=>({...x,validade:v}))} type="date"/>
            </div>
            <button onClick={addCupom} disabled={addingCupom||!novoCupom.codigo.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-xl text-sm font-bold hover:bg-zinc-700 transition-colors disabled:opacity-50">
              <Plus size={14}/> {addingCupom?'Salvando...':'Criar cupom'}
            </button>
          </div>

          {/* Lista de cupons */}
          <div className="space-y-2">
            {cupons.length===0 && <p className="text-sm text-zinc-400 text-center py-4">Nenhum cupom criado</p>}
            {cupons.map(c=>(
              <div key={c.id} className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${c.ativo?'bg-white border-zinc-100':'bg-zinc-50 border-zinc-100 opacity-60'}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-black text-zinc-800 dark:text-zinc-200 text-sm">{c.codigo}</span>
                    <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${c.ativo?'bg-emerald-100 text-emerald-700':'bg-zinc-100 text-zinc-500'}`}>
                      {c.ativo?'Ativo':'Inativo'}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    {c.tipo==='percentual'?`${c.valor}% de desconto`:c.tipo==='fixo'?`R$ ${c.valor} de desconto`:'Frete grátis'}
                    {c.min_pedido>0&&` · Mín: ${fmt(c.min_pedido)}`}
                    {c.limite_uso&&` · ${c.uso_atual}/${c.limite_uso} usos`}
                    {c.validade&&` · Válido até ${new Date(c.validade+'T12:00:00').toLocaleDateString('pt-BR')}`}
                  </p>
                </div>
                <button onClick={()=>toggleCupom(c.id,c.ativo)}
                  className={`p-1.5 rounded-lg text-xs font-bold transition-all ${c.ativo?'bg-amber-50 text-amber-600 hover:bg-amber-100':'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'}`}>
                  {c.ativo?'Pausar':'Ativar'}
                </button>
                <button onClick={()=>deleteCupom(c.id)} className="p-1.5 hover:bg-red-50 text-red-400 rounded-lg transition-colors">
                  <Trash2 size={13}/>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── EVOLUTION API (WhatsApp automático) ─────────────────── */}
      {activeSection === 'evolution' && hasStandaloneSection && (
        <div className="space-y-4">
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-xs text-blue-900 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-100">
            <p className="font-bold">Canal de notificações automáticas do pedido</p>
            <p className="mt-1">
              A conexão abaixo define o WhatsApp operacional da loja para envio de notificações automáticas. O fluxo do
              pedido não é alterado nesta etapa.
            </p>
          </div>
          <WhatsAppConnectionPanel token={token} />

          <div className="bg-fp-card border border-fp-border rounded-2xl p-6 space-y-5">
          <div>
            <h3 className="text-base font-black text-fptext-primary flex items-center gap-2"><Zap size={16}/>WhatsApp IA</h3>
            <p className="text-xs text-fptext-muted mt-0.5">
              Canal dedicado para envio e recebimento automatizado via <strong>Evolution API</strong>.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-900/40">
              <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Provider ativo</p>
              <p className="mt-1 text-sm font-black text-zinc-900 dark:text-zinc-100">{whatsappProviderLabel}</p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-900/40">
              <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Número usado pela IA</p>
              <p className="mt-1 text-sm font-black text-zinc-900 dark:text-zinc-100">{whatsappAiNumber || 'Não informado'}</p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-900/40">
              <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Instância ativa</p>
              <p className="mt-1 text-sm font-black text-zinc-900 dark:text-zinc-100">{whatsappAiInstance || 'Não informada'}</p>
            </div>
          </div>

          <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-4 text-xs text-cyan-900 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-100">
            <p className="font-bold">Envio e recebimento usam a mesma configuração</p>
            <p className="mt-1">
              O número e a instância informados abaixo ficam vinculados ao tenant e serão usados pela IA tanto para enviar mensagens quanto para receber o inbound deste tenant.
            </p>
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-xs text-amber-800 space-y-1 dark:bg-amber-500/10 dark:border-amber-500/30 dark:text-amber-100">
            <p className="font-bold">Como configurar a Evolution API:</p>
            <p>1. Instale: <code className="bg-amber-100 px-1 rounded">docker run -d evolutionapi/evolution-api</code></p>
            <p>2. Acesse o painel e crie uma instância com seu número</p>
            <p>3. Cole a URL, token e nome da instância abaixo</p>
            <a href="https://doc.evolution-api.com" target="_blank" rel="noreferrer" className="underline font-bold flex items-center gap-1">
              <Globe size={11}/> Documentação Evolution API
            </a>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5 dark:text-zinc-400">URL da API</label>
              <input value={cfg.evolution_url||''} onChange={e=>setCfg(c=>({...c,evolution_url:e.target.value}))}
                placeholder="https://api.meuservidor.com"
                className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm text-zinc-900 focus:outline-none focus:border-zinc-400 dark:bg-zinc-900/40 dark:border-zinc-700 dark:text-zinc-100 dark:focus:border-zinc-500"/>
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5 dark:text-zinc-400">Token (apikey)</label>
              <input type="password" value={cfg.evolution_token||''} onChange={e=>setCfg(c=>({...c,evolution_token:e.target.value}))}
                placeholder="seu-token-aqui"
                className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm text-zinc-900 focus:outline-none focus:border-zinc-400 dark:bg-zinc-900/40 dark:border-zinc-700 dark:text-zinc-100 dark:focus:border-zinc-500"/>
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5 dark:text-zinc-400">Nome da instância</label>
              <input value={cfg.evolution_instance||''} onChange={e=>setCfg(c=>({...c,evolution_instance:e.target.value}))}
                placeholder="meu-restaurante"
                className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm text-zinc-900 focus:outline-none focus:border-zinc-400 dark:bg-zinc-900/40 dark:border-zinc-700 dark:text-zinc-100 dark:focus:border-zinc-500"/>
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5 dark:text-zinc-400">Número do WhatsApp da IA</label>
              <input value={cfg.evolution_phone_number||''} onChange={e=>setCfg(c=>({...c,evolution_phone_number:e.target.value}))}
                placeholder="5511999999999"
                className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm text-zinc-900 focus:outline-none focus:border-zinc-400 dark:bg-zinc-900/40 dark:border-zinc-700 dark:text-zinc-100 dark:focus:border-zinc-500"/>
              <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                Número exibido como canal ativo deste tenant. Se ficar vazio, o sistema usa o WhatsApp geral da loja apenas como fallback visual.
              </p>
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5 dark:text-zinc-400">Identificador do canal</label>
              <input value={cfg.evolution_channel_id||''} onChange={e=>setCfg(c=>({...c,evolution_channel_id:e.target.value}))}
                placeholder={cfg.evolution_instance||'meu-restaurante'}
                className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm text-zinc-900 focus:outline-none focus:border-zinc-400 dark:bg-zinc-900/40 dark:border-zinc-700 dark:text-zinc-100 dark:focus:border-zinc-500"/>
              <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                Opcional. Se ficar vazio, o sistema usa o nome da instância como identificador do canal.
              </p>
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5 dark:text-zinc-400">Webhook inbound do tenant</label>
              <input value={whatsappInboundWebhookPath} readOnly
                className="w-full px-3 py-2.5 bg-zinc-100 border border-zinc-200 rounded-xl text-sm text-zinc-600 focus:outline-none dark:bg-zinc-900/60 dark:border-zinc-700 dark:text-zinc-300"/>
              <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                Configure este caminho no provider para que a IA receba mensagens neste mesmo tenant.
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-300">
            <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-fp-border bg-fp-card p-3">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-fptext-muted">Notificações automáticas</p>
                <p className="mt-1 text-xs text-fptext-muted">
                  Envia mensagens automáticas quando o pedido for aceito, sair para entrega ou ficar pronto para retirada. Requer o WhatsApp da loja conectado.
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  setCfg((c) => ({
                    ...c,
                    whatsapp_order_notifications_enabled: !Boolean(c.whatsapp_order_notifications_enabled),
                  }))
                }
                className={`relative h-7 w-12 rounded-full transition-colors ${
                  cfg.whatsapp_order_notifications_enabled ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-700'
                }`}
                aria-label="Ativar notificações automáticas por WhatsApp"
              >
                <span
                  className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
                    cfg.whatsapp_order_notifications_enabled ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
            <p><strong>Canal atual:</strong> {whatsappProviderLabel} {whatsappAiNumber ? `- ${whatsappAiNumber}` : ''} {whatsappAiInstance ? `- instancia ${whatsappAiInstance}` : ''}</p>
            <p className="mt-1"><strong>Channel ID:</strong> {whatsappChannelIdentifier || 'Não informado'}</p>
          </div>

          {!whatsappConfigured && (
            <div className="flex items-center gap-2 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl dark:bg-zinc-900/40 dark:border-zinc-700">
              <AlertCircle size={14} className="text-zinc-500 dark:text-zinc-400"/>
              <p className="text-xs font-bold text-zinc-700 dark:text-zinc-200">
                Preencha URL, token e instância para ativar o canal do tenant. O número exibível e o webhook acima ajudam a identificar o canal correto.
              </p>
            </div>
          )}

          {cfg.evolution_url && cfg.evolution_token && cfg.evolution_instance && (
            <div className="flex items-center gap-2 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-xl dark:bg-emerald-500/10 dark:border-emerald-500/30">
              <Check size={14} className="text-emerald-600"/>
              <p className="text-xs font-bold text-emerald-700 dark:text-emerald-200">Evolution API configurada. Mensagens serão enviadas automaticamente.</p>
            </div>
          )}
          </div>
        </div>
      )}

      {/* Botão salvar (exceto cupons que salvam individualmente) */}
      {activeSection !== 'cupons' && (
        <button onClick={save} disabled={saving}
          className="flex items-center gap-2 px-6 py-3 bg-zinc-900 text-white rounded-xl font-bold text-sm hover:bg-zinc-700 transition-all disabled:opacity-50 active:scale-95">
          {saving ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"/>Salvando...</>
            : saved ? <><Check size={16}/>Salvo!</> : 'Salvar configurações'}
        </button>
      )}
    </div>
  );
}

// ─── Utilitário de campo ─────────────────────────────────────────────────────
function Field({ label, value, onChange, type='text', placeholder='' }: {
  label: string; value: string; onChange: (v:string)=>void; type?:string; placeholder?:string;
}) {
  return (
    <div>
      <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5">{label}</label>
      <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
        className="w-full px-3 py-2.5 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 text-fptext-primary"/>
    </div>
  );
}