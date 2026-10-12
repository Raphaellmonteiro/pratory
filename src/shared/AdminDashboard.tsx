// src/shared/AdminDashboard.tsx
// Painel admin → "Dashboard": mesma leitura da planilha de comissões (filtros de semana/cliente,
// faixa de KPIs, tabela por cliente, semana a semana, gráfico) + o que precisa de ação hoje
// (mensalidades do software, cobranças do delivery, solicitações de acesso).
//
// Uso no AdminPanel:
//   <AdminDashboard token={token} onAuthError={handleAuthError} stats={stats} ... />

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, BadgeCheck, CalendarCheck, Clock, Coins, MessageCircle, Pencil, RefreshCw, Users, Wallet,
} from 'lucide-react';
import {
  Btn, Card, Kpi, Loading, PagamentoSoftwareModal, StatusChip, brl, brlShort, fieldInputClass, fieldLabelClass,
  fmtDate, pctFmt, useApi, weekLabel,
  type ClienteSw, type Ganhos, type PorEst, type Resumo,
} from './AdminGestaoDelivery';

type SoftwareStats = { total?: number; ativos?: number; pendentes?: number; bloqueados?: number; expirados?: number } | null;

export type DashboardProps = {
  token: string | null;
  onAuthError?: () => void;
  stats: SoftwareStats;
  /** abre a aba Clientes já com o estabelecimento (ou cliente do software) aberto para ajuste */
  onOpenCliente: (target: { estId?: number; clienteId?: number }) => void;
  onGoClientes: () => void;
  onGoGestao: () => void;
  onGoSolicitacoes: () => void;
};

const PALETTE = ['#ea1d2c', '#3f3e3e', '#f59e0b', '#2563eb', '#16a34a', '#7c3aed', '#0891b2', '#db2777'];

const th = 'whitespace-nowrap px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider';

