import React, { useState } from 'react';
import { PUBLIC_SEGMENT_NOTE, PUBLIC_SEGMENT_OPTIONS } from '../config/publicSegments';
import { WHATSAPP_NUMBER } from '../config/contactLinks';

const HIGHLIGHTS = [
  'Mesmo sistema para balcão, mesa, delivery e retirada',
  'Cliente pede pelo cardápio online (link ou QR Code)',
  'Caixa e estoque no ritmo do dia a dia',
];

const MODULES = [
  { icon: '🧾', label: 'PDV — venda no balcão, mesa e para levar' },
  { icon: '👨‍🍳', label: 'Cozinha vê a fila de pedidos em tempo real' },
  { icon: '🛵', label: 'Delivery com cardápio online e Pix integrado' },
  { icon: '🪑', label: 'Mesas e comanda digital' },
  { icon: '📦', label: 'Estoque e fechamento de caixa' },
  { icon: '📲', label: 'Notificações automáticas para o cliente' },
];

const PLANS = [
  {
    id: 'pdv_essencial',
    name: 'PDV Essencial',
    price: 'R$ 149',
    period: '/mês',
    desc: 'Para quem vende no balcão e não precisa de delivery.',
    highlight: false,
    features: [
      'PDV completo',
      'Controle de pedidos',
      'Impressão na cozinha',
      'Mesas e comanda',
      'Fechamento de caixa',
    ],
  },
  {
    id: 'delivery',
    name: 'Delivery',
    price: 'R$ 249',
    period: '/mês',
    desc: 'Para quem quer vender online e receber pelo Pix.',
    highlight: true,
    features: [
      'Tudo do PDV Essencial',
      'Cardápio online (link + QR Code)',
      'Delivery próprio',
      'Pix integrado',
      'Rastreamento do pedido pelo cliente',
      'Notificações automáticas via WhatsApp',
    ],
  },
  {
    id: 'completo',
    name: 'Completo',
    price: 'R$ 349',
    period: '/mês',
    desc: 'Gestão completa com estoque, relatórios e suporte prioritário.',
    highlight: false,
    features: [
      'Tudo do Delivery',
      'Controle de estoque',
      'Relatórios e dashboard',
      'Logs e auditoria',
      'Suporte prioritário',
    ],
  },
];

type FormData = {
  nome: string;
  empresa: string;
  cnpj: string;
  whatsapp: string;
  email: string;
  cidade: string;
  segmento: string;
  plano: string;
};

const EMPTY_FORM: FormData = {
  nome: '',
  empresa: '',
  cnpj: '',
  whatsapp: '',
  email: '',
  cidade: '',
  segmento: '',
  plano: '',
};

function formatCnpj(v: string) {
  return v.replace(/\D/g, '')
    .slice(0, 14)
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d)/, '$1-$2');
}

function formatPhone(v: string) {
  return v.replace(/\D/g, '')
    .slice(0, 11)
    .replace(/^(\d{2})(\d)/, '($1) $2')
    .replace(/(\d{5})(\d{1,4})$/, '$1-$2');
}

function buildWhatsAppMsg(data: FormData) {
  return encodeURIComponent(
    `Olá! Acabei de solicitar uma demonstração do plano *${data.plano}* e gostaria de mais informações.\n\n` +
    `Nome: ${data.nome}\nEmpresa: ${data.empresa}\nCidade: ${data.cidade}\nSegmento: ${data.segmento}`
  );
}

