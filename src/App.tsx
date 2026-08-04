/**
 * App.tsx - Roteador principal do Pratory.
 */

import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Monitor, Lock, Menu,
} from 'lucide-react';

import type { Product, CaixaStatusApi, Order } from './types';
import NavItem from './components/ui/NavItem';
import PlanBadge from './components/ui/PlanBadge';
import { getSegCfg, getOperationalSegment } from './config/segmentos';
import {
  getSafeFallbackPlanFeatures,
  isKnownPlanFeature,
  sanitizePlanFeatures,
  type PlanFeature,
} from './config/planFeatures';
import { mapOrderToCentralColumn } from './utils/orderCentralBoard';
import type { PlanProfileInfo } from './utils/planStatus';
import { playNewOrderSound } from './utils/sound';

// ── Telas críticas no primeiro paint (login + PDV padrão) ────────
import LoginScreen           from './shared/LoginScreen';
import MenuHubScreen, { DEFAULT_ICONS } from './shared/MenuHubScreen';
import POSScreen             from './shared/POSScreen';
import LicenseBlockedScreen  from './shared/LicenseBlockedScreen';
import LegalAcceptanceGate   from './shared/legal/LegalAcceptanceGate';
import ChunkLoadErrorBoundary from './shared/ChunkLoadErrorBoundary';

const AdminPanel            = lazy(() => import('./shared/AdminPanel'));
const OrdersScreen          = lazy(() => import('./shared/OrdersScreen'));
const CentralPedidosScreen  = lazy(() => import('./shared/CentralPedidosScreen'));
const DashboardScreen       = lazy(() => import('./shared/DashboardScreen'));
const FinanceScreen         = lazy(() => import('./shared/FinanceScreen'));
const EstoqueScreen         = lazy(() => import('./shared/EstoqueScreen'));
const ProductsScreen        = lazy(() => import('./shared/ProductsScreen'));
const ConfiguracoesScreen   = lazy(() => import('./shared/ConfiguracoesScreen'));
const OpenCaixaModal        = lazy(() => import('./shared/modals/OpenCaixaModal'));
const CloseCaixaModal       = lazy(() => import('./shared/modals/CloseCaixaModal'));
const SolicitacaoModal      = lazy(() => import('./shared/modals/SolicitacaoModal'));
const RHScreen              = lazy(() => import('./shared/RHScreen'));
const SystemLogsScreen      = lazy(() => import('./shared/SystemLogsScreen'));
const FiscalScreen          = lazy(() => import('./shared/FiscalScreen'));
const DeliveryScreen        = lazy(() => import('./shared/DeliveryScreen'));
const TabClientes = lazy(() => import('./shared/DeliveryScreen').then((m) => ({ default: m.TabClientes })));
const WhatsAppIAScreen      = lazy(() => import('./shared/WhatsAppIAScreen'));
const DeliveryCardapio      = lazy(() => import('./segments/delivery/DeliveryCardapio'));
const PedidoRastreamento    = lazy(() => import('./shared/PedidoRastreamento'));
const KDSScreen             = lazy(() => import('./segments/restaurante/KDSScreen'));
const ClienteDisplayScreen  = lazy(() => import('./segments/restaurante/ClienteDisplayScreen'));
const ClienteMesaScreen     = lazy(() => import('./segments/restaurante/ClienteMesaScreen'));
const MesasScreen           = lazy(() => import('./segments/bar/MesasScreen'));
const PrivacyPolicyPublicPage = lazy(() => import('./shared/legal/PrivacyPolicyPublicPage'));
const TermsOfUsePublicPage  = lazy(() => import('./shared/legal/TermsOfUsePublicPage'));
const AtendimentoMobileScreen = lazy(() => import('./segments/atendimento/AtendimentoMobileScreen'));
const GarcomMobileScreen = lazy(() => import('./segments/bar/GarcomMobileScreen'));

import { Button }            from './components/ui/Card';
import { Input }             from './components/ui/Card';

const FlowAIPopup           = lazy(() => import('./shared/FlowAIPopup'));
const NotificationCenter    = lazy(() => import('./shared/NotificationCenter'));
import { useFlowAI }         from './hooks/useFlowAI';

function TabLoadingFallback() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center px-4 py-8 text-sm text-fptext-muted">
      Carregando…
    </div>
  );
}

function PublicRouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-fp-app text-sm text-fptext-muted">
      Carregando…
    </div>
  );
}

const PLAN_FEATURES_STORAGE_KEY = 'plan_features';

function readStoredPlanFeatures(): PlanFeature[] {
  try {
    return sanitizePlanFeatures(JSON.parse(localStorage.getItem(PLAN_FEATURES_STORAGE_KEY) || 'null'));
  } catch {
    return getSafeFallbackPlanFeatures();
  }
}

type PublicMeta = {
  title: string;
  description: string;
};

function setDocumentMeta(name: string, content: string, attr: 'name' | 'property' = 'name') {
  let el = document.head.querySelector(`meta[${attr}="${name}"]`) as HTMLMetaElement | null;
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, name);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function getPublicMeta(path: string): PublicMeta {
  if (path === '/login') {
    return {
      title: 'Entrar | Pratory',
      description: 'Acesse o Pratory com seu usuário: caixa, pedidos, cozinha, mesas e delivery na sua loja.',
    };
  }
  if (path === '/') {
    return {
      title: 'Pratory | Caixa, pedidos e delivery para sua loja',
      description:
        'Sistema para restaurante e delivery: PDV, cozinha, cardápio online, mesas, retirada e caixa num lugar só.',
    };
  }
  if (path === '/privacidade') {
    return {
      title: 'Política de Privacidade | Pratory',
      description: 'Consulte a política de privacidade do Pratory e as informações aplicáveis à operação da plataforma.',
    };
  }
  if (path === '/termos') {
    return {
      title: 'Termos de Uso | Pratory',
      description: 'Consulte os termos de uso do Pratory para estabelecimentos e usuários autorizados.',
    };
  }
  if (/^\/delivery\/[^/]+\/pedido\/\d+$/.test(path)) {
    return {
      title: 'Acompanhe seu pedido | Pratory',
      description: 'Acompanhe o andamento do seu pedido online em tempo real.',
    };
  }
  if (/^\/delivery\/[^/]+$/.test(path)) {
    return {
      title: 'Cardápio online e pedidos | Pratory',
      description: 'Peça online com cardápio digital, retirada ou delivery direto pelo Pratory.',
    };
  }
  if (/^\/display\/[^/]+$/.test(path)) {
    return {
      title: 'Painel de pedidos | Pratory',
      description: 'Acompanhe a chamada e o andamento dos pedidos em tempo real.',
    };
  }
  if (/^\/mesa\/[^/]+\/[^/]+$/.test(path)) {
    return {
      title: 'Mesa digital | Pratory',
      description: 'Acompanhe e interaja com o pedido da sua mesa.',
    };
  }
  return {
    title: 'Pratory | PDV, cozinha e delivery para food service',
    description: 'Sistema para food service que integra PDV, pedidos, cozinha, cardápio online, delivery, mesas, retirada, caixa, estoque e relatórios na mesma operação.',
  };
}

