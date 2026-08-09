import React, { memo } from 'react';
import {
  Plus,
  Clock,
  X,
  Printer,
  ChefHat,
} from 'lucide-react';
import { openPrintPreviewFromUrl } from '../../utils/print';

function MesaCard({
  mesa,
  onOpen,
  onClose,
  onClick,
  token,
}: {
  key?: React.Key;
  mesa: any;
  onOpen: (m: any) => void;
  onClose: (m: any) => void;
  onClick: (m: any) => void;
  token: string;
}) {
  const isOpen = mesa.status === 'aberta';
  const subtotal = Number(mesa.subtotal_valor ?? mesa.total_valor ?? 0);
  const valorTaxa = Number(mesa.valor_taxa_servico || 0);
  const valorCouvert = Number(mesa.valor_couvert || 0);
  const hasExtras = valorTaxa > 0 || valorCouvert > 0;

  const handlePrint = async (e: React.MouseEvent) => {
    e.stopPropagation();

    try {
      const win = await openPrintPreviewFromUrl(`/api/mesas/${mesa.id}/comanda-html`, token);

      if (!win) {
        alert('Permita popups para imprimir.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('(404)')) {
        alert('Mesa vazia - sem itens para imprimir.');
        return;
      }

      alert('Erro ao gerar impressao da comanda.');
    }
  };

  const handlePrintProducao = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const win = await openPrintPreviewFromUrl(`/api/mesas/${mesa.id}/producao-html`, token);
      if (!win) alert('Permita popups para imprimir.');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('(404)')) {
        alert('Sem comanda aberta ou sem itens.');
        return;
      }
      alert('Erro ao gerar comanda de produção.');
    }
  };

  return (
    <div
      className={`mesa-card-shell relative rounded-xl border overflow-hidden transition-all duration-200 hover:scale-[1.02] hover:shadow-lg group ${
        isOpen
          ? 'border-l-4 border-l-red-400 border-red-400/35 bg-zinc-900 hover:bg-zinc-900/95 shadow-[0_10px_30px_rgba(0,0,0,0.35)]'
          : 'border-l-4 border-l-emerald-400 border-emerald-400/35 bg-zinc-900 hover:bg-zinc-900/95 shadow-[0_10px_30px_rgba(0,0,0,0.35)]'
      }`}
    >
      <div
        className={`absolute top-2 right-2 flex items-center gap-1 text-[9px] font-black px-2 py-1 rounded-full uppercase tracking-[0.18em] shadow-sm ${
          isOpen
            ? 'border border-red-400/45 bg-red-400/18 text-red-50'
            : 'border border-emerald-400/45 bg-emerald-400/18 text-emerald-50'
        }`}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isOpen ? 'bg-red-300 animate-pulse' : 'bg-emerald-200'}`} />
        {isOpen ? 'Ocupada' : 'Livre'}
      </div>

      <button
        onClick={() => onClick(mesa)}
        disabled={!isOpen}
        className={`w-full pt-5 pb-2 px-3 flex flex-col items-center transition-all active:scale-[0.98] ${
          isOpen ? 'hover:bg-white/[0.03] cursor-pointer' : 'cursor-default'
        }`}
      >
        <span className="text-3xl font-black text-zinc-100 leading-none drop-shadow-[0_1px_0_rgba(255,255,255,0.08)]">{mesa.numero}</span>
        <span className="text-[11px] font-extrabold text-zinc-200/80 mt-1 uppercase tracking-[0.22em]">Mesa</span>

        {isOpen && mesa.garcom_nome && (
          <div className="mt-1.5 w-full flex items-center justify-center gap-1 text-[9px] font-bold text-zinc-200/70 uppercase tracking-wide truncate">
            <span className="w-1 h-1 rounded-full bg-[#EA1D2C]/70 shrink-0" />
            <span className="truncate">Garçom: {mesa.garcom_nome}</span>
          </div>
        )}

        {isOpen && (
          <div className="mt-2 w-full space-y-0.5">
            {mesa.total_itens > 0 ? (
              <>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-zinc-200/85">{mesa.total_itens} item(s)</span>
                  <span className={`font-black ${hasExtras ? 'text-zinc-100' : 'text-white'}`}>R$ {subtotal.toFixed(2)}</span>
                </div>
                {valorTaxa > 0 && (
                  <div className="flex items-center justify-between text-[9px] text-zinc-200/70">
                    <span>Taxa</span>
                    <span>R$ {valorTaxa.toFixed(2)}</span>
                  </div>
                )}
                {valorCouvert > 0 && (
                  <div className="flex items-center justify-between text-[9px] text-zinc-200/70">
                    <span>Couvert</span>
                    <span>R$ {valorCouvert.toFixed(2)}</span>
                  </div>
                )}
                {hasExtras && (
                  <div className="flex items-center justify-between text-[11px] pt-1 mt-1 border-t border-zinc-800">
                    <span className="font-semibold text-zinc-200/85">Total</span>
                    <span className="font-black text-zinc-100">R$ {Number(mesa.total_valor).toFixed(2)}</span>
                  </div>
                )}
              </>
            ) : (
              <p className="text-[11px] text-zinc-200/80 text-center font-medium">Vazia</p>
            )}

            {mesa.opened_at && (
              <div className="flex items-center justify-center gap-0.5 text-[10px] text-zinc-200/80 mt-1">
                <Clock size={8} />
                {new Date(
                  mesa.opened_at + (mesa.opened_at.includes('Z') ? '' : '-03:00')
                ).toLocaleTimeString('pt-BR', {
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZone: 'America/Sao_Paulo',
                })}
              </div>
            )}
          </div>
        )}
      </button>

      <div className={`px-2 pb-2 flex gap-1.5 ${!isOpen ? 'pt-2' : ''}`}>
        {isOpen ? (
          <>
            <div className="flex-1 flex gap-1">
              <button
                type="button"
                title="Comanda mesa"
                onClick={handlePrint}
                className="flex-1 flex items-center justify-center py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-100 transition-all"
              >
                <Printer size={11} />
              </button>
              <button
                type="button"
                title="Produção (cozinha)"
                onClick={handlePrintProducao}
                className="flex-1 flex items-center justify-center py-1.5 bg-amber-900/40 hover:bg-amber-900/55 border border-amber-700/40 rounded-lg text-amber-100 transition-all"
              >
                <ChefHat size={11} />
              </button>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(mesa);
              }}
              className="flex-1 flex items-center justify-center gap-0.5 py-1.5 bg-red-500/15 hover:bg-red-500/25 border border-red-500/25 rounded-lg text-[10px] font-bold text-red-200 transition-all"
            >
              <X size={11} />
              Fechar
            </button>
          </>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpen(mesa);
            }}
            className="w-full flex items-center justify-center gap-1 py-2 bg-emerald-400 hover:bg-emerald-300 text-zinc-950 rounded-lg text-[11px] font-black transition-all active:scale-95 shadow-[0_6px_18px_rgba(16,185,129,0.28)] ring-1 ring-emerald-200/10"
          >
            <Plus size={11} />
            Abrir Mesa
          </button>
        )}
      </div>
    </div>
  );
}

export default memo(MesaCard);
