import React, { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from 'react';
import {
  ShoppingCart, Plus, Minus, Trash2, CheckCircle2, ShoppingBag,
  X, Search, Printer, Barcode, ScanLine, ChefHat, UserPlus,
  Banknote, QrCode, CreditCard,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { Product, OrderItem, PaymentMethod } from '../types';
import { getSegCfg } from '../config/segmentos';
import type { TipoItem } from '../config/segmentos';
import { normalizeBarcode } from '../utils/barcode';
import { openPrintPreview } from '../utils/print';
import { resolveRequiresPreparation } from '../utils/preparation';
import { normalizeProductPhotoPublicUrl } from '../utils/productPhotoUrl';
import { useDebounce } from '../hooks/useDebounce';
import { BREAKPOINT_MD_PX } from '../hooks/useBreakpoint';
import { usePOSKeyboard } from '../hooks/usePOSKeyboard';
import {
  type ProductOptionsProduto,
  type ProductOptionsCartItem,
  type GrupoOpcao,
  type VariacaoVendavel,
  type Selecoes,
  type ComboGrupoUi,
} from './ProductOptionsModal';
import type { PosClienteSelecionado } from './PosClienteModal';
import POSProductOptionsDialog from './POSProductOptionsDialog';
import { FlowProductImage } from './FlowProductImage';

const MesaPickerModal = lazy(() => import('../segments/bar/MesaPickerModal'));
const PosClienteModal = lazy(() => import('./PosClienteModal'));

// ── Constantes de estilo ──────────────────────────────────────────────────────
const PAY_METHODS: PaymentMethod[] = ['Dinheiro', 'PIX', 'Débito', 'Crédito'];

// Períodos do dia usados na barra de atalho fixa do balcão (café da manhã / almoço / jantar).
// `match` identifica a categoria "prato do período" (ex: produto "JANTAR - R$12,00" na categoria "Jantar").
// `priority` lista categorias que devem subir pro topo da faixa quando esse período está ativo
// (ex: de noite, o restaurante vende mais bebida/petisco junto do jantar).
const MEAL_PERIODS: Array<{ key: string; label: string; emoji: string; startHour: number; endHour: number; match: string[]; priority: string[] }> = [
  { key: 'cafe',   label: 'Café da Manhã', emoji: '☕', startHour: 5,    endHour: 10.5, match: ['café da manhã', 'cafe da manha'], priority: [] },
  { key: 'almoco', label: 'Almoço',        emoji: '🍽️', startHour: 10.5, endHour: 16,   match: ['almoço', 'almoco'],                priority: [] },
  { key: 'jantar', label: 'Jantar',        emoji: '🌙', startHour: 17.5, endHour: 24,   match: ['jantar'],                          priority: ['cerveja', 'petisco', 'refrigerante', 'bebida', 'suco', 'drink', 'caldinho'] },
];

// Ícone + cor própria por método — ajuda a reconhecer de longe, sem precisar ler o texto.
const PAY_METHOD_STYLE: Record<PaymentMethod, { icon: any; selected: string; text: string }> = {
  'Dinheiro': { icon: Banknote,    selected: 'border-emerald-500/50 bg-emerald-50 dark:bg-emerald-500/10',  text: 'text-emerald-700 dark:text-emerald-400' },
  'PIX':      { icon: QrCode,      selected: 'border-sky-500/50 bg-sky-50 dark:bg-sky-500/10',              text: 'text-sky-700 dark:text-sky-400' },
  'Débito':   { icon: CreditCard,  selected: 'border-violet-500/50 bg-violet-50 dark:bg-violet-500/10',     text: 'text-violet-700 dark:text-violet-400' },
  'Crédito':  { icon: CreditCard,  selected: 'border-orange-500/50 bg-orange-50 dark:bg-orange-500/10',     text: 'text-orange-700 dark:text-orange-400' },
};

const PAY_ICON: Record<string, string> = {
  Dinheiro: '💵',
  PIX:      '⚡',
  Débito:   '💳',
  Crédito:  '💳',
};

function getShortcutProductScore(product: Product): number {
  return (
    ((product as any).mais_vendido ? 1000 : 0) +
    ((product as any).destaque ? 100 : 0) +
    ((product as any).recomendado ? 10 : 0)
  );
}

type POSCartSeed = {
  product_id: number;
  product_name: string;
  price_at_time: number;
  variation_id?: number | null;
  observation?: string;
  selecoes?: Selecoes;
};

function normalizeGruposPDV(raw: unknown): GrupoOpcao[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g: any) => g != null && g.ativo !== 0 && g.ativo !== false)
    .map((g: any) => ({
      id: Number(g.id),
      nome: String(g.nome || ''),
      tipo: (g.tipo === 'checkbox' || g.tipo === 'quantidade' ? g.tipo : 'radio') as GrupoOpcao['tipo'],
      min_selecoes: Number(g.min_selecoes ?? 0),
      max_selecoes: Number(g.max_selecoes ?? 0),
      obrigatorio: !!(g.obrigatorio === 1 || g.obrigatorio === true),
      modo_preco: g.modo_preco === 'final' ? 'final' as const : 'adicional' as const,
      itens: (Array.isArray(g.itens) ? g.itens : [])
        .filter((it: any) => it != null && it.ativo !== 0 && it.ativo !== false)
        .map((it: any) => ({
          id: Number(it.id),
          nome: String(it.nome || ''),
          preco_adicional: Number(it.preco_adicional ?? 0),
        })),
    }))
    .filter((g) => g.itens.length > 0);
}

function buildProdutoOptionsPayload(
  product: Product,
  grupos: GrupoOpcao[],
  variacoes: VariacaoVendavel[],
  extras?: { is_combo?: boolean; combo_grupos?: ComboGrupoUi[] }
): ProductOptionsProduto {
  const isCombo =
    extras?.is_combo === true ||
    Number((product as any).is_combo) === 1 ||
    String((product as any).is_combo) === '1';
  return {
    id: product.id,
    name: product.name,
    price: product.price,
    category: product.category,
    photo_url: normalizeProductPhotoPublicUrl(product.photo_url) ?? undefined,
    descricao: (product as any).descricao || undefined,
    em_promocao: (product as any).em_promocao,
    preco_original: (product as any).preco_original ?? null,
    grupos_opcao: grupos,
    variacoes_vendaveis: variacoes,
    is_combo: isCombo ? 1 : 0,
    combo_grupos: Array.isArray(extras?.combo_grupos) ? extras!.combo_grupos : [],
  };
}

/** Mesma normalização dos GETs `/variacoes-vendaveis` + `/opcoes` e do payload unificado `pdv-opcoes`. */
function parsePdvOpcoesApiResponse(data: {
  variacoes_vendaveis?: unknown;
  grupos_opcao?: unknown;
  combo_grupos?: unknown;
  is_combo?: unknown;
}): { grupos: GrupoOpcao[]; variacoes: VariacaoVendavel[]; combo_grupos: ComboGrupoUi[]; is_combo: boolean } {
  const vars = data?.variacoes_vendaveis;
  const ativas = Array.isArray(vars)
    ? vars.filter((v: { ativo?: number }) => Number(v?.ativo) === 1)
    : [];
  const variacoes: VariacaoVendavel[] = ativas.map((v: any) => ({
    id: Number(v.id),
    nome: String(v.nome || ''),
    preco: Number(v.preco ?? 0),
  }));
  const comboRaw = Array.isArray(data?.combo_grupos) ? data.combo_grupos : [];
  const combo_grupos: ComboGrupoUi[] = comboRaw.map((g: any) => ({
    id: Number(g.id),
    nome: String(g.nome || ''),
    ordem: Number(g.ordem ?? 0),
    obrigatorio: !!(g.obrigatorio === true || g.obrigatorio === 1),
    qtd_min: Math.max(0, Number(g.qtd_min ?? 0)),
    qtd_max: Math.max(0, Number(g.qtd_max ?? 0)),
    produtos: Array.isArray(g.produtos)
      ? g.produtos.map((p: any) => ({
          link_id: Number(p.link_id ?? p.id),
          product_id: Number(p.product_id),
          name: String(p.name || ''),
        }))
      : [],
  }));
  const is_combo = data?.is_combo === true || Number(data?.is_combo) === 1;
  return { grupos: normalizeGruposPDV(data?.grupos_opcao), variacoes, combo_grupos, is_combo };
}

type PdvOpcoesCacheEntry = {
  grupos: GrupoOpcao[];
  variacoes: VariacaoVendavel[];
  combo_grupos: ComboGrupoUi[];
  is_combo: boolean;
};

function selecoesLineKey(s: unknown): string {
  if (!s || typeof s !== 'object') return '';
  try {
    return JSON.stringify(s);
  } catch {
    return '';
  }
}

function samePOSCartLine(item: OrderItem, sel: POSCartSeed, tipo: string): boolean {
  return item.product_id === sel.product_id
    && item.type === tipo
    && Number((item as any).variation_id || 0) === Number(sel.variation_id || 0)
    && String((item as any).observation || '') === String(sel.observation || '')
    && String((item as any).product_name || '') === String(sel.product_name || '')
    && selecoesLineKey((item as any).selecoes) === selecoesLineKey(sel.selecoes);
}

