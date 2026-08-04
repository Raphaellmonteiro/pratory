import React, { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { RefreshCw, LayoutGrid, X, ChevronRight, Clock, Printer, BadgeCheck, ReceiptText, MapPinned, MessageCircle, QrCode, ListTree, ChefHat } from 'lucide-react';
import type { Order } from '../types';
import { Card, Button } from '../components/ui/Card';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import {
  adminOpsInsetPanelClass,
  adminScreenMetaHintClass,
  adminSectionEyebrowClass,
} from '../components/ui/screenChrome';
import {
  canCentralNotifyCustomer,
  canCentralOpenCustomerWhatsApp,
  canCentralOpenMaps,
  canCentralConfirmPayment,
  canCentralPrintCupom,
  canCentralPrintProducao,
  canCentralPrintProof,
  executeCentralConfirmPayment,
  executeCentralPrintAction,
  executeCentralPrimaryAction,
  getCentralCustomerWhatsAppChatUrl,
  getCentralMapsUrl,
  getCentralNotifyCustomerUrl,
  getCentralPrimaryAction,
} from '../utils/orderCentralActions';
import { OrderAutomationBadges, orderHasAutomationBadges } from '../components/OrderAutomationBadges';
import { EmptyState } from '../components/ui/EmptyState';
import { StatusChip } from '../components/ui/StatusChip';
import { Spinner } from '../components/ui/Spinner';
import { getSegCfg } from '../config/segmentos';
import {
  FLOWPDV_CENTRAL_CHANNEL_FILTER_KEY,
  type CentralChannelFilter,
  type CentralColumnId,
  type CentralQuickFilter,
  getCentralOrderKind,
  getOrderAgeMinutes,
  groupOrdersByCentralColumn,
  isOrderFullyPaid,
  isOrderWithoutAssignedMotoboy,
  isPaymentPendingOrder,
  isPendingQrMesaOrder,
  isUrgentOrder,
  normalizeStatusKey,
  passesCentralQuickFilter,
  passesCentralChannelFilter,
} from '../utils/orderCentralBoard';
import {
  getOrderItemDetailText,
  orderHasAnyItemCustomization,
  splitOrderItemDetailLines,
} from '../utils/orderItemDisplay';

const TZ = 'America/Sao_Paulo';
const CENTRAL_ORDERS_LIMIT = 300;
const DARK_NEUTRAL_TONE = 'dark:border-zinc-600 dark:bg-zinc-800/90 dark:text-zinc-100';
const DARK_RED_TONE = 'dark:border-red-400/55 dark:bg-red-500/20 dark:text-red-100';
const DARK_AMBER_TONE = 'dark:border-amber-400/55 dark:bg-amber-500/20 dark:text-amber-100';
const DARK_EMERALD_TONE = 'dark:border-emerald-400/50 dark:bg-emerald-500/20 dark:text-emerald-100';
const DARK_SKY_TONE = 'dark:border-sky-400/50 dark:bg-sky-500/20 dark:text-sky-100';
const DARK_VIOLET_TONE = 'dark:border-violet-400/50 dark:bg-violet-500/20 dark:text-violet-100';
const DARK_ORANGE_TONE = 'dark:border-orange-400/55 dark:bg-orange-500/20 dark:text-orange-100';
const DARK_BLUE_TONE = 'dark:border-blue-400/50 dark:bg-blue-500/20 dark:text-blue-100';
const DARK_GREEN_TONE = 'dark:border-green-400/50 dark:bg-green-500/20 dark:text-green-100';
const DARK_NEUTRAL_BUTTON_TONE = `${DARK_NEUTRAL_TONE} dark:hover:border-zinc-500 dark:hover:bg-zinc-700/90`;
const DARK_EMERALD_BUTTON_TONE = `${DARK_EMERALD_TONE} dark:hover:border-emerald-300/70 dark:hover:bg-emerald-500/30`;
const DARK_AMBER_BUTTON_TONE = `${DARK_AMBER_TONE} dark:hover:border-amber-300/70 dark:hover:bg-amber-500/30`;
const DARK_BLUE_BUTTON_TONE = `${DARK_BLUE_TONE} dark:hover:border-blue-300/70 dark:hover:bg-blue-500/30`;
const DARK_GREEN_BUTTON_TONE = `${DARK_GREEN_TONE} dark:hover:border-green-300/70 dark:hover:bg-green-500/30`;

function getTodayRangeQuery(): { from: string; to: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  const day = `${y}-${m}-${d}`;
  return { from: day, to: day };
}

function formatMoney(value: number) {
  return `R$ ${Number(value || 0).toFixed(2).replace('.', ',')}`;
}

function formatCreatedAtPtBr(createdIso: string | null | undefined): string {
  const raw = String(createdIso ?? '').trim();
  if (!raw) return '—';
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR');
}

function formatElapsed(createdIso: string | null | undefined) {
  const raw = String(createdIso ?? '').trim();
  if (!raw) return '—';
  const t = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T')).getTime();
  if (Number.isNaN(t)) return '—';
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60} min`;
}

function getElapsedMeta(createdIso: string | null | undefined): { label: string; tone: string; dot: string } {
  const raw = String(createdIso ?? '').trim();
  if (!raw) {
    return {
      label: '—',
      tone: `bg-zinc-100 text-zinc-500 border-zinc-200 ${DARK_NEUTRAL_TONE}`,
      dot: 'bg-zinc-400 dark:bg-zinc-300',
    };
  }
  const t = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T')).getTime();
  if (Number.isNaN(t)) {
    return {
      label: '—',
      tone: `bg-zinc-100 text-zinc-500 border-zinc-200 ${DARK_NEUTRAL_TONE}`,
      dot: 'bg-zinc-400 dark:bg-zinc-300',
    };
  }
  const m = Math.floor((Date.now() - t) / 60000);
  if (m >= 45) {
    return {
      label: formatElapsed(raw),
      tone: `bg-red-50 text-red-700 border-red-200 ${DARK_RED_TONE}`,
      dot: 'bg-red-500 dark:bg-red-300',
    };
  }
  if (m >= 25) {
    return {
      label: formatElapsed(raw),
      tone: `bg-amber-50 text-amber-700 border-amber-200 ${DARK_AMBER_TONE}`,
      dot: 'bg-amber-500 dark:bg-amber-300',
    };
  }
  return {
    label: formatElapsed(raw),
    tone: `bg-emerald-50 text-emerald-700 border-emerald-200 ${DARK_EMERALD_TONE}`,
    dot: 'bg-emerald-500 dark:bg-emerald-300',
  };
}

function channelBadgeMeta(order: Order): { label: string; className: string } {
  const kind = getCentralOrderKind(order);
  if (kind === 'mesa') {
    return { label: 'Mesa', className: `bg-violet-100 text-violet-800 border-violet-200 ${DARK_VIOLET_TONE}` };
  }
  if (kind === 'delivery') {
    return { label: 'Delivery', className: `bg-orange-100 text-orange-800 border-orange-200 ${DARK_ORANGE_TONE}` };
  }
  if (kind === 'retirada') {
    return { label: 'Retirada', className: `bg-emerald-100 text-emerald-800 border-emerald-200 ${DARK_EMERALD_TONE}` };
  }
  return { label: 'Balcão', className: 'bg-zinc-100 text-zinc-800 border-zinc-200 dark:bg-zinc-700 dark:text-zinc-100 dark:border-zinc-600' };
}

function boardChannelBadgeMeta(order: Order): { label: string; className: string } {
  const kind = getCentralOrderKind(order);
  if (kind === 'mesa') {
    return { label: 'Mesa', className: `bg-violet-100 text-violet-800 border-violet-200 ${DARK_VIOLET_TONE}` };
  }
  if (kind === 'delivery') {
    return { label: 'Delivery', className: `bg-orange-100 text-orange-800 border-orange-200 ${DARK_ORANGE_TONE}` };
  }
  if (kind === 'retirada') {
    return { label: 'Retirada', className: `bg-emerald-100 text-emerald-800 border-emerald-200 ${DARK_EMERALD_TONE}` };
  }
  return { label: 'Balcão', className: `bg-zinc-100 text-zinc-800 border-zinc-200 ${DARK_NEUTRAL_TONE}` };
}

function getOrderNumberLine(order: Order) {
  const num = String(order.order_number || '').trim();
  const senha = order.senha_pedido != null && Number(order.senha_pedido) !== 0
    ? String(order.senha_pedido).padStart(2, '0')
    : '';
  if (senha) return `${num} · Senha ${senha}`;
  return num || `#${order.id}`;
}

function getClienteLine(order: Order) {
  const nome = String(order.cliente_nome || '').trim();
  if (nome) return nome;
  const tel = order.cliente_tel;
  if (tel && String(tel).trim()) return String(tel).trim();
  const kind = getCentralOrderKind(order);
  if (kind === 'retirada') return 'Cliente não identificado';
  return '—';
}

function getMesaReference(order: Order) {
  const mesaId = Number((order as { mesa_id?: number | null }).mesa_id || 0);
  if (mesaId > 0) return String(mesaId);
  const observation = String(order.observation || '');
  const mesaMatch = observation.match(/Mesa\s+(\d+)/i);
  return mesaMatch ? mesaMatch[1] : null;
}

function getCompactOrderItemsSummary(order: Order) {
  const items = Array.isArray(order.items) ? order.items : [];
  if (items.length === 0) return null;

  const summary = items.slice(0, 2).map((item) => {
    const label = String(item.name || (item as { product_name?: string }).product_name || 'Item').trim() || 'Item';
    const quantity = Math.max(1, Number(item.quantity || 0));
    return `${quantity}x ${label}`;
  });
  const remaining = items.length - summary.length;

  return remaining > 0 ? `${summary.join(', ')} +${remaining} itens` : summary.join(', ');
}

