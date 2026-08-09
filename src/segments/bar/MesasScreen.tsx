import React, { useState, useEffect, useCallback } from 'react';
import {
  TableProperties,
  Settings,
  QrCode,
  Users,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import MesaCard from './MesaCard';
import ComandaMesaModal from './ComandaMesaModal';
import GarcomCadastroModal from './GarcomCadastroModal';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import type { Product, Category, OrderItem, OrderType, PaymentMethod, Order, DashboardStats, CashReport, Expense, Caixa, Ingrediente, MovimentacaoEstoque } from '../../types';

export default function MesasScreen({ token, taxasPagamento }: { token: string; taxasPagamento?: { debito: number; credito: number; pix: number } }) {
  const [mesas, setMesas] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMesa, setSelectedMesa] = useState<any | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [qtdInput, setQtdInput] = useState('');
  const [configLoading, setConfigLoading] = useState(false);
  const [showQrGarcom, setShowQrGarcom] = useState(false);
  const [showGarcons, setShowGarcons] = useState(false);
  const [qrGarcomUrl, setQrGarcomUrl] = useState<string | null>(null);
  const [qrGarcomExpiresAt, setQrGarcomExpiresAt] = useState<number | null>(null);
  const [qrGarcomLoading, setQrGarcomLoading] = useState(false);

  // Os avisos de "pedir a conta" (popup + som) agora são tratados de forma
  // global em App.tsx, pra aparecer em qualquer aba — não só aqui em Mesas.

  const fetchMesas = useCallback(async () => {
    try {
      const res = await fetch('/api/mesas', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      setMesas(Array.isArray(data) ? data : []);
    } catch {
      setMesas([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchMesas(); }, [fetchMesas]);

  const handleAbrirMesa = useCallback(async (mesa: any) => {
    await fetch(`/api/mesas/${mesa.id}/abrir`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` } });
    fetchMesas();
  }, [token, fetchMesas]);

  const handleFecharMesa = useCallback(async (mesa: any) => {
    if (!window.confirm(`Fechar Mesa ${mesa.numero}? Os itens não pagos serão descartados.`)) return;
    await fetch(`/api/mesas/${mesa.id}/fechar`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` } });
    fetchMesas();
  }, [token, fetchMesas]);

  const handleClickMesa = useCallback((mesa: any) => setSelectedMesa(mesa), []);

  const handleConfigurar = async () => {
    const qtd = parseInt(qtdInput);
    if (!qtd || qtd < 1 || qtd > 200) return;
    setConfigLoading(true);
    try {
      await fetch('/api/mesas/configurar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ quantidade: qtd }),
      });
      setShowConfig(false);
      fetchMesas();
    } catch {
      alert('Erro ao configurar mesas');
    } finally {
      setConfigLoading(false);
    }
  };

  const handleGerarQrGarcom = useCallback(async () => {
    setShowQrGarcom(true);
    setQrGarcomLoading(true);
    try {
      const res = await fetch('/api/mesas/gerar-qr-garcom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data?.success) {
        setQrGarcomUrl(data.url);
        setQrGarcomExpiresAt(Date.now() + (data.expires_in_minutes || 360) * 60 * 1000);
      }
    } catch {
      setQrGarcomUrl(null);
    } finally {
      setQrGarcomLoading(false);
    }
  }, [token]);

  const abertas = mesas.filter(m => m.status === 'aberta').length;
  const fechadas = mesas.filter(m => m.status === 'fechada').length;
  const total = mesas.length;
  const taxaOcupacao = total > 0 ? Math.round((abertas / total) * 100) : 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="h-full flex flex-col overflow-hidden"
    >
      {/* Header + Resumo */}
      <div className="p-5 border-b border-zinc-200 flex-shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-xl font-black text-zinc-900">Mesas</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowGarcons(true)}
              className="flex items-center gap-2 px-3 py-2 bg-zinc-900 hover:bg-zinc-800 text-white rounded-lg font-semibold text-sm transition-all active:scale-95"
            >
              <Users size={14} />
              Cadastrar Garçom
            </button>
            <button
              onClick={handleGerarQrGarcom}
              className="flex items-center gap-2 px-3 py-2 bg-[#EA1D2C] hover:bg-[#C9101E] text-white rounded-lg font-semibold text-sm transition-all active:scale-95"
            >
              <QrCode size={14} />
              Gerar QR Garçom
            </button>
            <button
              onClick={() => { setQtdInput(String(mesas.length)); setShowConfig(true); }}
              className="flex items-center gap-2 px-3 py-2 bg-zinc-900 hover:bg-zinc-800 text-white rounded-lg font-semibold text-sm transition-all active:scale-95"
            >
              <Settings size={14} />
              Configurar
            </button>
          </div>
        </div>
        {total > 0 && (
          <div className="flex flex-wrap gap-3 mt-4">
            <div className="flex items-center gap-2 px-4 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl">
              <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Total</span>
              <span className="text-lg font-black text-zinc-900">{total}</span>
            </div>
            <div className="flex items-center gap-2 px-4 py-2.5 bg-red-50 border border-red-100 rounded-xl">
              <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
              <span className="text-[10px] font-bold text-red-600 uppercase tracking-wider">Ocupadas</span>
              <span className="text-lg font-black text-red-700">{abertas}</span>
            </div>
            <div className="flex items-center gap-2 px-4 py-2.5 bg-emerald-50 border border-emerald-100 rounded-xl">
              <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
              <span className="text-[10px] font-bold text-emerald-600 uppercase tracking-wider">Livres</span>
              <span className="text-lg font-black text-emerald-700">{fechadas}</span>
            </div>
            <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-50 border border-amber-100 rounded-xl">
              <span className="text-[10px] font-bold text-amber-600 uppercase tracking-wider">Ocupação</span>
              <span className="text-lg font-black text-amber-700">{taxaOcupacao}%</span>
            </div>
          </div>
        )}
      </div>

      {/* Grid de mesas */}
      <div className="flex-1 overflow-y-auto p-5">
        {loading ? (
          <div className="flex items-center justify-center py-20" role="status" aria-label="Carregando mesas">
            <Spinner className="h-10 w-10" />
          </div>
        ) : mesas.length === 0 ? (
          <div className="flex flex-col items-center">
            <EmptyState
              icon={TableProperties}
              title="Nenhuma mesa configurada"
              description='Use "Configurar" no topo para definir a quantidade de mesas.'
              className="!pb-6"
            />
            <button
              type="button"
              onClick={() => { setQtdInput('10'); setShowConfig(true); }}
              className="mt-2 px-6 py-3 min-h-[44px] bg-zinc-900 text-white rounded-xl font-bold text-sm hover:bg-zinc-800 transition-all"
            >
              Configurar agora
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-3">
            {mesas.map(mesa => (
              <MesaCard
                key={mesa.id}
                mesa={mesa}
                onOpen={handleAbrirMesa}
                onClose={handleFecharMesa}
                onClick={handleClickMesa}
                token={token}
              />
            ))}
          </div>
        )}
      </div>

      {/* Modal de Configuração */}
      <AnimatePresence>
        {showConfig && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-3xl p-8 max-w-sm w-full shadow-2xl"
            >
              <h3 className="text-xl font-black text-zinc-900 mb-1">Configurar Mesas</h3>
              <p className="text-sm text-zinc-500 mb-6">
                {mesas.length > 0 ? `Atualmente: ${mesas.length} mesa(s)` : 'Defina quantas mesas seu estabelecimento tem.'}
              </p>
              <div className="space-y-2 mb-6">
                <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Quantidade de Mesas</label>
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={qtdInput}
                  onChange={e => setQtdInput(e.target.value)}
                  className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl text-lg font-bold text-center focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                  autoFocus
                />
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowConfig(false)}
                  className="flex-1 px-4 py-3 bg-zinc-100 hover:bg-zinc-200 rounded-xl font-semibold text-sm transition-all"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleConfigurar}
                  disabled={configLoading}
                  className="flex-1 px-4 py-3 bg-zinc-900 hover:bg-zinc-800 text-white rounded-xl font-bold text-sm transition-all disabled:opacity-50"
                >
                  {configLoading ? 'Salvando...' : 'Salvar'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Modal de QR do Garçom */}
      <AnimatePresence>
        {showQrGarcom && (
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[200] flex items-center justify-center p-4"
            onClick={() => setShowQrGarcom(false)}
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.92, opacity: 0 }}
              className="bg-white rounded-3xl w-full max-w-sm shadow-2xl p-8 flex flex-col items-center text-center"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-xl font-black text-zinc-900 mb-1">QR do Garçom</h3>
              <p className="text-sm text-zinc-500 mb-5">
                Peça para o garçom escanear com o celular. Ele poderá abrir mesas e lançar
                pedidos direto, sem precisar de login. Válido por 6 horas.
              </p>

              {qrGarcomLoading ? (
                <div className="py-10"><Spinner className="h-10 w-10" /></div>
              ) : qrGarcomUrl ? (
                <>
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(qrGarcomUrl)}&bgcolor=ffffff&color=000000&margin=8`}
                    alt="QR Garçom"
                    className="w-[220px] h-[220px] rounded-2xl border border-zinc-100"
                  />
                  {qrGarcomExpiresAt && (
                    <p className="text-[11px] text-zinc-400 mt-3">
                      Expira às {new Date(qrGarcomExpiresAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={handleGerarQrGarcom}
                    className="mt-4 text-xs font-semibold text-[#EA1D2C] hover:underline"
                  >
                    Gerar novo QR
                  </button>
                </>
              ) : (
                <p className="text-sm text-red-500 py-6">Não foi possível gerar o QR. Tente novamente.</p>
              )}

              <button
                onClick={() => setShowQrGarcom(false)}
                className="mt-6 w-full px-4 py-3 bg-zinc-100 hover:bg-zinc-200 rounded-xl font-semibold text-sm transition-all"
              >
                Fechar
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Modal de Cadastro de Garçons */}
      {showGarcons && (
        <GarcomCadastroModal token={token} onClose={() => setShowGarcons(false)} />
      )}

      {/* Modal de Comanda da Mesa */}
      <AnimatePresence>
        {selectedMesa && (
          <ComandaMesaModal
            mesa={selectedMesa}
            token={token}
            taxasPagamento={taxasPagamento}
            onClose={() => { setSelectedMesa(null); fetchMesas(); }}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── CARD DE MESA ─────────────────────────────────────────────────────────────