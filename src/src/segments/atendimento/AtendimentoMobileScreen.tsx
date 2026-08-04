import React from 'react';
import {
  Minus,
  Plus,
  Search,
  Trash2,
  Phone,
  MapPin,
  ShoppingBag,
  CreditCard,
  ClipboardCheck,
  Check,
  ChevronLeft,
  ChevronRight,
  Printer,
  RotateCcw,
  Pencil,
  Banknote,
  QrCode,
  Home,
} from 'lucide-react';
import { formatDeliveryAddressLine } from '../../utils/deliveryAddressFormat';
import { fetchPrintableHtml, openPrintPreview } from '../../utils/print';
import { normalizeProductPhotoPublicUrl } from '../../utils/productPhotoUrl';
import { FlowProductImage } from '../../shared/FlowProductImage';

type PrefillCliente = { id: number; nome: string; telefone: string };
type PrefillEndereco = {
  id: number;
  label: string;
  logradouro: string;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  referencia: string | null;
  principal?: number | null;
};

type ProductHit = {
  id: number;
  name: string;
  price: number;
  category: string;
  photo_url?: string | null;
  is_combo?: number | null;
};

type CartItem = {
  product_id: number;
  name: string;
  unit_price_hint: number;
  quantity: number;
  observation: string;
  photo_url?: string | null;
};

type AtendimentoMobilePrefsV1 = {
  v: 1;
  ts: number;
  tipoRetirada: 'delivery' | 'retirada';
  pagamentoTipo: 'dinheiro' | 'pix' | 'cartao';
  taxaEntrega: number;
};

const ATENDIMENTO_MOBILE_PREFS_KEY = 'flowpdv:atendimentoMobile:prefs:v1';
const ATENDIMENTO_MOBILE_PREFS_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 dias

function onlyDigits(v: string) {
  return String(v || '').replace(/\D/g, '');
}

/**
 * Números copiados do WhatsApp às vezes vêm com o DDI (+55) e às vezes não.
 * Aqui só limpamos o DDI para exibição (evita o atendente ver "+5582..." na
 * tela); a checagem "com/sem o 9 do celular" fica a cargo do backend, que já
 * tenta várias variações ao buscar o cadastro — então mesmo que o número
 * cole sem o 9, a busca ainda funciona.
 */
function stripBrDdiForDisplay(raw: string) {
  const digits = onlyDigits(raw);
  if (digits.length >= 12 && digits.startsWith('55')) {
    const semDdi = digits.slice(2);
    if (semDdi.length === 10 || semDdi.length === 11) return semDdi;
  }
  return digits;
}

function fmtBRL(n: number) {
  return Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function safeNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Miniatura do produto (card), com ícone de fallback quando não há foto cadastrada. */
function ProdutoThumb({ src, alt, size = 44 }: { src?: string | null; alt: string; size?: number }) {
  const normalized = normalizeProductPhotoPublicUrl(src);
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900"
      style={{ width: size, height: size }}
    >
      {normalized ? (
        <FlowProductImage
          src={normalized}
          alt={alt}
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <ShoppingBag size={size * 0.42} className="text-zinc-600" />
      )}
    </span>
  );
}