function paymentMetodoUpper(tipo: string): string {
  const k = String(tipo || '').trim().toLowerCase();
  if (k === 'dinheiro') return 'DINHEIRO';
  if (k === 'pix') return 'PIX';
  if (k === 'cartao' || k === 'cartão') return 'CARTÃO';
  const u = String(tipo || '').trim().toUpperCase();
  return u || 'PAGAMENTO';
}

function getPagamentoLine(order: Order) {
  const tipo = order.pagamento_tipo;
  const status = order.pagamento_status;
  const t = String(tipo || '').trim();
  const s = String(status || '').trim();
  const totalPaid = Number(order.payment_total_paid || 0);
  const totalAmount = Number(order.total_amount || 0);
  if (isOrderFullyPaid(order)) {
    if (t) {
      if (totalPaid > 0) return `${paymentMetodoUpper(t)} — PAGO (${formatMoney(totalPaid)})`;
      return `${paymentMetodoUpper(t)} — PAGO`;
    }
    if (totalPaid > 0) return `PAGO (${formatMoney(totalPaid)})`;
    return 'PAGO';
  }
  if (totalPaid > 0 && totalAmount > 0) {
    return `${t ? paymentMetodoUpper(t) : 'PAGAMENTO'} — ${formatMoney(totalPaid)} / ${formatMoney(totalAmount)}`;
  }
  if (t) return `${paymentMetodoUpper(t)} — PENDENTE`;
  if (!t && !s) return null;
  if (s) return `${s.toUpperCase()}`;
  return null;
}

function getPaymentBadgeMeta(order: Order): { label: string; className: string } | null {
  const tipo = String(order.pagamento_tipo || '').trim();
  const status = String(order.pagamento_status || '').trim().toLowerCase();
  const fullyPaid = isOrderFullyPaid(order);
  const totalPaid = Number(order.payment_total_paid || 0);
  const totalAmount = Number(order.total_amount || 0);
  if (!tipo && !status && !fullyPaid) return null;
  if (fullyPaid) {
    return {
      label: tipo
        ? totalPaid > 0
          ? `${paymentMetodoUpper(tipo)} — PAGO · ${formatMoney(totalPaid)}`
          : `${paymentMetodoUpper(tipo)} — PAGO`
        : totalPaid > 0
          ? `PAGO · ${formatMoney(totalPaid)}`
          : 'PAGO',
      className: `bg-emerald-50 text-emerald-700 border-emerald-200 ${DARK_EMERALD_TONE}`,
    };
  }
  if (totalPaid > 0 && totalPaid + 0.01 < totalAmount) {
    return {
      label: `PARCIAL · ${formatMoney(totalPaid)} / ${formatMoney(totalAmount)}`,
      className: `bg-amber-50 text-amber-700 border-amber-200 ${DARK_AMBER_TONE}`,
    };
  }
  if (tipo) {
    return {
      label: `${paymentMetodoUpper(tipo)} — PENDENTE`,
      className: `bg-amber-50 text-amber-700 border-amber-200 ${DARK_AMBER_TONE}`,
    };
  }
  if (status) {
    return {
      label: status.toUpperCase(),
      className: `bg-amber-50 text-amber-700 border-amber-200 ${DARK_AMBER_TONE}`,
    };
  }
  return {
    label: 'PAGAMENTO',
    className: `bg-sky-50 text-sky-700 border-sky-200 ${DARK_SKY_TONE}`,
  };
}

function isRevisionStatusNormalized(statusRaw: string): boolean {
  const normalized = normalizeStatusKey(statusRaw);
  return (
    normalized === 'a_revisar' ||
    normalized === 'a revisar' ||
    normalized === 'em revisao' ||
    normalized === 'em revisao manual'
  );
}

/** Rótulo principal do chip de status (operacional, sem alterar buckets). */
function getBoardStatusLabel(statusRaw: string, columnId: CentralColumnId, mode: 'compact' | 'detailed'): string {
  const s = String(statusRaw || '').trim();

  if (columnId === 'a_confirmar') {
    return mode === 'compact'
      ? 'Confirmação pendente · QR/mesa'
      : 'Aguardando confirmação na mesa (pedido via QR)';
  }

  if (columnId === 'outros') {
    if (isRevisionStatusNormalized(s)) {
      return mode === 'compact' ? 'Em revisão' : 'Em revisão — conferir antes de avançar';
    }
    return s || '—';
  }

  return s || '—';
}

/** Tom do chip de status: destaque leve por subestado, sem replicar “colunas” escondidas. */
function getCentralStatusChipTone(columnId: CentralColumnId, statusRaw: string): string {
  if (columnId === 'a_confirmar') {
    return `border-sky-300/85 bg-sky-50/90 text-sky-950 ${DARK_SKY_TONE}`;
  }
  if (columnId === 'outros') {
    if (isRevisionStatusNormalized(statusRaw)) {
      return `border-amber-300/85 bg-amber-50/88 text-amber-950 ${DARK_AMBER_TONE}`;
    }
    return `border-amber-200/75 bg-amber-50/55 text-amber-950 ${DARK_AMBER_TONE}`;
  }
  return `border-zinc-200 bg-zinc-50 text-zinc-800 ${DARK_NEUTRAL_TONE}`;
}

function getColumnTone(columnId: CentralColumnId): {
  shell: string;
  header: string;
  count: string;
  empty: string;
  body: string;
  title: string;
  hint: string;
} {
  if (columnId === 'entrada') {
    return {
      shell: 'border-sky-200/70 bg-white dark:border-sky-400/35 dark:bg-zinc-900/90',
      header: 'border-b border-sky-100 bg-sky-50/65 dark:border-sky-400/30 dark:bg-sky-500/15',
      count: 'bg-sky-100 text-sky-800 ring-1 ring-inset ring-sky-200/80 dark:bg-sky-500/25 dark:text-sky-100 dark:ring-sky-400/35',
      empty: 'border-sky-200/75 text-zinc-500 dark:border-sky-400/25 dark:text-sky-300',
      body: 'bg-sky-50/[0.28] dark:bg-zinc-950/55',
      title: 'text-sky-900 dark:text-zinc-100',
      hint: 'text-sky-700/75 dark:text-zinc-400',
    };
  }
  if (columnId === 'em_preparo') {
    return {
      shell: 'border-amber-200/70 bg-white dark:border-amber-400/35 dark:bg-zinc-900/90',
      header: 'border-b border-amber-100 bg-amber-50/65 dark:border-amber-400/30 dark:bg-amber-500/15',
      count: 'bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-200/80 dark:bg-amber-500/25 dark:text-amber-100 dark:ring-amber-400/35',
      empty: 'border-amber-200/75 text-zinc-500 dark:border-amber-400/25 dark:text-amber-300',
      body: 'bg-amber-50/[0.30] dark:bg-zinc-950/55',
      title: 'text-amber-900 dark:text-zinc-100',
      hint: 'text-amber-700/75 dark:text-zinc-400',
    };
  }
  if (columnId === 'pronto') {
    return {
      shell: 'border-violet-200/70 bg-white dark:border-violet-400/35 dark:bg-zinc-900/90',
      header: 'border-b border-violet-100 bg-violet-50/65 dark:border-violet-400/30 dark:bg-violet-500/15',
      count: 'bg-violet-100 text-violet-800 ring-1 ring-inset ring-violet-200/80 dark:bg-violet-500/25 dark:text-violet-100 dark:ring-violet-400/35',
      empty: 'border-violet-200/75 text-zinc-500 dark:border-violet-400/25 dark:text-violet-300',
      body: 'bg-violet-50/[0.28] dark:bg-zinc-950/55',
      title: 'text-violet-900 dark:text-zinc-100',
      hint: 'text-violet-700/75 dark:text-zinc-400',
    };
  }
  if (columnId === 'rota') {
    return {
      shell: 'border-orange-200/70 bg-white dark:border-orange-400/35 dark:bg-zinc-900/90',
      header: 'border-b border-orange-100 bg-orange-50/65 dark:border-orange-400/30 dark:bg-orange-500/15',
      count: 'bg-orange-100 text-orange-800 ring-1 ring-inset ring-orange-200/80 dark:bg-orange-500/25 dark:text-orange-100 dark:ring-orange-400/35',
      empty: 'border-orange-200/75 text-zinc-500 dark:border-orange-400/25 dark:text-orange-300',
      body: 'bg-orange-50/[0.30] dark:bg-zinc-950/55',
      title: 'text-orange-900 dark:text-zinc-100',
      hint: 'text-orange-700/75 dark:text-zinc-400',
    };
  }
  if (columnId === 'encerrado') {
    return {
      shell: 'border-zinc-200/80 dark:border-zinc-700 bg-white dark:bg-zinc-900/90',
      header: 'border-b border-zinc-100 dark:border-zinc-700 bg-zinc-50/80 dark:bg-zinc-900',
      count: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:ring-1 dark:ring-inset dark:ring-zinc-700/80',
      empty: 'border-zinc-200/80 text-zinc-300 dark:border-zinc-700 dark:text-zinc-500',
      body: 'bg-zinc-50/60 dark:bg-zinc-950/45',
      title: 'text-zinc-700 dark:text-zinc-100',
      hint: 'text-zinc-400 dark:text-zinc-400',
    };
  }
  return {
    shell: 'border-zinc-200/80 dark:border-zinc-700 bg-white dark:bg-zinc-900/90',
    header: 'border-b border-zinc-100 dark:border-zinc-700 bg-zinc-50/80 dark:bg-zinc-900',
    count: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:ring-1 dark:ring-inset dark:ring-zinc-700/80',
    empty: 'border-zinc-200/80 text-zinc-300 dark:border-zinc-700 dark:text-zinc-500',
    body: 'bg-zinc-50/65 dark:bg-zinc-950/45',
    title: 'text-zinc-800 dark:text-zinc-100',
    hint: 'text-zinc-400 dark:text-zinc-400',
  };
}

