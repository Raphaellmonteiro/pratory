import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { getSegCfg } from '../config/segmentos';
import {
  TrendingUp, TrendingDown, DollarSign, ShoppingBag,
  BarChart2, CreditCard, Banknote, Smartphone,
  Package, AlertTriangle, RefreshCw, ArrowUpRight, ArrowDownRight,
} from 'lucide-react';

// ─── Tipos locais ─────────────────────────────────────────────────────────────
interface WeeklyDay { dia: string; label: string; total: number; pedidos: number; }

interface Stats {
  filteredTotal: number;
  today: number;
  week: number;
  month: number;
  totalExpenses: number;
  totalRefunded?: number;
  netRevenue?: number;
  totalRepassesPagos: number;
  productSales: { name: string; quantity: number; total: number }[];
  ticketMedio: number;
  totalPedidos: number;
}
interface CashReport {
  total: number;
  cash: number;
  pix: number;
  debit: number;
  credit: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt = (v: number) => `R$ ${(v || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

export default function DashboardScreen({
  token, segmento, onGoToPOS,
}: { token: string; segmento: string; onGoToPOS: () => void }) {
  const cfg = getSegCfg(segmento);
  const [stats, setStats]       = useState<Stats | null>(null);
  const [weeklyData, setWeeklyData] = useState<WeeklyDay[]>([]);
  const [cashReport, setCashReport] = useState<CashReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [filterType, setFilterType] = useState<'day' | 'month' | 'year'>('day');
  const _ld = new Date();
  const todayStr = `${_ld.getFullYear()}-${String(_ld.getMonth()+1).padStart(2,'0')}-${String(_ld.getDate()).padStart(2,'0')}`;
  const [selectedDate, setSelectedDate] = useState(todayStr);
  const [selectedMonth, setSelectedMonth] = useState((new Date().getMonth() + 1).toString());
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear().toString());
  const anoAtual = new Date().getFullYear();
  const anos = Array.from({ length: anoAtual - 2022 }, (_, i) => 2023 + i);
  const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

  const fetchAll = async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    try {
      let q = '';
      if (filterType === 'day') {
        const [y, m, d] = selectedDate.split('-');
        q = `?day=${d}&month=${m}&year=${y}`;
      } else if (filterType === 'month') {
        q = `?month=${selectedMonth}&year=${selectedYear}`;
      } else {
        q = `?year=${selectedYear}`;
      }
      const hdrs = { Authorization: `Bearer ${token}` };
      const [sRes, wRes, cRes] = await Promise.all([
        fetch(`/api/dashboard/stats${q}`, { headers: hdrs }),
        fetch('/api/dashboard/weekly', { headers: hdrs }),
        fetch(`/api/dashboard/cash-report${q}`, { headers: hdrs }),
      ]);

      // Parseia cada resposta individualmente — uma falha não derruba as demais
      const safeJson = async (r: Response) => {
        try { return r.ok ? await r.json() : null; } catch { return null; }
      };
      const [s, w, c] = await Promise.all([safeJson(sRes), safeJson(wRes), safeJson(cRes)]);

      if (s) setStats(s);
      if (Array.isArray(w)) setWeeklyData(w);
      if (c) setCashReport(c);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { fetchAll(); }, [filterType, selectedDate, selectedMonth, selectedYear]);

  if (loading) return (
    <div className="h-full flex items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 border-2 border-zinc-300 dark:border-zinc-700 border-t-zinc-900 dark:border-t-zinc-400 rounded-full animate-spin" />
        <p className="text-sm text-zinc-500 font-medium">Carregando dashboard...</p>
      </div>
    </div>
  );

  const receitaOperacional = stats?.filteredTotal || 0;
  const totalRefunded = stats?.totalRefunded || 0;
  const receitaLiquida = stats?.netRevenue ?? (receitaOperacional - totalRefunded);
  const lucro = receitaLiquida - (stats?.totalExpenses || 0) - (stats?.totalRepassesPagos || 0);
  const margem = receitaLiquida ? (lucro / receitaLiquida) * 100 : 0;
  const totalPagamentos = cashReport ? (cashReport.cash + cashReport.pix + cashReport.debit + cashReport.credit) : 0;
  const paymentMethods = [
    { label: 'Dinheiro', value: cashReport?.cash || 0, icon: <Banknote size={16} />, color: 'bg-emerald-500' },
    { label: 'PIX', value: cashReport?.pix || 0, icon: <Smartphone size={16} />, color: 'bg-red-500' },
    { label: 'Débito', value: cashReport?.debit || 0, icon: <CreditCard size={16} />, color: 'bg-zinc-700' },
    { label: 'Crédito', value: cashReport?.credit || 0, icon: <CreditCard size={16} />, color: 'bg-amber-500' },
  ];
  const dominantPayment = paymentMethods.reduce((acc, method) => method.value > acc.value ? method : acc, paymentMethods[0]);

  const periodoLabel =
    filterType === 'day' ? new Date(selectedDate + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })
    : filterType === 'month' ? `${meses[Number(selectedMonth)-1]} ${selectedYear}`
    : `Ano ${selectedYear}`;

  const panelClass = 'rounded-[24px] border border-zinc-200/90 bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.06)] transition-all hover:shadow-[0_14px_34px_rgba(15,23,42,0.08)] dark:bg-zinc-900 dark:border-zinc-800';
  const softSurfaceClass = 'rounded-2xl border border-zinc-200/80 bg-zinc-50/80 dark:bg-zinc-800 dark:border-zinc-700';
  const kpiTicketMedio = stats?.ticketMedio || (stats?.totalPedidos ? (receitaOperacional / stats.totalPedidos) : 0);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="h-full overflow-y-auto bg-zinc-50 dark:bg-zinc-950"
    >
      <div className="max-w-7xl mx-auto p-3 sm:p-5 lg:p-6 space-y-4 sm:space-y-5">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 sm:gap-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-red-600/80 dark:text-red-400">Visao geral</p>
            <h1 className="text-2xl sm:text-[30px] font-black text-zinc-900 dark:text-zinc-100 tracking-tight">Dashboard</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 capitalize font-medium">{periodoLabel}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Filtro tipo */}
            <div className="flex bg-white dark:bg-zinc-900 border border-zinc-200/90 dark:border-zinc-800 rounded-2xl p-1 gap-1 shadow-sm">
              {(['day','month','year'] as const).map(t => (
                <button key={t}
                  onClick={() => setFilterType(t)}
                  className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${filterType === t ? 'bg-red-600 text-white shadow-sm shadow-red-600/20 dark:bg-red-600 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
                >
                  {t === 'day' ? 'Dia' : t === 'month' ? 'Mês' : 'Ano'}
                </button>
              ))}
            </div>

            {filterType === 'day' && (
              <input type="date" value={selectedDate} onChange={e => setSelectedDate(e.target.value)}
                className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl px-3 py-2 text-sm font-medium text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-300 dark:focus:ring-red-500/20" />
            )}
            {filterType === 'month' && (
              <div className="flex gap-2 w-full sm:w-auto">
                <select value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}
                  className="flex-1 sm:flex-none bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl px-3 py-2 text-sm font-medium text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-300">
                  {meses.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
                </select>
                <select value={selectedYear} onChange={e => setSelectedYear(e.target.value)}
                  className="flex-1 sm:flex-none bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl px-3 py-2 text-sm font-medium text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-300">
                  {anos.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            )}
            {filterType === 'year' && (
              <select value={selectedYear} onChange={e => setSelectedYear(e.target.value)}
                className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl px-3 py-2 text-sm font-medium text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-300">
                {anos.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            )}

            <button onClick={() => fetchAll(true)}
              className={`p-2.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl text-zinc-500 dark:text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:border-red-200 transition-all ${refreshing ? 'animate-spin' : ''}`}>
              <RefreshCw size={16} />
            </button>
          </div>
        </div>

        {/* ── KPIs principais ─────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
          <KpiCard
            label="Receita Operacional"
            value={fmt(receitaOperacional)}
            sub={`${stats?.totalPedidos || 0} pedidos antes dos ajustes`}
            icon={<DollarSign size={22} />}
            color="emerald"
            trend={null}
            highlight={false}
          />
          <KpiCard
            label="Receita Líquida"
            value={fmt(receitaLiquida)}
            sub={totalRefunded > 0 ? `${fmt(totalRefunded)} em reembolsos` : 'sem reembolsos'}
            icon={receitaLiquida >= 0 ? <TrendingUp size={20} /> : <TrendingDown size={20} />}
            color={receitaLiquida >= 0 ? 'emerald' : 'red'}
            trend={null}
            highlight
            badge="Principal"
          />
          <KpiCard
            label="Despesas"
            value={fmt(stats?.totalExpenses || 0)}
            sub="custos operacionais"
            icon={<TrendingDown size={20} />}
            color="red"
            trend={null}
          />
          <KpiCard
            label="Ticket Médio"
            value={fmt(kpiTicketMedio)}
            sub="média por pedido"
            icon={<ShoppingBag size={20} />}
            color="blue"
            trend={null}
          />
        </div>

        {/* ── Linha 2: Métodos + Top Produtos ────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">

          {/* Métodos de pagamento */}
          <div className={panelClass}>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-black text-zinc-800 dark:text-zinc-200 uppercase tracking-wider flex items-center gap-2">
                  <CreditCard size={16} className="text-red-600 dark:text-red-400" />
                  Formas de Pagamento
                </h2>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Distribuicao dos recebimentos registrados no periodo.</p>
              </div>
              <div className="h-10 w-10 rounded-2xl bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400 flex items-center justify-center border border-red-100 dark:border-red-900/50">
                <CreditCard size={18} />
              </div>
            </div>
            <div className="space-y-2.5 sm:space-y-3">
              {paymentMethods.map(({ label, value, icon, color }) => {
                const pct = totalPagamentos > 0 ? (value / totalPagamentos) * 100 : 0;
                const isDominant = label === dominantPayment.label && value > 0;
                return (
                  <div key={label} className={`${softSurfaceClass} p-3 sm:p-3.5 ${isDominant ? 'ring-1 ring-red-300/70 dark:ring-red-800/70 border-red-200 dark:border-red-900/60' : ''}`}>
                    <div className="flex items-start justify-between mb-2 gap-2">
                      <div className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300 text-xs font-semibold min-w-0">
                        <span className="h-8 w-8 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-500 flex items-center justify-center">{icon}</span>
                        <span className="truncate">{label}</span>
                        {isDominant && (
                          <span className="text-[9px] uppercase tracking-wide font-bold text-red-600 dark:text-red-400">Líder</span>
                        )}
                      </div>
                      <div className="flex items-baseline gap-2 shrink-0">
                        <span className="text-[10px] font-semibold text-zinc-500 w-8 text-right tabular-nums">{pct.toFixed(0)}%</span>
                        <span className="text-[11px] sm:text-xs font-bold text-zinc-900 dark:text-zinc-100 tabular-nums">{fmt(value)}</span>
                      </div>
                    </div>
                    <div className="h-2.5 bg-white/90 dark:bg-zinc-900 rounded-full overflow-hidden border border-zinc-200/70 dark:border-zinc-800">
                      <div className={`h-full ${color} rounded-full transition-all duration-700`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
              <div className="pt-4 mt-2 border-t border-zinc-200 dark:border-zinc-800 space-y-1.5">
                <div className="flex justify-between items-end gap-2">
                  <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-wide">Total de pagamentos lançados</span>
                  <span className="text-xl font-black text-zinc-900 dark:text-zinc-100 tabular-nums shrink-0">{fmt(cashReport?.total || 0)}</span>
                </div>
                <p className="text-[10px] text-zinc-500 dark:text-zinc-400 leading-snug">
                  Soma por data de registro do pagamento no período; pode diferir da receita ou do lucro (baseadas em pedidos).
                </p>
                {dominantPayment.value > 0 && (
                  <p className="text-[10px] font-semibold text-zinc-600 dark:text-zinc-300">
                    Método dominante: {dominantPayment.label} ({((dominantPayment.value / Math.max(totalPagamentos, 1)) * 100).toFixed(0)}%).
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Top produtos */}
          <div className={`lg:col-span-2 ${panelClass}`}>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-black text-zinc-800 dark:text-zinc-200 uppercase tracking-wider flex items-center gap-2">
                  <Package size={16} className="text-red-600 dark:text-red-400" />
                  Produtos Mais Vendidos
                </h2>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Ranking por quantidade vendida no período filtrado.</p>
              </div>
              <div className="rounded-full bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400 px-3 py-1 text-[11px] font-bold border border-red-100 dark:border-red-900/50">
                Top 8
              </div>
            </div>
            {(stats?.productSales || []).length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 bg-zinc-50 dark:bg-zinc-800 rounded-2xl border border-dashed border-zinc-200 dark:border-zinc-700">
                <BarChart2 size={36} className="text-zinc-400 dark:text-zinc-500" />
                <p className="text-sm mt-2 text-zinc-500 dark:text-zinc-400 font-medium">Nenhuma venda no período</p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {(stats?.productSales || []).slice(0, 8).map((item, i) => {
                  const maxQty = Math.max(...(stats?.productSales || []).map(p => p.quantity));
                  const pct = (item.quantity / maxQty) * 100;
                  const colors = ['bg-red-600', 'bg-zinc-800', 'bg-red-400', 'bg-amber-500', 'bg-rose-500'];
                  return (
                    <div key={i} className={`${softSurfaceClass} flex items-start gap-3 p-3 sm:p-3.5 ${i === 0 ? 'ring-1 ring-red-300/70 dark:ring-red-800/70 border-red-200 dark:border-red-900/60' : ''}`}>
                      <span className="w-7 h-7 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-[10px] font-black text-zinc-500 flex items-center justify-center shrink-0 mt-0.5">{i+1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 mb-1.5">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 truncate">{item.name}</span>
                            {i === 0 && <span className="text-[9px] uppercase tracking-wide font-bold text-red-600 dark:text-red-400 shrink-0">Líder</span>}
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <span className="text-[10px] text-zinc-500">Qtd</span>
                            <span className="text-[11px] text-zinc-700 dark:text-zinc-300 tabular-nums">{item.quantity} un</span>
                            <span className="text-[10px] text-zinc-500">Valor</span>
                            <span className="text-xs font-bold text-zinc-900 dark:text-zinc-100 tabular-nums">{fmt(item.total || 0)}</span>
                          </div>
                        </div>
                        <div className="h-2.5 bg-white/90 dark:bg-zinc-900 rounded-full overflow-hidden border border-zinc-200/70 dark:border-zinc-800">
                          <div className={`h-full ${colors[i % colors.length]} rounded-full`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Linha 3: Resumo financeiro + Comparativo ───────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">

          {/* DRE simplificado */}
          <div className={panelClass}>
            <div className="mb-4">
              <h2 className="text-sm font-black text-zinc-800 dark:text-zinc-200 uppercase tracking-wider">Resultado do Período</h2>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Resumo financeiro consolidado sem alterar regras de cálculo.</p>
            </div>
            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-wide font-bold text-zinc-500 px-1">Entradas</p>
              <div className={`${softSurfaceClass} p-3`}>
                <DreRow label="Receita Operacional" value={receitaOperacional} type="positive" />
              </div>
              {totalRefunded > 0 && (
                <div className={`${softSurfaceClass} p-3`}>
                  <DreRow label="(-) Reembolsos" value={-totalRefunded} type="negative" />
                </div>
              )}
              <div className={`${softSurfaceClass} p-3 border-emerald-200/80 dark:border-emerald-900/60`}>
                <DreRow label="Receita Líquida" value={receitaLiquida} type="positive" />
              </div>
              <p className="text-[10px] uppercase tracking-wide font-bold text-zinc-500 px-1 pt-1">Saídas</p>
              <div className={`${softSurfaceClass} p-3`}>
                <DreRow label="(-) Despesas" value={-(stats?.totalExpenses || 0)} type="negative" />
              </div>
              {(stats?.totalRepassesPagos || 0) > 0 && (
                <div className={`${softSurfaceClass} p-3`}>
                  <DreRow label="(-) Repasses" value={-(stats?.totalRepassesPagos || 0)} type="negative" />
                </div>
              )}
              <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4 mt-3 rounded-t-2xl">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-black text-zinc-800 dark:text-zinc-200">Lucro Líquido</span>
                  <span className={`text-xl font-black tabular-nums ${lucro >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                    {fmt(lucro)}
                  </span>
                </div>
                <div className="mt-2 h-2.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${lucro >= 0 ? 'bg-emerald-500' : 'bg-red-500'}`}
                    style={{ width: `${Math.min(100, Math.abs(margem))}%` }}
                  />
                </div>
                <p className="text-[10px] text-zinc-500 mt-1">{margem.toFixed(1)}% de margem</p>
              </div>
            </div>
          </div>

          {/* Comparativo dia/semana/mês + Gráfico 7 dias */}
          <div className={`lg:col-span-2 ${panelClass}`}>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-black text-zinc-800 dark:text-zinc-200 uppercase tracking-wider flex items-center gap-2">
                  <BarChart2 size={16} className="text-red-600 dark:text-red-400" />
                  Vendas - Ultimos 7 Dias
                </h2>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Leitura operacional com destaque para o comportamento recente de vendas.</p>
              </div>
            </div>

            {/* Mini KPIs */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3 mb-5">
              {[
                { label: 'Hoje',        value: stats?.today || 0, active: false },
                { label: 'Esta Semana', value: stats?.week  || 0, active: false },
                { label: 'Este Mês',    value: stats?.month || 0, active: true },
              ].map(({ label, value, active }) => (
                <div key={label} className={`rounded-2xl p-3 text-center bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-sm ${active ? 'ring-2 ring-red-500/15 border-red-200 dark:border-red-900/50 bg-red-50/50 dark:bg-red-950/20' : ''}`}>
                  <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wide">{label}</p>
                  <p className="text-base sm:text-lg font-black text-zinc-900 dark:text-zinc-100 mt-1 tabular-nums">{fmt(value)}</p>
                </div>
              ))}
            </div>

            {/* Gráfico de barras — SVG puro, sem dependência */}
            {weeklyData.length > 0 && weeklyData.some(d => d.total > 0) ? (() => {
              const maxVal = Math.max(...weeklyData.map(d => d.total), 1);
              const H = 130;
              return (
                <div className="w-full overflow-x-auto">
                  <div className="min-w-[360px] bg-zinc-50 dark:bg-zinc-900 rounded-2xl p-3 sm:p-4 border border-zinc-200/80 dark:border-zinc-800 shadow-inner" style={{ height: 170 }}>
                    <svg width="100%" height="100%" viewBox={`0 0 ${weeklyData.length * 52} ${H + 36}`} preserveAspectRatio="xMidYMid meet">
                    {weeklyData.map((d, i) => {
                      const barH   = Math.max(6, Math.round((d.total / maxVal) * H));
                      const x      = i * 52 + 6;
                      const y      = H - barH;
                      const isHoje = i === weeklyData.length - 1;
                      const isMax  = d.total === maxVal && d.total > 0;
                      const fill   = isHoje ? '#ea1d2c' : isMax ? '#a02331' : '#cbd5e1';
                      return (
                        <g key={i}>
                          <rect x={x} y={y} width={40} height={barH} rx={6} fill={fill} opacity={isHoje || isMax ? 1 : 0.85} />
                          {d.total > 0 && (
                            <text x={x + 20} y={y - 6} textAnchor="middle" fontSize={10} fill="#a1a1aa" fontWeight={600}>
                              {d.total >= 1000 ? `${(d.total/1000).toFixed(1)}k` : `${d.total.toFixed(0)}`}
                            </text>
                          )}
                          <text x={x + 20} y={H + 18} textAnchor="middle" fontSize={10} fill={isHoje ? '#ea1d2c' : '#71717a'} fontWeight={isHoje ? 700 : 500}>
                            {d.label}
                          </text>
                        </g>
                      );
                    })}
                      <line x1={0} y1={H} x2={weeklyData.length * 52} y2={H} stroke="#d4d4d8" strokeWidth={1.5} />
                    </svg>
                  </div>
                </div>
              );
            })() : (
              <div className="h-[160px] flex flex-col items-center justify-center bg-zinc-50 dark:bg-zinc-800 rounded-2xl border border-dashed border-zinc-200 dark:border-zinc-700">
                <BarChart2 size={32} className="text-zinc-400 dark:text-zinc-500 mb-2" />
                <p className="text-sm text-zinc-500 dark:text-zinc-400 font-medium">Nenhuma venda nos últimos 7 dias</p>
              </div>
            )}

            {/* Alerta se sem vendas no período filtrado */}
            {(stats?.filteredTotal || 0) === 0 && (
              <div className="mt-4 p-4 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 rounded-xl flex items-center gap-3 shadow-sm">
                <AlertTriangle size={18} className="text-amber-500 dark:text-amber-400 shrink-0" />
                <div className="flex-1">
                  <p className="text-xs font-bold text-amber-700 dark:text-amber-300">Nenhuma venda neste período</p>
                  <p className="text-[11px] text-amber-600 dark:text-amber-400/80">Registre vendas no balcão para ver as métricas.</p>
                </div>
                <button onClick={onGoToPOS}
                  className="shrink-0 px-3 py-1.5 bg-amber-500 text-white rounded-lg text-xs font-bold hover:bg-amber-600 transition-all">
                  Ir ao PDV
                </button>
              </div>
            )}
          </div>
        </div>

      </div>
    </motion.div>
  );
}

// ─── Componentes auxiliares ───────────────────────────────────────────────────

function KpiCard({ label, value, sub, icon, color, trend, highlight, badge }: {
  label: string; value: string; sub: string;
  icon: React.ReactNode; color: 'emerald' | 'red' | 'blue' | 'amber';
  trend: number | null;
  highlight?: boolean;
  badge?: string;
}) {
  const colorMap = {
    emerald: { bg: 'bg-emerald-500/12', text: 'text-emerald-600 dark:text-emerald-400', accent: 'from-emerald-500 to-emerald-400' },
    red:     { bg: 'bg-red-500/12',     text: 'text-red-600 dark:text-red-400',         accent: 'from-red-600 to-red-400'         },
    blue:    { bg: 'bg-zinc-900/8 dark:bg-zinc-100/10', text: 'text-zinc-700 dark:text-zinc-200', accent: 'from-zinc-800 to-zinc-500' },
    amber:   { bg: 'bg-amber-500/12',   text: 'text-amber-600 dark:text-amber-400',     accent: 'from-amber-500 to-amber-400'     },
  };
  const c = colorMap[color];
  return (
    <div className={`relative overflow-hidden bg-white dark:bg-zinc-900 rounded-[24px] p-4 sm:p-5 shadow-[0_10px_30px_rgba(15,23,42,0.06)] border transition-all hover:shadow-[0_14px_34px_rgba(15,23,42,0.08)] min-h-[150px] ${
      highlight ? 'border-red-200 bg-red-50/60 dark:bg-red-950/20 dark:border-red-900/50' : 'border-zinc-200 dark:border-zinc-800'
    }`}>
      <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${highlight ? 'from-red-600 via-red-500 to-red-400' : c.accent}`} />
      <div className="flex items-start justify-between mb-3 gap-3">
        <div className={`w-11 h-11 sm:w-12 sm:h-12 ${c.bg} rounded-2xl flex items-center justify-center ${c.text} border border-white/60 dark:border-zinc-800 shrink-0`}>
          {icon}
        </div>
        {trend !== null && (
          <span className={`flex items-center gap-0.5 text-xs font-bold ${trend >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
            {trend >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
            {Math.abs(trend).toFixed(1)}%
          </span>
        )}
        {trend === null && badge && (
          <span className="text-[9px] uppercase tracking-wide font-bold px-2 py-1 rounded-full bg-red-50 text-red-600 border border-red-100 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900/50">
            {badge}
          </span>
        )}
      </div>
      <p className="text-[11px] font-bold text-zinc-500 uppercase tracking-[0.14em]">{label}</p>
      <p className={`font-black tabular-nums mt-1 break-words ${highlight ? 'text-[26px] sm:text-3xl text-zinc-900 dark:text-zinc-100' : 'text-2xl text-zinc-900 dark:text-zinc-100'}`}>{value}</p>
      <div className="mt-2 pt-2 border-t border-zinc-200/80 dark:border-zinc-800">
        <p className="text-[11px] text-zinc-500">{sub}</p>
      </div>
    </div>
  );
}

function DreRow({ label, value, type }: { label: string; value: number; type: 'positive' | 'negative' }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-semibold text-zinc-500">{label}</span>
      <span className={`text-sm font-bold tabular-nums ${type === 'positive' ? 'text-zinc-800 dark:text-zinc-200' : 'text-red-600 dark:text-red-400'}`}>
        {type === 'positive' ? '' : ''}{`R$ ${Math.abs(value).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`}
      </span>
    </div>
  );
}

export function StatCard({ label, value, icon, color, highlight = false }: any) {
  return (
    <div className={`bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-5 rounded-2xl flex items-center gap-4 ${highlight ? 'ring-2 ring-emerald-400' : ''}`}>
      <div className={`w-11 h-11 ${color} rounded-xl flex items-center justify-center shrink-0`}>{icon}</div>
      <div>
        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">{label}</p>
        <p className="text-xl font-black text-zinc-900 dark:text-zinc-100">{value}</p>
      </div>
    </div>
  );
}
export function CashRow({ label, value }: any) {
  return (
    <div className="flex justify-between items-center py-2 border-b border-zinc-100 dark:border-zinc-800">
      <span className="text-zinc-600 dark:text-zinc-400">{label}</span>
      <span className="font-bold text-zinc-900 dark:text-zinc-100">R$ {(value || 0).toFixed(2)}</span>
    </div>
  );
}