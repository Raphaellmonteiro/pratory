/**
 * MenuHubScreen.tsx — Tela de menu inicial pós-login do Pratory.
 *
 * Exibida logo após o login (e reaberta pelo botão "Menu" na sidebar),
 * permitindo que o usuário escolha visualmente para qual área do sistema
 * deseja ir, em vez de cair direto no Balcão/PDV.
 */

import React from 'react';
import {
  Monitor,
  Bike,
  Armchair,
  ClipboardList,
  BookOpen,
  Users,
  BarChart3,
  Settings,
  LogOut,
  HelpCircle,
} from 'lucide-react';

export interface MenuHubItem {
  tab: string;
  label: string;
  description: string;
  icon: React.ReactNode;
}

interface MenuHubScreenProps {
  userName: string;
  userRoleLabel: string;
  onSelect: (tab: string) => void;
  onLogout: () => void;
  /** Itens já filtrados por permissão (canAccess) e plano do usuário. */
  items?: MenuHubItem[];
  supportPhone?: string;
}

// Ícones padrão, usados quando a tela monta a lista automaticamente a
// partir das chaves de tab conhecidas (ver DEFAULT_ICONS abaixo).
const DEFAULT_ICONS: Record<string, React.ReactNode> = {
  pos: <Monitor className="w-8 h-8" />,
  delivery: <Bike className="w-8 h-8" />,
  mesas: <Armchair className="w-8 h-8" />,
  central: <ClipboardList className="w-8 h-8" />,
  orders: <ClipboardList className="w-8 h-8" />,
  products: <BookOpen className="w-8 h-8" />,
  clientes: <Users className="w-8 h-8" />,
  dashboard: <BarChart3 className="w-8 h-8" />,
  finance: <BarChart3 className="w-8 h-8" />,
  configuracoes: <Settings className="w-8 h-8" />,
};

export default function MenuHubScreen({
  userName,
  userRoleLabel,
  onSelect,
  onLogout,
  items = [],
  supportPhone,
}: MenuHubScreenProps) {
  return (
    <div className="min-h-screen w-full bg-zinc-950 flex flex-col items-center px-6 py-10 lg:py-16 relative overflow-hidden">
      {/* Glow decorativo de fundo, no espírito da marca */}
      <div className="pointer-events-none absolute -top-32 left-1/2 -translate-x-1/2 w-[640px] h-[640px] rounded-full bg-[#EA1D2C]/10 blur-[120px]" />

      {/* Cabeçalho */}
      <div className="w-full max-w-5xl flex items-center justify-between relative z-10 mb-10 lg:mb-14">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-[#EA1D2C] to-[#9C050B] flex items-center justify-center shadow-lg shadow-[#EA1D2C]/20">
            <ClipboardList className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-white text-xl font-black tracking-tight leading-none">Pratory</h1>
            <p className="text-zinc-500 text-xs mt-0.5">Sistema de Gestão para Restaurantes</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block">
            <p className="text-white text-sm font-semibold leading-none">Olá, {userName}</p>
            <p className="text-zinc-500 text-xs mt-1">{userRoleLabel}</p>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="flex items-center gap-1.5 px-3 h-9 rounded-lg border border-zinc-800 text-zinc-400
                       hover:border-[#EA1D2C]/50 hover:text-[#EA1D2C] text-xs font-semibold transition-all"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sair
          </button>
        </div>
      </div>

      {/* Título */}
      <div className="text-center relative z-10 mb-8 lg:mb-12">
        <h2 className="text-white text-2xl lg:text-3xl font-black tracking-tight">Bem-vindo ao Pratory</h2>
        <p className="text-zinc-500 text-sm mt-2">Escolha uma opção para começar</p>
      </div>

      {/* Grade de opções */}
      <div className="w-full max-w-5xl grid grid-cols-2 md:grid-cols-4 gap-4 relative z-10">
        {items.map((item) => (
          <button
            key={item.tab}
            type="button"
            onClick={() => onSelect(item.tab)}
            className="group flex flex-col items-center justify-center text-center gap-3
                       px-4 py-8 rounded-2xl border border-zinc-800/80 bg-gradient-to-b from-zinc-900/60 to-black/40
                       hover:border-[#EA1D2C]/60 hover:from-[#EA1D2C]/10 hover:to-black/40
                       active:scale-[0.98] transition-all"
          >
            <span className="text-[#EA1D2C] group-hover:scale-110 transition-transform">
              {item.icon}
            </span>
            <span className="text-white font-bold text-sm">{item.label}</span>
            <span className="text-zinc-500 text-xs leading-snug">{item.description}</span>
          </button>
        ))}
      </div>

      {/* Rodapé de suporte */}
      {supportPhone && (
        <div className="mt-12 relative z-10">
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-zinc-400 text-xs">
            <HelpCircle className="w-4 h-4" />
            <span>Suporte Pratory</span>
            <span className="text-zinc-700">|</span>
            <a
              href={`https://wa.me/${supportPhone.replace(/\D/g, '')}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#4ade80] hover:underline"
            >
              {supportPhone}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

export { DEFAULT_ICONS };