const COLUMN_DEF: { id: CentralColumnId; title: string; hint?: string; sourceIds: CentralColumnId[] }[] = [
  { id: 'entrada', title: 'Entrada', sourceIds: ['a_confirmar', 'entrada', 'outros'] },
  { id: 'em_preparo', title: 'Em preparo', sourceIds: ['em_preparo'] },
  { id: 'pronto', title: 'Pronto', sourceIds: ['pronto'] },
  { id: 'rota', title: 'Rota', hint: 'Em deslocamento', sourceIds: ['rota'] },
  { id: 'encerrado', title: 'Encerrado', sourceIds: ['encerrado'] },
];

const FILTERS: { id: CentralChannelFilter; label: string }[] = [
  { id: 'todos', label: 'Todos' },
  { id: 'balcao', label: 'Presencial' },
  { id: 'delivery', label: 'Delivery' },
  { id: 'retirada', label: 'Retirada' },
];

const QUICK_FILTERS: { id: CentralQuickFilter; label: string }[] = [
  { id: 'todos', label: 'Tudo' },
  { id: 'urgentes', label: 'Urgentes' },
  { id: 'pagamento_pendente', label: 'Pagamento pendente' },
  { id: 'qr_pendente', label: 'QR pendente' },
  { id: 'sem_motoboy', label: 'Sem motoboy' },
];

const CENTRAL_MOBILE_BOARD_BREAKPOINT = 1024;
const CENTRAL_BOARD_GESTURE_LOCK_THRESHOLD = 6;
const CENTRAL_BOARD_DRAG_THRESHOLD = 12;

type CentralBoardTouchState = {
  active: boolean;
  startX: number;
  startY: number;
  startScrollLeft: number;
  axis: 'x' | 'y' | null;
  suppressClick: boolean;
};

