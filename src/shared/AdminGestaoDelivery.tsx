// src/shared/AdminGestaoDelivery.tsx
// Painel admin → "Gestão" : ganhos consolidados (software + delivery), controle semanal
// dos restaurantes gerenciados e cadastro de estabelecimentos.
//
// Uso no AdminPanel:  <AdminGestaoDelivery token={token} onAuthError={handleAuthError} />

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, BadgeCheck, Building2, CalendarCheck, ChevronDown, ChevronLeft, ChevronRight, ClipboardCopy,
  Clock, Coins, HandCoins, Loader2, MessageCircle, Pencil, Plus, Trash2, TrendingUp, Wallet,
} from 'lucide-react';

/* ───────────── tema Pratori (claro) ─────────────
 * Branco dominante + vermelho Pratori. Cores explícitas (sem tokens do tema escuro e sem classes que o
 * AdminPanel escuro sobrescreve: .bg-white, thead, input[type=text]) para o módulo ficar claro
 * mesmo dentro do painel admin. */
const C = {
  red: '#ea1d2c', redDark: '#a02331', redHover: '#9c050b', redSoft: '#fdecee',
  text: '#3f3e3e', muted: '#7c7875', border: '#e5e5e7', soft: '#f1f1f3', hover: '#f5f5f5', alt: '#f7f7f8',
};
const fieldInputClass =
  'w-full rounded-xl border border-[#e5e5e7] bg-[#ffffff] px-3 py-2 text-sm text-[#3f3e3e] placeholder:text-[#a6a29f] transition-all focus:border-[#ea1d2c] focus:outline-none focus:ring-2 focus:ring-[#ea1d2c]/20 disabled:cursor-not-allowed disabled:bg-[#f7f7f8] disabled:opacity-70';
const fieldLabelClass = 'text-[11px] font-bold uppercase tracking-wider text-[#7c7875]';

const Card = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <div className={`min-w-0 max-w-full overflow-hidden rounded-2xl border border-[#e5e5e7] bg-[#ffffff] shadow-sm shadow-[#3f3e3e]/[0.06] ${className}`}>{children}</div>
);

