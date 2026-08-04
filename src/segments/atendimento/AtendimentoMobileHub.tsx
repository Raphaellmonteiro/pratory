/**
 * AtendimentoMobileHub.tsx — tela inicial de /m/atendimento (exige login
 * normal, mesmo token de sessão de sempre). Dá pro atendente escolher entre
 * dois fluxos já existentes, sem duplicar lógica:
 *  - Balcão / WhatsApp → AtendimentoMobileScreen (busca cliente por telefone,
 *    monta pedido avulso/delivery já com dados preenchidos).
 *  - Mesas → reaproveita o GarcomMobileScreen (mesmo usado no QR do garçom),
 *    mas autenticado com o token normal do atendente em vez do QR
 *    temporário — o back-end já libera tudo pra sessão normal.
 */

import React from 'react';
import { ArrowLeft, LayoutGrid, UtensilsCrossed } from 'lucide-react';

const AtendimentoMobileScreen = React.lazy(() => import('./AtendimentoMobileScreen'));
const GarcomMobileScreen = React.lazy(() => import('../bar/GarcomMobileScreen'));

type View = 'hub' | 'balcao' | 'mesas';

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Voltar ao menu de atendimento"
      className="fixed top-3 left-3 z-50 w-9 h-9 flex items-center justify-center rounded-full
                 bg-zinc-900/90 border border-zinc-800 text-zinc-300 backdrop-blur"
    >
      <ArrowLeft className="w-4 h-4" />
    </button>
  );
}

function SubScreenFallback() {
  return (
    <div className="min-h-screen w-full bg-zinc-950 flex items-center justify-center">
      <div className="h-8 w-8 rounded-full border-2 border-zinc-700 border-t-[#EA1D2C] animate-spin" />
    </div>
  );
}

export default function AtendimentoMobileHub({ token }: { token: string }) {
  const [view, setView] = React.useState<View>('hub');

  if (view === 'balcao') {
    return (
      <div className="relative min-h-screen w-full">
        <BackButton onClick={() => setView('hub')} />
        <React.Suspense fallback={<SubScreenFallback />}>
          <AtendimentoMobileScreen token={token} />
        </React.Suspense>
      </div>
    );
  }

  if (view === 'mesas') {
    return (
      <div className="relative min-h-screen w-full">
        <BackButton onClick={() => setView('hub')} />
        <React.Suspense fallback={<SubScreenFallback />}>
          <GarcomMobileScreen qrToken={token} />
        </React.Suspense>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-zinc-950 flex flex-col items-center justify-center px-6 gap-4">
      <div className="text-center mb-2">
        <h1 className="text-white text-2xl font-black">Atendimento</h1>
        <p className="text-zinc-500 text-sm mt-1">Escolha o que você vai fazer agora.</p>
      </div>

      <button
        type="button"
        onClick={() => setView('balcao')}
        className="w-full max-w-sm flex items-center gap-4 p-5 rounded-2xl bg-zinc-900 border border-zinc-800
                   hover:border-[#EA1D2C]/50 transition-colors text-left"
      >
        <span className="w-12 h-12 rounded-xl bg-[#EA1D2C]/10 flex items-center justify-center shrink-0">
          <LayoutGrid className="w-6 h-6 text-[#EA1D2C]" />
        </span>
        <span>
          <span className="block text-white font-bold text-base">Balcão / WhatsApp</span>
          <span className="block text-zinc-500 text-xs mt-0.5">
            Pedido avulso — busca o cliente pelo telefone e já preenche os dados
          </span>
        </span>
      </button>

      <button
        type="button"
        onClick={() => setView('mesas')}
        className="w-full max-w-sm flex items-center gap-4 p-5 rounded-2xl bg-zinc-900 border border-zinc-800
                   hover:border-[#EA1D2C]/50 transition-colors text-left"
      >
        <span className="w-12 h-12 rounded-xl bg-[#EA1D2C]/10 flex items-center justify-center shrink-0">
          <UtensilsCrossed className="w-6 h-6 text-[#EA1D2C]" />
        </span>
        <span>
          <span className="block text-white font-bold text-base">Mesas</span>
          <span className="block text-zinc-500 text-xs mt-0.5">
            Abrir mesa e lançar itens direto na comanda
          </span>
        </span>
      </button>
    </div>
  );
}
