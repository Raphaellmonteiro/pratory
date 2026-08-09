/**
 * GarcomMobileScreen.tsx — tela pública (sem login pessoal) acessada pelo
 * QR temporário gerado em Mesas → "Gerar QR Garçom". Permite abrir mesas,
 * lançar itens na comanda e fechar a mesa (com forma de pagamento) pelo
 * celular do garçom. O token do QR expira sozinho (6h) e o back-end recusa
 * qualquer ação fora desse escopo.
 *
 * Identificação do garçom: na primeira leitura do QR em cada aparelho, pede
 * o nome (autodeclarado, não é login) e guarda no navegador. O nome vai
 * junto em todo request via header `X-Garcom-Nome` e é gravado em
 * system_logs no back-end quando a mesa é aberta ou fechada — serve pra
 * responder "quem abriu/fechou essa mesa", não é autenticação de verdade.
 */

import React from 'react';
import { Search, Plus, Minus, ArrowLeft, AlertCircle, Loader2, Trash2, Wallet, X, Check, Bell, Sparkles, Delete, User } from 'lucide-react';
import POSProductOptionsDialog from '../../shared/POSProductOptionsDialog';
import {
  type ProductOptionsProduto,
  type ProductOptionsCartItem,
  type GrupoOpcao,
  type VariacaoVendavel,
  type ComboGrupoUi,
} from '../../shared/ProductOptionsModal';

type Mesa = {
  id: number;
  numero: number;
  status: 'aberta' | 'fechada';
  total_itens?: number;
  total_valor?: number;
};

type ComandaItem = {
  id: number;
  product_name: string;
  quantity: number;
  price_at_time: number;
  observation?: string | null;
};

type ComandaInfo = {
  total_com_extras?: number;
} | null;

type ProdutoHit = {
  id: number;
  name: string;
  price: number;
  category: string;
  is_combo?: number | boolean;
  /** Produto tem grupo de adicionais ou combo — precisa abrir o modal de
   *  personalização antes de lançar na comanda (ver `/produtos-garcom`). */
  tem_opcoes?: boolean;
};

type Payment = { method: string; amount_paid: number };

const PAYMENT_METHODS = ['Dinheiro', 'PIX', 'Débito', 'Crédito'];
const GARCOM_NOME_STORAGE_PREFIX = 'garcom_nome_';

