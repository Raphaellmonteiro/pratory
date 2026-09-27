// Local único de configuração dos links de contato comercial da Pratory.
// Para trocar o número de WhatsApp ou adicionar o Instagram, altere
// apenas os valores abaixo — todo o front-end (institucional, login,
// avisos de bloqueio de licença, banner de recarga de IA etc.) usa
// esta mesma fonte.

/** Número de WhatsApp comercial, no formato DDI+DDD+número (só dígitos). */
export const WHATSAPP_NUMBER = '5582981831172';

/**
 * Link do Instagram institucional da Pratory.
 */
export const INSTAGRAM_URL = 'https://www.instagram.com/pratoryfoodservice/';

/**
 * Monta a URL do wa.me com o número comercial e uma mensagem
 * pré-preenchida (opcional). Use isto em vez de montar a URL na mão
 * em cada componente.
 */
export function buildWhatsAppUrl(message?: string): string {
  const base = `https://wa.me/${WHATSAPP_NUMBER}`;
  if (!message) return base;
  return `${base}?text=${encodeURIComponent(message)}`;
}