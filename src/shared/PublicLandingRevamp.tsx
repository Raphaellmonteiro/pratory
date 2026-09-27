import React, { useState } from 'react';
import { PUBLIC_SEGMENT_OPTIONS } from '../config/publicSegments';
import { WHATSAPP_NUMBER, INSTAGRAM_URL } from '../config/contactLinks';

const STOCK_PHOTOS = {
  kitchen: 'https://images.pexels.com/photos/30120987/pexels-photo-30120987.jpeg?auto=compress&cs=tinysrgb&w=1400',
  cardapio: 'https://images.pexels.com/photos/8753672/pexels-photo-8753672.jpeg?auto=compress&cs=tinysrgb&w=900',
  delivery: 'https://images.pexels.com/photos/7362948/pexels-photo-7362948.jpeg?auto=compress&cs=tinysrgb&w=900',
};

const HIGHLIGHTS = [
  { icon: '🧾', label: 'PDV completo: mesas, cozinha e estoque' },
  { icon: '📱', label: 'Cardápio online por link ou QR Code' },
  { icon: '🛵', label: 'Delivery gerenciado no iFood e 99' },
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
            <p className="mt-0.5 text-xs font-medium tracking-wide text-fptext-secondary">Gestão e tecnologia para alimentação</p>
          </div>
          <nav className="flex shrink-0 items-center gap-2 sm:gap-3">
            <button type="button" onClick={goToWhatsApp}
              className="hidden rounded-xl px-4 py-2.5 text-sm font-semibold text-fptext-secondary transition-colors hover:bg-fp-hover sm:block">
              Atendimento
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
            <p className="pratori-text-eyebrow text-[11px] font-bold uppercase">Gestão e tecnologia para alimentação</p>
            <h1 className="mt-4 max-w-[20ch] text-balance text-[2rem] font-extrabold leading-[1.06] tracking-tight text-fptext-primary sm:max-w-[22ch] sm:text-[2.8rem] lg:text-[3.1rem]">
              Sistema de gestão e <span className="pratori-mark font-black">gestão de delivery</span> para o seu negócio vender mais.
            </h1>
            <p className="mt-6 max-w-2xl text-pretty text-base leading-relaxed text-fptext-secondary sm:text-[1.08rem]">
              Tudo em um só lugar: sistema para sua loja, delivery gerenciado e cardápio online.
            </p>
            <div className="mt-9 grid grid-cols-1 gap-3 sm:grid-cols-3">
              {HIGHLIGHTS.map((h) => (
                <div key={h.label}
                  className="flex items-center gap-3 rounded-2xl border border-fp-border bg-fp-card px-4 py-3.5 shadow-[0_8px_20px_rgba(63,62,62,0.04)] sm:flex-col sm:items-start sm:gap-2.5 sm:px-5 sm:py-4">
                  <span className="text-2xl" aria-hidden>{h.icon}</span>
                  <span className="text-sm font-semibold leading-snug text-fptext-primary sm:text-[0.95rem]">{h.label}</span>
                </div>
              ))}
            </div>
            <div className="mt-11 flex flex-wrap items-center gap-3.5">
              <button type="button" onClick={() => openModal('Delivery')}
                className="pratori-btn-primary rounded-xl px-6 py-3.5 text-sm font-semibold shadow-[0_14px_30px_rgba(156,5,11,0.2)] transition-all hover:-translate-y-[1px]">
                Teste grátis por 7 dias
              </button>
              <button type="button" onClick={goToWhatsApp}
                className="pratori-btn-secondary rounded-xl px-6 py-3.5 text-sm font-semibold shadow-[0_6px_18px_rgba(63,62,62,0.05)] transition-colors">
                Falar com a gente
              </button>
            </div>
            <div className="mt-8 flex max-w-2xl flex-wrap gap-x-5 gap-y-2 rounded-2xl border border-[#f6d9dc] bg-[#fff9fa] px-4 py-3.5 text-xs font-medium leading-relaxed text-fptext-secondary shadow-[0_8px_24px_rgba(63,62,62,0.04)] sm:px-5">
              <span>✓ Configuração feita junto com você</span>
              <span>✓ Pix cai direto na sua conta</span>
              <span>✓ Suporte via WhatsApp em Maceió</span>
              <span>✓ Sem fidelidade</span>
            </div>
          </section>

          <aside className="relative isolate overflow-hidden rounded-3xl shadow-[0_24px_60px_rgba(63,62,62,0.16)]">
            <img
              src={STOCK_PHOTOS.kitchen}
              alt="Cozinha de restaurante em operação"
              className="absolute inset-0 h-full w-full object-cover"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-gradient-to-br from-black/70 via-black/45 to-black/20" aria-hidden />

            <div className="relative flex min-h-[380px] items-center justify-center p-6 sm:min-h-[440px] sm:p-8">
              {/* Mockup tablet */}
              <div className="w-[230px] rounded-[26px] bg-[#141414] p-2.5 shadow-[0_30px_60px_rgba(0,0,0,0.45)] sm:w-[260px]">
                <div className="flex h-[290px] flex-col overflow-hidden rounded-[18px] bg-white sm:h-[320px]">
                  <div className="flex h-8 shrink-0 items-center gap-1.5 bg-[#EA1D2C] px-3">
                    <span className="text-[11px] font-extrabold text-white">Pratory</span>
                  </div>
                  <div className="flex flex-1">
                    <div className="flex w-10 shrink-0 flex-col items-center gap-3 border-r border-[#F0F0F0] bg-[#FAFAFB] py-3">
                      {[0, 1, 2, 3].map((i) => (
                        <span key={i} className="h-4 w-4 rounded-md bg-[#E6E6E6]" aria-hidden />
                      ))}
                    </div>
                    <div className="flex-1 space-y-2 p-2.5">
                      {[0, 1, 2, 3, 4].map((i) => (
                        <div key={i} className="flex items-center gap-2 rounded-lg bg-[#F5F5F5] p-1.5">
                          <span className={`h-5 w-5 shrink-0 rounded-md ${i % 3 === 0 ? 'bg-[#BEEBD0]' : 'bg-[#E6E6E6]'}`} aria-hidden />
                          <span className="h-2 flex-1 rounded-full bg-[#E0E0E0]" aria-hidden />
                          <span className="h-2 w-6 shrink-0 rounded-full bg-[#EA1D2C]/30" aria-hidden />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Mockup celular, sobreposto */}
              <div className="absolute bottom-6 right-6 w-[110px] rounded-[22px] bg-[#141414] p-1.5 shadow-[0_20px_40px_rgba(0,0,0,0.45)] sm:right-8 sm:w-[126px]">
                <div className="flex h-[200px] flex-col overflow-hidden rounded-[16px] bg-white sm:h-[228px]">
                  <div className="h-6 shrink-0 bg-[#EA1D2C]" aria-hidden />
                  <div className="flex-1 space-y-2 p-2">
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="flex items-center gap-1.5 rounded-md bg-[#F5F5F5] p-1">
                        <span className="h-5 w-5 shrink-0 rounded bg-[#E6E6E6]" aria-hidden />
                        <div className="flex-1 space-y-1">
                          <span className="block h-1.5 w-full rounded-full bg-[#E0E0E0]" aria-hidden />
                          <span className="block h-1.5 w-2/3 rounded-full bg-[#EFEFEF]" aria-hidden />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="absolute left-5 top-5 inline-flex items-center gap-2 rounded-full border border-white/25 bg-black/35 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-white backdrop-blur">
              <span className="h-2 w-2 rounded-full bg-[#4ADE80]" aria-hidden />
              Pronto para usar hoje
            </div>
          </aside>
        </div>
      </main>

      {/* ── Destaques visuais ── */}
      <section className="border-t border-fp-border bg-[#FAFAFB] py-14 sm:py-16">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 sm:grid-cols-3 sm:px-6">
          {[
            {
              photo: STOCK_PHOTOS.kitchen,
              alt: 'Balcão de restaurante em operação',
              title: 'Controle Total',
              desc: 'Gestão completa: mesas, cozinha e estoque em tempo real.',
            },
            {
              photo: STOCK_PHOTOS.cardapio,
              alt: 'Prato pronto para pedido no cardápio digital',
              title: 'Cardápio Digital',
              desc: 'Cardápio online personalizável, por link ou QR Code.',
            },
            {
              photo: STOCK_PHOTOS.delivery,
              alt: 'Entregador levando pedido de delivery',
              title: 'Delivery Integrado',
              desc: 'Pedidos do iFood, 99 e outros canais, tudo numa tela só.',
            },
          ].map((card) => (
            <div key={card.title} className="overflow-hidden rounded-3xl border border-fp-border bg-fp-card shadow-[0_12px_28px_rgba(63,62,62,0.05)]">
              <div className="relative aspect-[4/3]">
                <img src={card.photo} alt={card.alt} className="h-full w-full object-cover" loading="lazy" />
                <div className="absolute inset-0 bg-gradient-to-t from-black/35 via-black/0 to-black/0" aria-hidden />
              </div>
              <div className="p-5 sm:p-6">
                <h3 className="text-lg font-bold tracking-tight text-fptext-primary">{card.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-fptext-secondary">{card.desc}</p>
              </div>
            </div>
          ))}
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
            {INSTAGRAM_URL && (
              <a
                href={INSTAGRAM_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Instagram da Pratory"
                className="inline-flex items-center justify-center rounded-full p-1.5 text-fptext-secondary transition-colors hover:bg-fp-hover hover:text-[#EA1D2C]"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <rect x="2" y="2" width="20" height="20" rx="5.5" stroke="currentColor" strokeWidth="2" />
                  <circle cx="12" cy="12" r="4.3" stroke="currentColor" strokeWidth="2" />
                  <circle cx="17.1" cy="6.9" r="1.1" fill="currentColor" />
                </svg>
              </a>
            )}
          </div>
        </div>
      </footer>

    </div>
  );
}