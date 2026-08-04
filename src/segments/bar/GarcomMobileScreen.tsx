/**
 * GarcomMobileScreen.tsx — tela pública (sem login pessoal) acessada pelo
 * QR temporário gerado em Mesas → "Gerar QR Garçom". Permite abrir mesas e
 * lançar itens na comanda pelo celular do garçom. O token do QR expira
 * sozinho (3h) e o back-end recusa qualquer ação fora desse escopo.
 */

import React from 'react';
import { Search, Plus, Minus, ArrowLeft, AlertCircle, Loader2, Trash2 } from 'lucide-react';

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

type ProdutoHit = {
  id: number;
  name: string;
  price: number;
  category: string;
};

function fmtBRL(n: number) {
  return Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export default function GarcomMobileScreen({ qrToken }: { qrToken: string }) {
  const headers = React.useMemo(
    () => ({ Authorization: `Bearer ${qrToken}`, 'Content-Type': 'application/json' }),
    [qrToken]
  );

  const [mesas, setMesas] = React.useState<Mesa[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [expired, setExpired] = React.useState(false);
  const [selectedMesa, setSelectedMesa] = React.useState<Mesa | null>(null);
  const [itens, setItens] = React.useState<ComandaItem[]>([]);
  const [loadingComanda, setLoadingComanda] = React.useState(false);
  const [abrindo, setAbrindo] = React.useState(false);

  const [qProduto, setQProduto] = React.useState('');
  const [catalogo, setCatalogo] = React.useState<ProdutoHit[]>([]);
  const [catalogoCarregando, setCatalogoCarregando] = React.useState(false);
  const [categoriaAtiva, setCategoriaAtiva] = React.useState('Todas');
  const [adicionando, setAdicionando] = React.useState<number | null>(null);
  const [removendo, setRemovendo] = React.useState<number | null>(null);
  const [qty, setQty] = React.useState<Record<number, number>>({});

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

  React.useEffect(() => { fetchMesas(); }, [fetchMesas]);

  const fetchComanda = React.useCallback(async (mesa: Mesa) => {
    setLoadingComanda(true);
    try {
      const res = await fetch(`/api/mesas/${mesa.id}/comanda`, { headers });
      if (res.status === 401 || res.status === 403) { setExpired(true); return; }
      const data = await res.json();
      setItens(Array.isArray(data?.itens) ? data.itens : []);
    } catch {
      setItens([]);
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

  // ── Tela de detalhe da mesa ─────────────────────────────────────────────
  if (selectedMesa) {
    const total = itens.reduce((acc, it) => acc + Number(it.price_at_time || 0) * Number(it.quantity || 0), 0);
    return (
      <div className="min-h-screen w-full bg-zinc-950 flex flex-col">
        <div className="sticky top-0 z-10 bg-zinc-950 border-b border-zinc-800 px-4 py-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setSelectedMesa(null)}
            className="w-9 h-9 flex items-center justify-center rounded-full bg-zinc-900 text-zinc-300"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="text-white font-black text-lg leading-none">Mesa {selectedMesa.numero}</h1>
            <p className="text-zinc-500 text-xs mt-1">
              {selectedMesa.status === 'aberta' ? 'Aberta' : 'Fechada — abra para lançar pedidos'}
            </p>
          </div>
        </div>

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
                    <div key={it.id} className="flex items-center justify-between text-sm gap-2">
                      <span className="text-zinc-300 min-w-0 truncate">{it.quantity}x {it.product_name}</span>
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
                    <span className="text-[#EA1D2C]">{fmtBRL(total)}</span>
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
                      <p className="text-white text-sm font-semibold truncate">{p.name}</p>
                      <p className="text-zinc-500 text-xs">{fmtBRL(p.price)}</p>
                    </div>
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
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    );
  }

  // ── Lista de mesas ──────────────────────────────────────────────────────
  return (
    <div className="min-h-screen w-full bg-zinc-950 px-4 py-6">
      <h1 className="text-white text-xl font-black mb-1">Mesas</h1>
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
