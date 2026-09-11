import React from 'react';

type NavItemProps = {
  active?: boolean;
  attention?: boolean;
  badgeCount?: number;
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  /** Item visível porém não interativo (ex.: “em breve”). */
  disabled?: boolean;
  title?: string;
  /** Recua o item (usado para sub-itens dentro de um grupo expansível). */
  indent?: boolean;
};

export default function NavItem({
  active = false,
  attention = false,
  badgeCount,
  onClick,
  icon,
  label,
  disabled = false,
  title,
  indent = false,
}: NavItemProps) {
  if (disabled) {
    return (
      <div
        role="button"
        aria-disabled="true"
        title={title}
        className={`group relative flex w-full min-w-0 cursor-not-allowed items-center gap-2.5 rounded-lg px-2.5 py-2 text-left opacity-50 min-h-[38px] lg:min-h-[36px] ${indent ? 'ml-7' : ''}`}
      >
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-fptext-muted">
          <span className="flex h-full w-full items-center justify-center text-[15px] leading-none" aria-hidden>
            {icon}
          </span>
        </span>
        <span className="min-w-0 flex-1 truncate text-left text-[13px] font-medium leading-snug text-fptext-muted">
          {label}
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`group relative flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors active:opacity-80 min-h-[38px] lg:min-h-[36px] ${indent ? 'ml-7 w-[calc(100%-1.75rem)]' : ''} ${
        active
          ? 'bg-fp-accent/10 text-fp-accent'
          : attention
            ? 'bg-amber-50 text-amber-900 hover:bg-amber-100'
            : 'text-fptext-secondary hover:bg-fp-hover hover:text-fptext-primary'
      }`}
    >
      <span
        className={`absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full transition-all ${
          active ? 'bg-fp-accent' : attention ? 'bg-amber-500' : 'bg-transparent'
        }`}
      />
      <span
        className={`inline-flex h-5 w-5 shrink-0 items-center justify-center ${
          active ? 'text-fp-accent' : attention ? 'text-amber-700' : 'text-fptext-muted group-hover:text-fptext-primary'
        }`}
      >
        <span className="flex h-full w-full items-center justify-center text-[15px] leading-none" aria-hidden>
          {icon}
        </span>
      </span>
      <span className={`min-w-0 flex-1 truncate text-left text-[13px] leading-snug ${active ? 'font-bold' : 'font-medium'}`}>
        {label}
      </span>
      {typeof badgeCount === 'number' && badgeCount > 0 ? (
        <span
          className={`min-w-[19px] shrink-0 rounded-full px-1.5 py-0.5 text-center text-[10px] font-black leading-none ${
            active
              ? 'bg-fp-accent text-white'
              : attention
                ? 'bg-amber-500 text-white'
                : 'bg-fp-secondary text-fptext-secondary'
          }`}
        >
          {badgeCount > 99 ? '99+' : badgeCount}
        </span>
      ) : null}
    </button>
  );
}

/** Cabeçalho discreto de seção (ex.: "ANÁLISE", "GERENCIAMENTO"), no estilo do painel do iFood. */
export function NavSectionLabel({ label }: { label: string }) {
  return (
    <p className="px-2.5 pt-3 pb-1 text-[10px] font-black uppercase tracking-wider text-fptext-muted/70 first:pt-1">
      {label}
    </p>
  );
}

// --- TELA DE LOGIN ---