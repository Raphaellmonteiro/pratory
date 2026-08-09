import React, { useState, useEffect, useCallback } from 'react';
import { X, Plus, Trash2, Pencil, Check, Users, Percent, Calendar } from 'lucide-react';
import { motion } from 'motion/react';
import { Spinner } from '../../components/ui/Spinner';

type Garcom = {
  id: number;
  nome: string;
  ativo: number;
  pin_configurado: boolean;
  taxa_percentual_override: number | null;
};

type RelatorioTaxas = {
  modo_divisao: 'individual' | 'geral';
  total_taxa_servico: number;
  total_comandas: number;
  divisao_geral_por_garcom: number;
  por_garcom: { garcom_id: number | null; garcom_nome: string; total_taxa: number; qtd_comandas: number }[];
  garcons_ativos: { id: number; nome: string; taxa_percentual_override: number | null }[];
};

function fmtBRL(n: number) {
  return Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function hojeISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function primeiroDiaMesISO() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

export default function GarcomCadastroModal({ token, onClose }: { token: string; onClose: () => void }) {
  const [aba, setAba] = useState<'garcons' | 'relatorio'>('garcons');

  // ── Cadastro de garçons ───────────────────────────────────────────────
  const [garcons, setGarcons] = useState<Garcom[]>([]);
  const [loading, setLoading] = useState(true);
  const [editandoId, setEditandoId] = useState<number | 'novo' | null>(null);
  const [formNome, setFormNome] = useState('');
  const [formPin, setFormPin] = useState('');
  const [formTaxa, setFormTaxa] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const fetchGarcons = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/mesas/garcons', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      setGarcons(Array.isArray(data?.garcons) ? data.garcons : []);
    } catch {
      setGarcons([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchGarcons(); }, [fetchGarcons]);

  const abrirNovo = () => {
    setEditandoId('novo');
    setFormNome('');
    setFormPin('');
    setFormTaxa('');
    setErro(null);
  };

  const abrirEdicao = (g: Garcom) => {
    setEditandoId(g.id);
    setFormNome(g.nome);
    setFormPin('');
    setFormTaxa(g.taxa_percentual_override != null ? String(g.taxa_percentual_override) : '');
    setErro(null);
  };

  const cancelarForm = () => {
    setEditandoId(null);
    setErro(null);
  };

  const handleSalvar = async () => {
    setErro(null);
    const nome = formNome.trim();
    if (!nome) { setErro('Informe o nome do garçom.'); return; }
    if (editandoId === 'novo' && !/^\d{4,6}$/.test(formPin.trim())) {
      setErro('O PIN deve ter de 4 a 6 números.');
      return;
    }
    if (formPin.trim() && !/^\d{4,6}$/.test(formPin.trim())) {
      setErro('O PIN deve ter de 4 a 6 números.');
      return;
    }
    setSalvando(true);
    try {
      const payload: any = {
        nome,
        taxa_percentual_override: formTaxa.trim() === '' ? null : Number(formTaxa.replace(',', '.')),
      };
      if (formPin.trim()) payload.pin = formPin.trim();

      const isNovo = editandoId === 'novo';
      const res = await fetch(isNovo ? '/api/mesas/garcons' : `/api/mesas/garcons/${editandoId}`, {
        method: isNovo ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        setErro(data?.message || 'Não foi possível salvar.');
        return;
      }
      setEditandoId(null);
      await fetchGarcons();
    } catch {
      setErro('Erro ao salvar. Tente novamente.');
    } finally {
      setSalvando(false);
    }
  };

  const handleToggleAtivo = async (g: Garcom) => {
    await fetch(`/api/mesas/garcons/${g.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ativo: g.ativo ? 0 : 1 }),
    });
    fetchGarcons();
  };

  const handleRemover = async (g: Garcom) => {
    if (!window.confirm(`Desativar o garçom "${g.nome}"? Ele não vai mais aparecer na lista de login do QR.`)) return;
    await fetch(`/api/mesas/garcons/${g.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    fetchGarcons();
  };

  // ── Relatório de divisão da taxa de serviço ───────────────────────────
  const [inicio, setInicio] = useState(hojeISO());
  const [fim, setFim] = useState(hojeISO());
  const [relatorio, setRelatorio] = useState<RelatorioTaxas | null>(null);
  const [carregandoRelatorio, setCarregandoRelatorio] = useState(false);
  const [salvandoModo, setSalvandoModo] = useState(false);

  const fetchRelatorio = useCallback(async () => {
    setCarregandoRelatorio(true);
    try {
      const res = await fetch(`/api/mesas/garcons/relatorio-taxas?inicio=${inicio}&fim=${fim}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setRelatorio(data?.success ? data : null);
    } catch {
      setRelatorio(null);
    } finally {
      setCarregandoRelatorio(false);
    }
  }, [token, inicio, fim]);

  useEffect(() => { if (aba === 'relatorio') fetchRelatorio(); }, [aba, fetchRelatorio]);

  const handleMudarModo = async (modo: 'individual' | 'geral') => {
    if (!relatorio || relatorio.modo_divisao === modo) return;
    setSalvandoModo(true);
    try {
      await fetch('/api/mesas/garcons/config-divisao', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ modo }),
      });
      await fetchRelatorio();
    } finally {
      setSalvandoModo(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-3xl w-full max-w-2xl max-h-[85vh] shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between px-6 py-5 border-b border-zinc-100 shrink-0">
          <div>
            <h3 className="text-xl font-black text-zinc-900">Garçons</h3>
            <p className="text-sm text-zinc-500">Cadastro, PIN de acesso e taxa de serviço</p>
          </div>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center rounded-full bg-zinc-100 hover:bg-zinc-200 transition-all">
            <X size={16} />
          </button>
        </div>

        <div className="flex gap-1 px-6 pt-4 shrink-0">
          <button
            type="button"
            onClick={() => setAba('garcons')}
            className={`px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wide transition-all ${
              aba === 'garcons' ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-500'
            }`}
          >
            <Users size={12} className="inline mr-1.5 -mt-0.5" />
            Cadastro
          </button>
          <button
            type="button"
            onClick={() => setAba('relatorio')}
            className={`px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wide transition-all ${
              aba === 'relatorio' ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-500'
            }`}
          >
            <Percent size={12} className="inline mr-1.5 -mt-0.5" />
            Taxa de serviço
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {aba === 'garcons' ? (
            <>
              {loading ? (
                <div className="flex justify-center py-10"><Spinner className="h-8 w-8" /></div>
              ) : (
                <div className="space-y-2 mb-4">
                  {garcons.length === 0 && editandoId === null && (
                    <p className="text-sm text-zinc-500 py-4 text-center">Nenhum garçom cadastrado ainda.</p>
                  )}
                  {garcons.map((g) => (
                    <div
                      key={g.id}
                      className={`flex items-center justify-between gap-3 p-3 rounded-xl border ${
                        g.ativo ? 'bg-zinc-50 border-zinc-200' : 'bg-zinc-50/50 border-zinc-100 opacity-60'
                      }`}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-zinc-900 truncate">{g.nome}</p>
                        <p className="text-xs text-zinc-500">
                          {g.pin_configurado ? 'PIN configurado' : 'Sem PIN'}
                          {g.taxa_percentual_override != null ? ` · Taxa: ${g.taxa_percentual_override}%` : ' · Taxa: divisão geral'}
                          {!g.ativo ? ' · Inativo' : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => abrirEdicao(g)}
                          className="w-8 h-8 flex items-center justify-center rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-600"
                          title="Editar"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleAtivo(g)}
                          className={`px-2.5 h-8 rounded-lg text-[11px] font-bold ${
                            g.ativo ? 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100' : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200'
                          }`}
                        >
                          {g.ativo ? 'Ativo' : 'Reativar'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemover(g)}
                          className="w-8 h-8 flex items-center justify-center rounded-lg bg-red-50 hover:bg-red-100 text-red-500"
                          title="Desativar"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {editandoId !== null ? (
                <div className="p-4 rounded-2xl bg-zinc-50 border border-zinc-200 space-y-3">
                  <p className="text-sm font-bold text-zinc-900">
                    {editandoId === 'novo' ? 'Novo garçom' : 'Editar garçom'}
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">Nome</label>
                      <input
                        type="text"
                        value={formNome}
                        onChange={(e) => setFormNome(e.target.value)}
                        placeholder="Ex.: Maria"
                        maxLength={60}
                        className="w-full mt-1 px-3 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">
                        {editandoId === 'novo' ? 'PIN (4 a 6 números)' : 'Novo PIN (opcional)'}
                      </label>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={formPin}
                        onChange={(e) => setFormPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder={editandoId === 'novo' ? '••••' : 'Deixe em branco p/ manter'}
                        className="w-full mt-1 px-3 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">
                      Taxa de serviço individual (%) — opcional
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={formTaxa}
                      onChange={(e) => setFormTaxa(e.target.value.replace(/[^0-9,.]/g, ''))}
                      placeholder="Deixe em branco para usar a divisão geral"
                      className="w-full mt-1 px-3 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    />
                    <p className="text-[11px] text-zinc-400 mt-1">
                      Só preencha se esse garçom tiver um percentual diferente combinado. Sem isso, ele entra na divisão geral configurada na aba "Taxa de serviço".
                    </p>
                  </div>

                  {erro && <p className="text-sm text-red-500">{erro}</p>}

                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      onClick={cancelarForm}
                      className="flex-1 px-4 py-2.5 bg-zinc-100 hover:bg-zinc-200 rounded-xl font-semibold text-sm transition-all"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      onClick={handleSalvar}
                      disabled={salvando}
                      className="flex-1 px-4 py-2.5 bg-[#EA1D2C] hover:bg-[#C9101E] text-white rounded-xl font-bold text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      {salvando ? 'Salvando...' : (<><Check size={14} /> Salvar</>)}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={abrirNovo}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-zinc-900 hover:bg-zinc-800 text-white rounded-xl font-bold text-sm transition-all"
                >
                  <Plus size={14} />
                  Cadastrar Garçom
                </button>
              )}
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-3 mb-5">
                <div>
                  <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider flex items-center gap-1">
                    <Calendar size={11} /> De
                  </label>
                  <input
                    type="date"
                    value={inicio}
                    onChange={(e) => setInicio(e.target.value)}
                    className="mt-1 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">Até</label>
                  <input
                    type="date"
                    value={fim}
                    onChange={(e) => setFim(e.target.value)}
                    className="mt-1 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => { setInicio(hojeISO()); setFim(hojeISO()); }}
                  className="px-3 py-2 bg-zinc-100 hover:bg-zinc-200 rounded-lg text-xs font-bold"
                >
                  Hoje
                </button>
                <button
                  type="button"
                  onClick={() => { setInicio(primeiroDiaMesISO()); setFim(hojeISO()); }}
                  className="px-3 py-2 bg-zinc-100 hover:bg-zinc-200 rounded-lg text-xs font-bold"
                >
                  Este mês
                </button>
                <button
                  type="button"
                  onClick={fetchRelatorio}
                  className="px-3 py-2 bg-zinc-900 hover:bg-zinc-800 text-white rounded-lg text-xs font-bold"
                >
                  Filtrar
                </button>
              </div>

              {carregandoRelatorio ? (
                <div className="flex justify-center py-10"><Spinner className="h-8 w-8" /></div>
              ) : !relatorio ? (
                <p className="text-sm text-zinc-500 py-6 text-center">Não foi possível carregar o relatório.</p>
              ) : (
                <>
                  <div className="p-4 rounded-2xl bg-zinc-50 border border-zinc-200 mb-4">
                    <p className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Como dividir a taxa de serviço?</p>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => handleMudarModo('individual')}
                        disabled={salvandoModo}
                        className={`px-3 py-3 rounded-xl text-left border transition-all disabled:opacity-50 ${
                          relatorio.modo_divisao === 'individual'
                            ? 'bg-[#EA1D2C]/10 border-[#EA1D2C]/40'
                            : 'bg-white border-zinc-200'
                        }`}
                      >
                        <p className="text-sm font-bold text-zinc-900">Individual</p>
                        <p className="text-[11px] text-zinc-500 mt-0.5">Cada garçom fica com a taxa das mesas que ele fechou.</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMudarModo('geral')}
                        disabled={salvandoModo}
                        className={`px-3 py-3 rounded-xl text-left border transition-all disabled:opacity-50 ${
                          relatorio.modo_divisao === 'geral'
                            ? 'bg-[#EA1D2C]/10 border-[#EA1D2C]/40'
                            : 'bg-white border-zinc-200'
                        }`}
                      >
                        <p className="text-sm font-bold text-zinc-900">Geral (dividir igual)</p>
                        <p className="text-[11px] text-zinc-500 mt-0.5">Soma tudo e divide igualmente entre os garçons ativos.</p>
                      </button>
                    </div>
                  </div>

                  <div className="flex gap-3 mb-4">
                    <div className="flex-1 p-4 rounded-2xl bg-zinc-900 text-white">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">Total arrecadado</p>
                      <p className="text-2xl font-black mt-1">{fmtBRL(relatorio.total_taxa_servico)}</p>
                      <p className="text-[11px] text-zinc-400 mt-0.5">{relatorio.total_comandas} comanda(s) fechada(s)</p>
                    </div>
                    {relatorio.modo_divisao === 'geral' && (
                      <div className="flex-1 p-4 rounded-2xl bg-emerald-50 border border-emerald-100">
                        <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-600">Por garçom (dividido igual)</p>
                        <p className="text-2xl font-black mt-1 text-emerald-700">{fmtBRL(relatorio.divisao_geral_por_garcom)}</p>
                        <p className="text-[11px] text-emerald-600/70 mt-0.5">{relatorio.garcons_ativos.length} garçom(ns) ativo(s)</p>
                      </div>
                    )}
                  </div>

                  <p className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">
                    {relatorio.modo_divisao === 'individual' ? 'Quanto cada garçom arrecadou' : 'Valor a pagar por garçom'}
                  </p>
                  <div className="space-y-1.5">
                    {relatorio.modo_divisao === 'individual' ? (
                      relatorio.por_garcom.length === 0 ? (
                        <p className="text-sm text-zinc-400 py-3">Nenhuma comanda fechada no período.</p>
                      ) : (
                        relatorio.por_garcom.map((r) => (
                          <div key={`${r.garcom_id}-${r.garcom_nome}`} className="flex items-center justify-between px-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl">
                            <div>
                              <p className="text-sm font-semibold text-zinc-900">{r.garcom_nome}</p>
                              <p className="text-[11px] text-zinc-500">{r.qtd_comandas} mesa(s) fechada(s)</p>
                            </div>
                            <span className="text-sm font-black text-zinc-900">{fmtBRL(r.total_taxa)}</span>
                          </div>
                        ))
                      )
                    ) : (
                      relatorio.garcons_ativos.length === 0 ? (
                        <p className="text-sm text-zinc-400 py-3">Nenhum garçom ativo cadastrado.</p>
                      ) : (
                        relatorio.garcons_ativos.map((g) => (
                          <div key={g.id} className="flex items-center justify-between px-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl">
                            <p className="text-sm font-semibold text-zinc-900">{g.nome}</p>
                            <span className="text-sm font-black text-zinc-900">
                              {fmtBRL(relatorio.divisao_geral_por_garcom)}
                            </span>
                          </div>
                        ))
                      )
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}