// ─── ProductCard memoizado para evitar re-renders desnecessários ─────────────
const ProductCard = React.memo(function ProductCard({
  product,
  categoryEmojis,
  emojiDefault,
  onClick,
  disabled,
}: {
  product: Product;
  categoryEmojis?: Record<string, string>;
  emojiDefault?: string;
  onClick: (p: Product) => void;
  disabled: boolean;
}) {
  const isPromo = !!(product as any).em_promocao || !!(product as any).desconto;
  const isDestaque = !!(product as any).destaque || !!(product as any).mais_vendido;
  const isRecomend = !!(product as any).recomendado;
  const emoji = (categoryEmojis as any)?.[product.category] ?? emojiDefault ?? '🍽️';
  const thumbSrc = normalizeProductPhotoPublicUrl(product.photo_url);

  const handleClick = () => {
    if (!disabled) onClick(product);
  };

  return (
    <motion.button
      onClick={handleClick}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.97 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="group relative flex min-h-0 cursor-pointer flex-col overflow-hidden rounded-lg border border-fp-border bg-fp-card text-left shadow-sm shadow-zinc-950/[0.06] transition-all duration-200 ease-out hover:border-[#EA1D2C]/55 hover:shadow-md hover:shadow-[#EA1D2C]/10 dark:shadow-black/20 dark:hover:shadow-xl dark:hover:shadow-[#EA1D2C]/10 md:rounded-xl [@media(max-height:640px)]:rounded-md"
    >
      <div className="absolute inset-0 pointer-events-none rounded-lg md:rounded-xl bg-[#EA1D2C]/10 opacity-0 group-active:opacity-100 transition-opacity duration-75 z-10" aria-hidden />
      <div
        className="relative w-full overflow-hidden shrink-0 pb-[38%] min-[480px]:pb-[40%] md:pb-[42%] xl:pb-[44%] [@media(max-height:640px)]:pb-[34%]"
      >
        {thumbSrc ? (
          <FlowProductImage
            src={thumbSrc}
            alt={product.name}
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 ease-out"
          />
        ) : (
          <div className="absolute inset-0 bg-fp-secondary flex items-center justify-center">
            <span className="text-lg min-[480px]:text-xl md:text-2xl opacity-50">{emoji}</span>
          </div>
        )}
        {thumbSrc && (
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
        )}
        <div className="absolute bottom-1 left-1 md:bottom-1.5 md:left-1.5 flex flex-wrap gap-0.5 md:gap-1 max-w-[calc(100%-0.5rem)]">
          {isDestaque && (
            <span className="text-[7px] font-bold px-1 py-px rounded sm:text-[8px] sm:px-1.5 sm:py-0.5 md:text-[9px] md:rounded-md bg-[#EA1D2C] text-white tracking-wide leading-tight">
              <span className="md:hidden">TOP</span>
              <span className="hidden md:inline">MAIS VENDIDO</span>
            </span>
          )}
          {isRecomend && (
            <span className="text-[7px] font-bold px-1 py-px rounded sm:text-[8px] sm:px-1.5 sm:py-0.5 md:text-[9px] md:rounded-md bg-blue-500/95 text-white tracking-wide leading-tight">
              <span className="md:hidden">REC</span>
              <span className="hidden md:inline">RECOMENDADO</span>
            </span>
          )}
          {isPromo && (
            <span className="text-[7px] font-bold px-1 py-px rounded sm:text-[8px] sm:px-1.5 sm:py-0.5 md:text-[9px] md:rounded-md bg-red-500/95 text-white tracking-wide leading-tight">
              <span className="lg:hidden">PROMO</span>
              <span className="hidden lg:inline">PROMOÇÃO</span>
            </span>
          )}
        </div>
      </div>
      <div className="p-1.5 min-[480px]:p-2 flex-1 flex flex-col min-w-0 [@media(max-height:640px)]:p-1.5">
        <p className="text-[8px] font-bold text-fptext-muted uppercase tracking-wider mb-px min-[480px]:text-[9px] md:text-[10px] md:mb-0.5">{product.category}</p>
        <h3 className="font-bold text-fptext-primary text-[11px] leading-snug line-clamp-2 mb-0.5 min-[480px]:text-xs xl:text-[13px]">{product.name}</h3>
        {(product as any).codigo_barras && (
          <span className="text-[8px] text-fptext-muted flex items-center gap-0.5 mb-0.5 min-[480px]:text-[9px] md:text-[10px]">
            <Barcode size={8} className="shrink-0" />{(product as any).codigo_barras}
          </span>
        )}
        <p className="mt-auto text-xs font-black tabular-nums text-[#EA1D2C] min-[480px]:text-[13px] md:text-sm dark:text-[#ff7a83]">R$ {product.price.toFixed(2)}</p>
      </div>
    </motion.button>
  );
});