function fmtBRL(n: number) {
  return Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Normaliza os grupos de adicionais vindos da API pro formato estrito que o
 *  modal espera — mesma lógica usada no PDV (`POSScreen.tsx`), pra manter o
 *  mesmo comportamento em qualquer tela que lança item com opções. */
function normalizeGruposGarcom(raw: unknown): GrupoOpcao[] {
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
      modo_preco: g.modo_preco === 'final' ? ('final' as const) : ('adicional' as const),
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

type OpcoesApiPayload = {
  grupos: GrupoOpcao[];
  variacoes: VariacaoVendavel[];
  combo_grupos: ComboGrupoUi[];
  is_combo: boolean;
};

/** Mesma normalização do GET unificado `pdv-opcoes` do PDV, aplicada aqui à
 *  resposta de `/api/mesas/produtos-garcom/:id/opcoes`. */
function parseOpcoesApiResponse(data: {
  variacoes_vendaveis?: unknown;
  grupos_opcao?: unknown;
  combo_grupos?: unknown;
  is_combo?: unknown;
}): OpcoesApiPayload {
  const vars = data?.variacoes_vendaveis;
  const ativas = Array.isArray(vars) ? vars.filter((v: any) => Number(v?.ativo) === 1) : [];
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
  return { grupos: normalizeGruposGarcom(data?.grupos_opcao), variacoes, combo_grupos, is_combo };
}

function buildProdutoOptionsPayload(
  produto: ProdutoHit,
  grupos: GrupoOpcao[],
  variacoes: VariacaoVendavel[],
  extras?: { is_combo?: boolean; combo_grupos?: ComboGrupoUi[] }
): ProductOptionsProduto {
  const isCombo = extras?.is_combo === true || Number(produto.is_combo) === 1;
  return {
    id: produto.id,
    name: produto.name,
    price: produto.price,
    category: produto.category,
    grupos_opcao: grupos,
    variacoes_vendaveis: variacoes,
    is_combo: isCombo ? 1 : 0,
    combo_grupos: Array.isArray(extras?.combo_grupos) ? extras!.combo_grupos : [],
  };
}

type GarcomPublico = { id: number; nome: string };

export default function GarcomMobileScreen({ qrToken }: { qrToken: string }) {
  // ── Identificação do garçom: escolhe o nome cadastrado + digita o PIN ───
  // (evita ele entrar sem querer no usuário de outro garçom). Guarda o token
  // "identificado" (já carimbado com garcomId/garcomNome pelo back-end) no
  // aparelho, pra não precisar redigitar o PIN toda hora dentro da validade
  // do QR (6h).
  const sessionStorageKey = React.useMemo(() => `${GARCOM_NOME_STORAGE_PREFIX}${qrToken}`, [qrToken]);
  const [activeToken, setActiveToken] = React.useState<string | null>(null);
  const [garcomNome, setGarcomNome] = React.useState<string | null>(null);
  const [garcomId, setGarcomId] = React.useState<number | null>(null);
  const [sessionChecked, setSessionChecked] = React.useState(false);

  const [garconsPublico, setGarconsPublico] = React.useState<GarcomPublico[]>([]);
  const [carregandoGarcons, setCarregandoGarcons] = React.useState(true);
  const [garcomSelecionado, setGarcomSelecionado] = React.useState<GarcomPublico | null>(null);
  const [pinInput, setPinInput] = React.useState('');
  const [loginErro, setLoginErro] = React.useState<string | null>(null);
  const [logando, setLogando] = React.useState(false);

  // Restaura sessão salva no aparelho (se ainda for válida).
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(sessionStorageKey);
      if (raw) {
        const saved = JSON.parse(raw) as { token: string; nome: string; id: number };
        if (saved?.token && saved?.nome && saved?.id) {
          setActiveToken(saved.token);
          setGarcomNome(saved.nome);
          setGarcomId(saved.id);
        }
      }
    } catch {
      // ignora sessão corrompida
    } finally {
      setSessionChecked(true);
    }
  }, [sessionStorageKey]);

  // Lista os garçons cadastrados (tela de seleção), usando sempre o token
  // "cru" do QR — funciona mesmo antes de identificado.
  React.useEffect(() => {
    if (activeToken) return;
    let cancelled = false;
    (async () => {
      setCarregandoGarcons(true);
      try {
        const res = await fetch('/api/mesas/garcons-publico', {
          headers: { Authorization: `Bearer ${qrToken}` },
        });
        if (res.status === 401 || res.status === 403) {
          if (!cancelled) setExpired(true);
          return;
        }
        const data = await res.json();
        if (!cancelled) setGarconsPublico(Array.isArray(data?.garcons) ? data.garcons : []);
      } catch {
        if (!cancelled) setGarconsPublico([]);
      } finally {
        if (!cancelled) setCarregandoGarcons(false);
      }
    })();
    return () => { cancelled = true; };
  }, [qrToken, activeToken]);

  const handleDigitoPin = (d: string) => {
    setLoginErro(null);
    setPinInput((prev) => (prev.length >= 6 ? prev : prev + d));
  };
  const handleApagarPin = () => setPinInput((prev) => prev.slice(0, -1));

  const handleConfirmarLogin = React.useCallback(async () => {
    if (!garcomSelecionado || pinInput.length < 4) return;
    setLogando(true);
    setLoginErro(null);
    try {
      const res = await fetch('/api/mesas/garcom-login', {
        method: 'POST',
        headers: { Authorization: `Bearer ${qrToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ garcom_id: garcomSelecionado.id, pin: pinInput }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        setLoginErro(data?.message || 'PIN incorreto.');
        setPinInput('');
        return;
      }
      const session = { token: data.token as string, nome: data.garcom.nome as string, id: data.garcom.id as number };
      try { localStorage.setItem(sessionStorageKey, JSON.stringify(session)); } catch { /* ignora */ }
      setActiveToken(session.token);
      setGarcomNome(session.nome);
      setGarcomId(session.id);
    } catch {
      setLoginErro('Erro ao entrar. Tente novamente.');
      setPinInput('');
    } finally {
      setLogando(false);
    }
  }, [garcomSelecionado, pinInput, qrToken, sessionStorageKey]);

  // Envia o PIN automaticamente ao completar 4 dígitos.
  React.useEffect(() => {
    if (pinInput.length === 4 && garcomSelecionado && !logando) {
      void handleConfirmarLogin();
    }
  }, [pinInput, garcomSelecionado, logando, handleConfirmarLogin]);

  const handleTrocarUsuario = () => {
    try { localStorage.removeItem(sessionStorageKey); } catch { /* ignora */ }
    setActiveToken(null);
    setGarcomNome(null);
    setGarcomId(null);
    setGarcomSelecionado(null);
    setPinInput('');
  };

  const headers = React.useMemo(
    () => ({
      Authorization: `Bearer ${activeToken || qrToken}`,
      'Content-Type': 'application/json',
    }),
    [qrToken, activeToken]
  );

  const [mesas, setMesas] = React.useState<Mesa[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [expired, setExpired] = React.useState(false);
  const [selectedMesa, setSelectedMesa] = React.useState<Mesa | null>(null);
  const [itens, setItens] = React.useState<ComandaItem[]>([]);
  const [comandaInfo, setComandaInfo] = React.useState<ComandaInfo>(null);
  const [loadingComanda, setLoadingComanda] = React.useState(false);
  const [abrindo, setAbrindo] = React.useState(false);

  const [qProduto, setQProduto] = React.useState('');
  const [catalogo, setCatalogo] = React.useState<ProdutoHit[]>([]);
  const [catalogoCarregando, setCatalogoCarregando] = React.useState(false);
  const [categoriaAtiva, setCategoriaAtiva] = React.useState('Todas');
  const [adicionando, setAdicionando] = React.useState<number | null>(null);
  const [removendo, setRemovendo] = React.useState<number | null>(null);
  const [qty, setQty] = React.useState<Record<number, number>>({});

  // ── Modal de opções/adicionais (produtos com grupo ou combo) ────────────
  // Mesmo componente usado no PDV (`POSProductOptionsDialog` + `ProductOptionsModal`),
  // só que buscando os grupos por `/api/mesas/produtos-garcom/:id/opcoes`
  // (rota liberada pro QR temporário do garçom).
  const [opcaoModalProduto, setOpcaoModalProduto] = React.useState<ProductOptionsProduto | null>(null);
  const [opcaoModalBaseProduct, setOpcaoModalBaseProduct] = React.useState<ProdutoHit | null>(null);
  const [carregandoOpcoesProduto, setCarregandoOpcoesProduto] = React.useState(false);
  const opcaoModalLoadSeqRef = React.useRef(0);
  const opcoesCacheRef = React.useRef<Map<number, OpcoesApiPayload>>(new Map());

  // ── Fechar mesa (forma de pagamento) ────────────────────────────────────
  const [fechandoMesa, setFechandoMesa] = React.useState(false);
  const [payments, setPayments] = React.useState<Payment[]>([]);
  const [payMethod, setPayMethod] = React.useState('Dinheiro');
  const [payAmount, setPayAmount] = React.useState('');
  const [finalizando, setFinalizando] = React.useState(false);
  const [finalizarErro, setFinalizarErro] = React.useState<string | null>(null);

  // ── Pedir a conta (avisa o balcão, sem fechar a mesa) ───────────────────
  const [pedindoConta, setPedindoConta] = React.useState(false);
  const [contaPedidaMsg, setContaPedidaMsg] = React.useState<string | null>(null);
  const contaPedidaTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchMesas = React.useCallback(async () => {
    try {
      const res = await fetch('/api/mesas', { headers });
      if (res.status === 401 || res.status === 403) {
        setExpired(true);
        return;
      }
      const data = await res.json();
      setMesas(Array.isArray(data) ? data : []);
    } catch {
      setExpired(true);
    } finally {
      setLoading(false);
    }
  }, [headers]);

  React.useEffect(() => {
    if (!activeToken || !garcomId) return;
    fetchMesas();
  }, [fetchMesas, activeToken, garcomId]);

  const fetchComanda = React.useCallback(async (mesa: Mesa) => {
    setLoadingComanda(true);
    try {
      const res = await fetch(`/api/mesas/${mesa.id}/comanda`, { headers });
      if (res.status === 401 || res.status === 403) { setExpired(true); return; }
      const data = await res.json();
      setItens(Array.isArray(data?.itens) ? data.itens : []);
      setComandaInfo(data?.comanda ?? null);
    } catch {
      setItens([]);
      setComandaInfo(null);
    } finally {
      setLoadingComanda(false);
    }
  }, [headers]);

  const handleAbrirMesa = async (mesa: Mesa) => {
    setAbrindo(true);
    try {
      const res = await fetch(`/api/mesas/${mesa.id}/abrir`, { method: 'PUT', headers });
      if (res.status === 401 || res.status === 403) { setExpired(true); return; }
      const updated = { ...mesa, status: 'aberta' as const };
      setSelectedMesa(updated);
      await fetchComanda(updated);
      await fetchMesas();
    } finally {
      setAbrindo(false);
    }
  };

  const handleClickMesa = async (mesa: Mesa) => {
    setSelectedMesa(mesa);
    setQProduto('');
    setCategoriaAtiva('Todas');
    setFechandoMesa(false);
    setPayments([]);
    setPayAmount('');
    setFinalizarErro(null);
    if (mesa.status === 'aberta') await fetchComanda(mesa);
  };

  // Catálogo completo é buscado uma vez ao abrir a mesa (e reaproveitado);
  // filtro por categoria e por texto acontece no celular, sem round-trip.
  React.useEffect(() => {
    if (!selectedMesa || selectedMesa.status !== 'aberta') return;
    let cancelled = false;
    (async () => {
      setCatalogoCarregando(true);
      try {
        const res = await fetch('/api/mesas/produtos-garcom', { headers });
        if (res.status === 401 || res.status === 403) { setExpired(true); return; }
        const data = await res.json();
        if (!cancelled) setCatalogo(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) setCatalogo([]);
      } finally {
        if (!cancelled) setCatalogoCarregando(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedMesa?.id, selectedMesa?.status, headers]);

  const categorias = React.useMemo(
    () => ['Todas', ...Array.from(new Set(catalogo.map((p) => p.category).filter(Boolean)))],
    [catalogo]
  );

  const produtos = React.useMemo(() => {
    const term = qProduto.trim().toLowerCase();
    return catalogo.filter((p) => {
      const matchCategoria = categoriaAtiva === 'Todas' || p.category === categoriaAtiva;
      const matchTermo = term.length === 0 || p.name.toLowerCase().includes(term);
      return matchCategoria && matchTermo;
    });
  }, [catalogo, categoriaAtiva, qProduto]);

  const handleRemoverItem = async (item: ComandaItem) => {
    if (!selectedMesa) return;
    if (!window.confirm(`Remover "${item.product_name}" da comanda?`)) return;
    setRemovendo(item.id);
    try {
      const res = await fetch(`/api/mesas/comanda/item/${item.id}`, { method: 'DELETE', headers });
      if (res.status === 401 || res.status === 403) { setExpired(true); return; }
      await fetchComanda(selectedMesa);
    } finally {
      setRemovendo(null);
    }
  };

  const handleAdicionar = async (produto: ProdutoHit) => {
    if (!selectedMesa) return;
    const quantidade = qty[produto.id] || 1;
    setAdicionando(produto.id);
    try {
      const res = await fetch(`/api/mesas/${selectedMesa.id}/comanda/adicionar`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          product_id: produto.id,
          product_name: produto.name,
          price_at_time: produto.price,
          quantity: quantidade,
        }),
      });
      if (res.status === 401 || res.status === 403) { setExpired(true); return; }
      if (res.ok) {
        const mesaAberta = { ...selectedMesa, status: 'aberta' as const };
        setSelectedMesa(mesaAberta);
        await fetchComanda(mesaAberta);
        setQty((prev) => ({ ...prev, [produto.id]: 1 }));
      }
    } finally {
      setAdicionando(null);
    }
  };

  // Produto com grupo de adicionais/combo: abre o mesmo modal de
  // personalização do PDV antes de lançar o item, buscando (e cacheando) os
  // grupos pela rota liberada pro QR do garçom.
  const openProductCustomizeFlow = React.useCallback(async (produto: ProdutoHit) => {
    const seq = ++opcaoModalLoadSeqRef.current;
    setOpcaoModalBaseProduct(produto);

    const cached = opcoesCacheRef.current.get(produto.id);
    if (cached) {
      setOpcaoModalProduto(
        buildProdutoOptionsPayload(produto, cached.grupos, cached.variacoes, {
          is_combo: cached.is_combo,
          combo_grupos: cached.combo_grupos,
        })
      );
      setCarregandoOpcoesProduto(false);
      return;
    }

    setOpcaoModalProduto(buildProdutoOptionsPayload(produto, [], [], { is_combo: false, combo_grupos: [] }));
    setCarregandoOpcoesProduto(true);
    try {
      const res = await fetch(`/api/mesas/produtos-garcom/${produto.id}/opcoes`, { headers });
      if (res.status === 401 || res.status === 403) { setExpired(true); return; }
      if (seq !== opcaoModalLoadSeqRef.current) return;
      let payload: OpcoesApiPayload = { grupos: [], variacoes: [], combo_grupos: [], is_combo: false };
      if (res.ok) {
        const data = await res.json();
        payload = parseOpcoesApiResponse(data);
        opcoesCacheRef.current.set(produto.id, payload);
      }
      setOpcaoModalProduto(
        buildProdutoOptionsPayload(produto, payload.grupos, payload.variacoes, {
          is_combo: payload.is_combo,
          combo_grupos: payload.combo_grupos,
        })
      );
    } catch {
      if (seq !== opcaoModalLoadSeqRef.current) return;
      setOpcaoModalProduto(buildProdutoOptionsPayload(produto, [], [], { is_combo: false, combo_grupos: [] }));
    } finally {
      if (seq === opcaoModalLoadSeqRef.current) setCarregandoOpcoesProduto(false);
    }
  }, [headers]);

  const closeOpcaoModal = React.useCallback(() => {
    opcaoModalLoadSeqRef.current += 1;
    setCarregandoOpcoesProduto(false);
    setOpcaoModalProduto(null);
    setOpcaoModalBaseProduct(null);
  }, []);

  // Resolve/carrega opções de um componente dentro de um combo — mesmo
  // contrato do PDV (`resolveComboComponentePOS`/`loadComboComponenteOpcoesPOS`).
  const resolveComboComponenteGarcom = React.useCallback(
    (productId: number) => {
      const base = catalogo.find((p) => p.id === productId);
      if (!base) return null;
      const cached = opcoesCacheRef.current.get(productId);
      return buildProdutoOptionsPayload(base, cached?.grupos ?? [], cached?.variacoes ?? [], {
        is_combo: false,
        combo_grupos: [],
      });
    },
    [catalogo]
  );

  const loadComboComponenteOpcoesGarcom = React.useCallback(
    async (productId: number) => {
      const res = await fetch(`/api/mesas/produtos-garcom/${productId}/opcoes`, { headers });
      if (!res.ok) return null;
      const data = await res.json();
      const payload = parseOpcoesApiResponse(data);
      opcoesCacheRef.current.set(productId, payload);
      return { grupos_opcao: payload.grupos, variacoes_vendaveis: payload.variacoes };
    },
    [headers]
  );

  // Item confirmado no modal (com grupo/combo escolhidos): lança na comanda
  // já com `variation_id`/`observation`/`selecoes`, igual ao PDV.
  const applyModalItemToPedido = React.useCallback(async (item: ProductOptionsCartItem) => {
    const base = opcaoModalBaseProduct;
    opcaoModalLoadSeqRef.current += 1;
    setCarregandoOpcoesProduto(false);
    setOpcaoModalProduto(null);
    setOpcaoModalBaseProduct(null);
    if (!base || !selectedMesa) return;
    setAdicionando(base.id);
    try {
      const res = await fetch(`/api/mesas/${selectedMesa.id}/comanda/adicionar`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          product_id: item.id,
          product_name: item.name,
          price_at_time: item.preco_final,
          quantity: item.qty,
          variation_id: item.variation_id ?? null,
          observation: item.obs_opcoes?.trim() || undefined,
          selecoes: item.selecoes,
        }),
      });
      if (res.status === 401 || res.status === 403) { setExpired(true); return; }
      if (res.ok) {
        const mesaAberta = { ...selectedMesa, status: 'aberta' as const };
        setSelectedMesa(mesaAberta);
        await fetchComanda(mesaAberta);
      }
    } finally {
      setAdicionando(null);
    }
  }, [opcaoModalBaseProduct, selectedMesa, headers, fetchComanda]);

  const total = itens.reduce((acc, it) => acc + Number(it.price_at_time || 0) * Number(it.quantity || 0), 0);
  const totalComExtras = comandaInfo?.total_com_extras ?? total;
  const totalPago = payments.reduce((acc, p) => acc + p.amount_paid, 0);
  const troco = Math.max(0, totalPago - totalComExtras);
  const faltaPagar = Math.max(0, totalComExtras - totalPago);

  const abrirFecharMesa = () => {
    setFechandoMesa(true);
    setPayments([]);
    setPayMethod('Dinheiro');
    setPayAmount(faltaPagar > 0 ? faltaPagar.toFixed(2) : totalComExtras.toFixed(2));
    setFinalizarErro(null);
  };

  const handleAdicionarPagamento = () => {
    const valor = Number(String(payAmount).replace(',', '.'));
    if (!valor || valor <= 0) return;
    setPayments((prev) => [...prev, { method: payMethod, amount_paid: valor }]);
    const restante = Math.max(0, totalComExtras - (totalPago + valor));
    setPayAmount(restante > 0 ? restante.toFixed(2) : '');
  };

  const handleRemoverPagamento = (index: number) => {
    setPayments((prev) => prev.filter((_, i) => i !== index));
  };

  // Avisa o balcão (quem estiver com o painel de Mesas aberto) que o cliente
  // pediu a conta. Não fecha a mesa nem lança pagamento — só dispara o aviso
  // pra alguém confirmar e imprimir a comanda.
  const handlePedirConta = async () => {
    if (!selectedMesa) return;
    setPedindoConta(true);
    if (contaPedidaTimeoutRef.current) clearTimeout(contaPedidaTimeoutRef.current);
    setContaPedidaMsg(null);
    try {
      const res = await fetch(`/api/mesas/${selectedMesa.id}/solicitar-conta`, { method: 'POST', headers });
      if (res.status === 401 || res.status === 403) { setExpired(true); return; }
      const data = await res.json().catch(() => ({}));
      setContaPedidaMsg(
        res.ok && data?.success ? 'Conta pedida! O balcão foi avisado.' : (data?.message || 'Não foi possível avisar o balcão.')
      );
    } catch {
      setContaPedidaMsg('Erro ao pedir a conta. Tente novamente.');
    } finally {
      setPedindoConta(false);
      contaPedidaTimeoutRef.current = setTimeout(() => setContaPedidaMsg(null), 4000);
    }
  };

  React.useEffect(() => () => {
    if (contaPedidaTimeoutRef.current) clearTimeout(contaPedidaTimeoutRef.current);
  }, []);

  const handleConfirmarFechamento = async () => {
    if (!selectedMesa) return;
    if (totalPago < totalComExtras - 0.01) {
      setFinalizarErro('Informe pagamento suficiente para cobrir o total da mesa.');
      return;
    }
    setFinalizando(true);
    setFinalizarErro(null);
    try {
      const res = await fetch(`/api/mesas/${selectedMesa.id}/comanda/finalizar`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ payments }),
      });
      if (res.status === 401 || res.status === 403) { setExpired(true); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        setFinalizarErro(data?.message || 'Não foi possível fechar a mesa.');
        return;
      }
      setFechandoMesa(false);
      setSelectedMesa(null);
      setPayments([]);
      await fetchMesas();
    } catch {
      setFinalizarErro('Erro ao fechar a mesa. Tente novamente.');
    } finally {
      setFinalizando(false);
    }
  };

  // ── Tela de erro: QR expirado ou inválido ──────────────────────────────
  if (expired) {
    return (
      <div className="min-h-screen w-full bg-zinc-950 flex items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <AlertCircle className="w-12 h-12 text-[#EA1D2C] mx-auto mb-4" />
          <h1 className="text-white text-xl font-black mb-2">QR expirado ou inválido</h1>
          <p className="text-zinc-400 text-sm">
            Peça para o gerente gerar um novo QR do garçom em Mesas → "Gerar QR Garçom".
          </p>
        </div>
      </div>
    );
  }

  // ── Telinha de identificação: escolher o garçom cadastrado + digitar o PIN ──
  if (!sessionChecked) {
    return (
      <div className="min-h-screen w-full bg-zinc-950 flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-zinc-500 animate-spin" />
      </div>
    );
  }

  if (!activeToken || !garcomId) {
    // Passo 1: escolher quem é.
    if (!garcomSelecionado) {
      return (
        <div className="min-h-screen w-full bg-zinc-950 px-6 py-10">
          <h1 className="text-white text-xl font-black mb-1">Quem é você?</h1>
          <p className="text-zinc-500 text-sm mb-6">Toque no seu nome pra abrir mesas e lançar pedidos.</p>

          {carregandoGarcons ? (
            <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-zinc-500 animate-spin" /></div>
          ) : garconsPublico.length === 0 ? (
            <div className="text-center py-10">
              <AlertCircle className="w-8 h-8 text-zinc-600 mx-auto mb-3" />
              <p className="text-zinc-500 text-sm">
                Nenhum garçom cadastrado ainda. Peça pro gerente cadastrar em Mesas → "Cadastrar Garçom".
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {garconsPublico.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => { setGarcomSelecionado(g); setPinInput(''); setLoginErro(null); }}
                  className="flex flex-col items-center gap-2 py-5 rounded-2xl bg-zinc-900 border border-zinc-800 active:scale-95 transition-all"
                >
                  <span className="w-11 h-11 rounded-full bg-[#EA1D2C]/15 text-[#EA1D2C] flex items-center justify-center">
                    <User className="w-5 h-5" />
                  </span>
                  <span className="text-white text-sm font-bold truncate max-w-full px-2">{g.nome}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      );
    }

    // Passo 2: teclado de PIN.
    return (
      <div className="min-h-screen w-full bg-zinc-950 flex flex-col items-center justify-center px-6">
        <button
          type="button"
          onClick={() => { setGarcomSelecionado(null); setPinInput(''); setLoginErro(null); }}
          className="absolute top-6 left-6 w-9 h-9 flex items-center justify-center rounded-full bg-zinc-900 text-zinc-300"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>

        <span className="w-14 h-14 rounded-full bg-[#EA1D2C]/15 text-[#EA1D2C] flex items-center justify-center mb-3">
          <User className="w-6 h-6" />
        </span>
        <h1 className="text-white text-lg font-black mb-1">{garcomSelecionado.nome}</h1>
        <p className="text-zinc-500 text-sm mb-6">Digite seu PIN</p>

        <div className="flex items-center gap-3 mb-2">
          {Array.from({ length: Math.max(4, pinInput.length) }).map((_, i) => (
            <span
              key={i}
              className={`w-3.5 h-3.5 rounded-full border-2 ${
                i < pinInput.length ? 'bg-[#EA1D2C] border-[#EA1D2C]' : 'border-zinc-700'
              }`}
            />
          ))}
        </div>

        {loginErro && <p className="text-[#EA1D2C] text-sm mb-2">{loginErro}</p>}
        {logando && <Loader2 className="w-4 h-4 text-zinc-500 animate-spin mb-2" />}

        <div className="grid grid-cols-3 gap-3 mt-4 w-full max-w-[280px]">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => handleDigitoPin(d)}
              disabled={logando}
              className="h-16 rounded-2xl bg-zinc-900 border border-zinc-800 text-white text-xl font-bold active:scale-95 disabled:opacity-50"
            >
              {d}
            </button>
          ))}
          <div />
          <button
            type="button"
            onClick={() => handleDigitoPin('0')}
            disabled={logando}
            className="h-16 rounded-2xl bg-zinc-900 border border-zinc-800 text-white text-xl font-bold active:scale-95 disabled:opacity-50"
          >
            0
          </button>
          <button
            type="button"
            onClick={handleApagarPin}
            disabled={logando}
            className="h-16 rounded-2xl bg-zinc-900 border border-zinc-800 text-zinc-400 flex items-center justify-center active:scale-95 disabled:opacity-50"
          >
            <Delete className="w-5 h-5" />
          </button>
        </div>
      </div>
    );
  }

  // ── Painel de fechamento de mesa (forma de pagamento) ───────────────────
  if (selectedMesa && fechandoMesa) {
    return (
      <div className="min-h-screen w-full bg-zinc-950 flex flex-col">
        <div className="sticky top-0 z-10 bg-zinc-950 border-b border-zinc-800 px-4 py-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setFechandoMesa(false)}
            className="w-9 h-9 flex items-center justify-center rounded-full bg-zinc-900 text-zinc-300"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="text-white font-black text-lg leading-none">Fechar Mesa {selectedMesa.numero}</h1>
            <p className="text-zinc-500 text-xs mt-1">Escolha a forma de pagamento</p>
          </div>
        </div>

        <div className="px-4 py-4 space-y-4 flex-1 overflow-y-auto">
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-zinc-400">Total da mesa</span>
              <span className="text-white font-black text-lg">{fmtBRL(totalComExtras)}</span>
            </div>
          </div>

          <div>
            <p className="text-zinc-500 text-[11px] font-bold uppercase tracking-wider mb-2">Forma de pagamento</p>
            <div className="grid grid-cols-4 gap-2 mb-3">
              {PAYMENT_METHODS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setPayMethod(m)}
                  className={`h-11 rounded-xl text-xs font-bold border transition-colors
                    ${payMethod === m
                      ? 'bg-[#EA1D2C] border-[#EA1D2C] text-white'
                      : 'bg-zinc-900 border-zinc-800 text-zinc-400'}`}
                >
                  {m}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 text-sm">R$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  placeholder="0,00"
                  className="w-full h-12 pl-9 pr-3 rounded-xl bg-zinc-900 border border-zinc-800 text-white text-sm
                             focus:outline-none focus:border-[#EA1D2C]/60"
                />
              </div>
              <button
                type="button"
                onClick={handleAdicionarPagamento}
                className="h-12 px-4 rounded-xl bg-zinc-800 text-white text-xs font-bold uppercase tracking-wide"
              >
                Adicionar
              </button>
            </div>
          </div>

          {payments.length > 0 && (
            <div className="space-y-1.5">
              {payments.map((p, i) => (
                <div key={i} className="flex items-center justify-between text-sm bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2">
                  <span className="text-zinc-300 font-semibold">{p.method}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-white font-bold">{fmtBRL(p.amount_paid)}</span>
                    <button type="button" onClick={() => handleRemoverPagamento(i)} className="text-zinc-500 hover:text-[#EA1D2C]">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 space-y-1.5 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">Total pago</span>
              <span className="text-white font-bold">{fmtBRL(totalPago)}</span>
            </div>
            {faltaPagar > 0 ? (
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Falta</span>
                <span className="text-amber-500 font-bold">{fmtBRL(faltaPagar)}</span>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Troco</span>
                <span className="text-emerald-500 font-bold">{fmtBRL(troco)}</span>
              </div>
            )}
          </div>

          {finalizarErro && (
            <p className="text-[#EA1D2C] text-sm">{finalizarErro}</p>
          )}
        </div>

        <div className="px-4 py-4 border-t border-zinc-800">
          <button
            type="button"
            onClick={handleConfirmarFechamento}
            disabled={finalizando || totalPago < totalComExtras - 0.01}
            className="w-full h-13 py-3.5 rounded-2xl bg-[#EA1D2C] hover:bg-[#C9101E] text-white font-black text-sm uppercase tracking-wider disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {finalizando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {finalizando ? 'Fechando…' : 'Confirmar fechamento'}
          </button>
        </div>
      </div>
    );
  }

  // ── Tela de detalhe da mesa ─────────────────────────────────────────────
  if (selectedMesa) {
    return (
      <>
      <div className="min-h-screen w-full bg-zinc-950 flex flex-col">
        <div className="sticky top-0 z-10 bg-zinc-950 border-b border-zinc-800 px-4 py-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setSelectedMesa(null)}
            className="w-9 h-9 flex items-center justify-center rounded-full bg-zinc-900 text-zinc-300"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-white font-black text-lg leading-none">Mesa {selectedMesa.numero}</h1>
            <p className="text-zinc-500 text-xs mt-1">
              {selectedMesa.status === 'aberta' ? 'Aberta' : 'Fechada — abra para lançar pedidos'}
            </p>
          </div>
          {selectedMesa.status === 'aberta' && itens.length > 0 && (
            <div className="shrink-0 flex items-center gap-2">
              <button
                type="button"
                onClick={handlePedirConta}
                disabled={pedindoConta}
                className="h-9 px-3 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-bold uppercase tracking-wide flex items-center gap-1.5 disabled:opacity-50"
              >
                {pedindoConta ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />}
                Pedir conta
              </button>
              <button
                type="button"
                onClick={abrirFecharMesa}
                className="h-9 px-3 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold uppercase tracking-wide flex items-center gap-1.5"
              >
                <Wallet className="w-3.5 h-3.5" />
                Fechar mesa
              </button>
            </div>
          )}
        </div>

        {contaPedidaMsg && (
          <div className="px-4 py-2 bg-zinc-900 border-b border-zinc-800">
            <p className="text-xs text-zinc-300">{contaPedidaMsg}</p>
          </div>
        )}

        {selectedMesa.status !== 'aberta' ? (
          <div className="flex-1 flex items-center justify-center px-6">
            <button
              type="button"
              onClick={() => handleAbrirMesa(selectedMesa)}
              disabled={abrindo}
              className="px-8 py-4 rounded-2xl bg-[#EA1D2C] hover:bg-[#C9101E] text-white font-black text-sm uppercase tracking-wider disabled:opacity-50"
            >
              {abrindo ? 'Abrindo…' : 'Abrir mesa'}
            </button>
          </div>
        ) : (
          <>
            {/* Comanda atual */}
            <div className="px-4 py-3 border-b border-zinc-800">
              <p className="text-zinc-500 text-[11px] font-bold uppercase tracking-wider mb-2">Comanda atual</p>
              {loadingComanda ? (
                <Loader2 className="w-4 h-4 text-zinc-500 animate-spin" />
              ) : itens.length === 0 ? (
                <p className="text-zinc-600 text-sm">Nenhum item lançado ainda.</p>
              ) : (
                <div className="space-y-1.5">
                  {itens.map((it) => (
                    <div key={it.id} className="flex items-start justify-between text-sm gap-2">
                      <div className="min-w-0">
                        <span className="text-zinc-300 block truncate">{it.quantity}x {it.product_name}</span>
                        {it.observation && (
                          <span className="text-zinc-500 text-xs block leading-snug mt-0.5 whitespace-pre-line">
                            {it.observation}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-zinc-400">{fmtBRL(it.price_at_time * it.quantity)}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoverItem(it)}
                          disabled={removendo === it.id}
                          aria-label={`Remover ${it.product_name}`}
                          className="w-6 h-6 flex items-center justify-center rounded-full bg-zinc-800 text-zinc-400 hover:text-[#EA1D2C] hover:bg-zinc-800/80 disabled:opacity-50"
                        >
                          {removendo === it.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center justify-between text-sm font-bold pt-1.5 border-t border-zinc-800 mt-1.5">
                    <span className="text-white">Total</span>
                    <span className="text-[#EA1D2C]">{fmtBRL(totalComExtras)}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Busca de produtos */}
            <div className="px-4 py-3">
              <div className="relative">
                <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={qProduto}
                  onChange={(e) => setQProduto(e.target.value)}
                  placeholder="Buscar produto para adicionar…"
                  className="w-full h-11 pl-9 pr-3 rounded-xl bg-zinc-900 border border-zinc-800 text-white
                             placeholder-zinc-600 text-sm focus:outline-none focus:border-[#EA1D2C]/60"
                />
              </div>

              {categorias.length > 1 && (
                <div className="flex gap-2 overflow-x-auto mt-3 pb-1 -mx-4 px-4">
                  {categorias.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setCategoriaAtiva(cat)}
                      className={`shrink-0 px-3 h-8 rounded-full text-xs font-bold uppercase tracking-wide whitespace-nowrap border transition-colors
                        ${categoriaAtiva === cat
                          ? 'bg-[#EA1D2C] border-[#EA1D2C] text-white'
                          : 'bg-zinc-900 border-zinc-800 text-zinc-400'}`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-4 pb-6 space-y-2">
              {catalogoCarregando && <Loader2 className="w-4 h-4 text-zinc-500 animate-spin" />}
              {!catalogoCarregando && produtos.length === 0 && (
                <p className="text-zinc-600 text-sm">Nenhum produto encontrado.</p>
              )}
              {produtos.map((p) => {
                const q = qty[p.id] || 1;
                return (
                  <div key={p.id} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-zinc-900 border border-zinc-800">
                    <div className="min-w-0">
                      <p className="text-white text-sm font-semibold truncate flex items-center gap-1.5">
                        {p.name}
                        {p.tem_opcoes && (
                          <span
                            title="Tem opções/adicionais"
                            className="shrink-0 w-4 h-4 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center"
                          >
                            <Sparkles className="w-2.5 h-2.5" />
                          </span>
                        )}
                      </p>
                      <p className="text-zinc-500 text-xs">{fmtBRL(p.price)}</p>
                    </div>
                    {p.tem_opcoes ? (
                      <button
                        type="button"
                        onClick={() => openProductCustomizeFlow(p)}
                        disabled={adicionando === p.id}
                        className="shrink-0 px-3 h-8 rounded-full bg-[#EA1D2C] hover:bg-[#C9101E] text-white text-xs font-bold disabled:opacity-50"
                      >
                        {adicionando === p.id ? '...' : 'Ver opções'}
                      </button>
                    ) : (
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => setQty((prev) => ({ ...prev, [p.id]: Math.max(1, (prev[p.id] || 1) - 1) }))}
                          className="w-7 h-7 flex items-center justify-center rounded-full bg-zinc-800 text-zinc-300"
                        >
                          <Minus className="w-3.5 h-3.5" />
                        </button>
                        <span className="text-white text-sm font-bold w-4 text-center">{q}</span>
                        <button
                          type="button"
                          onClick={() => setQty((prev) => ({ ...prev, [p.id]: (prev[p.id] || 1) + 1 }))}
                          className="w-7 h-7 flex items-center justify-center rounded-full bg-zinc-800 text-zinc-300"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAdicionar(p)}
                          disabled={adicionando === p.id}
                          className="px-3 h-7 rounded-full bg-[#EA1D2C] hover:bg-[#C9101E] text-white text-xs font-bold disabled:opacity-50"
                        >
                          {adicionando === p.id ? '...' : 'Add'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {opcaoModalProduto && (
        <POSProductOptionsDialog
          produto={opcaoModalProduto}
          carregandoOpcoes={carregandoOpcoesProduto}
          onClose={closeOpcaoModal}
          onAdicionar={applyModalItemToPedido}
          resolveComboComponente={resolveComboComponenteGarcom}
          loadComboComponenteOpcoes={loadComboComponenteOpcoesGarcom}
          themeMode="light_red"
        />
      )}
      </>
    );
  }

  // ── Lista de mesas ──────────────────────────────────────────────────────
  return (
    <div className="min-h-screen w-full bg-zinc-950 px-4 py-6">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-white text-xl font-black">Mesas</h1>
        <button type="button" onClick={handleTrocarUsuario} className="text-zinc-500 text-xs underline decoration-dotted">
          Olá, {garcomNome} · trocar
        </button>
      </div>
      <p className="text-zinc-500 text-sm mb-5">Toque em uma mesa para abrir ou lançar pedidos.</p>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-zinc-500 animate-spin" /></div>
      ) : mesas.length === 0 ? (
        <p className="text-zinc-600 text-sm">Nenhuma mesa configurada.</p>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {mesas.map((mesa) => (
            <button
              key={mesa.id}
              type="button"
              onClick={() => handleClickMesa(mesa)}
              className={`aspect-square rounded-2xl flex flex-col items-center justify-center gap-1 border transition-all
                ${mesa.status === 'aberta'
                  ? 'bg-[#EA1D2C]/10 border-[#EA1D2C]/40'
                  : 'bg-zinc-900 border-zinc-800'}`}
            >
              <span className="text-white text-2xl font-black">{mesa.numero}</span>
              <span className={`text-[10px] font-bold uppercase tracking-wider ${mesa.status === 'aberta' ? 'text-[#EA1D2C]' : 'text-zinc-500'}`}>
                {mesa.status === 'aberta' ? 'Ocupada' : 'Livre'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
