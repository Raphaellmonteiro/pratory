import React from 'react';
import {
  Clock,
  Lock,
  Smartphone,
  ArrowLeft,
} from 'lucide-react';
import { motion } from 'motion/react';
import { Card, Button } from '../components/ui/Card';
import { WHATSAPP_NUMBER } from '../config/contactLinks';

const WA_LINK = `https://wa.me/${WHATSAPP_NUMBER}?text=Olá!%20Tenho%20interesse%20no%20Pratory`;

export default function LicenseBlockedScreen({ type, onBack }: { type: 'bloqueado' | 'trial_expirado', onBack: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 p-6">
      <motion.div 
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-md text-center"
      >
        <Card className="p-10">
          <div className={`w-20 h-20 rounded-3xl flex items-center justify-center mx-auto mb-6 ${type === 'bloqueado' ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600'}`}>
            {type === 'bloqueado' ? <Lock size={40} /> : <Clock size={40} />}
          </div>
          
          <h1 className="text-2xl font-bold text-zinc-900 mb-3">
            {type === 'bloqueado' ? "Acesso Bloqueado" : "Seu período de teste encerrou"}
          </h1>
          
          <p className="text-zinc-600 mb-8">
            {type === 'bloqueado' 
              ? "Sua conta foi suspensa temporariamente. Entre em contato com o suporte para regularizar seu acesso."
              : "Esperamos que tenha gostado da experiência! Para continuar utilizando o sistema, entre em contato para ativar sua licença definitiva."}
          </p>

          <div className="bg-zinc-50 p-6 rounded-2xl border border-zinc-100 mb-8">
            <p className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Falar com Consultor</p>
            <a 
              href={WA_LINK}
              target="_blank" 
              rel="noreferrer"
              className="flex items-center justify-center gap-3 text-emerald-600 font-bold text-lg hover:scale-105 transition-transform"
            >
              <Smartphone size={24} />
              {WHATSAPP_NUMBER.replace(/^55(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3')}
            </a>
          </div>

          <Button variant="ghost" onClick={onBack} className="w-full py-3">
            <ArrowLeft size={18} /> Voltar ao Login
          </Button>
        </Card>
      </motion.div>
    </div>
  );
}

// --- PAINEL ADMIN ---