export default function POSScreen({
  token, products, estabelecimentoSegmento, taxasPagamento,
}: {
  token: string;
  products: Product[];
  estabelecimentoSegmento?: string;
  taxasPagamento?: { debito: number; credito: number; pix: number };
}) {
  const cfg = getSegCfg(estabelecimentoSegmento);

  const [cart, setCart] = useState<OrderItem[]>([]);
  const [observation, setObservation]                     = useState('');
  const [payments, setPayments]                           = useState<{ method: PaymentMethod; amount_paid: number }[]>([]);
  const [currentPaymentMethod, setCurrentPaymentMethod]  = useState<PaymentMethod>('Dinheiro');
  const [currentAmount, setCurrentAmount]                 = useState<number>(0);
  const [pendingProduct, setPendingProduct]               = useState<Product | null>(null);
  const [pendingSelection, setPendingSelection]           = useState<{
    product_id: number;
    product_name: string;
    price_at_time: number;
    variation_id?: number | null;
    observation?: string;
    selecoes?: Selecoes;
  } | null>(null);
  const [opcaoModalProduto, setOpcaoModalProduto]         = useState<ProductOptionsProduto | null>(null);
  const [opcaoModalBaseProduct, setOpcaoModalBaseProduct] = useState<Product | null>(null);
  const [carregandoVariacoes, setCarregandoVariacoes]     = useState(false);
  const opcaoModalLoadSeqRef                              = useRef(0);
  const pdvOpcoesCacheRef                                 = useRef<Map<number, PdvOpcoesCacheEntry>>(new Map());
  const [showSuccess, setShowSuccess]                     = useState<{ number: string; receipt: string; senha: number; tipo: string; orderId?: number } | null>(null);
  const [isFinalizing, setIsFinalizing]                   = useState(false);
  const [showTipoRetirada, setShowTipoRetirada]           = useState(false);
  const [tipoRetirada, setTipoRetirada]                   = useState<'local' | 'levar'>('local');
  const [showMesaPicker, setShowMesaPicker]               = useState(false);
  const [pendingMesaProduct, setPendingMesaProduct]       = useState<Product | null>(null);
  const [pendingMesaSeed, setPendingMesaSeed]             = useState<POSCartSeed | null>(null);
  const [mesaToast, setMesaToast]                         = useState<string | null>(null);
  const [confirmLimpar, setConfirmLimpar]                 = useState(false);
  const [mobileCartOpen, setMobileCartOpen]               = useState(false);
  const [selectedCartIndex, setSelectedCartIndex]         = useState<number | null>(null);
  const [posCliente, setPosCliente]                         = useState<PosClienteSelecionado | null>(null);
  const [showClienteModal, setShowClienteModal]           = useState(false);

  // ─── Estado de UI ─────────────────────────────────────────────────────────
  const [selectedCategory, setSelectedCategory] = useState<string>('Todas');
  const [searchTerm, setSearchTerm]             = useState('');
  const debouncedSearch                         = useDebounce(searchTerm, 250);
  const [barcodeBuffer, setBarcodeBuffer]       = useState('');
  const [barcodeToast, setBarcodeToast]         = useState<string | null>(null);
  const searchRef    = useRef<HTMLInputElement>(null);
  const barcodeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ─── Derivados ────────────────────────────────────────────────────────────
  const total     = useMemo(() => cart.reduce((a, i) => a + i.price_at_time * i.quantity, 0), [cart]);
  const totalPaid = useMemo(() => payments.reduce((a, p) => a + p.amount_paid, 0), [payments]);


  const filteredProducts = useMemo(() => {
    // Verifica disponibilidade por horário
    const agora = new Date();
    const horaAtual = agora.getHours() * 60 + agora.getMinutes(); // minutos desde meia-noite

    const active = (Array.isArray(products) ? products : []).filter(p => {
      if (!p.active) return false;
      const de  = (p as any).disponivel_de;
      const ate = (p as any).disponivel_ate;
      if (!de || !ate) return true; // sem horário definido = sempre disponível
      const [dh, dm] = de.split(':').map(Number);
      const [ah, am] = ate.split(':').map(Number);
      const inicio = dh * 60 + dm;
      const fim    = ah * 60 + am;
      // Suporte a virada de meia-noite (ex: 22:00 às 02:00)
      if (inicio <= fim) return horaAtual >= inicio && horaAtual <= fim;
      return horaAtual >= inicio || horaAtual <= fim;
    });

    if (!debouncedSearch.trim()) return active;
    const t = debouncedSearch.toLowerCase();
    return active.filter(p =>
      p.name.toLowerCase().includes(t) ||
      (p as any).marca?.toLowerCase().includes(t) ||
      (p as any).codigo_barras?.includes(t) ||
      p.category.toLowerCase().includes(t)
    );
  }, [products, debouncedSearch]);

  const categoriesRaw = useMemo(() =>
    [...new Set(filteredProducts.map(p => p.category))].sort(),
  [filteredProducts]);

  // Descobre a hora atual e qual período (café/almoço/jantar) está ativo agora.
  const activePeriod = useMemo(() => {
    const now = new Date();
    const h = now.getHours() + now.getMinutes() / 60;
    return MEAL_PERIODS.find(p => h >= p.startHour && h < p.endHour) ?? null;
  }, []);

  // Para cada período, acha a categoria real do cardápio que corresponde a ele
  // (ex: período "jantar" → categoria "Jantar" cadastrada pelo restaurante).
  const periodShortcuts = useMemo(() => {
    return MEAL_PERIODS
      .map(period => {
        const cat = categoriesRaw.find(c => period.match.some(m => c.toLowerCase().includes(m)));
        return cat ? { ...period, category: cat } : null;
      })
      .filter((p): p is (typeof MEAL_PERIODS[number] & { category: string }) => p !== null);
  }, [categoriesRaw]);

  // Reordena a faixa de categorias: se o período ativo tem categorias prioritárias
  // (ex: de noite → cerveja/petisco sobem antes do resto), elas aparecem primeiro.
  const categories = useMemo(() => {
    if (!activePeriod || activePeriod.priority.length === 0) return categoriesRaw;
    const priorityMatches = categoriesRaw.filter(c => activePeriod.priority.some(p => c.toLowerCase().includes(p)));
    const rest = categoriesRaw.filter(c => !priorityMatches.includes(c));
    return [...priorityMatches, ...rest];
  }, [categoriesRaw, activePeriod]);

  const displayProducts = useMemo(() =>
    selectedCategory === 'Todas'
      ? filteredProducts
      : filteredProducts.filter(p => p.category === selectedCategory),
  [filteredProducts, selectedCategory]);

  const topShortcutProducts = useMemo(() => (
    [...(Array.isArray(products) ? products : [])]
      .filter((product) => Boolean(product.active))
      .sort((a, b) => {
        const scoreDiff = getShortcutProductScore(b) - getShortcutProductScore(a);
        if (scoreDiff !== 0) return scoreDiff;
        const orderA = Number((a as any).ordem ?? Number.MAX_SAFE_INTEGER);
        const orderB = Number((b as any).ordem ?? Number.MAX_SAFE_INTEGER);
        if (orderA !== orderB) return orderA - orderB;
        return String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR');
      })
      .slice(0, 8)
  ), [products]);

  // ─── Taxas de pagamento (após todos os useState e useMemo simples) ──────────
  const getTaxa = (method: PaymentMethod): number => {
    if (!taxasPagamento) return 0;
    if (method === 'Débito')  return taxasPagamento.debito  || 0;
    if (method === 'Crédito') return taxasPagamento.credito || 0;
    if (method === 'PIX')     return taxasPagamento.pix     || 0;
    return 0;
  };
  const taxaAtual        = getTaxa(currentPaymentMethod);
  const taxasAcumuladas  = payments.reduce((acc, p) => {
    const perc = getTaxa(p.method as PaymentMethod);
    return acc + (perc > 0 ? p.amount_paid * perc / 100 : 0);
  }, 0);
  const taxaPreviewPOS   = taxaAtual > 0 ? (currentAmount || 0) * taxaAtual / 100 : 0;
  const totalComTaxas    = total + taxasAcumuladas + taxaPreviewPOS;
  const totalPagoComTaxas = payments.reduce((acc, p) => {
    const perc = getTaxa(p.method as PaymentMethod);
    return acc + p.amount_paid + (perc > 0 ? p.amount_paid * perc / 100 : 0);
  }, 0);
  const remaining        = Math.max(0, totalComTaxas - totalPagoComTaxas);
  const change           = Math.max(0, totalPagoComTaxas - totalComTaxas);
  // ─────────────────────────────────────────────────────────────────────────

  const addSelectionToCart = useCallback((selection: POSCartSeed, tipo: string) => {
    let nextSelectedIndex: number | null = null;
    setCart(prev => {
      const ex = prev.find(i => samePOSCartLine(i, selection, tipo));
      if (ex) {
        const existingIndex = prev.findIndex(i => samePOSCartLine(i, selection, tipo));
        nextSelectedIndex = existingIndex >= 0 ? existingIndex : prev.length - 1;
        return prev.map(i =>
          samePOSCartLine(i, selection, tipo)
            ? { ...i, quantity: i.quantity + 1 }
            : i
        );
      }
      nextSelectedIndex = prev.length;
      return [...prev, { ...selection, quantity: 1, type: tipo } as any];
    });
    setSelectedCartIndex(nextSelectedIndex);
  }, []);

  const closeOpcaoModal = useCallback(() => {
    opcaoModalLoadSeqRef.current += 1;
    setCarregandoVariacoes(false);
    setOpcaoModalProduto(null);
    setOpcaoModalBaseProduct(null);
  }, []);

  const resolveComboComponentePOS = useCallback(
    (productId: number) => {
      const base = (Array.isArray(products) ? products : []).find((p) => p.id === productId);
      if (!base) return null;
      const cached = pdvOpcoesCacheRef.current.get(productId);
      return buildProdutoOptionsPayload(
        base,
        cached?.grupos ?? [],
        cached?.variacoes ?? [],
        { is_combo: false, combo_grupos: [] }
      );
    },
    [products]
  );

  const loadComboComponenteOpcoesPOS = useCallback(
    async (productId: number) => {
      const res = await fetch(`/api/products/${productId}/pdv-opcoes`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      const p = parsePdvOpcoesApiResponse(data);
      pdvOpcoesCacheRef.current.set(productId, {
        grupos: p.grupos,
        variacoes: p.variacoes,
        combo_grupos: p.combo_grupos,
        is_combo: p.is_combo,
      });
      return { grupos_opcao: p.grupos, variacoes_vendaveis: p.variacoes };
    },
    [token]
  );

  const openProductCustomizeFlow = useCallback(async (product: Product) => {
    const seq = ++opcaoModalLoadSeqRef.current;
    setOpcaoModalBaseProduct(product);

    const cached = pdvOpcoesCacheRef.current.get(product.id);
    if (cached) {
      setOpcaoModalProduto(
        buildProdutoOptionsPayload(product, cached.grupos, cached.variacoes, {
          is_combo: cached.is_combo,
          combo_grupos: cached.combo_grupos,
        })
      );
      setCarregandoVariacoes(false);
      return;
    }

    setOpcaoModalProduto(buildProdutoOptionsPayload(product, [], [], { is_combo: false, combo_grupos: [] }));
    setCarregandoVariacoes(true);
    try {
      const res = await fetch(`/api/products/${product.id}/pdv-opcoes`, { headers: { Authorization: `Bearer ${token}` } });
      if (seq !== opcaoModalLoadSeqRef.current) return;
      let payload: PdvOpcoesCacheEntry = { grupos: [], variacoes: [], combo_grupos: [], is_combo: false };
      if (res.ok) {
        const data = await res.json();
        payload = parsePdvOpcoesApiResponse(data);
        pdvOpcoesCacheRef.current.set(product.id, payload);
      }
      setOpcaoModalProduto(
        buildProdutoOptionsPayload(product, payload.grupos, payload.variacoes, {
          is_combo: payload.is_combo,
          combo_grupos: payload.combo_grupos,
        })
      );
    } catch {
      if (seq !== opcaoModalLoadSeqRef.current) return;
      setOpcaoModalProduto(buildProdutoOptionsPayload(product, [], [], { is_combo: false, combo_grupos: [] }));
    } finally {
      if (seq === opcaoModalLoadSeqRef.current) setCarregandoVariacoes(false);
    }
  }, [token]);

  const handleProductClick = useCallback((product: Product) => {
    void openProductCustomizeFlow(product);
  }, [openProductCustomizeFlow]);

  const applyModalItemToPedido = useCallback((item: ProductOptionsCartItem) => {
    const base = opcaoModalBaseProduct;
    opcaoModalLoadSeqRef.current += 1;
    setCarregandoVariacoes(false);
    setOpcaoModalProduto(null);
    setOpcaoModalBaseProduct(null);
    if (!base) return;
    const selection: POSCartSeed = {
      product_id: item.id,
      product_name: item.name,
      price_at_time: item.preco_final,
      variation_id: item.variation_id ?? null,
      observation: item.obs_opcoes?.trim() || undefined,
      selecoes: item.selecoes,
    };
    if (cfg.usaTipoItem && cfg.tiposItem.length > 1) {
      setPendingSelection(selection);
      setPendingProduct(base);
      return;
    }
    const tipo = cfg.tiposItem[0]?.type ?? 'Venda Direta';
    const tipoCfg = cfg.tiposItem[0];
    if (tipoCfg?.usaMesas) {
      setPendingMesaSeed(selection);
      setPendingMesaProduct(base);
      setShowMesaPicker(true);
      return;
    }
    addSelectionToCart(selection, tipo);
  }, [opcaoModalBaseProduct, cfg.usaTipoItem, cfg.tiposItem, addSelectionToCart]);

  const addToCartWithType = (tipo: TipoItem) => {
    if (!pendingProduct || !pendingSelection) return;
    setPendingProduct(null);
    const selection = pendingSelection;
    setPendingSelection(null);
    if (tipo.usaMesas) {
      setPendingMesaSeed(selection);
      setPendingMesaProduct(pendingProduct);
      setShowMesaPicker(true);
      return;
    }
    addSelectionToCart(selection, tipo.type);
  };

  const updateQuantity = useCallback((index: number, delta: number) => {
    setCart(prev => {
      if (!prev[index]) return prev;
      const next = [...prev];
      next[index] = { ...next[index], quantity: Math.max(1, next[index].quantity + delta) };
      return next;
    });
    setSelectedCartIndex(index);
  }, []);
  const removeItem = useCallback((index: number) => {
    setCart(prev => prev.filter((_, i) => i !== index));
    setSelectedCartIndex((current) => {
      if (current === null) return null;
      if (current === index) return null;
      if (current > index) return current - 1;
      return current;
    });
  }, []);
  const addPayment    = () => { if (currentAmount <= 0) return; setPayments(prev => [...prev, { method: currentPaymentMethod, amount_paid: currentAmount }]); setCurrentAmount(0); };
  const removePayment = (index: number) => setPayments(prev => prev.filter((_, i) => i !== index));
  const clearCartConfirmed = useCallback(() => {
    setCart([]);
    setPayments([]);
    setObservation('');
    setCurrentAmount(0);
    setPosCliente(null);
    setSelectedCartIndex(null);
    setConfirmLimpar(false);
  }, []);

  useEffect(() => { searchRef.current?.focus(); }, []);

  useEffect(() => {
    if (cart.length === 0) {
      setSelectedCartIndex(null);
      return;
    }
    setSelectedCartIndex((current) => {
      if (current === null) return current;
      return current >= cart.length ? cart.length - 1 : current;
    });
  }, [cart.length]);

  const hasBlockingModal = Boolean(
    pendingProduct ||
    opcaoModalProduto ||
    showMesaPicker ||
    showTipoRetirada ||
    showSuccess ||
    confirmLimpar ||
    showClienteModal
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (hasBlockingModal) return;
      const el = document.activeElement as HTMLElement;
      if (el?.tagName === 'TEXTAREA') return;
      if (el?.tagName === 'INPUT' && el !== searchRef.current) return;
      if (e.key === 'Enter' && barcodeBuffer.length >= 4) {
        const code = normalizeBarcode(barcodeBuffer); setBarcodeBuffer('');
        if (barcodeTimer.current) clearTimeout(barcodeTimer.current);
        const found = code
          ? (Array.isArray(products) ? products : []).find(
              p => p.active && normalizeBarcode((p as any).codigo_barras) === code
            )
          : null;
        if (found) {
          void openProductCustomizeFlow(found);
          setBarcodeToast(`✓ ${found.name} — personalizar`);
          setSearchTerm('');
        }
        else { setBarcodeToast(`⚠ Código "${code}" não cadastrado`); }
        setTimeout(() => setBarcodeToast(null), 2500); return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        setBarcodeBuffer(prev => prev + e.key);
        if (barcodeTimer.current) clearTimeout(barcodeTimer.current);
        barcodeTimer.current = setTimeout(() => setBarcodeBuffer(''), 120);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [barcodeBuffer, products, hasBlockingModal, openProductCustomizeFlow]);

  const handleStartFinalize = useCallback(() => {
    if (cart.length === 0 || remaining > 0.01 || isFinalizing) return;
    const isRestaurante = ['Restaurante/Food', 'Bar/Pub'].includes(estabelecimentoSegmento || '');
    const cartHasFood = cart.some(item => {
      const prod = products.find(p => p.id === item.product_id);
      return prod ? resolveRequiresPreparation(prod) : false;
    });
    if (isRestaurante && cartHasFood && !cfg.usaTipoItem) {
      setShowTipoRetirada(true);
      return;
    }
    void finalizeOrder('local');
  }, [
    cart,
    remaining,
    isFinalizing,
    estabelecimentoSegmento,
    products,
    cfg.usaTipoItem,
    observation,
    totalComTaxas,
    taxasAcumuladas,
    change,
    token,
  ]);

  const handleEscape = useCallback(() => {
    if (confirmLimpar) {
      setConfirmLimpar(false);
      return;
    }
    if (showSuccess) {
      setShowSuccess(null);
      searchRef.current?.focus();
      return;
    }
    if (showClienteModal) {
      setShowClienteModal(false);
      return;
    }
    if (showTipoRetirada) {
      setShowTipoRetirada(false);
      return;
    }
    if (showMesaPicker) {
      setShowMesaPicker(false);
      setPendingMesaProduct(null);
      setPendingMesaSeed(null);
      return;
    }
    if (opcaoModalProduto) {
      closeOpcaoModal();
      return;
    }
    if (pendingProduct) {
      setPendingProduct(null);
      setPendingSelection(null);
      return;
    }
    if (mobileCartOpen) {
      setMobileCartOpen(false);
    }
  }, [confirmLimpar, showSuccess, showClienteModal, showTipoRetirada, showMesaPicker, opcaoModalProduto, pendingProduct, mobileCartOpen, closeOpcaoModal]);

  const handleQtyIncrease = useCallback(() => {
    if (selectedCartIndex === null) return;
    updateQuantity(selectedCartIndex, 1);
  }, [selectedCartIndex, updateQuantity]);

  const handleQtyDecrease = useCallback(() => {
    if (selectedCartIndex === null) return;
    updateQuantity(selectedCartIndex, -1);
  }, [selectedCartIndex, updateQuantity]);

  const handleToggleCart = useCallback(() => {
    if (window.innerWidth >= BREAKPOINT_MD_PX) return;
    setMobileCartOpen((current) => !current);
  }, []);

  const requestClearCart = useCallback(() => {
    if (cart.length === 0) return;
    setConfirmLimpar(true);
  }, [cart.length]);

  usePOSKeyboard({
    products: topShortcutProducts,
    onAddProduct: handleProductClick,
    onClearCart: requestClearCart,
    onFocusSearch: () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    },
    onEscape: handleEscape,
    onFinalize: handleStartFinalize,
    onQtyIncrease: handleQtyIncrease,
    onQtyDecrease: handleQtyDecrease,
    onToggleCart: handleToggleCart,
    hasBlockingModal,
    enabled: true,
  });

  const finalizeOrder = async (tipo: 'local' | 'levar' = 'local') => {
    if (cart.length === 0 || remaining > 0.01 || isFinalizing) return;
    setIsFinalizing(true); setShowTipoRetirada(false);
    const orderData = {
      items: cart.map((row: any) => ({
        product_id: row.product_id,
        quantity: row.quantity,
        price_at_time: row.price_at_time,
        type: row.type,
        variation_id: row.variation_id ?? null,
        observation: row.observation,
        obs_opcoes: row.observation ?? row.obs_opcoes,
        selecoes: row.selecoes,
      })),
      observation,
      // ⚠️ Envia o total COM taxas de maquininha, não o subtotal pré-taxa.
      // Garante que o registro financeiro no servidor bate com o valor realmente pago.
      total_amount: totalComTaxas,
      taxa_total: taxasAcumuladas, // auxiliar: permite o servidor separar produto de taxa
      tipo_retirada: tipo,
      payments: payments.map((p, i) => ({ ...p, change_given: i === payments.length - 1 ? change : 0 })),
      ...(posCliente ? { cliente_id: posCliente.id } : {}),
    };
    try {
      const res  = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify(orderData) });
      const data = await res.json();
      if (data.success) {
        setShowSuccess({ number: data.orderNumber, receipt: data.receipt, senha: data.senhaPedido || 0, tipo, orderId: data.orderId });
        setCart([]); setPayments([]); setObservation(''); setCurrentAmount(0); setTipoRetirada('local');
        setPosCliente(null);
        setSelectedCartIndex(null);
        setMobileCartOpen(false);
      } else { alert('Erro ao finalizar pedido: ' + (data.error || 'Erro desconhecido')); }
    } catch { alert('Erro ao finalizar pedido'); }
    finally { setIsFinalizing(false); }
  };

  const renderCartColumn = (variant: 'desktop' | 'drawer') => (
    <>
      {variant === 'desktop' && (
        <div className="flex shrink-0 items-center gap-2 border-b border-fp-border bg-white px-2.5 py-2 md:px-3 md:py-2.5 xl:px-4 xl:py-3 [@media(max-height:640px)]:py-1.5 [@media(max-height:640px)]:px-2">
          <ShoppingCart size={18} className="shrink-0 text-[#EA1D2C] dark:text-[#ff7a83] [@media(max-height:640px)]:scale-90" />
          <h2 className="text-sm font-black text-fptext-primary md:text-base truncate">Pedido Atual</h2>
          {cart.length > 0 && (
            <button
              onClick={() => setConfirmLimpar(true)}
                className="ml-auto text-[10px] font-bold text-fptext-muted hover:text-red-500 dark:hover:text-red-400 transition-colors px-2 py-1 hover:bg-red-500/10 rounded-lg min-h-[40px] min-w-[40px] lg:min-h-[36px] lg:min-w-[36px] flex items-center justify-center"
              title="Limpar carrinho"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      )}

      <div className="shrink-0 border-b border-fp-border bg-white px-2.5 pb-1.5 pt-2 md:px-3 md:pb-2 md:pt-2.5 xl:px-4 xl:pt-3 [@media(max-height:640px)]:py-1.5 [@media(max-height:640px)]:px-2">
        {!posCliente ? (
          <button
            type="button"
            onClick={() => setShowClienteModal(true)}
            className="w-full flex items-center justify-center gap-2 rounded-xl border border-dashed border-[#EA1D2C]/35 bg-[#FFF7F8] py-2.5 text-xs font-black uppercase tracking-wide text-[#9C050B] transition-colors hover:bg-[#FFF0F2]"
          >
            <UserPlus size={16} /> Adicionar cliente
          </button>
        ) : (
          <div className="flex items-start gap-2 rounded-xl bg-fp-secondary border border-fp-border px-3 py-2.5">
            <div className="flex-1 min-w-0">
              <p className="text-[9px] font-bold uppercase tracking-wider text-fptext-muted">Cliente</p>
              <p className="text-sm font-bold text-fptext-primary truncate">{posCliente.nome || 'Cliente'}</p>
              <p className="text-xs text-fptext-secondary tabular-nums">{posCliente.telefone}</p>
              {posCliente.metricas && (
                <p className="text-[10px] text-fptext-muted mt-1 leading-snug">
                  <span className="font-semibold text-fptext-secondary">{posCliente.metricas.total_pedidos}</span> pedidos
                  <span className="text-fptext-muted mx-1">·</span>
                  <span className="tabular-nums">
                    {posCliente.metricas.total_gasto.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                  </span>
                  {posCliente.fidelizacao?.label ? (
                    <>
                      <span className="text-fptext-muted mx-1">·</span>
                      <span className="font-semibold text-[#9C050B] dark:text-[#ff9aa1]">{posCliente.fidelizacao.label}</span>
                    </>
                  ) : null}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowClienteModal(true)}
              className="shrink-0 rounded-lg border border-fp-border bg-fp-hover px-2 py-1.5 text-[10px] font-black uppercase text-[#9C050B] hover:text-[#A02331] dark:text-[#ff9aa1] dark:hover:text-white"
            >
              Trocar
            </button>
          </div>
        )}
      </div>

      {/* ── Área scrollável: itens + pagamentos ─────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[#FAFAFB]">

        {/* Itens do carrinho */}
        <div className="px-2.5 py-2 md:px-3 md:py-2.5 xl:px-4 xl:py-3 [@media(max-height:640px)]:px-2 [@media(max-height:640px)]:py-1.5">
          {cart.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-8 px-4">
              <div className="w-14 h-14 rounded-2xl bg-fp-card border border-fp-border flex items-center justify-center mb-3">
                <ShoppingCart size={28} className="text-fptext-muted" />
              </div>
              <p className="font-bold text-fptext-primary text-sm">Carrinho vazio</p>
              <p className="text-xs text-fptext-muted mt-1">Toque nos produtos para adicionar ao pedido</p>
            </div>
          ) : (
            <div className="space-y-2">
              {cart.map((item, index) => (
                <motion.div key={index} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }}
                  onClick={() => setSelectedCartIndex(index)}
                  className={`flex items-center gap-2 bg-fp-card rounded-lg border p-2 transition-all cursor-pointer ${
                    selectedCartIndex === index
                      ? 'border-[#EA1D2C]/55 ring-1 ring-[#EA1D2C]/20 dark:border-[#ff7a83] dark:ring-[#EA1D2C]/20'
                      : 'border-fp-border hover:border-zinc-300 dark:hover:border-zinc-600'
                  }`}>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-fptext-primary text-xs leading-snug line-clamp-2">{item.product_name}</p>
                    {(item as any).observation ? (
                      <p className="text-[9px] text-fptext-muted line-clamp-2 mt-0.5">{(item as any).observation}</p>
                    ) : null}
                    {selectedCartIndex === index && (
                      <p className="mt-0.5 text-[9px] font-bold uppercase tracking-wider text-[#EA1D2C] dark:text-[#ff7a83]">Selecionado</p>
                    )}
                    <p className="mt-0.5 text-xs font-black text-[#EA1D2C] dark:text-[#ff7a83]">R$ {(item.price_at_time * item.quantity).toFixed(2)}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button type="button" onClick={(e) => { e.stopPropagation(); updateQuantity(index, -1); }} className="w-10 h-10 lg:w-6 lg:h-6 flex items-center justify-center bg-fp-hover hover:bg-fp-active border border-fp-border rounded-lg transition-all text-fptext-primary"><Minus size={11} /></button>
                    <span className="w-8 lg:w-6 text-center font-black text-xs text-fptext-primary">{item.quantity}</span>
                    <button type="button" onClick={(e) => { e.stopPropagation(); updateQuantity(index, 1); }} className="w-10 h-10 lg:w-6 lg:h-6 flex items-center justify-center bg-fp-hover hover:bg-fp-active border border-fp-border rounded-lg transition-all text-fptext-primary"><Plus size={11} /></button>
                    <button type="button" onClick={(e) => { e.stopPropagation(); removeItem(index); }} className="w-10 h-10 lg:w-6 lg:h-6 flex items-center justify-center text-fptext-muted hover:text-red-500 dark:hover:text-red-400 transition-colors ml-0.5"><Trash2 size={12} /></button>
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </div>

        {/* Pagamentos */}
        <div className="border-t border-fp-border bg-white px-2.5 py-2.5 space-y-2.5 md:px-3 md:py-3 md:space-y-3 xl:px-4 xl:py-3 [@media(max-height:700px)]:px-2 [@media(max-height:700px)]:py-2 [@media(max-height:700px)]:space-y-2">
          <p className="text-xs font-bold text-fptext-muted uppercase tracking-wider">Pagamentos Adicionados</p>
          {payments.length > 0 && (
            <div className="space-y-1.5">
              {payments.map((p, i) => (
                <div key={i} className="flex justify-between items-center bg-fp-secondary px-2.5 py-2 rounded-lg border border-fp-border text-xs">
                  <span className="font-bold text-fptext-secondary">{p.method}</span>
                  <div className="flex items-center gap-2">
                    <span className="font-black text-fptext-primary">R$ {p.amount_paid.toFixed(2)}</span>
                    <button type="button" onClick={() => removePayment(i)} className="text-fptext-muted hover:text-red-500 dark:hover:text-red-400 transition-colors p-1 min-w-[40px] min-h-[40px] lg:min-w-[32px] lg:min-h-[32px] flex items-center justify-center"><Trash2 size={11} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="grid grid-cols-4 gap-1.5 lg:gap-2">
            {PAY_METHODS.map(m => {
              const style = PAY_METHOD_STYLE[m];
              const Icon = style.icon;
              const isSelected = currentPaymentMethod === m;
              return (
                <button key={m} type="button" onClick={() => {
                    setCurrentPaymentMethod(m);
                    // PIX/Débito/Crédito quase sempre fecham o valor exato restante — evita
                    // ter que digitar o valor de novo no balcão. Dinheiro fica de fora porque
                    // o caixa costuma receber uma nota arredondada e calcular troco.
                    if (m !== 'Dinheiro' && remaining > 0) setCurrentAmount(remaining);
                  }}
                  className={`flex flex-col items-center gap-0.5 py-2.5 lg:py-2 rounded-lg text-[11px] font-bold border-2 transition-all min-h-[52px] lg:min-h-[48px] ${
                    isSelected
                      ? `${style.selected} ${style.text}`
                      : 'bg-fp-secondary border-fp-border text-fptext-muted hover:border-zinc-400 hover:text-fptext-primary dark:hover:border-zinc-600 dark:hover:text-zinc-300'
                  }`}>
                  <Icon size={16} strokeWidth={2.25} />
                  <span>{m}</span>
                  {getTaxa(m) > 0 && (
                    <span className={`block text-[9px] font-bold ${isSelected ? style.text : 'text-fptext-muted'}`}>
                      +{getTaxa(m)}%
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div>
            <p className="text-xs font-bold text-fptext-secondary uppercase tracking-wider mb-1 truncate">
              Valor a receber {currentPaymentMethod !== 'Dinheiro' ? `(${currentPaymentMethod})` : ''}
            </p>
            <div className="flex gap-2">
              <input
                type="number" placeholder="0,00"
                value={currentAmount || ''}
                onChange={e => setCurrentAmount(parseFloat(e.target.value) || 0)}
                className="min-w-0 flex-1 min-h-[48px] rounded-lg border-2 border-fp-border bg-fp-input px-3 py-2 text-lg font-bold text-fptext-primary placeholder:text-fptext-muted placeholder:font-normal transition-all focus:border-[#EA1D2C]/60 focus:outline-none"
              />
              <button type="button" onClick={addPayment} disabled={currentAmount <= 0}
                className="shrink-0 min-h-[48px] rounded-lg bg-[#EA1D2C] px-3 md:px-4 py-2 text-sm font-bold text-white shadow-md shadow-[#EA1D2C]/20 transition-all hover:bg-[#9C050B] disabled:opacity-30 disabled:shadow-none">
                Adicionar
              </button>
            </div>
          </div>
          {remaining > 0 && (
            <button type="button" onClick={() => setCurrentAmount(remaining)}
              className="w-full py-2.5 md:py-2 text-xs font-bold text-[#9C050B] bg-[#FFF1F2] hover:bg-[#FFE5E8] border-2 border-[#EA1D2C]/40 rounded-lg transition-all dark:text-[#ff9aa1]">
              Preencher valor exato — R$ {remaining.toFixed(2)}
            </button>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <p className="text-[11px] font-bold text-fptext-muted uppercase tracking-wider mb-0.5">Restante</p>
              <div className={`min-h-9 flex items-center justify-center font-bold text-sm rounded-lg border ${remaining > 0 ? 'bg-red-500/10 text-red-600 border-red-500/30 dark:text-red-400' : 'bg-fp-secondary text-fptext-muted border-fp-border'}`}>
                R$ {Math.max(0, remaining).toFixed(2)}
              </div>
            </div>
            <div>
              <p className="text-[11px] font-bold text-fptext-muted uppercase tracking-wider mb-0.5">Troco</p>
              <div className={`min-h-9 flex items-center justify-center font-bold text-sm rounded-lg border ${change > 0 ? 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-400' : 'bg-fp-secondary text-fptext-muted border-fp-border'}`}>
                R$ {change.toFixed(2)}
              </div>
            </div>
          </div>
          <div>
            <p className="text-[11px] font-bold text-fptext-muted uppercase tracking-wider mb-0.5">Observações</p>
            <input
              placeholder="Ex: Sem feijão, mais carne..."
              value={observation}
              onChange={(e: any) => setObservation(e.target.value)}
              className="w-full min-h-[44px] rounded-lg border border-fp-border bg-fp-input px-3 py-2 text-base text-fptext-primary placeholder:text-fptext-muted transition-all focus:border-[#EA1D2C]/45 focus:outline-none md:text-sm"
            />
          </div>

          {/* Resumo de taxas */}
          <div className="rounded-lg border border-[#EA1D2C]/12 bg-[#FFF7F8] p-3 space-y-1.5 ring-1 ring-[#EA1D2C]/8 md:rounded-xl md:p-4 md:space-y-2 [@media(max-height:700px)]:p-2.5">
            <div className="flex justify-between items-center gap-2 min-w-0">
              <span className="text-fptext-muted font-medium text-[10px] md:text-xs truncate">Subtotal</span>
              <span className="text-xs font-black text-fptext-primary tabular-nums shrink-0 md:text-sm">R$ {total.toFixed(2)}</span>
            </div>
            {payments.map((p, i) => {
              const perc = getTaxa(p.method as PaymentMethod);
              const taxa = perc > 0 ? p.amount_paid * perc / 100 : 0;
              return taxa > 0 ? (
                <div key={i} className="flex justify-between items-center">
                  <span className="text-[10px] font-medium text-[#A02331]">Taxa {p.method} ({perc}%) s/ R$ {p.amount_paid.toFixed(2)}</span>
                  <span className="text-[10px] font-bold text-[#EA1D2C]">+ R$ {taxa.toFixed(2)}</span>
                </div>
              ) : null;
            })}
            {taxaPreviewPOS > 0 && (
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-medium text-[#A02331]">Taxa {currentPaymentMethod} ({taxaAtual}%) s/ R$ {(currentAmount||0).toFixed(2)}</span>
                <span className="text-[10px] font-bold text-[#EA1D2C]">+ R$ {taxaPreviewPOS.toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between items-center pt-2 mt-1.5 border-t-2 border-fp-border dark:border-zinc-600 gap-2 min-w-0 md:pt-3 md:mt-2">
              <span className="text-fptext-primary font-bold text-xs md:text-sm truncate">Total do Pedido</span>
              <span className="shrink-0 text-lg font-black tabular-nums text-[#EA1D2C] min-[340px]:text-xl xl:text-2xl dark:text-[#ff7a83]">
                R$ {totalComTaxas.toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Botão Finalizar — sempre fixo no bottom ──────────────────── */}
      <div className="shrink-0 border-t border-fp-border bg-white px-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] pt-2.5 md:px-3 md:pb-3 md:pt-3 xl:px-4 xl:pb-4 xl:pt-3 [@media(max-height:700px)]:px-2 [@media(max-height:700px)]:py-2">
        <button
          type="button"
          onClick={handleStartFinalize}
          disabled={cart.length === 0 || remaining > 0.01 || isFinalizing}
          className="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl bg-[#EA1D2C] py-2.5 text-xs font-black text-white shadow-xl shadow-[#EA1D2C]/20 ring-2 ring-[#EA1D2C]/18 transition-all duration-200 hover:bg-[#9C050B] hover:ring-[#EA1D2C]/26 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 md:min-h-[46px] md:gap-2 md:py-2.5 md:text-sm xl:min-h-[50px] xl:text-base xl:py-3 [@media(max-height:700px)]:min-h-[40px] [@media(max-height:700px)]:py-2 [@media(max-height:700px)]:text-xs"
        >
          {isFinalizing ? (
            <><span className="animate-pulse">⏳</span> Processando...</>
          ) : cart.length === 0 ? (
            'Adicione itens ao pedido'
          ) : remaining > 0.01 ? (
            `Faltam R$ ${remaining.toFixed(2)}`
          ) : (
            <><CheckCircle2 size={22} strokeWidth={2.5} /> Finalizar Venda</>
          )}
        </button>
      </div>
    </>
  );

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex h-full min-h-0 flex-col overflow-hidden bg-fp-app pb-[env(safe-area-inset-bottom)] md:flex-row md:pb-0">

      {/* ═══════════════════════════════════════════════════════════════
          PAINEL ESQUERDO — Catálogo
      ═══════════════════════════════════════════════════════════════ */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">

        {/* Busca */}
        <div className="shrink-0 px-2.5 pb-1.5 pt-2 md:px-3 md:pb-2 md:pt-3 [@media(max-height:640px)]:px-2 [@media(max-height:640px)]:pb-1 [@media(max-height:640px)]:pt-1.5">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fptext-muted pointer-events-none md:left-4 size-[14px] md:size-[15px]" />
            <input
              ref={searchRef} type="text" value={searchTerm}
              onChange={e => { setSearchTerm(e.target.value); setSelectedCategory('Todas'); }}
              placeholder="Buscar por nome, marca... ou bipe o código"
              className="w-full min-h-[44px] rounded-lg border border-fp-border bg-fp-input py-2.5 pl-10 pr-9 text-sm text-fptext-primary placeholder:text-fptext-muted transition-all focus:border-[#EA1D2C] focus:outline-none focus:ring-2 focus:ring-[#EA1D2C]/12 md:min-h-[42px] md:rounded-xl md:py-2.5 md:pl-11 md:pr-10 md:text-sm max-md:text-base [@media(max-height:640px)]:min-h-[40px] [@media(max-height:640px)]:py-2 [@media(max-height:640px)]:text-sm"
            />
            {searchTerm && (
              <button onClick={() => { setSearchTerm(''); searchRef.current?.focus(); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-fptext-muted hover:text-fptext-primary md:right-4">
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {topShortcutProducts.length > 0 && (
          <div className="hidden md:block px-2.5 pb-1.5 shrink-0 md:px-3 md:pb-2 [@media(max-height:640px)]:pb-1">
            <div className="rounded-lg md:rounded-xl border border-fp-border bg-fp-card px-2.5 py-1.5 md:px-3 md:py-2 [@media(max-height:640px)]:py-1.5">
              <div className="flex items-center justify-between gap-2 min-w-0">
                <p className="text-[9px] font-bold text-fptext-muted uppercase tracking-wider md:text-[10px] shrink-0">Atalhos</p>
                <p className="text-[9px] text-fptext-muted truncate min-w-0 md:text-[10px]">Ctrl+F • Ctrl+Enter</p>
              </div>
              <p className="mt-1 text-[9px] text-fptext-muted [@media(max-height:640px)]:hidden md:text-[10px]">Alt+↑/↓ item • Ctrl+Backspace limpa</p>
              <div className="mt-1.5 flex flex-wrap gap-1 md:mt-2 md:gap-1.5 [@media(max-height:640px)]:mt-1">
                {topShortcutProducts.map((product, index) => (
                  <span
                    key={product.id}
                    className="max-w-[140px] min-[1100px]:max-w-[180px] truncate rounded-md border border-fp-border bg-fp-secondary px-1.5 py-0.5 text-[9px] font-medium text-fptext-secondary md:px-2 md:py-1 md:text-[10px]"
                    title={product.name}
                  >
                    F{index + 1} {product.name}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Barra fixa de período (café da manhã / almoço / jantar) — só aparece se o cardápio tiver essas categorias */}
        {periodShortcuts.length > 0 && (
          <div className="px-2.5 pb-1.5 shrink-0 md:px-3 md:pb-2 [@media(max-height:640px)]:px-2 [@media(max-height:640px)]:pb-1">
            <div className="flex gap-1.5 md:gap-2">
              {periodShortcuts.map(period => {
                const isNow = activePeriod?.key === period.key;
                const isSelected = selectedCategory === period.category;
                return (
                  <button
                    key={period.key}
                    type="button"
                    onClick={() => { setSelectedCategory(period.category); setSearchTerm(''); }}
                    className={`flex-1 flex items-center justify-center gap-1.5 min-h-[44px] rounded-lg border-2 text-xs md:text-sm font-black transition-all ${
                      isSelected
                        ? 'border-[#EA1D2C] bg-[#EA1D2C] text-white shadow-md shadow-[#EA1D2C]/20'
                        : isNow
                          ? 'border-[#EA1D2C]/50 bg-[#FFF1F2] text-[#9C050B] dark:text-[#ff9aa1] animate-pulse'
                          : 'border-fp-border bg-fp-secondary text-fptext-muted hover:border-zinc-400 hover:text-fptext-primary'
                    }`}
                    title={isNow ? `${period.label} — período atual` : period.label}
                  >
                    <span>{period.emoji}</span>
                    <span>{period.label}</span>
                    {isNow && !isSelected && <span className="w-1.5 h-1.5 rounded-full bg-[#EA1D2C]" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Abas de categoria */}
        <div className="px-2.5 pb-1.5 shrink-0 md:px-3 md:pb-2 [@media(max-height:640px)]:px-2 [@media(max-height:640px)]:pb-1">
          <div className="flex gap-1.5 overflow-x-auto pb-0.5 md:gap-2 md:pb-1" style={{ scrollbarWidth: 'none' }}>
            {['Todas', ...categories].map(cat => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-3 py-2 min-h-[40px] text-xs rounded-md border transition-all duration-200 shrink-0 max-md:min-h-[44px] max-md:px-4 max-md:py-2.5 max-md:text-sm max-md:rounded-lg md:min-h-0 md:px-3 md:py-1.5 md:text-sm md:rounded-lg flex items-center font-bold whitespace-nowrap [@media(max-height:640px)]:min-h-0 [@media(max-height:640px)]:px-2.5 [@media(max-height:640px)]:py-1 [@media(max-height:640px)]:text-xs ${
                  selectedCategory === cat
                    ? 'border-[#EA1D2C] bg-[#EA1D2C] text-white shadow-md shadow-[#EA1D2C]/18 ring-2 ring-[#EA1D2C]/14'
                    : 'bg-fp-secondary/90 border-fp-border text-fptext-muted hover:border-zinc-400 hover:text-fptext-primary hover:bg-fp-hover dark:border-zinc-600 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200 dark:hover:bg-zinc-800'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Grade de Produtos */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-[calc(6rem+env(safe-area-inset-bottom))] md:px-3 md:pb-3 [@media(max-height:640px)]:px-2 [@media(max-height:640px)]:pb-2">
          {displayProducts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 px-4 text-center text-fptext-muted md:py-12 [@media(max-height:640px)]:py-6" role="status">
              <ScanLine size={36} className="mb-3 opacity-40" aria-hidden />
              <p className="text-base font-semibold text-fptext-primary">Nenhum produto encontrado</p>
              {searchTerm && <p className="text-sm mt-1.5 text-fptext-muted">Termo: {searchTerm}</p>}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-1.5 min-[480px]:gap-2 md:grid-cols-3 md:gap-2 min-[960px]:grid-cols-4 min-[960px]:gap-2.5 xl:grid-cols-5 xl:gap-3 min-[1440px]:grid-cols-6 min-[1800px]:grid-cols-7 min-[2400px]:grid-cols-8">
              {displayProducts.map(product => (
                <ProductCard
                  key={product.id}
                  product={product}
                  categoryEmojis={cfg.categoryEmojis}
                  emojiDefault={cfg.emojiDefault}
                  onClick={handleProductClick}
                  disabled={carregandoVariacoes}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════
          TOASTS
      ═══════════════════════════════════════════════════════════════ */}
      <AnimatePresence>
        {barcodeToast && (
          <motion.div initial={{ y: 50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 50, opacity: 0 }}
            className="fixed left-1/2 z-[200] -translate-x-1/2 rounded-2xl bg-zinc-900 px-6 py-3 text-sm font-semibold whitespace-nowrap text-white shadow-2xl max-md:bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] md:bottom-8">
            {barcodeToast}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ═══════════════════════════════════════════════════════════════
          PAINEL DIREITO — Pedido + Pagamento (tablet/desktop)
      ═══════════════════════════════════════════════════════════════ */}
      <div className="hidden h-full min-h-0 w-full shrink-0 overflow-hidden border-l border-fp-border bg-white shadow-sm shadow-zinc-950/[0.06] print:shadow-none [print-color-adjust:exact] [-webkit-print-color-adjust:exact] dark:shadow-[0_0_40px_rgba(0,0,0,0.45)] md:flex md:w-[min(300px,32vw)] md:flex-col md:min-w-[280px] lg:w-[min(320px,27vw)] xl:w-[min(340px,24vw)] 2xl:w-[min(376px,18vw)] min-[2200px]:w-[min(420px,15vw)]">
        {renderCartColumn('desktop')}
      </div>

      {/* Mobile: CTA fixo + sheet do pedido (max-md) */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-fp-border bg-white/95 backdrop-blur-sm pb-[max(0.35rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={() => setMobileCartOpen(true)}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 min-h-[56px] text-left active:bg-fp-hover"
        >
          <div className="flex items-center gap-2 min-w-0">
            <ShoppingCart size={20} className="shrink-0 text-[#EA1D2C] dark:text-[#ff7a83]" />
            <div className="min-w-0">
              <p className="text-[10px] font-bold text-fptext-muted uppercase tracking-wider">Pedido atual</p>
              <p className="text-sm font-black text-fptext-primary truncate">{cart.length === 0 ? 'Vazio' : `${cart.length} item(ns)`}</p>
            </div>
          </div>
          <div className="text-right shrink-0">
            <p className="text-[10px] text-fptext-muted">Total</p>
            <p className="text-lg font-black tabular-nums text-[#EA1D2C] dark:text-[#ff7a83]">R$ {totalComTaxas.toFixed(2)}</p>
          </div>
          <span className="shrink-0 text-xs font-black text-[#EA1D2C]">Abrir →</span>
        </button>
      </div>

      {mobileCartOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex flex-col justify-end">
          <button
            type="button"
            aria-label="Fechar"
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileCartOpen(false)}
          />
          <div className="relative mx-0 flex h-[min(92dvh,100%)] max-h-[min(92dvh,100%)] flex-col overflow-hidden rounded-t-2xl border border-b-0 border-fp-border bg-fp-card shadow-2xl">
            <div className="flex items-center justify-between px-3 py-3 border-b border-fp-border shrink-0">
              <button
                type="button"
                onClick={() => setMobileCartOpen(false)}
                className="p-2 rounded-xl text-fptext-secondary min-h-[44px] min-w-[44px] flex items-center justify-center active:bg-fp-hover"
                aria-label="Fechar pedido"
              >
                <X size={22} />
              </button>
              <h2 className="text-base font-black text-fptext-primary">Pedido e pagamento</h2>
              {cart.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setConfirmLimpar(true)}
                  className="text-[10px] font-bold text-fptext-muted hover:text-red-500 dark:hover:text-red-400 px-2 py-2 min-h-[44px] min-w-[44px] flex items-center justify-center"
                  title="Limpar carrinho"
                >
                  <Trash2 size={16} />
                </button>
              ) : (
                <span className="w-11" />
              )}
            </div>
            <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
              {renderCartColumn('drawer')}
            </div>
          </div>
        </div>
      )}

      <AnimatePresence>
        {pendingProduct && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm p-0 sm:items-center sm:p-6">
            <motion.div initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.85, opacity: 0 }} transition={{ duration: 0.15 }}
              className="my-auto flex max-h-[min(92dvh,100svh)] w-full max-w-sm min-h-0 flex-col overflow-y-auto overscroll-contain rounded-t-3xl border border-fp-border bg-fp-card p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-3xl sm:p-8 sm:pb-[max(1.5rem,env(safe-area-inset-bottom))]">
              <div className="text-center mb-6">
                {normalizeProductPhotoPublicUrl(pendingProduct.photo_url) && (
                  <div className="w-full h-40 rounded-2xl overflow-hidden mb-4">
                    <FlowProductImage
                      src={normalizeProductPhotoPublicUrl(pendingProduct.photo_url)!}
                      alt={pendingProduct.name}
                      className="w-full h-full object-cover"
                    />
                  </div>
                )}
                <p className="text-[10px] font-bold text-fptext-muted uppercase tracking-widest mb-1">{pendingProduct.category}</p>
                <h3 className="text-2xl font-black text-fptext-primary">{pendingSelection?.product_name || pendingProduct.name}</h3>
                <p className="mt-1 text-xl font-black text-[#EA1D2C]">R$ {Number(pendingSelection?.price_at_time ?? pendingProduct.price).toFixed(2)}</p>
              </div>
              <p className="text-center text-sm text-fptext-muted mb-6 font-medium">Como será este item?</p>
              <div className={`grid gap-4 ${cfg.tiposItem.length === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                {cfg.tiposItem.map(tipo => {
                  const paleta: Record<string, string> = { blue:'bg-[#FFF7F8] hover:bg-[#FFF0F2] border-[#F3C6CB] hover:border-[#EA1D2C] text-[#9C050B]', amber:'bg-[#FFF7F8] hover:bg-[#FFF0F2] border-[#F3C6CB] hover:border-[#EA1D2C] text-[#9C050B]', green:'bg-green-50 hover:bg-green-100 border-green-200 hover:border-green-400 text-green-700', purple:'bg-purple-50 hover:bg-purple-100 border-purple-200 hover:border-purple-400 text-purple-700' };
                  return (
                    <button key={tipo.type} onClick={() => addToCartWithType(tipo)} className={`flex flex-col items-center gap-3 p-5 border-2 rounded-2xl transition-all active:scale-95 ${paleta[tipo.cor] || paleta.blue}`}>
                      <span className="text-4xl">{tipo.emoji}</span>
                      <span className="font-black text-sm uppercase tracking-wider">{tipo.label}</span>
                    </button>
                  );
                })}
              </div>
              <button onClick={() => { setPendingProduct(null); setPendingSelection(null); }} className="w-full mt-4 py-2 text-fptext-muted hover:text-fptext-primary text-sm font-medium transition-colors">Cancelar</button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {opcaoModalProduto && (
        <POSProductOptionsDialog
          produto={opcaoModalProduto}
          carregandoOpcoes={carregandoVariacoes}
          onClose={closeOpcaoModal}
          onAdicionar={applyModalItemToPedido}
          resolveComboComponente={resolveComboComponentePOS}
          loadComboComponenteOpcoes={loadComboComponenteOpcoesPOS}
        />
      )}

      {showMesaPicker && pendingMesaProduct && (
        <Suspense fallback={null}>
          <MesaPickerModal
            product={pendingMesaProduct}
            lineSeed={pendingMesaSeed ?? undefined}
            token={token}
            onClose={() => {
            setShowMesaPicker(false);
            setPendingMesaProduct(null);
            setPendingMesaSeed(null);
          }}
            onSuccess={n => {
            setShowMesaPicker(false);
            setPendingMesaProduct(null);
            setPendingMesaSeed(null);
            setMesaToast(`✓ Adicionado à Mesa ${n}`);
            setTimeout(() => setMesaToast(null), 2500);
          }}
            />
        </Suspense>
      )}
      <AnimatePresence>
        {mesaToast && (          <motion.div initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }}
            className="fixed left-1/2 z-[200] -translate-x-1/2 rounded-2xl bg-zinc-900 px-6 py-3 text-sm font-bold text-white shadow-2xl max-md:bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] md:bottom-8">
            {mesaToast}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showTipoRetirada && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm p-0 sm:items-center sm:p-6">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              className="max-h-[min(92dvh,100%)] w-full max-w-sm overflow-y-auto rounded-t-3xl border border-fp-border bg-fp-card p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-center text-fptext-primary shadow-2xl sm:rounded-3xl sm:p-8">
              <div className="text-4xl mb-3">🍽️</div>
              <h3 className="text-xl font-black mb-1">Como vai consumir?</h3>
              <p className="mb-6 text-sm text-fptext-muted">Escolha para gerar a comanda correta</p>
              <div className="grid grid-cols-2 gap-3">
                <button type="button" onClick={() => finalizeOrder('local')} className="flex flex-col items-center gap-2 rounded-2xl bg-zinc-900 p-5 text-fp-card transition-all hover:scale-105 active:scale-95">
                  <span className="text-3xl">🪑</span><span className="font-black text-sm">Consumir aqui</span><span className="text-[10px] opacity-80">Pedido vai para a mesa</span>
                </button>
                <button type="button" onClick={() => finalizeOrder('levar')} className="flex flex-col items-center gap-2 rounded-2xl border-2 border-fp-border bg-fp-secondary p-5 text-fptext-primary transition-all hover:scale-105 active:scale-95">
                  <span className="text-3xl">🛍️</span><span className="font-black text-sm">Para levar</span><span className="text-[10px] text-fptext-muted">Retirada no balcão</span>
                </button>
              </div>
              <button type="button" onClick={() => setShowTipoRetirada(false)} className="mt-4 text-xs font-medium text-fptext-muted">Cancelar</button>
            </motion.div>
          </div>
        )}

        {showSuccess && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm p-0 sm:items-center sm:p-4">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              className="max-h-[min(92dvh,100%)] w-full max-w-xs overflow-y-auto rounded-t-2xl border border-fp-border bg-fp-card p-6 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-center shadow-2xl sm:rounded-2xl">

              {/* Ícone + título */}
              <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                <CheckCircle2 size={28} />
              </div>
              <h3 className="text-lg font-black text-fptext-primary">Venda Finalizada!</h3>
              <p className="text-xs text-fptext-muted mt-0.5">#{showSuccess.number}</p>

              {/* Senha */}
              {showSuccess.senha > 0 && (
                <div className="mt-3 mx-auto inline-flex flex-col items-center gap-0.5 px-5 py-2.5 rounded-xl bg-fp-secondary border border-fp-border dark:bg-zinc-900 dark:border-transparent">
                  <span className="text-[9px] font-bold uppercase tracking-widest text-fptext-muted">
                    {showSuccess.tipo === 'levar' ? '🛍️ Para Levar' : '🪑 Local'} — Senha
                  </span>
                  <span className="text-4xl font-black tabular-nums text-fptext-primary leading-none dark:text-white">
                    {String(showSuccess.senha).padStart(2, '0')}
                  </span>
                </div>
              )}

              {/* Botões de impressão */}
              <div className="flex flex-col gap-2 mt-4">
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      try {
                        const r = await fetch(`/api/print/cupom-html/${showSuccess.orderId}`, { headers: { Authorization: `Bearer ${token}` } });
                        const html = await r.text();
                        openPrintPreview(html);
                      } catch {
                        openPrintPreview(showSuccess.receipt);
                      }
                    }}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-bold bg-zinc-100 text-zinc-800 hover:bg-zinc-200 transition-colors"
                  >
                    <Printer size={14} /> Cupom
                  </button>
                  <button
                    onClick={async () => {
                      try {
                        const r = await fetch(`/api/print/comanda-html/${showSuccess.orderId}`, { headers: { Authorization: `Bearer ${token}` } });
                        const html = await r.text();
                        if (html.trim().toLowerCase().includes('nenhum item de preparo')) {
                          alert('Nenhum item de preparo neste pedido.');
                          return;
                        }
                        openPrintPreview(html);
                      } catch {
                        alert('Erro ao gerar comanda de produção.');
                      }
                    }}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-[#F3C6CB] bg-[#FFF7F8] py-2.5 text-sm font-bold text-[#9C050B] transition-colors hover:bg-[#FFF0F2]"
                    type="button"
                  >
                    <ChefHat size={14} /> Produção
                  </button>
                </div>
                <button
                  onClick={async () => {
                    try {
                      const r = await fetch(`/api/print/recibo/${showSuccess.orderId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
                      const d = await r.json();
                      if (!d.success) alert('Impressora: ' + (d.message || 'Erro'));
                    } catch { alert('Erro ao enviar para impressora.'); }
                  }}
                  className="w-full flex items-center justify-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm font-bold text-emerald-800 transition-colors dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-200"
                  title="Impressora térmica (cupom)"
                  type="button"
                >
                  <Printer size={14} /> Térmica (cupom)
                </button>
              </div>

              {/* Novo pedido */}
              <button
                onClick={() => setShowSuccess(null)}
                className="w-full mt-2 py-2.5 rounded-xl font-black text-sm bg-zinc-900 text-white hover:bg-zinc-700 transition-colors"
              >
                Novo Pedido →
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Modal confirmação limpar carrinho ────────────────────────── */}
      <AnimatePresence>
        {confirmLimpar && (
          <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 backdrop-blur-sm p-0 sm:items-center sm:p-6">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="max-h-[min(88dvh,100%)] w-full max-w-xs overflow-y-auto rounded-t-2xl border border-fp-border bg-fp-card p-6 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-center shadow-2xl sm:rounded-2xl"
            >
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-red-100 dark:bg-red-500/20">
                <Trash2 size={22} className="text-red-600 dark:text-red-300" />
              </div>
              <h3 className="mb-1 text-base font-black text-fptext-primary">Limpar carrinho?</h3>
              <p className="text-xs text-fptext-muted mb-5">
                {cart.length} item{cart.length !== 1 ? 's' : ''} será{cart.length !== 1 ? 'ão' : ''} removido{cart.length !== 1 ? 's' : ''}.
                Esta ação não pode ser desfeita.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmLimpar(false)}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold bg-zinc-100 hover:bg-zinc-200 text-zinc-700 transition-all"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => {
                    clearCartConfirmed();
                  }}
                  className="flex-1 py-2.5 rounded-xl text-sm font-black bg-red-600 hover:bg-red-700 text-white transition-all"
                >
                  Limpar tudo
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {showClienteModal && (
        <Suspense fallback={null}>
          <PosClienteModal
            open={showClienteModal}
            token={token}
            clienteAtual={posCliente}
            onClose={() => setShowClienteModal(false)}
            onSelect={(c) => setPosCliente(c)}
          />
        </Suspense>
      )}
    </motion.div>
  );
}