export default function CentralPedidosScreen({
  token,
  segmento,
  hasMotoboyFeature = true,
}: {
  token: string;
  /** Segmento operacional — define status final do segmento (ex.: Entregue vs Concluído). */
  segmento?: string;
  hasMotoboyFeature?: boolean;
}) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [channelFilter, setChannelFilter] = useState<CentralChannelFilter>('todos');
  const [quickFilter, setQuickFilter] = useState<CentralQuickFilter>('todos');
  const [detail, setDetail] = useState<Order | null>(null);
  const [motoboys, setMotoboys] = useState<Array<{ id: number; nome: string }>>([]);
  const [showClosed, setShowClosed] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  const [boardCanScrollLeft, setBoardCanScrollLeft] = useState(false);
  const [boardCanScrollRight, setBoardCanScrollRight] = useState(false);
  const [showQrAtendimento, setShowQrAtendimento] = useState(false);
  const boardScrollRef = useRef<HTMLDivElement | null>(null);
  const boardTouchStateRef = useRef<CentralBoardTouchState>({
    active: false,
    startX: 0,
    startY: 0,
    startScrollLeft: 0,
    axis: null,
    suppressClick: false,
  });
  const boardSuppressClickTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(FLOWPDV_CENTRAL_CHANNEL_FILTER_KEY);
      if (
        raw === 'todos' ||
        raw === 'balcao' ||
        raw === 'delivery' ||
        raw === 'retirada'
      ) {
        setChannelFilter(raw as CentralChannelFilter);
      }
      sessionStorage.removeItem(FLOWPDV_CENTRAL_CHANNEL_FILTER_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const segCfg = useMemo(() => getSegCfg(segmento || 'Restaurante/Food'), [segmento]);

  const fetchOrders = useCallback(async () => {
    if (!token) return;
    setError('');
    setLoading(true);
    try {
      const { from, to } = getTodayRangeQuery();
      const qs = new URLSearchParams({ from, to, limit: String(CENTRAL_ORDERS_LIMIT) });
      const res = await fetch(`/api/orders?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setError('Não foi possível carregar os pedidos.');
        setOrders([]);
        return;
      }
      const data = await res.json();
      setOrders(Array.isArray(data) ? data : []);
    } catch {
      setError('Erro de conexão ao carregar pedidos.');
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void fetchOrders();
  }, [fetchOrders]);

  useEffect(() => {
    if (!token) return;
    if (!hasMotoboyFeature) {
      setMotoboys([]);
      return;
    }
    void (async () => {
      try {
        const res = await fetch('/api/delivery/motoboys', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        if (!Array.isArray(data)) return;
        setMotoboys(
          data.map((m: { id: number; nome: string }) => ({ id: m.id, nome: String(m.nome || '') }))
        );
      } catch {
        /* ignore */
      }
    })();
  }, [token, hasMotoboyFeature]);

  useEffect(() => {
    if (!hasMotoboyFeature && quickFilter === 'sem_motoboy') {
      setQuickFilter('todos');
    }
  }, [hasMotoboyFeature, quickFilter]);

  const quickFilters = useMemo(
    () => (hasMotoboyFeature ? QUICK_FILTERS : QUICK_FILTERS.filter((f) => f.id !== 'sem_motoboy')),
    [hasMotoboyFeature]
  );

  useEffect(() => {
    const id = window.setInterval(() => {
      void fetchOrders();
    }, 30000);
    return () => window.clearInterval(id);
  }, [fetchOrders]);

  const filtered = useMemo(
    () => orders.filter((o) =>
      passesCentralChannelFilter(o, channelFilter) &&
      passesCentralQuickFilter(o, quickFilter, hasMotoboyFeature)
    ),
    [orders, channelFilter, quickFilter, hasMotoboyFeature]
  );

  const buckets = useMemo(
    () => groupOrdersByCentralColumn(filtered, {
      segmentFinalStatus: segCfg.statusConcluido,
      requireMotoboy: hasMotoboyFeature,
    }),
    [filtered, segCfg.statusConcluido, hasMotoboyFeature]
  );
  const visibleColumns = useMemo(
    () =>
      COLUMN_DEF
        .filter((col) => showClosed || col.id !== 'encerrado')
        .map((col) => ({
          ...col,
          items: col.sourceIds.flatMap((sourceColumnId) =>
            buckets[sourceColumnId].map((order) => ({ order, sourceColumnId }))
          ),
        })),
    [showClosed, buckets]
  );

  const updateBoardScrollState = useCallback(() => {
    const node = boardScrollRef.current;
    if (!node) {
      setBoardCanScrollLeft(false);
      setBoardCanScrollRight(false);
      return;
    }

    const maxScrollLeft = Math.max(0, node.scrollWidth - node.clientWidth);
    const nextCanScrollLeft = node.scrollLeft > 8;
    const nextCanScrollRight = maxScrollLeft - node.scrollLeft > 8;

    setBoardCanScrollLeft((current) => (current === nextCanScrollLeft ? current : nextCanScrollLeft));
    setBoardCanScrollRight((current) => (current === nextCanScrollRight ? current : nextCanScrollRight));
  }, []);

  const clearBoardSuppressClick = useCallback(() => {
    if (boardSuppressClickTimeoutRef.current != null) {
      window.clearTimeout(boardSuppressClickTimeoutRef.current);
      boardSuppressClickTimeoutRef.current = null;
    }
    boardTouchStateRef.current.suppressClick = false;
  }, []);

  useEffect(() => () => {
    if (boardSuppressClickTimeoutRef.current != null) {
      window.clearTimeout(boardSuppressClickTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    const node = boardScrollRef.current;
    if (!node) return;

    const syncBoardScrollState = () => updateBoardScrollState();
    const frameId = window.requestAnimationFrame(syncBoardScrollState);

    node.addEventListener('scroll', syncBoardScrollState, { passive: true });
    window.addEventListener('resize', syncBoardScrollState);

    return () => {
      window.cancelAnimationFrame(frameId);
      node.removeEventListener('scroll', syncBoardScrollState);
      window.removeEventListener('resize', syncBoardScrollState);
    };
  }, [updateBoardScrollState, visibleColumns.length, filtered.length, orders.length]);

  useEffect(() => {
    const node = boardScrollRef.current;
    if (!node) return;

    const isMobileBoardScrollable = () =>
      window.innerWidth < CENTRAL_MOBILE_BOARD_BREAKPOINT &&
      node.scrollWidth > node.clientWidth + 8;

    const handleTouchStart = (event: TouchEvent) => {
      if (!isMobileBoardScrollable()) return;
      const touch = event.touches[0];
      if (!touch) return;

      clearBoardSuppressClick();
      boardTouchStateRef.current.active = true;
      boardTouchStateRef.current.startX = touch.clientX;
      boardTouchStateRef.current.startY = touch.clientY;
      boardTouchStateRef.current.startScrollLeft = node.scrollLeft;
      boardTouchStateRef.current.axis = null;
    };

    const handleTouchMove = (event: TouchEvent) => {
      const state = boardTouchStateRef.current;
      if (!state.active || !isMobileBoardScrollable()) return;

      const touch = event.touches[0];
      if (!touch) return;

      const deltaX = touch.clientX - state.startX;
      const deltaY = touch.clientY - state.startY;

      if (!state.axis) {
        if (
          Math.abs(deltaX) < CENTRAL_BOARD_GESTURE_LOCK_THRESHOLD &&
          Math.abs(deltaY) < CENTRAL_BOARD_GESTURE_LOCK_THRESHOLD
        ) {
          return;
        }
        state.axis = Math.abs(deltaX) > Math.abs(deltaY) ? 'x' : 'y';
      }

      if (state.axis !== 'x') return;

      if (Math.abs(deltaX) > CENTRAL_BOARD_DRAG_THRESHOLD) {
        state.suppressClick = true;
      }

      event.preventDefault();
      node.scrollLeft = state.startScrollLeft - deltaX;
      updateBoardScrollState();
    };

    const handleTouchEnd = () => {
      const state = boardTouchStateRef.current;
      state.active = false;
      state.axis = null;

      if (!state.suppressClick) return;

      if (boardSuppressClickTimeoutRef.current != null) {
        window.clearTimeout(boardSuppressClickTimeoutRef.current);
      }

      boardSuppressClickTimeoutRef.current = window.setTimeout(() => {
        boardTouchStateRef.current.suppressClick = false;
        boardSuppressClickTimeoutRef.current = null;
      }, 220);
    };

    const handleClickCapture = (event: MouseEvent) => {
      if (!boardTouchStateRef.current.suppressClick) return;
      event.preventDefault();
      event.stopPropagation();
      clearBoardSuppressClick();
    };

    node.addEventListener('touchstart', handleTouchStart, { passive: true });
    node.addEventListener('touchmove', handleTouchMove, { passive: false });
    node.addEventListener('touchend', handleTouchEnd, { passive: true });
    node.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    node.addEventListener('click', handleClickCapture, true);

    return () => {
      node.removeEventListener('touchstart', handleTouchStart);
      node.removeEventListener('touchmove', handleTouchMove);
      node.removeEventListener('touchend', handleTouchEnd);
      node.removeEventListener('touchcancel', handleTouchEnd);
      node.removeEventListener('click', handleClickCapture, true);
    };
  }, [clearBoardSuppressClick, updateBoardScrollState, visibleColumns.length, filtered.length, orders.length]);

  const showBoardSwipeHint = boardCanScrollRight && !boardCanScrollLeft;
  const hasHorizontalOverflow = boardCanScrollLeft || boardCanScrollRight;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex h-full min-h-0 flex-col bg-white dark:bg-zinc-950">
      <div className="min-w-0 shrink-0 border-b border-fp-border bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900 sm:px-4 sm:py-2.5 lg:px-6">
        <div className="mx-auto flex w-full max-w-7xl min-w-0 flex-col">
        <ScreenHeader
          titleAs="h1"
          className="gap-1.5"
          titleClassName="flex items-center gap-1.5 flex-wrap text-base sm:text-lg"
          title={
            <>
              <LayoutGrid className="shrink-0 text-zinc-700 dark:text-zinc-300" size={18} strokeWidth={2.25} />
              Operação
            </>
          }
          subtitle={
            <p className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
              Ao vivo · hoje
            </p>
          }
          meta={
            <span className={`${adminScreenMetaHintClass} hidden lg:inline`}>
              Até {CENTRAL_ORDERS_LIMIT} pedidos (hoje)
            </span>
          }
          actions={
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                className="!min-h-[36px] sm:!min-h-[38px] !px-2.5 !py-1.5 !text-[11px]"
                onClick={() => setShowQrAtendimento(true)}
                title="Gerar QR para o atendente abrir o Atendimento Mobile (comanda/mesas) no celular"
              >
                <QrCode size={13} />
                QR Comanda/Mesas
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="!min-h-[36px] sm:!min-h-[38px] !px-2.5 !py-1.5 !text-[11px]"
                onClick={() => void fetchOrders()}
                disabled={loading}
              >
                <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                Atualizar
              </Button>
            </div>
          }
        />

        <div className="-mx-2 mt-1 overflow-x-auto px-2 pb-0.5 [-webkit-overflow-scrolling:touch] [scrollbar-gutter:stable] sm:mx-0 sm:overflow-visible sm:px-0 sm:pb-0">
          <div className="flex min-w-max gap-1 sm:min-w-0 sm:flex-wrap sm:gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setChannelFilter(f.id)}
                className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide min-h-[36px] sm:min-h-[38px] transition-colors ${
                  channelFilter === f.id
                    ? 'border-[#EA1D2C] bg-[#EA1D2C] text-white dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100'
                    : 'border-fp-border bg-white text-fptext-secondary dark:bg-zinc-800/80 dark:text-zinc-300 dark:border-zinc-700 hover:bg-[#FAFAFB] dark:hover:bg-zinc-800'
                }`}
              >
                {f.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setShowClosed((current) => !current)}
              className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold min-h-[36px] sm:min-h-[38px] transition-colors ${
                showClosed
                  ? 'border-[#EA1D2C] bg-[#EA1D2C] text-white dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100'
                  : 'border-fp-border bg-transparent text-fptext-secondary dark:text-zinc-400 dark:border-zinc-700 hover:bg-[#FAFAFB] dark:hover:bg-zinc-800'
              }`}
              title={showClosed ? 'Ocultar pedidos encerrados' : 'Mostrar pedidos encerrados'}
            >
              {showClosed ? 'Ocultar encerrados' : `Encerrados (${buckets.encerrado.length})`}
            </button>
            <button
              type="button"
              onClick={() => setCompactMode((current) => !current)}
              className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold min-h-[36px] sm:min-h-[38px] transition-colors ${
                compactMode
                  ? 'border-[#EA1D2C] bg-[#EA1D2C] text-white dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100'
                  : 'border-fp-border bg-transparent text-fptext-secondary dark:text-zinc-400 dark:border-zinc-700 hover:bg-[#FAFAFB] dark:hover:bg-zinc-800'
              }`}
              title={compactMode ? 'Voltar ao modo normal' : 'Reduzir altura dos cards'}
            >
              {compactMode ? 'Compacto' : 'Compactar'}
            </button>
          </div>
        </div>

        <div className="-mx-2 mt-1 overflow-x-auto px-2 pb-0.5 [-webkit-overflow-scrolling:touch] [scrollbar-gutter:stable] sm:mx-0 sm:overflow-visible sm:px-0 sm:pb-0">
          <div className="flex min-w-max items-center gap-1 sm:min-w-0 sm:flex-wrap sm:gap-1">
            <span className={`${adminSectionEyebrowClass} shrink-0 text-[10px]`}>Filtros</span>
            {quickFilters.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setQuickFilter(f.id)}
                className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-semibold min-h-[36px] transition-colors sm:min-h-0 sm:py-1 ${
                  quickFilter === f.id
                    ? 'border-[#EA1D2C] bg-[#EA1D2C] text-white dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100'
                    : 'border-fp-border bg-white text-fptext-secondary hover:bg-[#FAFAFB] dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-700 dark:hover:bg-zinc-800'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <div className="mx-auto flex h-full w-full max-w-7xl min-w-0 flex-col space-y-3 p-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:space-y-4 sm:p-4 sm:pb-4 lg:p-6 lg:pb-6">
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-400/35 dark:bg-red-500/12 dark:text-red-100">
            {error}
          </div>
        )}

        {loading && orders.length === 0 ? (
          <div className="flex justify-center py-8 sm:py-10 2xl:py-14">
            <Spinner />
          </div>
        ) : !loading && orders.length === 0 && !error ? (
          <EmptyState
            title="Nenhum pedido hoje"
            description="Ainda não há pedidos registrados para hoje neste estabelecimento."
          />
        ) : (
          <>
            {!loading && orders.length > 0 && filtered.length === 0 && (
              <p className="text-xs text-center text-zinc-500 dark:text-zinc-400 mb-1 2xl:text-sm 2xl:mb-2">
                Nenhum pedido corresponde ao filtro selecionado.
              </p>
            )}
            <div className="relative">
              <div className={`px-0.5 text-[10px] font-medium text-zinc-400 transition-opacity lg:hidden ${showBoardSwipeHint ? 'opacity-100' : 'opacity-0'}`}>
                Deslize pela lista para acessar as próximas colunas
              </div>
              {hasHorizontalOverflow && (
                <>
                  <div
                    aria-hidden="true"
                    className={`pointer-events-none absolute inset-y-0 left-0 z-10 w-7 bg-gradient-to-r from-white via-white/90 to-transparent transition-opacity dark:from-zinc-950 dark:via-zinc-950/90 lg:hidden ${boardCanScrollLeft ? 'opacity-100' : 'opacity-0'}`}
                  />
                  <div
                    aria-hidden="true"
                    className={`pointer-events-none absolute inset-y-0 right-0 z-10 w-9 bg-gradient-to-l from-white via-white/95 to-transparent transition-opacity dark:from-zinc-950 dark:via-zinc-950/95 lg:hidden ${boardCanScrollRight ? 'opacity-100' : 'opacity-0'}`}
                  />
                </>
              )}
              {showBoardSwipeHint && (
                <div className="pointer-events-none absolute right-3 top-2 z-10 rounded-full border border-fp-border bg-white/92 px-2.5 py-1 text-[10px] font-semibold text-fptext-secondary shadow-sm backdrop-blur dark:border-zinc-700/80 dark:bg-zinc-900/88 dark:text-zinc-300 lg:hidden">
                  Arraste o quadro
                </div>
              )}
              <div
                ref={boardScrollRef}
                className="-mx-1 overflow-x-auto overflow-y-hidden overscroll-x-contain px-1 pb-1.5 touch-pan-y [scrollbar-gutter:stable] [-webkit-overflow-scrolling:touch] scroll-smooth snap-x snap-proximity scroll-px-1.5 sm:-mx-1.5 sm:px-1.5 sm:pb-2 lg:mx-0 lg:overflow-x-visible lg:px-0 lg:pb-1 lg:touch-auto lg:snap-none"
              >
                <div
                  className={`flex min-w-max items-stretch gap-1.5 pr-1.5 sm:gap-2 sm:pr-2 lg:grid lg:min-w-0 lg:w-full lg:gap-3 lg:pr-0 ${
                    showClosed
                      ? 'lg:[grid-template-columns:repeat(5,minmax(10rem,1fr))]'
                      : 'lg:[grid-template-columns:repeat(4,minmax(13rem,1fr))]'
                  }`}
                >
                  {visibleColumns.map((col) => {
                    const tone = getColumnTone(col.id);
                    return (
                      <div
                        key={col.id}
                        className={`snap-start flex w-[min(calc(100vw-1rem),252px)] flex-shrink-0 flex-col rounded-2xl border shadow-sm shadow-zinc-950/[0.03] min-h-[min(220px,40vh)] max-h-none sm:w-[262px] md:w-[274px] lg:w-full lg:min-h-[min(256px,42vh)] lg:max-h-[min(58vh,34rem)] ${tone.shell}`}
                      >
                        <div className={`shrink-0 px-3 py-2 ${tone.header}`}>
                          <div className="flex items-center gap-1.5">
                            <span className={`min-w-0 truncate text-[13px] font-black leading-tight ${tone.title}`}>
                              {col.title}
                            </span>
                            <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black tabular-nums ${tone.count}`}>
                              {col.items.length}
                            </span>
                          </div>
                          {col.hint && (
                            <p className={`mt-0.5 hidden text-[9px] leading-tight xl:block ${tone.hint}`}>{col.hint}</p>
                          )}
                        </div>
                        <div className={`min-h-0 flex-1 space-y-1.5 p-1.5 lg:overflow-y-auto lg:overscroll-y-contain lg:space-y-1.5 lg:p-1.5 ${tone.body}`}>
                          {col.items.length === 0 ? (
                            <div className={`mx-0.5 rounded-xl border border-dashed px-2 py-6 text-center text-[10px] leading-snug ${tone.empty}`}>
                              Sem pedidos nesta etapa
                            </div>
                          ) : (
                            col.items.map(({ order, sourceColumnId }) => (
                              <Fragment key={`${sourceColumnId}-${order.id}`}>
                                <OrderCard
                                  order={order}
                                  columnId={sourceColumnId}
                                  token={token}
                                  segmentFinalStatus={segCfg.statusConcluido}
                                  motoboys={motoboys}
                                  hasMotoboyFeature={hasMotoboyFeature}
                                  compactMode={compactMode}
                                  onOpenDetail={() => setDetail(order)}
                                  onActionDone={() => void fetchOrders()}
                                />
                              </Fragment>
                            ))
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        )}
        </div>
      </div>

      <AnimatePresence>
        {detail && (
          <OrderDetailModal
            order={detail}
            token={token}
            onClose={() => setDetail(null)}
            onRefresh={() => void fetchOrders()}
            onOrderPatch={(patch) => setDetail((current) => (current ? { ...current, ...patch } : current))}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showQrAtendimento && (
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[200] flex items-center justify-center p-4"
            onClick={() => setShowQrAtendimento(false)}
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.92, opacity: 0 }}
              className="bg-white dark:bg-zinc-900 rounded-3xl w-full max-w-sm shadow-2xl p-8 flex flex-col items-center text-center"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-xl font-black text-zinc-900 dark:text-white mb-1">QR Comanda/Mesas</h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-5">
                Escaneie com o celular do atendente para abrir. Ele precisa fazer login normalmente —
                o QR só é um atalho para não digitar o endereço.
              </p>
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(
                  `${window.location.origin}/m/atendimento`
                )}&bgcolor=ffffff&color=000000&margin=8`}
                alt="QR Atendimento Mobile"
                className="w-[220px] h-[220px] rounded-2xl border border-zinc-100 dark:border-zinc-800"
              />
              <button
                onClick={() => setShowQrAtendimento(false)}
                className="mt-6 w-full px-4 py-3 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-900 dark:text-white rounded-xl font-semibold text-sm transition-all"
              >
                Fechar
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function OrderCard({
  order,
  columnId,
  token,
  segmentFinalStatus,
  motoboys,
  hasMotoboyFeature,
  compactMode,
  onOpenDetail,
  onActionDone,
}: {
  order: Order;
  columnId: CentralColumnId;
  token: string;
  segmentFinalStatus: string;
  motoboys: Array<{ id: number; nome: string }>;
  hasMotoboyFeature: boolean;
  compactMode: boolean;
  onOpenDetail: () => void;
  onActionDone: () => void;
}) {
  const badge = boardChannelBadgeMeta(order);
  const paymentBadge = getPaymentBadgeMeta(order);
  const elapsed = getElapsedMeta(order.created_at);
  const mesaReference = getMesaReference(order);
  const isQrPending = isPendingQrMesaOrder(order);
  const urgent = isUrgentOrder(order);
  const paymentPending = isPaymentPendingOrder(order);
  const withoutMotoboy = isOrderWithoutAssignedMotoboy(order, hasMotoboyFeature);
  const ageMinutes = getOrderAgeMinutes(order);
  const hasItemCustomization = orderHasAnyItemCustomization(order);
  const hasAutomationBadges = orderHasAutomationBadges(order);
  const compactItemsSummary = getCompactOrderItemsSummary(order);
  const compactOriginLabel = mesaReference ? `Mesa ${mesaReference}` : badge.label;
  const statusRaw = String(order.status || '').trim() || '—';
  const compactStatusLabel = getBoardStatusLabel(statusRaw, columnId, 'compact');
  const detailedStatusLabel = getBoardStatusLabel(statusRaw, columnId, 'detailed');
  const statusChipTone = getCentralStatusChipTone(columnId, statusRaw);
  const statusTitleHint =
    columnId === 'a_confirmar' || (columnId === 'outros' && statusRaw && statusRaw !== '—')
      ? `${detailedStatusLabel} · Status: ${statusRaw}`
      : detailedStatusLabel;
  const showOutrosExceptionHint =
    !compactMode && columnId === 'outros' && !isRevisionStatusNormalized(statusRaw);
  const paymentPendingLabel = Number(order.payment_total_paid || 0) > 0
    ? 'Pagamento parcial'
    : String(order.pagamento_tipo || '').trim().toLowerCase() === 'pix'
      ? 'Pix pendente'
      : 'Pagamento pendente';

  const primary = useMemo(
    () => getCentralPrimaryAction(order, { columnId, segmentFinalStatus, requireMotoboy: hasMotoboyFeature }),
    [order, columnId, segmentFinalStatus, hasMotoboyFeature]
  );

  const [motoboyId, setMotoboyId] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const [busyQuickAction, setBusyQuickAction] = useState<'payment' | 'cupom' | 'comprovante' | 'producao' | null>(null);

  const needsMotoboy =
    primary?.kind === 'patch_delivery' && primary.needsMotoboy;
  const bloqueadoMotoboy =
    Boolean(needsMotoboy) && (!motoboyId || motoboys.length === 0);
  const canConfirmPayment = canCentralConfirmPayment(order);
  const canPrintCupom = canCentralPrintCupom(order);
  const canPrintProducao = canCentralPrintProducao(order);
  const canPrintProof = canCentralPrintProof(order);
  const mapsUrl = getCentralMapsUrl(order);
  const notifyUrl = getCentralNotifyCustomerUrl(order);

  const handlePrimary = async () => {
    if (!primary || busy) return;
    if (bloqueadoMotoboy) return;
    setBusy(true);
    const r = await executeCentralPrimaryAction({
      token,
      order,
      action: primary,
      motoboyId: needsMotoboy ? Number(motoboyId) : undefined,
    });
    setBusy(false);
    if (!r.ok) {
      alert(r.error || 'Não foi possível concluir a ação.');
      return;
    }
    onActionDone();
  };

  const handleQuickPayment = async () => {
    if (busyQuickAction) return;
    setBusyQuickAction('payment');
    const r = await executeCentralConfirmPayment({ token, order });
    setBusyQuickAction(null);
    if (!r.ok) {
      alert(r.error || 'Não foi possível confirmar o pagamento.');
      return;
    }
    onActionDone();
  };

  const handleQuickPrint = async (document: 'cupom' | 'comprovante' | 'producao') => {
    if (busyQuickAction) return;
    setBusyQuickAction(document);
    const r = await executeCentralPrintAction({ token, order, document });
    setBusyQuickAction(null);
    if (!r.ok) {
      alert(r.error || 'Não foi possível abrir a impressão.');
    }
  };

  const openExternalUrl = (url: string | null) => {
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <Card className={`!shadow-none !rounded-xl transition-all duration-150 hover:-translate-y-0.5 hover:shadow-sm ${
      urgent
        ? 'ring-1 ring-red-200/80 border-red-200 dark:ring-red-400/30 dark:border-red-400/45 dark:hover:border-red-300/60'
        : 'hover:border-zinc-300 dark:hover:border-zinc-500'
    }`}>
      <div className={compactMode ? 'p-2 sm:p-2.5' : 'p-2.5 sm:p-2.5 lg:p-3'}>
        <button
          type="button"
          onClick={onOpenDetail}
          className="w-full rounded-lg text-left transition-colors hover:bg-zinc-50/70 active:bg-zinc-50/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50 dark:hover:bg-zinc-800/35 dark:active:bg-zinc-800/45 sm:rounded-xl"
        >
          {compactMode ? (
            <>
              {(urgent || paymentPending || withoutMotoboy || hasItemCustomization || hasAutomationBadges) && (
                <div className="mb-1 flex flex-wrap gap-0.5 sm:mb-1.5 sm:gap-1">
                  {urgent && (
                    <StatusChip size="sm" toneClassName={`border-red-200 bg-red-50 text-red-800 ${DARK_RED_TONE}`}>
                      {ageMinutes >= 45 ? 'Crítico' : 'Urgente'}
                    </StatusChip>
                  )}
                  {paymentPending && (
                    <StatusChip size="sm" toneClassName={`border-amber-200 bg-amber-50 text-amber-800 ${DARK_AMBER_TONE}`} emphasis="bold">
                      {paymentPendingLabel}
                    </StatusChip>
                  )}
                  {withoutMotoboy && (
                    <StatusChip
                      size="sm"
                      emphasis="bold"
                      toneClassName={`border-orange-200 bg-orange-50 text-orange-700 ${DARK_ORANGE_TONE}`}
                    >
                      Sem motoboy
                    </StatusChip>
                  )}
                  {hasItemCustomization && (
                    <StatusChip
                      size="sm"
                      icon={ListTree}
                      toneClassName={`border-violet-200 bg-violet-50 text-violet-800 ${DARK_VIOLET_TONE}`}
                    >
                      Itens c/ obs.
                    </StatusChip>
                  )}
                  <OrderAutomationBadges order={order} compact />
                </div>
              )}

              <div className="flex items-start justify-between gap-2 sm:gap-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-black leading-tight tracking-tight text-zinc-900 dark:text-zinc-100">
                    {getClienteLine(order)}
                  </p>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1">
                    <StatusChip
                      rounded="md"
                      size="sm"
                      toneClassName={badge.className}
                      emphasis="bold"
                      className="max-w-[96px] shrink-0 overflow-hidden sm:max-w-[120px]"
                    >
                      <span className="truncate">{compactOriginLabel}</span>
                    </StatusChip>
                    <p className="min-w-0 truncate text-[10px] font-semibold text-zinc-500 dark:text-zinc-400">
                      {getOrderNumberLine(order)}
                    </p>
                  </div>
                  {compactItemsSummary && (
                    <p className="mt-1 line-clamp-1 text-[10px] font-medium leading-tight text-zinc-600 dark:text-zinc-300 sm:hidden">
                      {compactItemsSummary}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <StatusChip
                    size="sm"
                    toneClassName={elapsed.tone}
                    className="tabular-nums gap-1 px-1.5 py-0.5"
                    uppercase={false}
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${elapsed.dot}`} />
                    {elapsed.label}
                  </StatusChip>
                  <p className="mt-0.5 text-[13px] font-black tabular-nums text-zinc-900 dark:text-zinc-50 sm:mt-1 sm:text-[14px]">
                    {formatMoney(order.total_amount)}
                  </p>
                </div>
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-1 sm:flex-nowrap">
                <StatusChip
                  rounded="lg"
                  size="sm"
                  toneClassName={statusChipTone}
                  className="min-w-0 inline-flex max-w-full flex-1 overflow-hidden px-1.5 py-0.5 leading-tight sm:px-2"
                  title={statusTitleHint}
                >
                  <span className="truncate">{compactStatusLabel}</span>
                </StatusChip>
                {paymentBadge && (
                  <StatusChip rounded="md" size="sm" toneClassName={paymentBadge.className} emphasis="semibold" className="max-w-full shrink-0 overflow-hidden sm:max-w-[46%]">
                    <span className="truncate">{paymentBadge.label}</span>
                  </StatusChip>
                )}
              </div>
            </>
          ) : (
            <>
              {(urgent || paymentPending || withoutMotoboy || hasItemCustomization || hasAutomationBadges) && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {urgent && (
                    <StatusChip size="md" toneClassName={`border-red-200 bg-red-50 text-red-800 ${DARK_RED_TONE}`}>
                      {ageMinutes >= 45 ? 'Crítico' : 'Urgente'}
                    </StatusChip>
                  )}
                  {paymentPending && (
                    <StatusChip size="md" toneClassName={`border-amber-200 bg-amber-50 text-amber-800 ${DARK_AMBER_TONE}`} emphasis="bold">
                      {paymentPendingLabel}
                    </StatusChip>
                  )}
                  {withoutMotoboy && (
                    <StatusChip
                      size="md"
                      emphasis="bold"
                      toneClassName={`border-orange-200 bg-orange-50 text-orange-700 ${DARK_ORANGE_TONE}`}
                    >
                      Sem motoboy
                    </StatusChip>
                  )}
                  {hasItemCustomization && (
                    <StatusChip
                      size="md"
                      icon={ListTree}
                      toneClassName={`border-violet-200 bg-violet-50 text-violet-800 ${DARK_VIOLET_TONE}`}
                    >
                      Itens personalizados
                    </StatusChip>
                  )}
                  <OrderAutomationBadges order={order} />
                </div>
              )}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {isQrPending && mesaReference && (
                    <div className="mb-1.5">
                      <StatusChip
                        size="md"
                        icon={QrCode}
                        toneClassName={`border-zinc-200 bg-zinc-50 text-zinc-700 ${DARK_NEUTRAL_TONE}`}
                      >
                        Mesa {mesaReference}
                      </StatusChip>
                    </div>
                  )}
                  <p className="text-[13px] font-black text-zinc-900 dark:text-zinc-100 truncate leading-tight tracking-tight">
                    {getOrderNumberLine(order)}
                  </p>
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-400 dark:text-zinc-400 mt-1">Cliente</p>
                  <p className="text-sm mt-0.5 font-semibold text-zinc-700 dark:text-zinc-200 truncate">
                    {getClienteLine(order)}
                  </p>
                </div>
                <div className="flex items-start gap-2 shrink-0">
                  <StatusChip
                    size="md"
                    toneClassName={elapsed.tone}
                    className="gap-1 px-2 py-1 tabular-nums"
                    uppercase={false}
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${elapsed.dot}`} />
                    <Clock size={10} className="shrink-0" strokeWidth={2.25} />
                    {elapsed.label}
                  </StatusChip>
                  <ChevronRight size={16} className="mt-1 shrink-0 text-zinc-300 dark:text-zinc-500" />
                </div>
              </div>

              <div className="mt-2 w-full min-w-0">
                <StatusChip
                  rounded="xl"
                  size="sm"
                  toneClassName={statusChipTone}
                  className="inline-flex w-full max-w-full px-2.5 py-1 leading-snug font-semibold"
                  title={statusTitleHint}
                >
                  <span className="line-clamp-2 break-words text-left">{detailedStatusLabel}</span>
                </StatusChip>
                {showOutrosExceptionHint && (
                  <p className="mt-1.5 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
                    Fora do fluxo automático — abra o pedido para tratar manualmente.
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                <StatusChip rounded="lg" size="sm" toneClassName={badge.className} emphasis="bold">
                  {badge.label}
                </StatusChip>
                {paymentBadge && (
                  <StatusChip rounded="lg" size="sm" toneClassName={paymentBadge.className} emphasis="semibold">
                    {paymentBadge.label}
                  </StatusChip>
                )}
              </div>

              <div className={`mt-2.5 px-2.5 py-2 ${adminOpsInsetPanelClass}`}>
                <div className="flex items-end justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[10px] text-zinc-400 uppercase font-bold tracking-[0.18em]">Total</p>
                  </div>
                  <p className="text-base font-black text-zinc-900 dark:text-zinc-50 tabular-nums">
                    {formatMoney(order.total_amount)}
                  </p>
                </div>
              </div>

              <div className="mt-2 pt-2 border-t border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-400 dark:text-zinc-400">Detalhes</span>
                <span className="text-[10px] font-semibold text-zinc-500 dark:text-zinc-300">Abrir pedido</span>
              </div>
            </>
          )}
        </button>

        {(canConfirmPayment || canPrintCupom || canPrintProducao || canPrintProof || canCentralOpenMaps(order) || canCentralNotifyCustomer(order) || primary) && (
          <div
            className={`${compactMode ? 'mt-1.5 pt-1.5 space-y-1' : 'mt-2.5 pt-2.5 space-y-1.5'} border-t border-zinc-100 dark:border-zinc-800`}
            onClick={(e) => e.stopPropagation()}
          >
            {compactMode && !needsMotoboy ? (
              <div className="flex items-center gap-1.5">
                {(canConfirmPayment || canPrintCupom || canPrintProducao || canPrintProof || mapsUrl || notifyUrl) && (
                  <div className="flex flex-wrap gap-1.5">
                    {canConfirmPayment && (
                      <button
                        type="button"
                        title="Confirmar pagamento"
                        aria-label="Confirmar pagamento"
                        onClick={() => void handleQuickPayment()}
                        disabled={busyQuickAction !== null}
                        className={`min-h-[40px] min-w-[40px] lg:min-h-[30px] lg:min-w-[30px] inline-flex items-center justify-center rounded-lg border border-emerald-200/90 bg-emerald-50 text-emerald-700 shadow-sm transition-colors hover:bg-emerald-100 disabled:opacity-50 ${DARK_EMERALD_BUTTON_TONE}`}
                      >
                        <BadgeCheck size={14} className={busyQuickAction === 'payment' ? 'animate-pulse' : ''} />
                      </button>
                    )}
                    {canPrintCupom && (
                      <button
                        type="button"
                        title="Imprimir cupom"
                        aria-label="Imprimir cupom"
                        onClick={() => void handleQuickPrint('cupom')}
                        disabled={busyQuickAction !== null}
                        className={`min-h-[40px] min-w-[40px] lg:min-h-[30px] lg:min-w-[30px] inline-flex items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-700 shadow-sm transition-colors hover:bg-zinc-100 disabled:opacity-50 ${DARK_NEUTRAL_BUTTON_TONE}`}
                      >
                        <Printer size={14} className={busyQuickAction === 'cupom' ? 'animate-pulse' : ''} />
                      </button>
                    )}
                    {canPrintProducao && (
                      <button
                        type="button"
                        title="Imprimir produção (cozinha)"
                        aria-label="Imprimir produção"
                        onClick={() => void handleQuickPrint('producao')}
                        disabled={busyQuickAction !== null}
                        className={`min-h-[40px] min-w-[40px] lg:min-h-[30px] lg:min-w-[30px] inline-flex items-center justify-center rounded-lg border border-amber-200 bg-amber-50 text-amber-900 shadow-sm transition-colors hover:bg-amber-100 disabled:opacity-50 ${DARK_AMBER_BUTTON_TONE}`}
                      >
                        <ChefHat size={14} className={busyQuickAction === 'producao' ? 'animate-pulse' : ''} />
                      </button>
                    )}
                    {canPrintProof && (
                      <button
                        type="button"
                        title="Imprimir comprovante"
                        aria-label="Imprimir comprovante"
                        onClick={() => void handleQuickPrint('comprovante')}
                        disabled={busyQuickAction !== null}
                        className={`min-h-[40px] min-w-[40px] lg:min-h-[30px] lg:min-w-[30px] inline-flex items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-700 shadow-sm transition-colors hover:bg-zinc-100 disabled:opacity-50 ${DARK_NEUTRAL_BUTTON_TONE}`}
                      >
                        <ReceiptText size={14} className={busyQuickAction === 'comprovante' ? 'animate-pulse' : ''} />
                      </button>
                    )}
                    {mapsUrl && (
                      <button
                        type="button"
                        title="Ver mapa"
                        aria-label="Ver mapa"
                        onClick={() => openExternalUrl(mapsUrl)}
                        className={`min-h-[40px] min-w-[40px] lg:min-h-[30px] lg:min-w-[30px] inline-flex items-center justify-center rounded-lg border border-blue-200 bg-blue-50 text-blue-700 shadow-sm transition-colors hover:bg-blue-100 ${DARK_BLUE_BUTTON_TONE}`}
                      >
                        <MapPinned size={14} />
                      </button>
                    )}
                    {notifyUrl && (
                      <button
                        type="button"
                        title="Avisar cliente"
                        aria-label="Avisar cliente"
                        onClick={() => openExternalUrl(notifyUrl)}
                        className={`min-h-[40px] min-w-[40px] lg:min-h-[30px] lg:min-w-[30px] inline-flex items-center justify-center rounded-lg border border-green-200 bg-green-50 text-green-700 shadow-sm transition-colors hover:bg-green-100 ${DARK_GREEN_BUTTON_TONE}`}
                      >
                        <MessageCircle size={14} />
                      </button>
                    )}
                  </div>
                )}
                {primary && (
                  <Button
                    type="button"
                    variant="primary"
                    disabled={busy || bloqueadoMotoboy}
                    className="!min-h-[40px] sm:!min-h-[44px] lg:!min-h-[34px] !py-1.5 sm:!py-2 lg:!py-1.5 !px-2.5 sm:!px-3 !text-[10px] sm:!text-[11px] !font-black shadow-sm flex-1"
                    onClick={() => void handlePrimary()}
                  >
                    <ChevronRight size={13} className={busy ? 'animate-pulse' : ''} />
                    {bloqueadoMotoboy ? 'Selecione o motoboy' : primary.label}
                  </Button>
                )}
              </div>
            ) : (
              <>
            {(canConfirmPayment || canPrintCupom || canPrintProducao || canPrintProof || mapsUrl || notifyUrl) && (
              <div className="flex flex-wrap gap-1.5">
                {canConfirmPayment && (
                  <button
                    type="button"
                    title="Confirmar pagamento"
                    aria-label="Confirmar pagamento"
                    onClick={() => void handleQuickPayment()}
                    disabled={busyQuickAction !== null}
                    className={`${compactMode ? 'min-h-[40px] min-w-[40px] lg:min-h-[32px] lg:min-w-[32px]' : 'min-h-[44px] px-3 gap-2 lg:min-h-[36px]'} inline-flex items-center justify-center rounded-xl border border-emerald-200/90 bg-emerald-50 text-emerald-700 shadow-sm transition-colors hover:bg-emerald-100 disabled:opacity-50 ${DARK_EMERALD_BUTTON_TONE}`}
                  >
                    <BadgeCheck size={15} className={busyQuickAction === 'payment' ? 'animate-pulse' : ''} />
                    {!compactMode && (
                      <span className="text-[11px] font-black uppercase tracking-wide">Confirmar pagamento</span>
                    )}
                  </button>
                )}
                {canPrintCupom && (
                  <button
                    type="button"
                    title="Imprimir cupom"
                    aria-label="Imprimir cupom"
                    onClick={() => void handleQuickPrint('cupom')}
                    disabled={busyQuickAction !== null}
                    className={`${compactMode ? 'min-h-[40px] min-w-[40px] lg:min-h-[32px] lg:min-w-[32px]' : 'min-h-[44px] min-w-[44px] lg:min-h-[36px] lg:min-w-[36px]'} inline-flex items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-700 shadow-sm transition-colors hover:bg-zinc-100 disabled:opacity-50 ${DARK_NEUTRAL_BUTTON_TONE}`}
                  >
                    <Printer size={15} className={busyQuickAction === 'cupom' ? 'animate-pulse' : ''} />
                  </button>
                )}
                {canPrintProducao && (
                  <button
                    type="button"
                    title="Imprimir produção (cozinha)"
                    aria-label="Imprimir produção"
                    onClick={() => void handleQuickPrint('producao')}
                    disabled={busyQuickAction !== null}
                    className={`${compactMode ? 'min-h-[40px] min-w-[40px] lg:min-h-[32px] lg:min-w-[32px]' : 'min-h-[44px] min-w-[44px] lg:min-h-[36px] lg:min-w-[36px]'} inline-flex items-center justify-center rounded-xl border border-amber-200 bg-amber-50 text-amber-900 shadow-sm transition-colors hover:bg-amber-100 disabled:opacity-50 ${DARK_AMBER_BUTTON_TONE}`}
                  >
                    <ChefHat size={15} className={busyQuickAction === 'producao' ? 'animate-pulse' : ''} />
                  </button>
                )}
                {canPrintProof && (
                  <button
                    type="button"
                    title="Imprimir comprovante"
                    aria-label="Imprimir comprovante"
                    onClick={() => void handleQuickPrint('comprovante')}
                    disabled={busyQuickAction !== null}
                    className={`${compactMode ? 'min-h-[40px] min-w-[40px] lg:min-h-[32px] lg:min-w-[32px]' : 'min-h-[44px] min-w-[44px] lg:min-h-[36px] lg:min-w-[36px]'} inline-flex items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-700 shadow-sm transition-colors hover:bg-zinc-100 disabled:opacity-50 ${DARK_NEUTRAL_BUTTON_TONE}`}
                  >
                    <ReceiptText size={15} className={busyQuickAction === 'comprovante' ? 'animate-pulse' : ''} />
                  </button>
                )}
                {mapsUrl && (
                  <button
                    type="button"
                    title="Ver mapa"
                    aria-label="Ver mapa"
                    onClick={() => openExternalUrl(mapsUrl)}
                    className={`${compactMode ? 'min-h-[40px] min-w-[40px] lg:min-h-[32px] lg:min-w-[32px]' : 'min-h-[44px] min-w-[44px] lg:min-h-[36px] lg:min-w-[36px]'} inline-flex items-center justify-center rounded-xl border border-blue-200 bg-blue-50 text-blue-700 shadow-sm transition-colors hover:bg-blue-100 ${DARK_BLUE_BUTTON_TONE}`}
                  >
                    <MapPinned size={15} />
                  </button>
                )}
                {notifyUrl && (
                  <button
                    type="button"
                    title="Avisar cliente"
                    aria-label="Avisar cliente"
                    onClick={() => openExternalUrl(notifyUrl)}
                    className={`${compactMode ? 'min-h-[40px] min-w-[40px] lg:min-h-[32px] lg:min-w-[32px]' : 'min-h-[44px] min-w-[44px] lg:min-h-[36px] lg:min-w-[36px]'} inline-flex items-center justify-center rounded-xl border border-green-200 bg-green-50 text-green-700 shadow-sm transition-colors hover:bg-green-100 ${DARK_GREEN_BUTTON_TONE}`}
                  >
                    <MessageCircle size={15} />
                  </button>
                )}
              </div>
            )}
            {needsMotoboy && (
              <select
                value={motoboyId}
                onChange={(e) => setMotoboyId(e.target.value ? Number(e.target.value) : '')}
                className={`w-full text-xs px-2.5 ${compactMode ? 'py-1.5 min-h-[38px] sm:py-1.5 sm:min-h-[36px]' : 'py-2 min-h-[40px]'} rounded-xl border bg-white dark:bg-zinc-800 dark:border-zinc-700 ${
                  bloqueadoMotoboy ? 'border-amber-400 dark:border-amber-500/50 bg-amber-50 dark:bg-amber-500/10' : ''
                }`}
              >
                <option value="">Motoboy…</option>
                {motoboys.length === 0 ? (
                  <option value="" disabled>
                    Nenhum motoboy cadastrado
                  </option>
                ) : (
                  motoboys.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.nome}
                    </option>
                  ))
                )}
              </select>
            )}
            {primary && (
              <Button
                type="button"
                variant="primary"
                disabled={busy || bloqueadoMotoboy}
                className={`${compactMode ? '!min-h-[40px] !py-1.5 sm:!min-h-[38px] sm:!py-2' : '!min-h-[42px] !py-2.5'} !w-full !text-xs !font-black shadow-sm`}
                onClick={() => void handlePrimary()}
              >
                <ChevronRight size={14} className={busy ? 'animate-pulse' : ''} />
                {bloqueadoMotoboy ? 'Selecione o motoboy' : primary.label}
              </Button>
            )}
              </>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function OrderDetailModal({
  order,
  token,
  onClose,
  onRefresh,
  onOrderPatch,
}: {
  order: Order;
  token: string;
  onClose: () => void;
  onRefresh: () => void;
  onOrderPatch: (patch: Partial<Order>) => void;
}) {
  const badge = boardChannelBadgeMeta(order);
  const pag = getPagamentoLine(order);
  const items = Array.isArray(order.items) ? order.items : [];
  const [busyPayment, setBusyPayment] = useState(false);
  const [busyPrint, setBusyPrint] = useState<'cupom' | 'comprovante' | 'producao' | null>(null);
  const canConfirmPayment = canCentralConfirmPayment(order);
  const canPrintProof = canCentralPrintProof(order);
  const canPrintProducaoModal = canCentralPrintProducao(order);
  const canWhatsAppCliente = canCentralOpenCustomerWhatsApp(order);

  const handleConfirmPayment = async () => {
    if (busyPayment) return;
    setBusyPayment(true);
    const result = await executeCentralConfirmPayment({ token, order });
    setBusyPayment(false);
    if (!result.ok) {
      alert(result.error || 'Não foi possível confirmar o pagamento.');
      return;
    }
    if (result.orderPatch) onOrderPatch(result.orderPatch);
    else onOrderPatch({ pagamento_status: 'pago' } as Partial<Order>);
    onRefresh();
  };

  const handlePrint = async (document: 'cupom' | 'comprovante' | 'producao') => {
    if (busyPrint) return;
    setBusyPrint(document);
    const result = await executeCentralPrintAction({ token, order, document });
    setBusyPrint(null);
    if (!result.ok) {
      alert(result.error || 'Não foi possível abrir a impressão.');
    }
  };

  const openClienteWhatsApp = () => {
    const url = getCentralCustomerWhatsAppChatUrl(order);
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 24, opacity: 0 }}
        transition={{ type: 'spring', damping: 28, stiffness: 320 }}
        role="dialog"
        aria-modal="true"
        aria-label={`Detalhes do pedido ${getOrderNumberLine(order)}`}
        className="flex h-[100dvh] w-full min-h-0 flex-col overflow-hidden bg-white px-[env(safe-area-inset-left)] pb-[env(safe-area-inset-bottom)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] shadow-2xl dark:bg-zinc-900 sm:h-auto sm:max-h-[min(92dvh,100svh)] sm:max-w-lg sm:rounded-2xl sm:border sm:border-zinc-200 sm:px-0 sm:pb-0 sm:pt-0 dark:sm:border-zinc-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 border-b border-zinc-100 bg-white/95 px-4 py-3.5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95 sm:px-4 sm:py-4">
          <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-zinc-200 dark:bg-zinc-700 sm:hidden" />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Pedido</p>
              <p className="truncate text-lg font-black text-zinc-900 dark:text-zinc-100">{getOrderNumberLine(order)}</p>
              <div className="mt-2 flex flex-wrap gap-1.5 sm:gap-2">
              <span className={`rounded-lg border px-2 py-0.5 text-[10px] font-bold ${badge.className}`}>
                {badge.label}
              </span>
              <span className={`rounded-lg border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-[10px] font-bold text-zinc-700 ${DARK_NEUTRAL_TONE}`}>
                {String(order.status || '—')}
              </span>
              {orderHasAnyItemCustomization(order) && (
                <span className={`inline-flex items-center gap-1 rounded-lg border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-bold text-violet-800 ${DARK_VIOLET_TONE}`}>
                  <ListTree size={12} />
                  Itens personalizados
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Fechar"
          >
            <X size={20} />
          </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-3 py-3 sm:space-y-4 sm:px-4 sm:py-4">
          <div className="grid grid-cols-1 gap-3 rounded-2xl border border-zinc-200 bg-zinc-50/80 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-950/40 sm:grid-cols-2">
            <div>
              <p className="text-[10px] font-bold text-zinc-400 uppercase">Cliente</p>
              <p className="font-semibold text-zinc-900 dark:text-zinc-100 break-words">{getClienteLine(order)}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold text-zinc-400 uppercase">Criado</p>
              <p className="font-semibold text-zinc-800 dark:text-zinc-200">{formatCreatedAtPtBr(order.created_at)}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold text-zinc-400 uppercase">Tempo</p>
              <p className="font-semibold text-zinc-800 dark:text-zinc-200">{formatElapsed(order.created_at)}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold text-zinc-400 uppercase">Total</p>
              <p className="font-black text-zinc-900 dark:text-zinc-100">{formatMoney(order.total_amount)}</p>
            </div>
          </div>

          {pag && (
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50/80 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
              <p className="text-[10px] font-bold text-zinc-400 uppercase">Pagamento</p>
              <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{pag}</p>
            </div>
          )}

          <div className="hidden sm:block">
            <p className="text-[10px] font-bold text-zinc-400 uppercase mb-2">Ações operacionais</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                type="button"
                variant="secondary"
                className="!justify-start !px-3 !text-xs"
                onClick={() => void handlePrint('cupom')}
                disabled={busyPrint !== null}
              >
                <Printer size={14} className={busyPrint === 'cupom' ? 'animate-pulse' : ''} />
                Imprimir cupom
              </Button>
              {canPrintProducaoModal && (
                <Button
                  type="button"
                  variant="secondary"
                  className={`!justify-start !px-3 !text-xs border-amber-200 bg-amber-50 text-amber-950 hover:bg-amber-100 ${DARK_AMBER_BUTTON_TONE}`}
                  onClick={() => void handlePrint('producao')}
                  disabled={busyPrint !== null}
                >
                  <ChefHat size={14} className={busyPrint === 'producao' ? 'animate-pulse' : ''} />
                  Imprimir produção
                </Button>
              )}
              {canPrintProof && (
                <Button
                  type="button"
                  variant="secondary"
                  className="!justify-start !px-3 !text-xs"
                  onClick={() => void handlePrint('comprovante')}
                  disabled={busyPrint !== null}
                >
                  <ReceiptText size={14} className={busyPrint === 'comprovante' ? 'animate-pulse' : ''} />
                  Imprimir comprovante
                </Button>
              )}
              {canWhatsAppCliente && (
                <Button
                  type="button"
                  variant="secondary"
                  className="!justify-start !px-3 !text-xs"
                  onClick={openClienteWhatsApp}
                >
                  <MessageCircle size={14} />
                  Abrir WhatsApp
                </Button>
              )}
              {canConfirmPayment && (
                <Button
                  type="button"
                  variant="success"
                  className="!justify-start !px-3 !text-xs sm:col-span-2"
                  onClick={() => void handleConfirmPayment()}
                  disabled={busyPayment}
                >
                  <BadgeCheck size={14} className={busyPayment ? 'animate-pulse' : ''} />
                  Confirmar pagamento
                </Button>
              )}
            </div>
          </div>

          {/* Itens — mesma lista que OrdersScreen usa em conceito */}
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[10px] font-bold uppercase text-zinc-400">Itens</p>
              <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                {items.length} {items.length === 1 ? 'item' : 'itens'}
              </span>
            </div>
            <ul className="space-y-2.5 sm:space-y-3">
              {items.map((it, idx) => {
                const label = it.name || (it as { product_name?: string }).product_name || 'Item';
                const ext = it as {
                  observation?: string | null;
                  obs_opcoes?: string | null;
                  item_display_details?: string[];
                };
                const detail = getOrderItemDetailText(ext);
                const lines =
                  Array.isArray(ext.item_display_details) && ext.item_display_details.length > 0
                    ? ext.item_display_details
                    : splitOrderItemDetailLines(detail);
                const unit = Number(it.price_at_time || 0);
                const lineTotal = unit * Number(it.quantity);
                return (
                  <li
                    key={`${it.product_id}-${idx}`}
                    className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-950/30"
                  >
                    <div className="flex justify-between gap-3 text-sm">
                      <span className="text-zinc-700 dark:text-zinc-300 min-w-0 font-semibold">
                        {label} ×{it.quantity}
                      </span>
                      <span className="text-zinc-900 dark:text-zinc-100 font-bold tabular-nums shrink-0">
                        {formatMoney(lineTotal)}
                      </span>
                    </div>
                    {lines.length > 0 ? (
                      <>
                        <ul className="mt-1.5 ml-1 space-y-0.5 text-[12px] leading-snug text-zinc-600 dark:text-zinc-400">
                          {lines.map((line, j) => (
                            <li key={j} className="flex gap-1.5">
                              <span className="text-zinc-400 shrink-0" aria-hidden>–</span>
                              <span className="min-w-0">{line}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-1.5 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
                          Unitário {formatMoney(unit)} (congelado na venda); à direita, total da linha.
                        </p>
                      </>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {items.length === 0 && (
              <p className="text-sm text-zinc-400">Sem itens na lista.</p>
            )}
          </div>

          {order.observation && String(order.observation).trim() && (
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50/80 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
              <p className="text-[10px] font-bold text-zinc-400 uppercase">Observação</p>
              <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">{order.observation}</p>
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-zinc-100 bg-white/95 px-3 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95 sm:hidden">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400">Acoes operacionais</p>
          <div className="grid gap-2">
            {canConfirmPayment && (
              <Button
                type="button"
                variant="success"
                className="!min-h-[48px] !justify-center !px-3 !text-sm"
                onClick={() => void handleConfirmPayment()}
                disabled={busyPayment}
              >
                <BadgeCheck size={14} className={busyPayment ? 'animate-pulse' : ''} />
                Confirmar pagamento
              </Button>
            )}
            <div className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
              <Button
                type="button"
                variant="secondary"
                className="!min-h-[46px] !justify-start !px-3 !text-xs"
                onClick={() => void handlePrint('cupom')}
                disabled={busyPrint !== null}
              >
                <Printer size={14} className={busyPrint === 'cupom' ? 'animate-pulse' : ''} />
                Imprimir cupom
              </Button>
              {canPrintProducaoModal && (
                <Button
                  type="button"
                  variant="secondary"
                  className={`!min-h-[46px] !justify-start !px-3 !text-xs border-amber-200 bg-amber-50 text-amber-950 hover:bg-amber-100 ${DARK_AMBER_BUTTON_TONE}`}
                  onClick={() => void handlePrint('producao')}
                  disabled={busyPrint !== null}
                >
                  <ChefHat size={14} className={busyPrint === 'producao' ? 'animate-pulse' : ''} />
                  Producao
                </Button>
              )}
              {canPrintProof && (
                <Button
                  type="button"
                  variant="secondary"
                  className="!min-h-[46px] !justify-start !px-3 !text-xs"
                  onClick={() => void handlePrint('comprovante')}
                  disabled={busyPrint !== null}
                >
                  <ReceiptText size={14} className={busyPrint === 'comprovante' ? 'animate-pulse' : ''} />
                  Comprovante
                </Button>
              )}
              {canWhatsAppCliente && (
                <Button
                  type="button"
                  variant="secondary"
                  className="!min-h-[46px] !justify-start !px-3 !text-xs"
                  onClick={openClienteWhatsApp}
                >
                  <MessageCircle size={14} />
                  WhatsApp
                </Button>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}