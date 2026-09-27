import React, { useState } from 'react';
import { PUBLIC_SEGMENT_OPTIONS } from '../config/publicSegments';
import { WHATSAPP_NUMBER, INSTAGRAM_URL } from '../config/contactLinks';

const HIGHLIGHTS = [
  'Sistema completo para PDV, mesas, cozinha e estoque',
  'Cardápio online com link ou QR Code para o cliente pedir',
  'Gestão profissional do seu delivery no iFood e 99',
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
              A Pratory reúne o sistema para operar seu restaurante, bar ou delivery e uma equipe que cuida da sua loja no iFood, 99 e outros canais — tudo em um só lugar.
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
              <button type="button" onClick={goToWhatsApp}
                className="pratori-btn-secondary rounded-xl px-6 py-3.5 text-sm font-semibold shadow-[0_6px_18px_rgba(63,62,62,0.05)] transition-colors">
                Falar com a gente
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
              <a href={INSTAGRAM_URL} target="_blank" rel="noopener noreferrer" className="font-medium underline-offset-4 hover:underline">Instagram</a>
            )}
          </div>
        </div>
      </footer>

    </div>
  );
}