export default function AdminDashboard({
  token, onAuthError, stats, onOpenCliente, onGoClientes, onGoGestao, onGoSolicitacoes,
}: DashboardProps) {
  const api = useApi(token, onAuthError);
  const [semana, setSemana] = useState<string>('todas');
  const [est, setEst] = useState<string>('');
  const [r, setR] = useState<Resumo | null>(null);
  const [g, setG] = useState<Ganhos | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const [payFor, setPayFor] = useState<ClienteSw | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true); setErro(null);
    const qs = new URLSearchParams({ semana, ...(est ? { estabelecimento: est } : {}) });
    Promise.all([
      api<Resumo>('GET', `/gestao-delivery/resumo?${qs}`),
      api<Ganhos>('GET', '/ganhos?meses=6'),
    ])
      .then(([resumo, ganhos]) => { setR(resumo); setG(ganhos); })
      .catch((e) => setErro(e instanceof Error ? e.message : 'Erro ao carregar o dashboard.'))
      .finally(() => setLoading(false));
  }, [api, semana, est]);

  useEffect(() => { load(); }, [load, version]);

  const ativos = useMemo(() => (r?.por_estabelecimento ?? []).filter((e) => e.ativo || e.gerenciado > 0), [r]);
  const colorOf = useMemo(() => {
    const m = new Map<number, string>();
    (r?.por_estabelecimento ?? []).forEach((e, i) => m.set(e.estabelecimento_id, PALETTE[i % PALETTE.length]));
    return m;
  }, [r]);

  if (erro && !r) {
    return (
      <div className="rounded-2xl bg-[#f7f7f8] p-6 text-[#3f3e3e]">
        <p className="mb-3 text-sm font-bold text-[#a02331]">{erro}</p>
        <Btn tone="primary" onClick={load}><RefreshCw size={14} />Tentar de novo</Btn>
      </div>
    );
  }
  if (!r || !g) return <div className="rounded-2xl bg-[#f7f7f8]"><Loading /></div>;

  const t = r.totais;
  const conciliado = Math.abs(t.comissao_bruta - t.repasse_parceiro - t.meu_liquido) < 0.01;
  const mesAtual = g.meses[g.meses.length - 1];
  const semanaSel = semana !== 'todas' ? r.semanas_disponiveis.find((s) => s.semana_inicio === semana) : null;

  // gráfico: últimas 12 semanas em ordem cronológica, empilhado por cliente
  const serie = [...r.semanas].reverse().slice(-12);
  const maxSerie = Math.max(1, ...serie.map((s) => s.meu_liquido ?? 0));

  const atrasados = r.alertas.filter((a) => a.tipo === 'atrasado');
  const fechar = r.alertas.filter((a) => a.tipo === 'fechar_semana');
  const semLanc = r.alertas.filter((a) => a.tipo === 'sem_lancamento');
  const pendentesAcesso = stats?.pendentes ?? 0;
  const totalAtencao = atrasados.length + fechar.length + semLanc.length + g.software.inadimplentes.length + pendentesAcesso;

  const estIdByNome = (nome: string) => r.por_estabelecimento.find((e) => e.nome === nome)?.estabelecimento_id;

  return (
    <div className="min-w-0 space-y-4 rounded-2xl bg-[#f7f7f8] p-3 text-[#3f3e3e] [color-scheme:light] sm:p-5">
      {/* título + filtros (igual à planilha: semana e cliente) */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto min-w-0">
          <h2 className="text-xl font-black text-[#3f3e3e] sm:text-2xl">Dashboard</h2>
          <p className="text-xs text-[#7c7875]">
            {semanaSel ? `Semana ${weekLabel(semanaSel.semana_inicio, semanaSel.semana_fim)}` : 'Todas as semanas'}
            {est ? ` · ${ativos.find((e) => String(e.estabelecimento_id) === est)?.nome ?? 'cliente'}` : ' · todos os clientes'}
          </p>
        </div>
        <label className="min-w-[170px]"><span className={fieldLabelClass}>Semana</span>
          <select className={`${fieldInputClass} !border-[#f5d9a8] !bg-[#fffbeb] font-bold`} value={semana} onChange={(e) => setSemana(e.target.value)}>
            <option value="todas">Todas as semanas</option>
            {r.semanas_disponiveis.map((s) => (
              <option key={s.semana_inicio} value={s.semana_inicio}>{weekLabel(s.semana_inicio, s.semana_fim)} ({s.semana_inicio.slice(0, 4)})</option>
            ))}
          </select></label>
        <label className="min-w-[170px]"><span className={fieldLabelClass}>Cliente</span>
          <select className={`${fieldInputClass} !border-[#f5d9a8] !bg-[#fffbeb] font-bold`} value={est} onChange={(e) => setEst(e.target.value)}>
            <option value="">Todos os clientes</option>
            {r.por_estabelecimento.map((e) => <option key={e.estabelecimento_id} value={e.estabelecimento_id}>{e.nome}</option>)}
          </select></label>
        <Btn onClick={() => setVersion((v) => v + 1)} title="Atualizar"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Atualizar</Btn>
      </div>

      {/* faixa de KPIs — as mesmas 9 colunas da planilha */}
      <Card className="p-0">
        <div className="grid grid-cols-2 divide-x divide-y divide-[#f1f1f3] sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9 xl:divide-y-0">
          {([
            ['Gerenciado', brl(t.gerenciado), 'text-[#3f3e3e]'],
            ['Comissão bruta', brl(t.comissao_bruta), 'text-[#2563eb]'],
            ['Repasse parceiro', brl(t.repasse_parceiro), 'text-[#ea1d2c]'],
            ['Meu líquido', brl(t.meu_liquido), 'text-[#15803d]'],
            ['Líquido recebido', brl(t.recebido), 'text-[#15803d]'],
            ['Líquido a receber', brl(t.a_receber), 'text-[#ea1d2c]'],
            ['Em andamento', brl(t.em_andamento), 'text-[#2563eb]'],
            ['Repasse a pagar', brl(t.repasse_a_pagar), 'text-[#ea1d2c]'],
          ] as const).map(([label, value, cls]) => (
            <div key={label} className="min-w-0 px-3 py-3 text-center">
              <p className="truncate text-[10px] font-bold uppercase tracking-wide text-[#7c7875]">{label}</p>
              <p className={`mt-1 truncate text-base font-black tabular-nums sm:text-lg ${cls}`}>{value}</p>
            </div>
          ))}
          <div className="min-w-0 px-3 py-3 text-center">
            <p className="truncate text-[10px] font-bold uppercase tracking-wide text-[#7c7875]">Conferência</p>
            <p className={`mt-1 truncate text-base font-black sm:text-lg ${conciliado ? 'text-[#15803d]' : 'text-[#b91c1c]'}`}>
              {conciliado ? '✓ Conciliado' : '⚠ Divergência'}
            </p>
          </div>
        </div>
      </Card>

      {/* software + visão do mês */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi tone="main" label="Recebido no mês" value={brl(g.mes_atual.recebido)} icon={<Coins size={16} />}
          hint={`Software ${brl(mesAtual?.software_recebido)} · Delivery ${brl(mesAtual?.delivery_recebido)}`} />
        <Kpi label="Previsto no mês" value={brl(g.mes_atual.previsto)} icon={<Wallet size={16} />}
          hint={`MRR ${brl(g.software.mrr)} · ${g.software.pagantes} pagante(s)`} />
        <Kpi tone={g.software.inadimplentes.length ? 'warn' : 'default'} label="Mensalidades em atraso"
          value={brl(g.software.inadimplencia_total)} icon={<Clock size={16} />}
          hint={`${g.software.inadimplentes.length} cliente(s) · ${g.software.a_vencer_7d.length} vence(m) em 7 dias`} />
        <Kpi label="Clientes do software" value={String(stats?.total ?? 0)} icon={<Users size={16} />}
          hint={`${stats?.ativos ?? 0} ativos · ${stats?.bloqueados ?? 0} bloqueados · ${stats?.expirados ?? 0} expirados`} />
      </div>

      {/* o que precisa de ação hoje */}
      <Card className={`p-4 ${totalAtencao ? '!border-[#f5d9a8]' : ''}`}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-black text-[#3f3e3e]">
            <AlertTriangle size={16} className={totalAtencao ? 'text-[#b45309]' : 'text-[#a6a29f]'} />
            Para resolver hoje {totalAtencao > 0 && <span className="rounded-full bg-[#fef3c7] px-2 py-0.5 text-[11px] text-[#b45309]">{totalAtencao}</span>}
          </h3>
          <div className="flex gap-1.5">
            <Btn onClick={onGoGestao}><CalendarCheck size={14} />Lançar semana</Btn>
            <Btn onClick={onGoClientes}><Users size={14} />Clientes</Btn>
          </div>
        </div>

        {totalAtencao === 0 ? (
          <p className="py-3 text-center text-sm text-[#7c7875]">Tudo em dia 🎉</p>
        ) : (
          <ul className="divide-y divide-[#f1f1f3] text-sm text-[#4f4c4a]">
            {pendentesAcesso > 0 && (
              <li className="flex items-center justify-between gap-3 py-2">
                <span>🔔 <b>{pendentesAcesso}</b> solicitação(ões) de acesso aguardando aprovação</span>
                <Btn tone="primary" onClick={onGoSolicitacoes}>Ver</Btn>
              </li>
            )}
            {g.software.inadimplentes.map((c) => (
              <li key={`sw-${c.id}`} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0">💻 <b>{c.nome_estabelecimento}</b> — mensalidade {brl(c.valor_plano)} atrasada há {c.dias_atraso} dia(s)</span>
                <span className="flex shrink-0 gap-1.5">
                  {c.whatsapp && (
                    <a className="inline-flex min-h-[36px] items-center rounded-lg border border-[#d4d4d8] px-2.5 text-[#4f4c4a] hover:bg-[#f5f5f5]" title="Cobrar no WhatsApp"
                      target="_blank" rel="noreferrer"
                      href={`https://wa.me/55${c.whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(`Olá! Sua mensalidade do sistema (${brl(c.valor_plano)}) venceu em ${fmtDate(c.vencimento)}. Posso enviar o PIX?`)}`}>
                      <MessageCircle size={14} /></a>
                  )}
                  <Btn onClick={() => onOpenCliente({ clienteId: c.id })}><Pencil size={14} />Abrir</Btn>
                  <Btn tone="primary" onClick={() => setPayFor(c)}><BadgeCheck size={14} />Recebi</Btn>
                </span>
              </li>
            ))}
            {atrasados.map((a, i) => (
              <li key={`at-${i}`} className="flex items-center justify-between gap-3 py-2">
                <span>⏰ <b>{a.nome}</b> deve a semana {fmtDate(a.semana_inicio)} há {a.dias} dias ({brl(a.meu)})</span>
                <Btn onClick={() => { const id = estIdByNome(a.nome); if (id) onOpenCliente({ estId: id }); }}>Abrir</Btn>
              </li>
            ))}
            {fechar.map((a, i) => (
              <li key={`fc-${i}`} className="flex items-center justify-between gap-3 py-2">
                <span>📌 <b>{a.nome}</b>: semana {fmtDate(a.semana_inicio)} já terminou, falta fechar e cobrar</span>
                <Btn onClick={onGoGestao}>Fechar</Btn>
              </li>
            ))}
            {semLanc.map((a, i) => (
              <li key={`sl-${i}`} className="flex items-center justify-between gap-3 py-2">
                <span>📝 <b>{a.nome}</b> não tem lançamento da semana {fmtDate(a.semana_inicio)}</span>
                <Btn onClick={onGoGestao}>Lançar</Btn>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* POR CLIENTE */}
      <Card className="overflow-x-auto">
        <div className="bg-[#2b2a2a] px-4 py-2.5 text-xs font-black uppercase tracking-wider text-[#ffffff]">
          Por cliente <span className="font-medium normal-case tracking-normal text-[#d4d4d8]">(segue a semana selecionada · clique para ajustar)</span>
        </div>
        <table className="w-full min-w-[980px] text-sm">
          <thead>
            <tr className="bg-[#2b2a2a] text-right text-[#ffffff]">
              <th className={`${th} text-left`}>Cliente</th><th className={th}>Gerenciado</th><th className={th}>Comissão total</th>
              <th className={th}>Repasse parceiro</th><th className={th}>Meu líquido</th><th className={th}>Líq. recebido</th>
              <th className={th}>Líq. a receber</th><th className={th}>Em andamento</th><th className={`${th} text-left`}>Status</th>
              <th className={th}>% do gerenciado</th><th className={th}>Margem líquida</th>
            </tr>
          </thead>
          <tbody>
            {r.por_estabelecimento.map((e: PorEst) => (
              <tr key={e.estabelecimento_id} className="cursor-pointer border-b border-[#f1f1f3] text-right tabular-nums hover:bg-[#faf9f9]"
                onClick={() => onOpenCliente({ estId: e.estabelecimento_id })}>
                <td className="px-3 py-2.5 text-left">
                  <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: colorOf.get(e.estabelecimento_id) }} />
                  <b className="align-middle text-[#3f3e3e]">{e.nome}</b>
                  {!e.ativo && <span className="ml-2 text-[10px] font-bold uppercase text-[#a6a29f]">arquivado</span>}
                </td>
                <td className="px-3 py-2.5">{brl(e.gerenciado)}</td>
                <td className="px-3 py-2.5">{brl(e.comissao_bruta)}</td>
                <td className="px-3 py-2.5 text-[#6f6b68]">{e.repasse_parceiro ? brl(e.repasse_parceiro) : '-'}</td>
                <td className="px-3 py-2.5 font-black text-[#3f3e3e]">{brl(e.meu_liquido)}</td>
                <td className="px-3 py-2.5 text-[#15803d]">{e.recebido ? brl(e.recebido) : '-'}</td>
                <td className="px-3 py-2.5 text-[#b45309]">{e.a_receber ? brl(e.a_receber) : '-'}</td>
                <td className="px-3 py-2.5 text-[#2563eb]">{e.em_andamento ? brl(e.em_andamento) : '-'}</td>
                <td className="px-3 py-2.5 text-left"><StatusChip s={e.status} /></td>
                <td className="px-3 py-2.5">{t.gerenciado ? pctFmt((e.gerenciado / t.gerenciado) * 100) : '—'}</td>
                <td className="px-3 py-2.5">{e.gerenciado ? pctFmt((e.meu_liquido / e.gerenciado) * 100) : '—'}</td>
              </tr>
            ))}
            <tr className="bg-[#eef0f3] text-right font-black tabular-nums text-[#3f3e3e]">
              <td className="px-3 py-2.5 text-left">TOTAL</td>
              <td className="px-3 py-2.5">{brl(t.gerenciado)}</td><td className="px-3 py-2.5">{brl(t.comissao_bruta)}</td>
              <td className="px-3 py-2.5">{brl(t.repasse_parceiro)}</td><td className="px-3 py-2.5">{brl(t.meu_liquido)}</td>
              <td className="px-3 py-2.5">{t.recebido ? brl(t.recebido) : '-'}</td><td className="px-3 py-2.5">{t.a_receber ? brl(t.a_receber) : '-'}</td>
              <td className="px-3 py-2.5">{t.em_andamento ? brl(t.em_andamento) : '-'}</td><td />
              <td className="px-3 py-2.5">{t.gerenciado ? '100,0%' : '—'}</td>
              <td className="px-3 py-2.5">{t.gerenciado ? pctFmt((t.meu_liquido / t.gerenciado) * 100) : '—'}</td>
            </tr>
          </tbody>
        </table>
      </Card>

      {/* SEMANA A SEMANA + gráfico */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card className="overflow-x-auto">
          <div className="bg-[#2b2a2a] px-4 py-2.5 text-xs font-black uppercase tracking-wider text-[#ffffff]">
            Semana a semana <span className="font-medium normal-case tracking-normal text-[#d4d4d8]">(clique numa semana para filtrar)</span>
          </div>
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="bg-[#2b2a2a] text-right text-[#ffffff]">
                <th className={`${th} text-left`}>Semana</th><th className={th}>Gerenciado</th><th className={th}>Comissão</th>
                <th className={th}>Repasse</th><th className={th}>Meu líquido</th>
                {ativos.filter((e) => e.ativo).map((e) => (
                  <th key={e.estabelecimento_id} className={th}>{e.nome.split(' ').slice(0, 2).join(' ')}</th>
                ))}
                <th className={`${th} text-center`}>Pendência</th>
              </tr>
            </thead>
            <tbody>
              {r.semanas.slice(0, 14).map((s) => (
                <tr key={s.semana_inicio}
                  onClick={() => setSemana(semana === s.semana_inicio ? 'todas' : s.semana_inicio)}
                  className={`cursor-pointer border-b border-[#f1f1f3] text-right tabular-nums hover:bg-[#faf9f9] ${semana === s.semana_inicio ? '!bg-[#fff8c5]' : ''}`}>
                  <td className="px-3 py-2.5 text-left font-bold text-[#3f3e3e]">{weekLabel(s.semana_inicio, s.semana_fim)}/{s.semana_inicio.slice(0, 4)}</td>
                  <td className="px-3 py-2.5">{brl(s.gerenciado)}</td>
                  <td className="px-3 py-2.5">{brl(s.comissao_bruta)}</td>
                  <td className="px-3 py-2.5 text-[#6f6b68]">{s.repasse_parceiro ? brl(s.repasse_parceiro) : '-'}</td>
                  <td className="px-3 py-2.5 font-black text-[#3f3e3e]">{brl(s.meu_liquido)}</td>
                  {ativos.filter((e) => e.ativo).map((e) => {
                    const p = s.por_estabelecimento.find((x) => x.estabelecimento_id === e.estabelecimento_id);
                    return <td key={e.estabelecimento_id} className={`px-3 py-2.5 ${p?.status === 'pago' ? 'text-[#15803d]' : 'text-[#4f4c4a]'}`}>{p ? brl(p.meu) : '-'}</td>;
                  })}
                  <td className="px-3 py-2.5 text-center">
                    {s.n_aguardando > 0 ? <span className="text-xs font-black text-[#b45309]">Aguardando</span>
                      : s.n_andamento > 0 ? <span className="text-xs font-black text-[#2563eb]">Em andamento</span>
                        : <span className="text-xs font-black text-[#15803d]">Quitada</span>}
                  </td>
                </tr>
              ))}
              {r.semanas.length === 0 && (
                <tr><td colSpan={7 + ativos.length} className="p-6 text-center text-sm text-[#7c7875]">Nenhuma semana lançada ainda.</td></tr>
              )}
            </tbody>
          </table>
        </Card>

        <Card className="p-4">
          <h3 className="mb-1 text-sm font-black text-[#3f3e3e]">Meu líquido por semana e cliente</h3>
          <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-bold text-[#6f6b68]">
            {r.por_estabelecimento.filter((e) => e.ativo).map((e) => (
              <span key={e.estabelecimento_id} className="flex items-center gap-1">
                <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: colorOf.get(e.estabelecimento_id) }} />{e.nome}
              </span>
            ))}
          </div>
          {serie.length === 0 ? (
            <p className="py-10 text-center text-sm text-[#7c7875]">Sem dados para o gráfico.</p>
          ) : (
            <div className="flex h-56 items-end gap-1.5">
              {serie.map((s) => (
                <div key={s.semana_inicio} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                  <span className="whitespace-nowrap text-[9px] font-bold tabular-nums text-[#4f4c4a]">{s.meu_liquido ? brlShort(s.meu_liquido) : ''}</span>
                  <div className="flex w-full flex-1 flex-col justify-end overflow-hidden rounded-t-md">
                    {s.por_estabelecimento.map((p) => (
                      <div key={p.estabelecimento_id} style={{ height: `${((p.meu ?? 0) / maxSerie) * 100}%`, background: colorOf.get(p.estabelecimento_id) }}
                        title={`${r.por_estabelecimento.find((x) => x.estabelecimento_id === p.estabelecimento_id)?.nome ?? ''}: ${brl(p.meu)}`} />
                    ))}
                  </div>
                  <span className="text-[9px] font-bold text-[#7c7875]">{s.semana_inicio.slice(8, 10)}/{s.semana_inicio.slice(5, 7)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <PagamentoSoftwareModal cliente={payFor} api={api} onClose={() => setPayFor(null)} fail={(e) => setToast(e instanceof Error ? e.message : 'Erro')}
        onDone={() => { setPayFor(null); setToast('Pagamento registrado e vencimento renovado.'); setVersion((v) => v + 1); window.setTimeout(() => setToast(null), 3200); }} />

      {toast && (
        <div className="fixed bottom-5 left-1/2 z-[90] -translate-x-1/2 rounded-xl bg-[#15803d] px-4 py-2.5 text-sm font-bold text-[#ffffff] shadow-xl">{toast}</div>
      )}
    </div>
  );
}