function Modal({ open, onClose, title, children, wide = false }: {
  open: boolean; onClose: () => void; title: string; children: React.ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center overflow-y-auto bg-black/40 p-0 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}
        className={`flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-[#e5e5e7] bg-[#ffffff] text-[#3f3e3e] shadow-2xl [color-scheme:light] sm:rounded-2xl ${wide ? 'max-w-2xl' : 'max-w-md'}`}>
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[#e5e5e7] px-4 py-3">
          <h3 className="min-w-0 truncate text-base font-black text-[#3f3e3e]">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Fechar" className="rounded-lg p-2 text-[#7c7875] hover:bg-[#f5f5f5]">✕</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

/* ───────────── tipos ───────────── */

type Status = 'em_andamento' | 'aguardando' | 'pago';
type Lancamento = {
  id: number; estabelecimento_id: number; semana_inicio: string; semana_fim: string;
  valor_99food: number; valor_ifood: number; valor_outros: number;
  pct_meu_snap: number; pct_parceiro_snap: number; status: Status;
  data_pagamento: string | null; repasse_pago: boolean; repasse_data: string | null; observacoes: string | null;
  base: number; comissao: number; repasse: number; meu: number;
};
type Estabelecimento = {
  id: number; nome: string; cliente_id: number | null; razao_social: string | null;
  documento_tipo: 'CPF' | 'CNPJ' | null; documento_numero: string | null; responsavel: string | null;
  whatsapp: string | null; email: string | null; cidade: string | null;
  pix_tipo: string | null; pix_chave: string | null; pix_titular: string | null; apps: string[];
  pct_meu: number; tem_parceiro: boolean; parceiro_nome: string | null; parceiro_pix: string | null;
  pct_parceiro: number; inicio_em: string | null; ativo: boolean; observacoes: string | null;
  total_semanas?: number; meu_acumulado?: number;
};
type Totais = {
  gerenciado: number; comissao_bruta: number; repasse_parceiro: number; meu_liquido: number;
  recebido: number; a_receber: number; em_andamento: number; repasse_a_pagar: number;
};
type PorEst = Totais & { estabelecimento_id: number; nome: string; ativo: boolean; tem_parceiro: boolean;
  pct_meu: number; pct_parceiro: number; status: 'aguardando' | 'em_andamento' | 'pago' | 'sem_lancamento' };
type SemanaRow = {
  semana_inicio: string; semana_fim: string; gerenciado: number; comissao_bruta: number; repasse_parceiro: number;
  meu_liquido: number; recebido: number | null; n_aguardando: number; n_andamento: number; n: number;
  por_estabelecimento: { estabelecimento_id: number; meu: number; status: Status }[];
};
type Resumo = {
  totais: Totais; por_estabelecimento: PorEst[]; semanas: SemanaRow[];
  semanas_disponiveis: { semana_inicio: string; semana_fim: string }[];
  alertas: { tipo: 'atrasado' | 'fechar_semana' | 'sem_lancamento'; nome: string; semana_inicio: string; dias: number | null; meu: number | null }[];
};
type ClienteSw = { id: number; nome_estabelecimento: string; whatsapp: string | null; plano: string; valor_plano: number;
  vencimento: string; dias_atraso?: number; dias?: number };
type Ganhos = {
  meses: { mes: string; software_recebido: number; delivery_recebido: number; delivery_competencia: number; total_recebido: number }[];
  software: { mrr: number; pagantes: number; inadimplentes: ClienteSw[]; inadimplencia_total: number; a_vencer_7d: ClienteSw[] };
  delivery: { a_receber: number; em_andamento: number; repasse_a_pagar: number; top_90d: { nome: string; meu_liquido: number }[] };
  mes_atual: { recebido: number; previsto: number }; a_receber_total: number;
};

/* ───────────── utilidades ───────────── */

const brl = (n: number | null | undefined) =>
  (n ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pctFmt = (n: number) => `${(n ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 })}%`;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const isoToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
function weekStart(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`); return addDays(iso, -((d.getUTCDay() + 6) % 7));
}
/** "05 a 11/10" — igual ao rótulo da planilha. */
function weekLabel(ini: string, fim: string) {
  const [, , d1] = ini.split('-'); const [, m2, d2] = fim.split('-'); return `${d1} a ${d2}/${m2}`;
}
function monthLabel(ym: string) {
  const [y, m] = ym.split('-'); return `${['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][+m - 1]}/${y.slice(2)}`;
}
const fmtDate = (iso?: string | null) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');

/** Cálculo idêntico ao do servidor (usado só para pré-visualizar enquanto digita). */
function calc(v99: number, vif: number, vout: number, pMeu: number, pPar: number) {
  const base = v99 + vif + vout;
  const comissao = r2((base * (pMeu + pPar)) / 100);
  const repasse = r2((base * pPar) / 100);
  return { base, comissao, repasse, meu: r2(comissao - repasse) };
}
const num = (s: string) => { const n = parseFloat(s.replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const numToInput = (n: number) => (n ? n.toFixed(2).replace('.', ',') : '');
/** 1.128,45 -> "R$ 1,1 mil" (rótulos curtos de gráfico) */
const brlShort = (n: number) => (n >= 1000 ? `R$ ${(n / 1000).toFixed(1).replace('.', ',')} mil` : `R$ ${Math.round(n)}`);

const STATUS_META: Record<Status | 'sem_lancamento', { label: string; cls: string }> = {
  em_andamento: { label: 'Em andamento', cls: 'bg-[#e8f3fb] text-[#0369a1] border-[#bfdcef]' },
  aguardando: { label: 'Aguardando pagamento', cls: 'bg-[#fef3c7] text-[#b45309] border-[#f5d9a8]' },
  pago: { label: 'Pago', cls: 'bg-[#e8f5ec] text-[#15803d] border-[#bfe3c9]' },
  sem_lancamento: { label: 'Sem lançamento', cls: 'bg-[#f1f1f3] text-[#4f4c4a] border-[#e5e5e7]' },
};
const StatusChip = ({ s }: { s: Status | 'sem_lancamento' }) => (
  <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${STATUS_META[s].cls}`}>
    {STATUS_META[s].label}
  </span>
);

function useApi(token: string | null, onAuthError?: () => void) {
  return useCallback(async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`/api/admin${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 || res.status === 403) { onAuthError?.(); throw new Error('Sessão expirada.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as any)?.error || (data as any)?.message || 'Erro inesperado.');
    return data as T;
  }, [token, onAuthError]);
}

const Kpi = ({ label, value, hint, tone = 'default', icon }: {
  label: string; value: string; hint?: string; tone?: 'default' | 'good' | 'warn' | 'main'; icon?: React.ReactNode;
}) => (
  <Card className={`p-4 ${tone === 'main' ? '!border-[#ea1d2c] !bg-[#ea1d2c] text-[#ffffff]' : ''}`}>
    <div className="mb-1 flex items-center justify-between gap-2">
      <p className={`text-[11px] font-bold uppercase tracking-widest ${tone === 'main' ? 'text-[#ffe3e5]' : 'text-[#6f6b68]'}`}>{label}</p>
      <span className={tone === 'main' ? 'text-[#ffe3e5]' : 'text-[#a6a29f]'}>{icon}</span>
    </div>
    <p className={`text-xl font-black tabular-nums sm:text-2xl ${tone === 'main' ? 'text-[#ffffff]' : tone === 'good' ? 'text-[#15803d]' : tone === 'warn' ? 'text-[#b45309]' : 'text-[#3f3e3e]'}`}>{value}</p>
    {hint && <p className={`mt-0.5 text-xs ${tone === 'main' ? 'text-[#ffe3e5]' : 'text-[#7c7875]'}`}>{hint}</p>}
  </Card>
);

const Btn = ({ children, onClick, tone = 'ghost', disabled, title }: {
  children: React.ReactNode; onClick?: () => void; tone?: 'ghost' | 'primary' | 'danger'; disabled?: boolean; title?: string;
}) => (
  <button type="button" title={title} disabled={disabled} onClick={onClick}
    className={`inline-flex min-h-[36px] items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-bold transition-colors disabled:opacity-50 ${
      tone === 'primary' ? 'bg-[#ea1d2c] text-[#ffffff] shadow-sm hover:bg-[#9c050b] active:bg-[#a02331]'
      : tone === 'danger' ? 'bg-[#fdecee] text-[#a02331] hover:bg-[#fbd5d9]'
      : 'border border-[#d4d4d8] text-[#3f3e3e] hover:bg-[#f5f5f5]'}`}>
    {children}
  </button>
);

/* ═════════════════════════ componente principal ═════════════════════════ */

type SubTab = 'planilha' | 'ganhos' | 'visao' | 'lancar' | 'cadastro';

export default function AdminGestaoDelivery({ token, onAuthError, secao = 'gestao' }: { token: string | null; onAuthError?: () => void; secao?: 'gestao' | 'clientes' }) {
  const api = useApi(token, onAuthError);
  const [tab, setTab] = useState<SubTab>(secao === 'clientes' ? 'cadastro' : 'planilha');
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [version, setVersion] = useState(0); // incrementa para recarregar tudo após uma mutação
  const bump = () => setVersion((v) => v + 1);
  const notify = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok }); window.setTimeout(() => setToast(null), 3200);
  }, []);
  const fail = useCallback((e: unknown) => notify(e instanceof Error ? e.message : 'Erro inesperado.', false), [notify]);

  const todasAbas: { id: SubTab; label: string; icon: React.ReactNode }[] = [
    { id: 'planilha', label: 'Planilha', icon: <CalendarCheck size={15} /> },
    { id: 'ganhos', label: 'Ganhos (software + delivery)', icon: <Wallet size={15} /> },
    { id: 'cadastro', label: 'Restaurantes', icon: <Building2 size={15} /> },
  ];
  // "Clientes Gestão Delivery" = só cadastro; "Gestão Delivery" = planilha + ganhos
  const tabs = todasAbas.filter((t) => (secao === 'clientes' ? t.id === 'cadastro' : t.id !== 'cadastro'));

  return (
    <div className="min-w-0 space-y-4 rounded-2xl bg-[#f7f7f8] p-3 text-[#3f3e3e] [color-scheme:light] sm:p-5">
      <div className={`flex gap-1.5 overflow-x-auto pb-1 ${tabs.length < 2 ? 'hidden' : ''}`}>
        {tabs.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={`flex min-h-[40px] shrink-0 items-center gap-2 rounded-xl px-4 text-sm font-bold transition-colors ${
              tab === t.id ? 'bg-[#ea1d2c] text-[#ffffff] shadow-sm' : 'border border-[#e5e5e7] text-[#4f4c4a] hover:bg-[#f5f5f5]'}`}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {tab === 'ganhos' && <GanhosView api={api} version={version} notify={notify} fail={fail} bump={bump} />}
      {tab === 'visao' && <VisaoGeral api={api} version={version} notify={notify} fail={fail} bump={bump} goLancar={() => setTab('lancar')} />}
      {tab === 'planilha' && <Planilha api={api} version={version} notify={notify} fail={fail} bump={bump} />}
      {tab === 'lancar' && <LancarSemana api={api} version={version} notify={notify} fail={fail} bump={bump} />}
      {tab === 'cadastro' && <Cadastro api={api} version={version} notify={notify} fail={fail} bump={bump} />}

      {toast && (
        <div className={`fixed bottom-5 left-1/2 z-[90] -translate-x-1/2 rounded-xl px-4 py-2.5 text-sm font-bold shadow-xl ${
          toast.ok ? 'bg-[#15803d] text-[#ffffff]' : 'bg-[#b91c1c] text-[#ffffff]'}`}>{toast.msg}</div>
      )}
    </div>
  );
}

type Shared = {
  api: ReturnType<typeof useApi>; version: number; bump: () => void;
  notify: (m: string, ok?: boolean) => void; fail: (e: unknown) => void;
};

const Loading = () => (
  <div className="flex items-center justify-center py-16 text-[#7c7875]"><Loader2 className="animate-spin" size={22} /></div>
);

/* ═════════════════════════ GANHOS (software + delivery) ═════════════════════════ */

function GanhosView({ api, version, notify, fail, bump }: Shared) {
  const [g, setG] = useState<Ganhos | null>(null);
  const [payFor, setPayFor] = useState<ClienteSw | null>(null);

  useEffect(() => { api<Ganhos>('GET', '/ganhos?meses=6').then(setG).catch(fail); }, [api, version, fail]);
  if (!g) return <Loading />;

  const maxBar = Math.max(1, ...g.meses.map((m) => m.software_recebido + m.delivery_recebido));
  const mesAtual = g.meses[g.meses.length - 1];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi tone="main" label="Recebido no mês" value={brl(g.mes_atual.recebido)} icon={<Coins size={16} />}
          hint={`Software ${brl(mesAtual?.software_recebido)} · Delivery ${brl(mesAtual?.delivery_recebido)}`} />
        <Kpi label="Previsto no mês" value={brl(g.mes_atual.previsto)} icon={<TrendingUp size={16} />}
          hint={`MRR ${brl(g.software.mrr)} + delivery do mês ${brl(mesAtual?.delivery_competencia)}`} />
        <Kpi tone="warn" label="A receber (total)" value={brl(g.a_receber_total)} icon={<Clock size={16} />}
          hint={`Delivery ${brl(g.delivery.a_receber + g.delivery.em_andamento)} · Atrasos software ${brl(g.software.inadimplencia_total)}`} />
        <Kpi label="Repasse a parceiros" value={brl(g.delivery.repasse_a_pagar)} icon={<HandCoins size={16} />}
          hint="Pendente de pagar" tone={g.delivery.repasse_a_pagar > 0 ? 'warn' : 'default'} />
      </div>

      <Card className="p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-black text-[#3f3e3e]">Recebido por mês</h3>
          <div className="flex items-center gap-3 text-[11px] font-bold text-[#6f6b68]">
            <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-[#ea1d2c]" />Software</span>
            <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-[#3f3e3e]" />Delivery</span>
          </div>
        </div>
        <div className="flex h-44 items-end gap-1 sm:gap-4">
          {g.meses.map((m) => {
            const hs = (m.software_recebido / maxBar) * 100, hd = (m.delivery_recebido / maxBar) * 100;
            return (
              <div key={m.mes} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                <span className="whitespace-nowrap text-[10px] font-bold tabular-nums text-[#4f4c4a] sm:text-[11px]">{m.total_recebido ? brlShort(m.total_recebido) : ''}</span>
                <div className="flex w-full max-w-[56px] flex-1 flex-col justify-end overflow-hidden rounded-t-md">
                  <div className="w-full bg-[#3f3e3e]" style={{ height: `${hd}%` }} title={`Delivery ${brl(m.delivery_recebido)}`} />
                  <div className="w-full bg-[#ea1d2c]" style={{ height: `${hs}%` }} title={`Software ${brl(m.software_recebido)}`} />
                </div>
                <span className="text-[11px] font-bold text-[#7c7875]">{monthLabel(m.mes)}</span>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] text-[#7c7875]">
          Delivery = só o que já caiu na sua conta (semanas marcadas como pagas, por data de pagamento).
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4 sm:p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-black text-[#3f3e3e]">Mensalidades em atraso</h3>
            <span className="text-xs font-bold text-[#a02331]">{brl(g.software.inadimplencia_total)}</span>
          </div>
          {g.software.inadimplentes.length === 0
            ? <p className="py-4 text-center text-sm text-[#7c7875]">Nenhum cliente em atraso 🎉</p>
            : <ul className="divide-y divide-[#e5e5e7]">{g.software.inadimplentes.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-[#3f3e3e]">{c.nome_estabelecimento}</p>
                  <p className="text-xs text-[#7c7875]">{c.plano} · venceu há {c.dias_atraso} dia(s) · {brl(c.valor_plano)}</p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  {c.whatsapp && <a className="rounded-lg border border-[#d4d4d8] p-2 text-[#4f4c4a] hover:bg-[#f5f5f5]" title="WhatsApp"
                    target="_blank" rel="noreferrer"
                    href={`https://wa.me/55${c.whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(`Olá! Sua mensalidade do sistema (${brl(c.valor_plano)}) venceu em ${fmtDate(c.vencimento)}. Posso enviar o PIX?`)}`}><MessageCircle size={14} /></a>}
                  <Btn tone="primary" onClick={() => setPayFor(c)}><BadgeCheck size={14} />Recebi</Btn>
                </div>
              </li>))}</ul>}
        </Card>

        <Card className="p-4 sm:p-5">
          <h3 className="mb-3 text-sm font-black text-[#3f3e3e]">Vencem nos próximos 7 dias</h3>
          {g.software.a_vencer_7d.length === 0
            ? <p className="py-4 text-center text-sm text-[#7c7875]">Nada vencendo esta semana.</p>
            : <ul className="divide-y divide-[#e5e5e7]">{g.software.a_vencer_7d.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-[#3f3e3e]">{c.nome_estabelecimento}</p>
                  <p className="text-xs text-[#7c7875]">{c.plano} · em {c.dias} dia(s) · {brl(c.valor_plano)}</p>
                </div>
                <Btn onClick={() => setPayFor(c)}><BadgeCheck size={14} />Registrar</Btn>
              </li>))}</ul>}
          <div className="mt-4 border-t border-[#e5e5e7] pt-3 text-xs text-[#7c7875]">
            MRR atual <b className="text-[#4f4c4a]">{brl(g.software.mrr)}</b> · {g.software.pagantes} cliente(s) pagante(s)
          </div>
        </Card>
      </div>

      {g.delivery.top_90d.length > 0 && (
        <Card className="p-4 sm:p-5">
          <h3 className="mb-3 text-sm font-black text-[#3f3e3e]">Quem mais rende no delivery (90 dias)</h3>
          <ul className="space-y-2">{g.delivery.top_90d.map((t) => {
            const max = g.delivery.top_90d[0].meu_liquido || 1;
            return (<li key={t.nome} className="flex items-center gap-3 text-sm">
              <span className="w-24 shrink-0 truncate text-xs font-bold text-[#3f3e3e] sm:w-40 sm:text-sm">{t.nome}</span>
              <div className="h-2 min-w-[40px] flex-1 rounded-full bg-[#ededee]"><div className="h-2 rounded-full bg-[#ea1d2c]" style={{ width: `${(t.meu_liquido / max) * 100}%` }} /></div>
              <span className="w-24 shrink-0 text-right text-xs font-black tabular-nums text-[#3f3e3e] sm:w-28 sm:text-sm">{brl(t.meu_liquido)}</span>
            </li>);
          })}</ul>
        </Card>
      )}

      <PagamentoSoftwareModal cliente={payFor} api={api} onClose={() => setPayFor(null)}
        onDone={() => { setPayFor(null); notify('Pagamento registrado e vencimento renovado.'); bump(); }} fail={fail} />
    </div>
  );
}

function PagamentoSoftwareModal({ cliente, api, onClose, onDone, fail }: {
  cliente: ClienteSw | null; api: Shared['api']; onClose: () => void; onDone: () => void; fail: (e: unknown) => void;
}) {
  const [valor, setValor] = useState(''); const [dias, setDias] = useState('30'); const [forma, setForma] = useState('pix');
  const [data, setData] = useState(isoToday()); const [busy, setBusy] = useState(false);
  useEffect(() => { if (cliente) { setValor(numToInput(cliente.valor_plano)); setDias('30'); setForma('pix'); setData(isoToday()); } }, [cliente]);
  if (!cliente) return null;
  const submit = async () => {
    setBusy(true);
    try {
      await api('POST', `/gestao-delivery/software/${cliente.id}/pagamento`,
        { valor: num(valor), dias: parseInt(dias, 10) || 30, forma, data_pagamento: data });
      onDone();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Mensalidade — ${cliente.nome_estabelecimento}`}>
      <div className="space-y-3 p-4">
        <label className="block"><span className={fieldLabelClass}>Valor recebido (R$)</span>
          <input className={fieldInputClass} inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className={fieldLabelClass}>Renovar por (dias)</span>
            <input className={fieldInputClass} inputMode="numeric" value={dias} onChange={(e) => setDias(e.target.value)} /></label>
          <label className="block"><span className={fieldLabelClass}>Data do pagamento</span>
            <input type="date" className={fieldInputClass} value={data} onChange={(e) => setData(e.target.value)} /></label>
        </div>
        <label className="block"><span className={fieldLabelClass}>Forma</span>
          <select className={fieldInputClass} value={forma} onChange={(e) => setForma(e.target.value)}>
            <option value="pix">PIX</option><option value="dinheiro">Dinheiro</option><option value="cartao">Cartão</option><option value="boleto">Boleto</option>
          </select></label>
        <p className="text-xs text-[#7c7875]">O vencimento é somado a partir do maior entre hoje e o vencimento atual.</p>
        <div className="flex justify-end gap-2 pt-1"><Btn onClick={onClose}>Cancelar</Btn>
          <Btn tone="primary" disabled={busy} onClick={submit}>{busy ? 'Salvando…' : 'Confirmar pagamento'}</Btn></div>
      </div>
    </Modal>
  );
}

/* ═════════════════════════ VISÃO GERAL DO DELIVERY ═════════════════════════ */

function VisaoGeral({ api, version, notify, fail, bump, goLancar }: Shared & { goLancar: () => void }) {
  const [semana, setSemana] = useState<string>('todas');
  const [est, setEst] = useState<string>('');
  const [r, setR] = useState<Resumo | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    const qs = new URLSearchParams({ semana, ...(est ? { estabelecimento: est } : {}) });
    api<Resumo>('GET', `/gestao-delivery/resumo?${qs}`).then(setR).catch(fail);
  }, [api, semana, est, version, fail]);

  const allEst = useMemo(() => r?.por_estabelecimento ?? [], [r]);
  if (!r) return <Loading />;
  const t = r.totais;
  const confere = Math.abs(t.comissao_bruta - t.repasse_parceiro - t.meu_liquido) < 0.01;

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-3 p-3 sm:p-4">
        <label className="min-w-[180px]"><span className={fieldLabelClass}>Semana</span>
          <select className={fieldInputClass} value={semana} onChange={(e) => setSemana(e.target.value)}>
            <option value="todas">Todas as semanas</option>
            {r.semanas_disponiveis.map((s) => <option key={s.semana_inicio} value={s.semana_inicio}>{weekLabel(s.semana_inicio, s.semana_fim)} ({s.semana_inicio.slice(0, 4)})</option>)}
          </select></label>
        <label className="min-w-[180px]"><span className={fieldLabelClass}>Estabelecimento</span>
          <select className={fieldInputClass} value={est} onChange={(e) => setEst(e.target.value)}>
            <option value="">Todos</option>
            {allEst.map((e) => <option key={e.estabelecimento_id} value={e.estabelecimento_id}>{e.nome}</option>)}
          </select></label>
        <div className="ml-auto flex items-center gap-2">
          <span className={`text-xs font-bold ${confere ? 'text-[#15803d]' : 'text-[#b91c1c]'}`}>{confere ? '✔ Conciliado' : '⚠ Divergência'}</span>
          <Btn tone="primary" onClick={goLancar}><Plus size={14} />Lançar semana</Btn>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi tone="main" label="Meu líquido" value={brl(t.meu_liquido)} hint="Já descontado o parceiro" icon={<Coins size={16} />} />
        <Kpi tone="good" label="Já recebi" value={brl(t.recebido)} icon={<BadgeCheck size={16} />} />
        <Kpi tone="warn" label="A receber" value={brl(t.a_receber)} hint={`+ ${brl(t.em_andamento)} em andamento`} icon={<Clock size={16} />} />
        <Kpi label="Repasse a pagar" value={brl(t.repasse_a_pagar)} hint={`Total parceiros ${brl(t.repasse_parceiro)}`} icon={<HandCoins size={16} />} />
        <Kpi label="Gerenciado" value={brl(t.gerenciado)} hint="Líquido dos donos nos apps" />
        <Kpi label="Comissão bruta" value={brl(t.comissao_bruta)} />
        <Kpi label="Margem líquida" value={t.gerenciado ? pctFmt((t.meu_liquido / t.gerenciado) * 100) : '—'} hint="Meu líquido ÷ gerenciado" />
        <Kpi label="Ativos" value={String(allEst.filter((e) => e.ativo).length)} hint="restaurantes gerenciados" icon={<Building2 size={16} />} />
      </div>

      {r.alertas.length > 0 && (
        <Card className="border-[#f5d9a8] p-4">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-black text-[#b45309]"><AlertTriangle size={16} />Pendências</h3>
          <ul className="space-y-1 text-sm text-[#4f4c4a]">
            {r.alertas.slice(0, 8).map((a, i) => (
              <li key={i}>
                {a.tipo === 'atrasado' && <>⏰ <b>{a.nome}</b> deve a semana {fmtDate(a.semana_inicio)} há {a.dias} dias ({brl(a.meu)})</>}
                {a.tipo === 'fechar_semana' && <>📌 <b>{a.nome}</b>: semana {fmtDate(a.semana_inicio)} já terminou, falta fechar e cobrar</>}
                {a.tipo === 'sem_lancamento' && <>📝 <b>{a.nome}</b> não tem lançamento da semana {fmtDate(a.semana_inicio)}</>}
              </li>))}
          </ul>
        </Card>
      )}

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <tbody><tr className="border-b border-[#e5e5e7] text-left text-[11px] uppercase tracking-wider text-[#7c7875]">
            <th className="p-3">Estabelecimento</th><th className="p-3 text-right">Gerenciado</th><th className="p-3 text-right">Comissão</th>
            <th className="p-3 text-right">Parceiro</th><th className="p-3 text-right">Meu líquido</th><th className="p-3 text-right">Recebido</th>
            <th className="p-3 text-right">A receber</th><th className="p-3">Status</th><th className="p-3" /></tr></tbody>
          <tbody>
            {r.por_estabelecimento.map((e) => (
              <React.Fragment key={e.estabelecimento_id}>
                <tr className="cursor-pointer border-b border-[#f1f1f3] hover:bg-[#faf9f9]" onClick={() => setOpen(open === e.estabelecimento_id ? null : e.estabelecimento_id)}>
                  <td className="p-3"><p className="font-bold text-[#3f3e3e]">{e.nome}</p>
                    <p className="text-[11px] text-[#7c7875]">{pctFmt(e.pct_meu)} meu{e.tem_parceiro ? ` + ${pctFmt(e.pct_parceiro)} parceiro` : ' · sem parceiro'}</p></td>
                  <td className="p-3 text-right tabular-nums">{brl(e.gerenciado)}</td>
                  <td className="p-3 text-right tabular-nums">{brl(e.comissao_bruta)}</td>
                  <td className="p-3 text-right tabular-nums text-[#6f6b68]">{e.repasse_parceiro ? brl(e.repasse_parceiro) : '—'}</td>
                  <td className="p-3 text-right font-black tabular-nums text-[#3f3e3e]">{brl(e.meu_liquido)}</td>
                  <td className="p-3 text-right tabular-nums text-[#15803d]">{brl(e.recebido)}</td>
                  <td className="p-3 text-right tabular-nums text-[#b45309]">{brl(e.a_receber + e.em_andamento)}</td>
                  <td className="p-3"><StatusChip s={e.status} /></td>
                  <td className="p-3 text-[#7c7875]"><ChevronDown size={16} className={open === e.estabelecimento_id ? 'rotate-180' : ''} /></td>
                </tr>
                {open === e.estabelecimento_id && (
                  <tr><td colSpan={9} className="bg-[#faf9f9] p-0"><EstDetalhe estId={e.estabelecimento_id} api={api} version={version} notify={notify} fail={fail} bump={bump} /></td></tr>)}
              </React.Fragment>))}
          </tbody>
        </table>
      </Card>

      <Card className="overflow-x-auto">
        <h3 className="px-4 pt-4 text-sm font-black text-[#3f3e3e]">Semana a semana — meu líquido</h3>
        <table className="mt-2 w-full min-w-[760px] text-sm">
          <tbody><tr className="border-b border-[#e5e5e7] text-left text-[11px] uppercase tracking-wider text-[#7c7875]">
            <th className="p-3">Semana</th><th className="p-3 text-right">Gerenciado</th><th className="p-3 text-right">Comissão</th>
            <th className="p-3 text-right">Repasse</th><th className="p-3 text-right">Meu líquido</th>
            {allEst.filter((e) => e.ativo).map((e) => <th key={e.estabelecimento_id} className="p-3 text-right">{e.nome.split(' ')[0]}</th>)}
            <th className="p-3">Pendência</th></tr></tbody>
          <tbody>
            {r.semanas.map((s) => (
              <tr key={s.semana_inicio} className="border-b border-[#f1f1f3]">
                <td className="p-3 font-bold text-[#3f3e3e]">{weekLabel(s.semana_inicio, s.semana_fim)}</td>
                <td className="p-3 text-right tabular-nums">{brl(s.gerenciado)}</td>
                <td className="p-3 text-right tabular-nums">{brl(s.comissao_bruta)}</td>
                <td className="p-3 text-right tabular-nums text-[#6f6b68]">{s.repasse_parceiro ? brl(s.repasse_parceiro) : '—'}</td>
                <td className="p-3 text-right font-black tabular-nums text-[#3f3e3e]">{brl(s.meu_liquido)}</td>
                {allEst.filter((e) => e.ativo).map((e) => {
                  const p = s.por_estabelecimento.find((x) => x.estabelecimento_id === e.estabelecimento_id);
                  return <td key={e.estabelecimento_id} className={`p-3 text-right tabular-nums ${p?.status === 'pago' ? 'text-[#15803d]' : 'text-[#4f4c4a]'}`}>{p ? brl(p.meu) : '—'}</td>;
                })}
                <td className="p-3">{s.n_aguardando > 0 ? <StatusChip s="aguardando" /> : s.n_andamento > 0 ? <StatusChip s="em_andamento" /> : <span className="text-xs font-bold text-[#15803d]">Quitada</span>}</td>
              </tr>))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/** Detalhe de um estabelecimento: histórico, baixa em lote, cobrança por WhatsApp. */
function EstDetalhe({ estId, api, version, notify, fail, bump }: Shared & { estId: number }) {
  const [rows, setRows] = useState<Lancamento[] | null>(null);
  const [est, setEst] = useState<Estabelecimento | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());

  useEffect(() => {
    Promise.all([
      api<Lancamento[]>('GET', `/gestao-delivery/estabelecimentos/${estId}/lancamentos`),
      api<Estabelecimento[]>('GET', '/gestao-delivery/estabelecimentos'),
    ]).then(([l, e]) => { setRows(l); setEst(e.find((x) => x.id === estId) ?? null); setSel(new Set()); }).catch(fail);
  }, [api, estId, version, fail]);

  if (!rows) return <div className="p-4"><Loading /></div>;
  const abertas = rows.filter((x) => x.status !== 'pago');
  const selRows = rows.filter((x) => sel.has(x.id));
  const totalSel = selRows.reduce((s, x) => s + x.meu, 0);

  const cobranca = () => {
    const linhas = (selRows.length ? selRows : abertas.filter((x) => x.status === 'aguardando'));
    if (!linhas.length) return notify('Nenhuma semana aguardando pagamento.', false);
    const total = linhas.reduce((s, x) => s + x.comissao, 0);
    const msg = [`Olá${est?.responsavel ? `, ${est.responsavel.split(' ')[0]}` : ''}! Segue o fechamento da gestão do delivery:`, '',
      ...linhas.map((x) => `• ${weekLabel(x.semana_inicio, x.semana_fim)}: líquido ${brl(x.base)} → comissão ${brl(x.comissao)}`),
      '', `Total a pagar: ${brl(total)}`, est?.pix_chave ? `PIX: ${est.pix_chave}` : '', 'Obrigado!'].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
    navigator.clipboard?.writeText(msg).then(() => notify('Cobrança copiada. É só colar no WhatsApp.'));
    if (est?.whatsapp) window.open(`https://wa.me/55${est.whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(msg)}`, '_blank');
  };
  const baixar = async () => {
    try { await api('POST', '/gestao-delivery/lancamentos/pagar-lote', { ids: [...sel] }); notify(`${sel.size} semana(s) marcadas como pagas.`); bump(); } catch (e) { fail(e); }
  };
  const setRepasse = async (l: Lancamento, v: boolean) => {
    try { await api('PATCH', `/gestao-delivery/lancamentos/${l.id}`, { repasse_pago: v }); bump(); } catch (e) { fail(e); }
  };

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Btn onClick={cobranca}><ClipboardCopy size={14} />Gerar cobrança{selRows.length ? ` (${selRows.length})` : ''}</Btn>
        <Btn tone="primary" disabled={!sel.size} onClick={baixar}><BadgeCheck size={14} />Marcar {sel.size || ''} como paga{sel.size > 1 ? 's' : ''}{sel.size ? ` · ${brl(totalSel)}` : ''}</Btn>
        {est?.pix_chave && <span className="text-xs text-[#7c7875]">PIX {est.pix_tipo}: <b className="text-[#4f4c4a]">{est.pix_chave}</b></span>}
      </div>
      <table className="w-full min-w-[640px] text-xs">
        <tbody><tr className="text-left uppercase tracking-wider text-[#7c7875]"><th className="p-2" /><th className="p-2">Semana</th>
          <th className="p-2 text-right">99Food</th><th className="p-2 text-right">iFood</th><th className="p-2 text-right">Comissão</th>
          <th className="p-2 text-right">Parceiro</th><th className="p-2 text-right">Meu</th><th className="p-2">Status</th><th className="p-2">Repasse</th></tr></tbody>
        <tbody>{rows.map((l) => (
          <tr key={l.id} className="border-t border-[#f1f1f3]">
            <td className="p-2"><input className="accent-[#ea1d2c]" type="checkbox" disabled={l.status === 'pago'} checked={sel.has(l.id)}
              onChange={(e) => setSel((p) => { const n = new Set(p); e.target.checked ? n.add(l.id) : n.delete(l.id); return n; })} /></td>
            <td className="p-2 font-bold text-[#3f3e3e]">{weekLabel(l.semana_inicio, l.semana_fim)}</td>
            <td className="p-2 text-right tabular-nums">{brl(l.valor_99food)}</td><td className="p-2 text-right tabular-nums">{brl(l.valor_ifood)}</td>
            <td className="p-2 text-right tabular-nums">{brl(l.comissao)} <span className="text-[#a6a29f]">({pctFmt(l.pct_meu_snap + l.pct_parceiro_snap)})</span></td>
            <td className="p-2 text-right tabular-nums text-[#6f6b68]">{l.repasse ? brl(l.repasse) : '—'}</td>
            <td className="p-2 text-right font-black tabular-nums text-[#3f3e3e]">{brl(l.meu)}</td>
            <td className="p-2"><StatusChip s={l.status} />{l.data_pagamento && <span className="ml-1 text-[#7c7875]">{fmtDate(l.data_pagamento)}</span>}</td>
            <td className="p-2">{l.repasse > 0 ? (l.status === 'em_andamento' ? <span className="text-[#a6a29f]">—</span> :
              <label className="flex items-center gap-1.5 text-[#4f4c4a]"><input className="accent-[#ea1d2c]" type="checkbox" checked={l.repasse_pago} onChange={(e) => setRepasse(l, e.target.checked)} />{l.repasse_pago ? 'pago' : 'pendente'}</label>) : <span className="text-[#a6a29f]">—</span>}</td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

/* ═════════════════════════ LANÇAR SEMANA ═════════════════════════ */

type Draft = { v99: string; vif: string; vout: string };
type SemanaItem = Estabelecimento & { lancamento: Lancamento | null };

function LancarSemana({ api, version, notify, fail, bump }: Shared) {
  // Padrão: segunda/terça você ainda está fechando a semana anterior; nos outros dias, a semana corrente.
  const [ini, setIni] = useState(() => {
    const hoje = isoToday();
    const dow = (new Date(`${hoje}T00:00:00Z`).getUTCDay() + 6) % 7; // seg=0
    return dow <= 1 ? addDays(weekStart(hoje), -7) : weekStart(hoje);
  });
  const [data, setData] = useState<{ semana_inicio: string; semana_fim: string; itens: SemanaItem[] } | null>(null);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [saving, setSaving] = useState<number | null>(null);

  const load = useCallback(() => {
    api<{ semana_inicio: string; semana_fim: string; itens: SemanaItem[] }>('GET', `/gestao-delivery/semana?inicio=${ini}`)
      .then((d) => {
        setData(d);
        const dr: Record<number, Draft> = {};
        d.itens.forEach((i) => { dr[i.id] = { v99: numToInput(i.lancamento?.valor_99food ?? 0), vif: numToInput(i.lancamento?.valor_ifood ?? 0), vout: numToInput(i.lancamento?.valor_outros ?? 0) }; });
        setDrafts(dr);
      }).catch(fail);
  }, [api, ini, fail]);
  useEffect(() => { load(); }, [load, version]);

  const save = async (i: SemanaItem) => {
    const d = drafts[i.id]; if (!d) return;
    const [a, b, c] = [num(d.v99), num(d.vif), num(d.vout)];
    const cur = i.lancamento;
    if (cur && cur.valor_99food === a && cur.valor_ifood === b && cur.valor_outros === c) return; // nada mudou
    if (!cur && !a && !b && !c) return;
    setSaving(i.id);
    try {
      const res = await api<{ lancamento: Lancamento }>('PUT', '/gestao-delivery/lancamentos',
        { estabelecimento_id: i.id, semana_inicio: ini, valor_99food: a, valor_ifood: b, valor_outros: c });
      setData((p) => p && { ...p, itens: p.itens.map((x) => (x.id === i.id ? { ...x, lancamento: res.lancamento } : x)) });
    } catch (e) { fail(e); } finally { setSaving(null); }
  };
  const patch = async (l: Lancamento, body: Record<string, unknown>) => {
    try { await api('PATCH', `/gestao-delivery/lancamentos/${l.id}`, body); load(); bump(); } catch (e) { fail(e); }
  };
  const fechar = async () => {
    try { const r = await api<{ fechados: number }>('POST', `/gestao-delivery/semanas/${ini}/fechar`);
      notify(r.fechados ? `${r.fechados} lançamento(s) fechados — agora é só cobrar.` : 'Nada para fechar nesta semana.', r.fechados > 0); load(); bump(); } catch (e) { fail(e); }
  };

  if (!data) return <Loading />;
  const itens = data.itens;
  const totalMeu = itens.reduce((s, i) => {
    const d = drafts[i.id]; const l = i.lancamento;
    const pm = l ? l.pct_meu_snap : i.pct_meu, pp = l ? l.pct_parceiro_snap : i.pct_parceiro;
    return s + (d ? calc(num(d.v99), num(d.vif), num(d.vout), pm, pp).meu : 0);
  }, 0);
  const isFuture = ini > weekStart(isoToday());

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-3 p-3 sm:p-4">
        <Btn onClick={() => setIni(addDays(ini, -7))}><ChevronLeft size={16} /></Btn>
        <div className="text-center">
          <p className="text-lg font-black text-[#3f3e3e]">{weekLabel(data.semana_inicio, data.semana_fim)} <span className="text-sm font-bold text-[#7c7875]">/{data.semana_inicio.slice(0, 4)}</span></p>
          <p className="text-[11px] text-[#7c7875]">segunda a domingo</p>
        </div>
        <Btn onClick={() => setIni(addDays(ini, 7))} disabled={isFuture}><ChevronRight size={16} /></Btn>
        <div className="ml-auto flex items-center gap-3">
          <p className="text-sm text-[#6f6b68]">Meu líquido da semana <b className="text-lg text-[#15803d]">{brl(totalMeu)}</b></p>
          <Btn tone="primary" onClick={fechar}><CalendarCheck size={14} />Fechar semana</Btn>
        </div>
      </Card>

      {itens.length === 0 ? (
        <Card className="p-8 text-center text-sm text-[#7c7875]">Cadastre um estabelecimento em “Clientes Gestão Delivery” para começar.</Card>
      ) : (
        <div className="space-y-3">
          {itens.map((i) => {
            const d = drafts[i.id] ?? { v99: '', vif: '', vout: '' };
            const l = i.lancamento;
            const pm = l ? l.pct_meu_snap : i.pct_meu, pp = l ? l.pct_parceiro_snap : i.pct_parceiro;
            const c = calc(num(d.v99), num(d.vif), num(d.vout), pm, pp);
            const set = (k: keyof Draft, v: string) => setDrafts((p) => ({ ...p, [i.id]: { ...d, [k]: v } }));
            const locked = l?.status === 'pago';
            const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); };
            return (
              <Card key={i.id} className={`p-4 ${locked ? 'opacity-90' : ''}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-black text-[#3f3e3e]">{i.nome} {saving === i.id && <Loader2 size={13} className="ml-1 inline animate-spin text-[#7c7875]" />}</p>
                    <p className="text-[11px] text-[#7c7875]">{pctFmt(pm)} meu{i.tem_parceiro || pp > 0 ? ` + ${pctFmt(pp)} ${i.parceiro_nome || 'parceiro'}` : ' · sem parceiro'}
                      {l && (pm !== i.pct_meu || pp !== i.pct_parceiro) && <span className="ml-1 text-[#b45309]">(taxa da época; hoje {pctFmt(i.pct_meu + i.pct_parceiro)})</span>}</p>
                  </div>
                  <StatusChip s={l?.status ?? 'sem_lancamento'} />
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-6">
                  {i.apps.includes('99food') && <label><span className={fieldLabelClass}>Líquido 99Food</span>
                    <input className={fieldInputClass} inputMode="decimal" placeholder="0,00" disabled={locked} value={d.v99} onChange={(e) => set('v99', e.target.value)} onBlur={() => save(i)} onKeyDown={onKey} /></label>}
                  {i.apps.includes('ifood') && <label><span className={fieldLabelClass}>Líquido iFood</span>
                    <input className={fieldInputClass} inputMode="decimal" placeholder="0,00" disabled={locked} value={d.vif} onChange={(e) => set('vif', e.target.value)} onBlur={() => save(i)} onKeyDown={onKey} /></label>}
                  {i.apps.includes('outros') && <label><span className={fieldLabelClass}>Outros</span>
                    <input className={fieldInputClass} inputMode="decimal" placeholder="0,00" disabled={locked} value={d.vout} onChange={(e) => set('vout', e.target.value)} onBlur={() => save(i)} onKeyDown={onKey} /></label>}
                  <div><span className={fieldLabelClass}>Total dono</span><p className="pt-2.5 text-sm font-bold tabular-nums text-[#3f3e3e]">{brl(c.base)}</p></div>
                  <div><span className={fieldLabelClass}>Comissão</span><p className="pt-2.5 text-sm font-bold tabular-nums text-[#3f3e3e]">{brl(c.comissao)}{c.repasse > 0 && <span className="block text-[11px] font-normal text-[#7c7875]">parceiro {brl(c.repasse)}</span>}</p></div>
                  <div><span className={fieldLabelClass}>Meu líquido</span><p className="pt-2 text-lg font-black tabular-nums text-[#15803d]">{brl(c.meu)}</p></div>
                </div>

                {l && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#e5e5e7] pt-3">
                    {l.status === 'em_andamento' && <Btn onClick={() => patch(l, { status: 'aguardando' })}><Clock size={14} />Fechar e cobrar</Btn>}
                    {l.status !== 'pago' && <Btn tone="primary" onClick={() => patch(l, { status: 'pago' })}><BadgeCheck size={14} />Recebi</Btn>}
                    {l.status === 'pago' && <><span className="text-xs text-[#15803d]">Pago{l.data_pagamento ? ` em ${fmtDate(l.data_pagamento)}` : ''}</span><Btn onClick={() => patch(l, { status: 'aguardando' })}>Desfazer</Btn></>}
                    {l.repasse > 0 && l.status !== 'em_andamento' && (
                      <label className="ml-auto flex items-center gap-2 text-xs text-[#4f4c4a]">
                        <input className="accent-[#ea1d2c]" type="checkbox" checked={l.repasse_pago} onChange={(e) => patch(l, { repasse_pago: e.target.checked })} />
                        Repasse de {brl(l.repasse)} ao parceiro: {l.repasse_pago ? `pago${l.repasse_data ? ` em ${fmtDate(l.repasse_data)}` : ''}` : 'pendente'}
                      </label>)}
                  </div>)}
              </Card>
            );
          })}
        </div>
      )}
      <p className="text-center text-[11px] text-[#a6a29f]">Os valores salvam sozinhos ao sair do campo (ou Enter). A taxa usada é a do momento do primeiro lançamento da semana.</p>
    </div>
  );
}

/* ═════════════════════════ PLANILHA (tudo junto, com filtros) ═════════════════════════ */

type LancRow = Lancamento & { nome: string; tem_parceiro: boolean; parceiro_nome: string | null; ativo: boolean };
/** Uma linha = um restaurante em uma semana (como a planilha). `l` é null enquanto a semana não foi lançada. */
type Linha = { key: string; est: Estabelecimento | null; estId: number; nome: string; ini: string; fim: string; l: LancRow | null };

const cellInput =
  'w-[88px] rounded-lg border border-[#e5e5e7] bg-[#ffffff] px-2 py-1.5 text-right text-xs tabular-nums text-[#3f3e3e] placeholder:text-[#c4c0bd] focus:border-[#ea1d2c] focus:outline-none focus:ring-2 focus:ring-[#ea1d2c]/20 disabled:cursor-not-allowed disabled:bg-[#f7f7f8] disabled:text-[#7c7875]';
const selectCls =
  'rounded-lg border border-[#e5e5e7] bg-[#ffffff] px-2 py-1.5 text-xs font-bold text-[#3f3e3e] focus:border-[#ea1d2c] focus:outline-none focus:ring-2 focus:ring-[#ea1d2c]/20';

function Planilha({ api, version, notify, fail }: Shared) {
  const [ests, setEsts] = useState<Estabelecimento[] | null>(null);
  const [lancs, setLancs] = useState<LancRow[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busca, setBusca] = useState('');
  const [estId, setEstId] = useState('');
  const [status, setStatus] = useState('');
  const [periodo, setPeriodo] = useState('todos');

  const load = useCallback(() => {
    Promise.all([
      api<Estabelecimento[]>('GET', '/gestao-delivery/estabelecimentos'),
      api<LancRow[]>('GET', '/gestao-delivery/lancamentos'),
    ]).then(([e, l]) => { setEsts(e); setLancs(l); setDrafts({}); setSel(new Set()); }).catch(fail);
  }, [api, fail]);
  useEffect(() => { load(); }, [load, version]);

  const hoje = isoToday();
  const semAtual = weekStart(hoje);

  const linhas = useMemo<Linha[]>(() => {
    if (!ests || !lancs) return [];
    const byId = new Map(ests.map((e) => [e.id, e] as const));
    const map = new Map<string, Linha>();
    lancs.forEach((l) => {
      const key = `${l.estabelecimento_id}|${l.semana_inicio}`;
      map.set(key, { key, est: byId.get(l.estabelecimento_id) ?? null, estId: l.estabelecimento_id, nome: l.nome, ini: l.semana_inicio, fim: l.semana_fim, l });
    });
    // Semana atual e anterior já aparecem prontas para preencher (restaurantes ativos).
    ests.filter((e) => e.ativo).forEach((e) => [semAtual, addDays(semAtual, -7)].forEach((s) => {
      const key = `${e.id}|${s}`;
      if (map.has(key) || (e.inicio_em && addDays(s, 6) < e.inicio_em.slice(0, 10))) return;
      map.set(key, { key, est: e, estId: e.id, nome: e.nome, ini: s, fim: addDays(s, 6), l: null });
    }));
    return [...map.values()].sort((a, b) => b.ini.localeCompare(a.ini) || a.nome.localeCompare(b.nome, 'pt-BR'));
  }, [ests, lancs, semAtual]);

  const mesIni = `${hoje.slice(0, 7)}-01`;
  const mesPassadoIni = (() => { const d = new Date(`${mesIni}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); })();
  const noPeriodo = (r: Linha) => {
    switch (periodo) {
      case 'mes': return r.fim >= mesIni;
      case 'mes_passado': return r.fim >= mesPassadoIni && r.ini < mesIni;
      case '90d': return r.fim >= addDays(hoje, -90);
      case 'ano': return r.fim >= `${hoje.slice(0, 4)}-01-01`;
      default: return true;
    }
  };
  const filtradas = useMemo(() => linhas.filter((r) => {
    if (estId && r.estId !== Number(estId)) return false;
    if (busca && !r.nome.toLowerCase().includes(busca.trim().toLowerCase())) return false;
    if (!noPeriodo(r)) return false;
    const st = r.l?.status ?? 'sem_lancamento';
    if (status === 'repasse_pendente') return !!r.l && r.l.repasse > 0 && r.l.status === 'pago' && !r.l.repasse_pago;
    if (status && st !== status) return false;
    return true;
  }), [linhas, estId, busca, status, periodo, hoje]); // eslint-disable-line react-hooks/exhaustive-deps

  const tot = useMemo(() => {
    const t = { base: 0, comissao: 0, repasse: 0, meu: 0, recebido: 0, aReceber: 0, repassePend: 0 };
    filtradas.forEach(({ l }) => {
      if (!l) return;
      t.base += l.base; t.comissao += l.comissao; t.repasse += l.repasse; t.meu += l.meu;
      if (l.status === 'pago') { t.recebido += l.meu; if (l.repasse > 0 && !l.repasse_pago) t.repassePend += l.repasse; }
      else t.aReceber += l.meu;
    });
    return { base: r2(t.base), comissao: r2(t.comissao), repasse: r2(t.repasse), meu: r2(t.meu), recebido: r2(t.recebido), aReceber: r2(t.aReceber), repassePend: r2(t.repassePend) };
  }, [filtradas]);

  const valores = (r: Linha): Draft =>
    drafts[r.key] ?? { v99: numToInput(r.l?.valor_99food ?? 0), vif: numToInput(r.l?.valor_ifood ?? 0), vout: numToInput(r.l?.valor_outros ?? 0) };
  const taxa = (r: Linha) => ({ pm: r.l ? r.l.pct_meu_snap : r.est?.pct_meu ?? 0, pp: r.l ? r.l.pct_parceiro_snap : r.est?.pct_parceiro ?? 0 });
  const limparDraft = (key: string) => setDrafts((p) => { const n = { ...p }; delete n[key]; return n; });

  const salvar = async (r: Linha) => {
    const d = drafts[r.key]; if (!d) return;
    const [a, b, c] = [num(d.v99), num(d.vif), num(d.vout)];
    const cur = r.l;
    const igual = cur ? cur.valor_99food === a && cur.valor_ifood === b && cur.valor_outros === c : !a && !b && !c;
    if (igual) return limparDraft(r.key);
    setSaving(r.key);
    try {
      const res = await api<{ lancamento: Lancamento }>('PUT', '/gestao-delivery/lancamentos',
        { estabelecimento_id: r.estId, semana_inicio: r.ini, valor_99food: a, valor_ifood: b, valor_outros: c });
      const novo: LancRow = { ...res.lancamento, nome: r.nome, tem_parceiro: r.est?.tem_parceiro ?? false, parceiro_nome: r.est?.parceiro_nome ?? null, ativo: r.est?.ativo ?? true };
      setLancs((p) => p && [...p.filter((x) => x.id !== novo.id), novo]);
      limparDraft(r.key);
    } catch (e) { fail(e); } finally { setSaving(null); }
  };
  const patch = async (l: LancRow, body: Record<string, unknown>) => {
    try { await api('PATCH', `/gestao-delivery/lancamentos/${l.id}`, body); load(); } catch (e) { fail(e); }
  };
  const remover = async (r: Linha) => {
    if (!r.l || !window.confirm(`Excluir o lançamento de ${r.nome} (${weekLabel(r.ini, r.fim)})?`)) return;
    try { await api('DELETE', `/gestao-delivery/lancamentos/${r.l.id}`); load(); } catch (e) { fail(e); }
  };

  const selecionaveis = filtradas.filter((r) => r.l && r.l.status !== 'pago');
  const selRows = filtradas.filter((r) => r.l && sel.has(r.l.id));
  const totalSel = r2(selRows.reduce((s, r) => s + (r.l?.meu ?? 0), 0));
  const toggle = (id: number, on: boolean) => setSel((p) => { const n = new Set(p); on ? n.add(id) : n.delete(id); return n; });

  const pagarSel = async () => {
    try { await api('POST', '/gestao-delivery/lancamentos/pagar-lote', { ids: [...sel] }); notify(`${sel.size} semana(s) marcadas como pagas.`); load(); } catch (e) { fail(e); }
  };
  const fecharSel = async () => {
    const ids = selRows.filter((r) => r.l!.status === 'em_andamento').map((r) => r.l!.id);
    if (!ids.length) return notify('Nenhuma das selecionadas está em andamento.', false);
    try { await Promise.all(ids.map((id) => api('PATCH', `/gestao-delivery/lancamentos/${id}`, { status: 'aguardando' }))); notify(`${ids.length} semana(s) fechadas para cobrança.`); load(); } catch (e) { fail(e); }
  };
  const cobranca = () => {
    const porEst = new Map<number, Linha[]>();
    selRows.forEach((r) => porEst.set(r.estId, [...(porEst.get(r.estId) ?? []), r]));
    const msgs = [...porEst.values()].map((rs) => {
      const est = rs[0].est;
      const total = rs.reduce((s, r) => s + (r.l?.comissao ?? 0), 0);
      return [`Olá${est?.responsavel ? `, ${est.responsavel.split(' ')[0]}` : ''}! Segue o fechamento da gestão do delivery (${rs[0].nome}):`, '',
        ...rs.map((r) => `• ${weekLabel(r.ini, r.fim)}: líquido ${brl(r.l!.base)} → comissão ${brl(r.l!.comissao)}`),
        '', `Total a pagar: ${brl(total)}`, est?.pix_chave ? `PIX: ${est.pix_chave}` : '', 'Obrigado!'].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n');
    });
    Promise.resolve(navigator.clipboard?.writeText(msgs.join('\n\n————————\n\n'))).then(() => notify('Cobrança copiada. É só colar no WhatsApp.'));
    const unico = porEst.size === 1 ? [...porEst.values()][0][0].est : null;
    if (unico?.whatsapp) window.open(`https://wa.me/55${unico.whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(msgs[0])}`, '_blank');
  };

  if (!ests || !lancs) return <Loading />;
  if (ests.length === 0) {
    return <Card className="p-8 text-center text-sm text-[#7c7875]">Cadastre um restaurante em “Clientes Gestão Delivery” para começar.</Card>;
  }
  const filtrosAtivos = !!(busca || estId || status || periodo !== 'todos');
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); };
  const th = 'whitespace-nowrap px-2 py-2.5 text-[11px] font-bold uppercase tracking-wider text-[#7c7875]';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi tone="main" label="Meu líquido" value={brl(tot.meu)} hint="no filtro atual" icon={<Coins size={16} />} />
        <Kpi label="Recebido" value={brl(tot.recebido)} tone="good" hint="semanas pagas" icon={<BadgeCheck size={16} />} />
        <Kpi label="A receber" value={brl(tot.aReceber)} tone="warn" hint="em andamento + aguardando" icon={<Clock size={16} />} />
        <Kpi label="Gerenciado" value={brl(tot.base)} hint={`comissão bruta ${brl(tot.comissao)}`} icon={<TrendingUp size={16} />} />
        <Kpi label="Repasse parceiros" value={brl(tot.repasse)} hint={tot.repassePend ? `${brl(tot.repassePend)} pendente` : 'nada pendente'} icon={<HandCoins size={16} />} />
      </div>

      <Card className="p-3 sm:p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="lg:col-span-2"><span className={fieldLabelClass}>Buscar restaurante</span>
            <input className={fieldInputClass} placeholder="Nome…" value={busca} onChange={(e) => setBusca(e.target.value)} /></label>
          <label><span className={fieldLabelClass}>Restaurante</span>
            <select className={fieldInputClass} value={estId} onChange={(e) => setEstId(e.target.value)}>
              <option value="">Todos</option>
              {ests.map((e) => <option key={e.id} value={e.id}>{e.nome}{e.ativo ? '' : ' (inativo)'}</option>)}
            </select></label>
          <label><span className={fieldLabelClass}>Status</span>
            <select className={fieldInputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Todos</option>
              <option value="sem_lancamento">A preencher (sem lançamento)</option>
              <option value="em_andamento">Em andamento</option>
              <option value="aguardando">Aguardando pagamento</option>
              <option value="pago">Pago</option>
              <option value="repasse_pendente">Repasse ao parceiro pendente</option>
            </select></label>
          <label><span className={fieldLabelClass}>Período</span>
            <select className={fieldInputClass} value={periodo} onChange={(e) => setPeriodo(e.target.value)}>
              <option value="todos">Tudo</option>
              <option value="mes">Este mês</option>
              <option value="mes_passado">Mês passado</option>
              <option value="90d">Últimos 90 dias</option>
              <option value="ano">Este ano</option>
            </select></label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[#7c7875]">
          <span>{filtradas.length} linha(s)</span>
          {filtrosAtivos && <button type="button" className="font-bold text-[#ea1d2c] hover:underline" onClick={() => { setBusca(''); setEstId(''); setStatus(''); setPeriodo('todos'); }}>Limpar filtros</button>}
          <span className="ml-auto">Digite os valores direto na linha — salva sozinho ao sair do campo (ou Enter).</span>
        </div>
      </Card>

      {selRows.length > 0 && (
        <Card className="flex flex-wrap items-center gap-2 !border-[#ea1d2c]/40 !bg-[#fff5f6] p-3">
          <b className="text-sm text-[#3f3e3e]">{selRows.length} selecionada(s) · meu líquido {brl(totalSel)}</b>
          <div className="ml-auto flex flex-wrap gap-2">
            <Btn onClick={cobranca}><ClipboardCopy size={14} />Gerar cobrança</Btn>
            <Btn onClick={fecharSel}><Clock size={14} />Fechar e cobrar</Btn>
            <Btn tone="primary" onClick={pagarSel}><BadgeCheck size={14} />Marcar como pagas</Btn>
          </div>
        </Card>
      )}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] border-collapse text-xs">
            <tbody>
              <tr className="border-b border-[#e5e5e7] bg-[#f7f7f8] text-left">
                <th className="w-8 px-2 py-2.5">
                  <input className="accent-[#ea1d2c]" type="checkbox" aria-label="Selecionar todas"
                    checked={selecionaveis.length > 0 && selecionaveis.every((r) => sel.has(r.l!.id))}
                    onChange={(e) => setSel(e.target.checked ? new Set(selecionaveis.map((r) => r.l!.id)) : new Set())} />
                </th>
                <th className={th}>Semana</th><th className={th}>Restaurante</th>
                <th className={`${th} text-right`}>99Food</th><th className={`${th} text-right`}>iFood</th><th className={`${th} text-right`}>Outros</th>
                <th className={`${th} text-right`}>Total dono</th><th className={`${th} text-right`}>Comissão</th>
                <th className={`${th} text-right`}>Parceiro</th><th className={`${th} text-right`}>Meu líquido</th>
                <th className={th}>Status</th><th className="w-8" />
              </tr>
            </tbody>
            <tbody>
              {filtradas.length === 0 && (
                <tr><td colSpan={12} className="p-8 text-center text-sm text-[#7c7875]">Nada neste filtro.</td></tr>
              )}
              {filtradas.map((r, idx) => {
                const l = r.l;
                const d = valores(r);
                const { pm, pp } = taxa(r);
                const c = calc(num(d.v99), num(d.vif), num(d.vout), pm, pp);
                const locked = l?.status === 'pago';
                const apps = r.est?.apps ?? ['99food', 'ifood', 'outros'];
                const set = (k: keyof Draft, v: string) => setDrafts((p) => ({ ...p, [r.key]: { ...valores(r), [k]: v } }));
                const campo = (app: string, k: keyof Draft, ph: string) => apps.includes(app)
                  ? <input className={cellInput} inputMode="decimal" placeholder={ph} disabled={locked} value={d[k]}
                      onChange={(e) => set(k, e.target.value)} onBlur={() => salvar(r)} onKeyDown={onKey} />
                  : <span className="text-[#c4c0bd]">—</span>;
                const novaSemana = idx > 0 && filtradas[idx - 1].ini !== r.ini;
                return (
                  <tr key={r.key} className={`${novaSemana ? 'border-t-2 border-t-[#e5e5e7]' : 'border-t border-t-[#f1f1f3]'} ${l ? '' : 'bg-[#fffaf0]'} hover:bg-[#fafafa]`}>
                    <td className="px-2 py-2">
                      {l && <input className="accent-[#ea1d2c]" type="checkbox" disabled={locked} checked={sel.has(l.id)} aria-label="Selecionar linha" onChange={(e) => toggle(l.id, e.target.checked)} />}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 font-bold text-[#3f3e3e]">{weekLabel(r.ini, r.fim)}<span className="font-normal text-[#a6a29f]">/{r.ini.slice(2, 4)}</span></td>
                    <td className="px-2 py-2">
                      <span className="font-bold text-[#3f3e3e]">{r.nome}</span>
                      {r.est && !r.est.ativo && <span className="ml-1 text-[10px] text-[#a6a29f]">(inativo)</span>}
                      {saving === r.key && <Loader2 size={12} className="ml-1 inline animate-spin text-[#7c7875]" />}
                    </td>
                    <td className="px-2 py-1.5 text-right">{campo('99food', 'v99', '0,00')}</td>
                    <td className="px-2 py-1.5 text-right">{campo('ifood', 'vif', '0,00')}</td>
                    <td className="px-2 py-1.5 text-right">{campo('outros', 'vout', '0,00')}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-[#3f3e3e]">{c.base ? brl(c.base) : <span className="text-[#c4c0bd]">—</span>}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-[#3f3e3e]">
                      {c.base ? brl(c.comissao) : <span className="text-[#c4c0bd]">—</span>}
                      <span className="block text-[10px] text-[#a6a29f]">{pctFmt(pm + pp)}</span>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-[#6f6b68]">
                      {c.repasse > 0 ? (
                        <>
                          {brl(c.repasse)}
                          {l && l.status !== 'em_andamento' && (
                            <label className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-[#4f4c4a]">
                              <input className="accent-[#ea1d2c]" type="checkbox" checked={l.repasse_pago} onChange={(e) => patch(l, { repasse_pago: e.target.checked })} />
                              {l.repasse_pago ? 'repassado' : 'repassar'}
                            </label>
                          )}
                        </>
                      ) : <span className="text-[#c4c0bd]">—</span>}
                    </td>
                    <td className="px-2 py-2 text-right text-sm font-black tabular-nums text-[#15803d]">{c.base ? brl(c.meu) : <span className="font-normal text-[#c4c0bd]">—</span>}</td>
                    <td className="px-2 py-1.5">
                      {l ? (
                        <>
                          <select className={selectCls} value={l.status} onChange={(e) => patch(l, { status: e.target.value })}>
                            <option value="em_andamento">Em andamento</option>
                            <option value="aguardando">Aguardando pgto.</option>
                            <option value="pago">Pago</option>
                          </select>
                          {l.data_pagamento && l.status === 'pago' && <span className="mt-0.5 block text-[10px] text-[#7c7875]">em {fmtDate(l.data_pagamento)}</span>}
                        </>
                      ) : <StatusChip s="sem_lancamento" />}
                    </td>
                    <td className="px-1 py-2">
                      {l && !locked && <button type="button" title="Excluir lançamento" aria-label="Excluir lançamento" className="rounded-lg p-1.5 text-[#a6a29f] hover:bg-[#fdecee] hover:text-[#a02331]" onClick={() => remover(r)}><Trash2 size={14} /></button>}
                    </td>
                  </tr>
                );
              })}
              {filtradas.length > 0 && (
                <tr className="border-t-2 border-t-[#e5e5e7] bg-[#f7f7f8] font-black text-[#3f3e3e]">
                  <td colSpan={6} className="px-2 py-2.5 text-right text-[11px] uppercase tracking-wider text-[#7c7875]">Total do filtro</td>
                  <td className="px-2 py-2.5 text-right tabular-nums">{brl(tot.base)}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums">{brl(tot.comissao)}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums">{brl(tot.repasse)}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-[#15803d]">{brl(tot.meu)}</td>
                  <td colSpan={2} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="text-center text-[11px] text-[#a6a29f]">Linhas em amarelo ainda não têm valores. A taxa de cada semana fica congelada no primeiro lançamento: mudar a % do restaurante depois não altera semanas já lançadas.</p>
    </div>
  );
}

/* ═════════════════════════ CADASTRO ═════════════════════════ */

const emptyEst = (): Partial<Estabelecimento> => ({
  nome: '', apps: ['99food', 'ifood'], pct_meu: 10, tem_parceiro: false, pct_parceiro: 0, ativo: true,
  documento_tipo: 'CNPJ', pix_tipo: 'cnpj', inicio_em: isoToday(),
});

function Cadastro({ api, version, notify, fail, bump }: Shared) {
  const [list, setList] = useState<Estabelecimento[] | null>(null);
  const [edit, setEdit] = useState<Partial<Estabelecimento> | null>(null);
  const [recalc, setRecalc] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showArq, setShowArq] = useState(false);
  const [clientes, setClientes] = useState<{ id: number; nome_estabelecimento: string }[]>([]);

  useEffect(() => { api<Estabelecimento[]>('GET', '/gestao-delivery/estabelecimentos').then(setList).catch(fail); }, [api, version, fail]);
  useEffect(() => { api<any[]>('GET', '/clientes').then((c) => setClientes(c.map((x) => ({ id: x.id, nome_estabelecimento: x.nome_estabelecimento })))).catch(() => {}); }, [api]);

  const submit = async () => {
    if (!edit) return; setBusy(true);
    try {
      const body = {
        ...edit,
        pct_meu: num(String(edit.pct_meu ?? 0)),
        pct_parceiro: edit.tem_parceiro ? num(String(edit.pct_parceiro ?? 0)) : 0,
        recalcular_abertas: recalc,
      };
      if (edit.id) await api('PUT', `/gestao-delivery/estabelecimentos/${edit.id}`, body);
      else await api('POST', '/gestao-delivery/estabelecimentos', body);
      notify('Estabelecimento salvo.'); setEdit(null); setRecalc(false); bump();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const remove = async (e: Estabelecimento) => {
    if (!window.confirm(`Remover "${e.nome}"? Se tiver histórico, ele será apenas arquivado.`)) return;
    try { const r = await api<{ arquivado: boolean }>('DELETE', `/gestao-delivery/estabelecimentos/${e.id}`);
      notify(r.arquivado ? 'Arquivado (o histórico foi mantido).' : 'Removido.'); bump(); } catch (er) { fail(er); }
  };
  const reativar = async (e: Estabelecimento) => { try { await api('POST', `/gestao-delivery/estabelecimentos/${e.id}/reativar`); bump(); } catch (er) { fail(er); } };

  if (!list) return <Loading />;
  const ativos = list.filter((x) => x.ativo), arq = list.filter((x) => !x.ativo);
  const f = edit ?? {};
  const upd = (p: Partial<Estabelecimento>) => setEdit((cur) => ({ ...(cur ?? {}), ...p }));
  const toggleApp = (a: string) => upd({ apps: f.apps?.includes(a) ? f.apps.filter((x) => x !== a) : [...(f.apps ?? []), a] });
  // função (e não componente) para o input não ser remontado a cada tecla e perder o foco
  const field = (label: string, k: keyof Estabelecimento, rest: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="block"><span className={fieldLabelClass}>{label}</span>
      <input className={fieldInputClass} value={(f[k] as string | number | null | undefined) ?? ''}
        onChange={(e) => upd({ [k]: e.target.value } as Partial<Estabelecimento>)} {...rest} /></label>);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[#6f6b68]">{ativos.length} restaurante(s) ativo(s)</p>
        <Btn tone="primary" onClick={() => setEdit(emptyEst())}><Plus size={14} />Novo estabelecimento</Btn>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {ativos.map((e) => (
          <Card key={e.id} className="space-y-2 p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0"><p className="truncate font-black text-[#3f3e3e]">{e.nome}</p>
                <p className="truncate text-xs text-[#7c7875]">{[e.responsavel, e.cidade].filter(Boolean).join(' · ') || '—'}</p></div>
              <div className="flex shrink-0 gap-1"><Btn onClick={() => setEdit(e)} title="Editar"><Pencil size={13} /></Btn>
                <Btn tone="danger" onClick={() => remove(e)} title="Remover"><Trash2 size={13} /></Btn></div>
            </div>
            <div className="flex flex-wrap gap-1.5 text-[11px] font-bold">
              <span className="rounded-full bg-[#fdecee] px-2 py-0.5 text-[#a02331]">{pctFmt(e.pct_meu)} meu</span>
              {e.tem_parceiro ? <span className="rounded-full bg-[#f3eefe] px-2 py-0.5 text-[#6d28d9]">{pctFmt(e.pct_parceiro)} {e.parceiro_nome || 'parceiro'}</span>
                : <span className="rounded-full bg-[#f1f1f3] px-2 py-0.5 text-[#4f4c4a]">sem parceiro</span>}
              {e.apps.map((a) => <span key={a} className="rounded-full bg-[#ededee] px-2 py-0.5 text-[#4f4c4a]">{a}</span>)}
              {e.cliente_id && <span className="rounded-full bg-[#e8f3fb] px-2 py-0.5 text-[#0369a1]">usa o software</span>}
            </div>
            <p className="text-xs text-[#7c7875]">{e.total_semanas ?? 0} semana(s) · acumulado <b className="text-[#4f4c4a]">{brl(e.meu_acumulado)}</b></p>
            {e.pix_chave && <p className="truncate text-xs text-[#7c7875]">PIX {e.pix_tipo}: <span className="text-[#4f4c4a]">{e.pix_chave}</span></p>}
          </Card>))}
      </div>

      {arq.length > 0 && (<div>
        <button type="button" className="text-xs font-bold text-[#7c7875] hover:text-[#4f4c4a]" onClick={() => setShowArq((v) => !v)}>{showArq ? 'Ocultar' : 'Ver'} arquivados ({arq.length})</button>
        {showArq && <ul className="mt-2 space-y-1">{arq.map((e) => <li key={e.id} className="flex items-center justify-between rounded-lg border border-[#e5e5e7] px-3 py-2 text-sm text-[#6f6b68]">{e.nome}<Btn onClick={() => reativar(e)}>Reativar</Btn></li>)}</ul>}
      </div>)}

      <Modal open={!!edit} onClose={() => setEdit(null)} title={f.id ? 'Editar estabelecimento' : 'Novo estabelecimento'} wide>
        <div className="space-y-4 overflow-y-auto p-4">
          <section className="grid gap-3 sm:grid-cols-2">
            {field("Nome do estabelecimento *", "nome")}{field("Razão social", "razao_social")}
            <label className="block"><span className={fieldLabelClass}>Documento</span>
              <div className="flex gap-2"><select className={`${fieldInputClass} !w-24`} value={f.documento_tipo ?? ''} onChange={(e) => upd({ documento_tipo: (e.target.value || null) as any })}>
                <option value="CNPJ">CNPJ</option><option value="CPF">CPF</option></select>
                <input className={fieldInputClass} value={f.documento_numero ?? ''} onChange={(e) => upd({ documento_numero: e.target.value })} /></div></label>
            {field("Responsável", "responsavel")}{field("WhatsApp", "whatsapp")}{field("E-mail", "email")}{field("Cidade", "cidade")}
            <label className="block"><span className={fieldLabelClass}>Cliente do software? (opcional)</span>
              <select className={fieldInputClass} value={f.cliente_id ?? ''} onChange={(e) => upd({ cliente_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Não</option>{clientes.map((c) => <option key={c.id} value={c.id}>{c.nome_estabelecimento}</option>)}</select></label>
          </section>

          <section className="rounded-xl border border-[#e5e5e7] p-3">
            <p className="mb-2 text-xs font-black uppercase tracking-wider text-[#6f6b68]">PIX para receber</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block"><span className={fieldLabelClass}>Tipo</span>
                <select className={fieldInputClass} value={f.pix_tipo ?? ''} onChange={(e) => upd({ pix_tipo: e.target.value || null })}>
                  <option value="">—</option><option value="cnpj">CNPJ</option><option value="cpf">CPF</option><option value="email">E-mail</option><option value="telefone">Telefone</option><option value="aleatoria">Aleatória</option></select></label>
              {field("Chave", "pix_chave")}{field("Titular", "pix_titular")}
            </div>
          </section>

          <section className="rounded-xl border border-[#e5e5e7] p-3">
            <p className="mb-2 text-xs font-black uppercase tracking-wider text-[#6f6b68]">Como eu ganho</p>
            <div className="mb-3 flex flex-wrap gap-2">{['99food', 'ifood', 'outros'].map((a) => (
              <button key={a} type="button" onClick={() => toggleApp(a)} className={`rounded-full border px-3 py-1 text-xs font-bold ${f.apps?.includes(a) ? 'border-[#ea1d2c] bg-[#fdecee] text-[#a02331]' : 'border-[#d4d4d8] text-[#6f6b68]'}`}>{a}</button>))}</div>
            <div className="grid gap-3 sm:grid-cols-2">
              {field("Minha parte (%)", "pct_meu", { inputMode: "decimal" })}
              <label className="flex items-end gap-2 pb-2.5 text-sm font-bold text-[#3f3e3e]"><input className="accent-[#ea1d2c]" type="checkbox" checked={!!f.tem_parceiro} onChange={(e) => upd({ tem_parceiro: e.target.checked })} />Tem parceiro (divide comigo)</label>
              {f.tem_parceiro && <>
                {field("Nome do parceiro", "parceiro_nome")}{field("Parte do parceiro (%)", "pct_parceiro", { inputMode: "decimal" })}
                {field("PIX do parceiro", "parceiro_pix")}</>}
            </div>
            {(() => { const pm = num(String(f.pct_meu ?? 0)), pp = f.tem_parceiro ? num(String(f.pct_parceiro ?? 0)) : 0;
              const ex = calc(1000, 0, 0, pm, pp);
              return <p className="mt-3 rounded-lg bg-[#f7f7f8] p-2.5 text-xs text-[#6f6b68]">Simulação com R$ 1.000,00 de líquido do dono: comissão <b className="text-[#3f3e3e]">{brl(ex.comissao)}</b> ({pctFmt(pm + pp)})
                {pp > 0 && <> · parceiro <b className="text-[#6d28d9]">{brl(ex.repasse)}</b></>} · <b className="text-[#15803d]">fica comigo {brl(ex.meu)}</b></p>; })()}
          </section>

          <label className="block"><span className={fieldLabelClass}>Observações (não coloque senhas aqui)</span>
            <textarea className={fieldInputClass} rows={2} value={f.observacoes ?? ''} onChange={(e) => upd({ observacoes: e.target.value })} /></label>

          {f.id && <label className="flex items-start gap-2 rounded-lg bg-[#fffbeb] p-2.5 text-xs text-[#92400e]">
            <input className="mt-0.5 accent-[#ea1d2c]" type="checkbox" checked={recalc} onChange={(e) => setRecalc(e.target.checked)} />
            Aplicar estas porcentagens também às semanas ainda não pagas. Sem marcar, só as próximas semanas usam a taxa nova (semanas pagas nunca mudam).</label>}

          <div className="flex justify-end gap-2"><Btn onClick={() => setEdit(null)}>Cancelar</Btn><Btn tone="primary" disabled={busy} onClick={submit}>{busy ? 'Salvando…' : 'Salvar'}</Btn></div>
        </div>
      </Modal>
    </div>
  );
}
