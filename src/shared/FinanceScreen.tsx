import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Plus, Trash2, DollarSign, TrendingDown, TrendingUp,
  X, Filter, Calendar, AlertCircle, CheckCircle2,
  Banknote, ChevronDown,
} from 'lucide-react';
import { adminScreenPagePaddingClass } from '../components/ui/screenChrome';

type DateFilter = 'hoje' | 'semana' | 'mes' | 'tudo';

interface Expense {
  id: number;
  description: string;
  amount: number;
  category: string | null;
  created_at: string;
}

interface Caixa {
  id: number;
  data: string;
  status: string;
  fundo_inicial: number;
  total_vendas_dinheiro?: number;
  total_esperado?: number;
  valor_contado?: number;
  diferenca?: number;
}

interface FinancialStats {
  filteredTotal?: number;
  totalRefunded?: number;
  netRevenue?: number;
  totalPedidos?: number;
}

const fmt = (v: number) => `R$ ${(v || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

const CATEGORIAS = ['Estoque', 'Funcionários', 'Aluguel', 'Energia/Água', 'Manutenção', 'Marketing', 'Equipamentos', 'Outros'];
const DATE_FILTER_OPTIONS: { key: DateFilter; label: string }[] = [
  { key: 'hoje', label: 'Hoje' },
  { key: 'semana', label: 'Esta semana' },
  { key: 'mes', label: 'Este mês' },
  { key: 'tudo', label: 'Tudo' },
];
const DATE_FILTER_LABELS: Record<DateFilter, string> = {
  hoje: 'Hoje',
  semana: 'Esta semana',
  mes: 'Este mês',
  tudo: 'Todo o período',
};

const CAT_COLORS: Record<string, string> = {
  Estoque: 'bg-blue-100 text-blue-700',
  Funcionários: 'bg-violet-100 text-violet-700',
  Aluguel: 'bg-amber-100 text-amber-700',
  'Energia/Água': 'bg-cyan-100 text-cyan-700',
  Manutenção: 'bg-orange-100 text-orange-700',
  Marketing: 'bg-pink-100 text-pink-700',
  Equipamentos: 'bg-indigo-100 text-indigo-700',
  Outros: 'bg-zinc-100 text-zinc-700',
};

const normalizeCategory = (category?: string | null) => category?.trim() || 'Outros';

const matchesDateFilter = (createdAt: string, range: DateFilter) => {
  if (range === 'tudo') return true;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const date = new Date(createdAt);

  if (Number.isNaN(date.getTime())) return false;
  if (range === 'hoje') return date >= today;

  if (range === 'semana') {
    const start = new Date(today);
    start.setDate(today.getDate() - today.getDay());
    return date >= start;
  }

  return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
};

const formatExpenseDayLabel = (createdAt: string) => {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return 'Data indisponível';

  return date.toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: 'short',
  });
};

const formatExpenseMeta = (createdAt: string) => {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return 'Sem horário';

  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export default function FinanceScreen({ token, segmento: _segmento, initialTab }: { token: string; segmento: string; initialTab?: 'despesas' | 'caixa' }) {
  const [tab, setTab] = useState<'despesas' | 'caixa'>(initialTab || 'despesas');
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [caixaHistory, setCaixaHistory] = useState<Caixa[]>([]);
  const [financialStats, setFinancialStats] = useState<FinancialStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [catFilter, setCatFilter] = useState('Todas');
  const [dateFilter, setDateFilter] = useState<DateFilter>(() => {
    return (localStorage.getItem('finance_date_filter') as DateFilter) || 'tudo';
  });
  const [form, setForm] = useState({ description: '', amount: '', category: 'Estoque' });
  const [saving, setSaving] = useState(false);

  const handleDateFilter = (value: DateFilter) => {
    setDateFilter(value);
    localStorage.setItem('finance_date_filter', value);
  };

  useEffect(() => {
    if (tab === 'despesas') fetchExpenses();
    else if (tab === 'caixa') fetchCaixa();
  }, [tab]);

  useEffect(() => {
    fetchFinancialStats();
  }, [dateFilter, token]);

  const fetchExpenses = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/expenses', { headers: { Authorization: `Bearer ${token}` } });
      setExpenses(await response.json());
    } catch {} finally {
      setLoading(false);
    }
  };

  const fetchCaixa = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/caixa/historico', { headers: { Authorization: `Bearer ${token}` } });
      setCaixaHistory(await response.json());
    } catch {} finally {
      setLoading(false);
    }
  };

  const fetchFinancialStats = async () => {
    try {
      const query =
        dateFilter === 'hoje' ? '?range=today' :
        dateFilter === 'semana' ? '?range=week' :
        dateFilter === 'mes' ? '?range=month' :
        '?range=all';

      const response = await fetch(`/api/dashboard/stats${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        setFinancialStats(await response.json());
      }
    } catch {}
  };

  const handleAdd = async () => {
    if (!form.description || !form.amount) return;

    setSaving(true);
    try {
      const response = await fetch('/api/expenses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ...form, amount: parseFloat(form.amount.replace(',', '.')) }),
      });

      if (response.ok) {
        setShowAdd(false);
        setForm({ description: '', amount: '', category: 'Estoque' });
        fetchExpenses();
      } else {
        const error = await response.json();
        alert(error.error || 'Erro ao salvar');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Excluir esta despesa?')) return;
    try {
      const response = await fetch(`/api/expenses/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const error = await response.json().catch(() => null);
        alert(error?.error || 'Não foi possível excluir a despesa.');
        return;
      }

      fetchExpenses();
    } catch {
      alert('Erro de conexão ao excluir a despesa.');
    }
  };

  const filterByDate = <T extends { created_at: string }>(list: T[], range = dateFilter) => {
    return list.filter(item => matchesDateFilter(item.created_at, range));
  };

  const expFiltered = filterByDate(expenses) as Expense[];
  const filtered = catFilter === 'Todas'
    ? expFiltered
    : expFiltered.filter(expense => normalizeCategory(expense.category) === catFilter);
  const totalDespesas = expFiltered.reduce((sum, expense) => sum + expense.amount, 0);
  const filteredTotal = filtered.reduce((sum, expense) => sum + expense.amount, 0);
  const receitaOperacional = Number(financialStats?.filteredTotal || 0);
  const totalReembolsado = Number(financialStats?.totalRefunded || 0);
  const receitaLiquida = Number(financialStats?.netRevenue ?? (receitaOperacional - totalReembolsado));
  const byCat = CATEGORIAS.map(category => ({
    cat: category,
    total: filtered.filter(expense => normalizeCategory(expense.category) === category).reduce((sum, expense) => sum + expense.amount, 0),
    count: filtered.filter(expense => normalizeCategory(expense.category) === category).length,
  })).filter(category => category.count > 0).sort((a, b) => b.total - a.total);
  const summaryByRange = (['hoje', 'semana', 'mes'] as const).map(range => {
    const items = filterByDate(expenses, range) as Expense[];
    return {
      key: range,
      label: DATE_FILTER_LABELS[range],
      total: items.reduce((sum, item) => sum + item.amount, 0),
      count: items.length,
    };
  });
  const groupedExpenses = filtered.reduce((groups, expense) => {
    const date = new Date(expense.created_at);
    const key = Number.isNaN(date.getTime())
      ? `sem-data-${expense.id}`
      : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const current = groups.find(group => group.key === key);

    if (current) {
      current.items.push(expense);
      current.total += expense.amount;
      return groups;
    }

    groups.push({
      key,
      label: formatExpenseDayLabel(expense.created_at),
      total: expense.amount,
      items: [expense],
    });

    return groups;
  }, [] as { key: string; label: string; total: number; items: Expense[] }[]);
  const leadingCategory = byCat[0];
  const activeCategoryLabel = catFilter === 'Todas' ? 'Todas as categorias' : catFilter;

  const TABS = [
    { key: 'despesas', label: 'Despesas' },
    { key: 'caixa', label: 'Histórico de Caixa' },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto bg-zinc-50"
    >
      <div className={`mx-auto max-w-6xl min-w-0 space-y-3 sm:space-y-4 2xl:space-y-5 ${adminScreenPagePaddingClass}`}>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-black text-zinc-900 sm:text-xl 2xl:text-2xl">Financeiro</h1>
            <p className="mt-0.5 text-[11px] text-zinc-400 sm:text-xs 2xl:text-sm">Controle de despesas e caixa</p>
          </div>
          {tab === 'despesas' && (
            <button
              onClick={() => setShowAdd(true)}
              className="flex shrink-0 items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-bold text-white transition-all hover:bg-zinc-800 active:scale-95 min-h-[44px] sm:min-h-0 sm:py-2"
            >
              <Plus size={16} /> Nova Despesa
            </button>
          )}
        </div>

        <div className="flex w-full min-w-0 gap-0.5 overflow-x-auto overflow-y-hidden rounded-xl border border-zinc-200 bg-white p-1 touch-pan-x overscroll-x-contain [-webkit-overflow-scrolling:touch] sm:w-fit sm:overflow-visible">
          {TABS.map(item => (
            <button
              key={item.key}
              onClick={() => setTab(item.key as 'despesas' | 'caixa')}
              className={`shrink-0 rounded-lg px-3 py-2 text-xs font-bold transition-all sm:px-4 sm:text-sm min-h-[40px] sm:min-h-0 ${tab === item.key ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:bg-zinc-50'}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-2 overflow-x-auto overflow-y-hidden pb-0.5 [-webkit-overflow-scrolling:touch] touch-pan-x overscroll-x-contain sm:flex-wrap sm:overflow-visible sm:pb-0">
          <Calendar size={14} className="shrink-0 text-zinc-400" />
          {DATE_FILTER_OPTIONS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => handleDateFilter(key)}
              className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-bold transition-all sm:px-3 ${dateFilter === key ? 'bg-zinc-900 text-white' : 'border border-zinc-200 bg-white text-zinc-500 hover:border-zinc-400'}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-2 min-[960px]:grid-cols-3 sm:gap-2.5 2xl:gap-3">
          <div className="rounded-2xl border border-zinc-200 bg-white p-2.5 sm:p-3 min-w-0 2xl:p-4">
            <p className="text-xs font-bold text-zinc-400 uppercase tracking-wide">Receita Operacional</p>
            <p className="text-2xl font-black text-emerald-600 mt-1">{fmt(receitaOperacional)}</p>
            <p className="text-[10px] text-zinc-400 mt-0.5">{financialStats?.totalPedidos || 0} pedidos no período</p>
          </div>
          <div className="rounded-2xl border border-zinc-200 bg-white p-2.5 sm:p-3 min-w-0 2xl:p-4">
            <p className="text-xs font-bold text-zinc-400 uppercase tracking-wide">Reembolsos</p>
            <p className="text-2xl font-black text-amber-600 mt-1">{fmt(totalReembolsado)}</p>
            <p className="text-[10px] text-zinc-400 mt-0.5">Total reembolsado no período</p>
          </div>
          <div className="rounded-2xl border border-zinc-200 bg-white p-2.5 sm:p-3 min-w-0 2xl:p-4">
            <p className="text-xs font-bold text-zinc-400 uppercase tracking-wide">Receita Líquida</p>
            <p className="text-2xl font-black text-zinc-900 mt-1">{fmt(receitaLiquida)}</p>
            <p className="text-[10px] text-zinc-400 mt-0.5">Receita operacional menos reembolsos</p>
          </div>
        </div>

        {tab === 'despesas' && (
          <div className="space-y-3 2xl:space-y-4">
            <div className="grid grid-cols-1 gap-2 min-[1100px]:grid-cols-4 sm:gap-3 2xl:gap-3">
              <div className="min-w-0 rounded-2xl border border-zinc-200 bg-white p-3 sm:p-4 min-[1100px]:col-span-1 2xl:p-5">
                <div className="w-10 h-10 rounded-xl bg-red-50 text-red-500 flex items-center justify-center mb-3 2xl:mb-4 2xl:h-11 2xl:w-11 2xl:rounded-2xl">
                  <DollarSign size={20} />
                </div>
                <p className="text-xs font-bold text-zinc-400 uppercase tracking-wide">Resumo da lista</p>
                <p className="text-3xl font-black text-red-600 mt-2">{fmt(filteredTotal)}</p>
                <p className="text-sm text-zinc-500 mt-2">
                  {filtered.length} lançamento{filtered.length !== 1 ? 's' : ''} em {DATE_FILTER_LABELS[dateFilter].toLowerCase()}.
                </p>
                <div className="mt-3 pt-3 border-t border-zinc-100 space-y-1.5 text-xs text-zinc-500 2xl:mt-4 2xl:pt-4">
                  <p>Categoria ativa: <span className="font-bold text-zinc-700">{activeCategoryLabel}</span></p>
                  <p>Categoria em destaque: <span className="font-bold text-zinc-700">{leadingCategory ? `${leadingCategory.cat} (${fmt(leadingCategory.total)})` : 'Sem dados no filtro atual'}</span></p>
                </div>
              </div>

              {summaryByRange.map(summary => (
                <div key={summary.key} className="rounded-2xl border border-zinc-200 bg-white p-2.5 sm:p-3 min-w-0 2xl:p-4">
                  <p className="text-xs font-bold text-zinc-400 uppercase tracking-wide">{summary.label}</p>
                  <p className="text-2xl font-black text-zinc-900 mt-1">{fmt(summary.total)}</p>
                  <p className="text-[11px] text-zinc-500 mt-2">
                    {summary.count} registro{summary.count !== 1 ? 's' : ''} no período
                  </p>
                </div>
              ))}
            </div>

            <div className="space-y-2 rounded-2xl border border-zinc-200 bg-white p-2.5 sm:p-3 min-w-0 2xl:space-y-3 2xl:p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between min-w-0">
                <div>
                  <p className="text-sm font-black text-zinc-900">Filtros rápidos</p>
                  <p className="text-xs text-zinc-400">
                    Período: {DATE_FILTER_LABELS[dateFilter]} • Total bruto do período: {fmt(totalDespesas)}
                  </p>
                </div>
                <div className="text-xs font-bold text-zinc-500">
                  Mostrando {filtered.length} registro{filtered.length !== 1 ? 's' : ''}
                </div>
              </div>

              <div className="flex min-w-0 flex-wrap items-center gap-2 overflow-x-auto overflow-y-hidden pb-0.5 [-webkit-overflow-scrolling:touch] touch-pan-x overscroll-x-contain sm:flex-wrap sm:overflow-visible sm:pb-0">
                <Filter size={14} className="shrink-0 text-zinc-400" />
                {['Todas', ...CATEGORIAS].map(category => (
                  <button
                    key={category}
                    onClick={() => setCatFilter(category)}
                    className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-bold transition-all sm:px-3 ${catFilter === category ? 'bg-zinc-900 text-white' : 'border border-zinc-200 bg-white text-zinc-500 hover:border-zinc-400'}`}
                  >
                    {category}
                  </button>
                ))}
              </div>
            </div>

            {loading ? (
              <div className="flex justify-center py-10">
                <div className="w-7 h-7 border-2 border-zinc-200 border-t-zinc-800 rounded-full animate-spin" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 sm:py-12 bg-white border border-dashed border-zinc-200 rounded-2xl">
                <TrendingDown size={40} className="text-zinc-200 mb-3" />
                <p className="text-zinc-500 font-medium">
                  Nenhuma despesa encontrada em {DATE_FILTER_LABELS[dateFilter].toLowerCase()} para {activeCategoryLabel.toLowerCase()}.
                </p>
                <button
                  onClick={() => setShowAdd(true)}
                  className="mt-4 px-4 py-2 bg-zinc-900 text-white rounded-xl text-sm font-bold"
                >
                  Registrar despesa
                </button>
              </div>
            ) : (
              <div className="min-w-0 overflow-hidden rounded-2xl border border-zinc-200 bg-white">
                <div className="flex min-w-0 flex-col gap-2 border-b border-zinc-200 px-3 py-2.5 sm:flex-row sm:items-end sm:justify-between sm:px-4 2xl:py-4">
                  <div>
                    <p className="text-xs font-bold text-zinc-400 uppercase tracking-wide">Lançamentos</p>
                    <p className="text-lg font-black text-zinc-900 mt-1">Leitura rápida dos gastos</p>
                    <p className="text-xs text-zinc-400 mt-1">Valores em destaque, categoria visível e agrupamento por dia.</p>
                  </div>
                  <div className="text-left sm:text-right">
                    <p className="text-xs font-bold text-zinc-400 uppercase tracking-wide">Total visível</p>
                    <p className="text-2xl font-black text-red-600 mt-1">{fmt(filteredTotal)}</p>
                  </div>
                </div>

                <div className="min-w-0 space-y-2 p-2.5 sm:space-y-3 sm:p-3 2xl:space-y-4 2xl:p-4">
                  {groupedExpenses.map(group => (
                    <div key={group.key} className="border border-zinc-200 rounded-2xl overflow-hidden">
                      <div className="px-4 py-3 bg-zinc-50 border-b border-zinc-200 flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-black text-zinc-900 capitalize">{group.label}</p>
                          <p className="text-[11px] text-zinc-400">
                            {group.items.length} lançamento{group.items.length !== 1 ? 's' : ''}
                          </p>
                        </div>
                        <p className="text-sm font-black text-red-600">{fmt(group.total)}</p>
                      </div>

                      <div className="divide-y divide-zinc-100">
                        {group.items.map(expense => {
                          const category = normalizeCategory(expense.category);

                          return (
                            <motion.div
                              key={expense.id}
                              initial={{ opacity: 0, y: 4 }}
                              animate={{ opacity: 1, y: 0 }}
                              className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
                            >
                              <div className="flex items-start gap-3 flex-1 min-w-0">
                                <div className="w-11 h-11 bg-red-50 rounded-2xl flex items-center justify-center text-red-400 shrink-0">
                                  <TrendingDown size={18} />
                                </div>

                                <div className="min-w-0 flex-1">
                                  <p className="min-w-0 truncate font-bold text-zinc-900 text-sm sm:text-base" title={expense.description}>{expense.description}</p>
                                  <div className="flex flex-wrap items-center gap-2 mt-2">
                                    <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full ${CAT_COLORS[category] || 'bg-zinc-100 text-zinc-600'}`}>
                                      {category}
                                    </span>
                                    <span className="text-[11px] text-zinc-400">{formatExpenseMeta(expense.created_at)}</span>
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center justify-between sm:justify-end gap-3 sm:gap-4">
                                <div className="text-left sm:text-right">
                                  <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-wide">Valor</p>
                                  <p className="text-lg sm:text-xl font-black text-red-600">{fmt(expense.amount)}</p>
                                </div>

                                <button
                                  onClick={() => handleDelete(expense.id)}
                                  title="Excluir despesa"
                                  className="w-9 h-9 flex items-center justify-center rounded-xl text-zinc-300 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0"
                                >
                                  <Trash2 size={15} />
                                </button>
                              </div>
                            </motion.div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'caixa' && (
          <div className="space-y-3">
            {loading ? (
              <div className="flex justify-center py-10">
                <div className="w-7 h-7 border-2 border-zinc-200 border-t-zinc-800 rounded-full animate-spin" />
              </div>
            ) : caixaHistory.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 sm:py-12 bg-white border border-dashed border-zinc-200 rounded-2xl">
                <Banknote size={40} className="text-zinc-200 mb-3" />
                <p className="text-zinc-400 font-medium">Nenhum histórico de caixa</p>
              </div>
            ) : (
              (filterByDate(caixaHistory.map(item => ({ ...item, created_at: `${item.data}T12:00:00` }))) as (Caixa & { created_at: string })[]).map((item, index) => {
                const isAberto = item.status === 'aberto';
                const diff = item.diferenca || 0;

                return (
                  <div key={index} className="bg-white border border-zinc-200 rounded-xl overflow-hidden">
                    <div className="p-4 flex items-center gap-4">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${isAberto ? 'bg-emerald-50 text-emerald-500' : 'bg-zinc-100 text-zinc-400'}`}>
                        <Banknote size={18} />
                      </div>

                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <p className="font-bold text-zinc-900 text-sm">
                            {new Date(`${item.data}T12:00:00`).toLocaleDateString('pt-BR', {
                              weekday: 'short',
                              day: '2-digit',
                              month: 'short',
                              year: 'numeric',
                            })}
                          </p>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isAberto ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-100 text-zinc-500'}`}>
                            {isAberto ? 'Aberto' : 'Fechado'}
                          </span>
                        </div>

                        <div className="flex items-center gap-4 mt-1 flex-wrap">
                          <span className="text-xs text-zinc-400">Fundo: <b className="text-zinc-700">{fmt(item.fundo_inicial)}</b></span>
                          <span className="text-xs text-zinc-400">Esperado: <b className="text-zinc-700">{fmt(item.total_esperado || 0)}</b></span>
                          {!isAberto && <span className="text-xs text-zinc-400">Contado: <b className="text-zinc-700">{fmt(item.valor_contado || 0)}</b></span>}
                          {!isAberto && (
                            <span className={`flex items-center gap-1 text-xs font-bold ${diff === 0 ? 'text-emerald-600' : diff > 0 ? 'text-blue-600' : 'text-red-600'}`}>
                              {diff === 0 ? <CheckCircle2 size={12} /> : diff > 0 ? <TrendingUp size={12} /> : <AlertCircle size={12} />}
                              {diff > 0 ? '+' : ''}{fmt(diff)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      <AnimatePresence>
        {showAdd && (
          <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4">
            <motion.div
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.92, opacity: 0 }}
              className="my-auto flex max-h-[min(92dvh,100svh)] min-h-0 w-full max-w-md flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:max-h-[min(90vh,560px)] sm:rounded-2xl"
            >
              <div className="flex shrink-0 items-center justify-between border-b border-zinc-100 px-3 py-3 sm:px-5 sm:py-3 2xl:px-6 2xl:py-4">
                <h3 className="text-base font-black text-zinc-900 2xl:text-lg">Nova Despesa</h3>
                <button type="button" onClick={() => setShowAdd(false)} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100">
                  <X size={18} />
                </button>
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-3 sm:px-5 2xl:space-y-4 2xl:px-6 2xl:py-4">
                <div>
                  <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Descrição</label>
                  <input
                    value={form.description}
                    onChange={event => setForm({ ...form, description: event.target.value })}
                    placeholder="Ex: Compra de ingredientes"
                    className="mt-1 w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Valor (R$)</label>
                    <input
                      value={form.amount}
                      onChange={event => setForm({ ...form, amount: event.target.value })}
                      placeholder="0,00"
                      type="text"
                      className="mt-1 w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Categoria</label>
                    <div className="relative mt-1">
                      <select
                        value={form.category}
                        onChange={event => setForm({ ...form, category: event.target.value })}
                        className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none appearance-none"
                      >
                        {CATEGORIAS.map(category => <option key={category}>{category}</option>)}
                      </select>
                      <ChevronDown size={14} className="absolute right-3 top-3 text-zinc-400 pointer-events-none" />
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex shrink-0 gap-2 border-t border-zinc-100 bg-white px-3 py-3 sm:gap-3 sm:px-5 2xl:px-6 2xl:py-4">
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  className="flex-1 rounded-xl bg-zinc-100 py-2.5 text-sm font-bold transition-all hover:bg-zinc-200"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={saving || !form.description || !form.amount}
                  className="flex-1 rounded-xl bg-zinc-900 py-2.5 text-sm font-bold text-white transition-all hover:bg-zinc-800 disabled:opacity-50"
                >
                  {saving ? 'Salvando...' : 'Salvar'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}