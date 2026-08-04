import React from 'react';
import { Minus, Plus, Search, Trash2 } from 'lucide-react';
import { formatDeliveryAddressLine } from '../../utils/deliveryAddressFormat';

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
  is_combo?: number | null;
};

type CartItem = {
  product_id: number;
  name: string;
  unit_price_hint: number;
  quantity: number;
  observation: string;
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

function fmtBRL(n: number) {
  return Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function safeNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
    const digits = onlyDigits(fromQs);
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

        <div className="mt-4 space-y-3">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <h2 className="text-sm font-black text-white">1) Cliente</h2>
            <div className="mt-3 space-y-2">
              <input
                value={clienteNome}
                onChange={(e) => setClienteNome(e.target.value)}
                autoComplete="name"
                placeholder={cliente ? 'Cliente (opcional)' : 'Cliente (obrigatório se não tiver cadastro)'}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-[#EA1D2C]/60 focus:ring-2 focus:ring-[#EA1D2C]/20"
              />
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-[12px] text-zinc-400">
                {cliente
                  ? `Cadastro encontrado: ${cliente.nome} (${cliente.telefone})`
                  : 'Sem cadastro? Informe o nome e siga.'}
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <h2 className="text-sm font-black text-white">2) Telefone</h2>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
              <input
                value={telefone}
                onChange={(e) => setTelefone(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onBuscarCliente();
                }}
                inputMode="tel"
                autoComplete="tel"
                enterKeyHint="search"
                placeholder="Telefone (DDD) — buscar cadastro"
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-[#EA1D2C]/60 focus:ring-2 focus:ring-[#EA1D2C]/20"
              />
              <button
                type="button"
                onClick={() => void onBuscarCliente()}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#EA1D2C] px-3 py-2.5 text-sm font-black text-white hover:bg-[#C9101E] disabled:opacity-50"
                disabled={!isTelefoneOk || prefillLoading}
              >
                <Search size={16} />
                {prefillLoading ? 'Buscando...' : 'Buscar'}
                {/*
                {prefillLoading ? 'Buscandoâ€¦' : 'Buscar'}
                */}
              </button>

            </div>
            <p className="mt-2 text-[11px] text-zinc-500">
              Busca automatica ao digitar (min. 8 digitos). O botao <span className="font-bold text-zinc-300">Buscar</span> serve para forcar/repetir.
              {/*
              Dica: digitou o telefone? toque em <span className="font-bold text-zinc-300">Buscar</span> e já puxa cliente/endereço.
              */}
            </p>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <h2 className="text-sm font-black text-white">3) Endereço</h2>
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
                        className={`shrink-0 rounded-xl border px-3 py-2 text-left ${
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
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <h2 className="text-sm font-black text-white">4) Itens</h2>
            <div className="mt-3">
              <input
                value={qProduto}
                onChange={(e) => setQProduto(e.target.value)}
                placeholder="Adicionar item (digite 2 letras)"
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-[#EA1D2C]/60 focus:ring-2 focus:ring-[#EA1D2C]/20"
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
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-white truncate">{p.name}</div>
                          <div className="text-[11px] text-zinc-500 truncate">{p.category}</div>
                        </div>
                        <div className="text-sm font-black text-white">{fmtBRL(p.price)}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-4 space-y-3">
              {cart.length === 0 ? (
                <p className="text-[12px] text-zinc-500">Adicione itens para montar o pedido.</p>
              ) : (
                cart.map((it, idx) => (
                  <div key={`${it.product_id}-${idx}`} className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-black text-white">{it.name}</p>
                        <p className="text-[11px] text-zinc-500">
                          {fmtBRL(it.unit_price_hint)} · linha: {fmtBRL(it.unit_price_hint * it.quantity)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => remove(idx)}
                        className="rounded-xl border border-zinc-800 bg-zinc-900 p-2 text-zinc-400 hover:text-[#EA1D2C] hover:bg-zinc-800"
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
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <h2 className="text-sm font-black text-white">5) Total</h2>
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

            <div className="mt-3">
              <textarea
                value={obsPedido}
                onChange={(e) => setObsPedido(e.target.value)}
                placeholder="Observação do pedido (opcional)"
                rows={2}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-[#EA1D2C]/60 focus:ring-2 focus:ring-[#EA1D2C]/20"
              />
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <h2 className="text-sm font-black text-white">6) Pagamento</h2>
            <select
              value={pagamentoTipo}
              onChange={(e) => setPagamentoTipo(e.target.value as any)}
              className="mt-3 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-white outline-none focus:border-[#EA1D2C]/60 focus:ring-2 focus:ring-[#EA1D2C]/20"
            >
              <option value="dinheiro">Dinheiro</option>
              <option value="pix">PIX</option>
              <option value="cartao">Cartão</option>
            </select>
          </section>

          {erro && (
            <div className="rounded-2xl border border-red-900/40 bg-red-950/30 px-4 py-3 text-sm text-red-400">
              {erro}
            </div>
          )}
          {okMsg && (
            <div className="rounded-2xl border border-emerald-900/40 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-400">
              {okMsg}
            </div>
          )}

          <button
            type="button"
            onClick={() => void onSalvar()}
            disabled={!canSave}
            className="w-full rounded-2xl bg-[#EA1D2C] px-4 py-3 text-sm font-black text-white hover:bg-[#C9101E] disabled:opacity-40"
          >
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  );
}
