// src/shared/AdminClientesHub.tsx
// Painel admin → "Clientes": uma lista única com os clientes do software e os estabelecimentos
// da gestão de delivery (quando o mesmo restaurante é os dois, aparece numa linha só).
// Dá para filtrar, buscar e ajustar tudo daqui (plano/senhas/bloqueio do software;
// porcentagens, PIX, semanas e cobrança do delivery).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Building2, ChevronDown, KeyRound, Lock, LogOut, MessageCircle, MoreHorizontal, Pencil, Plus, Search, Trash2,
  UserCheck, Users2, Wrench,
} from 'lucide-react';
import {
  Btn, Card, EstDetalhe, EstabelecimentoEditor, Loading, StatusChip, brl, emptyEst, fieldInputClass, fmtDate, pctFmt, useApi,
  type Estabelecimento, type PorEst, type Resumo,
} from './AdminGestaoDelivery';

export type SoftwareActions = {
  onPainel: (c: any) => void;
  onEditar: (c: any) => void;
  onSenhas: (c: any) => void;
  onSubUsers: (c: any) => void;
  onBloquear: (c: any) => void;
  onDesconectar: (c: any) => void;
  onExcluir: (c: any) => void;
};

export type ClientesFocus = { estId?: number; clienteId?: number; nonce: number } | null;

type Row = { key: string; nome: string; sw: any | null; est: Estabelecimento | null };
type Filtro = 'todos' | 'software' | 'delivery' | 'atencao';

const diasAte = (c: any): number | null => {
  const ref = c.vencimento ?? c.trial_fim;
  return ref ? Math.ceil((new Date(ref).getTime() - Date.now()) / 86400000) : null;
};