export default function App() {
  const OPERATIONAL_ALERT_SOUND_KEY = 'flowpdv_operational_alert_sound';
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [estabelecimentoSegmento, setEstabelecimentoSegmento] = useState('Restaurante/Food');
  const [activeTab, setActiveTab] = useState<'pos' | 'dashboard' | 'products' | 'orders' | 'central' | 'finance' | 'estoque' | 'mesas' | 'funcionarios' | 'configuracoes' | 'logs' | 'delivery' | 'clientes' | 'whatsapp-ia'>('pos')
  // Tela de menu inicial exibida logo após o login (antes de cair direto no PDV).
  // Reaberta manualmente pelo botão "Menu" na sidebar.
  const [showMenuHub, setShowMenuHub] = useState<boolean>(true)
  const [floatPos, setFloatPos]   = React.useState(() => {
    const saved = localStorage.getItem('orders_float_pos');
    return saved ? JSON.parse(saved) : { x: window.innerWidth - 80, y: window.innerHeight - 120 };
  });
  const floatDrag = React.useRef<{ dragging: boolean; ox: number; oy: number; hasDragged: boolean }>({ dragging: false, ox: 0, oy: 0, hasDragged: false });
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [pendingTab, setPendingTab] = useState<any>(null);
  const [authPassword, setAuthPassword] = useState('');
  const [currentCaixa, setCurrentCaixa] = useState<CaixaStatusApi | null>(null);
  const [showCaixaModal, setShowCaixaModal] = useState<'abrir' | 'fechar' | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [showWatermarkSettings, setShowWatermarkSettings] = useState(false);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('dark_mode') === 'true');
  const [showQRModal, setShowQRModal] = useState(false);
  const [slugAtual, setSlugAtual] = useState<string>(() => {
    try {
      const t = localStorage.getItem('token');
      if (!t) return '';
      return (JSON.parse(atob(t.split('.')[1])) as any).username || '';
    } catch { return ''; }
  });

  // ── Permissões ────────────────────────────────────────────────────────────
  const [userCargo, setUserCargo]           = useState<string>(() => localStorage.getItem('user_cargo') || 'dono');
  const [userPermissoes, setUserPermissoes] = useState<string[] | null>(() => {
    try { const p = localStorage.getItem('user_permissoes'); return p ? JSON.parse(p) : null; } catch { return null; }
  });
  const [userName, setUserName] = useState<string>(() => localStorage.getItem('user_nome') || '');
  const [estabelecimentoNome, setEstabelecimentoNome] = useState('Pratory');
  const [planFeatures, setPlanFeatures] = useState<PlanFeature[]>(() => readStoredPlanFeatures());
  const [planProfile, setPlanProfile] = useState<PlanProfileInfo | null>(null);
  const [operationalAlertCount, setOperationalAlertCount] = useState(0);
  const [operationalNeedsAttention, setOperationalNeedsAttention] = useState(false);
  const [operationalSoundEnabled, setOperationalSoundEnabled] = useState(
    () => localStorage.getItem(OPERATIONAL_ALERT_SOUND_KEY) !== 'false'
  );
  const operationalAlertSnapshotRef = React.useRef('');
  const operationalAlertLoadedRef = React.useRef(false);
  const operationalSoundRepeatTimeoutRef = React.useRef<ReturnType<typeof window.setTimeout> | undefined>(undefined);
  const shouldRepeatOperationalSoundRef = React.useRef(false);

  const [openMesasCount, setOpenMesasCount] = useState(0);

  const userAllows = (tab: string): boolean => {
    if (userCargo === 'dono') return true;
    if (!Array.isArray(userPermissoes)) return false;
    return userPermissoes.includes(tab);
  };
  const normalizeAccessFeature = (tab: string): string => {
    if (tab === 'central') return 'orders';
    // Clientes (cadastro delivery) e WhatsApp IA reutilizam o mesmo gate de delivery.
    if (tab === 'clientes' || tab === 'whatsapp-ia') return 'delivery';
    return tab;
  };
  const planAllows = (tab: string): boolean => {
    const feature = normalizeAccessFeature(tab);
    if (!isKnownPlanFeature(feature)) return true;
    if (token && !planProfile) {
      return getSafeFallbackPlanFeatures().includes(feature);
    }
    return planFeatures.includes(feature);
  };
  const canAccess = (tab: string): boolean => {
    const feature = normalizeAccessFeature(tab);
    return planAllows(feature) && userAllows(feature);
  };

  const refreshOpenMesasCount = useCallback(async () => {
    if (!token || isAtendimentoMobile) return;
    try {
      const res = await fetch('/api/mesas', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      const mesas = Array.isArray(data) ? data : [];
      const n = mesas.filter((m: { status?: string }) => m.status === 'aberta').length;
      setOpenMesasCount(n);
    } catch {
      setOpenMesasCount(0);
    }
  }, [token]);

  const tenantHasMotoboyFeature = token && !planProfile
    ? true
    : planFeatures.includes('funcionarios');
  const alertsToken = token && planProfile && planAllows('dashboard') ? token : null;
  const alertsEnabled = Boolean(alertsToken);
  const alertsPopupEnabled = Boolean(token && planProfile && planAllows('ai'));
  const userRoleLabel =
    userCargo === 'dono' ? 'Proprietário' : userCargo === 'gerente' ? 'Gerente' : 'Atendente';
  const userDisplayName = userName || 'Sessão ativa';
  const userSecondaryLine = userRoleLabel || 'Painel operacional';
  const estabelecimentoMonogram = estabelecimentoNome
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((chunk) => chunk[0]?.toUpperCase())
    .join('') || 'FP';

  // ── FlowAI ────────────────────────────────────────────────────────────────
  const {
    avisoAtivo, avisos, avisosNaoLidos,
    historico, historicoTotal, carregandoHist,
    buscarAvisos, marcarLido, marcarTodosLidos,
    gerarAvisos, proximoAviso, buscarHistorico,
  } = useFlowAI(alertsToken);

  const refreshNotifHistorico = useCallback(() => {
    buscarHistorico(100, 0);
  }, [buscarHistorico]);

  const [notifCenterOpen, setNotifCenterOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Gera avisos ao logar e a cada 30 minutos — com fallback silencioso
  useEffect(() => {
    if (!alertsToken) return;
    const rodar = () =>
      gerarAvisos()
        .then(() => buscarAvisos())
        .catch(() => {
          // Falha silenciosa — ANTHROPIC_API_KEY ausente ou rede indisponível
          // não polui o console de produção
        });
    // Após boot HTTP (produtos/caixa/perfil) — evita competir com o pool do banco
    const init = setTimeout(rodar, 6000);
    const iv   = setInterval(rodar, 30 * 60 * 1000);
    return () => { clearTimeout(init); clearInterval(iv); };
  }, [alertsToken, gerarAvisos, buscarAvisos]);

  // Após login como cliente (admin): abre Estoque ou Pedidos para deeplink
  useEffect(() => {
    if (!token) return;
    try {
      const nav = localStorage.getItem('flowpdv_initial_nav_tab') || sessionStorage.getItem('flowpdv_initial_nav_tab');
      if (nav === 'estoque' && canAccess('estoque')) {
        localStorage.removeItem('flowpdv_initial_nav_tab');
        sessionStorage.removeItem('flowpdv_initial_nav_tab');
        setActiveTab('estoque');
      } else if (nav === 'whatsapp-ia' && canAccess('whatsapp-ia')) {
        localStorage.removeItem('flowpdv_initial_nav_tab');
        sessionStorage.removeItem('flowpdv_initial_nav_tab');
        setActiveTab('whatsapp-ia');
      } else if (nav === 'orders' && canAccess('orders')) {
        localStorage.removeItem('flowpdv_initial_nav_tab');
        sessionStorage.removeItem('flowpdv_initial_nav_tab');
        setActiveTab('orders');
      }
    } catch {
      /* ignore */
    }
  }, [token, userPermissoes, planFeatures, planProfile]);

  // ── Injeta/remove tema escuro no <html> ──────────────────────────────────
  useEffect(() => {
    const el = document.documentElement;
    if (darkMode) {
      el.classList.add('flowpdv-dark', 'dark');
      localStorage.setItem('dark_mode', 'true');
    } else {
      el.classList.remove('flowpdv-dark', 'dark');
      localStorage.setItem('dark_mode', 'false');
    }
  }, [darkMode]);

  const [showSolicitacao, setShowSolicitacao] = useState(false);
  const [licenseError, setLicenseError] = useState<'bloqueado' | 'trial_expirado' | null>(null);
  const [legalNeedsAcceptance, setLegalNeedsAcceptance] = useState(false);
  const [legalGateResolved, setLegalGateResolved] = useState(() => {
    try {
      return !localStorage.getItem('token');
    } catch {
      return true;
    }
  });
  const [taxasPagamento, setTaxasPagamento] = useState({ debito: 0, credito: 0, pix: 0 });
  const [senhaPadrao, setSenhaPadrao]       = useState(false);
  const path = window.location.pathname;
  const isLegalPublicPage = path === '/privacidade' || path === '/termos';
  const isAdmin = path.startsWith('/admin');
  const atendimentoMobileMatch = path.match(/^\/m\/atendimento\/?$/);
  const isAtendimentoMobile = Boolean(atendimentoMobileMatch);
  const garcomMobileMatch = path.match(/^\/m\/garcom\/([^/]+)\/?$/);
  const isGarcomMobile = Boolean(garcomMobileMatch);
  const garcomQrToken = garcomMobileMatch ? decodeURIComponent(garcomMobileMatch[1]) : null;
  const bookingMatch = path.match(/^\/agendar\/(.+)$/);
  const bookingSlug  = bookingMatch ? bookingMatch[1] : null;
  const kdsMatch     = path.match(/^\/kds\/(.+)$/);
  const kdsSlug      = kdsMatch ? kdsMatch[1] : null;
  const pontoMatch   = path.match(/^\/kiosk\/ponto\/(.+)$/) || path.match(/^\/public\/ponto\/(.+)$/);
  const isPonto      = !!pontoMatch;
  const displayMatch = path.match(/^\/display\/([^/]+)$/);
  const mesaMatch    = path.match(/^\/mesa\/([^/]+)\/([^/]+)$/);
  // Verifica pathname E query param (fallback para quando o servidor redireciona em dev)
  const _deliverySlugQS = new URLSearchParams(window.location.search).get('delivery_slug');
  const deliveryMatch  = path.match(/^\/delivery\/([^/]+)$/) || (_deliverySlugQS ? [null, _deliverySlugQS] : null);
  // Rastreamento público: /delivery/:slug/pedido/:id
  const trackingMatch  = path.match(/^\/delivery\/([^/]+)\/pedido\/(\d+)$/);

  useEffect(() => {
    const meta = getPublicMeta(path);
    if (isAdmin) {
      document.title = 'Admin — Pratory';
      return;
    }
    if (kdsSlug) {
      document.title = 'Tela de Pedidos — Pratory';
      return;
    }
    if (bookingSlug) {
      document.title = 'Página pública indisponível — Pratory';
      return;
    }
    if (isPonto) {
      document.title = 'Sistema de Ponto — Pratory';
      return;
    }

    document.title = meta.title;
    setDocumentMeta('description', meta.description);
    setDocumentMeta('og:title', meta.title, 'property');
    setDocumentMeta('og:description', meta.description, 'property');
  }, [path, isAdmin, kdsSlug, bookingSlug, isPonto]);

  const segmentoOperacional = getOperationalSegment(estabelecimentoSegmento);
  const segCfg = getSegCfg(segmentoOperacional);
  const permiteMesas = segmentoOperacional === 'Restaurante/Food' || segmentoOperacional === 'Bar/Pub';
  const permiteDelivery = permiteMesas;
  const isOperationTab = activeTab === 'orders' || activeTab === 'central';
  /** Som operacional: repetir a cada 10s enquanto houver pedido acionável fora da aba Operação/Pedidos. */
  const OPERATIONAL_ALERT_REPEAT_MS = 10_000;
  const shouldRepeatOperationalSound =
    Boolean(token)
    && !isAdmin
    && operationalAlertCount > 0
    && !isOperationTab
    && operationalSoundEnabled;
  shouldRepeatOperationalSoundRef.current = shouldRepeatOperationalSound;

  const clearOperationalSoundRepeat = React.useCallback(() => {
    if (operationalSoundRepeatTimeoutRef.current !== undefined) {
      window.clearTimeout(operationalSoundRepeatTimeoutRef.current);
      operationalSoundRepeatTimeoutRef.current = undefined;
    }
  }, []);

  const mesasNavAttentionEligible = Boolean(
    token && !isAdmin && !isAtendimentoMobile && permiteMesas && canAccess('mesas'),
  );

  // ── Título dinâmico + alerta operacional incremental ─────────────────────
React.useEffect(() => {
    if (!token || isAdmin || isAtendimentoMobile) return;

    const fetchOperationalAlerts = async () => {
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const from = `${yyyy}-${mm}-${dd} 00:00:00`;
      const to = `${yyyy}-${mm}-${dd} 23:59:59`;

      try {
        const qs = new URLSearchParams({ from, to, limit: '250' });
        const res = await fetch(`/api/orders?${qs.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        const orders = Array.isArray(data) ? data : [];
        const actionableOrders = orders.filter((order: Order) => {
          const column = mapOrderToCentralColumn(order, { segmentFinalStatus: segCfg.statusConcluido });
          return column === 'a_confirmar' || column === 'entrada';
        });
        const actionableIds = actionableOrders
          .map((order: Order) => Number(order.id))
          .filter((id) => Number.isFinite(id))
          .sort((a, b) => a - b);
        const previousIds = new Set(
          operationalAlertSnapshotRef.current
            .split(',')
            .map((value) => Number(value))
            .filter((id) => Number.isFinite(id))
        );
        const hasNewOperationalItem =
          operationalAlertLoadedRef.current && actionableIds.some((id) => !previousIds.has(id));

        operationalAlertSnapshotRef.current = actionableIds.join(',');
        operationalAlertLoadedRef.current = true;
        setOperationalAlertCount(actionableOrders.length);

        if (hasNewOperationalItem && operationalSoundEnabled) {
          playNewOrderSound();
        }

        if (isOperationTab) {
          setOperationalNeedsAttention(false);
          document.title = 'Pratory';
          return;
        }

        if (hasNewOperationalItem) {
          setOperationalNeedsAttention(true);
        }

        document.title = actionableOrders.length > 0
          ? `Operação (${actionableOrders.length}) — Pratory`
          : 'Pratory';
      } catch {}
    };

    // 1º poll depois do carregamento inicial (perfil/produtos/caixa em série)
    const BOOT_ALERT_DELAY_MS = 4500;
    let intervalId: number | undefined;
    const bootTimer = window.setTimeout(() => {
      fetchOperationalAlerts();
      intervalId = window.setInterval(fetchOperationalAlerts, 30000) as unknown as number;
    }, BOOT_ALERT_DELAY_MS);
    return () => {
      window.clearTimeout(bootTimer);
      if (intervalId) window.clearInterval(intervalId);
    };
  }, [token, isAdmin, isAtendimentoMobile, isOperationTab, operationalSoundEnabled, segCfg.statusConcluido]);

  useEffect(() => {
    if (!shouldRepeatOperationalSound) {
      clearOperationalSoundRepeat();
      return;
    }
    if (operationalSoundRepeatTimeoutRef.current !== undefined) {
      return;
    }
    const tick = () => {
      if (!shouldRepeatOperationalSoundRef.current) {
        clearOperationalSoundRepeat();
        return;
      }
      playNewOrderSound();
      operationalSoundRepeatTimeoutRef.current = window.setTimeout(tick, OPERATIONAL_ALERT_REPEAT_MS);
    };
    tick();
    return () => {
      clearOperationalSoundRepeat();
    };
  }, [shouldRepeatOperationalSound, clearOperationalSoundRepeat]);

  useEffect(() => {
    if (isOperationTab) {
      setOperationalNeedsAttention(false);
    }
  }, [isOperationTab]);

  useEffect(() => {
    localStorage.setItem(OPERATIONAL_ALERT_SOUND_KEY, String(operationalSoundEnabled));
  }, [operationalSoundEnabled]);

  useEffect(() => {
    if (!mesasNavAttentionEligible) {
      setOpenMesasCount(0);
      return;
    }
    const BOOT_MESAS_POLL_MS = 4500;
    let intervalId: number | undefined;
    const bootTimer = window.setTimeout(() => {
      void refreshOpenMesasCount();
      intervalId = window.setInterval(() => { void refreshOpenMesasCount(); }, 30000) as unknown as number;
    }, BOOT_MESAS_POLL_MS);
    return () => {
      window.clearTimeout(bootTimer);
      if (intervalId) window.clearInterval(intervalId);
    };
  }, [mesasNavAttentionEligible, refreshOpenMesasCount]);

  useEffect(() => {
    if (!mesasNavAttentionEligible) return;
    void refreshOpenMesasCount();
  }, [activeTab, mesasNavAttentionEligible, refreshOpenMesasCount]);
  
  // ── Rotas públicas — Tela Cliente ────────────────────────────────────────────
  // /delivery/:slug/pedido/:id → rastreamento do pedido pelo cliente
  if (trackingMatch) {
    return (
      <Suspense fallback={<PublicRouteFallback />}>
        <PedidoRastreamento slug={trackingMatch[1]} pedidoId={Number(trackingMatch[2])} />
      </Suspense>
    );
  }
  // /delivery/:slug → PÚBLICO — deve vir ANTES de qualquer check de token
  if (deliveryMatch) {
    return (
      <Suspense fallback={<PublicRouteFallback />}>
        <DeliveryCardapio />
      </Suspense>
    );
  }
  if (displayMatch) {
    return (
      <Suspense fallback={<PublicRouteFallback />}>
        <ClienteDisplayScreen slug={displayMatch[1]} />
      </Suspense>
    );
  }
  // /mesa/:slug/:numero  →  Display individual da mesa (celular do cliente)
  if (mesaMatch) {
    return (
      <Suspense fallback={<PublicRouteFallback />}>
        <ClienteMesaScreen slug={mesaMatch[1]} mesa={mesaMatch[2]} />
      </Suspense>
    );
  }

  if (isLegalPublicPage) {
    return (
      <Suspense fallback={<PublicRouteFallback />}>
        {path === '/privacidade' ? <PrivacyPolicyPublicPage /> : <TermsOfUsePublicPage />}
      </Suspense>
    );
  }

  // ── Rota pública legada desativada ───────────────────────────────────────────
  if (bookingSlug) return <SegmentDisabledNotice />;
  if (kdsSlug) {
    return (
      <Suspense fallback={<PublicRouteFallback />}>
        <KDSScreen slug={kdsSlug} />
      </Suspense>
    );
  }

  const fetchCaixa = async () => {
    try {
      const res = await fetch('/api/caixa/hoje', {
        headers: { Authorization: "Bearer " + localStorage.getItem('token') }
      });
      const data = await res.json();
      setCurrentCaixa(data);
    } catch (err) {
      console.error("Erro ao carregar caixa", err);
    }
  };

  useEffect(() => {
    if (!token) return;
    // Independentes: perfil / produtos / caixa não se ordenam entre si; paralelo reduz tempo até UI pronta.
    void Promise.all([fetchProducts(), fetchCaixa(), fetchPerfil()]);
  }, [token, isAtendimentoMobile]);

const fetchPerfil = async () => {
    try {
      const res = await fetch('/api/settings/profile', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.nome_estabelecimento) setEstabelecimentoNome(data.nome_estabelecimento);
        if (typeof data.logo_url === 'string' && data.logo_url) setLogoUrl(data.logo_url);
        else if (data.logo_url === null) setLogoUrl(null);
        if (data.segmento) setEstabelecimentoSegmento(getOperationalSegment(data.segmento));
        const nextPlanFeatures = sanitizePlanFeatures(data.plan_features);
        setPlanFeatures(nextPlanFeatures);
        localStorage.setItem(PLAN_FEATURES_STORAGE_KEY, JSON.stringify(nextPlanFeatures));
        setPlanProfile({
          plano: data.plano || 'completo',
          trial_ativo: !!data.trial_ativo,
          trial_fim: data.trial_fim || null,
          vencimento: data.vencimento || null,
        });
        setTaxasPagamento({
          debito:  data.taxa_debito  || 0,
          credito: data.taxa_credito || 0,
          pix:     data.taxa_pix     || 0,
        });

        // Não armazenamos senhas no localStorage — verificação sempre server-side
        setSenhaPadrao(!!data.senha_padrao);

        const cargo = data.cargo || 'dono';
        const perms = data.permissoes || null;
        const nome  = data.nome_usuario || '';
        setUserCargo(cargo);
        setUserPermissoes(perms);
        setUserName(nome);
        localStorage.setItem('user_cargo', cargo);
        localStorage.setItem('user_permissoes', perms ? JSON.stringify(perms) : '');
        localStorage.setItem('user_nome', nome);
      } else {
        setPlanFeatures((current) => (current.length > 0 ? current : getSafeFallbackPlanFeatures()));
      }
    } catch (err) {
      setPlanFeatures((current) => (current.length > 0 ? current : getSafeFallbackPlanFeatures()));
    }
  };

const fetchProducts = async () => {
    try {
      const token = localStorage.getItem("token");

      const res = await fetch('/api/products', {
        cache: 'no-store',
        headers: {
          Authorization: "Bearer " + token
        }
      });

      const data = await res.json();
      
      // TRAVA DE SEGURANÇA: Só aceita se for uma lista (array)
      if (Array.isArray(data)) {
        setProducts(data);
      } else {
        setProducts([]); // Evita tela branca
      }
    } catch (err) {
      console.error("Erro ao carregar produtos", err);
      setProducts([]); 
    }
  };

  const handleTabChange = (tab: any) => {
    if (!canAccess(tab)) {
      return;
    }
    if (tab === 'abrir-caixa' || tab === 'fechar-caixa') {
      setPendingTab(tab);
      setShowAuthModal(true);
      setAuthPassword('');
      return;
    }
    setActiveTab(tab);
    setMobileNavOpen(false);
  };

  useEffect(() => {
    if (!token) return;
    if (canAccess(activeTab)) return;

    const fallbackTabs = ['pos', 'orders', 'dashboard', 'products', 'configuracoes'];
    const fallback = fallbackTabs.find((tab) => canAccess(tab));
    if (fallback) {
      setActiveTab(fallback as typeof activeTab);
    }
  }, [token, activeTab, userPermissoes, planFeatures, planProfile]);

const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pendingTab === 'abrir-caixa' || pendingTab === 'fechar-caixa') {
      try {
        const res = await fetch('/api/auth/verify-caixa', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ senha: authPassword }),
        });
        if (res.ok) {
          setShowCaixaModal(pendingTab === 'abrir-caixa' ? 'abrir' : 'fechar');
          setShowAuthModal(false);
          setAuthPassword('');
          setPendingTab(null);
        } else {
          alert('Senha do caixa incorreta!');
        }
      } catch {
        alert('Erro de conexão ao verificar senha.');
      }
    }
  };

  // ── Registra log de atividade ─────────────────────────────────────────────
  const postLog = (acao: string, detalhes?: string) => {
    if (!token) return;
    fetch('/api/logs', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ acao, ...(detalhes != null && detalhes !== '' ? { detalhes } : {}) }),
    }).catch(() => {});
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user_cargo');
    localStorage.removeItem('user_permissoes');
    localStorage.removeItem('user_nome');
    localStorage.removeItem(PLAN_FEATURES_STORAGE_KEY);
    setUserCargo('dono');
    setUserPermissoes(null);
    setUserName('');
    setPlanFeatures(getSafeFallbackPlanFeatures());
    setPlanProfile(null);
    setLegalNeedsAcceptance(false);
    setLegalGateResolved(true);
    setToken(null);
  };

  useEffect(() => {
    if (!token) {
      setLegalNeedsAcceptance(false);
      setLegalGateResolved(true);
      return;
    }

    let cancelled = false;
    setLegalGateResolved(false);

    (async () => {
      try {
        const res = await fetch('/api/legal/status', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error('legal_status');
        const data = (await res.json()) as { needs_acceptance?: boolean };
        if (!cancelled) setLegalNeedsAcceptance(!!data.needs_acceptance);
      } catch {
        if (!cancelled) setLegalNeedsAcceptance(false);
      } finally {
        if (!cancelled) setLegalGateResolved(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  const isProtectedApiUrl = (url: string) =>
    url.includes('/api/')
    && !url.includes('/api/login')
    && !url.includes('/api/v1/login')
    && !url.includes('/api/admin')
    && !url.includes('/api/v1/admin');

  const isSessionInvalidResponse = async (response: Response) => {
    if (response.status === 401) return true;
    if (response.status !== 403) return false;

    try {
      const cloned = response.clone();
      const contentType = cloned.headers.get('content-type') || '';
      const payload = contentType.includes('application/json')
        ? await cloned.json()
        : { error: await cloned.text() };
      const message = String(payload?.error || payload?.message || '').trim().toLowerCase();

      return (
        message.includes('token inválido')
        || message.includes('token invalido')
        || message.includes('token expirado')
        || message.includes('sessão inválida')
        || message.includes('sessao invalida')
        || message.includes('sessão expirada')
        || message.includes('sessao expirada')
      );
    } catch {
      return false;
    }
  };

  // ── Interceptor global: sessão inválida → logout automático ───────────────
  // O backend pode responder 401 ou 403 para token inválido/expirado.
  // Fazemos logout apenas quando a resposta indica de fato sessão inválida,
  // sem derrubar o usuário em 403 de regra de negócio (ex.: bloqueio/trial).
  useEffect(() => {
    // Guard contra registro duplo (React StrictMode monta/desmonta duas vezes em dev)
    const INTERCEPTED = Symbol.for('flowpdv_fetch_intercepted');
    if ((window.fetch as any)[INTERCEPTED]) return;

    const originalFetch = window.fetch;
    const intercepted = async (...args: Parameters<typeof fetch>) => {
      const response = await originalFetch(...args);
      const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request).url;

      if (isProtectedApiUrl(url) && await isSessionInvalidResponse(response)) {
        console.warn('[Auth] Sessão inválida detectada — fazendo logout automático.');
        handleLogout();
      }
      return response;
    };
    (intercepted as any)[INTERCEPTED] = true;
    window.fetch = intercepted;
    return () => { window.fetch = originalFetch; };
  }, []); // sem deps — usa handleLogout via closure estável

  if (isAdmin) {
    return (
      <Suspense fallback={<PublicRouteFallback />}>
        <AdminPanel />
      </Suspense>
    );
  }

  // QR temporário do garçom: acesso público, sem login pessoal — a validade
  // do token (3h) é conferida pelo próprio back-end a cada chamada.
  if (isGarcomMobile && garcomQrToken) {
    return (
      <Suspense fallback={<PublicRouteFallback />}>
        <GarcomMobileScreen qrToken={garcomQrToken} />
      </Suspense>
    );
  }

  if (licenseError) return <LicenseBlockedScreen type={licenseError} onBack={() => { setLicenseError(null); handleLogout(); }} />;

  if (!token) {
    return (
      <>
        <LoginScreen 
          onLogin={(t) => {
              setToken(t);
              localStorage.setItem('token', t);
              setLegalGateResolved(false);
              setShowMenuHub(true);
              try { setSlugAtual((JSON.parse(atob(t.split('.')[1])) as any).username || ''); } catch {}
            }} 
          onShowSolicitacao={() => setShowSolicitacao(true)}
          onLicenseError={(type) => setLicenseError(type)}
        />
        <Suspense fallback={null}>
          <SolicitacaoModal isOpen={showSolicitacao} onClose={() => setShowSolicitacao(false)} />
        </Suspense>
      </>
    );
  }

  if (!legalGateResolved) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-fp-app px-4">
        <div className="text-center">
          <div className="mx-auto h-9 w-9 animate-spin rounded-full border-2 border-fp-border border-t-fp-accent" />
          <p className="mt-4 text-sm font-medium text-fptext-muted">Verificando termos e privacidade…</p>
        </div>
      </div>
    );
  }

  if (legalNeedsAcceptance) {
    return (
      <LegalAcceptanceGate
        token={token}
        onAccepted={() => setLegalNeedsAcceptance(false)}
      />
    );
  }

  if (isAtendimentoMobile) {
    return (
      <Suspense fallback={<PublicRouteFallback />}>
        <AtendimentoMobileScreen token={token} />
      </Suspense>
    );
  }

  if (showMenuHub) {
    const hubItemDefs: { tab: string; label: string; description: string; requires?: boolean }[] = [
      { tab: 'pos',            label: segCfg.labelSidebarPOS,      description: 'Abrir o ponto de venda e realizar pedidos' },
      { tab: 'delivery',       label: 'Delivery',                  description: 'Gerenciar pedidos de delivery',            requires: permiteDelivery },
      { tab: 'mesas',          label: 'Mesas',                     description: 'Gerenciar mesas e comandas',                requires: permiteMesas },
      { tab: 'orders',         label: 'Pedidos',                   description: 'Acompanhar todos os pedidos' },
      { tab: 'products',       label: segCfg.labelSidebarProdutos, description: 'Gerenciar produtos, categorias e opções' },
      { tab: 'clientes',       label: 'Clientes',                  description: 'Gerenciar clientes e cadastros',            requires: permiteDelivery },
      { tab: 'dashboard',      label: 'Dashboard',                 description: 'Visualizar indicadores do negócio' },
      { tab: 'finance',        label: 'Financeiro',                description: 'Controle financeiro e caixa' },
      { tab: 'configuracoes',  label: 'Configurações',             description: 'Configurar o sistema e preferências' },
    ];

    const hubItems = hubItemDefs
      .filter((item) => item.requires !== false && canAccess(item.tab))
      .map((item) => ({
        tab: item.tab,
        label: item.label,
        description: item.description,
        icon: DEFAULT_ICONS[item.tab] ?? DEFAULT_ICONS.pos,
      }));

    return (
      <MenuHubScreen
        userName={estabelecimentoNome}
        userRoleLabel={userRoleLabel}
        items={hubItems}
        onSelect={(tab) => {
          handleTabChange(tab);
          setShowMenuHub(false);
        }}
        onLogout={handleLogout}
        supportPhone="5582996490367"
      />
    );
  }

  return (
    <ChunkLoadErrorBoundary>
    <div className="flex h-screen min-h-0 bg-fp-app overflow-hidden flex-col lg:flex-row">
      {mobileNavOpen && (
        <button
          type="button"
          aria-label="Fechar menu"
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <aside
        className={`
          fixed lg:static inset-y-0 left-0 z-50
          w-[min(100%,14rem)] max-w-[85vw] sm:w-[15rem]
          ${activeTab === 'central'
            ? 'lg:w-[11rem] xl:w-48 2xl:w-60'
            : 'lg:w-[13rem] xl:w-56 2xl:w-60'}
          bg-fp-card border-r border-fp-border flex flex-col h-screen min-h-0 shrink-0
          transition-[transform,width] duration-200 ease-out
          ${mobileNavOpen ? 'translate-x-0' : '-translate-x-full'}
          lg:translate-x-0
        `}
      >
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="border-b border-fp-border-soft bg-fp-secondary p-3 sm:p-4 lg:p-3 xl:p-4 [@media(max-height:700px)]:p-2.5">
          <div className="rounded-3xl border border-fp-border bg-fp-card p-3 shadow-sm lg:p-3 xl:p-3.5 [@media(max-height:700px)]:p-2.5">
            <div className="flex items-start gap-3">
            <label className="cursor-pointer group relative" title="Clique para trocar a logo">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const formData = new FormData();
                  formData.append('logo', file);
                  const res = await fetch('/api/settings/logo', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` },
                    body: formData
                  });
                  const data = await res.json();
                  if (data.success) setLogoUrl(data.logo_url + '?t=' + Date.now()); // cache bust
                }}
              />
              {logoUrl ? (
                <div className="h-14 w-14 [@media(max-height:700px)]:h-10 [@media(max-height:700px)]:w-10 overflow-hidden rounded-2xl ring-2 ring-transparent transition-all group-hover:ring-[#DA5D69]/60">
                  <img
                    src={logoUrl}
                    alt="Logo"
                    className="w-full h-full object-cover"
                  />
                </div>
              ) : (
                <div className="flex h-14 w-14 [@media(max-height:700px)]:h-10 [@media(max-height:700px)]:w-10 items-center justify-center rounded-2xl bg-[#EA1D2C] text-sm font-black uppercase tracking-[0.18em] text-white transition-colors group-hover:bg-[#9C050B]">
                  {estabelecimentoMonogram}
                </div>
              )}
              <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
            </label>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-fptext-muted">Seu painel</p>
              <h1 className="mt-1 truncate text-lg [@media(max-height:700px)]:text-sm font-black leading-tight text-fptext-primary">{estabelecimentoNome}</h1>
              <p className="mt-2 truncate text-sm font-semibold text-fptext-primary">{userDisplayName}</p>
              <p className="mt-1 text-xs text-fptext-muted">{userSecondaryLine}</p>
            </div>
          </div>
            <div className="mt-4">
              <PlanBadge profile={planProfile} compact />
            </div>
          </div>
        </div>

        {/* Status do Caixa */}
        <div className="border-b border-fp-border-soft px-3 py-2.5 lg:px-3 lg:py-3 xl:px-5 xl:py-3.5 [@media(max-height:700px)]:px-2.5 [@media(max-height:700px)]:py-2">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${currentCaixa?.status === 'aberto' ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
              <span className="text-xs font-bold text-fptext-primary">
                {currentCaixa?.status === 'aberto' ? 'Caixa Aberto' : 'Caixa Fechado'}
              </span>
            </div>
          </div>
          {currentCaixa?.status === 'aberto' ? (
            <div className="space-y-1 mb-3">
              <p className="text-[10px] text-fptext-muted uppercase font-bold">Início: {new Date(currentCaixa.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</p>
              <p className="text-[10px] text-fptext-muted uppercase font-bold">Fundo: R$ {currentCaixa.fundo_inicial.toFixed(2)}</p>
            </div>
          ) : null}
          
          {currentCaixa?.status === 'aberto' ? (
            <Button 
              variant="secondary" 
              className="w-full py-1.5 text-[10px] uppercase tracking-wider"
              onClick={() => {
                setPendingTab('fechar-caixa');
                setShowAuthModal(true);
              }}
            >
              Fechar Caixa
            </Button>
          ) : (
            <Button 
              variant="primary" 
              className="w-full py-1.5 text-[10px] uppercase tracking-wider"
              onClick={() => {
                setPendingTab('abrir-caixa');
                setShowAuthModal(true);
              }}
              disabled={currentCaixa == null || currentCaixa.can_open_caixa === false}
            >
              Abrir Caixa
            </Button>
          )}
        </div>

     <nav className="flex-1 min-h-0 space-y-1.5 overflow-y-auto p-2.5 lg:p-2.5 lg:space-y-1 xl:p-3 xl:space-y-1.5">
          {(() => { return (<> 
            <NavItem active={false} onClick={() => setShowMenuHub(true)} icon="🏠" label="Menu" />
            {canAccess('pos')    && <NavItem active={activeTab === 'pos'}    onClick={() => handleTabChange('pos')}    icon="🛒" label={segCfg.labelSidebarPOS} />}
            {canAccess('orders') && (
              <>
                <NavItem
                  active={activeTab === 'central'}
                  attention={operationalNeedsAttention}
                  badgeCount={operationalAlertCount > 0 ? operationalAlertCount : undefined}
                  onClick={() => handleTabChange('central')}
                  icon="🧩"
                  label="Operação"
                />
                <NavItem
                  active={activeTab === 'orders'}
                  onClick={() => handleTabChange('orders')}
                  icon="📜"
                  label="Consulta de pedidos"
                />
              </>
            )}
            {canAccess('delivery') && permiteDelivery && (
              <NavItem active={activeTab === 'delivery'} onClick={() => handleTabChange('delivery')} icon="🛵" label="Delivery" />
            )}
            {permiteMesas && canAccess('mesas') && (
              <NavItem
                active={activeTab === 'mesas'}
                attention={openMesasCount > 0 && activeTab !== 'mesas'}
                badgeCount={openMesasCount > 0 ? openMesasCount : undefined}
                onClick={() => handleTabChange('mesas')}
                icon="🍽️"
                label="Mesas"
              />
            )}
            {canAccess('products') && <NavItem active={activeTab === 'products'} onClick={() => handleTabChange('products')} icon="📖" label={segCfg.labelSidebarProdutos} />}
            {canAccess('clientes') && permiteDelivery && (
              <NavItem active={activeTab === 'clientes'} onClick={() => handleTabChange('clientes')} icon="👥" label="Clientes" />
            )}
            {canAccess('whatsapp-ia') && permiteDelivery && (
              <NavItem active={activeTab === 'whatsapp-ia'} onClick={() => handleTabChange('whatsapp-ia')} icon="💬" label="WhatsApp IA" />
            )}
            {canAccess('estoque')  && <NavItem active={activeTab === 'estoque'}  onClick={() => handleTabChange('estoque')}  icon="📦"  label="Estoque" />}
          </>); })()}
          {canAccess('nfse') && (
            <NavItem active={activeTab === 'fiscal'} onClick={() => handleTabChange('fiscal')} icon="📊" label="Fiscal" />
          )}
          {canAccess('dashboard')    && <NavItem active={activeTab === 'dashboard'}    onClick={() => handleTabChange('dashboard')}    icon="📊" label="Dashboard" />}
          {canAccess('finance')      && <NavItem active={activeTab === 'finance'}      onClick={() => handleTabChange('finance')}      icon="💰"      label="Financeiro" />}
          {canAccess('funcionarios') && <NavItem active={activeTab === 'funcionarios'} onClick={() => handleTabChange('funcionarios')} icon="👥"           label="RH" />}
          {canAccess('logs')         && <NavItem active={activeTab === 'logs'}         onClick={() => handleTabChange('logs')}         icon="🕘"         label="Logs" />}
          {canAccess('configuracoes')&& <NavItem active={activeTab === 'configuracoes'} onClick={() => handleTabChange('configuracoes')}  icon="⚙️"        label="Configurações" />}
        </nav>


        </div>{/* fim área scrollável */}

        <div className="flex-shrink-0 space-y-2 border-t border-fp-border-soft p-2.5 lg:p-2.5 xl:space-y-2.5 xl:p-3">
          <div className="flex items-center justify-between px-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-fptext-muted">Utilitários</p>
            <p className="text-[10px] text-fptext-muted">Tema, alertas e sessão</p>
          </div>
          <div className={`grid gap-2 ${alertsEnabled ? 'grid-cols-4' : 'grid-cols-3'}`}>
            {alertsEnabled && (
              <button
                type="button"
                onClick={() => setNotifCenterOpen(true)}
                title="Alertas"
                aria-label="Alertas"
                className="relative flex min-h-[48px] w-full items-center justify-center rounded-xl border border-fp-border bg-fp-card px-2 text-[18px] leading-none text-fptext-secondary transition-all hover:border-fp-border hover:bg-fp-hover hover:text-fptext-primary active:scale-[0.98] lg:min-h-[52px] lg:rounded-2xl lg:px-3"
              >
                <span className="select-none" aria-hidden>🔔</span>
                {avisosNaoLidos > 0 && (
                  <span className="absolute right-2 top-2 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-black leading-none text-white">
                    {avisosNaoLidos > 9 ? '9+' : avisosNaoLidos}
                  </span>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => setOperationalSoundEnabled((value) => !value)}
              title={operationalSoundEnabled ? 'Desativar som da Operação' : 'Ativar som da Operação'}
              aria-label={operationalSoundEnabled ? 'Desativar som da Operação' : 'Ativar som da Operação'}
              className={`flex min-h-[48px] w-full items-center justify-center rounded-xl border px-2 text-[18px] leading-none transition-all active:scale-[0.98] lg:min-h-[52px] lg:rounded-2xl lg:px-3 ${
                operationalSoundEnabled
                  ? 'border-red-200 bg-red-50 text-red-800 hover:border-red-300 hover:bg-red-100 [.flowpdv-dark_&]:border-red-900/50 [.flowpdv-dark_&]:bg-red-950/35 [.flowpdv-dark_&]:text-red-200 [.flowpdv-dark_&]:hover:border-red-800 [.flowpdv-dark_&]:hover:bg-red-950/50'
                  : 'border-fp-border bg-fp-card text-fptext-secondary hover:border-fp-border hover:bg-fp-hover hover:text-fptext-primary'
              }`}
            >
              <span className="select-none" aria-hidden>{operationalSoundEnabled ? '🔊' : '🔇'}</span>
            </button>
            <button
              type="button"
              onClick={() => setDarkMode(v => !v)}
              title={darkMode ? 'Modo claro' : 'Modo escuro'}
              aria-label={darkMode ? 'Ativar modo claro' : 'Ativar modo escuro'}
              className="flex min-h-[48px] w-full items-center justify-center rounded-xl border border-fp-border bg-fp-card px-2 text-[18px] leading-none text-fptext-secondary transition-all hover:border-fp-border hover:bg-fp-hover hover:text-fptext-primary active:scale-[0.98] lg:min-h-[52px] lg:rounded-2xl lg:px-3"
            >
              <span className="select-none" aria-hidden>{darkMode ? '🌙' : '☀️'}</span>
            </button>
            <button
              type="button"
              onClick={handleLogout}
              title="Sair do sistema"
              aria-label="Sair do sistema"
              className="flex min-h-[48px] w-full items-center justify-center rounded-xl border border-fp-border bg-fp-card px-2 text-[18px] leading-none text-fptext-secondary transition-all hover:border-red-200 hover:bg-red-50 hover:text-red-700 active:scale-[0.98] lg:min-h-[52px] lg:rounded-2xl lg:px-3 [.flowpdv-dark_&]:hover:bg-red-950/40 [.flowpdv-dark_&]:hover:text-red-300"
            >
              <span className="select-none" aria-hidden>🚪</span>
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center gap-2 border-b border-fp-border bg-fp-card px-2.5 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] lg:hidden">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            className="p-2.5 rounded-xl border border-fp-border text-fptext-primary min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0 active:bg-fp-hover"
            aria-label="Abrir menu"
          >
            <Menu size={22} strokeWidth={2} />
          </button>
          <div className="min-w-0 flex-1">
            <p className="font-bold text-fptext-primary truncate leading-tight">{estabelecimentoNome}</p>
            <p className="text-[11px] text-fptext-muted truncate">{`${userDisplayName} · ${userSecondaryLine}`}</p>
          </div>
        </header>

      {/* Botão flutuante — atalho para Operação (visão ao vivo) */}
      {canAccess('orders') && (
        <div
          title="Operação — visão ao vivo (atalho)"
          style={{ position: 'fixed', left: floatPos.x, top: floatPos.y, zIndex: 999, cursor: floatDrag.current.dragging ? 'grabbing' : 'grab', userSelect: 'none' }}
          onMouseDown={(e) => {
            floatDrag.current = { dragging: true, ox: e.clientX - floatPos.x, oy: e.clientY - floatPos.y, hasDragged: false };
            const onMove = (ev: MouseEvent) => {
              if (!floatDrag.current.dragging) return;
              const nx = Math.max(0, Math.min(window.innerWidth - 56, ev.clientX - floatDrag.current.ox));
              const ny = Math.max(0, Math.min(window.innerHeight - 56, ev.clientY - floatDrag.current.oy));
              floatDrag.current.hasDragged = true;
              setFloatPos({ x: nx, y: ny });
            };
            const onUp = () => {
              floatDrag.current.dragging = false;
              localStorage.setItem('orders_float_pos', JSON.stringify(floatPos));
              window.removeEventListener('mousemove', onMove);
              window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
          }}
          onClick={() => {
            // hasDragged garante que um drag longo não abre a tela ao soltar
            if (!floatDrag.current.hasDragged) handleTabChange('central');
            floatDrag.current.hasDragged = false;
          }}
        >
          <div className={`relative flex h-14 w-14 items-center justify-center rounded-2xl border shadow-xl transition-all hover:scale-110 active:scale-95 ${
            activeTab === 'orders' || activeTab === 'central'
              ? 'border-zinc-900 bg-zinc-900 text-white'
              : operationalNeedsAttention
                ? 'border-amber-300 bg-amber-50 text-amber-900'
                : 'border-zinc-200 bg-white text-zinc-700'
          }`}>
            {operationalAlertCount > 0 && (
              <span className={`absolute -right-1 -top-1 min-w-[20px] rounded-full px-1 py-0.5 text-center text-[10px] font-black leading-none ${
                operationalNeedsAttention ? 'bg-amber-500 text-white animate-pulse' : 'bg-zinc-900 text-white'
              }`}>
                {operationalAlertCount > 99 ? '99+' : operationalAlertCount}
              </span>
            )}
            <span className="text-[20px] leading-none" aria-hidden>🧩</span>
          </div>
        </div>
      )}



      {/* Área de Conteúdo Principal */}
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-auto" style={{ zIndex: 2 }}>

        {/* ── Banner senha padrão ───────────────────────────────────── */}
        {senhaPadrao && userCargo === 'dono' && (
          <div className="bg-amber-50 border-b border-amber-200 px-4 py-2.5 flex flex-col sm:flex-row sm:items-center gap-3 shrink-0">
            <span className="text-amber-600 shrink-0">⚠️</span>
            <p className="text-xs text-amber-800 font-medium flex-1">
              <strong>Senha padrão detectada.</strong> Acesse <strong>Configurações → Alterar senhas</strong> para proteger o sistema.
            </p>
            <button
              onClick={() => handleTabChange('configuracoes')}
              className="text-[11px] font-black text-amber-700 hover:text-amber-900 bg-amber-100 hover:bg-amber-200 px-3 py-2 rounded-lg transition-all shrink-0 self-start sm:self-auto min-h-[40px]"
            >
              Alterar agora →
            </button>
          </div>
        )}

        <AnimatePresence mode="wait">
          <Suspense fallback={<TabLoadingFallback />}>
            {activeTab === 'pos' && canAccess('pos') && <POSScreen token={token} products={products} estabelecimentoSegmento={segmentoOperacional} taxasPagamento={taxasPagamento} />}
            {activeTab === 'orders' && canAccess('orders') && <OrdersScreen token={token} segmento={segmentoOperacional} displaySlug={slugAtual} onShowQR={() => setShowQRModal(true)} />}
            {activeTab === 'central' && canAccess('orders') && (
              <CentralPedidosScreen
                  token={token}
                  segmento={segmentoOperacional}
                  hasMotoboyFeature={tenantHasMotoboyFeature}
                />
            )}
            {activeTab === 'dashboard' && canAccess('dashboard') && <DashboardScreen token={token} segmento={segmentoOperacional} onGoToPOS={() => handleTabChange('pos')} />}
            {activeTab === 'products' && canAccess('products') && (
              <ProductsScreen
                products={products}
                onUpdate={fetchProducts}
                token={token}
                estabelecimentoNome={estabelecimentoNome}
                logoUrl={logoUrl}
                deliverySlug={slugAtual}
              />
            )}
            {activeTab === 'clientes' && canAccess('clientes') && permiteDelivery && (
              <TabClientes token={token} />
            )}
            {activeTab === 'estoque' && canAccess('estoque') && <EstoqueScreen token={token} segmento={segmentoOperacional} />}
            {activeTab === 'delivery' && canAccess('delivery') && permiteDelivery && (
              <DeliveryScreen token={token} hasMotoboyFeature={tenantHasMotoboyFeature} slug={slugAtual} />
            )}
            {activeTab === 'whatsapp-ia' && canAccess('whatsapp-ia') && permiteDelivery && (
              <WhatsAppIAScreen token={token} slug={slugAtual} />
            )}
            {activeTab === 'mesas' && canAccess('mesas') && permiteMesas && <MesasScreen token={token} taxasPagamento={taxasPagamento} />}
            {activeTab === 'finance' && canAccess('finance') && <FinanceScreen token={token} segmento={segmentoOperacional} />}
            {activeTab === 'fiscal' && canAccess('nfse') && <FiscalScreen token={token} />}
            {activeTab === 'funcionarios' && canAccess('funcionarios') && <RHScreen token={token} />}
            {activeTab === 'logs' && canAccess('logs') && <SystemLogsScreen token={token} />}
            {activeTab === 'configuracoes' && canAccess('configuracoes') && <ConfiguracoesScreen token={token} darkMode={darkMode} setDarkMode={setDarkMode} />}
          </Suspense>
        </AnimatePresence>

        {/* Modal de Autenticação para Áreas Restritas */}
        <AnimatePresence>
          {showAuthModal && (
            <div className="fixed inset-0 z-[100] flex items-end justify-center overflow-y-auto bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-6">
              <motion.div 
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="my-auto flex w-full max-w-sm flex-col overflow-y-auto rounded-t-3xl border border-fp-border bg-fp-card p-5 shadow-2xl max-h-[min(92dvh,100svh)] min-h-0 sm:max-h-[min(90dvh,560px)] sm:rounded-3xl sm:p-8 pb-[max(1rem,env(safe-area-inset-bottom))]"
              >
                <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-fp-secondary text-fptext-primary">
                  <Lock size={32} />
                </div>
                <h3 className="text-center text-2xl font-bold text-fptext-primary">Área Restrita</h3>
                <p className="mb-8 mt-2 text-center text-fptext-muted">Digite a senha de acesso para continuar.</p>
                
                <form onSubmit={handleAuth} className="space-y-4">
                  <Input 
                    label="Senha de Acesso" 
                    type="password" 
                    value={authPassword} 
                    onChange={(e: any) => setAuthPassword(e.target.value)}
                    placeholder="••••••"
                    autoFocus
                    required
                  />
                  <div className="flex gap-3 pt-2">
                    <Button variant="ghost" className="flex-1" onClick={() => { setShowAuthModal(false); setAuthPassword(''); }}>
                      Cancelar
                    </Button>
                    <Button type="submit" className="flex-1">
                      Acessar
                    </Button>
                  </div>
                </form>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Modais de Caixa */}
        <AnimatePresence>
          {showCaixaModal === 'abrir' && (
            <Suspense fallback={null}>
              <OpenCaixaModal
                onClose={() => setShowCaixaModal(null)}
                onSuccess={() => {
                  setShowCaixaModal(null);
                  fetchCaixa();
                  postLog('CAIXA_ABERTO', `${userName || 'Usuário'} abriu o caixa`);
                }}
                token={token}
              />
            </Suspense>
          )}
          {showCaixaModal === 'fechar' && (
            <Suspense fallback={null}>
              <CloseCaixaModal
                onClose={() => setShowCaixaModal(null)}
                onSuccess={() => {
                  setShowCaixaModal(null);
                  fetchCaixa();
                  postLog('CAIXA_FECHADO', `${userName || 'Usuário'} fechou o caixa`);
                }}
                token={token}
              />
            </Suspense>
          )}
        </AnimatePresence>
      </main>

      {/* ── Modal QR das Mesas ──────────────────────────────────────────── */}
      <AnimatePresence>
        {showQRModal && (
          <QRMesasModal slug={slugAtual} token={token} onClose={() => setShowQRModal(false)} />
        )}
      </AnimatePresence>

      {/* ── FlowAI Popup proativo ─────────────────────────────────────────── */}
      <AnimatePresence>
        {alertsPopupEnabled && avisoAtivo && (
          <Suspense fallback={null}>
            <FlowAIPopup
              aviso={avisoAtivo}
              onDismiss={(id) => { marcarLido(id); proximoAviso(); }}
              onAcao={(rota) => {
                const tab = rota.replace('/', '') as any;
                handleTabChange(tab);
                if (avisoAtivo) { marcarLido(avisoAtivo.id); proximoAviso(); }
              }}
            />
          </Suspense>
        )}
      </AnimatePresence>

      {/* ── Central de Notificações ───────────────────────────────────────── */}
      {alertsEnabled && (
        <Suspense fallback={null}>
          <NotificationCenter
            open={notifCenterOpen}
            onClose={() => setNotifCenterOpen(false)}
            historico={historico}
            carregandoHist={carregandoHist}
            avisosNaoLidos={avisosNaoLidos}
            onMarcarLido={marcarLido}
            onMarcarTodosLidos={marcarTodosLidos}
            onAcao={(rota) => {
              const tab = rota.replace('/', '') as any;
              handleTabChange(tab);
              setNotifCenterOpen(false);
            }}
            onRefresh={refreshNotifHistorico}
          />
        </Suspense>
      )}
      </div>
    </div>
    </ChunkLoadErrorBoundary>
  );
}

// --- SUB-COMPONENTES DE UI ---

// Constante global para contato comercial
const WA_NUMBER = '5500000000000';
const WA_LINK = `https://wa.me/${WA_NUMBER}?text=Olá!%20Tenho%20interesse%20no%20Pratory`;

function SegmentDisabledNotice() {
  return (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white border border-zinc-200 rounded-3xl shadow-xl p-8 text-center">
        <div className="w-16 h-16 mx-auto mb-5 rounded-2xl bg-zinc-100 flex items-center justify-center text-3xl">
          🍽️
        </div>
        <h1 className="text-2xl font-black text-zinc-900">Página pública indisponível</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-500">
          Este link público não está disponível nesta versão do Pratory para operações de food service.
        </p>
        <a
          href="/"
          className="inline-flex items-center justify-center mt-6 px-5 py-3 rounded-2xl bg-zinc-900 text-white text-sm font-bold hover:bg-zinc-800 transition-colors"
        >
          Voltar ao inicio
        </a>
      </div>
    </div>
  );
}

function QRMesasModal({ slug, token, onClose }: { slug: string; token: string | null; onClose: () => void }) {
  const [mesas, setMesas] = React.useState<{ numero: number }[]>([]);
  const [loading, setLoading] = React.useState(true);
  const baseUrl = window.location.origin;

  React.useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/mesas', { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) {
          const data = await res.json();
          setMesas((data as any[]).map((m: any) => ({ numero: m.numero })));
        }
      } catch { /* sem mesas */ }
      setLoading(false);
    })();
  }, [token]);

  const mesaUrl = (num: number) => `${baseUrl}/mesa/${slug}/${num}`;
  const qrSrc   = (url: string) =>
    `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}&bgcolor=ffffff&color=000000&margin=8`;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[200] flex items-center justify-center p-4" onClick={onClose}>
      <motion.div
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.92, opacity: 0 }}
        className="bg-white rounded-3xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-8 py-5 border-b border-zinc-100">
          <div>
            <h2 className="text-xl font-black text-zinc-900">🪑 QR Codes das Mesas</h2>
            <p className="text-xs text-zinc-400 mt-0.5">Imprima e cole em cada mesa. O cliente escaneia e acompanha o pedido.</p>
          </div>
          <div className="flex items-center gap-3">
            <a href={`/display/${slug}`} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-xl text-sm font-bold hover:bg-zinc-700 transition-colors">
              <Monitor size={15} /> Tela Cliente
            </a>
            <button onClick={() => window.print()}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 transition-colors">
              🖨️ Imprimir
            </button>
            <button onClick={onClose} className="p-2 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 rounded-xl transition-colors font-bold">✕</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-8">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-zinc-400">
              <div className="text-center"><div className="text-4xl mb-3">⏳</div><p className="text-sm">Carregando mesas...</p></div>
            </div>
          ) : mesas.length === 0 ? (
            <div className="flex items-center justify-center py-16">
              <div className="text-center">
                <div className="text-5xl mb-3">🪑</div>
                <p className="font-semibold text-zinc-600">Nenhuma mesa configurada</p>
                <p className="text-sm text-zinc-400 mt-1">Configure as mesas em <strong>Mesas → Configurar</strong> primeiro.</p>
              </div>
            </div>
          ) : (
            <div className="grid gap-6" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
              {mesas.map(({ numero }) => {
                const url = mesaUrl(numero);
                return (
                  <div key={numero} className="border-2 border-zinc-200 rounded-2xl p-4 flex flex-col items-center gap-2 hover:border-zinc-400 transition-colors">
                    <div className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">Mesa</div>
                    <div className="text-4xl font-black text-zinc-900 leading-none">{numero}</div>
                    <img src={qrSrc(url)} alt={`QR Mesa ${numero}`} className="w-[150px] h-[150px] rounded-xl mt-1" loading="lazy" />
                    <p className="text-[9px] text-zinc-400 text-center break-all leading-tight">{url}</p>
                    <a href={url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-blue-600 hover:underline font-semibold">Testar link →</a>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="px-8 py-4 border-t border-zinc-100 rounded-b-3xl bg-zinc-50">
          <p className="text-[11px] text-zinc-400">
            📺 <strong>Tela Cliente:</strong> {baseUrl}/display/{slug} &nbsp;·&nbsp; 📱 <strong>Mesa (ex):</strong> {baseUrl}/mesa/{slug}/1
          </p>
        </div>
      </motion.div>
    </div>
  );
}