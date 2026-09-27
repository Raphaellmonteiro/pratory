/**
 * LoginScreen.tsx — Tela de login do Pratory (usuário/senha).
 *
 * Esta tela é só o formulário de acesso ao sistema. A apresentação
 * institucional da Pratory (o que é, para quem é, soluções) fica na
 * landing pública em "/" (ver src/shared/PublicLandingRevamp.tsx).
 */

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';

// ── Tipos ────────────────────────────────────────────────────────────────────
interface LoginScreenProps {
  onLogin: (token: string) => void;
  onShowSolicitacao?: () => void;
  onLicenseError?: (type: 'bloqueado' | 'trial_expirado') => void;
}

// ── Componente principal ─────────────────────────────────────────────────────
export default function LoginScreen({ onLogin, onShowSolicitacao, onLicenseError }: LoginScreenProps) {
  const [username, setUsername]     = useState('');
  const [password, setPassword]     = useState('');
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('Preencha usuário e senha.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res  = await fetch('/api/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json();

      if (!res.ok) {
        if (data?.tipo === 'bloqueado' || data?.tipo === 'trial_expirado') {
          onLicenseError?.(data.tipo);
          return;
        }
        setError(data?.message || data?.error || 'Usuário ou senha incorretos.');
        return;
      }
      if (data?.token) onLogin(data.token);
      else setError('Resposta inválida do servidor.');
    } catch {
      setError('Erro de conexão. Verifique sua internet.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center bg-zinc-950 px-6 py-10">

      <div className="w-full max-w-sm">

        {/* Link para voltar ao site institucional */}
        <div className="mb-6 text-center">
          <a
            href="/"
            className="inline-flex items-center gap-1.5 text-zinc-500 hover:text-zinc-300 text-xs font-medium transition-colors"
          >
            ← Voltar para o site da Pratory
          </a>
        </div>

        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="relative mb-4">
            <img
              src="/images/logopratory.jpeg"
              alt="Pratory"
              className="w-24 h-24 rounded-[28px] object-cover shadow-2xl
                         ring-2 ring-[#EA1D2C]/30"
            />
            {/* brilho decorativo */}
            <div className="absolute -inset-1 rounded-[32px] bg-[#EA1D2C]/10 blur-xl -z-10" />
          </div>
          <h2 className="text-2xl font-black text-white tracking-tight">Pratory</h2>
          <p className="text-zinc-500 text-sm mt-1">Acesse sua conta</p>
        </div>

        {/* Formulário */}
        <form onSubmit={handleSubmit} className="space-y-4">

          {/* Usuário */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-1.5">
              Usuário
            </label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="seu-estabelecimento"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="username"
              required
              className="w-full h-12 px-4 rounded-xl bg-zinc-900 border border-zinc-800
                         text-white placeholder-zinc-600 text-sm
                         focus:outline-none focus:border-[#EA1D2C]/60 focus:ring-1
                         focus:ring-[#EA1D2C]/30 transition-all"
            />
          </div>

          {/* Senha */}
          <div>
            <label className="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-1.5">
              Senha
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
              className="w-full h-12 px-4 rounded-xl bg-zinc-900 border border-zinc-800
                         text-white placeholder-zinc-600 text-sm
                         focus:outline-none focus:border-[#EA1D2C]/60 focus:ring-1
                         focus:ring-[#EA1D2C]/30 transition-all"
            />
          </div>

          {/* Mensagem de erro */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="flex items-start gap-2 px-4 py-3 rounded-xl
                           bg-red-950/50 border border-red-800/60 text-red-300 text-sm"
              >
                <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                {error}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Botão entrar */}
          <button
            type="submit"
            disabled={loading}
            className="w-full h-12 rounded-xl bg-[#EA1D2C] hover:bg-[#C9101E]
                       active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed
                       text-white font-black text-sm uppercase tracking-wider
                       transition-all shadow-lg shadow-[#EA1D2C]/20 mt-2"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Entrando…
              </span>
            ) : 'Entrar no sistema'}
          </button>
        </form>

        {/* Divisor */}
        <div className="flex items-center gap-3 my-6">
          <div className="flex-1 h-px bg-zinc-800" />
          <span className="text-zinc-600 text-xs">ou</span>
          <div className="flex-1 h-px bg-zinc-800" />
        </div>

        {/* Solicitar acesso */}
        {onShowSolicitacao && (
          <button
            type="button"
            onClick={onShowSolicitacao}
            className="w-full h-11 rounded-xl border border-zinc-800 text-zinc-400
                       hover:border-zinc-600 hover:text-zinc-200 hover:bg-zinc-900
                       text-sm font-semibold transition-all"
          >
            Solicitar acesso ao Pratory
          </button>
        )}

        {/* Rodapé */}
        <p className="text-center text-zinc-700 text-[11px] mt-8 leading-relaxed">
          Ao acessar, você concorda com os{' '}
          <a href="/termos" target="_blank" rel="noopener noreferrer"
             className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2 transition-colors">
            Termos de Uso
          </a>{' '}
          e{' '}
          <a href="/privacidade" target="_blank" rel="noopener noreferrer"
             className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2 transition-colors">
            Política de Privacidade
          </a>.
        </p>
      </div>
    </div>
  );
}