export default function AdminClientesHub({
  token, onAuthError, clientes, actions, focus, onFocusHandled,
}: {
  token: string | null;
  onAuthError?: () => void;
  clientes: any[];
  actions: SoftwareActions;
  focus: ClientesFocus;
  onFocusHandled?: () => void;
}) {
  const api = useApi(token, onAuthError);
  const [ests, setEsts] = useState<Estabelecimento[] | null>(null);
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [version, setVersion] = useState(0);
  const [busca, setBusca] = useState('');
  const [filtro, setFiltro] = useState<Filtro>('todos');
  const [edit, setEdit] = useState<Partial<Estabelecimento> | null>(null);
  const [aberto, setAberto] = useState<string | null>(null); // linha com as semanas expandidas
  const [menu, setMenu] = useState<string | null>(null);
  const [showArq, setShowArq] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});

  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const notify = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok }); window.setTimeout(() => setToast(null), 3200);
  }, []);
  const fail = useCallback((e: unknown) => notify(e instanceof Error ? e.message : 'Erro inesperado.', false), [notify]);

  useEffect(() => {
    Promise.all([
      api<Estabelecimento[]>('GET', '/gestao-delivery/estabelecimentos'),
      api<Resumo>('GET', '/gestao-delivery/resumo?semana=todas'),
    ]).then(([e, r]) => { setEsts(e); setResumo(r); }).catch(fail);
  }, [api, version, fail]);

  const resumoPorEst = useMemo(() => {
    const m = new Map<number, PorEst>();
    (resumo?.por_estabelecimento ?? []).forEach((p) => m.set(p.estabelecimento_id, p));
    return m;
  }, [resumo]);

  // ── junta software + delivery (liga por estabelecimento.cliente_id)
  const { rows, arquivados } = useMemo(() => {
    const ativos = (ests ?? []).filter((e) => e.ativo);
    const usados = new Set<number>();
    const list: Row[] = (clientes ?? []).map((c) => {
      const est = ativos.find((e) => e.cliente_id === c.id) ?? null;
      if (est) usados.add(est.id);
      return { key: `c${c.id}`, nome: c.nome_estabelecimento, sw: c, est };
    });
    ativos.filter((e) => !usados.has(e.id)).forEach((e) => list.push({ key: `e${e.id}`, nome: e.nome, sw: null, est: e }));
    list.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }));
    return { rows: list, arquivados: (ests ?? []).filter((e) => !e.ativo) };
  }, [clientes, ests]);

  const precisaAtencao = useCallback((r: Row) => {
    if (r.sw) {
      const d = diasAte(r.sw);
      if (r.sw.status !== 'ativo' || (d !== null && d <= 5)) return true;
    }
    if (r.est && resumoPorEst.get(r.est.id)?.status === 'aguardando') return true;
    return false;
  }, [resumoPorEst]);

  const contagem = useMemo(() => ({
    todos: rows.length,
    software: rows.filter((r) => r.sw).length,
    delivery: rows.filter((r) => r.est).length,
    atencao: rows.filter(precisaAtencao).length,
  }), [rows, precisaAtencao]);

  const visiveis = useMemo(() => {
    const b = busca.trim().toLowerCase();
    return rows.filter((r) => {
      if (filtro === 'software' && !r.sw) return false;
      if (filtro === 'delivery' && !r.est) return false;
      if (filtro === 'atencao' && !precisaAtencao(r)) return false;
      if (!b) return true;
      return [r.nome, r.sw?.usuario, r.sw?.documento_numero, r.est?.responsavel, r.est?.cidade, r.est?.razao_social]
        .some((v) => typeof v === 'string' && v.toLowerCase().includes(b));
    });
  }, [rows, filtro, busca, precisaAtencao]);

  // ── vem do Dashboard: abre direto o cliente que precisa de ajuste
  useEffect(() => {
    if (!focus || !ests) return;
    if (focus.estId) {
      const e = ests.find((x) => x.id === focus.estId);
      if (e) {
        setFiltro('todos'); setBusca('');
        setAberto(rows.find((r) => r.est?.id === e.id)?.key ?? null);
        window.setTimeout(() => rowRefs.current[rows.find((r) => r.est?.id === e.id)?.key ?? '']?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80);
      }
    } else if (focus.clienteId) {
      const c = clientes.find((x) => x.id === focus.clienteId);
      if (c) { setFiltro('todos'); setBusca(''); actions.onEditar(c); }
    }
    onFocusHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce, ests]);

  const clientesSimples = useMemo(
    () => (clientes ?? []).map((c) => ({ id: c.id, nome_estabelecimento: c.nome_estabelecimento })), [clientes],
  );

  const arquivar = async (e: Estabelecimento) => {
    if (!window.confirm(`Remover "${e.nome}" da gestão de delivery? Se tiver histórico, ele será apenas arquivado.`)) return;
    try {
      const r = await api<{ arquivado: boolean }>('DELETE', `/gestao-delivery/estabelecimentos/${e.id}`);
      notify(r.arquivado ? 'Arquivado (o histórico foi mantido).' : 'Removido.'); bump();
    } catch (er) { fail(er); }
  };
  const reativar = async (e: Estabelecimento) => {
    try { await api('POST', `/gestao-delivery/estabelecimentos/${e.id}/reativar`); bump(); } catch (er) { fail(er); }
  };

  if (!ests || !resumo) return <div className="rounded-2xl bg-[#f7f7f8]"><Loading /></div>;

  const chips: { id: Filtro; label: string }[] = [
    { id: 'todos', label: 'Todos' },
    { id: 'software', label: 'Software' },
    { id: 'delivery', label: 'Gestão delivery' },
    { id: 'atencao', label: 'Precisam de atenção' },
  ];

  return (
    <div className="min-w-0 space-y-4 rounded-2xl bg-[#f7f7f8] p-3 text-[#3f3e3e] [color-scheme:light] sm:p-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto min-w-0">
          <h2 className="text-xl font-black sm:text-2xl">Clientes</h2>
          <p className="text-xs text-[#7c7875]">
            {contagem.software} no software · {contagem.delivery} na gestão de delivery · {rows.length} no total
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#a6a29f]" size={16} />
          <input className={`${fieldInputClass} !pl-9`} placeholder="Buscar cliente, usuário, cidade…" value={busca} onChange={(e) => setBusca(e.target.value)} />
        </div>
        <Btn tone="primary" onClick={() => setEdit(emptyEst())}><Plus size={14} />Novo estabelecimento (delivery)</Btn>
      </div>

      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {chips.map((c) => (
          <button key={c.id} type="button" onClick={() => setFiltro(c.id)}
            className={`flex min-h-[38px] shrink-0 items-center gap-2 rounded-xl px-4 text-sm font-bold transition-colors ${
              filtro === c.id ? 'bg-[#ea1d2c] text-[#ffffff] shadow-sm' : 'border border-[#e5e5e7] bg-[#ffffff] text-[#4f4c4a] hover:bg-[#f5f5f5]'}`}>
            {c.label}
            <span className={`rounded-full px-1.5 text-[11px] ${filtro === c.id ? 'bg-[#ffffff]/25' : c.id === 'atencao' && contagem.atencao ? 'bg-[#fef3c7] text-[#b45309]' : 'bg-[#f1f1f3] text-[#6f6b68]'}`}>
              {contagem[c.id]}
            </span>
          </button>
        ))}
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead>
            <tr className="border-b border-[#e5e5e7] bg-[#fafafa] text-[11px] uppercase tracking-wider text-[#7c7875]">
              <th className="px-3 py-3">Cliente</th>
              <th className="px-3 py-3">Software</th>
              <th className="px-3 py-3">Gestão delivery</th>
              <th className="px-3 py-3 text-right">Ações</th>
            </tr>
          </thead>
          <tbody>
            {visiveis.map((r) => {
              const c = r.sw, e = r.est;
              const dias = c ? diasAte(c) : null;
              const online = c?.ultimo_acesso && Date.now() - new Date(c.ultimo_acesso).getTime() < 86400000;
              const res = e ? resumoPorEst.get(e.id) : undefined;
              const isOpen = aberto === r.key;
              return (
                <React.Fragment key={r.key}>
                  <tr ref={(el) => { rowRefs.current[r.key] = el; }}
                    className={`border-b border-[#f1f1f3] align-top hover:bg-[#faf9f9] ${isOpen ? 'bg-[#faf9f9]' : ''}`}>
                    {/* cliente */}
                    <td className="px-3 py-3">
                      <div className="flex items-start gap-2.5">
                        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${c ? (online ? 'bg-[#16a34a]' : 'bg-[#d4d4d8]') : 'bg-transparent'}`}
                          title={c ? (online ? 'Online (acesso recente)' : 'Offline') : ''} />
                        <div className="min-w-0">
                          <p className="font-black text-[#3f3e3e]">{r.nome}</p>
                          <p className="text-[11px] text-[#7c7875]">
                            {[c?.documento_numero ? `${c.documento_tipo ?? ''} ${c.documento_numero}`.trim() : null, e?.responsavel, e?.cidade].filter(Boolean).join(' · ') || '—'}
                          </p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {c && <span className="rounded-full bg-[#e8f3fb] px-2 py-0.5 text-[10px] font-bold uppercase text-[#0369a1]">Software</span>}
                            {e && <span className="rounded-full bg-[#fdecee] px-2 py-0.5 text-[10px] font-bold uppercase text-[#a02331]">Gestão delivery</span>}
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* software */}
                    <td className="px-3 py-3">
                      {c ? (
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="rounded bg-[#f1f1f3] px-2 py-0.5 text-[10px] font-bold uppercase text-[#4f4c4a]">{c.plano || 'completo'}</span>
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${c.status === 'ativo' ? 'bg-[#e8f5ec] text-[#15803d]' : 'bg-[#fdecee] text-[#a02331]'}`}>{c.status}</span>
                            {dias !== null && (
                              <span className={`text-xs font-black ${dias > 5 ? 'text-[#15803d]' : dias > 0 ? 'text-[#b45309]' : 'text-[#b91c1c]'}`}>
                                {dias > 0 ? `${dias}d` : dias === 0 ? 'vence hoje' : `${Math.abs(dias)}d em atraso`}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-[#7c7875]">
                            {brl(c.valor_plano)} · vence {fmtDate(c.vencimento ?? c.trial_fim)} · <span className="font-mono">{c.usuario}</span>
                          </p>
                        </div>
                      ) : <span className="text-xs text-[#a6a29f]">não usa o software</span>}
                    </td>

                    {/* delivery */}
                    <td className="px-3 py-3">
                      {e ? (
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-bold">
                            <span className="rounded-full bg-[#fdecee] px-2 py-0.5 text-[#a02331]">{pctFmt(e.pct_meu)} meu</span>
                            {e.tem_parceiro
                              ? <span className="rounded-full bg-[#f3eefe] px-2 py-0.5 text-[#6d28d9]">{pctFmt(e.pct_parceiro)} {e.parceiro_nome || 'parceiro'}</span>
                              : <span className="rounded-full bg-[#f1f1f3] px-2 py-0.5 text-[#4f4c4a]">sem parceiro</span>}
                            {res && <StatusChip s={res.status} />}
                          </div>
                          <p className="text-xs text-[#7c7875]">
                            acumulado <b className="text-[#4f4c4a]">{brl(e.meu_acumulado)}</b>
                            {res && (res.a_receber + res.em_andamento) > 0 && <> · a receber <b className="text-[#b45309]">{brl(res.a_receber + res.em_andamento)}</b></>}
                          </p>
                        </div>
                      ) : (
                        <button type="button" className="text-xs font-bold text-[#a02331] hover:underline"
                          onClick={() => setEdit({ ...emptyEst(), nome: c?.nome_estabelecimento ?? '', cliente_id: c?.id ?? null, whatsapp: c?.whatsapp ?? null })}>
                          + incluir na gestão de delivery
                        </button>
                      )}
                    </td>

                    {/* ações */}
                    <td className="px-3 py-3 text-right">
                      <div className="relative flex flex-wrap items-center justify-end gap-1.5">
                        {c && <Btn onClick={() => actions.onPainel(c)} title="Abrir painel de suporte do cliente"><Wrench size={14} />Painel</Btn>}
                        {c && <Btn onClick={() => actions.onEditar(c)} title="Editar plano, valor e vencimento"><Pencil size={14} />Plano</Btn>}
                        {e && <Btn onClick={() => setEdit(e)} title="Editar porcentagens, PIX e dados do estabelecimento"><Pencil size={14} />Delivery</Btn>}
                        {e && <Btn onClick={() => setAberto(isOpen ? null : r.key)} title="Semanas, cobrança e baixa">
                          Semanas <ChevronDown size={14} className={isOpen ? 'rotate-180' : ''} /></Btn>}
                        {(c?.whatsapp || e?.whatsapp) && (
                          <a className="inline-flex min-h-[36px] items-center rounded-lg border border-[#d4d4d8] px-2.5 text-[#4f4c4a] hover:bg-[#f5f5f5]" title="WhatsApp"
                            target="_blank" rel="noreferrer" href={`https://wa.me/55${String(c?.whatsapp || e?.whatsapp).replace(/\D/g, '')}`}><MessageCircle size={14} /></a>
                        )}
                        <Btn onClick={() => setMenu(menu === r.key ? null : r.key)} title="Mais ações"><MoreHorizontal size={14} /></Btn>
                        {menu === r.key && (
                          <>
                            <div className="fixed inset-0 z-[60]" onClick={() => setMenu(null)} />
                            <div className="absolute right-0 top-full z-[61] mt-1 w-56 overflow-hidden rounded-xl border border-[#e5e5e7] bg-[#ffffff] py-1 text-left shadow-xl">
                              {c && <>
                                <MenuItem icon={<KeyRound size={14} />} onClick={() => { setMenu(null); actions.onSenhas(c); }}>Alterar senhas</MenuItem>
                                <MenuItem icon={<Users2 size={14} />} onClick={() => { setMenu(null); actions.onSubUsers(c); }}>Sub-usuários</MenuItem>
                                <MenuItem icon={c.status === 'ativo' ? <Lock size={14} /> : <UserCheck size={14} />} onClick={() => { setMenu(null); actions.onBloquear(c); }}>
                                  {c.status === 'ativo' ? 'Bloquear acesso' : 'Desbloquear acesso'}</MenuItem>
                                <MenuItem icon={<LogOut size={14} />} onClick={() => { setMenu(null); actions.onDesconectar(c); }}>Desconectar sessões</MenuItem>
                                <MenuItem danger icon={<Trash2 size={14} />} onClick={() => { setMenu(null); actions.onExcluir(c); }}>Excluir cliente do software</MenuItem>
                              </>}
                              {e && <MenuItem danger icon={<Building2 size={14} />} onClick={() => { setMenu(null); arquivar(e); }}>Tirar da gestão de delivery</MenuItem>}
                            </div>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  {isOpen && e && (
                    <tr><td colSpan={4} className="bg-[#faf9f9] p-0">
                      <EstDetalhe estId={e.id} api={api} version={version} notify={notify} fail={fail} bump={bump} />
                    </td></tr>
                  )}
                </React.Fragment>
              );
            })}
            {visiveis.length === 0 && (
              <tr><td colSpan={4} className="p-10 text-center text-sm text-[#7c7875]">
                {busca || filtro !== 'todos' ? 'Nenhum cliente encontrado com esse filtro.' : 'Nenhum cliente cadastrado ainda.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {arquivados.length > 0 && (
        <div>
          <button type="button" className="text-xs font-bold text-[#7c7875] hover:text-[#4f4c4a]" onClick={() => setShowArq((v) => !v)}>
            {showArq ? 'Ocultar' : 'Ver'} arquivados da gestão de delivery ({arquivados.length})
          </button>
          {showArq && (
            <ul className="mt-2 space-y-1">
              {arquivados.map((e) => (
                <li key={e.id} className="flex items-center justify-between rounded-lg border border-[#e5e5e7] bg-[#ffffff] px-3 py-2 text-sm text-[#6f6b68]">
                  {e.nome}<Btn onClick={() => reativar(e)}>Reativar</Btn>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <EstabelecimentoEditor edit={edit} onClose={() => setEdit(null)} api={api} notify={notify} fail={fail} clientes={clientesSimples}
        onSaved={() => { setEdit(null); bump(); }} />

      {toast && (
        <div className={`fixed bottom-5 left-1/2 z-[90] -translate-x-1/2 rounded-xl px-4 py-2.5 text-sm font-bold shadow-xl ${
          toast.ok ? 'bg-[#15803d] text-[#ffffff]' : 'bg-[#b91c1c] text-[#ffffff]'}`}>{toast.msg}</div>
      )}
    </div>
  );
}

function MenuItem({ children, icon, onClick, danger }: { children: React.ReactNode; icon: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-xs font-bold hover:bg-[#f5f5f5] ${danger ? 'text-[#a02331]' : 'text-[#3f3e3e]'}`}>
      {icon}{children}
    </button>
  );
}