function readAtendimentoMobilePrefs(): AtendimentoMobilePrefsV1 | null {
  try {
    const raw = window.localStorage.getItem(ATENDIMENTO_MOBILE_PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AtendimentoMobilePrefsV1> | null;
    if (!parsed || parsed.v !== 1) return null;
    if (!Number.isFinite(Number(parsed.ts))) return null;
    return parsed as AtendimentoMobilePrefsV1;
  } catch {
    return null;
  }
}

function writeAtendimentoMobilePrefs(partial: Partial<AtendimentoMobilePrefsV1>) {
  try {
    const prev = readAtendimentoMobilePrefs();
    const next: AtendimentoMobilePrefsV1 = {
      v: 1,
      ts: Date.now(),
      tipoRetirada: (partial.tipoRetirada ?? prev?.tipoRetirada ?? 'delivery') as AtendimentoMobilePrefsV1['tipoRetirada'],
      pagamentoTipo: (partial.pagamentoTipo ?? prev?.pagamentoTipo ?? 'dinheiro') as AtendimentoMobilePrefsV1['pagamentoTipo'],
      taxaEntrega: safeNumber(partial.taxaEntrega ?? prev?.taxaEntrega ?? 0, 0),
    };
    window.localStorage.setItem(ATENDIMENTO_MOBILE_PREFS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

export default function AtendimentoMobileScreen({ token }: { token: string }) {
  const [telefone, setTelefone] = React.useState('');
  const [clienteNome, setClienteNome] = React.useState('');
  const [cliente, setCliente] = React.useState<PrefillCliente | null>(null);
  const [enderecos, setEnderecos] = React.useState<PrefillEndereco[]>([]);
  const [enderecoId, setEnderecoId] = React.useState<number | null>(null);
  const [enderecoLivre, setEnderecoLivre] = React.useState('');
  const [tipoRetirada, setTipoRetirada] = React.useState<'delivery' | 'retirada'>('delivery');
  const [pagamentoTipo, setPagamentoTipo] = React.useState<'dinheiro' | 'pix' | 'cartao'>('dinheiro');
  const [taxaEntrega, setTaxaEntrega] = React.useState(0);
  const [obsPedido, setObsPedido] = React.useState('');
  const [openObsIdx, setOpenObsIdx] = React.useState<number | null>(null);
  const [prefillLoading, setPrefillLoading] = React.useState(false);
  const enderecoLivreRef = React.useRef<HTMLTextAreaElement | null>(null);

  const [qProduto, setQProduto] = React.useState('');
  const [produtos, setProdutos] = React.useState<ProductHit[]>([]);
  const [buscandoProdutos, setBuscandoProdutos] = React.useState(false);

  const [cart, setCart] = React.useState<CartItem[]>([]);
  const [subtotalServer, setSubtotalServer] = React.useState<number | null>(null);
  const [validandoSubtotal, setValidandoSubtotal] = React.useState(false);

  const [saving, setSaving] = React.useState(false);
  const [erro, setErro] = React.useState<string | null>(null);
  const [okMsg, setOkMsg] = React.useState<string | null>(null);

  // --- Fluxo guiado por etapas ---
  const [currentStep, setCurrentStep] = React.useState(1);
  const [maxStep, setMaxStep] = React.useState(1);

  // --- Impressão da comanda ---
  const [savedOrderId, setSavedOrderId] = React.useState<number | null>(null);
  const [savedOrderNumber, setSavedOrderNumber] = React.useState<string | number | null>(null);
  const [printing, setPrinting] = React.useState(false);
  const [printMsg, setPrintMsg] = React.useState<string | null>(null);
  const [printMsgTone, setPrintMsgTone] = React.useState<'ok' | 'warn'>('ok');

  const headers = React.useMemo(
    () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }),
    [token]
  );

  const subtotalHint = React.useMemo(
    () => cart.reduce((acc, it) => acc + Number(it.unit_price_hint || 0) * Number(it.quantity || 0), 0),
    [cart]
  );

  const subtotal = subtotalServer ?? subtotalHint;
  const taxaFinal = tipoRetirada === 'retirada' ? 0 : Math.max(0, Number(taxaEntrega || 0));
  const total = subtotal + taxaFinal;

  const isTelefoneOk = onlyDigits(telefone).length >= 8;
  const needsNome = !cliente && isTelefoneOk;
  const isEnderecoOk = tipoRetirada === 'retirada' ? true : Boolean(String(enderecoLivre || '').trim());
  const canSave =
    isTelefoneOk
    && (!needsNome || Boolean(clienteNome.trim()))
    && cart.length > 0
    && isEnderecoOk
    && !saving;

  const clienteNomeRef = React.useRef(clienteNome);
  React.useEffect(() => {
    clienteNomeRef.current = clienteNome;
  }, [clienteNome]);

  const lastPrefillDigitsRef = React.useRef<string>('');
  const prefillAbortRef = React.useRef<AbortController | null>(null);

  const runPrefill = React.useCallback(
    async (digits: string, opts?: { force?: boolean; source?: 'auto' | 'manual' | 'qs' }) => {
      const source = opts?.source ?? 'manual';
      const force = Boolean(opts?.force);
      if (!force && digits === lastPrefillDigitsRef.current) return;

      prefillAbortRef.current?.abort();
      const ac = new AbortController();
      prefillAbortRef.current = ac;

      setErro(null);
      setOkMsg(null);
      setCliente(null);
      setEnderecos([]);
      setEnderecoId(null);
      setPrefillLoading(true);

      try {
        const res = await fetch(`/api/atendimento/prefill?telefone=${encodeURIComponent(digits)}`, {
          headers,
          signal: ac.signal,
        });
        const data = await res.json();
        if (!res.ok) {
          if (source !== 'auto') {
            setErro(typeof data?.error === 'string' ? data.error : 'Falha ao buscar cliente');
          }
          return;
        }

        lastPrefillDigitsRef.current = digits;
        const c = data?.cliente as PrefillCliente | null;
        const ends = (Array.isArray(data?.enderecos) ? data.enderecos : []) as PrefillEndereco[];
        setCliente(c);
        if (c?.nome && !clienteNomeRef.current.trim()) setClienteNome(String(c.nome));
        setEnderecos(ends);

        const principal = ends.find((e) => Number(e.principal) === 1) || ends[0];
        if (principal?.id) {
          setEnderecoId(Number(principal.id));
          setEnderecoLivre(formatDeliveryAddressLine(principal));
        } else if (tipoRetirada === 'delivery') {
          setEnderecoLivre('');
        }
      } catch (e: any) {
        if (e?.name !== 'AbortError' && source !== 'auto') {
          setErro('Falha ao buscar cliente');
        }
      } finally {
        if (!ac.signal.aborted) setPrefillLoading(false);
      }
    },
    [headers, tipoRetirada]
  );

  React.useEffect(() => {
    const prefs = readAtendimentoMobilePrefs();
    if (!prefs) return;
    if (Date.now() - Number(prefs.ts) > ATENDIMENTO_MOBILE_PREFS_TTL_MS) return;

    if (prefs.tipoRetirada === 'delivery' || prefs.tipoRetirada === 'retirada') setTipoRetirada(prefs.tipoRetirada);
    if (prefs.pagamentoTipo === 'dinheiro' || prefs.pagamentoTipo === 'pix' || prefs.pagamentoTipo === 'cartao') {
      setPagamentoTipo(prefs.pagamentoTipo);
    }
    if (Number.isFinite(Number(prefs.taxaEntrega))) {
      setTaxaEntrega(Math.max(0, safeNumber(prefs.taxaEntrega, 0)));
    }
  }, []);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromQs = params.get('tel') || params.get('telefone') || '';
    const digits = stripBrDdiForDisplay(fromQs);
    if (digits.length >= 8) {
      lastPrefillDigitsRef.current = digits; // evita disparo duplo com auto-busca
      setTelefone(digits);
      void runPrefill(digits, { force: true, source: 'qs' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    const digits = onlyDigits(telefone);
    if (!digits || digits.length < 8) {
      lastPrefillDigitsRef.current = '';
      prefillAbortRef.current?.abort();
      setPrefillLoading(false);
      setCliente(null);
      setEnderecos([]);
      setEnderecoId(null);
      if (tipoRetirada === 'delivery') setEnderecoLivre('');
      return;
    }

    if (digits === lastPrefillDigitsRef.current) return;
    const t = window.setTimeout(() => {
      void runPrefill(digits, { source: 'auto' });
    }, 350);
    return () => window.clearTimeout(t);
  }, [telefone, runPrefill, tipoRetirada]);

  React.useEffect(() => {
    if (tipoRetirada === 'retirada') {
      setTaxaEntrega(0);
      setEnderecoLivre('');
      setEnderecoId(null);
    } else if (enderecoId && enderecos.length) {
      const found = enderecos.find((e) => Number(e.id) === Number(enderecoId));
      if (found) setEnderecoLivre(formatDeliveryAddressLine(found));
    }
  }, [tipoRetirada, enderecoId, enderecos]);

  React.useEffect(() => {
    if (!qProduto.trim() || qProduto.trim().length < 2) {
      setProdutos([]);
      return;
    }

    const ac = new AbortController();
    const t = window.setTimeout(() => {
      void (async () => {
        setBuscandoProdutos(true);
        try {
          const res = await fetch(`/api/atendimento/produtos?q=${encodeURIComponent(qProduto.trim())}`, {
            headers,
            signal: ac.signal,
          });
          const data = await res.json();
          if (!res.ok) {
            setProdutos([]);
            return;
          }
          setProdutos(Array.isArray(data) ? (data as ProductHit[]) : []);
        } finally {
          setBuscandoProdutos(false);
        }
      })();
    }, 250);

    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [qProduto, headers]);

  React.useEffect(() => {
    if (cart.length === 0) {
      setSubtotalServer(null);
      return;
    }
    const ac = new AbortController();
    const t = window.setTimeout(() => {
      void (async () => {
        setValidandoSubtotal(true);
        try {
          const res = await fetch('/api/atendimento/delivery/itens/validate', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              items: cart.map((it) => ({
                product_id: it.product_id,
                quantity: it.quantity,
                observation: it.observation || undefined,
              })),
            }),
            signal: ac.signal,
          });
          const data = await res.json();
          if (!res.ok) return;
          const sub = Number(data?.subtotal);
          if (Number.isFinite(sub)) setSubtotalServer(sub);
        } finally {
          setValidandoSubtotal(false);
        }
      })();
    }, 350);

    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [cart, headers]);

  const addProduto = (p: ProductHit) => {
    if (Number(p.is_combo) === 1) {
      setErro('Combo ainda não suportado no MVP do atendimento mobile. Use o painel completo do delivery.');
      return;
    }
    setErro(null);
    setOkMsg(null);
    setCart((prev) => {
      const idx = prev.findIndex((it) => it.product_id === p.id && !it.observation);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], quantity: next[idx].quantity + 1 };
        return next;
      }
      return [
        ...prev,
        {
          product_id: p.id,
          name: p.name,
          unit_price_hint: safeNumber(p.price, 0),
          quantity: 1,
          observation: '',
          photo_url: normalizeProductPhotoPublicUrl(p.photo_url),
        },
      ];
    });
  };

  const inc = (i: number) => setCart((prev) => prev.map((it, idx) => (idx === i ? { ...it, quantity: it.quantity + 1 } : it)));
  const dec = (i: number) =>
    setCart((prev) =>
      prev
        .map((it, idx) => (idx === i ? { ...it, quantity: Math.max(1, it.quantity - 1) } : it))
        .filter(Boolean)
    );
  const remove = (i: number) => {
    setOpenObsIdx((prev) => {
      if (prev == null) return null;
      if (prev === i) return null;
      if (prev > i) return prev - 1;
      return prev;
    });
    setCart((prev) => prev.filter((_, idx) => idx !== i));
  };
  const setObsItem = (i: number, v: string) =>
    setCart((prev) => prev.map((it, idx) => (idx === i ? { ...it, observation: v } : it)));

  const onBuscarCliente = async () => {
    const digits = onlyDigits(telefone);
    if (digits.length < 8) {
      setErro('Digite o telefone com DDD (mín. 8 dígitos).');
      return;
    }
    await runPrefill(digits, { force: true, source: 'manual' });
  };

  const onSalvar = async () => {
    if (!canSave) return;
    setSaving(true);
    setErro(null);
    setOkMsg(null);
    try {
      const digits = onlyDigits(telefone);

      const validateRes = await fetch('/api/atendimento/delivery/itens/validate', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          items: cart.map((it) => ({
            product_id: it.product_id,
            quantity: it.quantity,
            observation: it.observation || undefined,
          })),
        }),
      });
      const validateData = await validateRes.json();
      if (!validateRes.ok) {
        setErro(typeof validateData?.error === 'string' ? validateData.error : 'Falha ao validar itens');
        return;
      }
      const sub = safeNumber(validateData?.subtotal, 0);
      setSubtotalServer(sub);

      const taxa = tipoRetirada === 'retirada' ? 0 : Math.max(0, Number(taxaEntrega || 0));
      const totalAmount = sub + taxa;

      const body = {
        tipo_retirada: tipoRetirada,
        items: cart.map((it) => ({
          product_id: it.product_id,
          quantity: it.quantity,
          observation: it.observation || undefined,
        })),
        cliente_nome: clienteNome.trim() || cliente?.nome || '',
        cliente_tel: digits,
        endereco: tipoRetirada === 'retirada' ? null : String(enderecoLivre || '').trim(),
        pagamento_tipo: pagamentoTipo,
        taxa_entrega: taxa,
        total_amount: totalAmount,
        observation: obsPedido?.trim() || null,
      };

      const res = await fetch('/api/delivery/pedidos', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data?.success === false) {
        setErro(typeof data?.error === 'string' ? data.error : 'Falha ao salvar pedido');
        return;
      }

      setOkMsg(`Pedido salvo: #${data.orderNumber || data.orderId || ''}`);
      setSavedOrderId(Number(data.orderId) || null);
      setSavedOrderNumber(data.orderNumber || data.orderId || null);
      setPrintMsg(null);
      writeAtendimentoMobilePrefs({
        tipoRetirada,
        pagamentoTipo,
        taxaEntrega: tipoRetirada === 'retirada' ? 0 : Math.max(0, Number(taxaEntrega || 0)),
      });
      setCart([]);
      setObsPedido('');
      setSubtotalServer(null);
      setQProduto('');
      setProdutos([]);
      if (tipoRetirada === 'delivery') {
        // mantém cliente/endereço para lançar outro pedido rapidamente
      } else {
        setEnderecoLivre('');
        setEnderecoId(null);
      }
    } finally {
      setSaving(false);
    }
  };

  const onImprimir = async () => {
    if (!savedOrderId) return;
    setPrinting(true);
    setPrintMsg(null);
    try {
      const res = await fetch(`/api/print/comanda/${savedOrderId}`, { method: 'POST', headers });
      const data = await res.json().catch(() => null as any);
      if (res.ok && data?.success) {
        setPrintMsgTone('ok');
        setPrintMsg('Comanda enviada para a impressora.');
        return;
      }
      // Sem impressora de rede configurada (ex.: impressora só USB no notebook):
      // abre a pré-visualização para impressão manual.
      setPrintMsgTone('warn');
      setPrintMsg(
        data?.message
          ? `${data.message} Abrindo impressão manual…`
          : 'Impressora de rede não configurada. Abrindo impressão manual…'
      );
      const html = await fetchPrintableHtml(`/api/print/comanda-html/${savedOrderId}`, token);
      const win = openPrintPreview(html, 'width=420,height=700,toolbar=0,menubar=0,location=0');
      if (!win) {
        setPrintMsg((prev) => `${prev || ''} Permita pop-ups para abrir a impressão.`.trim());
      }
    } catch {
      setPrintMsgTone('warn');
      setPrintMsg('Falha de conexão ao imprimir. Tente novamente.');
    } finally {
      setPrinting(false);
    }
  };

  // "Novo pedido": mesmo cliente/endereço, pula direto para os itens (agilidade
  // para lançar vários pedidos seguidos do mesmo cliente).
  const startNewOrder = () => {
    setSavedOrderId(null);
    setSavedOrderNumber(null);
    setPrintMsg(null);
    setOkMsg(null);
    setErro(null);
    if (tipoRetirada === 'delivery' && cliente) {
      setCurrentStep(3);
      setMaxStep((m) => Math.max(m, 3));
    } else {
      setCurrentStep(1);
      setMaxStep(1);
    }
  };

  // "Voltar ao início": limpa tudo (telefone, cliente, endereço, carrinho) e
  // recomeça do zero — para atender outro cliente.
  const backToStart = () => {
    setSavedOrderId(null);
    setSavedOrderNumber(null);
    setPrintMsg(null);
    setOkMsg(null);
    setErro(null);
    setTelefone('');
    setClienteNome('');
    setCliente(null);
    setEnderecos([]);
    setEnderecoId(null);
    setEnderecoLivre('');
    setCart([]);
    setObsPedido('');
    setSubtotalServer(null);
    setQProduto('');
    setProdutos([]);
    setCurrentStep(1);
    setMaxStep(1);
  };

  // Etapas "Cliente" e "Entrega" foram unificadas: assim que o telefone é buscado,
  // o atendente já cai direto em nome (só se não achou cadastro) + endereço, num só passo.
  type StepKey = 'telefone' | 'entrega' | 'itens' | 'pagamento' | 'revisao';
  const LAST_STEP = 5;
  const STEPS: { id: number; key: StepKey; label: string; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
    { id: 1, key: 'telefone', label: 'Telefone', icon: Phone },
    { id: 2, key: 'entrega', label: 'Cliente/Entrega', icon: MapPin },
    { id: 3, key: 'itens', label: 'Itens', icon: ShoppingBag },
    { id: 4, key: 'pagamento', label: 'Pagamento', icon: CreditCard },
    { id: 5, key: 'revisao', label: 'Revisão', icon: ClipboardCheck },
  ];

  const isClienteOk = Boolean(cliente) || Boolean(clienteNome.trim());

  const isStepDone = (key: StepKey): boolean => {
    switch (key) {
      case 'telefone':
        return isTelefoneOk;
      case 'entrega':
        return isClienteOk && isEnderecoOk;
      case 'itens':
        return cart.length > 0;
      case 'pagamento':
        return true;
      case 'revisao':
        return Boolean(savedOrderId);
      default:
        return false;
    }
  };

  const goToStep = (id: number) => {
    if (id <= maxStep) setCurrentStep(id);
  };

  const goNext = () => {
    const next = Math.min(LAST_STEP, currentStep + 1);
    setMaxStep((m) => Math.max(m, next));
    setCurrentStep(next);
  };

  const goBack = () => setCurrentStep((s) => Math.max(1, s - 1));

  // Depois que o telefone é buscado (com Enter ou no botão Buscar), pula direto
  // para a etapa de Cliente/Entrega — sem exigir um clique extra em "Continuar".
  const onBuscarEAvancar = async () => {
    await onBuscarCliente();
    setMaxStep((m) => Math.max(m, 2));
    setCurrentStep(2);
  };

  const stepSummary = (key: StepKey): string => {
    switch (key) {
      case 'telefone':
        return telefone || '—';
      case 'entrega': {
        const nome = cliente?.nome || clienteNome || '—';
        const local = tipoRetirada === 'retirada' ? 'Retirada no balcão' : enderecoLivre || '—';
        return `${nome} · ${local}`;
      }
      case 'itens':
        return cart.length ? `${cart.length} item${cart.length > 1 ? 's' : ''} · ${fmtBRL(subtotal)}` : '—';
      case 'pagamento':
        return pagamentoTipo === 'dinheiro' ? 'Dinheiro' : pagamentoTipo === 'pix' ? 'PIX' : 'Cartão';
      default:
        return '';
    }
  };


  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="mx-auto w-full max-w-2xl px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-black tracking-tight">Comandinha (Mobile)</h1>
            <p className="text-[11px] text-zinc-500">Comandinha digital rápida (WhatsApp → pedido)</p>
          </div>
          <a
            href="/"
            className="shrink-0 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-bold text-zinc-300 hover:bg-zinc-800 hover:text-white"
          >
            Painel
          </a>
        </div>

        {/* Trilha de etapas — guia o atendente passo a passo */}
        <div className="mt-4 -mx-4 overflow-x-auto px-4 pb-1 [-webkit-overflow-scrolling:touch]">
          <div className="flex min-w-max items-center gap-1">
            {STEPS.map((step, idx) => {
              const done = isStepDone(step.key) && step.id !== currentStep;
              const active = step.id === currentStep;
              const reached = step.id <= maxStep;
              const Icon = step.icon;
              return (
                <React.Fragment key={step.key}>
                  <button
                    type="button"
                    onClick={() => goToStep(step.id)}
                    disabled={!reached}
                    className={`flex flex-col items-center gap-1 rounded-xl px-1.5 py-1.5 transition-colors ${
                      reached ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
                    }`}
                  >
                    <span
                      className={`flex h-8 w-8 items-center justify-center rounded-full border-2 text-[11px] font-black transition-colors ${
                        active
                          ? 'border-[#EA1D2C] bg-[#EA1D2C] text-white'
                          : done
                            ? 'border-emerald-500 bg-emerald-500/15 text-emerald-400'
                            : 'border-zinc-700 bg-zinc-900 text-zinc-500'
                      }`}
                    >
                      {done ? <Check size={14} /> : <Icon size={14} />}
                    </span>
                    <span className={`text-[9px] font-bold uppercase tracking-wide ${active ? 'text-white' : 'text-zinc-500'}`}>
                      {step.label}
                    </span>
                  </button>
                  {idx < STEPS.length - 1 && (
                    <span className={`h-[2px] w-4 shrink-0 rounded-full ${step.id < currentStep ? 'bg-emerald-500/60' : 'bg-zinc-800'}`} />
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>

        {/* Resumo das etapas já concluídas — toque para editar */}
        {STEPS.some((s) => s.id < currentStep && isStepDone(s.key)) && (
          <div className="mt-3 space-y-1.5">
            {STEPS.filter((s) => s.id < currentStep && isStepDone(s.key)).map((s) => {
              const Icon = s.icon;
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => goToStep(s.id)}
                  className="flex w-full items-center gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-left hover:bg-zinc-900"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                    <Icon size={13} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[9px] font-black uppercase tracking-wider text-zinc-500">{s.label}</span>
                    <span className="block truncate text-[12px] font-semibold text-zinc-200">{stepSummary(s.key)}</span>
                  </span>
                  <Pencil size={13} className="shrink-0 text-zinc-600" />
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-3 space-y-3">
          {/* ETAPA 1 — TELEFONE */}
          {currentStep === 1 && (
            <section className="rounded-2xl border border-[#EA1D2C]/30 bg-zinc-900 p-4">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#EA1D2C]/15 text-[#EA1D2C]">
                  <Phone size={15} />
                </span>
                <div>
                  <h2 className="text-sm font-black text-white">1) Telefone</h2>
                  <p className="text-[11px] text-zinc-500">Buscamos o cadastro do cliente automaticamente</p>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
                <input
                  value={telefone}
                  onChange={(e) => setTelefone(e.target.value)}
                  onPaste={(e) => {
                    const pasted = e.clipboardData?.getData('text') || '';
                    if (!pasted) return;
                    const cleaned = stripBrDdiForDisplay(pasted);
                    if (cleaned) {
                      e.preventDefault();
                      setTelefone(cleaned);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void onBuscarEAvancar();
                  }}
                  inputMode="tel"
                  autoComplete="tel"
                  enterKeyHint="search"
                  autoFocus
                  placeholder="Telefone com DDD (cole do WhatsApp, com ou sem +55)"
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-3 text-base text-white placeholder:text-zinc-600 outline-none focus:border-[#EA1D2C]/60 focus:ring-2 focus:ring-[#EA1D2C]/20"
                />
                <button
                  type="button"
                  onClick={() => void onBuscarEAvancar()}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#EA1D2C] px-3 py-3 text-sm font-black text-white hover:bg-[#C9101E] disabled:opacity-50"
                  disabled={!isTelefoneOk || prefillLoading}
                >
                  <Search size={16} />
                  {prefillLoading ? 'Buscando...' : 'Buscar'}
                </button>
              </div>

              {isTelefoneOk && (
                <div
                  className={`mt-3 flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-[12px] ${
                    prefillLoading
                      ? 'border-zinc-800 bg-zinc-950/60 text-zinc-400'
                      : cliente
                        ? 'border-emerald-900/50 bg-emerald-950/30 text-emerald-300'
                        : 'border-amber-900/50 bg-amber-950/30 text-amber-300'
                  }`}
                >
                  {prefillLoading ? (
                    'Procurando cadastro…'
                  ) : cliente ? (
                    <span>
                      <span className="font-black">Cadastro encontrado:</span> {cliente.nome}
                    </span>
                  ) : (
                    <span>Nenhum cadastro encontrado — no próximo passo você informa o nome.</span>
                  )}
                </div>
              )}
              {!isTelefoneOk && (
                <p className="mt-2 text-[11px] text-zinc-500">Digite ao menos 8 dígitos (DDD + número).</p>
              )}

              <button
                type="button"
                onClick={goNext}
                disabled={!isStepDone('telefone')}
                className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#EA1D2C] px-4 py-3 text-sm font-black text-white hover:bg-[#C9101E] disabled:opacity-30"
              >
                Continuar <ChevronRight size={16} />
              </button>
            </section>
          )}

          {/* ETAPA 2 — CLIENTE + ENTREGA (unificadas: sem clique extra pra confirmar cliente) */}
          {currentStep === 2 && (
            <section className="rounded-2xl border border-[#EA1D2C]/30 bg-zinc-900 p-4">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#EA1D2C]/15 text-[#EA1D2C]">
                  <MapPin size={15} />
                </span>
                <div>
                  <h2 className="text-sm font-black text-white">2) Cliente &amp; Entrega</h2>
                  <p className="text-[11px] text-zinc-500">
                    {cliente ? 'Cadastro encontrado — confirme o endereço' : 'Quem vai receber e onde entregar'}
                  </p>
                </div>
              </div>

              {cliente ? (
                <div className="mt-3 flex items-center gap-3 rounded-xl border border-emerald-900/40 bg-emerald-950/20 px-3 py-2.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-sm font-black text-emerald-300">
                    {(cliente.nome || '?').trim().charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-black text-white">{cliente.nome}</div>
                    <div className="text-[11px] text-zinc-400">{cliente.telefone}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCliente(null)}
                    className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-[11px] font-bold text-zinc-400 hover:bg-zinc-800 hover:text-white"
                  >
                    Trocar
                  </button>
                </div>
              ) : (
                <div className="mt-3">
                  <input
                    value={clienteNome}
                    onChange={(e) => setClienteNome(e.target.value)}
                    autoComplete="name"
                    autoFocus
                    placeholder="Nome de quem vai receber (obrigatório)"
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-3 text-base text-white placeholder:text-zinc-600 outline-none focus:border-[#EA1D2C]/60 focus:ring-2 focus:ring-[#EA1D2C]/20"
                  />
                </div>
              )}

              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setTipoRetirada('delivery')}
                  className={`flex-1 rounded-xl px-3 py-2.5 text-sm font-black border ${
                    tipoRetirada === 'delivery'
                      ? 'bg-[#EA1D2C] border-[#EA1D2C] text-white'
                      : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:bg-zinc-800'
                  }`}
                >
                  Entrega
                </button>
                <button
                  type="button"
                  onClick={() => setTipoRetirada('retirada')}
                  className={`flex-1 rounded-xl px-3 py-2.5 text-sm font-black border ${
                    tipoRetirada === 'retirada'
                      ? 'bg-[#EA1D2C] border-[#EA1D2C] text-white'
                      : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:bg-zinc-800'
                  }`}
                >
                  Retirada
                </button>
              </div>

              {tipoRetirada === 'delivery' && (
                <div className="mt-3 space-y-2">
                  {enderecos.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {enderecos.slice(0, 6).map((e) => (
                        <button
                          key={e.id}
                          type="button"
                          onClick={() => {
                            setEnderecoId(e.id);
                            setEnderecoLivre(formatDeliveryAddressLine(e));
                          }}
                          className={`shrink-0 w-[200px] rounded-xl border px-3 py-2 text-left ${
                            Number(enderecoId) === Number(e.id)
                              ? 'border-[#EA1D2C]/50 bg-[#EA1D2C]/10'
                              : 'border-zinc-800 bg-zinc-950 hover:bg-zinc-800'
                          }`}
                        >
                          <div className="text-[10px] font-black uppercase tracking-wider text-zinc-500">
                            {e.label || 'Endereço'}
                          </div>
                          <div className="mt-1 text-[12px] text-zinc-300 line-clamp-2">
                            {formatDeliveryAddressLine(e)}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setEnderecoId(null);
                      setEnderecoLivre('');
                      requestAnimationFrame(() => enderecoLivreRef.current?.focus());
                    }}
                    className="w-full rounded-xl border border-dashed border-zinc-700 bg-zinc-950 px-3 py-2.5 text-left hover:bg-zinc-800"
                  >
                    <div className="flex items-center gap-2">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#EA1D2C]/15 text-[#EA1D2C]">
                        <Plus size={16} />
                      </span>
                      <div>
                        <div className="text-sm font-black text-white">Adicionar novo endereço</div>
                        <div className="text-[11px] text-zinc-500">Limpa a seleção e permite digitar outro endereço</div>
                      </div>
                    </div>
                  </button>

                  <textarea
                    ref={enderecoLivreRef}
                    value={enderecoLivre}
                    onChange={(e) => setEnderecoLivre(e.target.value)}
                    placeholder="Endereço completo"
                    autoComplete="street-address"
                    rows={3}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-[#EA1D2C]/60 focus:ring-2 focus:ring-[#EA1D2C]/20"
                  />

                  <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
                    <div className="text-[10px] font-black uppercase tracking-wider text-zinc-500">Taxa de entrega</div>
                    <input
                      value={String(taxaEntrega)}
                      onChange={(e) => setTaxaEntrega(safeNumber(e.target.value, 0))}
                      inputMode="decimal"
                      className="mt-2 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-white outline-none focus:border-[#EA1D2C]/60 focus:ring-2 focus:ring-[#EA1D2C]/20"
                    />
                  </div>
                </div>
              )}

              {tipoRetirada === 'retirada' && (
                <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 text-[12px] text-zinc-400">
                  Retirada no balcão (sem endereço / sem taxa).
                </div>
              )}

              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={goBack}
                  className="flex items-center justify-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm font-black text-zinc-300 hover:bg-zinc-800"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  disabled={!isStepDone('entrega')}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#EA1D2C] px-4 py-3 text-sm font-black text-white hover:bg-[#C9101E] disabled:opacity-30"
                >
                  Continuar <ChevronRight size={16} />
                </button>
              </div>
            </section>
          )}

          {/* ETAPA 3 — ITENS */}
          {currentStep === 3 && (
            <section className="rounded-2xl border border-[#EA1D2C]/30 bg-zinc-900 p-4">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#EA1D2C]/15 text-[#EA1D2C]">
                  <ShoppingBag size={15} />
                </span>
                <div>
                  <h2 className="text-sm font-black text-white">3) Itens</h2>
                  <p className="text-[11px] text-zinc-500">Monte o pedido do cliente</p>
                </div>
              </div>

              <div className="mt-3">
                <input
                  value={qProduto}
                  onChange={(e) => setQProduto(e.target.value)}
                  autoFocus
                  placeholder="Adicionar item (digite 2 letras)"
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-3 text-base text-white placeholder:text-zinc-600 outline-none focus:border-[#EA1D2C]/60 focus:ring-2 focus:ring-[#EA1D2C]/20"
                />
                {buscandoProdutos && <p className="mt-2 text-[11px] text-zinc-500">Buscando…</p>}
                {produtos.length > 0 && (
                  <div className="mt-2 space-y-2">
                    {produtos.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => addProduto(p)}
                        className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-left hover:bg-zinc-800"
                      >
                        <div className="flex items-center gap-3">
                          <ProdutoThumb src={p.photo_url} alt={p.name} />
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold text-white truncate">{p.name}</div>
                            <div className="text-[11px] text-zinc-500 truncate">{p.category}</div>
                          </div>
                          <div className="shrink-0 text-sm font-black text-white">{fmtBRL(p.price)}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-4 space-y-3">
                {cart.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-zinc-800 px-3 py-6 text-center text-[12px] text-zinc-500">
                    Adicione itens para montar o pedido.
                  </p>
                ) : (
                  cart.map((it, idx) => (
                    <div key={`${it.product_id}-${idx}`} className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <ProdutoThumb src={it.photo_url} alt={it.name} />
                          <div className="min-w-0">
                            <p className="text-sm font-black text-white truncate">{it.name}</p>
                            <p className="text-[11px] text-zinc-500">
                              {fmtBRL(it.unit_price_hint)} · linha: {fmtBRL(it.unit_price_hint * it.quantity)}
                            </p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => remove(idx)}
                          className="shrink-0 rounded-xl border border-zinc-800 bg-zinc-900 p-2 text-zinc-400 hover:text-[#EA1D2C] hover:bg-zinc-800"
                          aria-label="Remover"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>

                      <div className="mt-2 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => dec(idx)}
                          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                          aria-label="Diminuir"
                        >
                          <Minus size={16} />
                        </button>
                        <div className="min-w-[52px] text-center text-sm font-black text-white">{it.quantity}</div>
                        <button
                          type="button"
                          onClick={() => inc(idx)}
                          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                          aria-label="Aumentar"
                        >
                          <Plus size={16} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setOpenObsIdx((prev) => (prev === idx ? null : idx))}
                          className={`ml-2 rounded-xl border px-3 py-2 text-sm font-black ${
                            openObsIdx === idx || it.observation
                              ? 'border-[#EA1D2C]/40 bg-[#EA1D2C]/10 text-[#EA1D2C]'
                              : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
                          }`}
                        >
                          Obs
                        </button>
                      </div>

                      {(openObsIdx === idx || Boolean(it.observation)) && (
                        <div className="mt-2">
                          <input
                            value={it.observation}
                            onChange={(e) => setObsItem(idx, e.target.value)}
                            placeholder="Observação do item (opcional)"
                            className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-[#EA1D2C]/60 focus:ring-2 focus:ring-[#EA1D2C]/20"
                          />
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>

              {cart.length > 0 && (
                <div className="mt-3 flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2.5">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">Subtotal</span>
                  <span className="text-sm font-black text-white">{fmtBRL(subtotal)}</span>
                </div>
              )}

              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={goBack}
                  className="flex items-center justify-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm font-black text-zinc-300 hover:bg-zinc-800"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  disabled={!isStepDone('itens')}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#EA1D2C] px-4 py-3 text-sm font-black text-white hover:bg-[#C9101E] disabled:opacity-30"
                >
                  Continuar <ChevronRight size={16} />
                </button>
              </div>
            </section>
          )}

          {/* ETAPA 4 — PAGAMENTO */}
          {currentStep === 4 && (
            <section className="rounded-2xl border border-[#EA1D2C]/30 bg-zinc-900 p-4">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#EA1D2C]/15 text-[#EA1D2C]">
                  <CreditCard size={15} />
                </span>
                <div>
                  <h2 className="text-sm font-black text-white">4) Pagamento</h2>
                  <p className="text-[11px] text-zinc-500">Como o cliente vai pagar?</p>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2">
                {(
                  [
                    { id: 'dinheiro', label: 'Dinheiro', icon: Banknote },
                    { id: 'pix', label: 'PIX', icon: QrCode },
                    { id: 'cartao', label: 'Cartão', icon: CreditCard },
                  ] as const
                ).map((opt) => {
                  const OptIcon = opt.icon;
                  const active = pagamentoTipo === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setPagamentoTipo(opt.id)}
                      className={`flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-[12px] font-black transition-colors ${
                        active
                          ? 'border-[#EA1D2C] bg-[#EA1D2C]/10 text-[#EA1D2C]'
                          : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:bg-zinc-800'
                      }`}
                    >
                      <OptIcon size={18} />
                      {opt.label}
                    </button>
                  );
                })}
              </div>

              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={goBack}
                  className="flex items-center justify-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm font-black text-zinc-300 hover:bg-zinc-800"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#EA1D2C] px-4 py-3 text-sm font-black text-white hover:bg-[#C9101E]"
                >
                  Continuar <ChevronRight size={16} />
                </button>
              </div>
            </section>
          )}

          {/* ETAPA 5 — REVISÃO / SALVAR / IMPRIMIR */}
          {currentStep === 5 && !savedOrderId && (
            <section className="rounded-2xl border border-[#EA1D2C]/30 bg-zinc-900 p-4">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#EA1D2C]/15 text-[#EA1D2C]">
                  <ClipboardCheck size={15} />
                </span>
                <div>
                  <h2 className="text-sm font-black text-white">5) Revisão</h2>
                  <p className="text-[11px] text-zinc-500">Confira tudo antes de salvar</p>
                </div>
              </div>

              <div className="mt-3 space-y-2 text-[12px]">
                <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                  <span className="text-zinc-500">Cliente</span>
                  <span className="font-bold text-white">{cliente?.nome || clienteNome || '—'} · {telefone}</span>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                  <span className="text-zinc-500">Entrega</span>
                  <span className="max-w-[70%] truncate text-right font-bold text-white">
                    {tipoRetirada === 'retirada' ? 'Retirada no balcão' : enderecoLivre}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                  <span className="text-zinc-500">Itens</span>
                  <span className="font-bold text-white">{cart.length}</span>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                  <span className="text-zinc-500">Pagamento</span>
                  <span className="font-bold text-white">{stepSummary('pagamento')}</span>
                </div>
              </div>

              <div className="mt-3">
                <textarea
                  value={obsPedido}
                  onChange={(e) => setObsPedido(e.target.value)}
                  placeholder="Observação do pedido (opcional)"
                  rows={2}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-[#EA1D2C]/60 focus:ring-2 focus:ring-[#EA1D2C]/20"
                />
              </div>

              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <div className="text-[10px] font-black uppercase tracking-wider text-zinc-500">Subtotal</div>
                  <div className="mt-1 text-sm font-black text-white">{fmtBRL(subtotal)}</div>
                  <div className="text-[11px] text-zinc-500">
                    {validandoSubtotal ? 'recalculando…' : subtotalServer != null ? 'validado' : 'estimado'}
                  </div>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <div className="text-[10px] font-black uppercase tracking-wider text-zinc-500">Taxa</div>
                  <div className="mt-1 text-sm font-black text-white">{fmtBRL(taxaFinal)}</div>
                </div>
                <div className="rounded-xl border border-[#EA1D2C]/30 bg-[#EA1D2C]/5 p-3">
                  <div className="text-[10px] font-black uppercase tracking-wider text-zinc-500">Total</div>
                  <div className="mt-1 text-sm font-black text-[#EA1D2C]">{fmtBRL(total)}</div>
                </div>
              </div>

              {erro && (
                <div className="mt-3 rounded-xl border border-red-900/40 bg-red-950/30 px-4 py-3 text-sm text-red-400">
                  {erro}
                </div>
              )}

              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={goBack}
                  className="flex items-center justify-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm font-black text-zinc-300 hover:bg-zinc-800"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => void onSalvar()}
                  disabled={!canSave}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#EA1D2C] px-4 py-3 text-sm font-black text-white hover:bg-[#C9101E] disabled:opacity-40"
                >
                  {saving ? 'Salvando…' : 'Salvar pedido'}
                </button>
              </div>
            </section>
          )}

          {/* SUCESSO — pedido salvo, oferece impressão */}
          {currentStep === 5 && savedOrderId && (
            <section className="rounded-2xl border border-emerald-900/40 bg-emerald-950/20 p-5 text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                <Check size={22} />
              </span>
              <h2 className="mt-3 text-base font-black text-white">Pedido salvo!</h2>
              <p className="mt-1 text-sm text-zinc-400">
                Comanda #{savedOrderNumber} · {cliente?.nome || clienteNome}
              </p>

              {printMsg && (
                <div
                  className={`mt-3 rounded-xl border px-3 py-2.5 text-[12px] ${
                    printMsgTone === 'ok'
                      ? 'border-emerald-900/50 bg-emerald-950/30 text-emerald-300'
                      : 'border-amber-900/50 bg-amber-950/30 text-amber-300'
                  }`}
                >
                  {printMsg}
                </div>
              )}

              <div className="mt-4 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => void onImprimir()}
                  disabled={printing}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#EA1D2C] px-4 py-3 text-sm font-black text-white hover:bg-[#C9101E] disabled:opacity-50"
                >
                  <Printer size={16} />
                  {printing ? 'Enviando…' : 'Imprimir comanda'}
                </button>
                <button
                  type="button"
                  onClick={startNewOrder}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm font-black text-zinc-200 hover:bg-zinc-800"
                >
                  <RotateCcw size={16} />
                  Novo pedido {tipoRetirada === 'delivery' && cliente ? '(mesmo cliente)' : ''}
                </button>
                <button
                  type="button"
                  onClick={backToStart}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm font-black text-zinc-400 hover:bg-zinc-800 hover:text-white"
                >
                  <Home size={16} />
                  Voltar ao início
                </button>
              </div>

              <p className="mt-3 text-[10px] leading-snug text-zinc-500">
                Se a impressora for só USB no notebook (sem IP de rede configurado em Configurações), a
                pré-visualização abre para impressão manual por lá.
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