export default function PublicLandingRevamp({
  onShowSolicitacao,
}: {
  onShowSolicitacao: () => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [formData, setFormData] = useState<FormData>(EMPTY_FORM);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const goToLogin = () => { window.location.href = '/login'; };
  const goToWhatsApp = () => {
    window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent('Olá! Quero saber mais sobre o Pratory para meu restaurante.')}`, '_blank');
  };

  const openModal = (planName: string) => {
    setFormData({ ...EMPTY_FORM, plano: planName });
    setSent(false);
    setError('');
    setModalOpen(true);
  };

  const scrollToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    if (name === 'cnpj') { setFormData(p => ({ ...p, cnpj: formatCnpj(value) })); return; }
    if (name === 'whatsapp') { setFormData(p => ({ ...p, whatsapp: formatPhone(value) })); return; }
    setFormData(p => ({ ...p, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.nome || !formData.whatsapp || !formData.segmento) {
      setError('Preencha nome, WhatsApp e segmento para continuar.');
      return;
    }
    setSending(true);
    setError('');
    try {
      await fetch('/api/solicitacoes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...formData, origem: 'landing_planos' }),
      });
    } catch {
      // falha silenciosa — abre WhatsApp mesmo assim
    }
    setSending(false);
    setSent(true);
    setTimeout(() => {
      setModalOpen(false);
      window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${buildWhatsAppMsg(formData)}`, '_blank');
    }, 1400);
  };

  const segmentLine = PUBLIC_SEGMENT_OPTIONS.map((s) => s.label).join(' · ');

  return (
    <div className="pratori-public-light min-h-screen bg-fp-app text-fptext-primary">

      {/* ── Modal de pré-cadastro ── */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setModalOpen(false); }}
        >
          <div className="relative w-full max-w-lg rounded-3xl border border-fp-border bg-fp-card p-6 shadow-[0_32px_80px_rgba(0,0,0,0.18)] sm:p-8">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="absolute right-4 top-4 rounded-full p-2 text-fptext-secondary hover:bg-fp-hover"
              aria-label="Fechar"
            >
              ✕
            </button>

            {sent ? (
              <div className="flex flex-col items-center gap-4 py-8 text-center">
                <div className="text-4xl">✅</div>
                <h3 className="text-lg font-bold text-fptext-primary">Solicitação recebida!</h3>
                <p className="text-sm text-fptext-secondary">Abrindo o WhatsApp para continuar o atendimento…</p>
              </div>
            ) : (
              <>
                <div className="mb-6">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-[#EA1D2C]">Solicitar demonstração</p>
                  <h3 className="mt-1 text-xl font-extrabold tracking-tight text-fptext-primary">
                    Plano <span className="pratori-mark">{formData.plano}</span>
                  </h3>
                  <p className="mt-1 text-sm text-fptext-secondary">Preencha os dados e entraremos em contato via WhatsApp.</p>
                </div>

                {error && (
                  <p className="mb-4 rounded-xl bg-[#fff5f5] px-4 py-3 text-sm text-[#c0392b]">{error}</p>
                )}

                <form onSubmit={handleSubmit} className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-fptext-secondary">Nome do responsável *</label>
                      <input name="nome" value={formData.nome} onChange={handleChange} placeholder="João Silva"
                        className="w-full rounded-xl border border-fp-border bg-fp-app px-4 py-2.5 text-sm text-fptext-primary placeholder:text-fptext-secondary focus:border-[#EA1D2C] focus:outline-none" />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-fptext-secondary">Nome da empresa</label>
                      <input name="empresa" value={formData.empresa} onChange={handleChange} placeholder="Restaurante do João"
                        className="w-full rounded-xl border border-fp-border bg-fp-app px-4 py-2.5 text-sm text-fptext-primary placeholder:text-fptext-secondary focus:border-[#EA1D2C] focus:outline-none" />
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-fptext-secondary">WhatsApp *</label>
                      <input name="whatsapp" value={formData.whatsapp} onChange={handleChange} placeholder="(82) 99999-9999"
                        className="w-full rounded-xl border border-fp-border bg-fp-app px-4 py-2.5 text-sm text-fptext-primary placeholder:text-fptext-secondary focus:border-[#EA1D2C] focus:outline-none" />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-fptext-secondary">E-mail</label>
                      <input name="email" type="email" value={formData.email} onChange={handleChange} placeholder="joao@email.com"
                        className="w-full rounded-xl border border-fp-border bg-fp-app px-4 py-2.5 text-sm text-fptext-primary placeholder:text-fptext-secondary focus:border-[#EA1D2C] focus:outline-none" />
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-fptext-secondary">CNPJ</label>
                      <input name="cnpj" value={formData.cnpj} onChange={handleChange} placeholder="00.000.000/0001-00"
                        className="w-full rounded-xl border border-fp-border bg-fp-app px-4 py-2.5 text-sm text-fptext-primary placeholder:text-fptext-secondary focus:border-[#EA1D2C] focus:outline-none" />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-fptext-secondary">Cidade</label>
                      <input name="cidade" value={formData.cidade} onChange={handleChange} placeholder="Maceió"
                        className="w-full rounded-xl border border-fp-border bg-fp-app px-4 py-2.5 text-sm text-fptext-primary placeholder:text-fptext-secondary focus:border-[#EA1D2C] focus:outline-none" />
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-fptext-secondary">Segmento *</label>
                    <select name="segmento" value={formData.segmento} onChange={handleChange}
                      className="w-full rounded-xl border border-fp-border bg-fp-app px-4 py-2.5 text-sm text-fptext-primary focus:border-[#EA1D2C] focus:outline-none">
                      <option value="">Selecione o segmento</option>
                      {PUBLIC_SEGMENT_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  </div>

                  <button type="submit" disabled={sending}
                    className="pratori-btn-primary mt-2 w-full rounded-xl px-5 py-3.5 text-sm font-semibold shadow-[0_12px_28px_rgba(156,5,11,0.2)] transition-all hover:-translate-y-[1px] disabled:opacity-60">
                    {sending ? 'Enviando…' : '💬 Confirmar e abrir WhatsApp'}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <header className="sticky top-0 z-20 border-b border-fp-border bg-fp-card/96 shadow-[0_4px_20px_rgba(63,62,62,0.05)] backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6 sm:py-5">
          <div className="min-w-0">
            <div className="pratori-text-brand text-2xl font-extrabold tracking-tight sm:text-[1.7rem]">Pratory</div>
            <p className="mt-0.5 text-xs font-medium tracking-wide text-fptext-secondary">Restaurante e delivery</p>
          </div>
          <nav className="flex shrink-0 items-center gap-2 sm:gap-3">
            <button type="button" onClick={() => scrollToSection('lp-planos')}
              className="hidden rounded-xl px-4 py-2.5 text-sm font-semibold text-fptext-secondary transition-colors hover:bg-fp-hover sm:block">
              Planos
            </button>
            <button type="button" onClick={goToLogin}
              className="rounded-xl border border-transparent px-4 py-2.5 text-sm font-semibold text-fptext-primary transition-colors hover:bg-fp-hover">
              Entrar
            </button>
            <button type="button" onClick={() => openModal('Delivery')}
              className="pratori-btn-primary rounded-xl px-4 py-2.5 text-sm font-semibold shadow-[0_10px_24px_rgba(156,5,11,0.18)] transition-all hover:-translate-y-[1px]">
              Pedir teste
            </button>
          </nav>
        </div>
      </header>

      {/* ── Hero ── */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12 sm:px-6 sm:py-16 lg:py-20">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.18fr)_minmax(330px,0.82fr)] lg:items-start lg:gap-12">
          <section>
            <p className="pratori-text-eyebrow text-[11px] font-bold uppercase">Venda, cozinha e caixa</p>
            <h1 className="mt-4 max-w-[18ch] text-balance text-[2rem] font-extrabold leading-[1.06] tracking-tight text-fptext-primary sm:max-w-[20ch] sm:text-[2.8rem] lg:text-[3.1rem]">
              Balcão, mesa e <span className="pratori-mark font-black">delivery</span> no mesmo sistema.
            </h1>
            <p className="mt-6 max-w-2xl text-pretty text-base leading-relaxed text-fptext-secondary sm:text-[1.08rem]">
              Pedido vai para a cozinha, o caixa fecha certo e o cliente pode pedir pelo cardápio no celular. Tudo num lugar só, fácil no dia a dia.
            </p>
            <ul className="mt-10 space-y-4 text-sm leading-relaxed text-fptext-primary sm:text-[0.96rem]">
              {HIGHLIGHTS.map((line) => (
                <li key={line} className="flex gap-3.5 rounded-lg px-1 py-0.5">
                  <span className="pratori-bullet mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full shadow-[0_0_0_4px_rgba(234,29,44,0.11)]" aria-hidden />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <div className="mt-11 flex flex-wrap items-center gap-3.5">
              <button type="button" onClick={() => openModal('Delivery')}
                className="pratori-btn-primary rounded-xl px-6 py-3.5 text-sm font-semibold shadow-[0_14px_30px_rgba(156,5,11,0.2)] transition-all hover:-translate-y-[1px]">
                Teste grátis por 7 dias
              </button>
              <button type="button" onClick={() => scrollToSection('lp-planos')}
                className="pratori-btn-secondary rounded-xl px-6 py-3.5 text-sm font-semibold shadow-[0_6px_18px_rgba(63,62,62,0.05)] transition-colors">
                Ver planos e preços
              </button>
            </div>
            <p className="mt-8 max-w-2xl rounded-2xl border border-[#f6d9dc] bg-[#fff9fa] px-4 py-3.5 text-xs leading-relaxed text-fptext-secondary shadow-[0_8px_24px_rgba(63,62,62,0.04)] sm:px-5">
              Teste sem cartão · ajuda para começar · serve restaurante, lanchonete, bar e delivery.
            </p>
          </section>

          <aside className="relative overflow-hidden rounded-3xl border border-fp-border bg-fp-card p-6 shadow-[0_24px_60px_rgba(63,62,62,0.1)] sm:p-7">
            <div className="absolute -right-10 -top-10 h-28 w-28 rounded-full bg-[#fff3f5]" aria-hidden />
            <div className="relative">
              <div className="inline-flex items-center gap-2 rounded-full border border-[#f2d6d9] bg-[#fff7f8] px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-[#a02331]">
                <span className="h-2 w-2 rounded-full bg-[#EA1D2C]" aria-hidden />
                Pronto para usar hoje
              </div>
              <h2 className="mt-4 text-[1.35rem] font-extrabold leading-tight tracking-tight text-fptext-primary sm:text-[1.5rem]">
                Sem fidelidade. Cancela quando quiser.
              </h2>
            </div>
            <div className="mt-6 space-y-3.5">
              {[
                '✓  Configuração feita junto com você',
                '✓  Cardápio online no seu link ou QR Code',
                '✓  Pix cai direto na sua conta',
                '✓  Suporte via WhatsApp em Maceió',
              ].map((item) => (
                <div key={item}
                  className="rounded-2xl border border-fp-border bg-[#FAFAFB] px-4 py-3.5 text-sm font-medium leading-relaxed text-fptext-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                  {item}
                </div>
              ))}
            </div>
            <button type="button" onClick={goToWhatsApp}
              className="mt-7 w-full rounded-xl bg-[#25D366] px-5 py-3.5 text-sm font-semibold text-white shadow-[0_12px_28px_rgba(37,211,102,0.25)] transition-all hover:-translate-y-[1px]">
              💬 Falar no WhatsApp agora
            </button>
          </aside>
        </div>
      </main>

      {/* ── O que inclui ── */}
      <section id="lp-modulos" className="border-t border-fp-border bg-[#FAFAFB] py-14 sm:py-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <h2 className="text-center text-[1.5rem] font-extrabold tracking-tight text-fptext-primary sm:text-[1.95rem]">
            O que a plataforma entrega hoje
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-sm leading-relaxed text-fptext-secondary">
            Tudo pronto para usar no primeiro dia.
          </p>
          <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-5">
            {MODULES.map((m) => (
              <li key={m.label}
                className="flex items-start gap-3 rounded-2xl border border-fp-border bg-fp-card px-5 py-4 text-sm leading-snug text-fptext-primary shadow-[0_12px_28px_rgba(63,62,62,0.05)]">
                <span className="mt-0.5 text-lg" aria-hidden>{m.icon}</span>
                <span>{m.label}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── Planos ── */}
      <section id="lp-planos" className="border-t border-fp-border bg-fp-app py-14 sm:py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <h2 className="text-center text-[1.5rem] font-extrabold tracking-tight text-fptext-primary sm:text-[1.95rem]">
            Planos e preços
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-center text-sm leading-relaxed text-fptext-secondary">
            Sem taxas escondidas. Você escolhe o plano e pode trocar a qualquer momento.
          </p>

          <div className="mt-12 grid gap-6 sm:grid-cols-3">
            {PLANS.map((plan) => (
              <div key={plan.id}
                className={`relative flex flex-col rounded-3xl border p-6 shadow-[0_18px_44px_rgba(63,62,62,0.08)] sm:p-7 ${
                  plan.highlight
                    ? 'border-[#EA1D2C] bg-fp-card ring-2 ring-[#EA1D2C]/20'
                    : 'border-fp-border bg-fp-card'
                }`}>
                {plan.highlight && (
                  <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                    <span className="rounded-full bg-[#EA1D2C] px-4 py-1 text-[11px] font-bold uppercase tracking-wide text-white shadow-[0_8px_20px_rgba(234,29,44,0.3)]">
                      Mais popular
                    </span>
                  </div>
                )}
                <div>
                  <p className="text-sm font-bold text-fptext-secondary">{plan.name}</p>
                  <div className="mt-2 flex items-end gap-1">
                    <span className="text-[2.2rem] font-extrabold leading-none tracking-tight text-fptext-primary">{plan.price}</span>
                    <span className="mb-1 text-sm text-fptext-secondary">{plan.period}</span>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-fptext-secondary">{plan.desc}</p>
                </div>
                <ul className="mt-6 flex-1 space-y-2.5">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-sm text-fptext-primary">
                      <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full bg-[#EA1D2C]/10 text-center text-[10px] font-bold leading-4 text-[#EA1D2C]">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
                <button type="button" onClick={() => openModal(plan.name)}
                  className={`mt-8 w-full rounded-xl px-5 py-3.5 text-sm font-semibold transition-all hover:-translate-y-[1px] ${
                    plan.highlight
                      ? 'pratori-btn-primary shadow-[0_12px_28px_rgba(156,5,11,0.2)]'
                      : 'pratori-btn-secondary'
                  }`}>
                  Quero este plano
                </button>
              </div>
            ))}
          </div>

          <p className="mt-8 text-center text-xs text-fptext-secondary">
            Dúvidas sobre qual plano escolher?{' '}
            <button type="button" onClick={goToWhatsApp} className="font-semibold text-[#EA1D2C] underline-offset-2 hover:underline">
              Fale com a gente no WhatsApp
            </button>
          </p>
        </div>
      </section>

      {/* ── Segmentos ── */}
      <section id="lp-segmentos" className="border-t border-fp-border bg-[#FAFAFB] py-12 sm:py-14">
        <div className="mx-auto max-w-5xl px-4">
          <h2 className="text-xl font-bold tracking-tight text-fptext-primary sm:text-2xl">
            Tipos de estabelecimento
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-fptext-secondary">{segmentLine}</p>
          <div className="pratori-card-soft mt-6 rounded-2xl p-4 sm:p-5">
            <p className="text-sm font-semibold text-fptext-primary">Leia antes de contratar</p>
            <p className="mt-2 text-sm leading-relaxed text-fptext-secondary">{PUBLIC_SEGMENT_NOTE}</p>
          </div>
        </div>
      </section>

      {/* ── CTA final ── */}
      <section className="pratori-cta-band py-12 sm:py-14">
        <div className="mx-auto max-w-5xl px-4 text-center">
          <div className="mx-auto max-w-2xl rounded-3xl border border-fp-border bg-fp-card px-5 py-8 shadow-[0_18px_44px_rgba(63,62,62,0.08)] sm:px-8">
            <p className="pratori-text-eyebrow text-[11px] font-bold uppercase">Teste na sua loja</p>
            <h2 className="mt-3 text-xl font-bold tracking-tight text-fptext-primary sm:text-2xl">
              7 dias grátis, sem cartão
            </h2>
            <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-fptext-secondary">
              Use na operação e veja se pedidos, cozinha e caixa ficam do jeito que você precisa.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <button type="button" onClick={() => openModal('Delivery')}
                className="pratori-btn-primary rounded-xl px-5 py-3 text-sm font-semibold transition-colors">
                Pedir teste
              </button>
              <button type="button" onClick={goToWhatsApp}
                className="rounded-xl bg-[#25D366] px-5 py-3 text-sm font-semibold text-white transition-all hover:brightness-105">
                💬 WhatsApp
              </button>
              <button type="button" onClick={goToLogin}
                className="pratori-btn-secondary rounded-xl px-5 py-3 text-sm font-semibold transition-colors">
                Já tenho login
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-fp-border bg-fp-card py-8">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-4 px-4 text-center text-sm text-fptext-secondary">
          <div>
            <span className="pratori-text-brand font-bold">Pratory</span>
            <span className="text-fptext-secondary"> · RM Tecnologia</span>
          </div>
          <p className="text-xs text-fptext-secondary">
            © {new Date().getFullYear()} RM Tecnologia. Todos os direitos reservados.
          </p>
          <div className="pratori-footer-links flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs">
            <a href="/privacidade" className="font-medium underline-offset-4 hover:underline">Privacidade</a>
            <a href="/termos" className="font-medium underline-offset-4 hover:underline">Termos de uso</a>
            <button type="button" onClick={() => openModal('Delivery')} className="font-medium underline-offset-4 hover:underline">Pedir teste</button>
            <button type="button" onClick={goToWhatsApp} className="font-medium text-[#25D366] underline-offset-4 hover:underline">WhatsApp</button>
          </div>
        </div>
      </footer>

    </div>
  );
}