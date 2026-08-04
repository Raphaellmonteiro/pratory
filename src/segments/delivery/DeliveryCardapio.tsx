// src/segments/delivery/DeliveryCardapio.tsx
// Cardápio online premium — design limpo, login por telefone
import React, { useState, useEffect, useMemo, useCallback, useRef, Fragment } from 'react';
import { useDebounce } from '../../hooks/useDebounce';
import { motion, AnimatePresence } from 'motion/react';
import {
  ShoppingCart, Plus, Minus, MapPin, Smartphone, Banknote,
  CreditCard, CheckCircle2, Search, Package, User, LogOut,
  History, ArrowLeft, Trash2, Home, ChevronRight, Clock,
  Bike, Heart, X, Pencil, AlertCircle, ClipboardList, ShoppingBag,
  Tag, MessageCircle, Instagram, Info, Menu, Utensils, Copy, Loader2,
} from 'lucide-react';
import {
  buildDeliveryCardapioTheme,
  normalizeDeliveryCardapioThemeMode,
  type DeliveryCardapioThemeMode,
  type DeliveryCardapioTheme,
} from './deliveryCardapioTheme';
import { CardapioThemeShell, useDeliveryCardapioTheme } from './DeliveryCardapioThemeContext';
import {
  ProductOptionsModal,
  type ComboGrupoUi,
  type ProductOptionsProduto,
  type Selecoes,
} from '../../shared/ProductOptionsModal';
import PedidoRastreamento from '../../shared/PedidoRastreamento';
import { normalizeCardapioOnlineBannerSlots } from '../../utils/deliveryCardapioBannerSlots';
import {
  findDeliveryZoneByBairro,
  MENSAGEM_ENTREGA_FORA_DA_AREA,
} from '../../utils/deliveryBairroZona';
import { normalizeBrazilDeliveryPhoneDigits } from '../../utils/deliveryFirstPurchaseEligibility';
import { normalizeProductPhotoPublicUrl } from '../../utils/productPhotoUrl';
import { FlowProductImage } from '../../shared/FlowProductImage';
import { fetchViaCep } from '../../utils/viacep';

// ─── Tipos ────────────────────────────────────────────────────────────────────
interface OpcaoItem { id: number; nome: string; preco_adicional: number; }
interface GrupoOpcao {
  id: number; nome: string; tipo: 'radio'|'checkbox'|'quantidade';
  min_selecoes: number; max_selecoes: number; obrigatorio: boolean;
  modo_preco?: 'adicional'|'final'; // 'final' = item define o preço total, não adiciona ao base
  itens: OpcaoItem[];
}
interface VariacaoVendavel { id: number; nome: string; preco: number; }
interface Produto {
  id: number; name: string; price: number; category: string;
  photo_url?: string; description?: string; descricao?: string;
  destaque?: number;
  em_promocao?: number | boolean;
  preco_original?: number | null;
  grupos_opcao?: GrupoOpcao[];
  variacoes_vendaveis?: VariacaoVendavel[];
  is_combo?: number | boolean;
  combo_grupos?: ComboGrupoUi[];
}
interface Categoria { nome: string; itens: Produto[]; }

/** Resposta parcial de `/public/delivery/:slug/suggestions` (produto sugerido). */
interface SuggestionItem {
  id: number;
  name: string;
  price?: number;
  category?: string;
  photo_url?: string;
  variacoes_vendaveis?: VariacaoVendavel[] | string;
  source_product_id?: number;
  prioridade?: number;
  total_eventos?: number;
}
interface Config {
  modelo_entrega?: 'bairro_fixo';
  taxa_entrega: number;
  pedido_minimo: number;
  tempo_preparo: number;
  pix_chave?: string;
  pix_nome?: string;
  pix_cidade?: string;
  pix_payload_estatico?: string;
  qr_code_image_base64?: string;
  payment_provider?: string;
  payment_external_id?: string;
  payment_external_reference?: string;
  payment_status?: string;
  payment_expires_at?: string;
  whatsapp?: string;
  horario_abertura?: string;
  horario_fechamento?: string;
  /** Agenda semanal por dia (opcional). */
  horarios_semana_ativo?: boolean;
  horarios_semana?: unknown;
  /** Próximos horários calculados pelo backend (compatível com múltiplas janelas). */
  proxima_abertura?: string | null;
  proximo_fechamento?: string | null;
  desconto_pix?: number;
  zonas_entrega?: Array<{nome: string; taxa: number}>;
  desconto_primeiro_cliente_ativo?: boolean;
  desconto_primeiro_cliente_tipo?: 'percentual'|'fixo'|'frete_gratis';
  desconto_primeiro_cliente_valor?: number;
  desconto_primeiro_cliente_min_pedido?: number;
  theme_mode?: DeliveryCardapioThemeMode;
  /** 4 URLs de banner do topo (índice 0 = slot visual 1). Alias histórico: `cardapio_banner_slots`. */
  cardapio_online_banner_urls?: string[];
  /** @deprecated Preferir `cardapio_online_banner_urls` (mesmo conteúdo na API pública). */
  cardapio_banner_slots?: string[];
  /** 0=domingo … 6=sábado. Eco do painel; aberto/fechado vem de `ativo` / `dia_folga_hoje`. */
  dias_folga_entrega?: number[];
}
interface CheckoutResumo {
  modelo_entrega: 'bairro_fixo';
  bairro_entrega: string | null;
  subtotal: number;
  desconto_pix: number;
  subtotal_apos_desconto_pix: number;
  taxa_entrega: number;
  zona_entrega: { nome: string; taxa: number } | null;
  entrega_bloqueada_por_zona?: boolean;
  mensagem_entrega_bloqueada?: string;
  desconto_cupom: number;
  cupom_aplicado: { codigo: string; tipo: 'percentual'|'fixo'|'frete_gratis' } | null;
  cupom_invalido?: string;
  desconto_primeiro_cliente: number;
  primeiro_cliente: {
    ativo: boolean;
    elegivel: boolean;
    aplicado: boolean;
    tipo: 'percentual'|'fixo'|'frete_gratis';
    valor_configurado: number;
    min_pedido: number;
    descricao: string;
    motivo: string;
    mensagem: string;
  };
  total: number;
}
type CupomAplicadoResumo = CheckoutResumo['cupom_aplicado'];

type DeliveryVisualConfig = {
  logoUrl: string;
  coverImages: string[];
  /** 4 células do hero; se ausente, usa apenas `coverImages` / destaques. */
  coverSlots?: string[];
  backgroundImage: string;
  backgroundOpacity: number;
};

function resolveDeliveryLogoUrl(cfg: DeliveryVisualConfig, apiLogo: string | null | undefined): string | null {
  const fromCfg = String(cfg.logoUrl || '').trim();
  if (fromCfg) return fromCfg;
  const fromApi = String(apiLogo || '').trim();
  return fromApi || null;
}

function resolveDeliveryBackgroundDecor(cfg: DeliveryVisualConfig): { url: string | null; opacity: number } {
  const url = String(cfg.backgroundImage || '').trim() || null;
  const raw = Number(cfg.backgroundOpacity);
  const opacity = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.1;
  return { url, opacity };
}

function normalizeHeroImageSrc(raw: unknown): string {
  const text = String(raw || '').trim();
  if (!text) return '';
  const normalized = normalizeProductPhotoPublicUrl(text);
  if (normalized) return normalized;
  const unixPath = text.replace(/\\/g, '/');
  if (/^https?:\/\//i.test(unixPath) || unixPath.startsWith('//') || unixPath.startsWith('data:') || unixPath.startsWith('blob:')) {
    return unixPath;
  }
  const cleanRelative = unixPath.replace(/^\.\//, '');
  if (!cleanRelative) return '';
  return cleanRelative.startsWith('/') ? cleanRelative : `/${cleanRelative}`;
}

type HeroGalleryItem = {
  key: string;
  src: string;
  alt: string;
  tipo: 'banner' | 'destaque' | 'logo' | 'fallback';
};

/** Hero 2×2: `coverSlots[0..3]` = slots visuais 1–4; só células vazias usam destaque/logo/letra. */
function resolveDeliveryHeroGallery(
  cfg: DeliveryVisualConfig,
  produtosDestaque: Produto[],
  logoResolvido: string | null,
  nome: string
): HeroGalleryItem[] {
  const slots = cfg.coverSlots;
  if (Array.isArray(slots) && slots.length === 4) {
    const productPool = produtosDestaque
      .map((p) => normalizeProductPhotoPublicUrl(p.photo_url))
      .filter((src): src is string => Boolean(src));
    let prodIdx = 0;
    const nextProductSrc = () => {
      if (!productPool.length) return '';
      const src = productPool[prodIdx % productPool.length];
      prodIdx++;
      return src;
    };
    return [0, 1, 2, 3].map((index) => {
      const configured = String(slots[index] || '').trim();
      if (configured) {
        const src = normalizeHeroImageSrc(configured);
        return {
          key: `cover-slot-${index}`,
          src,
          alt: nome || 'Loja',
          tipo: 'banner' as const,
        };
      }
      let src = nextProductSrc();
      let tipo: HeroGalleryItem['tipo'] = 'destaque';
      if (!src && logoResolvido) {
        src = logoResolvido;
        tipo = 'logo';
      }
      if (!src) {
        tipo = 'fallback';
      }
      return {
        key: `cover-slot-${index}`,
        src,
        alt: nome || 'Loja',
        tipo,
      };
    });
  }

  const capasConfig = [...(cfg.coverImages || [])].map(String).filter((s) => s.trim());
  if (capasConfig.length > 0) {
    const imagens: HeroGalleryItem[] = capasConfig
      .slice(0, 4)
      .map((src, index): HeroGalleryItem | null => {
        const normalized = normalizeHeroImageSrc(src);
        if (!normalized) return null;
        return {
          key: `cover-config-${index}`,
          src: normalized,
          alt: nome || 'Loja',
          tipo: 'destaque' as const,
        };
      })
      .filter((item): item is HeroGalleryItem => item != null);
    const base = imagens[0];
    while (imagens.length < 4 && base) {
      imagens.push({
        key: `${base.key}-rep-${imagens.length}`,
        src: base.src,
        alt: base.alt,
        tipo: 'destaque',
      });
    }
    return imagens;
  }

  const imagens: HeroGalleryItem[] = produtosDestaque
    .map((produto) => {
      const src = normalizeProductPhotoPublicUrl(produto.photo_url);
      return src ? { produto, src } : null;
    })
    .filter((x): x is { produto: Produto; src: string } => x != null)
    .slice(0, 4)
    .map(({ produto, src }, index) => ({
      key: `produto-${produto.id}-${index}`,
      src,
      alt: produto.name,
      tipo: 'destaque' as const,
    }));

  const base = imagens[0];
  while (imagens.length < 4 && base) {
    imagens.push({
      key: `${base.key}-rep-${imagens.length}`,
      src: base.src,
      alt: base.alt,
      tipo: 'destaque',
    });
  }

  if (imagens.length === 0 && logoResolvido) {
    return Array.from({ length: 4 }, (_, index) => ({
      key: `logo-${index}`,
      src: logoResolvido,
      alt: nome || 'Logo da loja',
      tipo: 'logo' as const,
    }));
  }

  if (imagens.length === 0) {
    return Array.from({ length: 4 }, (_, index) => ({
      key: `fallback-${index}`,
      src: '',
      alt: nome || 'Loja',
      tipo: 'fallback' as const,
    }));
  }

  return imagens;
}

interface CartItem extends Produto {
  qty: number;
  selecoes?: Selecoes;        // opções selecionadas
  preco_final: number;        // preço base + adicionais
  obs_opcoes?: string;        // descrição textual das opções (para o pedido)
  cart_key: string;           // chave única para diferenciar variações do mesmo produto
  variation_id?: number | null;
}
function buildSuggestionProductSignature(cart: CartItem[]): string {
  const uniqueIds = new Set<number>();
  for (const item of cart) {
    const productId = Number(item.id);
    if (Number.isInteger(productId) && productId > 0) {
      uniqueIds.add(productId);
    }
  }
  return Array.from(uniqueIds).sort((a, b) => a - b).join(',');
}
interface Endereco { id: number; label: string; logradouro: string; numero?: string; complemento?: string; bairro?: string; referencia?: string; principal: number; }

/** Campos de endereço alinhados ao modelo `delivery_enderecos` (checkout + Meus endereços). */
type DeliveryEnderecoCampos = {
  cep: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
  referencia: string;
};

function emptyDeliveryEnderecoCampos(): DeliveryEnderecoCampos {
  return {
    cep: '',
    logradouro: '',
    numero: '',
    complemento: '',
    bairro: '',
    cidade: '',
    uf: '',
    referencia: '',
  };
}

function onlyCepDigits(value: string): string {
  return value.replace(/\D/g, '').slice(0, 8);
}

function formatCepInputDisplay(digits: string): string {
  const d = onlyCepDigits(digits);
  if (d.length <= 5) return d;
  return `${d.slice(0, 5)}-${d.slice(5)}`;
}

function formatEnderecoResumoTexto(campos: DeliveryEnderecoCampos): string {
  const cityUf = [campos.cidade.trim(), campos.uf.trim()].filter(Boolean).join(' - ');
  const parts = [
    [campos.logradouro.trim(), campos.numero.trim()].filter(Boolean).join(', '),
    campos.complemento.trim() || '',
    campos.bairro.trim() || '',
    cityUf || '',
    campos.referencia.trim() ? `Ref: ${campos.referencia.trim()}` : '',
  ].filter(Boolean);
  return parts.join(' • ');
}

/** Alinhado ao backend `formatSavedDeliveryAddress` (texto gravado no pedido). */
function formatEnderecoPedidoLinha(campos: DeliveryEnderecoCampos): string {
  const cityUf = [campos.cidade.trim(), campos.uf.trim()].filter(Boolean).join(' - ');
  return [
    [campos.logradouro.trim(), campos.numero.trim()].filter(Boolean).join(', '),
    campos.complemento.trim() ? `Compl: ${campos.complemento.trim()}` : '',
    campos.bairro.trim() ? `Bairro: ${campos.bairro.trim()}` : '',
    cityUf ? `Cidade: ${cityUf}` : '',
    campos.referencia.trim() ? `Ref: ${campos.referencia.trim()}` : '',
  ].filter(Boolean).join(' - ');
}

const DELIVERY_ENDERECO_LABELS = ['Casa', 'Trabalho', 'Familiar', 'Outro'] as const;

type DeliveryNovoEnderecoForm = {
  label: string;
  campos: DeliveryEnderecoCampos;
  principal: boolean;
};

function emptyDeliveryNovoEnderecoForm(principalDefault: boolean): DeliveryNovoEnderecoForm {
  return { label: 'Casa', campos: emptyDeliveryEnderecoCampos(), principal: principalDefault };
}

function DeliveryIdentificacaoEnderecoChips({
  value,
  onChange,
  chipOn,
  chipOff,
}: {
  value: string;
  onChange: (label: string) => void;
  chipOn: string;
  chipOff: string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {DELIVERY_ENDERECO_LABELS.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => onChange(l)}
          className={`rounded-full border-2 px-4 py-2 text-sm font-bold transition-all ${value === l ? chipOn : chipOff}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

function DeliveryEnderecoCamposInputs({
  value,
  onChange,
  inpClass,
  temZonas,
  labelClassName,
  cepSurface = 'light',
}: {
  value: DeliveryEnderecoCampos;
  onChange: (next: DeliveryEnderecoCampos) => void;
  inpClass: string;
  temZonas: boolean;
  labelClassName: string;
  /** Tom das mensagens de loading/erro do CEP (checkout claro vs escuro). */
  cepSurface?: 'light' | 'dark';
}) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const patch = (partial: Partial<DeliveryEnderecoCampos>) => onChange({ ...value, ...partial });

  const cepDigits = onlyCepDigits(value.cep || '');
  const debouncedCep = useDebounce(cepDigits, 300);
  const [cepLookupLoading, setCepLookupLoading] = useState(false);
  const [cepLookupError, setCepLookupError] = useState('');
  const lastSuccessCepRef = useRef<string | null>(null);
  const viaCepGenRef = useRef(0);

  const cepStatusError =
    cepSurface === 'dark' ? 'text-sm font-medium text-red-300' : 'text-sm font-medium text-red-600';
  const cepStatusMuted =
    cepSurface === 'dark' ? 'text-sm font-medium text-zinc-400' : 'text-sm font-medium text-zinc-500';

  useEffect(() => {
    if (debouncedCep.length !== 8) {
      setCepLookupLoading(false);
      setCepLookupError('');
      lastSuccessCepRef.current = null;
      return;
    }

    if (debouncedCep === lastSuccessCepRef.current) {
      setCepLookupLoading(false);
      setCepLookupError('');
      return;
    }

    const gen = ++viaCepGenRef.current;
    setCepLookupLoading(true);
    setCepLookupError('');

    const ac = new AbortController();

    void (async () => {
      try {
        const res = await fetchViaCep(debouncedCep, ac.signal);
        if (viaCepGenRef.current !== gen) return;
        if (!res.ok) {
          setCepLookupError('CEP não encontrado');
          lastSuccessCepRef.current = null;
          return;
        }
        lastSuccessCepRef.current = debouncedCep;
        const v = valueRef.current;
        onChangeRef.current({
          ...v,
          cep: debouncedCep,
          logradouro: res.data.logradouro ? res.data.logradouro : v.logradouro,
          bairro: res.data.bairro ? res.data.bairro : v.bairro,
          cidade: res.data.localidade || v.cidade,
          uf: res.data.uf || v.uf,
        });
      } catch (e: unknown) {
        if (viaCepGenRef.current !== gen) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setCepLookupError('CEP não encontrado');
        lastSuccessCepRef.current = null;
      } finally {
        if (viaCepGenRef.current === gen) {
          setCepLookupLoading(false);
        }
      }
    })();

    return () => {
      ac.abort();
    };
  }, [debouncedCep]);

  return (
    <div className="space-y-2">
      <div>
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <label className={`block text-xs font-bold uppercase tracking-wider ${labelClassName}`}>CEP</label>
          {cepLookupLoading && (
            <span className={`inline-flex items-center gap-1.5 ${cepStatusMuted}`} aria-live="polite">
              <Loader2 size={14} className="animate-spin shrink-0" aria-hidden />
              Buscando endereço…
            </span>
          )}
        </div>
        <input
          inputMode="numeric"
          autoComplete="postal-code"
          value={formatCepInputDisplay(value.cep || '')}
          onChange={(e) => {
            const d = onlyCepDigits(e.target.value);
            patch({ cep: d });
            if (cepLookupError) setCepLookupError('');
          }}
          placeholder="00000-000"
          className={inpClass}
          maxLength={9}
        />
        {cepLookupError ? (
          <p className={`mt-1.5 ${cepStatusError}`} role="status">
            {cepLookupError}
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <label className={`mb-1.5 block text-xs font-bold uppercase tracking-wider ${labelClassName}`}>Rua / Avenida *</label>
          <input
            value={value.logradouro}
            onChange={(e) => patch({ logradouro: e.target.value })}
            placeholder="Rua das Flores"
            className={inpClass}
          />
        </div>
        <div>
          <label className={`mb-1.5 block text-xs font-bold uppercase tracking-wider ${labelClassName}`}>Número *</label>
          <input
            value={value.numero}
            onChange={(e) => patch({ numero: e.target.value })}
            placeholder="123"
            className={inpClass}
          />
        </div>
      </div>
      <div>
        <label className={`mb-1.5 block text-xs font-bold uppercase tracking-wider ${labelClassName}`}>Complemento</label>
        <input
          value={value.complemento}
          onChange={(e) => patch({ complemento: e.target.value })}
          placeholder="Apto, bloco..."
          className={inpClass}
        />
      </div>
      <div>
        <label className={`mb-1.5 block text-xs font-bold uppercase tracking-wider ${labelClassName}`}>
          Bairro *{temZonas ? ' (taxa de entrega)' : ''}
        </label>
        <input
          value={value.bairro}
          onChange={(e) => patch({ bairro: e.target.value })}
          placeholder={temZonas ? 'Informe o bairro para calcular a taxa' : 'Centro'}
          className={inpClass}
        />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <label className={`mb-1.5 block text-xs font-bold uppercase tracking-wider ${labelClassName}`}>Cidade</label>
          <input
            value={value.cidade}
            onChange={(e) => patch({ cidade: e.target.value })}
            placeholder="Preenchido pelo CEP"
            className={inpClass}
          />
        </div>
        <div>
          <label className={`mb-1.5 block text-xs font-bold uppercase tracking-wider ${labelClassName}`}>UF</label>
          <input
            value={value.uf}
            onChange={(e) => patch({ uf: e.target.value.toUpperCase().slice(0, 2) })}
            placeholder="SP"
            className={inpClass}
            maxLength={2}
          />
        </div>
      </div>
      <div>
        <label className={`mb-1.5 block text-xs font-bold uppercase tracking-wider ${labelClassName}`}>Referência</label>
        <input
          value={value.referencia}
          onChange={(e) => patch({ referencia: e.target.value })}
          placeholder="Próximo ao mercado..."
          className={inpClass}
        />
      </div>
    </div>
  );
}

interface ClienteAuth { id: number; nome: string; telefone: string; email?: string; favoritos: number[]; }
interface PedidoHistItem { product_id: number; quantity: number; price_at_time: number; variation_id?: number | null; }
interface PedidoHist { id: number; order_number: string; status: string; total_amount: number; created_at: string; resumo_itens: string; itens?: PedidoHistItem[]; }
type Tela = 'cardapio'|'cart'|'checkout'|'confirmado'|'conta'|'identificar'|'historico'|'enderecos'|'novo_endereco'|'editar_perfil';
/** Etapas do checkout em modal (shell — conteúdo será migrado por etapa). */
type CheckoutStep = 1 | 2 | 3;
type TipoAtendimento = 'entrega'|'retirada';
/** Modo de recebimento no checkout (API continua só delivery | retirada). */
type ModoRecebimentoPedido = 'entrega' | 'retirada' | 'consumo_local';

function modoToTipoAtendimento(m: ModoRecebimentoPedido): TipoAtendimento {
  return m === 'entrega' ? 'entrega' : 'retirada';
}

function observacaoComModoConsumo(m: ModoRecebimentoPedido, obs: string): string {
  if (m !== 'consumo_local') return obs;
  const t = obs.trim();
  return t ? `Consumo no local. ${t}` : 'Consumo no local.';
}

const MAX_CHECKOUT_NOME_RECEBE_LEN = 80;
const MAX_CHECKOUT_OBS_ENTREGA_LEN = 200;

/** Bloco operacional da entrega (vai para `observation` do pedido; mesma tag de contato que o backend já usava no merge). */
function buildDeliveryCheckoutObservationBlock(parts: {
  nomeQuemRecebe: string;
  contatoDigits: string | null;
  obsEntrega: string;
}): string {
  const lines: string[] = [];
  const nome = parts.nomeQuemRecebe.trim().slice(0, MAX_CHECKOUT_NOME_RECEBE_LEN);
  if (nome) lines.push(`Quem recebe: ${nome}`);
  if (parts.contatoDigits) lines.push(`[Contato no local] ${parts.contatoDigits}`);
  const ent = parts.obsEntrega.trim().slice(0, MAX_CHECKOUT_OBS_ENTREGA_LEN);
  if (ent) lines.push(`Entrega: ${ent}`);
  return lines.join('\n');
}

function mergeDeliveryObservationWithBase(block: string, base: string): string {
  const b = base.trim();
  const bl = block.trim();
  if (!bl) return b;
  if (!b) return bl;
  return `${bl}\n${b}`;
}

function labelModoRecebimento(m: ModoRecebimentoPedido): string {
  if (m === 'entrega') return 'Receber no endereço';
  if (m === 'retirada') return 'Retirar no estabelecimento';
  return 'Consumir no local';
}

type PagamentoCheckout = 'pix' | 'dinheiro' | 'cartao_credito' | 'cartao_debito';

function labelPagamentoCheckout(p: PagamentoCheckout): string {
  if (p === 'pix') return 'Pix';
  if (p === 'dinheiro') return 'Dinheiro';
  if (p === 'cartao_credito') return 'Cartão crédito';
  return 'Cartão débito';
}
type PedidoConfirmado = {
  orderNumber: string;
  waLink: string | null;
  total: number;
  orderId: number;
  pagamento_tipo: string;
  pagamento_status?: string | null;
  mapsUrl?: string;
  itens?: any[];
  config_pix?: Partial<Config>;
  payment_pix?: {
    id?: string | null;
    payment_id?: string | null;
    provider?: string | null;
    external_id?: string | null;
    external_reference?: string | null;
    status?: string | null;
    qr_code_text?: string | null;
    qr_code_base64?: string | null;
    qr_code_image_base64?: string | null;
    expires_at?: string | null;
  } | null;
  canal?: 'delivery'|'retirada';
  /** Pedido finalizado pelo checkout em modal: não exibir segunda tela de instruções Pix. */
  checkout_modal_concluido?: boolean;
};

/** Só libera o checkout sem sugestões se a API não responder (evita sacola travada). */
const SUGGESTIONS_CHECKOUT_FAILSAFE_MS = 10_000;

const fmt = (v: number) => `R$ ${(v||0).toFixed(2).replace('.',',').replace(/\B(?=(\d{3})+(?!\d))/g,'.')}`;

function getProdutoDescricao(produto: Produto) {
  return String(produto.description || produto.descricao || '').trim();
}

function hasVariacoesVendaveis(produto: Produto) {
  return !!(produto.variacoes_vendaveis && produto.variacoes_vendaveis.length > 0);
}

function produtoRequerModalDetalhes(produto: Produto): boolean {
  if (hasVariacoesVendaveis(produto)) return true;
  if (Number(produto.is_combo) === 1 && (produto.combo_grupos?.length ?? 0) > 0) return true;
  return !!(produto.grupos_opcao && produto.grupos_opcao.length > 0);
}

function isPromocaoProdutoValida(produto: Produto) {
  const precoOriginal = Number(produto.preco_original || 0);
  return !hasVariacoesVendaveis(produto)
    && !(Number(produto.is_combo) === 1 && (produto.combo_grupos?.length ?? 0) > 0)
    && Boolean(produto.em_promocao)
    && Number.isFinite(precoOriginal)
    && precoOriginal > Number(produto.price || 0);
}

function getPercentualDesconto(produto: Produto) {
  if (!isPromocaoProdutoValida(produto)) return 0;
  const precoOriginal = Number(produto.preco_original || 0);
  const precoAtual = Number(produto.price || 0);
  return Math.max(0, Math.round(((precoOriginal - precoAtual) / precoOriginal) * 100));
}

function isProdutoCombo(produto: Produto) {
  const base = `${produto.name} ${produto.category} ${getProdutoDescricao(produto)}`.toLowerCase();
  return /\bcombo?s?\b/.test(base);
}

type SuggestionIntent = 'drink' | 'dessert' | 'side' | 'sauce' | 'main' | 'other';

function normalizeSuggestionText(value: string) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function parseSuggestionVariacoes(item: SuggestionItem): VariacaoVendavel[] {
  if (Array.isArray(item.variacoes_vendaveis)) return item.variacoes_vendaveis;
  if (typeof item.variacoes_vendaveis === 'string') {
    try {
      const parsed = JSON.parse(item.variacoes_vendaveis || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function getSuggestionVariationCount(item: SuggestionItem) {
  return parseSuggestionVariacoes(item).length;
}

function getSuggestionDisplayPrice(item: SuggestionItem) {
  const prices = [
    Number(item.price || 0),
    ...parseSuggestionVariacoes(item).map((variacao) => Number(variacao.preco || 0)),
  ].filter((value) => Number.isFinite(value) && value > 0);

  return prices.length ? Math.min(...prices) : 0;
}

function getSuggestionIntent(item: Pick<SuggestionItem, 'name' | 'category'>): SuggestionIntent {
  const base = normalizeSuggestionText(`${item.name || ''} ${item.category || ''}`);

  if (/(bebida|suco|refrigerante|refri|agua|cerveja|drink|milkshake|vitamina|cha|cafe|soda)/.test(base)) {
    return 'drink';
  }
  if (/(sobremesa|doce|brownie|cookie|sorvete|mousse|pudim|acai|torta|brigadeiro)/.test(base)) {
    return 'dessert';
  }
  if (/(molho|maionese|barbecue|ketchup|mostarda|vinagrete)/.test(base)) {
    return 'sauce';
  }
  if (/(batata|frita|porcao|acompanhamento|onion|nugget|salada|entrada|anel de cebola)/.test(base)) {
    return 'side';
  }
  if (/(lanche|burger|hamburg|pizza|esfiha|prato|combo|sanduiche|hot dog|pastel|tapioca)/.test(base)) {
    return 'main';
  }
  return 'other';
}

function getSuggestionSourceCartItem(cart: CartItem[], item: SuggestionItem): CartItem | null {
  const sourceId = Number(item.source_product_id);
  if (Number.isInteger(sourceId) && sourceId > 0) {
    return cart.find((cartItem) => Number(cartItem.id) === sourceId) || null;
  }
  return cart[0] || null;
}

function shortenSuggestionSourceName(name: string, maxChars = 28) {
  const compact = String(name || '').trim().split(/\s+/).slice(0, 4).join(' ');
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 3).trim()}...`;
}

function getSuggestionBadgeText(item: SuggestionItem, sourceItem: CartItem | null, featured: boolean) {
  const totalEventos = Number(item.total_eventos || 0);
  const intent = getSuggestionIntent(item);

  if (featured && totalEventos > 0) return 'Mais pedido';
  if (featured) return 'Sugestao';
  if (sourceItem && intent === 'drink') return 'Combina';
  if (sourceItem && intent === 'dessert') return 'Leve junto';
  if (sourceItem && (intent === 'side' || intent === 'sauce')) return 'Acompanha';
  if (intent === 'drink') return 'Combina';
  if (intent === 'dessert') return 'Leve junto';
  if (intent === 'side' || intent === 'sauce') return 'Sugestao';
  return 'Leve junto';
}

function getSuggestionHeadline(item: SuggestionItem, sourceItem: CartItem | null) {
  const intent = getSuggestionIntent(item);
  const sourceName = sourceItem ? shortenSuggestionSourceName(sourceItem.name) : '';

  if (sourceName) {
    if (intent === 'drink') return `Para acompanhar ${sourceName}`;
    if (intent === 'dessert') return `Leve junto com ${sourceName}`;
    if (intent === 'side' || intent === 'sauce') return `Para acompanhar ${sourceName}`;
    return `Vai bem com ${sourceName}`;
  }

  if (intent === 'drink') return 'Uma bebida para acompanhar seu pedido';
  if (intent === 'dessert') return 'Um extra gostoso para levar junto';
  if (intent === 'side' || intent === 'sauce') return 'Um complemento que combina com a sacola';
  if (intent === 'main') return 'Mais uma escolha para completar o pedido';
  return 'Uma sugestao que combina com seu pedido';
}

function getSuggestionSupportText(item: SuggestionItem) {
  const intent = getSuggestionIntent(item);
  const variationCount = getSuggestionVariationCount(item);

  if (variationCount > 0) {
    return variationCount === 1
      ? 'Escolha sem sair da sacola.'
      : `${variationCount} opcoes para escolher rapido.`;
  }

  if (intent === 'drink') return 'Combina e valoriza o pedido.';
  if (intent === 'dessert') return 'Leve um extra sem pesar no pedido.';
  if (intent === 'side' || intent === 'sauce') return 'Complemento simples com boa percepcao de valor.';
  return 'Adicione junto e finalize no mesmo fluxo.';
}

function getSuggestionCtaText(item: SuggestionItem, featured: boolean) {
  return featured ? 'Adicionar' : 'Levar';
}

function getSuggestionPricePrefix(item: SuggestionItem) {
  return getSuggestionVariationCount(item) > 0 ? 'Leve por' : 'So mais';
}

function scoreSuggestionForUpsell(item: SuggestionItem, index: number, cart: CartItem[]) {
  const sourceItem = getSuggestionSourceCartItem(cart, item);
  const intent = getSuggestionIntent(item);
  const variationCount = getSuggestionVariationCount(item);

  let score = Math.max(0, 18 - (index * 4));
  score += Number(item.prioridade || 0) * 12;
  score += Math.min(18, Number(item.total_eventos || 0) * 2);
  score += Number(item.source_product_id || 0) > 0 ? 18 : 0;
  score += normalizeProductPhotoPublicUrl(item.photo_url) ? 3 : 0;
  score += variationCount === 0 ? 2 : 1;

  if (sourceItem) {
    if (intent === 'drink' || intent === 'dessert' || intent === 'side') score += 8;
    if (intent === 'sauce') score += 5;
    if (isProdutoCombo(sourceItem) && intent === 'drink') score += 4;
  }

  return score;
}

/** Status amigável para “Meus pedidos” (acompanhamento do cliente) */
function labelStatusPedidoCliente(status: string): string {
  const raw = String(status || '').trim();
  const k = raw.toLowerCase();
  if (k.includes('cancel')) return 'Cancelado';
  if (k === 'em preparo') return 'Em preparo';
  if (k === 'pronto' || k === 'pronto para entrega') return 'Pronto';
  if (k === 'saiu para entrega') return 'Saiu para entrega';
  if (k === 'entregue' || k === 'concluído' || k === 'concluido') return 'Entregue';
  if (k === 'criado' || k === 'pedido recebido') return 'Recebido';
  if (k.includes('aguardando')) return 'Recebido';
  return raw || '—';
}

/** Pedido ainda em andamento para o cliente (não cancelado / não entregue / não concluído). */
function isPedidoAndamentoClienteStatus(status: string): boolean {
  const k = String(status || '').trim().toLowerCase();
  if (!k || k.includes('cancel')) return false;
  if (k === 'entregue' || k.startsWith('conclu')) return false;
  return true;
}

const MEUS_PEDIDOS_POLL_MS = 10000;
const CARDAPIO_STATUS_POLL_FALLBACK_MS = 60000;
const CARDAPIO_STATUS_POLL_MIN_MS = 15000;
const CARDAPIO_STATUS_POLL_MAX_MS = 10 * 60000;

function badgeClassStatusPedido(status: string, mode: DeliveryCardapioThemeMode = 'dark_premium'): string {
  const k = String(status || '').toLowerCase();
  if (mode === 'light_red') {
    if (k.includes('cancel')) return 'border border-red-200 bg-red-50 text-red-800';
    if (k.includes('entregue') || k.includes('conclu')) return 'border border-sky-200 bg-sky-50 text-sky-800';
    if (k.includes('saiu')) return 'border border-orange-200 bg-orange-50 text-orange-900';
    if (k.includes('pronto')) return 'border border-violet-200 bg-violet-50 text-violet-900';
    if (k.includes('preparo')) return 'border border-amber-200 bg-amber-50 text-amber-900';
    return 'border border-zinc-200 bg-zinc-100 text-zinc-700';
  }
  if (k.includes('cancel')) return 'border border-red-500/30 bg-red-500/15 text-red-200';
  if (k.includes('entregue') || k.includes('conclu')) return 'border border-sky-500/30 bg-sky-500/15 text-sky-200';
  if (k.includes('saiu')) return 'border border-orange-500/30 bg-orange-500/15 text-orange-200';
  if (k.includes('pronto')) return 'border border-violet-500/30 bg-violet-500/15 text-violet-200';
  if (k.includes('preparo')) return 'border border-amber-500/30 bg-amber-500/15 text-amber-200';
  return 'border border-white/10 bg-white/5 text-zinc-300';
}

const STATUS_COR: Record<string,string> = {
  'Criado':'border border-cyan-500/30 bg-cyan-500/15 text-cyan-200',
  'Pedido Recebido':'border border-cyan-500/30 bg-cyan-500/15 text-cyan-200',
  'Em Preparo':'border border-amber-500/30 bg-amber-500/15 text-amber-200',
  'Pronto':'border border-violet-500/30 bg-violet-500/15 text-violet-200',
  'Pronto para Entrega':'border border-violet-500/30 bg-violet-500/15 text-violet-200',
  'Saiu para Entrega':'border border-orange-500/30 bg-orange-500/15 text-orange-200',
  'Entregue':'border border-sky-500/30 bg-sky-500/15 text-sky-200',
  'Concluído':'border border-sky-500/30 bg-sky-500/15 text-sky-200',
  'Cancelado':'border border-red-500/30 bg-red-500/15 text-red-200',
};
const STATUS_COR_LIGHT: Record<string,string> = {
  'Criado':'border border-red-200 bg-red-50 text-red-800',
  'Pedido Recebido':'border border-red-200 bg-red-50 text-red-800',
  'Em Preparo':'border border-amber-200 bg-amber-50 text-amber-900',
  'Pronto':'border border-violet-200 bg-violet-50 text-violet-900',
  'Pronto para Entrega':'border border-violet-200 bg-violet-50 text-violet-900',
  'Saiu para Entrega':'border border-orange-200 bg-orange-50 text-orange-900',
  'Entregue':'border border-sky-200 bg-sky-50 text-sky-800',
  'Concluído':'border border-sky-200 bg-sky-50 text-sky-800',
  'Cancelado':'border border-red-200 bg-red-50 text-red-800',
};
const STATUS_TXT: Record<string,string> = { 'Criado':'Recebido','Pedido Recebido':'Recebido','Em Preparo':'Em preparo','Pronto':'Pronto','Pronto para Entrega':'Pronto','Saiu para Entrega':'A caminho','Entregue':'Entregue','Concluído':'Concluído','Cancelado':'Cancelado' };

function describeFirstCustomerDiscountConfig(config: Config) {
  const tipo = config.desconto_primeiro_cliente_tipo || 'percentual';
  const valor = Number(config.desconto_primeiro_cliente_valor || 0);

  if (tipo === 'frete_gratis') return 'Frete gratis na primeira compra';
  if (tipo === 'fixo') return `${fmt(valor)} na primeira compra`;
  return `${valor}% na primeira compra`;
}

function createFallbackCheckoutResumo(params: {
  config: Config;
  subtotal: number;
  pagamentoTipo: string;
  taxaEntrega: number;
  zonaEntrega?: { nome: string; taxa: number } | null;
  bairroEntrega?: string | null;
  cupomAplicado?: CupomAplicadoResumo;
  descontoCupom?: number;
  mensagemPrimeiroCliente?: string;
  entregaBloqueadaPorZona?: boolean;
  mensagemEntregaBloqueada?: string;
}): CheckoutResumo {
  const descontoPix = params.pagamentoTipo === 'pix'
    ? params.subtotal * ((Number(params.config.desconto_pix || 0)) / 100)
    : 0;
  const subtotalAposPix = Math.max(0, params.subtotal - descontoPix);
  const descontoCupom = Number(params.descontoCupom || 0);

  return {
    modelo_entrega: 'bairro_fixo' as const,
    bairro_entrega: params.bairroEntrega?.trim() || null,
    subtotal: params.subtotal,
    desconto_pix: descontoPix,
    subtotal_apos_desconto_pix: subtotalAposPix,
    taxa_entrega: Number(params.taxaEntrega || 0),
    zona_entrega: params.zonaEntrega || null,
    entrega_bloqueada_por_zona: Boolean(params.entregaBloqueadaPorZona),
    mensagem_entrega_bloqueada: params.entregaBloqueadaPorZona
      ? (params.mensagemEntregaBloqueada || MENSAGEM_ENTREGA_FORA_DA_AREA)
      : undefined,
    desconto_cupom: descontoCupom,
    cupom_aplicado: params.cupomAplicado || null,
    desconto_primeiro_cliente: 0,
    primeiro_cliente: {
      ativo: Boolean(params.config.desconto_primeiro_cliente_ativo),
      elegivel: false,
      aplicado: false,
      tipo: params.config.desconto_primeiro_cliente_tipo || 'percentual',
      valor_configurado: Number(params.config.desconto_primeiro_cliente_valor || 0),
      min_pedido: Number(params.config.desconto_primeiro_cliente_min_pedido || 0),
      descricao: params.config.desconto_primeiro_cliente_ativo
        ? describeFirstCustomerDiscountConfig(params.config)
        : '',
      motivo: 'aguardando_resumo',
      mensagem: params.mensagemPrimeiroCliente || (
        params.config.desconto_primeiro_cliente_ativo
          ? 'Validando o desconto de primeira compra no servidor...'
          : 'Desconto de primeira compra desativado.'
      ),
    },
    total: Math.max(0, subtotalAposPix + Number(params.taxaEntrega || 0) - descontoCupom),
  };
}

function ResumoComercialLinhas({
  resumo,
  descontoPixPercentual,
  zonaFallback,
  bairroFallback,
  mensagemAuxiliar,
  totalLabel = 'Total final',
  tipoAtendimento,
  temZonasEntrega,
}: {
  resumo: CheckoutResumo;
  descontoPixPercentual?: number;
  zonaFallback?: { nome: string; taxa: number } | null;
  bairroFallback?: string | null;
  mensagemAuxiliar?: string | null;
  totalLabel?: string;
  tipoAtendimento?: TipoAtendimento | null;
  /** Quando true, taxa 0 sem zona nem bairro indica “aguardando bairro”, não “grátis”. */
  temZonasEntrega?: boolean;
}) {
  const rl = useDeliveryCardapioTheme().resumoLinhas;
  const taxaEntrega = Number(resumo.taxa_entrega || 0);
  const zonaResumo = resumo.zona_entrega || zonaFallback || null;
  const bairroResumo = String(resumo.bairro_entrega || bairroFallback || '').trim();
  const primeiroCliente = resumo.primeiro_cliente;
  const primeiroClienteMensagem = String(primeiroCliente?.mensagem || '').trim();
  const showPrimeiroClienteStatus = Boolean(
    resumo.desconto_primeiro_cliente > 0 ||
    primeiroCliente?.ativo ||
    primeiroClienteMensagem
  );
  const primeiroClienteStatusLabel = resumo.desconto_primeiro_cliente > 0
    ? `-${fmt(resumo.desconto_primeiro_cliente)}`
    : primeiroCliente?.motivo === 'aguardando_resumo'
      ? 'Validando'
      : primeiroCliente?.motivo === 'cliente_nao_identificado'
        ? 'Identifique-se'
        : primeiroCliente?.motivo === 'existing_customer_history' ||
            primeiroCliente?.motivo === 'same_phone_previous_order' ||
            primeiroCliente?.motivo === 'same_address_previous_order'
          ? 'Nao elegivel'
          : 'Nao aplicado';

  return (
    <>
      <div className={rl.line}>
        <span>Subtotal</span>
        <span className={rl.lineStrong}>{fmt(resumo.subtotal)}</span>
      </div>
      {tipoAtendimento == null ? (
        <div className={rl.line}>
          <span className="font-semibold">Entrega ou retirada</span>
          <span className={`font-bold ${rl.lineStrong}`}>Escolher no checkout</span>
        </div>
      ) : tipoAtendimento === 'retirada' ? (
        <div className={rl.accent}>
          <span className="font-semibold">Atendimento</span>
          <span className={rl.accentBold}>Retirar no local</span>
        </div>
      ) : resumo.entrega_bloqueada_por_zona ? (
        <div className={`${rl.line} flex-col items-stretch gap-1`}>
          <span className="text-sm font-semibold leading-snug text-amber-800 dark:text-amber-200">
            {resumo.mensagem_entrega_bloqueada || MENSAGEM_ENTREGA_FORA_DA_AREA}
          </span>
        </div>
      ) : taxaEntrega > 0 ? (
        <div className={rl.line}>
          <span>Taxa de entrega{zonaResumo ? ` · ${zonaResumo.nome}` : bairroResumo ? ` · ${bairroResumo}` : ''}</span>
          <span className={rl.lineStrong}>{fmt(taxaEntrega)}</span>
        </div>
      ) : temZonasEntrega && !zonaResumo && !bairroResumo ? (
        <div className={rl.line}>
          <span>Taxa de entrega</span>
          <span className={`text-xs font-bold ${rl.lineStrong}`}>Após informar o bairro</span>
        </div>
      ) : (
        <div className={rl.accent}>
          <span className="font-semibold">Taxa de entrega</span>
          <span className={rl.accentBold}>Gratis</span>
        </div>
      )}
      {resumo.desconto_pix > 0 && (
        <div className={rl.accent}>
          <span className="font-semibold">Desconto Pix{descontoPixPercentual ? ` (${descontoPixPercentual}%)` : ''}</span>
          <span className={rl.accentBold}>-{fmt(resumo.desconto_pix)}</span>
        </div>
      )}
      {showPrimeiroClienteStatus && (
        <div className={`flex justify-between text-sm ${resumo.desconto_primeiro_cliente > 0 ? rl.amber : rl.line}`}>
          <span className="font-semibold">{resumo.desconto_primeiro_cliente > 0 ? 'Desconto primeira compra' : 'Primeira compra'}</span>
          <span className="font-bold">{primeiroClienteStatusLabel}</span>
        </div>
      )}
      {showPrimeiroClienteStatus && primeiroClienteMensagem && (
        <div className={`text-[11px] ${resumo.desconto_primeiro_cliente > 0 ? rl.amberMuted : rl.line}`}>
          {primeiroClienteMensagem}
        </div>
      )}
      {resumo.cupom_aplicado && resumo.desconto_cupom > 0 && (
        <div className={rl.accent}>
          <span className="font-semibold">Cupom ({resumo.cupom_aplicado.codigo})</span>
          <span className={rl.accentBold}>-{fmt(resumo.desconto_cupom)}</span>
        </div>
      )}
      {mensagemAuxiliar && (
        <div className={rl.aux}>
          {mensagemAuxiliar}
        </div>
      )}
      <div className={rl.totalRow}>
        <span className={rl.totalLabel}>{totalLabel}</span>
        <span className={rl.totalValue}>{fmt(Math.max(0, resumo.total))}</span>
      </div>
    </>
  );
}

function LojaInfoLinha({
  icon,
  label,
  value,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  href?: string | null;
}) {
  const li = useDeliveryCardapioTheme().lojaInfo;
  const content = (
    <div className={li.card}>
      <div className={li.iconWrap}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className={li.label}>{label}</p>
        <p className={li.value}>{value}</p>
      </div>
    </div>
  );

  if (!href) return content;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="block transition-opacity hover:opacity-90">
      {content}
    </a>
  );
}

// Calcula o preço mínimo possível de um produto com opções
function calcPrecoMinimo(produto: Produto): number {
  if (Number(produto.is_combo) === 1 && (produto.combo_grupos?.length ?? 0) > 0) {
    return Number(produto.price || 0);
  }
  const grupos = produto.grupos_opcao || [];
  let precoBase = produto.price;
  let extraAdicional = 0;
  let maxFinal = 0;
  let temFinal = false;

  for (const g of grupos) {
    if (!g.obrigatorio || !g.itens.length) continue;
    if (g.modo_preco === 'final' && g.tipo === 'radio') {
      temFinal = true;
      const minFinal = Math.min(...g.itens.map(it => it.preco_adicional));
      maxFinal = Math.max(maxFinal, minFinal);
    } else if (g.tipo === 'radio') {
      extraAdicional += Math.min(...g.itens.map(it => it.preco_adicional));
    }
  }
  return temFinal ? maxFinal : precoBase + extraAdicional;
}

function getSlug() {
  const m = window.location.pathname.match(/^\/delivery\/([^/]+)/);
  if (m) return m[1];
  const sp = new URLSearchParams(window.location.search);
  return sp.get('delivery_slug') || sp.get('_delivery_slug') || '';
}

function isDeliveryAssistidoEnabled(slug: string): boolean {
  if (!slug) return false;
  const key = `dc_assistido_${slug}`;
  const sp = new URLSearchParams(window.location.search);
  const raw = String(
    sp.get('assistido') ??
      sp.get('assist') ??
      sp.get('atendimento_assistido') ??
      ''
  )
    .trim()
    .toLowerCase();
  const truthy = raw === '1' || raw === 'true' || raw === 'sim' || raw === 'yes' || raw === 'on';
  const falsy = raw === '0' || raw === 'false' || raw === 'nao' || raw === 'não' || raw === 'off';
  if (truthy) {
    try {
      sessionStorage.setItem(key, '1');
    } catch {
      /* ignore */
    }
    return true;
  }
  if (falsy) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    return false;
  }
  try {
    return sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function useClienteAuth(slug: string) {
  const KEY = `dc_token_${slug}`;
  const [token, setToken] = useState<string|null>(() => localStorage.getItem(KEY));
  const [cliente, setCliente] = useState<ClienteAuth|null>(null);
  const [carregando, setCarregando] = useState(true);
  const salvar = useCallback((t: string, c: ClienteAuth) => { localStorage.setItem(KEY, t); setToken(t); setCliente(c); }, [KEY]);
  const logout = useCallback(() => { localStorage.removeItem(KEY); setToken(null); setCliente(null); }, [KEY]);
  const atualizarFavoritos = useCallback((favs: number[]) => { setCliente(c => c ? { ...c, favoritos: favs } : c); }, []);
  useEffect(() => {
    if (!token || !slug) { setCarregando(false); return; }
    fetch(`/public/delivery/${slug}/cliente/perfil`, { headers: { Authorization:`Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setCliente({ id:d.id, nome:d.nome, telefone:d.telefone, email:d.email, favoritos: Array.isArray(d.favoritos)?d.favoritos:[] }); else logout(); })
      .catch(() => logout()).finally(() => setCarregando(false));
  }, [token, slug]);
  return { token, cliente, carregando, salvar, logout, atualizarFavoritos };
}

export default function DeliveryCardapio() {
  const slug = getSlug();
  const assistido = useMemo(() => isDeliveryAssistidoEnabled(slug), [slug]);
  const { token: cliToken, cliente, salvar: salvarToken, logout, atualizarFavoritos } = useClienteAuth(slug);
  const [nome, setNome] = useState('');
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [config, setConfig] = useState<Config>({ taxa_entrega:0, pedido_minimo:0, tempo_preparo:40 });
  const [ativo, setAtivo] = useState(true);
  const [diaFolgaHoje, setDiaFolgaHoje] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [tela, setTela] = useState<Tela>('cardapio');
  const [posIdentificacao, setPosIdentificacao] = useState<Tela>('cardapio');
  /** Após identificar com telefone, abrir aba Meus pedidos (sem usar `posIdentificacao`, que é tela cheia). */
  const [identificacaoAbaDestino, setIdentificacaoAbaDestino] = useState<null | 'meus_pedidos'>(null);
  const [tipoAtendimento, setTipoAtendimento] = useState<TipoAtendimento | null>(null);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 250);
  const [catAtiva, setCatAtiva] = useState('');
  const [pedidoOk, setPedidoOk] = useState<PedidoConfirmado|null>(null);
  const [pedidoSucessoOpen, setPedidoSucessoOpen] = useState(false);
  const [acompanharBannerOpen, setAcompanharBannerOpen] = useState(false);
  const [abaCardapio, setAbaCardapio] = useState<'todos'|'favoritos'|'promocoes'|'meus_pedidos'>('todos');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [lojaInfoAberta, setLojaInfoAberta] = useState(false);
  const [buscaAberta, setBuscaAberta] = useState(false);
  const [menuCatalogoAberto, setMenuCatalogoAberto] = useState(false);
  const [sacolaOpen, setSacolaOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutStep, setCheckoutStep] = useState<CheckoutStep>(1);
  const [mpList, setMpList] = useState<Array<{ id: number; status: string; total: number; created_at: string; order_number?: string }>>([]);
  const [mpLoading, setMpLoading] = useState(false);
  const [mpErr, setMpErr] = useState('');
  const [mpDetalhe, setMpDetalhe] = useState<{
    id: number; status: string; total: number; created_at: string; order_number?: string;
    itens: Array<{ product_id: number; name: string; quantity: number; price_at_time: number }>;
  } | null>(null);
  const [produtoModal, setProdutoModal] = useState<Produto|null>(null); // opções e/ou variações (modal único)
  const catRefs = useRef<Record<string, HTMLDivElement|null>>({});
  const suggestionsCacheRef = useRef<Map<string, SuggestionItem[]>>(new Map());
  const suggestionsReqRef = useRef(0);
  const [prefetchedSuggestions, setPrefetchedSuggestions] = useState<SuggestionItem[]>([]);
  const [suggestionsReadySignature, setSuggestionsReadySignature] = useState('');
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [heroBrokenKeys, setHeroBrokenKeys] = useState<Record<string, true>>({});

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    let cancelled = false;
    fetch(`/public/delivery/${slug}/cardapio`)
      .then(async (r) => {
        if (!r.ok) throw new Error('cardapio');
        return r.json() as Promise<{
          estabelecimento?: string;
          ativo?: boolean;
          dia_folga_hoje?: boolean;
          logo_url?: string | null;
          categorias?: Categoria[];
          config?: Config;
        }>;
      })
      .then((d) => {
        if (cancelled) return;
        setNome(d.estabelecimento || '');
        setAtivo(d.ativo !== false);
        setDiaFolgaHoje(d.dia_folga_hoje === true);
        setLogoUrl(d.logo_url || null);
        setCategorias(Array.isArray(d.categorias) ? d.categorias : []);
        setConfig((prev) => ({
          ...prev,
          ...(d.config && typeof d.config === 'object' ? d.config : {}),
        }));
        if (d.categorias?.length) setCatAtiva(d.categorias[0].nome);
      })
      .catch(() => {
        if (!cancelled) {
          setCategorias([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Revalida aberto/fechado automaticamente (múltiplas janelas por dia).
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    let timer: number | null = null;

    const scheduleNext = (nextMinutes: unknown) => {
      const n = typeof nextMinutes === 'number' && Number.isFinite(nextMinutes) ? Math.max(0, nextMinutes) : null;
      const ms = n == null
        ? CARDAPIO_STATUS_POLL_FALLBACK_MS
        : Math.min(CARDAPIO_STATUS_POLL_MAX_MS, Math.max(CARDAPIO_STATUS_POLL_MIN_MS, Math.round(n * 60000) + 1500));
      timer = window.setTimeout(() => { void poll(); }, ms);
    };

    const poll = async () => {
      try {
        const r = await fetch(`/public/delivery/${slug}/status`);
        const d = await r.json().catch(() => ({}));
        if (cancelled) return;

        if (typeof (d as any)?.aberto === 'boolean') {
          setAtivo(Boolean((d as any).aberto));
        }
        setDiaFolgaHoje((d as any)?.dia_folga_hoje === true);
        setConfig((prev) => ({
          ...prev,
          proxima_abertura: (d as any)?.proxima_abertura ?? prev.proxima_abertura,
          proximo_fechamento: (d as any)?.proximo_fechamento ?? prev.proximo_fechamento,
        }));

        scheduleNext((d as any)?.proximo_evento_em_minutos);
      } catch {
        if (!cancelled) scheduleNext(null);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [slug]);

  const subtotal = useMemo(() => cart.reduce((a,i)=>a+i.preco_final*i.qty,0), [cart]);
  const suggestionProductSignature = useMemo(() => buildSuggestionProductSignature(cart), [cart]);
  const shouldShowSuggestions = cart.length > 0;
  const suggestionsReadyForCurrentCart = !!suggestionProductSignature && suggestionsReadySignature === suggestionProductSignature;
  const suggestionsPendingForCurrentCart = shouldShowSuggestions && !!suggestionProductSignature && !suggestionsReadyForCurrentCart;
  const totalItens = cart.reduce((a,i)=>a+i.qty,0);
  const produtosOrdenados = useMemo(
    () => categorias.flatMap((cat, categoryIndex) =>
      cat.itens.map((produto, itemIndex) => ({
        produto,
        ordem: categoryIndex * 1000 + itemIndex,
      }))
    ),
    [categorias]
  );
  const produtoCatalogoPorId = useMemo(() => {
    const m = new Map<number, ProductOptionsProduto>();
    for (const c of categorias) {
      for (const p of c.itens) {
        m.set(p.id, p as ProductOptionsProduto);
      }
    }
    return m;
  }, [categorias]);
  const resolveComboComponenteDelivery = useCallback(
    (productId: number) => produtoCatalogoPorId.get(productId) ?? null,
    [produtoCatalogoPorId]
  );
  const totalPromocoesValidas = useMemo(
    () => categorias.flatMap(cat => cat.itens).filter(isPromocaoProdutoValida).length,
    [categorias]
  );
  useEffect(() => {
    const requestId = ++suggestionsReqRef.current;

    if (!slug) {
      suggestionsCacheRef.current.clear();
      setPrefetchedSuggestions([]);
      setSuggestionsReadySignature('');
      setLoadingSuggestions(false);
      return;
    }

    if (!suggestionProductSignature) {
      setPrefetchedSuggestions([]);
      setSuggestionsReadySignature('');
      setLoadingSuggestions(false);
      return;
    }

    const cacheKey = `${slug}:${suggestionProductSignature}`;
    if (suggestionsCacheRef.current.has(cacheKey)) {
      setPrefetchedSuggestions(suggestionsCacheRef.current.get(cacheKey) || []);
      setSuggestionsReadySignature(suggestionProductSignature);
      setLoadingSuggestions(false);
      return;
    }

    const productIds = suggestionProductSignature
      .split(',')
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);

    if (!productIds.length) {
      setPrefetchedSuggestions([]);
      setSuggestionsReadySignature('');
      setLoadingSuggestions(false);
      return;
    }

    const controller = new AbortController();
    setPrefetchedSuggestions([]);
    setSuggestionsReadySignature('');
    setLoadingSuggestions(true);

    fetch(`/public/delivery/${slug}/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productIds }),
      signal: controller.signal,
    })
      .then(r => (r.ok ? r.json() : []))
      .then((d) => {
        if (requestId !== suggestionsReqRef.current) return;
        const nextSuggestions = Array.isArray(d) ? d.slice(0, 3) as SuggestionItem[] : [];
        suggestionsCacheRef.current.set(cacheKey, nextSuggestions);
        setPrefetchedSuggestions(nextSuggestions);
        setSuggestionsReadySignature(suggestionProductSignature);
      })
      .catch((error) => {
        if (requestId !== suggestionsReqRef.current) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setPrefetchedSuggestions([]);
        setSuggestionsReadySignature(suggestionProductSignature);
      })
      .finally(() => {
        if (requestId === suggestionsReqRef.current) {
          setLoadingSuggestions(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [slug, suggestionProductSignature]);
  const produtosDestaque = useMemo(() => {
    const vistos = new Set<number>();
    return produtosOrdenados
      .filter(({ produto }) => {
        if (vistos.has(produto.id)) return false;
        vistos.add(produto.id);
        return true;
      })
      .sort((a, b) => {
        const score = (produto: Produto) => {
          let total = 0;
          if (normalizeProductPhotoPublicUrl(produto.photo_url)) total += 4;
          if (Number(produto.destaque || 0) > 0) total += 5 + Number(produto.destaque || 0);
          if (isPromocaoProdutoValida(produto)) total += 4;
          if (isProdutoCombo(produto)) total += 1;
          return total;
        };
        const diff = score(b.produto) - score(a.produto);
        if (diff !== 0) return diff;
        return a.ordem - b.ordem;
      })
      .map(({ produto }) => produto)
      .slice(0, 8);
  }, [produtosOrdenados]);
  const deliveryVisualFromConfig = useMemo((): DeliveryVisualConfig => {
    const coverSlots = [...normalizeCardapioOnlineBannerSlots(
      config.cardapio_online_banner_urls ?? config.cardapio_banner_slots
    )];
    return {
      logoUrl: '',
      coverImages: [],
      coverSlots,
      backgroundImage: '',
      backgroundOpacity: 0.1,
    };
  }, [config.cardapio_online_banner_urls, config.cardapio_banner_slots]);
  const logoResolvido = useMemo(
    () => resolveDeliveryLogoUrl(deliveryVisualFromConfig, logoUrl),
    [deliveryVisualFromConfig, logoUrl]
  );
  const fundoDecorativo = useMemo(
    () => resolveDeliveryBackgroundDecor(deliveryVisualFromConfig),
    [deliveryVisualFromConfig]
  );

  const galeriaTopo = useMemo(
    () => resolveDeliveryHeroGallery(deliveryVisualFromConfig, produtosDestaque, logoResolvido, nome),
    [deliveryVisualFromConfig, produtosDestaque, logoResolvido, nome]
  );
  useEffect(() => {
    setHeroBrokenKeys({});
  }, [galeriaTopo]);
  const resumoVitrine = useMemo(() => createFallbackCheckoutResumo({
    config,
    subtotal,
    pagamentoTipo: 'pix',
    taxaEntrega: Number(config.taxa_entrega || 0),
    mensagemPrimeiroCliente: 'Confira a taxa e os beneficios finais ao abrir sua sacola.',
  }), [config, subtotal]);
  const horarioLoja = useMemo(() => {
    const proximoFecha = config.proximo_fechamento || config.horario_fechamento;
    const proximoAbre = config.proxima_abertura || config.horario_abertura;
    if (ativo) {
      return proximoFecha ? `Aberto até às ${proximoFecha}` : 'Loja aberta agora';
    }
    if (diaFolgaHoje) return 'Fechado hoje (folga semanal)';
    return proximoAbre ? `Fechado agora · abre às ${proximoAbre}` : 'Loja fechada no momento';
  }, [ativo, diaFolgaHoje, config.proxima_abertura, config.proximo_fechamento, config.horario_abertura, config.horario_fechamento]);
  const cardapioTheme = useMemo(
    () => buildDeliveryCardapioTheme(normalizeDeliveryCardapioThemeMode(config.theme_mode)),
    [config.theme_mode]
  );
  const isLightRed = cardapioTheme.mode === 'light_red';
  const resumoLocalizacao = useMemo(() => {
    const zonas = (config.zonas_entrega || []).filter((zona) => String(zona?.nome || '').trim());
    if (zonas.length > 0) {
      const destaques = zonas.slice(0, 2).map((zona) => zona.nome.trim());
      return `Entrega em ${destaques.join(' e ')}${zonas.length > 2 ? ` +${zonas.length - 2} bairros` : ''}`;
    }
    return Number(config.taxa_entrega || 0) > 0 ? 'Entrega disponivel na regiao da loja' : 'Retirada no local';
  }, [config.zonas_entrega, config.taxa_entrega]);
  const entregaResumo = useMemo(() => {
    const zonasGratis = (config.zonas_entrega || []).filter((zona) => Number(zona?.taxa || 0) <= 0);
    if (zonasGratis.length > 0) return `Entrega gratis em ${zonasGratis[0].nome}${zonasGratis.length > 1 ? ' e outros bairros' : ''}`;
    if (Number(config.taxa_entrega || 0) <= 0) return 'Entrega gratis';
    return `Taxa a partir de ${fmt(Number(config.taxa_entrega || 0))}`;
  }, [config.taxa_entrega, config.zonas_entrega]);
  const rotuloMenuCatalogo = useMemo(() => {
    if (abaCardapio === 'favoritos') return cliente ? `Favoritos (${cliente.favoritos.length})` : 'Favoritos';
    if (abaCardapio === 'promocoes') return 'Promocoes';
    if (abaCardapio === 'meus_pedidos') return 'Meus pedidos';
    if (catAtiva) return catAtiva;
    return 'Explorar cardapio';
  }, [abaCardapio, catAtiva, cliente]);
  const whatsappHref = useMemo(() => {
    const digits = String(config.whatsapp || '').replace(/\D/g, '');
    return digits ? `https://wa.me/${digits}` : null;
  }, [config.whatsapp]);

  const buscarMeusPedidos = useCallback(async (opts?: { keepDetail?: boolean; silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!cliToken) {
      if (!silent) {
        setMpList([]);
        setMpErr('');
      }
      return;
    }
    if (!silent) {
      setMpErr('');
      setMpLoading(true);
    }
    if (!opts?.keepDetail) setMpDetalhe(null);
    try {
      const r = await fetch(`/public/delivery/${slug}/cliente/pedidos`, { headers: { Authorization: `Bearer ${cliToken}` } });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Nao foi possivel carregar');
      const list = Array.isArray(d) ? d.map((row: any) => ({
        id: row.id,
        status: row.status,
        total: Number(row.total_amount || 0),
        created_at: row.created_at,
        order_number: row.order_number,
      })) : [];
      setMpList(list);
    } catch (e: any) {
      if (!silent) {
        setMpErr(e?.message || 'Erro ao buscar');
        setMpList([]);
      }
    } finally {
      if (!silent) setMpLoading(false);
    }
  }, [slug, cliToken]);

  useEffect(() => {
    if (abaCardapio !== 'meus_pedidos' || !cliToken || !slug) return;
    void buscarMeusPedidos();
  }, [abaCardapio, cliToken, slug, buscarMeusPedidos]);

  useEffect(() => {
    if (!cliToken || !slug) return;
    const id = window.setTimeout(() => {
      void buscarMeusPedidos({ silent: true, keepDetail: true });
    }, 1200);
    return () => clearTimeout(id);
  }, [cliToken, slug, buscarMeusPedidos]);

  const pedidoEmAndamento = useMemo(() => {
    const sorted = [...mpList].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    return sorted.find((p) => isPedidoAndamentoClienteStatus(p.status)) ?? null;
  }, [mpList]);

  const abrirDetalheMeusPedidos = useCallback(async (pedidoId: number, opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!cliToken) return;
    if (!silent) {
      setMpLoading(true);
      setMpErr('');
    }
    try {
      const r = await fetch(`/public/delivery/${slug}/orders/${pedidoId}`, { headers: { Authorization: `Bearer ${cliToken}` } });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Pedido nao encontrado');
      setMpDetalhe(d);
    } catch (e: any) {
      if (!silent) {
        setMpErr(e?.message || 'Erro ao abrir pedido');
        setMpDetalhe(null);
      }
    } finally {
      if (!silent) setMpLoading(false);
    }
  }, [slug, cliToken]);

  useEffect(() => {
    if (!slug || !cliToken) return;
    const interval = setInterval(() => {
      void buscarMeusPedidos({ keepDetail: true, silent: true });
    }, MEUS_PEDIDOS_POLL_MS);
    return () => clearInterval(interval);
  }, [slug, cliToken, buscarMeusPedidos]);

  useEffect(() => {
    if (!mpDetalhe || !cliToken || !slug) return;
    const interval = setInterval(() => {
      void abrirDetalheMeusPedidos(mpDetalhe.id, { silent: true });
    }, MEUS_PEDIDOS_POLL_MS);
    return () => clearInterval(interval);
  }, [mpDetalhe?.id ?? null, slug, cliToken, abrirDetalheMeusPedidos]);
  /** Sempre abre o modal do produto; a sacola só muda pelo botão final do `ProductOptionsModal`. */
  const handleAddProduto = (p: Produto) => {
    if (!ativo) return;
    setProdutoModal(p);
  };

  const addCartItem = (item: CartItem) => {
    setCart(prev => {
      const ex = prev.find(i => i.cart_key === item.cart_key);
      return ex
        ? prev.map(i => i.cart_key === item.cart_key ? {...i, qty: i.qty+1} : i)
        : [...prev, item];
    });
  };

  const removeCart = (cartKey: string) => setCart(prev => {
    const ex = prev.find(i => i.cart_key === cartKey);
    if (!ex) return prev;
    return ex.qty === 1 ? prev.filter(i => i.cart_key !== cartKey) : prev.map(i => i.cart_key === cartKey ? {...i, qty: i.qty-1} : i);
  });

  const cartQty = (id: number) => cart.filter(i=>i.id===id).reduce((a,i)=>a+i.qty,0);

  const toggleFav = async (prodId: number) => {
    if (!cliToken || !cliente) { abrirIdentificacao('cardapio'); return; }
    const favs = cliente.favoritos.includes(prodId) ? cliente.favoritos.filter(f=>f!==prodId) : [...cliente.favoritos, prodId];
    atualizarFavoritos(favs);
    fetch(`/public/delivery/${slug}/cliente/favoritos`, { method:'PUT', headers:{'Content-Type':'application/json','Authorization':`Bearer ${cliToken}`}, body:JSON.stringify({favoritos:favs}) });
  };

  const prodsFiltrados = useMemo(() => {
    let cats = categorias;
    if (debouncedSearch) {
      const t = debouncedSearch.toLowerCase();
      cats = cats.map(c => ({
        ...c,
        itens: c.itens.filter(p => p.name.toLowerCase().includes(t) || getProdutoDescricao(p).toLowerCase().includes(t)),
      })).filter(c => c.itens.length > 0);
    }
    if (abaCardapio === 'favoritos') {
      cats = cliente?.favoritos.length
        ? cats.map(c => ({ ...c, itens: c.itens.filter(p => cliente.favoritos.includes(p.id)) })).filter(c => c.itens.length > 0)
        : [];
    }
    if (abaCardapio === 'promocoes') {
      const promos = cats
        .flatMap(c => c.itens)
        .filter(isPromocaoProdutoValida)
        .sort((a, b) => {
          const descontoDiff = getPercentualDesconto(b) - getPercentualDesconto(a);
          if (descontoDiff !== 0) return descontoDiff;
          const destaqueDiff = Number(b.destaque || 0) - Number(a.destaque || 0);
          if (destaqueDiff !== 0) return destaqueDiff;
          return a.name.localeCompare(b.name, 'pt-BR');
        });
      cats = promos.length ? [{ nome: 'Promoções', itens: promos }] : [];
    }
    return cats;
  }, [categorias, debouncedSearch, abaCardapio, cliente?.favoritos]);

  const onPedidoOk = (d: PedidoConfirmado) => {
    setCart([]);
    setPedidoOk(d);
    setCheckoutOpen(false);
    setSacolaOpen(false);
    setCheckoutStep(1);
    if (d.pagamento_tipo === 'pix') {
      setPedidoSucessoOpen(false);
      setTela('confirmado');
    } else {
      setPedidoSucessoOpen(true);
    }
    void buscarMeusPedidos({ silent: true, keepDetail: true });
  };
  const fecharPedidoSucesso = useCallback(() => {
    setPedidoSucessoOpen(false);
    setPedidoOk(null);
    setTipoAtendimento(null);
  }, []);
  const fecharCheckoutModal = useCallback(() => {
    setCheckoutOpen(false);
    setCheckoutStep(1);
  }, []);
  const fecharSacolaModal = useCallback(() => { setSacolaOpen(false); }, []);

  useEffect(() => {
    if (!pedidoEmAndamento) setAcompanharBannerOpen(false);
  }, [pedidoEmAndamento]);

  useEffect(() => {
    if (!checkoutOpen && !sacolaOpen && !pedidoSucessoOpen && !acompanharBannerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [checkoutOpen, sacolaOpen, pedidoSucessoOpen, acompanharBannerOpen]);

  const hasSearch = search.trim().length > 0;
  const catalogEmptyState = useMemo(() => {
    if (hasSearch) {
      return {
        icon: Search,
        title: 'Nenhum item encontrado na busca',
        description: 'Tente outro termo ou volte para a vitrine completa para descobrir mais ofertas e categorias.',
        ctaLabel: 'Limpar busca',
        onClick: () => setSearch(''),
      };
    }
    if (abaCardapio === 'favoritos') {
      return {
        icon: Heart,
        title: 'Seus favoritos ainda estao vazios',
        description: 'Toque no coracao dos produtos para montar sua lista e voltar mais rapido nos seus pedidos preferidos.',
        ctaLabel: 'Explorar cardapio',
        onClick: () => setAbaCardapio('todos'),
      };
    }
    if (abaCardapio === 'promocoes') {
      return {
        icon: AlertCircle,
        title: 'Nenhuma oferta ativa agora',
        description: 'As promocoes validas aparecem aqui assim que estiverem disponiveis. Enquanto isso, explore os destaques do cardapio.',
        ctaLabel: 'Ver todos os itens',
        onClick: () => setAbaCardapio('todos'),
      };
    }
    return {
      icon: Package,
      title: 'Nenhum produto disponivel no momento',
      description: 'Atualize a busca ou navegue entre as categorias para encontrar o que deseja pedir agora.',
      ctaLabel: 'Ver categorias',
      onClick: () => {
        setSearch('');
        setAbaCardapio('todos');
      },
    };
  }, [abaCardapio, hasSearch, setAbaCardapio, setSearch]);
  const abrirIdentificacao = useCallback((destino: Tela = 'cardapio') => {
    setIdentificacaoAbaDestino(null);
    setPosIdentificacao(destino);
    setTela('identificar');
  }, []);
  const abrirCheckoutAPartirDaSacola = useCallback(() => {
    if (!ativo) return;
    if (!cliente && !assistido) {
      abrirIdentificacao('checkout');
      return;
    }
    setSacolaOpen(false);
    setCheckoutOpen(true);
    setCheckoutStep(1);
  }, [ativo, cliente, assistido, abrirIdentificacao]);
  const abrirPromocoesPublicas = useCallback(() => {
    setSearch('');
    setAbaCardapio('promocoes');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);
  const abrirPedidosPublicos = useCallback(() => {
    if (!cliToken || !cliente) {
      setIdentificacaoAbaDestino('meus_pedidos');
      setPosIdentificacao('cardapio');
      setTela('identificar');
      return;
    }
    setIdentificacaoAbaDestino(null);
    setSearch('');
    setAbaCardapio('meus_pedidos');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [cliToken, cliente]);
  const abrirContaOuIdentificacao = useCallback((destinoSemCliente: Tela = 'cardapio') => {
    if (cliente) {
      setTela('conta');
      return;
    }
    abrirIdentificacao(destinoSemCliente);
  }, [cliente, abrirIdentificacao]);
  const renderVitrineCard = (
    p: Produto,
    variant: 'showcase' | 'compact' | 'offer',
    options?: {
      sectionBadge?: { label: string; tone: 'cyan' | 'rose' | 'amber' };
      sectionHint?: string;
    }
  ) => {
    const qty = cartQty(p.id);
    const isFav = cliente?.favoritos.includes(p.id) || false;
    const temVariacoes = hasVariacoesVendaveis(p);
    const temModalDetalhes = produtoRequerModalDetalhes(p);
    const promoValida = isPromocaoProdutoValida(p);
    const percentualDesconto = getPercentualDesconto(p);
    const descricao = getProdutoDescricao(p);
    const precoMinimo = temVariacoes
      ? Math.min(...(p.variacoes_vendaveis!.map(v => Number(v.preco))))
      : calcPrecoMinimo(p);
    const temPrecoVariavel = precoMinimo > p.price || temVariacoes;
    const destaqueVisual = Number(p.destaque || 0) > 0;
    const vt = cardapioTheme.vitrine;
    const fotoSrc = normalizeProductPhotoPublicUrl(p.photo_url);
    const badgeTone = options?.sectionBadge?.tone === 'rose'
      ? 'border-rose-500/30 bg-rose-500/15 text-rose-100'
      : options?.sectionBadge?.tone === 'amber'
        ? 'border-amber-500/30 bg-amber-500/15 text-amber-100'
        : vt.badgeCyan;

    if (variant === 'showcase') {
      return (
        <div className={vt.showcaseCard}>
          <div
            className={`${vt.imageBg} outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${cardapioTheme.mode === 'light_red' ? 'focus-visible:ring-red-500/40 focus-visible:ring-offset-white' : 'focus-visible:ring-cyan-400/50 focus-visible:ring-offset-zinc-950'}`}
            onClick={() => handleAddProduto(p)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleAddProduto(p);
              }
            }}
            role="button"
            tabIndex={0}
            aria-label={`Abrir detalhes de ${p.name}`}
          >
            {fotoSrc ? (
              <FlowProductImage src={fotoSrc} alt={p.name} loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
            ) : (
              <div className={vt.noPhoto}>
                <Package size={30} className={cardapioTheme.mode === 'light_red' ? 'text-zinc-400' : 'text-zinc-600'} />
                <span className={`text-[11px] font-bold uppercase tracking-[0.18em] ${cardapioTheme.mode === 'light_red' ? 'text-zinc-500' : 'text-zinc-300'}`}>Sem foto</span>
              </div>
            )}
            <div className={`absolute inset-0 bg-gradient-to-t ${cardapioTheme.mode === 'light_red' ? 'from-black/45 via-black/10 to-transparent' : 'from-black/80 via-black/15 to-transparent'}`} />
            <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
              {options?.sectionBadge && (
                <span className={`rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em] ${badgeTone}`}>
                  {options.sectionBadge.label}
                </span>
              )}
              {promoValida && (
                <span className="rounded-full border border-emerald-200/40 bg-emerald-500 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-white shadow-[0_6px_20px_rgba(16,185,129,0.45)] ring-1 ring-white/20">
                  ✨ Oferta
                </span>
              )}
              {destaqueVisual && !promoValida && (
                <span className="rounded-full bg-amber-300 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-zinc-950 shadow-[0_6px_18px_rgba(251,191,36,0.35)] ring-1 ring-amber-100/40">
                  🔥 Top
                </span>
              )}
            </div>
            {qty > 0 && (
              <div className={vt.qtyBadge}>
                {qty}
              </div>
            )}
          </div>
          <div className="flex min-h-0 flex-1 flex-col justify-between px-3 py-3 sm:px-4 sm:py-3.5">
            <div className="min-h-0 flex-1 flex flex-col">
              <div className="flex shrink-0 items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p
                    className={`${vt.title} cursor-pointer outline-none focus-visible:rounded-lg focus-visible:ring-2 ${cardapioTheme.mode === 'light_red' ? 'focus-visible:ring-red-500/35' : 'focus-visible:ring-cyan-400/40'}`}
                    onClick={() => handleAddProduto(p)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleAddProduto(p);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    {p.name}
                  </p>
                  {(isFav || !temModalDetalhes) && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {isFav && <span className="shrink-0 text-[10px] font-bold text-amber-300">Favorito</span>}
                      {!temModalDetalhes && <span className="shrink-0 text-[10px] font-bold text-amber-200">⚡ Rapido</span>}
                    </div>
                  )}
                </div>
                <button type="button" onClick={() => toggleFav(p.id)} className={`shrink-0 self-start ${vt.favBtn}`} aria-label={isFav ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}>
                  <Heart size={14} className={isFav ? 'fill-rose-500 text-rose-500' : vt.favIcon} />
                </button>
              </div>
              {(descricao || options?.sectionHint) && (
                <div className="mt-2 min-h-0 flex-1 overflow-hidden">
                  {descricao && <p className={vt.desc}>{descricao}</p>}
                  {options?.sectionHint && <p className={vt.hint}>{options.sectionHint}</p>}
                </div>
              )}
            </div>
            <div className="mt-3 flex shrink-0 items-end justify-between gap-3 pt-0.5">
              <div className="min-w-0">
                {(temVariacoes || temPrecoVariavel) ? (
                  <>
                    <span className={vt.priceFrom}>A partir de</span>
                    <p className={vt.priceMain}>{fmt(precoMinimo)}</p>
                  </>
                ) : (
                  <>
                    {promoValida && (
                      <div className="flex flex-nowrap items-center gap-2 overflow-hidden">
                        <p className="min-w-0 shrink truncate text-sm font-semibold tabular-nums text-zinc-500 line-through decoration-zinc-500">{fmt(Number(p.preco_original || 0))}</p>
                        <span className="shrink-0 rounded-full border border-emerald-400/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-black text-emerald-200">-{percentualDesconto}%</span>
                      </div>
                    )}
                    <p className={promoValida ? vt.priceMainPromo : vt.priceMain}>{fmt(p.price)}</p>
                    {promoValida && (
                      <p className="mt-1 line-clamp-2 text-[11px] font-bold leading-snug text-emerald-100/95">
                        ✨ Economia de {fmt(Math.max(0, Number(p.preco_original || 0) - Number(p.price)))} no preco atual
                      </p>
                    )}
                  </>
                )}
              </div>
              <button onClick={() => ativo && handleAddProduto(p)} disabled={!ativo} className={vt.btnAdd}>
                <Plus size={14} />
                {temModalDetalhes ? 'Escolher' : 'Adicionar'}
              </button>
            </div>
          </div>
        </div>
      );
    }

    const wrapperClass = variant === 'offer' ? vt.compactOfferBg : '';

    return (
        <div className={`${vt.compactCard} ${wrapperClass}`.trim()}>
        <div
          className={`${vt.compactThumb} outline-none focus-visible:ring-2 ${cardapioTheme.mode === 'light_red' ? 'focus-visible:ring-red-500/40' : 'focus-visible:ring-cyan-400/45'}`}
          onClick={() => handleAddProduto(p)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleAddProduto(p);
            }
          }}
          role="button"
          tabIndex={0}
          aria-label={`Abrir detalhes de ${p.name}`}
        >
          {fotoSrc ? (
            <FlowProductImage src={fotoSrc} alt={p.name} loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
          ) : (
            <div className={`flex h-full w-full items-center justify-center ${cardapioTheme.mode === 'light_red' ? 'bg-gradient-to-br from-zinc-100 via-zinc-50 to-zinc-100' : 'bg-gradient-to-br from-zinc-800 via-zinc-900 to-zinc-950'}`}>
              <Package size={24} className={cardapioTheme.mode === 'light_red' ? 'text-zinc-400' : 'text-zinc-600'} />
            </div>
          )}
          <div className={`absolute inset-0 bg-gradient-to-t ${cardapioTheme.mode === 'light_red' ? 'from-black/40 via-black/5 to-transparent' : 'from-black/75 via-black/10 to-transparent'}`} />
          <div className="absolute left-2 top-2 flex max-w-[calc(100%-0.5rem)] flex-wrap gap-1">
            {options?.sectionBadge && (
              <span className={`rounded-full border px-2 py-1 text-[10px] font-black uppercase tracking-[0.16em] ${badgeTone}`}>
                {options.sectionBadge.label}
              </span>
            )}
            {destaqueVisual && !promoValida && (
              <span className="rounded-full bg-amber-300 px-2 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-zinc-950 shadow-sm ring-1 ring-amber-100/40">
                🔥 Top
              </span>
            )}
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-between overflow-hidden px-3 py-2.5 sm:px-3.5 sm:py-3">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex h-[26px] shrink-0 items-center justify-between gap-2">
              <div className="flex min-h-[22px] min-w-0 flex-1 items-center">
                {promoValida ? (
                  <span className="inline-flex max-w-full rounded-full border border-emerald-200/40 bg-emerald-500 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.14em] text-white shadow-[0_4px_12px_rgba(16,185,129,0.35)] ring-1 ring-white/15">
                    ✨ Oferta
                  </span>
                ) : null}
              </div>
              <button type="button" onClick={() => toggleFav(p.id)} className={`shrink-0 ${vt.favBtn}`} aria-label={isFav ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}>
                <Heart size={13} className={isFav ? 'fill-rose-500 text-rose-500' : vt.favIcon} />
              </button>
            </div>
            <div className="mt-0.5 min-h-[2.35rem] shrink-0">
              <p
                className={`line-clamp-2 cursor-pointer break-words text-[15px] font-black leading-snug tracking-tight outline-none selection:bg-red-100 selection:text-zinc-900 focus-visible:rounded-md focus-visible:ring-2 sm:text-base ${cardapioTheme.mode === 'light_red' ? 'text-zinc-900 focus-visible:ring-red-500/35' : 'text-white focus-visible:ring-cyan-400/40'}`}
                onClick={() => handleAddProduto(p)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleAddProduto(p);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                {p.name}
              </p>
            </div>
            <div className="mt-0.5 min-h-[2.35rem] shrink-0 overflow-hidden">
              {descricao ? (
                <p className={`line-clamp-2 text-[11px] leading-snug sm:text-[12px] ${cardapioTheme.mode === 'light_red' ? 'text-zinc-600' : 'text-zinc-200/95'}`}>{descricao}</p>
              ) : options?.sectionHint ? (
                <p className={`line-clamp-2 text-[10px] font-semibold uppercase leading-snug tracking-[0.14em] ${cardapioTheme.mode === 'light_red' ? 'text-zinc-500' : 'text-zinc-300'}`}>{options.sectionHint}</p>
              ) : (
                <span className="block text-[11px] leading-snug opacity-0" aria-hidden>
                  {'\u00a0'}
                </span>
              )}
            </div>
          </div>
          <div
            className={`mt-1.5 flex shrink-0 flex-col gap-2 border-t pt-2 ${
              cardapioTheme.mode === 'light_red' ? 'border-zinc-200/80' : 'border-white/10'
            }`}
          >
            <div className="min-h-[3.15rem] min-w-0">
              {(temVariacoes || temPrecoVariavel) ? (
                <>
                  <span className={vt.priceFrom}>A partir de</span>
                  <p
                    className={`mt-0.5 text-xl font-black tabular-nums leading-tight tracking-tight sm:text-[22px] ${
                      cardapioTheme.mode === 'light_red' ? 'text-red-700' : 'text-cyan-100'
                    }`}
                  >
                    {fmt(precoMinimo)}
                  </p>
                </>
              ) : (
                <>
                  <div className="flex min-h-[18px] items-center gap-1.5 overflow-hidden">
                    {promoValida ? (
                      <>
                        <p className="min-w-0 shrink truncate text-[11px] font-semibold tabular-nums text-zinc-500 line-through decoration-zinc-500">{fmt(Number(p.preco_original || 0))}</p>
                        <span className="shrink-0 rounded-full border border-emerald-400/35 bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-black tabular-nums text-emerald-200">-{percentualDesconto}%</span>
                      </>
                    ) : null}
                  </div>
                  <p
                    className={`text-xl font-black tabular-nums leading-tight tracking-tight sm:text-[22px] ${
                      promoValida
                        ? cardapioTheme.mode === 'light_red'
                          ? 'text-emerald-600'
                          : 'text-emerald-300'
                        : cardapioTheme.mode === 'light_red'
                          ? 'text-red-700'
                          : 'text-cyan-100'
                    }`}
                  >
                    {fmt(p.price)}
                  </p>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => ativo && handleAddProduto(p)}
              disabled={!ativo}
              className={`${vt.btnAdd} w-full min-w-0 justify-center whitespace-nowrap !min-h-[44px] !py-2`}
            >
              <Plus size={14} className="shrink-0" />
              {temModalDetalhes ? 'Escolher' : 'Adicionar'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  /** Só o cardápio bloqueia a vitrine; perfil do cliente hidrata em segundo plano (evita somar latências no mobile). */
  if (loading) {
    const sk =
      cardapioTheme.mode === 'light_red'
        ? {
            header: 'bg-zinc-200/90',
            heroCell: 'bg-zinc-200',
            heroWrap: 'border-zinc-200/90 bg-white',
            logo: 'bg-zinc-100',
            line: 'bg-zinc-200',
            lineSm: 'bg-zinc-200/80',
            card: 'bg-zinc-100',
            menu: 'bg-zinc-200/70',
          }
        : {
            header: 'bg-white/10',
            heroCell: 'bg-zinc-800/85',
            heroWrap: 'border-white/12 bg-zinc-900/45',
            logo: 'bg-zinc-800',
            line: 'bg-zinc-700/90',
            lineSm: 'bg-zinc-800/80',
            card: 'bg-zinc-800/55',
            menu: 'bg-white/8',
          };
    return (
      <CardapioThemeShell theme={cardapioTheme}>
        <div className={`${cardapioTheme.shell.root} min-h-[100dvh]`}>
          <div className={cardapioTheme.shell.inner}>
            <header className={cardapioTheme.header.bar}>
              <div className="mx-auto max-w-[1440px] px-3 py-1.5 sm:px-4 sm:py-3 lg:px-6">
                <div className={`h-9 w-full max-w-2xl animate-pulse rounded-xl sm:h-10 ${sk.header}`} />
              </div>
            </header>
            <div className="mx-auto max-w-[1440px] px-2 pt-1.5 pb-24 sm:px-3 sm:py-4 sm:pb-28 lg:px-6">
              <section className={`w-full overflow-hidden rounded-[22px] border p-0 shadow-none sm:rounded-[34px] ${sk.heroWrap}`}>
                <div className="grid grid-cols-4 grid-rows-1 gap-px bg-black/5 max-sm:h-[3.5rem] dark:bg-white/5 sm:grid-cols-2 sm:h-auto lg:grid-cols-4">
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className={`h-full animate-pulse max-sm:aspect-auto sm:aspect-[4/3] ${sk.heroCell}`}
                    />
                  ))}
                </div>
                <div className="flex min-h-[60px] items-center gap-2.5 px-3 py-2.5 sm:min-h-[96px] sm:gap-4 sm:px-5 sm:py-5 md:min-h-[104px] md:px-6">
                  <div className={`h-14 w-14 shrink-0 animate-pulse rounded-2xl sm:h-28 sm:w-28 sm:rounded-[36px] md:h-36 md:w-36 ${sk.logo}`} />
                  <div className="min-w-0 flex-1 space-y-1.5 sm:space-y-3">
                    <div className={`h-6 w-[78%] max-w-md animate-pulse rounded-lg sm:h-9 ${sk.line}`} />
                    <div className={`h-3 w-[52%] animate-pulse rounded sm:h-4 ${sk.lineSm}`} />
                  </div>
                </div>
              </section>
              <div className="mt-3 space-y-2.5 sm:mt-6 sm:space-y-4">
                <div className={`h-12 w-full animate-pulse rounded-2xl ${sk.menu}`} />
                <div className="grid gap-3 min-[480px]:grid-cols-2">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className={`h-40 animate-pulse rounded-3xl ${sk.card}`} />
                  ))}
                </div>
              </div>
              <p className={`mt-8 text-center text-sm ${cardapioTheme.pageLoading.text}`}>Carregando cardápio...</p>
            </div>
          </div>
        </div>
      </CardapioThemeShell>
    );
  }
  if (!slug) return (
    <CardapioThemeShell theme={cardapioTheme}>
      <div className={cardapioTheme.pageEmpty}><Package size={48}/></div>
    </CardapioThemeShell>
  );

  if (tela==='confirmado'&&pedidoOk) return (
    <CardapioThemeShell theme={cardapioTheme}>
      <TelaConfirmado
        pedidoOk={pedidoOk}
        config={config}
        slug={slug}
        tipoAtendimento={tipoAtendimento || 'entrega'}
        clienteToken={cliToken}
        onNovo={()=>{setPedidoOk(null);setTipoAtendimento(null);setTela('cardapio');}}
      />
    </CardapioThemeShell>
  );
  if (tela==='identificar') return (
    <CardapioThemeShell theme={cardapioTheme}>
      <TelaIdentificar
        slug={slug}
        tipoAtendimento={tipoAtendimento}
        contexto={posIdentificacao === 'checkout' ? 'checkout' : 'geral'}
        onSuccess={(t, c) => {
          salvarToken(t, c);
          const abaDest = identificacaoAbaDestino;
          setIdentificacaoAbaDestino(null);
          if (posIdentificacao === 'checkout') {
            setTela('cardapio');
            setSacolaOpen(false);
            if (ativo) {
              setCheckoutOpen(true);
              setCheckoutStep(1);
            }
            return;
          }
          if (abaDest === 'meus_pedidos') {
            setTela('cardapio');
            setAbaCardapio('meus_pedidos');
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return;
          }
          setTela(posIdentificacao);
        }}
        onBack={() => {
          setIdentificacaoAbaDestino(null);
          setTela(posIdentificacao === 'checkout' ? 'cardapio' : posIdentificacao);
        }}
      />
    </CardapioThemeShell>
  );
  if (tela==='conta') return (
    <CardapioThemeShell theme={cardapioTheme}>
      <TelaConta slug={slug} token={cliToken} cliente={cliente} onLogout={()=>{logout();setTela('cardapio');}} onBack={()=>setTela('cardapio')} onHistorico={()=>setTela('historico')} onEnderecos={()=>setTela('enderecos')} onEditarPerfil={()=>setTela('editar_perfil')} />
    </CardapioThemeShell>
  );
  if (tela==='editar_perfil') return (
    <CardapioThemeShell theme={cardapioTheme}>
      <TelaEditarPerfil slug={slug} token={cliToken} cliente={cliente} onSaved={(c)=>{salvarToken(cliToken!,c);setTela('conta');}} onBack={()=>setTela('conta')} />
    </CardapioThemeShell>
  );
  if (tela==='historico') return (
    <CardapioThemeShell theme={cardapioTheme}>
      <TelaHistorico slug={slug} token={cliToken} onBack={()=>setTela('conta')} onRepetir={(items)=>{items.forEach(i=>addCartItem({...i,qty:1}));setTela('cardapio');setSacolaOpen(true);}} categorias={categorias} />
    </CardapioThemeShell>
  );
  if (tela==='enderecos') return (
    <CardapioThemeShell theme={cardapioTheme}>
      <TelaEnderecos slug={slug} token={cliToken} onBack={()=>setTela('conta')} onNovo={()=>setTela('novo_endereco')} />
    </CardapioThemeShell>
  );
  if (tela==='novo_endereco') return (
    <CardapioThemeShell theme={cardapioTheme}>
      <TelaNovo
        Endereco
        slug={slug}
        token={cliToken}
        temZonas={(config.zonas_entrega || []).length > 0}
        onBack={() => setTela('enderecos')}
        onSaved={() => setTela('enderecos')}
      />
    </CardapioThemeShell>
  );
  return (
    <CardapioThemeShell theme={cardapioTheme}>
    <div className={cardapioTheme.shell.root}>
      {fundoDecorativo.url ? (
        <div className={isLightRed ? 'pointer-events-none fixed inset-0 z-0 bg-[#f6f6f4]' : 'pointer-events-none fixed inset-0 z-0 bg-zinc-950'} aria-hidden>
          <div
            className="absolute inset-0 bg-cover bg-center bg-no-repeat"
            style={{
              backgroundImage: `url(${fundoDecorativo.url})`,
              opacity: fundoDecorativo.opacity,
            }}
          />
        </div>
      ) : null}
      <div className={cardapioTheme.shell.inner}>
      <header className={cardapioTheme.header.bar}>
        <div className="mx-auto max-w-[1440px] px-3 py-1.5 sm:px-4 sm:py-3 lg:px-6">
          <div className="relative flex items-center justify-center pr-12 sm:pr-14">
            <nav className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-hide">
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setAbaCardapio('todos');
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className={cardapioTheme.header.navBtn}
            >
              Início
            </button>
            <button
              type="button"
              onClick={abrirPromocoesPublicas}
              className={cardapioTheme.header.navBtn}
            >
              Promoções
            </button>
            <button
              type="button"
              onClick={abrirPedidosPublicos}
              className={`relative ${cardapioTheme.header.navBtn}`}
            >
              Pedidos
              {pedidoEmAndamento ? (
                <span
                  className={
                    isLightRed
                      ? 'absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.85)] animate-pulse'
                      : 'absolute right-1 top-1 h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.9)] animate-pulse'
                  }
                  aria-hidden
                />
              ) : null}
            </button>
            <button
              type="button"
              onClick={()=>abrirContaOuIdentificacao('cardapio')}
              className={cardapioTheme.header.navBtn}
            >
              {cliente ? 'Minha conta' : 'Entrar / Cadastrar'}
            </button>
            </nav>
            <button type="button" onClick={()=>setSacolaOpen(true)} className={cardapioTheme.header.cartFab} aria-label="Abrir sacola">
              <ShoppingCart size={18} strokeWidth={2.35} className={cardapioTheme.header.cartFabIcon}/>
              {totalItens>0&&<motion.span initial={{scale:0}} animate={{scale:1}} className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-[10px] font-black text-white">{totalItens}</motion.span>}
            </button>
          </div>
        </div>
      </header>

      {!ativo && (
        <div className="bg-rose-600 px-4 py-2.5 text-center text-sm font-semibold text-white">
          {diaFolgaHoje
            ? 'Hoje a loja está fechada (folga semanal). Pedidos pelo cardápio não estão disponíveis.'
            : <>Delivery fechado no momento {(config.proxima_abertura || config.horario_abertura) && `• Abre às ${config.proxima_abertura || config.horario_abertura}`}</>}
        </div>
      )}

      <div className="mx-auto max-w-[1440px] px-2 pt-1.5 pb-28 sm:px-3 sm:py-4 sm:pb-32 lg:px-6 lg:pb-10">
        <section className={cardapioTheme.mode === 'light_red'
          ? 'w-full overflow-hidden rounded-[22px] border border-zinc-200/90 bg-white shadow-[0_20px_60px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.04] sm:rounded-[34px]'
          : 'w-full overflow-hidden rounded-[22px] border border-white/14 bg-[linear-gradient(180deg,rgba(42,42,48,0.98),rgba(24,24,28,1))] shadow-[0_28px_80px_rgba(0,0,0,0.35)] ring-1 ring-white/[0.05] sm:rounded-[34px]'}>
            <div className="relative">
            <div className={cardapioTheme.hero.gridBg}>
              {galeriaTopo.slice(0, 4).map((item, heroIdx) => (
                <div key={item.key} className={cardapioTheme.hero.cellBg}>
                  {item.tipo === 'fallback' || !item.src || heroBrokenKeys[item.key] ? (
                    <div className={cardapioTheme.hero.fallbackLetter}>
                      <span className={`text-base font-black sm:text-5xl ${cardapioTheme.mode === 'light_red' ? 'text-zinc-300' : 'text-zinc-300'}`}>{(nome || 'F').slice(0, 1).toUpperCase()}</span>
                    </div>
                  ) : (
                    <img
                      src={item.src}
                      alt={item.alt}
                      className="h-full w-full object-cover object-center"
                      loading={heroIdx === 0 ? 'eager' : 'lazy'}
                      decoding="async"
                      fetchPriority={heroIdx === 0 ? 'high' : 'low'}
                      onError={() => {
                        setHeroBrokenKeys((prev) => (prev[item.key] ? prev : { ...prev, [item.key]: true }));
                      }}
                    />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent max-sm:from-black/20" />
                </div>
              ))}
            </div>

            <div className="pointer-events-none absolute bottom-0 left-2.5 translate-y-[38%] sm:left-5 sm:translate-y-1/2 md:left-6">
              <div className={cardapioTheme.mode === 'light_red'
                ? 'flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl border-2 border-white bg-white shadow-[0_10px_28px_rgba(0,0,0,0.1)] sm:h-32 sm:w-32 sm:rounded-[36px] sm:border-4 sm:shadow-[0_14px_36px_rgba(0,0,0,0.12)] md:h-36 md:w-36'
                : 'flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl border-2 border-zinc-900 bg-zinc-950 shadow-[0_14px_32px_rgba(0,0,0,0.35)] sm:h-32 sm:w-32 sm:rounded-[36px] sm:border-4 sm:shadow-[0_18px_40px_rgba(0,0,0,0.38)] md:h-36 md:w-36'}>
                {logoResolvido ? (
                  <img src={logoResolvido} alt={nome} className="h-full w-full object-cover" decoding="async" loading="eager" fetchPriority="high" />
                ) : (
                  <span className={`text-lg font-black sm:text-3xl ${cardapioTheme.mode === 'light_red' ? 'text-red-600' : 'text-cyan-300'}`}>{(nome || 'F').slice(0, 1).toUpperCase()}</span>
                )}
              </div>
            </div>
          </div>

          <div className={cardapioTheme.lojaBlock}>
            <div className="flex min-h-[3.25rem] items-center pl-[4.25rem] sm:min-h-[5.5rem] sm:pl-[9.5rem] md:min-h-[6.75rem] md:pl-[11rem]">
              <div className="min-w-0 pr-1">
                <h2 className={`text-lg font-black leading-[1.15] tracking-tight sm:text-3xl md:text-4xl md:leading-tight lg:text-[52px] lg:leading-none ${cardapioTheme.mode === 'light_red' ? 'text-zinc-900' : 'text-white drop-shadow-[0_0_24px_rgba(255,255,255,0.08)]'}`}>{nome}</h2>
                <div className={`mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] sm:mt-3 sm:gap-x-6 sm:gap-y-2 sm:text-sm md:text-base ${cardapioTheme.mode === 'light_red' ? 'text-zinc-700' : 'text-zinc-100'}`}>
                  <p className={`flex min-w-0 max-w-full items-center gap-1 rounded-full px-2 py-0.5 sm:gap-2 sm:px-3 sm:py-1 ${ativo ? cardapioTheme.statusPillOpen : cardapioTheme.statusPillClosed}`}>
                    <Clock size={12} className={`shrink-0 sm:h-[15px] sm:w-[15px] ${ativo ? 'text-emerald-300' : 'text-zinc-300'}`} />
                    <span className="min-w-0 truncate max-sm:max-w-[10rem] sm:whitespace-nowrap">{horarioLoja}</span>
                  </p>
                  <p className={`flex min-w-0 max-w-full flex-[1_1_100%] items-center gap-1 font-medium sm:flex-[0_1_auto] sm:gap-2 ${cardapioTheme.mode === 'light_red' ? 'text-zinc-800' : 'text-zinc-100'}`}>
                    <MapPin size={12} className={`shrink-0 sm:h-[15px] sm:w-[15px] ${cardapioTheme.mode === 'light_red' ? 'text-red-600' : 'text-cyan-200'}`} />
                    <span className="min-w-0 truncate sm:overflow-visible sm:whitespace-normal">{resumoLocalizacao}</span>
                  </p>
                  <button
                    type="button"
                    onClick={() => setLojaInfoAberta(true)}
                    aria-label="Mais informações da loja"
                    className={
                      isLightRed
                        ? 'inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full text-xs font-semibold text-red-700 transition-colors hover:text-red-800 sm:min-h-0 sm:min-w-0 sm:gap-1.5 sm:rounded-full sm:px-0 sm:py-1 sm:text-sm md:text-base'
                        : 'inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full text-xs font-semibold text-cyan-100 transition-colors hover:text-cyan-50 sm:min-h-0 sm:min-w-0 sm:gap-1.5 sm:rounded-full sm:px-0 sm:py-1 sm:text-sm md:text-base'
                    }
                  >
                    <Info size={14} className={`shrink-0 sm:h-[15px] sm:w-[15px] ${isLightRed ? 'text-red-600' : 'text-cyan-200'}`} />
                    <span className="hidden sm:inline">Mais informacoes</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="mt-3 grid gap-3 sm:mt-6 sm:gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-2.5 sm:space-y-4">

            <section
              className={
                isLightRed
                  ? 'rounded-[20px] border border-zinc-200/90 bg-white p-2.5 shadow-[0_12px_40px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.03] sm:rounded-[32px] sm:p-4'
                  : 'rounded-[20px] border border-white/14 bg-[linear-gradient(180deg,rgba(42,42,48,0.98),rgba(24,24,28,1))] p-2.5 shadow-[0_22px_58px_rgba(0,0,0,0.3)] ring-1 ring-white/[0.04] sm:rounded-[32px] sm:p-4'
              }
            >
              <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
                <div className="relative min-w-0">
                  <button
                    type="button"
                    onClick={() => setMenuCatalogoAberto((prev) => !prev)}
                    className={`inline-flex min-h-[44px] max-w-full items-center gap-1.5 rounded-xl border px-2.5 py-2 text-[11px] font-bold transition-colors sm:gap-2 sm:rounded-2xl sm:px-4 sm:py-3 sm:text-sm ${
                      menuCatalogoAberto
                        ? isLightRed
                          ? 'border-red-200 bg-red-50 text-red-950 [.flowpdv-dark_&]:border-zinc-700 [.flowpdv-dark_&]:bg-zinc-800 [.flowpdv-dark_&]:text-white [.flowpdv-dark_&]:hover:bg-zinc-700 [.flowpdv-dark_&]:hover:text-white'
                          : 'border-red-500/60 bg-red-500 text-white hover:bg-red-600 hover:text-white'
                        : isLightRed
                          ? 'border-zinc-200 bg-white text-zinc-950 hover:bg-zinc-50 hover:text-zinc-950 [.flowpdv-dark_&]:border-zinc-700 [.flowpdv-dark_&]:bg-zinc-900 [.flowpdv-dark_&]:text-white [.flowpdv-dark_&]:hover:bg-zinc-800 [.flowpdv-dark_&]:hover:text-white'
                          : 'border-white/12 bg-zinc-800 text-white/80 hover:bg-zinc-700 hover:text-white'
                    }`}
                  >
                    <Menu size={16} />
                    {rotuloMenuCatalogo}
                  </button>

                  {menuCatalogoAberto && (
                    <div className={cardapioTheme.menuDropdown}>
                      <div className="space-y-1">
                        <button
                          type="button"
                          onClick={() => {
                            setAbaCardapio('todos');
                            setMenuCatalogoAberto(false);
                          }}
                          className={abaCardapio === 'todos' ? cardapioTheme.menuItemActive : cardapioTheme.menuItem}
                        >
                          <span>Todos</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (!cliente) {
                              abrirContaOuIdentificacao('cardapio');
                            } else {
                              setAbaCardapio('favoritos');
                            }
                            setMenuCatalogoAberto(false);
                          }}
                          className={abaCardapio === 'favoritos' ? cardapioTheme.menuItemActive : cardapioTheme.menuItem}
                        >
                          <span>Favoritos</span>
                          {cliente && (
                            <span
                              className={`text-xs font-semibold tabular-nums ${
                                abaCardapio === 'favoritos'
                                  ? isLightRed
                                    ? 'text-red-800'
                                    : 'text-cyan-800'
                                  : isLightRed
                                    ? 'text-zinc-400'
                                    : 'text-zinc-400'
                              }`}
                            >
                              {cliente.favoritos.length}
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            abrirPedidosPublicos();
                            setMenuCatalogoAberto(false);
                          }}
                          className={abaCardapio === 'meus_pedidos' ? cardapioTheme.menuItemActive : cardapioTheme.menuItem}
                        >
                          <span>Meus pedidos</span>
                        </button>
                      </div>

                      {categorias.length > 0 && (
                        <>
                          <div className="my-3 h-px bg-white/10" />
                          <div className="max-h-[260px] space-y-1 overflow-y-auto pr-1">
                            {categorias.map((c) => (
                              <button
                                key={c.nome}
                                type="button"
                                onClick={() => {
                                  setAbaCardapio('todos');
                                  setCatAtiva(c.nome);
                                  setMenuCatalogoAberto(false);
                                  requestAnimationFrame(() => {
                                    catRefs.current[c.nome]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                  });
                                }}
                                className={
                                  catAtiva === c.nome && abaCardapio === 'todos'
                                    ? cardapioTheme.menuCategoryActive
                                    : cardapioTheme.menuItem
                                }
                              >
                                <span className="min-w-0 truncate pr-2">{c.nome}</span>
                                <span
                                  className={
                                    catAtiva === c.nome && abaCardapio === 'todos'
                                      ? cardapioTheme.menuCategoryCountActive
                                      : cardapioTheme.menuCategoryCountIdle
                                  }
                                >
                                  {c.itens.length}
                                </span>
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setBuscaAberta((prev) => !prev)}
                  className={`inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl border px-2.5 py-2 text-[11px] font-bold transition-colors sm:gap-2 sm:rounded-2xl sm:px-4 sm:py-3 sm:text-sm ${
                    buscaAberta || search
                      ? isLightRed
                        ? 'border-red-200 bg-red-50 text-red-900'
                        : 'border-cyan-500/30 bg-cyan-500/10 text-cyan-100'
                      : isLightRed
                        ? 'border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50'
                        : 'border-white/12 bg-zinc-950 text-zinc-50 hover:bg-white/8'
                  }`}
                >
                  <Search size={15} className="shrink-0 sm:h-4 sm:w-4" />
                  <span className="whitespace-nowrap sm:hidden">{buscaAberta || search ? 'Ocultar' : 'Buscar'}</span>
                  <span className="hidden whitespace-nowrap sm:inline">{buscaAberta || search ? 'Ocultar busca' : 'Buscar no cardápio'}</span>
                </button>
                {search && (
                  <button
                    type="button"
                    onClick={() => { setSearch(''); setBuscaAberta(false); }}
                    className={
                      isLightRed
                        ? 'inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-50 px-2.5 py-2 text-[11px] font-bold text-zinc-700 transition-colors hover:bg-white sm:gap-2 sm:rounded-2xl sm:px-4 sm:py-3 sm:text-sm'
                        : 'inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl border border-white/12 bg-zinc-950 px-2.5 py-2 text-[11px] font-bold text-zinc-100 transition-colors hover:bg-white/8 sm:gap-2 sm:rounded-2xl sm:px-4 sm:py-3 sm:text-sm'
                    }
                  >
                    <X size={14} className="shrink-0 sm:h-[15px] sm:w-[15px]" />
                    <span className="sm:hidden">Limpar</span>
                    <span className="hidden sm:inline">Limpar busca</span>
                  </button>
                )}
              </div>

              {(buscaAberta || search) && (
                <div className="relative mt-3 sm:mt-4">
                  <Search size={16} className={`pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 sm:left-4 ${isLightRed ? 'text-zinc-400' : 'text-zinc-300'}`}/>
                  <input
                    value={search}
                    onChange={e=>setSearch(e.target.value)}
                    placeholder="Buscar pratos, lanches, bebidas e combos"
                    className={cardapioTheme.searchInput}
                  />
                  {search&&<button onClick={()=>setSearch('')} className={`absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 ${isLightRed ? 'text-zinc-400 hover:text-zinc-700' : 'text-zinc-300 hover:text-white'}`}><X size={14}/></button>}
                </div>
              )}

            </section>

            {pedidoEmAndamento && abaCardapio !== 'meus_pedidos' && !search && (
              <section
                className={
                  isLightRed
                    ? 'rounded-[28px] border-2 border-red-300/80 bg-gradient-to-br from-red-50 via-white to-white p-5 shadow-[0_16px_44px_rgba(220,38,38,0.14)] ring-1 ring-red-100/70'
                    : 'rounded-[28px] border-2 border-cyan-400/40 bg-[linear-gradient(145deg,rgba(6,78,92,0.35),rgba(22,24,30,0.98))] p-5 shadow-[0_22px_56px_rgba(34,211,238,0.18)] ring-1 ring-cyan-500/25'
                }
              >
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <button
                      type="button"
                      onClick={() => setAcompanharBannerOpen(true)}
                      aria-label={`Acompanhar pedido ${pedidoEmAndamento.order_number ? `#${pedidoEmAndamento.order_number}` : `#${pedidoEmAndamento.id}`}`}
                      className={
                        isLightRed
                          ? 'flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-2xl border-0 bg-transparent p-0 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white'
                          : 'flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-2xl border-0 bg-transparent p-0 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900'
                      }
                    >
                      <div
                        className={
                          isLightRed
                            ? 'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-red-600 text-white shadow-md'
                            : 'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-cyan-500/25 text-cyan-100 shadow-inner'
                        }
                      >
                        <Package size={22} strokeWidth={2.35} aria-hidden />
                      </div>
                      <div className="min-w-0">
                        <p className={`text-[11px] font-black uppercase tracking-[0.2em] ${isLightRed ? 'text-red-800' : 'text-cyan-200/90'}`}>
                          Pedido em andamento
                        </p>
                        <p className={`mt-1 truncate text-lg font-black ${isLightRed ? 'text-zinc-950' : 'text-white'}`}>
                          {pedidoEmAndamento.order_number ? `#${pedidoEmAndamento.order_number}` : `Pedido #${pedidoEmAndamento.id}`}
                        </p>
                        <span
                          className={`mt-2 inline-flex text-[11px] font-black px-2.5 py-1 rounded-full ${badgeClassStatusPedido(pedidoEmAndamento.status, cardapioTheme.mode)}`}
                        >
                          {labelStatusPedidoCliente(pedidoEmAndamento.status)}
                        </span>
                      </div>
                    </button>
                    <div className="flex flex-col gap-2 sm:shrink-0 sm:flex-row sm:justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          abrirPedidosPublicos();
                          void abrirDetalheMeusPedidos(pedidoEmAndamento.id);
                        }}
                        className={
                          isLightRed
                            ? 'rounded-2xl bg-red-600 px-5 py-3 text-center text-sm font-black text-white shadow-md transition-colors hover:bg-red-700'
                            : 'rounded-2xl bg-white px-5 py-3 text-center text-sm font-black text-zinc-950 shadow-[0_12px_32px_rgba(255,255,255,0.12)] transition-colors hover:bg-cyan-200'
                        }
                      >
                        Ver na aba Pedidos
                      </button>
                      <button
                        type="button"
                        onClick={() => setAcompanharBannerOpen(true)}
                        className={
                          isLightRed
                            ? 'inline-flex items-center justify-center rounded-2xl border border-zinc-200 bg-white px-5 py-3 text-sm font-bold text-zinc-800 transition-colors hover:bg-zinc-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white'
                            : 'inline-flex items-center justify-center rounded-2xl border border-white/18 bg-white/10 px-5 py-3 text-sm font-bold text-zinc-100 transition-colors hover:bg-white/14 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900'
                        }
                      >
                        Acompanhar passo a passo
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAcompanharBannerOpen(true)}
                    className={`w-full border-0 bg-transparent p-0 text-left text-xs leading-relaxed focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 sm:rounded-xl sm:px-1 sm:py-0.5 ${
                      isLightRed
                        ? `cursor-pointer text-zinc-600 focus-visible:ring-red-500 focus-visible:ring-offset-white`
                        : `cursor-pointer text-zinc-400 focus-visible:ring-cyan-400 focus-visible:ring-offset-zinc-900`
                    }`}
                  >
                    O status é o mesmo da cozinha e da operação; esta página atualiza automaticamente a cada poucos segundos.
                  </button>
                </div>
              </section>
            )}

            {!search && abaCardapio==='todos' && produtosDestaque.length > 0 && (
              <section
                className={
                  isLightRed
                    ? 'rounded-[20px] border border-zinc-200/90 bg-white p-2.5 shadow-[0_12px_36px_rgba(0,0,0,0.06)] sm:rounded-[30px] sm:p-4'
                    : 'rounded-[20px] border border-white/12 bg-[linear-gradient(180deg,rgba(39,39,42,0.96),rgba(24,24,27,1))] p-2.5 shadow-[0_18px_50px_rgba(0,0,0,0.22)] sm:rounded-[30px] sm:p-4'
                }
              >
                <div className="mb-2 flex items-center justify-between gap-2 sm:mb-4 sm:gap-3">
                  <div className="min-w-0">
                    <p className={`text-[10px] font-bold uppercase tracking-[0.2em] sm:text-[11px] sm:tracking-[0.22em] ${isLightRed ? 'text-red-700/90' : 'text-cyan-200/80'}`}>Destaques</p>
                    <h3 className={`mt-0.5 text-base font-black sm:mt-1 sm:text-lg md:text-xl ${isLightRed ? 'text-zinc-900' : 'text-white'}`}>Produtos em destaque</h3>
                  </div>
                  {totalPromocoesValidas > 0 && (
                    <button
                      type="button"
                      onClick={abrirPromocoesPublicas}
                      className={
                        isLightRed
                          ? 'rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-bold text-emerald-800 transition-colors hover:bg-emerald-100'
                          : 'rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-2 text-xs font-bold text-emerald-100 transition-colors hover:bg-emerald-500/16'
                      }
                    >
                      Ver promocoes
                    </button>
                  )}
                </div>
                <div className="flex snap-x snap-mandatory gap-2 overflow-x-auto scroll-pl-1 pb-1.5 scrollbar-hide sm:gap-3 sm:pb-2 sm:scroll-pl-0">
                  {produtosDestaque.slice(0, 6).map((produto) => (
                    <div key={`destaque-simples-${produto.id}`} className="snap-start shrink-0">
                      {renderVitrineCard(produto, 'compact')}
                    </div>
                  ))}
                </div>
              </section>
            )}

        {/* Meus pedidos */}
        {abaCardapio === 'meus_pedidos' && !search && (
          <div className="space-y-4">
            {!cliToken && (
              <div
                className={
                  isLightRed
                    ? 'rounded-[28px] border border-zinc-200/90 bg-white p-5 shadow-[0_12px_40px_rgba(0,0,0,0.06)]'
                    : 'rounded-[28px] border border-white/12 bg-[linear-gradient(180deg,rgba(39,39,42,0.98),rgba(24,24,27,1))] p-5 shadow-[0_18px_50px_rgba(0,0,0,0.26)]'
                }
              >
                <p className={`text-[11px] font-bold uppercase tracking-[0.22em] ${isLightRed ? 'text-red-700/90' : 'text-cyan-300/80'}`}>Acompanhe seus pedidos</p>
                <p className={`mt-2 text-lg font-black ${isLightRed ? 'text-zinc-900' : 'text-white'}`}>Identifique-se com seu telefone</p>
                <p className={`mt-1 text-sm ${isLightRed ? 'text-zinc-600' : 'text-zinc-200'}`}>
                  Por seguranca, a lista de pedidos so aparece apos confirmar o mesmo telefone usado na loja. Leva poucos segundos.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setIdentificacaoAbaDestino('meus_pedidos');
                    setPosIdentificacao('cardapio');
                    setTela('identificar');
                  }}
                  className={
                    isLightRed
                      ? 'mt-4 w-full rounded-2xl bg-red-600 px-5 py-3.5 text-sm font-black text-white shadow-md transition-colors hover:bg-red-700'
                      : 'mt-4 w-full rounded-2xl bg-white px-5 py-3.5 text-sm font-black text-zinc-950 shadow-[0_14px_30px_rgba(255,255,255,0.14)] transition-colors hover:bg-cyan-300 hover:shadow-[0_18px_34px_rgba(34,211,238,0.24)]'
                  }
                >
                  Entrar com telefone
                </button>
              </div>
            )}
            {cliToken && mpErr && <p className={`px-1 text-xs font-medium ${isLightRed ? 'text-red-600' : 'text-red-300'}`}>{mpErr}</p>}
            {mpList.length > 0 && (
              <div className="space-y-2">
                <p className={`px-1 text-xs font-black uppercase tracking-wider ${isLightRed ? 'text-zinc-500' : 'text-zinc-200'}`}>Pedidos encontrados</p>
                {mpList.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => void abrirDetalheMeusPedidos(p.id)}
                    className={
                      isLightRed
                        ? 'w-full rounded-[22px] border border-zinc-200/90 bg-white p-3.5 text-left shadow-sm transition-colors active:scale-[0.99] hover:border-red-200 hover:shadow-md sm:rounded-[26px] sm:p-4'
                        : 'w-full rounded-[22px] border border-white/12 bg-[linear-gradient(180deg,rgba(39,39,42,0.98),rgba(24,24,27,1))] p-3.5 text-left shadow-[0_18px_50px_rgba(0,0,0,0.24)] transition-colors active:scale-[0.99] hover:border-cyan-400/40 hover:shadow-[0_20px_44px_rgba(8,145,178,0.12)] sm:rounded-[26px] sm:p-4'
                    }
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className={`text-xs font-medium ${isLightRed ? 'text-zinc-500' : 'text-zinc-200'}`}>
                          {p.order_number ? `#${p.order_number}` : `Pedido #${p.id}`}
                        </p>
                        <p className={`mt-0.5 text-sm font-bold ${isLightRed ? 'text-zinc-900' : 'text-white'}`}>
                          {new Date(p.created_at).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                      <span className={`text-[11px] font-black px-2.5 py-1 rounded-full shrink-0 ${badgeClassStatusPedido(p.status, cardapioTheme.mode)}`}>
                        {labelStatusPedidoCliente(p.status)}
                      </span>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <p className={`text-sm font-black ${isLightRed ? 'text-red-700' : 'text-cyan-300'}`}>{fmt(p.total)}</p>
                      <span className={`text-xs font-semibold ${isLightRed ? 'text-zinc-500' : 'text-zinc-200'}`}>Toque para ver detalhes</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {cliToken && mpList.length === 0 && !mpLoading && !mpErr && (
              <div
                className={
                  isLightRed
                    ? 'rounded-[28px] border border-dashed border-zinc-200 bg-zinc-50/80 px-6 py-10 text-center'
                    : 'rounded-[28px] border border-dashed border-white/12 bg-zinc-900/80 px-6 py-10 text-center'
                }
              >
                <ClipboardList size={40} className={`mx-auto mb-4 ${isLightRed ? 'text-zinc-400' : 'text-zinc-500'}`} />
                <p className={`text-sm font-bold ${isLightRed ? 'text-zinc-900' : 'text-white'}`}>Voce ainda nao fez pedidos por aqui</p>
                <p className={`mt-2 text-sm ${isLightRed ? 'text-zinc-600' : 'text-zinc-200'}`}>Quando voce finalizar uma compra, o acompanhamento vai aparecer nesta area.</p>
              </div>
            )}
          </div>
        )}

        {/* Produtos */}
        {abaCardapio !== 'meus_pedidos' && (prodsFiltrados.length===0
          ? (() => {
              const EmptyIcon = catalogEmptyState.icon;
              return (
                <div
                  className={
                    isLightRed
                      ? 'rounded-[30px] border border-dashed border-zinc-200 bg-zinc-50/90 px-6 py-12 text-center text-zinc-600'
                      : 'rounded-[30px] border border-dashed border-white/12 bg-zinc-900/80 px-6 py-12 text-center text-zinc-300'
                  }
                >
                  <div
                    className={
                      isLightRed
                        ? 'mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-zinc-200 bg-white text-zinc-400'
                        : 'mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-white/8 text-zinc-300'
                    }
                  >
                    <EmptyIcon size={28} />
                  </div>
                  <p className={`mt-4 text-base font-black ${isLightRed ? 'text-zinc-900' : 'text-white'}`}>{catalogEmptyState.title}</p>
                  <p className={`mx-auto mt-2 max-w-md text-sm leading-relaxed ${isLightRed ? 'text-zinc-600' : 'text-zinc-200'}`}>{catalogEmptyState.description}</p>
                  <button
                    type="button"
                    onClick={catalogEmptyState.onClick}
                    className={
                      isLightRed
                        ? 'mt-5 inline-flex items-center justify-center rounded-2xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-bold text-zinc-800 shadow-sm transition-colors hover:bg-zinc-50'
                        : 'mt-5 inline-flex items-center justify-center rounded-2xl border border-white/12 bg-white/10 px-4 py-2.5 text-sm font-bold text-zinc-100 transition-colors hover:bg-white/14'
                    }
                  >
                    {catalogEmptyState.ctaLabel}
                  </button>
                </div>
              );
            })()
          : prodsFiltrados.map(cat=>(
            <div key={cat.nome} ref={el=>{catRefs.current[cat.nome]=el}}>
              <div className="mb-2 flex items-center gap-2 pt-1 sm:mb-3 sm:gap-3 sm:pt-2">
                <h2 className={`text-base font-black tracking-tight sm:text-lg ${isLightRed ? 'text-zinc-950' : 'text-white drop-shadow-sm'}`}>{cat.nome}</h2>
                <div className={`h-px flex-1 ${isLightRed ? 'bg-gradient-to-r from-zinc-200 via-zinc-100 to-transparent' : 'bg-gradient-to-r from-white/15 via-white/8 to-transparent'}`}/>
                <span
                  className={
                    isLightRed
                      ? 'rounded-full border border-zinc-200 bg-zinc-100 px-2.5 py-1 text-xs font-bold text-zinc-700'
                      : 'rounded-full border border-white/14 bg-zinc-800/90 px-2.5 py-1 text-xs font-bold text-zinc-100'
                  }
                >
                  {cat.itens.length} itens
                </span>
              </div>
              <div className="grid gap-3 sm:gap-4 xl:grid-cols-2">
                {cat.itens.map(p=>{
                  const qty=cartQty(p.id);
                  const isFav=cliente?.favoritos.includes(p.id)||false;
                  const temVariacoes = hasVariacoesVendaveis(p);
                  const temModalDetalhes = produtoRequerModalDetalhes(p);
                  const promoValida = isPromocaoProdutoValida(p);
                  const percentualDesconto = getPercentualDesconto(p);
                  const descricao = getProdutoDescricao(p);
                  const precoMinimo = temVariacoes
                    ? Math.min(...(p.variacoes_vendaveis!.map(v=>Number(v.preco))))
                    : calcPrecoMinimo(p);
                  const temPrecoVariavel = precoMinimo > p.price || temVariacoes;
                  const destaqueVisual = Number(p.destaque || 0) > 0;
                  const gridFotoSrc = normalizeProductPhotoPublicUrl(p.photo_url);
                  const gridCardRing = isLightRed ? 'ring-black/[0.03]' : 'ring-white/[0.04]';
                  const gridCardBody = isLightRed
                    ? qty > 0
                      ? 'border-red-400/75 bg-gradient-to-br from-red-50 via-rose-50/85 to-zinc-100/90 shadow-[0_12px_32px_rgba(220,38,38,0.14)]'
                      : 'border-zinc-200/90 bg-white shadow-[0_8px_28px_rgba(0,0,0,0.06)] hover:-translate-y-1 hover:border-red-200 hover:shadow-[0_14px_36px_rgba(220,38,38,0.1)]'
                    : qty > 0
                      ? 'border-cyan-400/50 bg-[linear-gradient(180deg,rgba(48,52,62,0.99),rgba(24,26,32,1))] shadow-[0_22px_56px_rgba(34,211,238,0.2)]'
                      : 'border-white/14 bg-[linear-gradient(180deg,rgba(48,48,56,0.99),rgba(24,24,30,1))] hover:-translate-y-1 hover:border-cyan-400/32 hover:shadow-[0_28px_60px_rgba(34,211,238,0.14)]';
                  const gridAddBtn = isLightRed
                    ? 'flex shrink-0 min-h-[46px] items-center gap-2 rounded-2xl border border-red-700/20 bg-red-600 px-4 py-2 text-sm font-black text-white shadow-[0_10px_28px_rgba(220,38,38,0.28)] transition-all duration-300 ease-out hover:bg-red-700 hover:shadow-[0_14px_34px_rgba(220,38,38,0.22)] disabled:border-transparent disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none active:scale-95'
                    : 'flex shrink-0 min-h-[46px] items-center gap-2 rounded-2xl border border-white/15 bg-[linear-gradient(135deg,#4ade80,#22d3ee)] px-4 py-2 text-sm font-black text-zinc-950 shadow-[0_14px_36px_rgba(34,211,238,0.35)] ring-1 ring-cyan-300/30 transition-all duration-300 ease-out hover:brightness-110 hover:shadow-[0_20px_44px_rgba(52,211,153,0.22)] disabled:border-transparent disabled:bg-zinc-700 disabled:text-zinc-500 disabled:shadow-none disabled:ring-0 active:scale-95';
                  return (
                    <div
                      key={p.id}
                      className={`group h-[156px] min-h-0 overflow-hidden rounded-[22px] border transition-all duration-300 ease-out backdrop-blur-sm ring-1 [tap-highlight-color:transparent] active:scale-[0.995] sm:h-[168px] sm:rounded-[32px] ${gridCardRing} ${gridCardBody}`}
                    >
                      <div className="flex h-full min-h-0 items-stretch">
                        <div
                          className={`relative h-[156px] w-[100px] flex-shrink-0 cursor-pointer overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-red-500/35 sm:h-[168px] sm:w-[146px] ${isLightRed ? 'bg-zinc-100' : 'bg-zinc-800'}`}
                          onClick={()=>handleAddProduto(p)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              handleAddProduto(p);
                            }
                          }}
                          role="button"
                          tabIndex={0}
                          aria-label={`Abrir detalhes de ${p.name}`}
                        >
                          {gridFotoSrc ? (
                            <FlowProductImage src={gridFotoSrc} alt={p.name} loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"/>
                          ) : (
                            <div className={`flex h-full w-full flex-col items-center justify-center gap-2 ${isLightRed ? 'bg-gradient-to-br from-zinc-100 via-zinc-50 to-zinc-100' : 'bg-gradient-to-br from-zinc-800 via-zinc-900 to-zinc-950'}`}>
                              <Package size={30} className="text-zinc-600"/>
                              <span className={`text-[11px] font-bold uppercase tracking-[0.18em] ${isLightRed ? 'text-zinc-500' : 'text-zinc-300'}`}>Sem foto</span>
                            </div>
                          )}
                          <div className={`absolute inset-0 bg-gradient-to-t ${isLightRed ? 'from-black/40 via-black/5 to-transparent' : 'from-black/70 via-black/10 to-transparent'}`}/>
                          <div className="absolute left-2 top-2 flex flex-wrap gap-1">
                            {promoValida && (
                              <span className="rounded-full border border-emerald-200/40 bg-emerald-500 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-white shadow-[0_6px_20px_rgba(16,185,129,0.45)] ring-1 ring-white/20">
                                ✨ Oferta
                              </span>
                            )}
                            {!promoValida && destaqueVisual && (
                              <span className="rounded-full bg-amber-300 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-zinc-950 shadow-[0_6px_18px_rgba(251,191,36,0.35)] ring-1 ring-amber-100/40">
                                🔥 Top
                              </span>
                            )}
                          </div>
                          {qty>0&&<div className={`absolute bottom-2 left-2 flex h-8 min-w-[30px] items-center justify-center rounded-full px-2 text-xs font-black shadow-lg ${isLightRed ? 'bg-red-600 text-white' : 'bg-cyan-400 text-zinc-950'}`}>{qty}</div>}
                        </div>
                        <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-between px-2.5 py-2 sm:px-4 sm:py-3.5">
                          <div className="flex min-h-0 flex-1 flex-col">
                            <div className="flex shrink-0 items-start gap-2 sm:gap-3">
                              <div className="min-w-0 flex-1">
                                <p
                                  className={`line-clamp-2 min-h-[2.35rem] cursor-pointer break-words text-[14px] font-black leading-snug tracking-tight selection:bg-red-100 selection:text-zinc-900 sm:min-h-[2.5rem] sm:text-[17px] ${isLightRed ? 'text-zinc-900' : 'text-white drop-shadow-sm'}`}
                                  onClick={()=>handleAddProduto(p)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      handleAddProduto(p);
                                    }
                                  }}
                                  role="button"
                                  tabIndex={0}
                                >
                                  {p.name}
                                </p>
                                {(isFav || (!promoValida && destaqueVisual)) && (
                                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                    {isFav && <span className={`shrink-0 text-[10px] font-bold ${isLightRed ? 'text-amber-700' : 'text-amber-300'}`}>Favorito</span>}
                                    {!promoValida && destaqueVisual && <span className={`shrink-0 text-[10px] font-bold ${isLightRed ? 'text-amber-700' : 'text-amber-200'}`}>⭐ Frequente</span>}
                                  </div>
                                )}
                              </div>
                              <button type="button" onClick={()=>toggleFav(p.id)} className={`shrink-0 self-start rounded-full border p-2 transition-all active:scale-110 ${isLightRed ? 'border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50' : 'border-white/12 bg-white/8 hover:border-white/20 hover:bg-white/12'}`} aria-label={isFav?'Remover dos favoritos':'Adicionar aos favoritos'}>
                                <Heart size={14} className={isFav?'fill-rose-500 text-rose-500': isLightRed ? 'text-zinc-400 hover:text-rose-500 transition-colors' : 'text-zinc-200 hover:text-white transition-colors'}/>
                              </button>
                            </div>
                            {descricao && (
                              <div className="mt-1.5 min-h-0 flex-1 overflow-hidden">
                                <p className={`line-clamp-1 text-[13px] leading-relaxed ${isLightRed ? 'text-zinc-600' : 'text-zinc-200/95'}`}>{descricao}</p>
                              </div>
                            )}
                          </div>
                          <div className="mt-1.5 flex shrink-0 items-end justify-between gap-2 sm:gap-3 sm:mt-2 pt-0.5">
                            {/* Preço: "A partir de" quando tem variações; preço fixo quando não tem */}
                            <div className="min-w-0">
                              {temVariacoes ? (
                                <div>
                                  <span className={`text-[10px] font-semibold uppercase tracking-wide ${isLightRed ? 'text-zinc-500' : 'text-zinc-300'}`}>A partir de</span>
                                  <p className={`mt-0.5 text-[19px] font-black tabular-nums leading-tight sm:text-[28px] ${isLightRed ? 'text-red-700' : 'text-cyan-200 drop-shadow-[0_0_20px_rgba(34,211,238,0.28)]'}`}>{fmt(precoMinimo)}</p>
                                </div>
                              ) : temPrecoVariavel ? (
                                <div>
                                  <span className={`text-[10px] font-semibold uppercase tracking-wide ${isLightRed ? 'text-zinc-500' : 'text-zinc-300'}`}>A partir de</span>
                                  <p className={`mt-0.5 text-[19px] font-black tabular-nums leading-tight sm:text-[28px] ${isLightRed ? 'text-red-700' : 'text-cyan-200 drop-shadow-[0_0_20px_rgba(34,211,238,0.28)]'}`}>{fmt(precoMinimo)}</p>
                                </div>
                              ) : (
                                <div>
                                  {promoValida && (
                                    <div className="flex flex-nowrap items-center gap-1.5 overflow-hidden">
                                      <p className="min-w-0 shrink truncate text-sm font-semibold tabular-nums text-zinc-500 line-through decoration-zinc-500">{fmt(Number(p.preco_original || 0))}</p>
                                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-black ${isLightRed ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-emerald-400/30 bg-emerald-500/15 text-emerald-200'}`}>-{percentualDesconto}%</span>
                                    </div>
                                  )}
                                  <p className={`text-[19px] font-black tabular-nums leading-tight sm:text-[28px] ${promoValida ? (isLightRed ? 'text-emerald-600' : 'text-emerald-400 drop-shadow-[0_0_22px_rgba(52,211,153,0.35)]') : (isLightRed ? 'text-red-700' : 'text-cyan-200 drop-shadow-[0_0_20px_rgba(34,211,238,0.28)]')}`}>{fmt(p.price)}</p>
                                  {promoValida && (
                                    <p className={`mt-0.5 line-clamp-2 text-[11px] font-bold leading-snug ${isLightRed ? 'text-emerald-800' : 'text-emerald-100/95'}`}>
                                      ✨ Economia de {fmt(Math.max(0, Number(p.preco_original || 0) - Number(p.price)))}
                                    </p>
                                  )}
                                </div>
                              )}
                            </div>
                            {/* Se tem variações ou opções: botão "Adicionar" abre modal */}
                            {temModalDetalhes ? (
                              <button onClick={()=>ativo&&handleAddProduto(p)} disabled={!ativo} className={gridAddBtn}>
                                {qty>0?<><span className={`rounded-full px-2 py-0.5 text-xs font-black ${isLightRed ? 'bg-white/20' : 'bg-zinc-950/10'}`}>{qty}</span>Escolher</>:<><Plus size={14}/>Escolher</>}
                              </button>
                            ) : qty===0 ? (
                              <button onClick={()=>ativo&&handleAddProduto(p)} disabled={!ativo} className={gridAddBtn}>
                                <Plus size={14}/>Adicionar
                              </button>
                            ) : (
                              <div className={`flex shrink-0 items-center gap-2 rounded-2xl border p-1 shadow-inner ${isLightRed ? 'border-zinc-200 bg-white shadow-zinc-200/40' : 'border-white/10 bg-zinc-950 shadow-black/20'}`}>
                                <button onClick={()=>removeCart(`${p.id}_`)} className={`flex h-9 w-9 items-center justify-center rounded-xl transition-colors hover:text-rose-400 active:scale-95 ${isLightRed ? 'bg-zinc-100 text-zinc-600' : 'bg-zinc-800 text-zinc-200'}`} aria-label="Remover um item"><Minus size={12}/></button>
                                <span className={`w-7 text-center text-sm font-black ${isLightRed ? 'text-zinc-900' : 'text-white'}`}>{qty}</span>
                                <button onClick={()=>handleAddProduto(p)} className={`flex h-9 w-9 items-center justify-center rounded-xl transition-colors active:scale-95 ${isLightRed ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-cyan-400 text-zinc-950 hover:bg-cyan-300'}`} aria-label="Adicionar mais um item"><Plus size={12}/></button>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
          </div>

          <aside className="hidden xl:-mt-[72px] xl:block">
            <div className="sticky top-24 space-y-4">
              <div
                className={
                  isLightRed
                    ? 'rounded-[30px] border border-stone-700/50 bg-[#231f1d] p-5 shadow-[0_28px_64px_rgba(0,0,0,0.36)] ring-1 ring-black/25'
                    : 'rounded-[30px] border border-white/16 bg-[linear-gradient(165deg,rgba(44,44,52,0.99),rgba(22,22,28,1))] p-5 shadow-[0_28px_80px_rgba(0,0,0,0.42)] ring-1 ring-cyan-500/10'
                }
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className={`text-[11px] font-bold uppercase tracking-[0.22em] ${isLightRed ? 'text-red-300' : 'text-cyan-50'}`}>Sua sacola</p>
                    <h3 className={`mt-1 text-xl font-black tracking-tight ${isLightRed ? 'text-stone-50' : 'text-white'}`}>Resumo do pedido</h3>
                  </div>
                  <div
                    className={
                      isLightRed
                        ? 'flex h-11 w-11 items-center justify-center rounded-2xl bg-red-600 text-white shadow-md ring-2 ring-red-400/35'
                        : 'flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-200 to-cyan-500 text-zinc-950 shadow-[0_10px_32px_rgba(34,211,238,0.45)] ring-2 ring-cyan-300/50'
                    }
                  >
                    <ShoppingBag size={21} strokeWidth={2.25} />
                  </div>
                </div>

                {cart.length === 0 ? (
                  <div
                    className={
                      isLightRed
                        ? 'mt-5 rounded-[24px] border border-dashed border-stone-500/45 bg-[#faf6f0] p-5 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] ring-1 ring-stone-400/20'
                        : 'mt-5 rounded-[24px] border border-dashed border-cyan-500/20 bg-zinc-950/85 p-5 text-center'
                    }
                  >
                    <div
                      className={
                        isLightRed
                          ? 'mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-red-100 text-red-700 ring-1 ring-red-200/80'
                          : 'mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-cyan-500/10 text-cyan-200 ring-1 ring-cyan-400/20'
                      }
                    >
                      <ShoppingCart size={24} />
                    </div>
                    <p className={`mt-4 text-sm font-bold ${isLightRed ? 'text-stone-900' : 'text-white'}`}>🛒 Sua sacola ainda esta vazia</p>
                    <p className={`mt-1 text-sm leading-relaxed ${isLightRed ? 'text-stone-600' : 'text-zinc-200'}`}>Adicione itens para acompanhar o pedido por aqui.</p>
                  </div>
                ) : (
                  <>
                    <div className="mt-5 space-y-2">
                      {cart.slice(0, 4).map((item) => {
                        const lineFoto = normalizeProductPhotoPublicUrl(item.photo_url);
                        return (
                        <div
                          key={item.cart_key}
                          className={
                            isLightRed
                              ? 'flex items-center gap-3 rounded-2xl border border-stone-500/35 bg-[#f3efe8] p-3 shadow-sm ring-1 ring-stone-400/15'
                              : 'flex items-center gap-3 rounded-2xl border border-white/14 bg-zinc-950/90 p-3 shadow-[0_8px_24px_rgba(0,0,0,0.2)]'
                          }
                        >
                          {lineFoto ? (
                            <FlowProductImage src={lineFoto} alt={item.name} className="h-14 w-14 rounded-xl object-cover" />
                          ) : (
                            <div className={`flex h-14 w-14 items-center justify-center rounded-xl ${isLightRed ? 'bg-stone-300/90 text-stone-600' : 'bg-zinc-800 text-zinc-500'}`}>
                              <Package size={18} />
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <p className={`truncate text-sm font-bold ${isLightRed ? 'text-stone-900' : 'text-white'}`}>{item.name}</p>
                            <p className={`mt-0.5 text-xs ${isLightRed ? 'text-stone-600' : 'text-zinc-100/90'}`}>{item.qty}x item</p>
                            <p className={`mt-1 text-sm font-black tabular-nums ${isLightRed ? 'text-red-700' : 'text-cyan-200 drop-shadow-[0_0_14px_rgba(34,211,238,0.22)]'}`}>{fmt(item.preco_final * item.qty)}</p>
                          </div>
                        </div>
                        );
                      })}
                      {cart.length > 4 && (
                        <p className={`px-1 text-xs font-medium ${isLightRed ? 'text-stone-400' : 'text-zinc-100/90'}`}>+{cart.length - 4} item(ns) na sacola</p>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => setSacolaOpen(true)}
                      className={
                        isLightRed
                          ? 'mt-5 flex w-full items-center justify-between rounded-[22px] border border-red-400/40 bg-red-600 px-5 py-4 text-sm font-black text-white shadow-[0_10px_28px_rgba(0,0,0,0.25)] transition-all hover:bg-red-700'
                          : 'mt-5 flex w-full items-center justify-between rounded-[22px] border border-white/20 bg-white px-5 py-4 text-sm font-black text-zinc-950 shadow-[0_16px_40px_rgba(255,255,255,0.12)] ring-1 ring-cyan-400/20 transition-all hover:bg-cyan-300 hover:shadow-[0_22px_48px_rgba(34,211,238,0.25)]'
                      }
                    >
                      <span>Abrir sacola</span>
                      <span className="tabular-nums">{fmt(subtotal)}</span>
                    </button>
                    <p className={`mt-3 text-center text-xs font-medium leading-relaxed ${isLightRed ? 'text-stone-400' : 'text-zinc-100'}`}>Entrega ou retirada: voce escolhe na finalizacao.</p>
                  </>
                )}
              </div>

              <div
                className={
                  isLightRed
                    ? 'rounded-[30px] border border-stone-700/50 bg-[#231f1d] p-5 shadow-[0_28px_64px_rgba(0,0,0,0.36)] ring-1 ring-black/25'
                    : 'rounded-[30px] border border-white/16 bg-[linear-gradient(165deg,rgba(44,44,52,0.99),rgba(22,22,28,1))] p-5 shadow-[0_28px_80px_rgba(0,0,0,0.42)] ring-1 ring-white/[0.06]'
                }
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className={`text-[11px] font-bold uppercase tracking-[0.22em] ${isLightRed ? 'text-red-300' : 'text-cyan-50'}`}>Entrega e resumo</p>
                    <h3 className={`mt-1 text-xl font-black tracking-tight ${isLightRed ? 'text-stone-50' : 'text-white'}`}>Taxa e cupom</h3>
                  </div>
                  <div
                    className={
                      isLightRed
                        ? 'flex h-11 w-11 items-center justify-center rounded-2xl border border-stone-500/50 bg-[#faf6f0] text-red-700 shadow-sm ring-1 ring-stone-400/25'
                        : 'flex h-11 w-11 items-center justify-center rounded-2xl border border-cyan-500/25 bg-gradient-to-br from-cyan-500/20 to-zinc-950 text-cyan-200 shadow-[0_8px_22px_rgba(34,211,238,0.12)]'
                    }
                  >
                    <Bike size={20} />
                  </div>
                </div>

                {entregaResumo.toLowerCase().includes('gratis') && (
                  <div
                    className={
                      isLightRed
                        ? 'mt-4 rounded-2xl border border-red-300/40 bg-[#fff5f4] px-4 py-3 shadow-sm ring-1 ring-red-200/25'
                        : 'mt-4 rounded-2xl border border-cyan-400/30 bg-cyan-500/15 px-4 py-3 shadow-[0_8px_28px_rgba(34,211,238,0.12)]'
                    }
                  >
                    <p className={`text-sm font-black ${isLightRed ? 'text-red-900' : 'text-cyan-50'}`}>⚡ {entregaResumo}</p>
                    <p className={`mt-1 text-xs font-medium leading-relaxed ${isLightRed ? 'text-red-800/90' : 'text-cyan-50'}`}>A confirmacao final depende do checkout e do endereco selecionado.</p>
                  </div>
                )}

                <div
                  className={
                    isLightRed
                      ? 'mt-4 rounded-[24px] border border-stone-500/45 bg-[#faf6f0] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] ring-1 ring-stone-400/20'
                      : 'mt-4 rounded-[24px] border border-white/14 bg-zinc-950/90 p-4 shadow-inner shadow-black/20'
                  }
                >
                  <ResumoComercialLinhas
                    resumo={resumoVitrine}
                    descontoPixPercentual={Number(config.desconto_pix || 0)}
                    tipoAtendimento={null}
                    mensagemAuxiliar="Entrega, retirada, cupom e total final sao definidos no checkout."
                    totalLabel="Previa da sacola"
                  />
                </div>

                <div className="mt-4 space-y-3">
                  <div
                    className={
                      isLightRed
                        ? 'rounded-2xl border border-stone-500/35 bg-[#f0ebe4] p-4 shadow-sm ring-1 ring-stone-400/15'
                        : 'rounded-2xl border border-cyan-500/25 bg-zinc-950/90 p-4 shadow-[0_10px_28px_rgba(0,0,0,0.2)]'
                    }
                  >
                    <p className={`text-xs font-black uppercase tracking-[0.18em] ${isLightRed ? 'text-red-800' : 'text-cyan-100'}`}>🚚 Entrega</p>
                    <p className={`mt-2 text-sm font-semibold leading-snug ${isLightRed ? 'text-stone-900' : 'text-white'}`}>{entregaResumo}</p>
                    <div
                      className={
                        isLightRed
                          ? 'mt-2 flex items-center gap-2.5 rounded-xl border border-stone-400/45 bg-[#faf8f5] px-3 py-2 shadow-sm'
                          : 'mt-2 flex items-center gap-2.5 rounded-xl border border-cyan-400/35 bg-cyan-500/15 px-3 py-2 shadow-[0_0_20px_rgba(34,211,238,0.08)]'
                      }
                    >
                      <Clock size={16} className={`shrink-0 ${isLightRed ? 'text-red-600' : 'text-cyan-300'}`} aria-hidden />
                      <p className={`text-sm font-bold tabular-nums leading-snug ${isLightRed ? 'text-stone-900' : 'text-cyan-50'}`}>
                        {config.tempo_preparo || 40}–{(config.tempo_preparo || 40) + 10} min de preparo estimado
                      </p>
                    </div>
                  </div>
                  <div
                    className={
                      isLightRed
                        ? 'rounded-2xl border border-emerald-600/25 bg-[#ecf8f1] p-4 shadow-sm ring-1 ring-emerald-300/20'
                        : 'rounded-2xl border border-emerald-500/20 bg-zinc-950/90 p-4 shadow-[0_10px_28px_rgba(0,0,0,0.2)]'
                    }
                  >
                    <p className={`text-xs font-black uppercase tracking-[0.18em] ${isLightRed ? 'text-emerald-900' : 'text-emerald-100'}`}>🏷️ Cupom e beneficios</p>
                    <p className={`mt-2 text-sm font-semibold leading-snug ${isLightRed ? 'text-stone-900' : 'text-white'}`}>Use seu codigo no checkout antes de confirmar o pedido.</p>
                    <div
                      className={
                        isLightRed
                          ? 'mt-2 flex items-start gap-2 rounded-xl border border-emerald-400/35 bg-[#fafcf9] px-3 py-2 shadow-sm'
                          : 'mt-2 flex items-start gap-2 rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-3 py-2'
                      }
                    >
                      <Tag size={15} className={`mt-0.5 shrink-0 ${isLightRed ? 'text-emerald-600' : 'text-emerald-300'}`} aria-hidden />
                      <p className={`text-xs font-medium leading-relaxed ${isLightRed ? 'text-emerald-900' : 'text-emerald-50/95'}`}>Pix, cupom e outras vantagens entram no total na etapa final.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>

      <AnimatePresence>
        {lojaInfoAberta && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
            <div className={`absolute inset-0 backdrop-blur-sm ${isLightRed ? 'bg-black/40' : 'bg-black/60'}`} onClick={() => setLojaInfoAberta(false)} />
            <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 360 }}
              className={
                isLightRed
                  ? 'relative flex max-h-[min(85dvh,100%)] w-full max-w-xl flex-col overflow-hidden rounded-t-[32px] border border-zinc-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_28px_80px_rgba(0,0,0,0.18)] sm:rounded-[32px] sm:pb-0'
                  : 'relative flex max-h-[min(85dvh,100%)] w-full max-w-xl flex-col overflow-hidden rounded-t-[32px] border border-white/12 bg-zinc-950 pb-[env(safe-area-inset-bottom)] shadow-[0_28px_80px_rgba(0,0,0,0.54)] sm:rounded-[32px] sm:pb-0'
              }
            >
              <div className={`flex items-start justify-between gap-3 border-b p-5 ${isLightRed ? 'border-zinc-100' : 'border-white/12'}`}>
                <div>
                  <p className={`text-[11px] font-bold uppercase tracking-[0.22em] ${isLightRed ? 'text-red-800' : 'text-cyan-100'}`}>Mais informacoes</p>
                  <h3 className={`mt-1 text-2xl font-black ${isLightRed ? 'text-zinc-900' : 'text-white'}`}>{nome}</h3>
                  <p className={`mt-2 text-sm ${ativo ? (isLightRed ? 'text-emerald-700' : 'text-emerald-200') : isLightRed ? 'text-zinc-600' : 'text-zinc-100'}`}>{horarioLoja}</p>
                </div>
                <button type="button" onClick={() => setLojaInfoAberta(false)} className={`rounded-2xl border p-2 transition-colors ${isLightRed ? 'border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-white' : 'border-white/12 bg-white/8 text-zinc-100 hover:bg-white/12'}`}>
                  <X size={18} />
                </button>
              </div>
              <div className="space-y-3 overflow-y-auto p-5">
                <LojaInfoLinha
                  icon={<MessageCircle size={18} />}
                  label="WhatsApp"
                  value={config.whatsapp ? config.whatsapp : 'Nao informado'}
                  href={whatsappHref}
                />
                <LojaInfoLinha
                  icon={<Instagram size={18} />}
                  label="Instagram"
                  value="Nao informado"
                />
                <LojaInfoLinha
                  icon={<MapPin size={18} />}
                  label="Endereco"
                  value="Nao informado"
                />
                <LojaInfoLinha
                  icon={<Clock size={18} />}
                  label="Horario"
                  value={horarioLoja}
                />
                <LojaInfoLinha
                  icon={<Bike size={18} />}
                  label="Entrega"
                  value={entregaResumo}
                />
                <LojaInfoLinha
                  icon={<Tag size={18} />}
                  label="Pedido minimo"
                  value={Number(config.pedido_minimo || 0) > 0 ? fmt(Number(config.pedido_minimo || 0)) : 'Nao informado'}
                />
                <p className={`px-1 text-xs leading-relaxed ${isLightRed ? 'text-zinc-500' : 'text-zinc-100/80'}`}>
                  WhatsApp, horario e entrega usam os dados publicos disponiveis hoje. Instagram e endereco aparecem aqui quando estiverem configurados e expostos no fluxo publico.
                </p>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Detalhe pedido (Meus pedidos) */}
      <AnimatePresence>
        {mpDetalhe && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center">
            <div className={`absolute inset-0 backdrop-blur-sm ${isLightRed ? 'bg-black/40' : 'bg-black/60'}`} onClick={() => setMpDetalhe(null)}/>
            <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              className={
                isLightRed
                  ? 'relative flex max-h-[min(85dvh,100%)] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-zinc-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl sm:rounded-3xl sm:pb-0'
                  : 'relative flex max-h-[min(85dvh,100%)] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl bg-zinc-950 pb-[env(safe-area-inset-bottom)] shadow-2xl sm:rounded-3xl sm:pb-0'
              }
            >
              <div className={`flex items-start justify-between gap-3 border-b p-5 ${isLightRed ? 'border-zinc-100' : 'border-white/12'}`}>
                <div>
                  <p className={`text-xs font-medium ${isLightRed ? 'text-zinc-500' : 'text-zinc-300'}`}>
                    {mpDetalhe.order_number ? `#${mpDetalhe.order_number}` : `Pedido #${mpDetalhe.id}`}
                  </p>
                  <span className={`inline-block mt-2 text-[11px] font-black px-2.5 py-1 rounded-full ${badgeClassStatusPedido(mpDetalhe.status, cardapioTheme.mode)}`}>
                    {labelStatusPedidoCliente(mpDetalhe.status)}
                  </span>
                  <p className={`mt-2 text-xs ${isLightRed ? 'text-zinc-500' : 'text-zinc-300'}`}>
                    {new Date(mpDetalhe.created_at).toLocaleString('pt-BR')}
                  </p>
                </div>
                <button type="button" onClick={() => setMpDetalhe(null)} className={`shrink-0 rounded-xl p-2 ${isLightRed ? 'hover:bg-zinc-100' : 'hover:bg-white/8'}`}>
                  <X size={20} className={isLightRed ? 'text-zinc-500' : 'text-zinc-300'}/>
                </button>
              </div>
              <div className="flex-1 space-y-3 overflow-y-auto p-5">
                <p className={`text-sm font-black ${isLightRed ? 'text-zinc-900' : 'text-white'}`}>Itens</p>
                {Array.isArray(mpDetalhe.itens) && mpDetalhe.itens.map((it, idx) => (
                  <div key={idx} className={`flex justify-between gap-3 border-b pb-2 text-sm ${isLightRed ? 'border-zinc-100' : 'border-white/5'}`}>
                    <span className={`min-w-0 flex-1 font-medium ${isLightRed ? 'text-zinc-800' : 'text-zinc-100'}`}>{it.name} <span className={`font-normal ${isLightRed ? 'text-zinc-500' : 'text-zinc-300'}`}>x{it.quantity}</span></span>
                    <span className={`shrink-0 font-bold ${isLightRed ? 'text-zinc-900' : 'text-zinc-200'}`}>{fmt(it.price_at_time * it.quantity)}</span>
                  </div>
                ))}
              </div>
              <div className={`flex items-center justify-between border-t px-5 py-5 ${isLightRed ? 'border-zinc-100 bg-zinc-50' : 'border-white/12 bg-zinc-900'}`}>
                <div>
                  <span className={`font-black ${isLightRed ? 'text-zinc-900' : 'text-white'}`}>Total</span>
                  <p className={`mt-1 text-xs ${isLightRed ? 'text-zinc-500' : 'text-zinc-300'}`}>Voce tambem pode abrir o acompanhamento publico deste pedido.</p>
                </div>
                <span className={`text-lg font-black ${isLightRed ? 'text-red-700' : 'text-cyan-200 drop-shadow-[0_0_12px_rgba(34,211,238,0.14)]'}`}>{fmt(mpDetalhe.total)}</span>
              </div>
              <div className={`border-t px-5 pb-5 ${isLightRed ? 'border-zinc-100 bg-zinc-50' : 'border-white/12 bg-zinc-900'}`}>
                <a
                  href={`/delivery/${slug}/pedido/${mpDetalhe.id}`}
                  className={
                    isLightRed
                      ? 'mt-4 flex w-full items-center justify-center gap-2 rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm font-bold text-zinc-800 shadow-sm transition-colors hover:bg-zinc-50'
                      : 'mt-4 flex w-full items-center justify-center gap-2 rounded-2xl border border-white/12 bg-white/10 px-4 py-3 text-sm font-bold text-zinc-100 transition-colors hover:bg-white/14'
                  }
                >
                  <Clock size={15} />
                  Abrir acompanhamento do pedido
                </a>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Barra fixa do carrinho — visível enquanto navega no cardápio */}
      <AnimatePresence>
        {cart.length > 0 && (
          <motion.div initial={{y:100,opacity:0}} animate={{y:0,opacity:1}} exit={{y:100,opacity:0}} className="fixed left-4 right-4 z-30 mx-auto max-w-[1440px] bottom-[max(1.25rem,calc(env(safe-area-inset-bottom)+0.75rem))] xl:hidden">
            <button type="button" onClick={() => setSacolaOpen(true)} className={cardapioTheme.barraFlutuante}>
              <span className="flex items-center gap-2.5">
                <span className={cardapioTheme.barraFlutuanteIconWrap}>
                  <ShoppingCart size={18} strokeWidth={2.35} className={cardapioTheme.barraFlutuanteIcon} aria-hidden />
                </span>
                <span className={cardapioTheme.barraFlutuanteBadge}>{totalItens} {totalItens===1?'item':'itens'}</span>
              </span>
              <span className={cardapioTheme.barraFlutuanteTotal}>{fmt(subtotal)}</span>
              <span className="font-black">Revisar pedido</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {sacolaOpen && (
          <SacolaModal
            open={sacolaOpen}
            onClose={fecharSacolaModal}
            onContinuarCheckout={abrirCheckoutAPartirDaSacola}
            slug={slug}
            cliToken={cliToken}
            cart={cart}
            config={config}
            tipoAtendimento={tipoAtendimento}
            suggestions={prefetchedSuggestions}
            loadingSuggestions={loadingSuggestions}
            showSuggestions={shouldShowSuggestions}
            suggestionsReady={suggestionsReadyForCurrentCart}
            suggestionsPending={suggestionsPendingForCurrentCart}
            suggestionRequestKey={suggestionProductSignature}
            onAdd={(p) => addCartItem({ ...p, qty: 1 })}
            onAddSuggestion={(item: SuggestionItem) => {
              const produtoCompleto = categorias
                .flatMap((c) => c.itens)
                .find((p) => Number(p.id) === Number(item?.id));
              if (produtoCompleto) {
                handleAddProduto(produtoCompleto);
                return;
              }
              let variacoes: VariacaoVendavel[] = [];
              if (Array.isArray(item?.variacoes_vendaveis)) variacoes = item.variacoes_vendaveis;
              else if (typeof item?.variacoes_vendaveis === 'string') {
                try { variacoes = JSON.parse(item.variacoes_vendaveis || '[]'); } catch { /* ignore */ }
              }
              if (variacoes.length > 0) {
                const produtoFallback = { ...item, variacoes_vendaveis: variacoes } as Produto;
                setProdutoModal(produtoFallback);
                return;
              }
              console.warn('[delivery-suggestions] Produto sugerido nao encontrado no cardapio carregado:', {
                suggestedId: item?.id,
                suggestedName: item?.name,
              });
              addCartItem({
                ...item,
                qty: 1,
                preco_final: Number(item?.price || 0),
                cart_key: `${item?.id}_`,
              } as CartItem);
            }}
            onRemove={(key) => removeCart(key)}
            aceitaPedidos={ativo}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {checkoutOpen && (cliente || assistido) && (
          <TelaCheckout
            slug={slug}
            cart={cart}
            config={config}
            assistido={assistido}
            cliToken={assistido ? null : cliToken}
            cliente={assistido ? null : cliente}
            tipoAtendimento={tipoAtendimento}
            onTipoAtendimentoChange={setTipoAtendimento}
            onSuccess={onPedidoOk}
            modalUi={{
              step: checkoutStep,
              onStepChange: setCheckoutStep,
              onClose: () => {
                fecharCheckoutModal();
                if (ativo) setSacolaOpen(true);
              },
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {pedidoSucessoOpen && pedidoOk && (
          <PedidoSucessoModal
            pedidoOk={pedidoOk}
            config={config}
            slug={slug}
            tipoAtendimento={tipoAtendimento}
            onFechar={fecharPedidoSucesso}
            onNovoPedido={fecharPedidoSucesso}
          />
        )}
      </AnimatePresence>

      {pedidoEmAndamento ? (
        <ModalAcompanharPedido
          open={acompanharBannerOpen}
          onClose={() => setAcompanharBannerOpen(false)}
          slug={slug}
          pedidoId={pedidoEmAndamento.id}
        />
      ) : null}

      {/* Modal de opções do produto */}
      <AnimatePresence>
        {produtoModal && (
          <Fragment key={produtoModal.id}>
            <ProductOptionsModal
              produto={produtoModal}
              onClose={()=>setProdutoModal(null)}
              onAdicionar={(item)=>{ addCartItem(item); setProdutoModal(null); }}
              resolveComboComponente={resolveComboComponenteDelivery}
            />
          </Fragment>
        )}
      </AnimatePresence>
      </div>
    </div>
    </CardapioThemeShell>
  );
}


type SacolaUpsellCardData = {
  item: SuggestionItem;
  featured: boolean;
  badge: string;
  headline: string;
  support: string;
  cta: string;
  pricePrefix: string;
  displayPrice: number;
};

function SacolaUpsellCard({
  card,
  isLightRed,
  onAdd,
}: {
  card: SacolaUpsellCardData;
  isLightRed: boolean;
  onAdd: (item: SuggestionItem) => void;
}) {
  const featured = card.featured;
  const upsellFoto = normalizeProductPhotoPublicUrl(card.item.photo_url);
  return (
    <div
      className={
        featured
          ? isLightRed
            ? 'flex h-full min-h-[200px] flex-col rounded-[20px] border-2 border-red-400/70 bg-[linear-gradient(180deg,#fffdf9_0%,#ffe8e0_100%)] p-3 shadow-[0_10px_28px_rgba(220,38,38,0.10)] ring-1 ring-red-200/70 sm:min-h-[208px] sm:p-3.5'
            : 'flex h-full min-h-[200px] flex-col rounded-[20px] border border-cyan-400/35 bg-[linear-gradient(180deg,rgba(16,18,28,1)_0%,rgba(10,22,30,0.99)_100%)] p-3 shadow-[0_12px_32px_rgba(0,0,0,0.35)] ring-1 ring-cyan-400/25 sm:min-h-[208px] sm:p-3.5'
          : isLightRed
            ? 'flex h-full min-h-[200px] flex-col rounded-[18px] border border-stone-300/80 bg-[#fffefc] p-3 shadow-sm sm:min-h-[208px] sm:rounded-[20px] sm:p-3.5'
            : 'flex h-full min-h-[200px] flex-col rounded-[18px] border border-white/12 bg-zinc-950 p-3 sm:min-h-[208px] sm:rounded-[20px] sm:p-3.5'
      }
    >
      <div className="shrink-0 space-y-2 sm:space-y-2.5">
        {upsellFoto ? (
          <FlowProductImage
            src={upsellFoto}
            alt={card.item.name}
            className={
              featured
                ? isLightRed
                  ? 'aspect-[4/3] w-full rounded-[14px] border-2 border-red-200/85 object-cover shadow-[0_8px_22px_rgba(220,38,38,0.10)] sm:rounded-[16px]'
                  : 'aspect-[4/3] w-full rounded-[14px] border border-cyan-400/25 object-cover shadow-[0_10px_26px_rgba(0,0,0,0.28)] sm:rounded-[16px]'
                : isLightRed
                  ? 'aspect-[4/3] w-full rounded-[14px] border border-stone-200 object-cover shadow-sm sm:rounded-[16px]'
                  : 'aspect-[4/3] w-full rounded-[14px] border border-white/10 object-cover shadow-[0_8px_22px_rgba(0,0,0,0.2)] sm:rounded-[16px]'
            }
          />
        ) : (
          <div
            className={
              featured
                ? isLightRed
                  ? 'flex aspect-[4/3] w-full items-center justify-center rounded-[14px] border-2 border-red-200/85 bg-red-50/80 text-[10px] font-black tracking-[0.16em] text-red-700 sm:rounded-[16px]'
                  : 'flex aspect-[4/3] w-full items-center justify-center rounded-[14px] border border-cyan-400/25 bg-cyan-400/[0.08] text-[10px] font-black tracking-[0.16em] text-cyan-200 sm:rounded-[16px]'
                : isLightRed
                  ? 'flex aspect-[4/3] w-full items-center justify-center rounded-[14px] border border-stone-200 bg-stone-100 text-[10px] font-black tracking-[0.16em] text-stone-600 sm:rounded-[16px]'
                  : 'flex aspect-[4/3] w-full items-center justify-center rounded-[14px] border border-white/10 bg-black/25 text-[10px] font-black tracking-[0.16em] text-cyan-200 sm:rounded-[16px]'
            }
          >
            ITEM
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex w-fit max-w-full items-center truncate rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.14em] sm:px-2.5 sm:py-1 sm:text-[10px] ${featured ? (isLightRed ? 'bg-red-600 text-white ring-1 ring-red-600/70' : 'bg-cyan-300/95 text-zinc-950 ring-1 ring-cyan-200/50') : (isLightRed ? 'bg-red-50 text-red-700 ring-1 ring-red-100' : 'bg-white/[0.07] text-zinc-200 ring-1 ring-white/10')}`}
          >
            {card.badge}
          </span>
          {featured && (
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.14em] sm:px-2.5 sm:py-1 sm:text-[10px] ${isLightRed ? 'bg-white text-red-700 ring-1 ring-red-200' : 'bg-white/[0.08] text-cyan-100 ring-1 ring-cyan-400/25'}`}
            >
              Escolha da casa
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 pt-2 sm:pt-2.5">
        {card.item.category ? (
          <p
            className={`line-clamp-1 text-[9px] font-black uppercase tracking-[0.14em] sm:text-[10px] ${featured ? (isLightRed ? 'text-red-700' : 'text-cyan-200/75') : (isLightRed ? 'text-stone-500' : 'text-zinc-400')}`}
          >
            {card.item.category}
          </p>
        ) : (
          <div className="h-[10px] sm:h-[12px]" aria-hidden />
        )}
        <p
          className={
            featured
              ? `mt-1 line-clamp-2 text-[15px] font-black leading-snug tracking-tight sm:mt-1.5 sm:text-base ${isLightRed ? 'text-stone-900' : 'text-white'}`
              : `mt-1 line-clamp-2 text-[13px] font-black leading-snug sm:text-[14px] ${isLightRed ? 'text-stone-900' : 'text-zinc-100'}`
          }
        >
          {card.item.name}
        </p>
        <p
          className={
            featured
              ? `mt-1 line-clamp-2 text-[11px] leading-relaxed sm:text-[12px] ${isLightRed ? 'text-stone-600' : 'text-zinc-400'}`
              : `mt-1 line-clamp-2 text-[11px] leading-relaxed sm:min-h-[2.25rem] sm:text-[11.5px] ${isLightRed ? 'text-stone-600' : 'text-zinc-400'}`
          }
        >
          {card.headline}
        </p>
        {featured && (
          <p className={`mt-1 line-clamp-1 text-[10px] leading-relaxed sm:line-clamp-2 sm:text-[11px] ${isLightRed ? 'text-stone-500' : 'text-zinc-500'}`}>
            {card.support}
          </p>
        )}
      </div>

      <div
        className={`mt-2.5 flex shrink-0 flex-col gap-2.5 border-t pt-2.5 sm:mt-3 sm:flex-row sm:items-end sm:justify-between sm:gap-3 sm:pt-3 ${featured ? (isLightRed ? 'border-red-200/70' : 'border-cyan-400/12') : (isLightRed ? 'border-stone-200/80' : 'border-white/10')}`}
      >
        <div className="min-w-0 flex-1">
          <p
            className={`text-[9px] font-semibold uppercase tracking-[0.16em] sm:text-[10px] ${featured ? (isLightRed ? 'text-red-700' : 'text-cyan-200/70') : (isLightRed ? 'text-stone-500' : 'text-zinc-500')}`}
          >
            {card.pricePrefix}
          </p>
          <p
            className={
              featured
                ? `mt-0.5 break-words text-xl font-black tabular-nums leading-none sm:text-[1.35rem] ${isLightRed ? 'text-red-700' : 'text-cyan-200'}`
                : `mt-0.5 break-words text-[15px] font-black tabular-nums leading-tight sm:text-base ${isLightRed ? 'text-red-700' : 'text-cyan-300'}`
            }
          >
            {fmt(card.displayPrice)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onAdd(card.item)}
          className={
            featured
              ? isLightRed
                ? 'inline-flex min-h-[44px] w-full shrink-0 items-center justify-center rounded-xl bg-red-600 px-3.5 py-2.5 text-[11px] font-black text-white shadow-[0_8px_20px_rgba(220,38,38,0.18)] transition-colors hover:bg-red-700 sm:min-h-[42px] sm:w-auto sm:min-w-[6.75rem] sm:text-xs'
                : 'inline-flex min-h-[44px] w-full shrink-0 items-center justify-center rounded-xl bg-cyan-300 px-3.5 py-2.5 text-[11px] font-black text-zinc-950 shadow-[0_8px_20px_rgba(34,211,238,0.12)] transition-colors hover:bg-cyan-200 sm:min-h-[42px] sm:w-auto sm:min-w-[6.75rem] sm:text-xs'
              : isLightRed
                ? 'inline-flex min-h-[44px] w-full shrink-0 items-center justify-center rounded-xl bg-red-600 px-3 py-2.5 text-[11px] font-black text-white transition-colors hover:bg-red-700 sm:min-h-[42px] sm:w-auto sm:min-w-[6.5rem]'
                : 'inline-flex min-h-[44px] w-full shrink-0 items-center justify-center rounded-xl bg-white px-3 py-2.5 text-[11px] font-black text-zinc-950 transition-colors hover:bg-cyan-300 sm:min-h-[42px] sm:w-auto sm:min-w-[6.5rem]'
          }
        >
          {card.cta}
        </button>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// SACOLA EM MODAL
// ═══════════════════════════════════════════════════════════════════════════════
function SacolaConteudo({ slug, cliToken, cart, config, tipoAtendimento, suggestions, loadingSuggestions, showSuggestions, suggestionsReady, suggestionsPending, suggestionsTimedOut, onAdd, onAddSuggestion, onRemove, onContinuarComprando }: {
  slug: string;
  cliToken: string | null;
  cart: CartItem[]; config: Config;
  tipoAtendimento: TipoAtendimento | null;
  suggestions: SuggestionItem[];
  loadingSuggestions: boolean;
  showSuggestions: boolean;
  suggestionsReady: boolean;
  suggestionsPending: boolean;
  suggestionsTimedOut: boolean;
  onAdd: (p: CartItem)=>void; onRemove: (key: string)=>void;
  onAddSuggestion: (item: SuggestionItem)=>void;
  onContinuarComprando: ()=>void;
}) {
  const cardTh = useDeliveryCardapioTheme();
  const sb = cardTh.sacola;
  const isLightRed = cardTh.mode === 'light_red';
  const sub=cart.reduce((a,i)=>a+i.preco_final*i.qty,0);
  const pedidoMinimoAplicavel = tipoAtendimento === 'entrega' ? Number(config.pedido_minimo || 0) : 0;
  const [resumoCheckout, setResumoCheckout] = useState<CheckoutResumo | null>(null);
  const [carregandoResumo, setCarregandoResumo] = useState(false);
  const resumoReqRef = useRef(0);

  const descontoPixPercentual = Number(config.desconto_pix || 0);
  const resumoFallback = useMemo(() => createFallbackCheckoutResumo({
    config,
    subtotal: sub,
    pagamentoTipo: 'pix',
    taxaEntrega: tipoAtendimento === 'entrega' ? Number(config.taxa_entrega || 0) : 0,
    mensagemPrimeiroCliente: tipoAtendimento ? 'Validando beneficios e total estimado do carrinho...' : 'Escolha entrega ou retirada no checkout para ver o total final.',
  }), [config, sub, tipoAtendimento]);
  const resumoAtual = resumoCheckout || resumoFallback;
  const mensagemResumo = carregandoResumo
    ? 'Atualizando beneficios do carrinho...'
    : (tipoAtendimento == null
      ? 'Entrega ou retirada sera escolhida no checkout.'
      : tipoAtendimento === 'retirada'
      ? 'Retirada no local sem taxa de entrega.'
      : (config.zonas_entrega?.length
      ? 'Taxa e total finais sao confirmados no checkout apos escolher o endereco.'
      : (descontoPixPercentual > 0 ? 'Preview com Pix, que ja vem selecionado no checkout.' : null)));

  useEffect(() => {
    if (!slug || cart.length === 0 || !tipoAtendimento) {
      setResumoCheckout(null);
      return;
    }

    const requestId = ++resumoReqRef.current;
    setCarregandoResumo(true);

    fetch(`/public/delivery/${slug}/pedido/resumo`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({
        items: cart.map(i=>({ product_id:i.id, quantity:i.qty, price_at_time:i.preco_final, name:i.name, obs_opcoes:i.obs_opcoes||'', variation_id:i.variation_id ?? null, selecoes: i.selecoes || undefined })),
        pagamento_tipo: 'pix',
        clienteToken: cliToken || undefined,
        canal: tipoAtendimento === 'retirada' ? 'retirada' : 'delivery',
      }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (requestId !== resumoReqRef.current) return;
        if (d?.success && d.resumo) {
          setResumoCheckout(d.resumo as CheckoutResumo);
        } else {
          setResumoCheckout(null);
        }
      })
      .catch(() => {
        if (requestId === resumoReqRef.current) setResumoCheckout(null);
      })
      .finally(() => {
        if (requestId === resumoReqRef.current) setCarregandoResumo(false);
      });
  }, [slug, cliToken, cart, tipoAtendimento]);

  const suggestionCards = useMemo(() => (
    suggestions
      .map((item, index) => ({ item, originalIndex: index }))
      .sort((a, b) => scoreSuggestionForUpsell(b.item, b.originalIndex, cart) - scoreSuggestionForUpsell(a.item, a.originalIndex, cart))
      .slice(0, 3)
      .map(({ item }, index) => {
        const sourceItem = getSuggestionSourceCartItem(cart, item);
        return {
          item,
          featured: index === 0,
          sourceItem,
          badge: getSuggestionBadgeText(item, sourceItem, index === 0),
          headline: getSuggestionHeadline(item, sourceItem),
          support: getSuggestionSupportText(item),
          cta: getSuggestionCtaText(item, index === 0),
          pricePrefix: getSuggestionPricePrefix(item),
          displayPrice: getSuggestionDisplayPrice(item),
          variationCount: getSuggestionVariationCount(item),
        };
      })
  ), [suggestions, cart]);

  const featuredSuggestion = suggestionCards[0] || null;
  const showSuggestionSkeleton = showSuggestions && suggestionsPending && loadingSuggestions && !suggestionsTimedOut;
  const suggestionSubtitle = featuredSuggestion
    ? featuredSuggestion.sourceItem
      ? `Para acompanhar ${shortenSuggestionSourceName(featuredSuggestion.sourceItem.name, 34)}.`
      : 'Sugestoes que combinam com seu pedido.'
    : 'Leve mais um item sem pesar na sacola.';

  const handleSuggestionAdd = useCallback((item: SuggestionItem) => {
    const sourceProductId = Number(item?.source_product_id);
    const suggestedProductId = Number(item?.id);
    if (
      Number.isInteger(sourceProductId) &&
      sourceProductId > 0 &&
      Number.isInteger(suggestedProductId) &&
      suggestedProductId > 0
    ) {
      void fetch(
        `/api/products/suggestions/event?slug=${encodeURIComponent(slug)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceProductId, suggestedProductId }),
        }
      ).catch(() => {});
    }
    onAddSuggestion(item);
  }, [slug, onAddSuggestion]);

  return (
    <div className="space-y-3">
            {cart.length===0 ? (
              <div
                className={
                  isLightRed
                    ? 'rounded-[24px] border border-dashed border-stone-500/45 bg-[#faf6f0] px-5 py-12 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] ring-1 ring-stone-400/20'
                    : 'rounded-[24px] border border-dashed border-white/10 bg-zinc-900/70 px-5 py-12 text-center text-zinc-500'
                }
              >
                <ShoppingCart size={44} className={`mx-auto mb-3 ${isLightRed ? 'text-red-300/90' : 'opacity-20'}`}/>
                <p className={`text-base font-black ${isLightRed ? 'text-stone-900' : 'text-white'}`}>Sua sacola ainda esta vazia</p>
                <p className={`mx-auto mt-2 max-w-md text-sm leading-relaxed ${isLightRed ? 'text-stone-600' : 'text-zinc-200'}`}>Volte ao cardapio para descobrir ofertas e montar seu pedido.</p>
                <button
                  type="button"
                  onClick={onContinuarComprando}
                  className={
                    isLightRed
                      ? 'mt-5 rounded-2xl border border-stone-500/50 bg-[#fffefc] px-5 py-3 text-sm font-bold text-stone-800 shadow-sm transition-colors hover:border-red-300/60 hover:bg-red-50/80'
                      : 'mt-5 rounded-2xl border border-white/10 bg-white/5 px-5 py-3 text-sm font-bold text-zinc-200 transition-colors hover:bg-white/10'
                  }
                >
                  Continuar comprando
                </button>
              </div>
            ) : cart.map((item) => {
              const rowFoto = normalizeProductPhotoPublicUrl(item.photo_url);
              return (
              <div
                key={item.cart_key}
                className={
                  isLightRed
                    ? 'flex items-start gap-4 rounded-[30px] border border-stone-500/40 bg-[#f3efe8] p-4 shadow-sm ring-1 ring-stone-400/15'
                    : 'flex items-start gap-4 rounded-[30px] border border-white/10 bg-zinc-900 p-4 shadow-[0_18px_50px_rgba(0,0,0,0.22)]'
                }
              >
                {rowFoto ? (
                  <FlowProductImage src={rowFoto} alt={item.name} className="h-20 w-20 rounded-2xl object-cover shrink-0"/>
                ) : (
                  <div className={`flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl ${isLightRed ? 'bg-stone-300/80 text-stone-600' : 'bg-zinc-800 text-zinc-500'}`}><Package size={20}/></div>
                )}
                <div className="flex-1 min-w-0">
                  <p className={`text-base font-bold ${isLightRed ? 'text-stone-900' : 'text-white'}`}>{item.name}</p>
                  {item.obs_opcoes && <p className={`mt-1 text-[11px] ${isLightRed ? 'text-stone-600' : 'text-zinc-300'}`}>{item.obs_opcoes}</p>}
                  {isPromocaoProdutoValida(item) && (
                    <p className={`mt-2 text-[11px] line-through ${isLightRed ? 'text-stone-500' : 'text-zinc-400/80'}`}>{fmt(Number(item.preco_original || 0) * item.qty)}</p>
                  )}
                  <p className={`mt-1 text-lg font-black ${isPromocaoProdutoValida(item) ? (isLightRed ? 'text-emerald-600' : 'text-emerald-300 drop-shadow-[0_0_14px_rgba(52,211,153,0.2)]') : (isLightRed ? 'text-red-700' : 'text-cyan-300')}`}>{fmt(item.preco_final*item.qty)}</p>
                  {(item.preco_final!==item.price || isPromocaoProdutoValida(item)) && <p className={`text-xs ${isLightRed ? 'text-stone-600' : 'text-zinc-300'}`}>{fmt(item.preco_final)} un.</p>}
                </div>
                <div className={`flex shrink-0 items-center gap-2 rounded-2xl border p-1 ${isLightRed ? 'border-stone-400/50 bg-[#ebe6df]' : 'border-white/10 bg-zinc-950'}`}>
                <button onClick={()=>onRemove(item.cart_key)} className={`flex h-11 w-11 items-center justify-center rounded-xl transition-colors hover:text-rose-400 sm:h-10 sm:w-10 ${isLightRed ? 'bg-[#fffefc] text-stone-700 shadow-sm' : 'bg-zinc-800 text-zinc-200'}`}><Minus size={13}/></button>
                  <span className={`w-7 text-center text-sm font-black ${isLightRed ? 'text-stone-900' : 'text-white'}`}>{item.qty}</span>
                <button onClick={()=>onAdd({...item,qty:1})} className={`flex h-11 w-11 items-center justify-center rounded-xl transition-colors sm:h-10 sm:w-10 ${isLightRed ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-cyan-400 text-zinc-950 hover:bg-cyan-300'}`}><Plus size={13}/></button>
                </div>
              </div>
              );
            })}

            {showSuggestions && (
              <div
                id="sacola-upsell"
                className={
                  isLightRed
                    ? 'scroll-mt-4 space-y-3 rounded-[24px] border border-stone-500/40 bg-[#faf6f0] p-3.5 shadow-sm ring-1 ring-stone-400/15 sm:space-y-4 sm:rounded-[28px] sm:p-5'
                    : 'scroll-mt-4 space-y-3 rounded-[24px] border border-white/10 bg-zinc-900 p-3.5 shadow-[0_14px_40px_rgba(0,0,0,0.2)] sm:space-y-4 sm:rounded-[28px] sm:p-5'
                }
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.2em] ${isLightRed ? 'border border-red-200 bg-red-50 text-red-700' : 'border border-cyan-400/20 bg-cyan-400/10 text-cyan-200'}`}>
                      Sugestoes
                    </span>
                    <p className={`mt-2 text-xl font-black tracking-tight sm:text-[1.35rem] ${isLightRed ? 'text-stone-900' : 'text-white'}`}>Leve junto</p>
                    <p className={`mt-1 max-w-[26rem] text-xs leading-relaxed sm:text-[13px] ${isLightRed ? 'text-stone-600' : 'text-zinc-300'}`}>
                      {showSuggestionSkeleton ? 'Buscando itens que combinam com o que voce ja escolheu.' : suggestionSubtitle}
                    </p>
                  </div>
                  <span className={`shrink-0 self-start rounded-full px-3 py-1.5 text-[11px] font-bold sm:self-auto ${isLightRed ? 'border border-stone-300 bg-[#fffefc] text-stone-700' : 'border border-white/10 bg-zinc-950 text-zinc-200'}`}>
                    {showSuggestionSkeleton ? 'Carregando' : suggestionCards.length > 0 ? `${suggestionCards.length} opcoes` : 'Sem sugestoes'}
                  </span>
                </div>

                {suggestionsTimedOut && suggestionsPending && !suggestionsReady && (
                  <div
                    role="status"
                    className={
                      isLightRed
                        ? 'rounded-2xl border border-amber-200/90 bg-amber-50/90 px-3 py-2.5 text-center text-xs font-semibold text-amber-950'
                        : 'rounded-2xl border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-center text-xs font-semibold text-amber-100'
                    }
                  >
                    As sugestoes estao demorando. Voce ja pode finalizar o pedido abaixo; quando carregarem, elas aparecem aqui.
                  </div>
                )}

                {showSuggestionSkeleton && (
                  <div className="flex min-h-[160px] flex-col gap-3 sm:gap-3.5 motion-reduce:animate-none" aria-busy="true" aria-live="polite">
                    <div
                      className={`rounded-[20px] border p-3 opacity-75 motion-reduce:opacity-100 sm:p-3.5 ${isLightRed ? 'border-red-200/80 bg-[#fffefc] ring-1 ring-red-100/80' : 'border-cyan-400/20 bg-zinc-950 ring-1 ring-cyan-400/15'}`}
                    >
                      <div className={`aspect-[4/3] w-full rounded-[14px] animate-pulse motion-reduce:animate-none sm:rounded-[16px] ${isLightRed ? 'bg-stone-200/90' : 'bg-white/[0.08]'}`} />
                      <div className={`mt-2 flex gap-2`}>
                        <div className={`h-4 w-24 rounded-full animate-pulse motion-reduce:animate-none ${isLightRed ? 'bg-stone-200/80' : 'bg-white/[0.07]'}`} />
                        <div className={`h-4 w-20 rounded-full animate-pulse motion-reduce:animate-none ${isLightRed ? 'bg-stone-200/70' : 'bg-white/[0.06]'}`} />
                      </div>
                      <div className={`mt-2 h-4 w-[90%] rounded-lg animate-pulse motion-reduce:animate-none ${isLightRed ? 'bg-stone-300/70' : 'bg-white/[0.08]'}`} />
                      <div className={`mt-2 flex flex-col gap-2.5 border-t pt-2.5 sm:flex-row sm:items-end sm:justify-between ${isLightRed ? 'border-stone-200/60' : 'border-white/10'}`}>
                        <div className="space-y-1.5">
                          <div className={`h-2.5 w-14 rounded-full animate-pulse motion-reduce:animate-none ${isLightRed ? 'bg-stone-200/80' : 'bg-white/[0.06]'}`} />
                          <div className={`h-6 w-24 rounded-md animate-pulse motion-reduce:animate-none ${isLightRed ? 'bg-stone-300/80' : 'bg-white/[0.08]'}`} />
                        </div>
                        <div className={`h-10 w-full rounded-xl animate-pulse motion-reduce:animate-none sm:h-[42px] sm:w-[6.75rem] ${isLightRed ? 'bg-stone-300/80' : 'bg-white/[0.09]'}`} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:items-stretch sm:gap-3.5">
                      {[0, 1].map((index) => (
                        <div
                          key={`suggestion-skeleton-compact-${index}`}
                          className={`flex min-h-[200px] flex-col rounded-[18px] border p-3 opacity-70 motion-reduce:opacity-100 sm:min-h-[208px] sm:rounded-[20px] sm:p-3.5 ${isLightRed ? 'border-stone-300/70 bg-[#fffefc]' : 'border-white/10 bg-zinc-950'}`}
                        >
                          <div className={`aspect-[4/3] w-full rounded-[14px] animate-pulse motion-reduce:animate-none sm:rounded-[16px] ${isLightRed ? 'bg-stone-200/90' : 'bg-white/[0.08]'}`} />
                          <div className={`mt-2 h-3 w-14 rounded-full animate-pulse motion-reduce:animate-none ${isLightRed ? 'bg-stone-200/80' : 'bg-white/[0.06]'}`} />
                          <div className={`mt-2 h-9 w-full rounded-lg animate-pulse motion-reduce:animate-none ${isLightRed ? 'bg-stone-300/70' : 'bg-white/[0.07]'}`} />
                          <div className={`mt-auto flex flex-col gap-2 border-t pt-2.5 ${isLightRed ? 'border-stone-200/60' : 'border-white/10'}`}>
                            <div className={`h-5 w-20 rounded-md animate-pulse motion-reduce:animate-none ${isLightRed ? 'bg-stone-300/80' : 'bg-white/[0.08]'}`} />
                            <div className={`h-10 w-full rounded-xl animate-pulse motion-reduce:animate-none ${isLightRed ? 'bg-stone-300/80' : 'bg-white/[0.09]'}`} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {!showSuggestionSkeleton && suggestionCards.length > 0 && (
                  <div
                    className={
                      suggestionCards.length === 1
                        ? 'grid grid-cols-1 gap-3 sm:gap-3.5'
                        : 'grid grid-cols-2 gap-3 sm:items-stretch sm:gap-3.5'
                    }
                  >
                    {suggestionCards.map((card) => (
                      <Fragment key={card.item.id}>
                        <SacolaUpsellCard card={card} isLightRed={isLightRed} onAdd={handleSuggestionAdd} />
                      </Fragment>
                    ))}
                  </div>
                )}

                {!showSuggestionSkeleton && suggestionCards.length === 0 && (
                  <div className={`rounded-[24px] border border-dashed p-4 text-center sm:p-5 ${isLightRed ? 'border-stone-300/80 bg-[#fffefc] text-stone-600' : 'border-white/10 bg-zinc-950 text-zinc-300'}`}>
                    <p className={`text-sm font-bold ${isLightRed ? 'text-stone-800' : 'text-white'}`}>Ainda nao encontramos uma sugestao ideal para esta sacola.</p>
                    <p className="mt-1 text-xs leading-relaxed sm:text-[13px]">Voce pode seguir normalmente para o checkout assim mesmo.</p>
                  </div>
                )}
              </div>
            )}
      {cart.length > 0 && (
        <div className={sb.resumoBox}>
          <div className="flex items-center justify-between gap-2">
            <p className={sb.resumoLabel}>Resumo</p>
            <span className={sb.resumoBadge}>{cart.reduce((a,i)=>a+i.qty,0)} itens</span>
          </div>
          <ResumoComercialLinhas
            resumo={resumoAtual}
            descontoPixPercentual={descontoPixPercentual}
            tipoAtendimento={tipoAtendimento}
            mensagemAuxiliar={mensagemResumo}
            temZonasEntrega={(config.zonas_entrega || []).length > 0}
          />
          <p className={`text-center text-xs ${cardTh.mode === 'light_red' ? 'text-stone-600' : 'text-zinc-400'}`}>Subtotal da sacola. Taxa e total final dependem da entrega e do pagamento no checkout.</p>
        </div>
      )}
    </div>
  );
}

function SacolaModal({ open, onClose, onContinuarCheckout, slug, cliToken, cart, config, tipoAtendimento, suggestions, loadingSuggestions, showSuggestions, suggestionsReady, suggestionsPending, suggestionRequestKey, onAdd, onAddSuggestion, onRemove, aceitaPedidos = true }: {
  open: boolean;
  onClose: () => void;
  onContinuarCheckout: () => void;
  slug: string;
  cliToken: string | null;
  cart: CartItem[];
  config: Config;
  tipoAtendimento: TipoAtendimento | null;
  suggestions: SuggestionItem[];
  loadingSuggestions: boolean;
  showSuggestions: boolean;
  suggestionsReady: boolean;
  suggestionsPending: boolean;
  suggestionRequestKey: string;
  onAdd: (p: CartItem) => void;
  onAddSuggestion: (item: SuggestionItem) => void;
  onRemove: (key: string) => void;
  /** Quando false, a sacola abre mas não segue para o checkout (loja fechada / fora do horário). */
  aceitaPedidos?: boolean;
}) {
  const sub = cart.reduce((a, i) => a + i.preco_final * i.qty, 0);
  const pedidoMinimoAplicavel = tipoAtendimento === 'entrega' ? Number(config.pedido_minimo || 0) : 0;
  const th = useDeliveryCardapioTheme();
  const sb = th.sacola;
  const [suggestionsTimedOut, setSuggestionsTimedOut] = useState(false);

  useEffect(() => {
    if (!open) {
      setSuggestionsTimedOut(false);
      return;
    }
    if (!showSuggestions || !suggestionsPending || suggestionsReady) {
      setSuggestionsTimedOut(false);
      return;
    }
    setSuggestionsTimedOut(false);
    const timeoutId = window.setTimeout(() => {
      setSuggestionsTimedOut(true);
    }, SUGGESTIONS_CHECKOUT_FAILSAFE_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [open, showSuggestions, suggestionsPending, suggestionsReady, suggestionRequestKey]);

  const checkoutLockedBySuggestions = showSuggestions && suggestionsPending && !suggestionsReady && !suggestionsTimedOut;
  const footerHint = checkoutLockedBySuggestions
    ? 'Carregando sugestoes para voce ver antes de finalizar.'
    : showSuggestions && suggestionsPending && !suggestionsReady && suggestionsTimedOut
      ? 'As sugestoes demoraram. Voce pode seguir para o checkout abaixo.'
      : null;
  const handleContinuarCheckout = useCallback(() => {
    if (checkoutLockedBySuggestions || !aceitaPedidos) return;
    onContinuarCheckout();
  }, [aceitaPedidos, checkoutLockedBySuggestions, onContinuarCheckout]);

  if (!open) return null;
  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sacola-modal-title"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[65] flex items-end justify-center sm:items-center sm:p-4"
    >
      <div className={sb.overlay} onClick={onClose} aria-hidden />
      <motion.div
        initial={{ y: 28, opacity: 0.97 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 36, opacity: 0 }}
        transition={{ type: 'spring', damping: 28, stiffness: 380 }}
        className={sb.panel}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={sb.headerRow}>
          <div className="min-w-0">
            <h2 id="sacola-modal-title" className={sb.title}>
              Sua sacola
            </h2>
            <p className={sb.subtitle}>
              {cart.reduce((a, i) => a + i.qty, 0)} {cart.reduce((a, i) => a + i.qty, 0) === 1 ? 'item' : 'itens'} · {fmt(sub)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={sb.closeBtn}
            aria-label="Fechar sacola"
          >
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2.5 sm:px-5 sm:py-3">
          <SacolaConteudo
            slug={slug}
            cliToken={cliToken}
            cart={cart}
            config={config}
            tipoAtendimento={tipoAtendimento}
            suggestions={suggestions}
            loadingSuggestions={loadingSuggestions}
            showSuggestions={showSuggestions}
            suggestionsReady={suggestionsReady}
            suggestionsPending={suggestionsPending}
            suggestionsTimedOut={suggestionsTimedOut}
            onAdd={onAdd}
            onAddSuggestion={onAddSuggestion}
            onRemove={onRemove}
            onContinuarComprando={() => {
              onClose();
            }}
          />
        </div>
        {cart.length > 0 && (
          <div className={sb.footer}>
            {sub < pedidoMinimoAplicavel && (
              <p
                className={
                  th.mode === 'light_red'
                    ? 'mb-3 rounded-xl border border-amber-200 bg-amber-50 py-2 text-center text-xs font-bold text-amber-900'
                    : 'mb-3 rounded-xl border border-amber-500/20 bg-amber-500/10 py-2 text-center text-xs font-bold text-amber-200'
                }
              >
                Pedido mínimo: {fmt(pedidoMinimoAplicavel)}
              </p>
            )}
            {footerHint ? (
              <p
                className={
                  th.mode === 'light_red'
                    ? 'mb-3 rounded-xl border border-stone-300 bg-[#fff8ef] px-3 py-2 text-center text-xs font-semibold text-stone-700'
                    : 'mb-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-center text-xs font-semibold text-zinc-200'
                }
              >
                {footerHint}
              </p>
            ) : null}
            {!aceitaPedidos ? (
              <p
                className={
                  th.mode === 'light_red'
                    ? 'mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-center text-xs font-bold text-rose-900'
                    : 'mb-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-center text-xs font-bold text-rose-100'
                }
              >
                A loja nao esta aceitando pedidos agora. Volte quando estiver aberta.
              </p>
            ) : null}
            <button
              type="button"
              onClick={handleContinuarCheckout}
              disabled={sub < pedidoMinimoAplicavel || checkoutLockedBySuggestions || !aceitaPedidos}
              className={sb.primaryBtn}
            >
              {checkoutLockedBySuggestions ? 'Carregando sugestoes...' : 'Continuar para finalizar'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className={sb.secondaryBtn}
            >
              Voltar ao cardápio
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

// ── Injeta valor em payload Pix estático (QR do banco, campo aberto) ──────────
function injetarValorPix(payload: string, valor: number): string {
  try {
    const campos: {id:string;len:number;val:string;raw:string}[] = [];
    let pos = 0;
    const semCrc = payload.slice(0, -8); // remove '6304XXXX'
    while (pos < semCrc.length) {
      const id = semCrc.slice(pos, pos+2);
      const len = parseInt(semCrc.slice(pos+2, pos+4));
      const val = semCrc.slice(pos+4, pos+4+len);
      campos.push({ id, len, val, raw: semCrc.slice(pos, pos+4+len) });
      pos += 4 + len;
    }
    const sem54 = campos.filter(c => c.id !== '54');
    const v = valor.toFixed(2);
    const campo54 = { id:'54', len: v.length, val: v, raw: '54' + String(v.length).padStart(2,'0') + v };
    const idx53 = sem54.findIndex(c => c.id === '53');
    sem54.splice(idx53 + 1, 0, campo54);
    const base = sem54.map(c => c.raw).join('') + '6304';
    let crc = 0xFFFF;
    for (let i=0; i<base.length; i++) { crc ^= base.charCodeAt(i)<<8; for(let j=0;j<8;j++) crc=(crc&0x8000)?(crc<<1)^0x1021:(crc<<1); }
    return base + (crc & 0xFFFF).toString(16).toUpperCase().padStart(4,'0');
  } catch { return payload; }
}

// ── Gerador de payload Pix Copia e Cola (BR Code EMV — padrão Banco Central) ──
function gerarPixPayload(chave: string, nome: string, cidade: string, valor: number): string {
  const v = valor.toFixed(2);
  const emv = (id: string, val: string) => { const len = String(val.length).padStart(2,'0'); return `${id}${len}${val}`; };
  const gui = emv('00','BR.GOV.BCB.PIX') + emv('01', chave);
  const merchantInfo = emv('26', gui);
  const addInfo = emv('62', emv('05','FlowDelivery'));
  const nomeClean = nome.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z0-9 ]/g,'').substring(0,25).toUpperCase();
  const cidadeClean = cidade.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z0-9 ]/g,'').substring(0,15).toUpperCase() || 'BRASIL';
  let payload = '000201'+'010212'+merchantInfo+'52040000'+'5303986'+emv('54',v)+'5802BR'+emv('59',nomeClean)+emv('60',cidadeClean)+addInfo+'6304';
  let crc = 0xFFFF;
  for (let i=0;i<payload.length;i++){ crc^=payload.charCodeAt(i)<<8; for(let j=0;j<8;j++) crc=(crc&0x8000)?(crc<<1)^0x1021:(crc<<1); }
  return payload + (crc&0xFFFF).toString(16).toUpperCase().padStart(4,'0');
}

const BANCOS_DEEPLINK = [
  { nome:'Nubank',    cor:'#820AD1', logo:'💜', link:(payload:string)=>`nubank://pix/copy-paste?payload=${encodeURIComponent(payload)}` },
  { nome:'Inter',     cor:'#FF7A00', logo:'🟠', link:(payload:string)=>`bancointer://pix?payload=${encodeURIComponent(payload)}` },
  { nome:'C6 Bank',   cor:'#1A1A1A', logo:'⬛', link:(payload:string)=>`c6bank://pix?copiaecola=${encodeURIComponent(payload)}` },
  { nome:'Bradesco',  cor:'#CC0000', logo:'🔴', link:(payload:string)=>`bradesco://pix?payload=${encodeURIComponent(payload)}` },
  { nome:'Itaú',      cor:'#EC7000', logo:'🟧', link:(payload:string)=>`itau://pix?payload=${encodeURIComponent(payload)}` },
  { nome:'BB',        cor:'#FAAE00', logo:'🟡', link:(payload:string)=>`bb://pix?payload=${encodeURIComponent(payload)}` },
  { nome:'Caixa',     cor:'#005CA9', logo:'🔵', link:(payload:string)=>`caixa://pix?payload=${encodeURIComponent(payload)}` },
  { nome:'Picpay',    cor:'#21C25E', logo:'💚', link:(payload:string)=>`picpay://pix?payload=${encodeURIComponent(payload)}` },
];

function ModalAcompanharPedido({
  open,
  onClose,
  slug,
  pedidoId,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  pedidoId: number;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="acompanhar-pedido-titulo"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/70"
        onClick={onClose}
        aria-label="Fechar acompanhamento"
      />
      <div
        className="relative flex max-h-[min(88dvh,100%)] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-white/10 bg-zinc-950 pb-[env(safe-area-inset-bottom)] shadow-2xl sm:max-h-[85vh] sm:rounded-2xl sm:pb-0"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <p id="acompanhar-pedido-titulo" className="text-sm font-black tracking-tight text-white">
            Acompanhar pedido
          </p>
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl p-2 text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Fechar"
          >
            <X size={20} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <PedidoRastreamento slug={slug} pedidoId={pedidoId} embedded />
        </div>
      </div>
    </div>
  );
}

/** Sucesso após checkout em modal: permanece no cardápio (z acima do checkout z-72). */
function PedidoSucessoModal({
  pedidoOk,
  config,
  slug,
  tipoAtendimento,
  onFechar,
  onNovoPedido,
}: {
  pedidoOk: PedidoConfirmado;
  config: Config;
  slug: string;
  tipoAtendimento: TipoAtendimento | null;
  onFechar: () => void;
  onNovoPedido: () => void;
}) {
  const th = useDeliveryCardapioTheme();
  const cx = th.checkout;
  const sb = th.sacola;
  const isLight = th.mode === 'light_red';
  const [acompanharOpen, setAcompanharOpen] = useState(false);
  const [confirmeiPagamentoPix, setConfirmeiPagamentoPix] = useState(false);
  const isPix = pedidoOk.pagamento_tipo === 'pix';
  const isRetirada = pedidoOk.canal === 'retirada' || tipoAtendimento === 'retirada';
  const pixNoModal = pedidoOk.checkout_modal_concluido === true;
  const tempoMin = config.tempo_preparo || 35;
  const tempoMax = tempoMin + 10;
  const waNumber = (config.whatsapp || '').replace(/\D/g, '');
  const waMsgPixComprovante =
    isPix && waNumber
      ? `https://wa.me/55${waNumber}?text=${encodeURIComponent(
          `🧾 *Comprovante Pix — Pedido #${pedidoOk.orderNumber}*\n\nOlá! Acabei de realizar o pagamento de *${fmt(pedidoOk.total)}* via Pix.\n\n📎 Segue o comprovante em anexo.`,
        )}`
      : null;
  const waMsgEntrega =
    waNumber && !isRetirada
      ? `https://wa.me/55${waNumber}?text=${encodeURIComponent(
          `✅ *Pedido Confirmado #${pedidoOk.orderNumber}*\n\nOlá! Meu pedido foi confirmado. Aguardo a entrega!\n💰 Pagarei *${fmt(pedidoOk.total)}* ${
            pedidoOk.pagamento_tipo === 'dinheiro' ? 'em dinheiro' : 'no cartão'
          } na entrega.`,
        )}`
      : null;
  let statusPagamento = '';
  if (isPix && pixNoModal) statusPagamento = 'Pagamento via Pix registrado neste pedido.';
  else if (isPix) statusPagamento = 'Pagamento via Pix.';
  else if (pedidoOk.pagamento_tipo === 'dinheiro')
    statusPagamento = isRetirada ? 'Pagamento em dinheiro na retirada ou no local.' : 'Pagamento em dinheiro na entrega.';
  else statusPagamento = isRetirada ? 'Pagamento no cartão na retirada ou no local.' : 'Pagamento no cartão na entrega.';

  const pagamentoDestaqueSucesso = isPix && pixNoModal;
  const pagamentoCard = pagamentoDestaqueSucesso
    ? isLight
      ? 'border-emerald-200 bg-emerald-50'
      : 'border-emerald-500/25 bg-emerald-500/10'
    : isLight
      ? 'border-amber-200 bg-amber-50'
      : 'border-amber-500/30 bg-amber-500/10';
  const pagamentoIconBox = pagamentoDestaqueSucesso
    ? isLight
      ? 'bg-emerald-600 text-white'
      : 'bg-emerald-500 text-zinc-950'
    : isLight
      ? 'bg-amber-600 text-white'
      : 'bg-amber-500 text-zinc-950';
  const pagamentoTitulo = pagamentoDestaqueSucesso
    ? isLight
      ? 'text-emerald-900'
      : 'text-emerald-100'
    : isLight
      ? 'text-amber-900'
      : 'text-amber-100';
  const pagamentoTexto = pagamentoDestaqueSucesso
    ? isLight
      ? 'text-emerald-800'
      : 'text-emerald-200/90'
    : isLight
      ? 'text-amber-900'
      : 'text-amber-100/90';

  return (
    <>
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pedido-sucesso-title"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[75] flex items-end justify-center sm:items-center sm:p-4"
    >
      <div className={sb.overlay} onClick={onFechar} aria-hidden />
      <motion.div
        initial={{ y: 28, opacity: 0.97 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 36, opacity: 0 }}
        transition={{ type: 'spring', damping: 28, stiffness: 380 }}
        className={cx.panel}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`${cx.header} shrink-0`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p
                className={`text-[11px] font-bold uppercase tracking-[0.22em] ${isLight ? 'text-zinc-500' : 'text-zinc-400'}`}
              >
                Tudo certo
              </p>
              <h2 id="pedido-sucesso-title" className={cx.title}>
                Pedido confirmado
              </h2>
              <p className={cx.subtitle}>Seu pedido foi registrado com sucesso.</p>
            </div>
            <button type="button" onClick={onFechar} className={cx.closeBtn} aria-label="Fechar">
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain space-y-3 px-3 py-3 sm:space-y-4 sm:px-5 sm:py-4">
          <div
            className={`rounded-[22px] border p-4 shadow-sm ${
              isLight
                ? 'border-red-200/90 bg-gradient-to-br from-red-50 via-white to-zinc-50 ring-1 ring-red-100/60'
                : 'border-white/12 bg-gradient-to-br from-zinc-800/90 to-zinc-950 ring-1 ring-white/[0.06]'
            }`}
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p
                  className={`text-[11px] font-bold uppercase tracking-[0.2em] ${isLight ? 'text-red-800/80' : 'text-zinc-400'}`}
                >
                  Número do pedido
                </p>
                <p
                  className={`mt-1 text-2xl font-black tabular-nums tracking-tight ${
                    isLight ? 'text-black' : 'text-zinc-50 drop-shadow-[0_1px_2px_rgba(0,0,0,0.75)]'
                  }`}
                >
                  #{pedidoOk.orderNumber}
                </p>
              </div>
              <div className="sm:text-right">
                <p
                  className={`text-[11px] font-bold uppercase tracking-[0.2em] ${isLight ? 'text-zinc-500' : 'text-zinc-400'}`}
                >
                  Total
                </p>
                <p
                  className={`mt-1 text-3xl font-black tabular-nums leading-none tracking-tight ${isLight ? 'text-red-800' : 'text-cyan-300'}`}
                >
                  {fmt(pedidoOk.total)}
                </p>
              </div>
            </div>
          </div>
          <div className={`flex items-center gap-3 rounded-2xl border px-4 py-3 ${pagamentoCard}`}>
            <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${pagamentoIconBox}`}>
              {pagamentoDestaqueSucesso ? <CheckCircle2 size={22} /> : <AlertCircle size={22} />}
            </div>
            <div className="min-w-0">
              <p className={`text-sm font-black ${pagamentoTitulo}`}>Status do pagamento</p>
              <p className={`mt-0.5 text-sm leading-snug ${pagamentoTexto}`}>{statusPagamento}</p>
            </div>
          </div>
          <div className={cx.card}>
            <div className="flex items-center gap-3">
              <div
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                  isLight ? 'bg-amber-100 text-amber-600' : 'bg-amber-500/20 text-amber-200'
                }`}
              >
                <Clock size={20} />
              </div>
              <div>
                <p className={`text-xs ${isLight ? 'text-zinc-500' : 'text-zinc-400'}`}>Tempo estimado de preparo</p>
                <p className={`text-base font-black ${isLight ? 'text-zinc-900' : 'text-white'}`}>
                  {tempoMin}–{tempoMax} min
                </p>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setAcompanharOpen(true)}
            className={`flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-black transition-colors ${
              isLight
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-cyan-500 text-zinc-950 hover:bg-cyan-400'
            }`}
          >
            <Clock size={18} />
            Acompanhar pedido online
          </button>
          {isPix && !pixNoModal && !confirmeiPagamentoPix && (
            <button
              type="button"
              onClick={() => setConfirmeiPagamentoPix(true)}
              className={`flex w-full items-center justify-center gap-2 rounded-2xl border py-3.5 text-sm font-bold transition-colors ${
                isLight
                  ? 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
                  : 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              <CheckCircle2 size={18} />
              Já fiz o pagamento via Pix
            </button>
          )}
          {waMsgPixComprovante && (pixNoModal || confirmeiPagamentoPix) && (
            <a
              href={waMsgPixComprovante}
              target="_blank"
              rel="noreferrer"
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-green-600 py-3.5 text-sm font-bold text-white transition-colors hover:bg-green-500"
            >
              <MessageCircle size={18} />
              Enviar comprovante pelo WhatsApp
            </a>
          )}
          {!pedidoOk.waLink && waMsgEntrega && (
            <a
              href={waMsgEntrega}
              target="_blank"
              rel="noreferrer"
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-green-500/40 bg-green-600/90 py-3.5 text-sm font-bold text-white transition-colors hover:bg-green-500"
            >
              <MessageCircle size={18} />
              Falar no WhatsApp
            </a>
          )}
        </div>
        <div className={`${cx.footerBar} shrink-0`}>
          <button type="button" onClick={onNovoPedido} className={cx.secondaryBtn}>
            Fazer novo pedido
          </button>
        </div>
      </motion.div>
    </motion.div>
    <ModalAcompanharPedido
      open={acompanharOpen}
      onClose={() => setAcompanharOpen(false)}
      slug={slug}
      pedidoId={pedidoOk.orderId}
    />
    </>
  );
}

function TelaCheckout({ slug, cart, config, assistido, cliToken, cliente, tipoAtendimento, onTipoAtendimentoChange, onSuccess, modalUi }: {
  slug:string; cart:CartItem[]; config:Config;
  assistido: boolean;
  cliToken:string|null; cliente:ClienteAuth | null;
  tipoAtendimento: TipoAtendimento | null;
  onTipoAtendimentoChange: (tipo: TipoAtendimento) => void;
  onSuccess:(d: PedidoConfirmado)=>void;
  modalUi: { step: CheckoutStep; onStepChange: (s: CheckoutStep) => void; onClose: () => void };
}) {
  const { step: modalStep, onStepChange: setModalStep, onClose: fecharModalCheckout } = modalUi;

  const [assistTelefone, setAssistTelefone] = useState('');
  const [assistNome, setAssistNome] = useState('');
  const [assistLoading, setAssistLoading] = useState(false);
  const [assistNovoCliente, setAssistNovoCliente] = useState(false);
  const [assistErro, setAssistErro] = useState('');
  const [assistSession, setAssistSession] = useState<null | { token: string; cliente: ClienteAuth }>(null);
  const effectiveCliToken = assistido ? (assistSession?.token || cliToken) : cliToken;
  const effectiveCliente = assistido ? (assistSession?.cliente || cliente) : cliente;
  const [enderecos, setEnderecos] = useState<Endereco[]>([]);
  const [endSel, setEndSel] = useState<number|'novo'|''>('');
  const [novoEndereco, setNovoEndereco] = useState<DeliveryNovoEnderecoForm>(() => emptyDeliveryNovoEnderecoForm(true));
  const [modoRecebimento, setModoRecebimento] = useState<ModoRecebimentoPedido | null>(null);
  const [pag, setPag] = useState('pix');
  const [pixCheckoutCopiado, setPixCheckoutCopiado] = useState(false);
  /** Opcional: quem recebe no endereço (só entrega; vai para observation). */
  const [nomeQuemRecebe, setNomeQuemRecebe] = useState('');
  /** Opcional: contato no local (só entrega; consolidado em observation, sem `contato_recebimento_tel` para evitar duplicar merge no servidor). */
  const [contatoRecebimento, setContatoRecebimento] = useState('');
  /** Observação curta só da entrega (portaria, campainha, etc.). */
  const [obsEntrega, setObsEntrega] = useState('');
  const enderecoEntregaScrollRef = useRef<HTMLDivElement | null>(null);
  const [precisaTroco, setPrecisaTroco] = useState(false);
  const [troco, setTroco] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  // Cupom
  const [cupomInput, setCupomInput] = useState('');
  const [cupomValido, setCupomValido] = useState<any>(null);
  const [cupomErro, setCupomErro] = useState('');
  const [validandoCupom, setValidandoCupom] = useState(false);
  const [resumoCheckout, setResumoCheckout] = useState<CheckoutResumo | null>(null);
  const [carregandoResumo, setCarregandoResumo] = useState(false);
  const resumoReqRef = useRef(0);
  const checkoutTheme = useDeliveryCardapioTheme();
  const cx = checkoutTheme.checkout;
  const isLightCheckout = checkoutTheme.mode === 'light_red';

  const zonas = config.zonas_entrega || [];
  const temZonas = zonas.length > 0;

  // ── Detecta zona pelo bairro (mesma normalização que o servidor: `deliveryBairroZona`) ──
  const detectarZona = (bairro: string): { nome: string; taxa: number } | null => {
    if (!temZonas || !bairro.trim()) return null;
    return findDeliveryZoneByBairro(zonas, bairro);
  };

  // Bairro do endereço atualmente selecionado
  const bairroAtual = endSel === 'novo'
    ? novoEndereco.campos.bairro
    : (() => {
        const e = enderecos.find(x => x.id === endSel);
        return e?.bairro || '';
      })();

  const zonaDetectada = detectarZona(bairroAtual);
  const entregaBloqueadaFallback =
    tipoAtendimento === 'entrega' && temZonas && Boolean(bairroAtual.trim()) && !zonaDetectada;

  // Com zonas cadastradas só há taxa quando o bairro casa com uma zona (sem taxa “padrão” fora da lista).
  const taxaEntregaFallback = tipoAtendimento == null
    ? 0
    : tipoAtendimento === 'retirada'
    ? 0
    : temZonas
      ? (zonaDetectada ? zonaDetectada.taxa : 0)
      : (config.taxa_entrega || 0);
  const sub = cart.reduce((a,i)=>a+i.preco_final*i.qty,0);
  const descontoCupomFallback = cupomValido
    ? cupomValido.cupom.tipo === 'frete_gratis' ? taxaEntregaFallback : cupomValido.desconto
    : 0;
  const resumoAtual = resumoCheckout || createFallbackCheckoutResumo({
    config,
    subtotal: sub,
    pagamentoTipo: pag,
    taxaEntrega: taxaEntregaFallback,
    zonaEntrega: tipoAtendimento === 'entrega' ? zonaDetectada : null,
    bairroEntrega: tipoAtendimento === 'entrega' ? (bairroAtual.trim() || null) : null,
    cupomAplicado: cupomValido?.cupom || null,
    descontoCupom: descontoCupomFallback,
    entregaBloqueadaPorZona: entregaBloqueadaFallback,
  });
  const usandoResumoFallback = !resumoCheckout;
  const descontoPix = resumoAtual.desconto_pix;
  const descontoPrimeiroCliente = resumoAtual.desconto_primeiro_cliente;
  const zonaResumo = resumoAtual.zona_entrega || zonaDetectada;
  const bairroResumo = (resumoAtual.bairro_entrega || bairroAtual || '').trim();
  const tot = resumoAtual.total;
  const descontoPixPercentual = Number(config.desconto_pix || 0);
  const inp = cx.inputBase;
  const assistTelefoneDigits = useMemo(
    () => normalizeBrazilDeliveryPhoneDigits(assistTelefone),
    [assistTelefone]
  );
  const assistTelefoneOk = assistTelefoneDigits.length === 10 || assistTelefoneDigits.length === 11;

  const resetAssistidoCliente = useCallback(() => {
    setAssistErro('');
    setAssistNovoCliente(false);
    setAssistSession(null);
    setAssistNome('');
    setAssistTelefone('');
    setEnderecos([]);
    setEndSel('novo');
    setNovoEndereco(emptyDeliveryNovoEnderecoForm(true));
    setResumoCheckout(null);
  }, []);

  const identificarPorTelefoneAssistido = useCallback(async () => {
    if (!assistido) return;
    if (!slug) return;
    setAssistErro('');
    if (!assistTelefoneOk) {
      setAssistErro('Telefone: use DDD + telefone (10 ou 11 dígitos).');
      return;
    }
    if (assistLoading) return;
    setAssistLoading(true);
    try {
      const r = await fetch(`/public/delivery/${slug}/auth/identificar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telefone: assistTelefoneDigits }),
      });
      const d = await r.json();
      if (d?.success && d?.novo === false && d?.token && d?.cliente) {
        const c = d.cliente as ClienteAuth;
        setAssistSession({
          token: String(d.token),
          cliente: {
            id: Number(c.id),
            nome: String(c.nome || '').trim(),
            telefone: String(c.telefone || '').trim(),
            email: c.email ? String(c.email) : undefined,
            favoritos: Array.isArray((c as any).favoritos) ? (c as any).favoritos : [],
          },
        });
        setAssistNovoCliente(false);
        setAssistNome(String(c.nome || ''));
        return;
      }
      if (d?.success && d?.novo === true) {
        setAssistNovoCliente(true);
        setAssistSession(null);
        if (!assistNome.trim()) setAssistNome('');
        return;
      }
      setAssistErro(d?.error || 'Não foi possível identificar o cliente.');
    } catch {
      setAssistErro('Erro de conexão ao buscar cliente.');
    } finally {
      setAssistLoading(false);
    }
  }, [
    assistido,
    slug,
    assistTelefoneOk,
    assistTelefoneDigits,
    assistLoading,
    assistNome,
  ]);

  const cadastrarRapidoAssistido = useCallback(async () => {
    if (!assistido) return;
    if (!slug) return;
    setAssistErro('');
    if (!assistTelefoneOk) {
      setAssistErro('Telefone: use DDD + telefone (10 ou 11 dígitos).');
      return;
    }
    const nomeTrim = assistNome.trim();
    if (!nomeTrim) {
      setAssistErro('Informe o nome do cliente.');
      return;
    }
    if (assistLoading) return;
    setAssistLoading(true);
    try {
      const r = await fetch(`/public/delivery/${slug}/auth/cadastrar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telefone: assistTelefoneDigits, nome: nomeTrim }),
      });
      const d = await r.json();
      if (d?.success && d?.token && d?.cliente) {
        const c = d.cliente as ClienteAuth;
        setAssistSession({
          token: String(d.token),
          cliente: {
            id: Number(c.id),
            nome: String(c.nome || '').trim(),
            telefone: String(c.telefone || '').trim(),
            email: c.email ? String(c.email) : undefined,
            favoritos: Array.isArray((c as any).favoritos) ? (c as any).favoritos : [],
          },
        });
        setAssistNovoCliente(false);
        return;
      }
      setAssistErro(d?.error || 'Não foi possível cadastrar o cliente.');
    } catch {
      setAssistErro('Erro de conexão ao cadastrar cliente.');
    } finally {
      setAssistLoading(false);
    }
  }, [
    assistido,
    slug,
    assistTelefoneOk,
    assistTelefoneDigits,
    assistLoading,
    assistNome,
  ]);

  const temPixCheckoutCfg = !!(config.pix_chave || config.pix_payload_estatico);
  const pixPayloadCheckout = useMemo(() => {
    if (pag !== 'pix' || !temPixCheckoutCfg) return '';
    try {
      if (config.pix_payload_estatico) return injetarValorPix(config.pix_payload_estatico, tot);
      if (config.pix_chave) {
        return gerarPixPayload(
          config.pix_chave,
          config.pix_nome || 'Estabelecimento',
          config.pix_cidade || 'Brasil',
          tot
        );
      }
    } catch { /* ignore */ }
    return '';
  }, [pag, temPixCheckoutCfg, config.pix_payload_estatico, config.pix_chave, config.pix_nome, config.pix_cidade, tot]);

  useEffect(() => {
    if (pag !== 'pix') {
      setPixCheckoutCopiado(false);
    }
  }, [pag]);

  const copiarPixCheckout = useCallback(async () => {
    if (!pixPayloadCheckout) return;
    try {
      await navigator.clipboard.writeText(pixPayloadCheckout);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = pixPayloadCheckout;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setPixCheckoutCopiado(true);
    setTimeout(() => setPixCheckoutCopiado(false), 4000);
  }, [pixPayloadCheckout]);

  const ondePagaPresencial =
    tipoAtendimento === 'entrega'
      ? 'na entrega'
      : modoRecebimento === 'consumo_local'
        ? 'no local'
        : 'na retirada';

  const aplicarEntrega = () => {
    setModoRecebimento('entrega');
    onTipoAtendimentoChange('entrega');
    window.setTimeout(() => {
      enderecoEntregaScrollRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  };
  const aplicarRetirada = () => { setModoRecebimento('retirada'); onTipoAtendimentoChange('retirada'); };
  const aplicarConsumoLocal = () => { setModoRecebimento('consumo_local'); onTipoAtendimentoChange('retirada'); };

  useEffect(()=>{
    if (!effectiveCliToken||!slug) return;
    fetch(`/public/delivery/${slug}/cliente/enderecos`,{headers:{Authorization:`Bearer ${effectiveCliToken}`}})
      .then(r=>r.ok?r.json():[]).then(d=>{
        if (Array.isArray(d)&&d.length>0) {
          setEnderecos(d);
          const p = d.find((e:Endereco)=>e.principal);
          setEndSel(p ? p.id : d[0].id);
        } else {
          setEnderecos([]);
          setEndSel('novo');
          setNovoEndereco(emptyDeliveryNovoEnderecoForm(true));
        }
      });
  },[effectiveCliToken,slug]);

  const atualizarResumo = useCallback(async (
    cupomCodigo?: string | null,
    feeOverride?: { enderecoId?: number },
  ) => {
    if (!effectiveCliToken || !slug || cart.length === 0 || !tipoAtendimento) {
      setResumoCheckout(null);
      return null;
    }

    const requestId = ++resumoReqRef.current;
    setCarregandoResumo(true);

    const resolvedEndId =
      feeOverride && feeOverride.enderecoId !== undefined
        ? feeOverride.enderecoId
        : tipoAtendimento === 'retirada'
          ? undefined
          : typeof endSel === 'number'
            ? endSel
            : undefined;

    const resolvedBairroTemp =
      tipoAtendimento === 'retirada'
        ? undefined
        : bairroAtual.trim() || undefined;

    try {
      const r = await fetch(`/public/delivery/${slug}/pedido/resumo`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({
          items: cart.map(i=>({ product_id:i.id, quantity:i.qty, price_at_time:i.preco_final, name:i.name, obs_opcoes:i.obs_opcoes||'', variation_id:i.variation_id ?? null, selecoes: i.selecoes || undefined })),
          pagamento_tipo: pag,
          clienteToken: effectiveCliToken,
          canal: tipoAtendimento === 'retirada' ? 'retirada' : 'delivery',
          endereco_id: resolvedEndId,
          bairro_temporario: resolvedBairroTemp,
          endereco_eligibilidade:
            tipoAtendimento === 'entrega' && endSel === 'novo'
              ? {
                  logradouro: novoEndereco.campos.logradouro.trim(),
                  numero: novoEndereco.campos.numero.trim(),
                  bairro: novoEndereco.campos.bairro.trim(),
                }
              : undefined,
          cupom_codigo: cupomCodigo === undefined ? (cupomValido?.cupom?.codigo || undefined) : (cupomCodigo || undefined),
        }),
      });
      const d = await r.json();
      if (requestId !== resumoReqRef.current) return null;

      if (!d.success || !d.resumo) {
        if (cupomCodigo) {
          setCupomValido(null);
          setCupomErro(d.error || 'Nao foi possivel validar o cupom');
        }
        setResumoCheckout(null);
        return null;
      }

      const resumo = d.resumo as CheckoutResumo;
      setResumoCheckout(resumo);

      if (resumo.cupom_aplicado) {
        setCupomValido({ cupom: resumo.cupom_aplicado, desconto: resumo.desconto_cupom });
        setCupomErro('');
      } else if (cupomCodigo !== undefined || cupomValido?.cupom?.codigo) {
        setCupomValido(null);
        setCupomErro(resumo.cupom_invalido || '');
      }

      return resumo;
    } catch {
      if (requestId === resumoReqRef.current) {
        if (cupomCodigo) setCupomErro('Erro ao validar cupom');
        setResumoCheckout(null);
      }
      return null;
    } finally {
      if (requestId === resumoReqRef.current) {
        setCarregandoResumo(false);
      }
    }
  }, [
    effectiveCliToken,
    slug,
    cart,
    pag,
    endSel,
    bairroAtual,
    novoEndereco.campos.bairro,
    novoEndereco.campos.logradouro,
    novoEndereco.campos.numero,
    cupomValido?.cupom?.codigo,
    tipoAtendimento,
  ]);

  useEffect(() => {
    atualizarResumo();
  }, [atualizarResumo]);

  const endStr = endSel==='novo'
    ? formatEnderecoPedidoLinha(novoEndereco.campos)
    : (() => { const e=enderecos.find(x=>x.id===endSel); return e?`${e.logradouro}${e.numero?', '+e.numero:''}${e.complemento?' — '+e.complemento:''}${e.bairro?' • '+e.bairro:''}${e.referencia?' — Ref: '+e.referencia:''}`.trim():''; })();

  const validarCupom = async () => {
    const codigo = cupomInput.trim().toUpperCase();
    if (!codigo) return;
    setValidandoCupom(true);
    setCupomErro('');
    const resumo = await atualizarResumo(codigo);
    if (!resumo?.cupom_aplicado && !resumo?.cupom_invalido) {
      setCupomErro('Erro ao validar cupom');
    }
    setValidandoCupom(false);
  };

const finalizar = async () => {
    setErro('');
    if (!tipoAtendimento) { setErro('Escolha se o pedido sera para entrega ou retirada.'); return; }
    if (!modoRecebimento) { setErro('Escolha como deseja receber o pedido.'); return; }
    if (tipoAtendimento === 'entrega') {
    if (endSel === 'novo') {
      if (!novoEndereco.campos.logradouro.trim()) { setErro('Informe a rua ou avenida'); return; }
      if (!novoEndereco.campos.numero.trim()) { setErro('Informe o número do endereço'); return; }
      if (!novoEndereco.campos.bairro.trim()) { setErro('Informe o bairro'); return; }
    }
    if (!endStr.trim()) { setErro('Selecione ou informe o endereço de entrega'); return; }
    if (temZonas && endSel === 'novo' && !novoEndereco.campos.bairro.trim()) {
      setErro('Informe o bairro do endereço para calcular a taxa de entrega.');
      return;
    }
    }
    if (pag==='dinheiro' && precisaTroco) {
      const trocoVal = parseFloat(troco.replace(',','.'));
      if (!trocoVal || trocoVal < tot) { setErro(`Troco deve ser maior que ${fmt(tot)}`); return; }
    }
    const contatoRecCheck = contatoRecebimento.trim();
    if (contatoRecCheck) {
      const cd = normalizeBrazilDeliveryPhoneDigits(contatoRecCheck);
      if (cd.length < 10 || cd.length > 11) {
        setErro('Número para contato: use DDD + telefone (10 ou 11 dígitos), ou deixe em branco.');
        return;
      }
    }
    if (enviando) return;
    setEnviando(true);
    try {
      let enderecoIdFinal: number | undefined = typeof endSel === 'number' ? endSel : undefined;

      if (tipoAtendimento === 'entrega' && endSel === 'novo') {
        if (!effectiveCliToken) {
          setErro('É necessário identificar o cliente (telefone) para salvar o endereço de entrega.');
          return;
        }
        const principalFlag = enderecos.length === 0 || novoEndereco.principal;
        const rs = await fetch(`/public/delivery/${slug}/cliente/enderecos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${effectiveCliToken}` },
          body: JSON.stringify({
            label: novoEndereco.label,
            logradouro: novoEndereco.campos.logradouro.trim(),
            numero: novoEndereco.campos.numero.trim(),
            complemento: novoEndereco.campos.complemento.trim() || null,
            bairro: novoEndereco.campos.bairro.trim(),
            referencia: novoEndereco.campos.referencia.trim() || null,
            principal: principalFlag,
          }),
        });
        const sd = await rs.json();
        if (!sd.success) {
          setErro(sd.error || 'Não foi possível salvar o endereço');
          return;
        }
        enderecoIdFinal = sd.id;
      }

      const resumoFinal = await atualizarResumo(
        undefined,
        enderecoIdFinal ? { enderecoId: enderecoIdFinal } : undefined
      );
      if (!resumoFinal) {
        setErro('Nao foi possivel validar o resumo final do pedido. Tente novamente.');
        return;
      }
      if (tipoAtendimento === 'entrega' && resumoFinal.entrega_bloqueada_por_zona) {
        setErro(
          resumoFinal.mensagem_entrega_bloqueada || MENSAGEM_ENTREGA_FORA_DA_AREA
        );
        return;
      }

      let obsCompleta = '';
      if (tipoAtendimento === 'entrega') {
        const cdRaw = contatoRecebimento.trim();
        const cd = cdRaw ? normalizeBrazilDeliveryPhoneDigits(cdRaw) : '';
        const cdOk = cd.length >= 10 && cd.length <= 11 ? cd : null;
        const bloco = buildDeliveryCheckoutObservationBlock({
          nomeQuemRecebe,
          contatoDigits: cdOk,
          obsEntrega,
        });
        obsCompleta = mergeDeliveryObservationWithBase(bloco, obsCompleta);
      }
      if (pag==='dinheiro' && precisaTroco && troco) {
        const rest = obsCompleta.trim();
        obsCompleta = `Troco para R$ ${troco}${rest ? ` | ${rest}` : ''}`;
      }
      obsCompleta = observacaoComModoConsumo(modoRecebimento, obsCompleta);
      if (!effectiveCliente) {
        setErro(
          assistido
            ? 'Informe o telefone do cliente para localizar/cadastrar antes de finalizar o pedido.'
            : 'É necessário estar identificado para finalizar o pedido.'
        );
        return;
      }
      const body: any = {
        items: cart.map(i=>({product_id:i.id,quantity:i.qty,price_at_time:i.preco_final,name:i.name,obs_opcoes:i.obs_opcoes||'',variation_id:i.variation_id ?? null, selecoes: i.selecoes || undefined})),
        pagamento_tipo: pag,
        desconto_pix: pag==='pix' ? descontoPix : 0,
        observation: obsCompleta,
        cliente_nome: effectiveCliente.nome, cliente_tel: effectiveCliente.telefone,
        customer_email: effectiveCliente.email || undefined,
        endereco: tipoAtendimento === 'retirada' ? null : endStr,
        clienteToken: effectiveCliToken,
        canal: tipoAtendimento === 'retirada' ? 'retirada' : 'delivery',
        ...(tipoAtendimento === 'retirada'
          ? {
              tipo_retirada: modoRecebimento === 'consumo_local' ? 'local' : 'levar',
              modo_recebimento: modoRecebimento,
            }
          : {}),
        bairro_temporario:
          tipoAtendimento === 'retirada'
            ? undefined
            : bairroAtual.trim() || undefined,
        cupom_codigo: cupomValido ? cupomValido.cupom.codigo : undefined,
      };
      if (tipoAtendimento === 'entrega' && enderecoIdFinal != null) body.endereco_id = enderecoIdFinal;
      const r = await fetch(`/public/delivery/${slug}/pedido`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const d = await r.json();
      // CORREÇÃO: Pegamos o config_pix que vem do backend e mandamos para a próxima tela
      if (d.success) {
        onSuccess({
          orderNumber: d.orderNumber,
          waLink: d.waLink,
          total: d.total,
          orderId: d.orderId,
          pagamento_tipo: pag,
          mapsUrl: d.mapsUrl,
          itens: cart,
          config_pix: d.config_pix,
          payment_pix: d.payment_pix || null,
          canal: d.canal,
          pagamento_status: d.pagamento_status || (pag === 'pix' ? 'aguardando_confirmacao' : 'pendente'),
        });
      }
      else setErro(d.error||'Erro ao enviar pedido');
    } catch { setErro('Erro de conexão. Tente novamente.'); }
    finally { setEnviando(false); }
  };

  const stepsMeta: Array<{ num: CheckoutStep; label: string }> = [
    { num: 1, label: 'Entrega' },
    { num: 2, label: 'Pagamento' },
    { num: 3, label: 'Confirmação' },
  ];

  const validarAvancoEtapa1 = (): boolean => {
    setErro('');
    if (assistido && !effectiveCliente) {
      setErro('Informe o telefone do cliente (atendimento assistido) para continuar.');
      return false;
    }
    if (modoRecebimento == null) {
      setErro('Escolha como deseja receber o pedido.');
      return false;
    }
    if (modoRecebimento === 'entrega') {
      if (endSel === 'novo') {
        if (!novoEndereco.campos.logradouro.trim()) { setErro('Informe a rua ou avenida'); return false; }
        if (!novoEndereco.campos.numero.trim()) { setErro('Informe o número do endereço'); return false; }
        if (!novoEndereco.campos.bairro.trim()) { setErro('Informe o bairro'); return false; }
      }
      if (!endStr.trim()) { setErro('Selecione ou informe o endereço de entrega'); return false; }
      if (temZonas && endSel === 'novo' && !novoEndereco.campos.bairro.trim()) {
        setErro('Informe o bairro do endereço para calcular a taxa de entrega.');
        return false;
      }
      if (temZonas) {
        const bairroChecar =
          endSel === 'novo'
            ? novoEndereco.campos.bairro
            : enderecos.find((x) => x.id === endSel)?.bairro || '';
        if (bairroChecar.trim() && !detectarZona(bairroChecar)) {
          setErro(MENSAGEM_ENTREGA_FORA_DA_AREA);
          return false;
        }
      }
      const cr = contatoRecebimento.trim();
      if (cr) {
        const cd = normalizeBrazilDeliveryPhoneDigits(cr);
        if (cd.length < 10 || cd.length > 11) {
          setErro('Número para contato: use DDD + telefone (10 ou 11 dígitos), ou deixe em branco.');
          return false;
        }
      }
    }
    return true;
  };

  const validarAvancoEtapa2 = (): boolean => {
    setErro('');
    if (pag === 'dinheiro' && precisaTroco) {
      const trocoVal = parseFloat(troco.replace(',', '.'));
      if (!trocoVal || trocoVal <= tot) {
        setErro(`Troco deve ser maior que ${fmt(tot)}`);
        return false;
      }
    }
    return true;
  };

  const handleFooterVoltar = () => {
    if (modalStep <= 1) fecharModalCheckout();
    else setModalStep((modalStep - 1) as CheckoutStep);
  };

  const handleFooterPrimario = () => {
    if (modalStep === 1) {
      if (!validarAvancoEtapa1()) return;
      if (modoRecebimento === 'entrega') onTipoAtendimentoChange('entrega');
      else onTipoAtendimentoChange('retirada');
      setModalStep(2);
      return;
    }
    if (modalStep === 2) {
      if (!validarAvancoEtapa2()) return;
      setErro('');
      setModalStep(3);
      return;
    }
    if (modalStep === 3) { /*
        setErro('Toque em "Já confirmei o pagamento" abaixo antes de enviar o pedido.');
      */ setErro('');
    }
    void finalizar();
  };

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-labelledby="checkout-modal-title"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[72] flex items-end justify-center sm:items-center sm:p-4"
    >
      <div className={cx.overlay} onClick={fecharModalCheckout} aria-hidden />
      <motion.div
        initial={{ y: 24, opacity: 0.96 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 32, opacity: 0 }}
        transition={{ type: 'spring', damping: 28, stiffness: 380 }}
        className={cx.panel}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={cx.header}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="checkout-modal-title" className={cx.title}>Checkout</h2>
              <p className={cx.subtitle}>{fmt(sub)} · {cart.reduce((a, i) => a + i.qty, 0)} itens</p>
            </div>
            <button type="button" onClick={fecharModalCheckout} className={cx.closeBtn} aria-label="Fechar checkout">
              <X size={18} />
            </button>
          </div>
          <nav className="mt-4 flex items-center justify-between gap-1" aria-label="Etapas do checkout">
            {stepsMeta.map((s, i) => {
              const ativo = modalStep === s.num;
              const concluido = modalStep > s.num;
              const ultimo = i === stepsMeta.length - 1;
              return (
                <Fragment key={s.num}>
                  <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                    <div
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-black tabular-nums transition-colors ${
                        ativo ? cx.stepActive : concluido ? cx.stepDone : cx.stepIdle
                      }`}
                    >
                      {concluido ? <CheckCircle2 size={18} strokeWidth={2.5} /> : s.num}
                    </div>
                    <span
                      className={`max-w-[5.5rem] text-center text-[10px] font-bold uppercase leading-tight tracking-wide ${
                        ativo ? cx.stepLabelActive : concluido ? cx.stepLabelDone : cx.stepLabelIdle
                      }`}
                    >
                      {s.label}
                    </span>
                  </div>
                  {!ultimo && (
                    <div
                      className={`mx-0.5 mb-6 h-0.5 min-w-[12px] flex-1 rounded-full ${modalStep > s.num ? cx.stepLineDone : cx.stepLineTodo}`}
                      aria-hidden
                    />
                  )}
                </Fragment>
              );
            })}
          </nav>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain space-y-3 px-3 py-3 sm:space-y-4 sm:px-5 sm:py-4">
        <div className={`${cx.card} ${modalStep !== 1 ? 'hidden' : ''}`}>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className={`text-[11px] font-bold uppercase tracking-[0.22em] ${checkoutTheme.mode === 'light_red' ? 'text-zinc-500' : 'text-zinc-400'}`}>Como voce quer receber</p>
              <p className={cx.cardTitle}>Como deseja receber o pedido</p>
            </div>
            <p className={cx.cardMuted}>O total final e atualizado conforme sua escolha.</p>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <button
              type="button"
              onClick={aplicarEntrega}
              className={modoRecebimento === 'entrega' ? cx.modeCardActive : cx.modeCard}
            >
              <div className={modoRecebimento === 'entrega' ? cx.modeIconActive : cx.modeIconIdle}>
                <Bike size={18} />
              </div>
              <p className={cx.modeTitle}>Receber no endereço</p>
              <p className={cx.modeDesc}>Endereço, taxa por bairro e total com entrega.</p>
            </button>
            <button
              type="button"
              onClick={aplicarRetirada}
              className={modoRecebimento === 'retirada' ? cx.modeCardActive : cx.modeCard}
            >
              <div className={modoRecebimento === 'retirada' ? cx.modeIconActive : cx.modeIconIdle}>
                <Package size={18} />
              </div>
              <p className={cx.modeTitle}>Retirar no estabelecimento</p>
              <p className={cx.modeDesc}>Sem endereço e sem taxa de entrega.</p>
            </button>
            <button
              type="button"
              onClick={aplicarConsumoLocal}
              className={`sm:col-span-1 ${modoRecebimento === 'consumo_local' ? cx.modeCardActive : cx.modeCard}`}
            >
              <div className={modoRecebimento === 'consumo_local' ? cx.modeIconActive : cx.modeIconIdle}>
                <Utensils size={18} />
              </div>
              <p className={cx.modeTitle}>Consumir no local</p>
              <p className={cx.modeDesc}>Pedido para consumo no estabelecimento (sem entrega).</p>
            </button>
          </div>
          <div className={`mt-4 rounded-2xl border px-4 py-3 text-sm ${
            modoRecebimento === 'entrega'
              ? cx.hintBoxEntrega
              : modoRecebimento === 'retirada'
                ? cx.hintBoxRetirada
                : modoRecebimento === 'consumo_local'
                  ? cx.hintBoxLocal
                  : cx.hintBoxDefault
          }`}>
            {modoRecebimento === 'entrega'
              ? 'Entrega: confira o endereço abaixo para validar taxa, descontos e total final.'
              : modoRecebimento === 'retirada'
                ? 'Retirada: sem endereço e sem taxa de entrega.'
                : modoRecebimento === 'consumo_local'
                  ? 'Consumo no local: sem endereço de entrega; informamos na observação do pedido.'
                  : 'Escolha uma opção para continuar.'}
          </div>
        </div>
        {/* Resumo dos itens */}
        <div className={`${cx.card} ${modalStep !== 3 ? 'hidden' : ''}`}>
          <p className={`font-black mb-2 text-sm ${isLightCheckout ? 'text-zinc-900' : 'text-white'}`}>Resumo do pedido</p>
          {cart.map(i=>(
            <div
              key={i.cart_key}
              className={`flex items-start justify-between border-b py-2 last:border-0 ${isLightCheckout ? 'border-zinc-200' : 'border-white/5'}`}
            >
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-semibold ${isLightCheckout ? 'text-zinc-800' : 'text-zinc-100'}`}>{i.qty}× {i.name}</p>
                {i.obs_opcoes && (
                  <p className={`mt-0.5 text-[11px] ${isLightCheckout ? 'text-zinc-500' : 'text-zinc-500'}`}>{i.obs_opcoes}</p>
                )}
              </div>
              <div className="ml-2 shrink-0 text-right">
                {isPromocaoProdutoValida(i) && (
                  <p className={`text-[11px] line-through ${isLightCheckout ? 'text-zinc-400' : 'text-zinc-500'}`}>
                    {fmt(Number(i.preco_original || 0) * i.qty)}
                  </p>
                )}
                <p
                  className={`text-sm font-bold ${
                    isPromocaoProdutoValida(i)
                      ? isLightCheckout
                        ? 'text-emerald-600'
                        : 'text-emerald-300'
                      : isLightCheckout
                        ? 'text-red-700'
                        : 'text-cyan-300'
                  }`}
                >
                  {fmt(i.preco_final * i.qty)}
                </p>
              </div>
            </div>
          ))}
        </div>
        {/* Cliente */}
        {effectiveCliente ? (
          <div className={`${cx.clienteCard} ${modalStep !== 2 ? 'hidden' : ''}`}>
            <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-black text-white ${checkoutTheme.mode === 'light_red' ? 'bg-red-600' : 'bg-sky-600'}`}>{effectiveCliente.nome[0]}</div>
            <div><p className={`text-sm font-bold ${checkoutTheme.mode === 'light_red' ? 'text-zinc-900' : 'text-white'}`}>{effectiveCliente.nome}</p><p className={`text-xs ${checkoutTheme.mode === 'light_red' ? 'text-red-700' : 'text-cyan-200'}`}>{effectiveCliente.telefone}</p></div>
          </div>
        ) : assistido ? (
          <div className={`${cx.clienteCard} ${modalStep !== 2 ? 'hidden' : ''}`}>
            <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-black text-white ${checkoutTheme.mode === 'light_red' ? 'bg-red-600' : 'bg-sky-600'}`}>?</div>
            <div>
              <p className={`text-sm font-bold ${checkoutTheme.mode === 'light_red' ? 'text-zinc-900' : 'text-white'}`}>Telefone do cliente</p>
              <p className={`text-xs ${checkoutTheme.mode === 'light_red' ? 'text-red-700' : 'text-cyan-200'}`}>Informe na etapa Entrega</p>
            </div>
          </div>
        ) : null}

        {/* Atendimento assistido (sem login/senha): identifica o cliente no checkout */}
        {assistido && modalStep === 1 && (
          <div className={cx.card}>
            <p className={cx.cardTitle}>Atendimento assistido</p>
            <p className={cx.cardMuted}>Informe o telefone para buscar cadastro e endereços. Se não existir, cadastre rápido.</p>

            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
              <div>
                <p className={`mb-1.5 text-xs font-bold uppercase tracking-wider ${isLightCheckout ? 'text-zinc-500' : 'text-zinc-400'}`}>Telefone do cliente</p>
                <input
                  value={assistTelefone}
                  onChange={(e) => {
                    const next = e.target.value;
                    setAssistTelefone(next);
                    setAssistErro('');
                    if (assistSession) {
                      setAssistSession(null);
                      setAssistNovoCliente(false);
                      setEnderecos([]);
                      setEndSel('novo');
                      setNovoEndereco(emptyDeliveryNovoEnderecoForm(true));
                      setResumoCheckout(null);
                    }
                  }}
                  onBlur={() => {
                    if (!assistSession && assistTelefoneOk && !assistNovoCliente) {
                      void identificarPorTelefoneAssistido();
                    }
                  }}
                  placeholder="DDD + telefone (somente números)"
                  inputMode="tel"
                  className={inp}
                />
              </div>
              {assistSession ? (
                <button type="button" onClick={resetAssistidoCliente} className={cx.footerBack}>
                  Trocar
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void identificarPorTelefoneAssistido()}
                  className={cx.cupomApply}
                  disabled={!assistTelefoneOk || assistLoading}
                >
                  {assistLoading ? 'Buscando...' : 'Buscar'}
                </button>
              )}
            </div>

            {assistSession && (
              <div className={`mt-3 rounded-xl border px-3 py-2 text-sm ${isLightCheckout ? 'border-zinc-200 bg-zinc-50 text-zinc-700' : 'border-white/10 bg-white/5 text-zinc-200'}`}>
                <span className="font-bold">Cliente:</span> {assistSession.cliente.nome} · {assistSession.cliente.telefone}
              </div>
            )}

            {assistNovoCliente && !assistSession && (
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                <div>
                  <p className={`mb-1.5 text-xs font-bold uppercase tracking-wider ${isLightCheckout ? 'text-zinc-500' : 'text-zinc-400'}`}>Nome do cliente</p>
                  <input
                    value={assistNome}
                    onChange={(e) => setAssistNome(e.target.value)}
                    placeholder="Nome para cadastro rápido"
                    className={inp}
                    maxLength={80}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void cadastrarRapidoAssistido()}
                  className={cx.cupomApply}
                  disabled={assistLoading || !assistTelefoneOk || !assistNome.trim()}
                >
                  {assistLoading ? 'Cadastrando...' : 'Cadastrar'}
                </button>
              </div>
            )}

            {assistErro && (
              <p className={`mt-2 text-sm font-semibold ${isLightCheckout ? 'text-red-700' : 'text-rose-200'}`}>
                {assistErro}
              </p>
            )}
          </div>
        )}

        {/* Endereço / retirada — etapa 1 */}
        {modoRecebimento === 'retirada' && modalStep === 1 && (
          <div className={cx.card}>
            <p className={`font-black mb-2 flex items-center gap-2 ${checkoutTheme.mode === 'light_red' ? 'text-zinc-900' : 'text-white'}`}><Package size={15} className={checkoutTheme.mode === 'light_red' ? 'text-red-600' : 'text-cyan-300'}/>Retirar no local</p>
            <p className={cx.cardMuted}>Nao vamos pedir endereco neste pedido. Assim que ficar pronto, a retirada acontece diretamente no estabelecimento.</p>
          </div>
        )}
        {modoRecebimento === 'consumo_local' && modalStep === 1 && (
          <div className={cx.card}>
            <p className={`font-black mb-2 flex items-center gap-2 ${checkoutTheme.mode === 'light_red' ? 'text-zinc-900' : 'text-white'}`}><Utensils size={15} className={checkoutTheme.mode === 'light_red' ? 'text-red-600' : 'text-cyan-300'}/>Consumo no local</p>
            <p className={cx.cardMuted}>O pedido sera preparado para consumo no estabelecimento. Use a observacao se precisar de mesa ou detalhe.</p>
          </div>
        )}
        <div
          ref={enderecoEntregaScrollRef}
          className={`${cx.card} ${tipoAtendimento !== 'entrega' || modalStep !== 1 ? 'hidden' : ''}`}
        >
          <p className={`font-black mb-3 flex items-center gap-2 ${checkoutTheme.mode === 'light_red' ? 'text-zinc-900' : 'text-white'}`}><MapPin size={15} className={checkoutTheme.mode === 'light_red' ? 'text-red-600' : 'text-cyan-300'}/>Endereço de entrega</p>
          {temZonas && (
            <div
              className={
                isLightCheckout
                  ? 'mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-900'
                  : 'mb-3 rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-[12px] text-cyan-200'
              }
            >
              A entrega só é feita para bairros cadastrados como zonas. A taxa é a definida para a zona que corresponder ao seu bairro.
            </div>
          )}
          {enderecos.length>0&&(
            <div className="space-y-2 mb-2">
              {enderecos.map(e=>(
                <button key={e.id} onClick={()=>setEndSel(e.id)}
                  className={endSel===e.id ? cx.addressBtnOn : cx.addressBtnOff}>
                  <p className={`text-sm font-bold ${endSel===e.id ? (checkoutTheme.mode === 'light_red' ? 'text-red-900' : 'text-cyan-200') : (checkoutTheme.mode === 'light_red' ? 'text-zinc-900' : 'text-zinc-100')}`}>
                    {e.label}
                    {e.principal===1&&<span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] ${checkoutTheme.mode === 'light_red' ? 'bg-red-100 text-red-800' : 'bg-cyan-500/20 text-cyan-200'}`}>Principal</span>}
                  </p>
                  <p className={`mt-0.5 text-xs ${checkoutTheme.mode === 'light_red' ? 'text-zinc-500' : 'text-zinc-400'}`}>{e.logradouro}{e.numero?', '+e.numero:''}{e.bairro?' • '+e.bairro:''}</p>
                  {/* Mostra a taxa detectada para este endereço */}
                  {temZonas && e.bairro && (() => {
                    const z = detectarZona(e.bairro);
                    if (z) {
                      return (
                        <p
                          className={`mt-1 text-[11px] font-bold ${
                            z.taxa === 0
                              ? isLightCheckout
                                ? 'text-red-700'
                                : 'text-cyan-300'
                              : isLightCheckout
                                ? 'text-zinc-500'
                                : 'text-zinc-400'
                          }`}
                        >
                          {z.taxa === 0 ? 'Entrega grátis neste bairro' : `Taxa de entrega: ${fmt(z.taxa)}`}
                        </p>
                      );
                    }
                    return (
                      <p
                        className={`mt-1 text-[11px] font-bold ${
                          isLightCheckout ? 'text-amber-800' : 'text-amber-200'
                        }`}
                      >
                        {MENSAGEM_ENTREGA_FORA_DA_AREA}
                      </p>
                    );
                  })()}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setEndSel('novo');
                  setNovoEndereco(emptyDeliveryNovoEnderecoForm(false));
                }}
                className={endSel==='novo' ? cx.addressBtnOn : `${cx.addressBtnOff} border-dashed`}
              >
                <p className={`text-sm font-bold ${checkoutTheme.mode === 'light_red' ? 'text-red-800' : 'text-cyan-200'}`}>+ Usar outro endereço</p>
              </button>
            </div>
          )}
          {(endSel==='novo'||enderecos.length===0) && (
            <div className="mt-2 space-y-3">
              <div>
                <p className={`mb-1.5 text-xs font-bold uppercase tracking-wider ${isLightCheckout ? 'text-zinc-500' : 'text-zinc-400'}`}>Identificação</p>
                <DeliveryIdentificacaoEnderecoChips
                  value={novoEndereco.label}
                  onChange={(label) => setNovoEndereco((f) => ({ ...f, label }))}
                  chipOn={
                    isLightCheckout
                      ? 'border-cyan-400 bg-cyan-50 text-cyan-700'
                      : 'border-cyan-400/70 bg-cyan-500/15 text-cyan-200'
                  }
                  chipOff={
                    isLightCheckout
                      ? 'border-zinc-200 bg-white text-zinc-500'
                      : 'border-white/15 bg-white/5 text-zinc-400'
                  }
                />
              </div>
              <div
                className={
                  isLightCheckout
                    ? 'space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm'
                    : 'space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4'
                }
              >
                <DeliveryEnderecoCamposInputs
                  value={novoEndereco.campos}
                  onChange={(campos) => setNovoEndereco((f) => ({ ...f, campos }))}
                  inpClass={inp}
                  temZonas={temZonas}
                  labelClassName={isLightCheckout ? 'text-zinc-500' : 'text-zinc-400'}
                />
              </div>
              {enderecos.length === 0 ? (
                <p className={`text-xs font-medium ${isLightCheckout ? 'text-zinc-500' : 'text-zinc-400'}`}>
                  Este primeiro endereço será salvo no seu cadastro como principal.
                </p>
              ) : (
                <label
                  className={
                    isLightCheckout
                      ? 'flex cursor-pointer items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm'
                      : 'flex cursor-pointer items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-4'
                  }
                >
                  <button
                    type="button"
                    aria-pressed={novoEndereco.principal}
                    onClick={() => setNovoEndereco((f) => ({ ...f, principal: !f.principal }))}
                    className={`relative h-6 w-12 shrink-0 rounded-full transition-all ${
                      novoEndereco.principal
                        ? isLightCheckout
                          ? 'bg-red-600'
                          : 'bg-cyan-600'
                        : isLightCheckout
                          ? 'bg-zinc-300'
                          : 'bg-zinc-600'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                        novoEndereco.principal ? 'left-6' : 'left-0.5'
                      }`}
                    />
                  </button>
                  <span className={`text-sm font-semibold ${isLightCheckout ? 'text-zinc-700' : 'text-zinc-200'}`}>
                    Definir como principal
                  </span>
                </label>
              )}
            </div>
          )}

          {/* Badge da zona detectada automaticamente */}
          {temZonas && zonaDetectada && (
            <div className={zonaDetectada.taxa === 0 ? cx.zonaBadgeFree : cx.zonaBadgePaid}>
              <Bike size={14}/>
              <span>
                {zonaDetectada.taxa === 0
                  ? `Entrega gratis para ${zonaDetectada.nome}`
                  : `Taxa para ${zonaDetectada.nome}: ${fmt(zonaDetectada.taxa)}`}
              </span>
            </div>
          )}

          {/* Bairro fora das zonas cadastradas — entrega bloqueada */}
          {temZonas && !zonaDetectada && bairroAtual.trim() && (
            <div
              className={
                isLightCheckout
                  ? 'mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900'
                  : 'mt-3 flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-200'
              }
            >
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>{MENSAGEM_ENTREGA_FORA_DA_AREA}</span>
            </div>
          )}

          <div
            className={
              isLightCheckout
                ? 'mt-4 space-y-3 border-t border-zinc-200 pt-4'
                : 'mt-4 space-y-3 border-t border-white/10 pt-4'
            }
          >
            <p
              className={`text-[11px] font-bold uppercase tracking-[0.18em] ${isLightCheckout ? 'text-zinc-500' : 'text-zinc-400'}`}
            >
              Outra pessoa vai receber? (opcional)
            </p>
            <p className={`-mt-1 text-xs leading-relaxed ${isLightCheckout ? 'text-zinc-500' : 'text-zinc-400'}`}>
              Preencha só se você pediu do trabalho ou de outro lugar e outra pessoa vai receber no seu lugar. Caso contrário, deixe em branco.
            </p>
            <div>
              <label
                className={`mb-1.5 block text-xs font-bold uppercase tracking-wider ${isLightCheckout ? 'text-zinc-500' : 'text-zinc-400'}`}
              >
                Nome de quem vai receber
              </label>
              <input
                type="text"
                autoComplete="name"
                maxLength={MAX_CHECKOUT_NOME_RECEBE_LEN}
                value={nomeQuemRecebe}
                onChange={(e) => setNomeQuemRecebe(e.target.value)}
                placeholder="Ex.: Maria Souza"
                className={`${inp} text-sm`}
              />
            </div>
            <div>
              <label
                className={`mb-1.5 block text-xs font-bold uppercase tracking-wider ${isLightCheckout ? 'text-zinc-500' : 'text-zinc-400'}`}
              >
                Telefone de quem vai receber
              </label>
              <p className={`mb-2 text-xs leading-relaxed ${isLightCheckout ? 'text-zinc-600' : 'text-zinc-400'}`}>
                Para o entregador entrar em contato com quem está no local. Não altera o telefone do seu cadastro.
              </p>
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                maxLength={40}
                value={contatoRecebimento}
                onChange={(e) => setContatoRecebimento(e.target.value)}
                placeholder="Ex.: (82) 99999-9999"
                className={`${inp} text-sm`}
              />
            </div>
            <div>
              <label
                className={`mb-1.5 block text-xs font-bold uppercase tracking-wider ${isLightCheckout ? 'text-zinc-500' : 'text-zinc-400'}`}
              >
                Recado para o entregador
              </label>
              <textarea
                value={obsEntrega}
                onChange={(e) => setObsEntrega(e.target.value)}
                placeholder="Ex.: Deixar na portaria. Campainha não funciona."
                rows={2}
                maxLength={MAX_CHECKOUT_OBS_ENTREGA_LEN}
                className={`${inp} resize-none text-sm`}
              />
            </div>
          </div>
        </div>
        {/* ── Pagamento ── */}
        <div className={`space-y-2 ${modalStep !== 2 ? 'hidden' : ''}`}>
          {/* PIX — destaque principal */}
          <button onClick={()=>setPag('pix')}
            className={pag==='pix' ? cx.pixOptionOuterOn : cx.pixOptionOuter}>
            {/* Banner de desconto se configurado */}
            {descontoPix > 0 && (
              <div className={`px-4 py-1.5 flex items-center justify-between ${checkoutTheme.mode === 'light_red' ? 'bg-red-600' : 'bg-cyan-600'}`}>
                <span className="text-white text-xs font-black">Desconto Pix de {descontoPixPercentual}%</span>
                <span className="text-white text-xs font-black bg-white/20 px-2 py-0.5 rounded-full">-{fmt(descontoPix)}</span>
              </div>
            )}
            <div className={pag==='pix' ? cx.pixOptionInnerOn : cx.pixOptionInner}>
              <div className="flex items-center gap-3">
                <div className={pag==='pix' ? cx.pixIconBoxOn : cx.pixIconBoxOff}>
                  <Smartphone size={18} className={pag==='pix'?'text-white':'text-zinc-300'}/>
                </div>
                <div className="text-left">
                  <p className={pag==='pix' ? cx.pixTitleOn : cx.pixTitleOff}>Pix</p>
                  <p className={pag==='pix' ? cx.pixSubOn : cx.pixSubOff}>
                    {descontoPixPercentual > 0 ? `${descontoPixPercentual}% de desconto • Pague agora` : 'Pague agora via Pix Copia e Cola'}
                  </p>
                </div>
              </div>
              <div className={pag==='pix' ? cx.radioOn : cx.radioOff}>
                {pag==='pix'&&<div className="w-2 h-2 rounded-full bg-white"/>}
              </div>
            </div>
          </button>

          {pag === 'pix' && modalStep === 2 && pixPayloadCheckout && (
            <div className={cx.pixPanel}>
              <p className={cx.pixPanelTitle}>Pague agora (mesmo valor da confirmação)</p>
              <div className="flex justify-center">
                <div
                  className={
                    isLightCheckout
                      ? 'rounded-xl border border-zinc-200 bg-white p-2 shadow-sm'
                      : 'rounded-xl border border-white/15 bg-white p-2 shadow-inner'
                  }
                >
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=168x168&ecc=M&data=${encodeURIComponent(pixPayloadCheckout)}`}
                    alt="QR Code Pix"
                    width={168}
                    height={168}
                    className="rounded-lg"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                </div>
              </div>
              <div className={cx.pixDetailBox}>
                <div className="flex justify-between gap-2">
                  <span className={`shrink-0 ${checkoutTheme.mode === 'light_red' ? 'text-zinc-500' : 'text-zinc-500'}`}>Valor</span>
                  <span className={`font-black ${checkoutTheme.mode === 'light_red' ? 'text-red-700' : 'text-cyan-300'}`}>{fmt(tot)}</span>
                </div>
                {config.pix_chave && (
                  <div className="flex justify-between gap-2">
                    <span className="shrink-0 text-zinc-500">Chave</span>
                    <span className={`max-w-[65%] truncate text-right font-mono text-xs font-bold ${checkoutTheme.mode === 'light_red' ? 'text-zinc-800' : 'text-zinc-200'}`}>{config.pix_chave}</span>
                  </div>
                )}
                {config.pix_nome && (
                  <div className="flex justify-between gap-2">
                    <span className="shrink-0 text-zinc-500">Recebedor</span>
                    <span className={`text-right font-semibold ${checkoutTheme.mode === 'light_red' ? 'text-zinc-900' : 'text-zinc-100'}`}>{config.pix_nome}</span>
                  </div>
                )}
              </div>
              <p className={`text-center text-[10px] ${checkoutTheme.mode === 'light_red' ? 'text-zinc-500' : 'text-zinc-500'}`}>Pix copia e cola</p>
              <div className={`max-h-20 overflow-y-auto rounded-xl border px-3 py-2 ${checkoutTheme.mode === 'light_red' ? 'border-zinc-200 bg-zinc-100' : 'border-white/10 bg-black/40'}`}>
                <p className={`break-all font-mono text-[10px] leading-relaxed ${checkoutTheme.mode === 'light_red' ? 'text-zinc-600' : 'text-zinc-400'}`}>{pixPayloadCheckout}</p>
              </div>
              <button
                type="button"
                onClick={copiarPixCheckout}
                className={pixCheckoutCopiado ? cx.pixCopyBtnDone : cx.pixCopyBtn}
              >
                {pixCheckoutCopiado ? <CheckCircle2 size={18} /> : <Copy size={18} />}
                {pixCheckoutCopiado ? 'Código copiado' : 'Copiar código Pix'}
              </button>
            </div>
          )}
          {pag === 'pix' && modalStep === 2 && !pixPayloadCheckout && temPixCheckoutCfg && (
            <p
              className={
                isLightCheckout
                  ? 'rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-center text-xs text-amber-900'
                  : 'rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-center text-xs text-amber-100'
              }
            >
              Não foi possível gerar o código Pix aqui. Avance para confirmar o pedido ou escolha outra forma de pagamento.
            </p>
          )}
          {pag === 'pix' && modalStep === 2 && !temPixCheckoutCfg && (
            <p
              className={
                isLightCheckout
                  ? 'rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-center text-xs text-zinc-600'
                  : 'rounded-xl border border-white/10 bg-zinc-900 px-3 py-2 text-center text-xs text-zinc-400'
              }
            >
              O Pix desta loja será exibido após você confirmar o pedido na próxima etapa.
            </p>
          )}

          {/* Dinheiro */}
          <button onClick={()=>setPag('dinheiro')}
            className={pag==='dinheiro' ? cx.pixOptionOuterOn : cx.pixOptionOuter}>
            <div className={pag==='dinheiro' ? cx.pixOptionInnerOn : cx.pixOptionInner}>
              <div className="flex items-center gap-3">
                <div className={pag==='dinheiro' ? cx.pixIconBoxOn : cx.pixIconBoxOff}>
                  <Banknote size={18} className={pag==='dinheiro'?'text-white':'text-zinc-300'}/>
                </div>
                <div className="text-left">
                  <p className={pag==='dinheiro' ? cx.pixTitleOn : cx.pixTitleOff}>Dinheiro</p>
                  <p className={pag==='dinheiro' ? cx.pixSubOn : cx.pixSubOff}>{tipoAtendimento === 'retirada' ? (modoRecebimento === 'consumo_local' ? 'Pague no local' : 'Pague na retirada') : 'Pague na entrega'}</p>
                </div>
              </div>
              <div className={pag==='dinheiro' ? cx.radioOn : cx.radioOff}>
                {pag==='dinheiro'&&<div className="w-2 h-2 rounded-full bg-white"/>}
              </div>
            </div>
            {/* Troco — expande ao selecionar dinheiro */}
            {pag==='dinheiro' && (
              <div className={cx.payDinheiroExpand}>
                <div className="flex items-center gap-3">
                  <span className={`text-sm font-semibold ${checkoutTheme.mode === 'light_red' ? 'text-zinc-800' : 'text-zinc-100'}`}>Precisa de troco?</span>
                  <div className="flex gap-2 ml-auto">
                    <button onClick={e=>{e.stopPropagation();setPrecisaTroco(false);setTroco('');}}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${!precisaTroco ? cx.trocoToggleOn : cx.trocoToggleOff}`}>
                      Não
                    </button>
                    <button onClick={e=>{e.stopPropagation();setPrecisaTroco(true);}}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${precisaTroco ? cx.trocoToggleOn : cx.trocoToggleOff}`}>
                      Sim
                    </button>
                  </div>
                </div>
                {precisaTroco && (
                  <div>
                    <label className={`block mb-1.5 text-[11px] font-bold uppercase tracking-wider ${checkoutTheme.mode === 'light_red' ? 'text-zinc-500' : 'text-zinc-400'}`}>Troco para quanto?</label>
                    <div className="relative">
                      <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-bold text-zinc-400">R$</span>
                      <input
                        type="number" step="0.01" min={tot}
                        value={troco} onChange={e=>setTroco(e.target.value)}
                        onClick={e=>e.stopPropagation()}
                        placeholder={`Mín. ${tot.toFixed(2)}`}
                        className={cx.trocoInput}
                      />
                    </div>
                    {troco && parseFloat(troco.replace(',','.')) > tot && (
                      <p className={`mt-1.5 text-xs font-semibold ${checkoutTheme.mode === 'light_red' ? 'text-red-700' : 'text-cyan-300'}`}>
                        Troco: {fmt(parseFloat(troco.replace(',','.'))-tot)}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </button>

          {/* Cartão */}
          <button onClick={()=>setPag('cartao')}
            className={pag==='cartao' ? cx.cartaoRowOn : cx.cartaoRow}>
            <div className="flex items-center gap-3">
              <div className={pag==='cartao' ? cx.pixIconBoxOn : cx.pixIconBoxOff}>
                <CreditCard size={18} className={pag==='cartao'?'text-white':'text-zinc-300'}/>
              </div>
              <div className="text-left">
                <p className={pag==='cartao' ? cx.pixTitleOn : cx.pixTitleOff}>Cartao</p>
                <p className={pag==='cartao' ? cx.pixSubOn : cx.pixSubOff}>{tipoAtendimento === 'retirada' ? (modoRecebimento === 'consumo_local' ? 'Debito ou credito no local' : 'Debito ou credito na retirada') : 'Debito ou credito na entrega'}</p>
              </div>
            </div>
            <div className={pag==='cartao' ? cx.radioOn : cx.radioOff}>
              {pag==='cartao'&&<div className="w-2 h-2 rounded-full bg-white"/>}
            </div>
          </button>

          {modalStep === 2 && pag === 'dinheiro' && (
            <div
              className={
                isLightCheckout
                  ? 'rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-xs leading-relaxed text-zinc-600'
                  : 'rounded-xl border border-white/10 bg-zinc-900/80 px-3 py-2.5 text-xs leading-relaxed text-zinc-300'
              }
            >
              <span className={`font-bold ${isLightCheckout ? 'text-zinc-900' : 'text-zinc-100'}`}>Dinheiro:</span> você paga {ondePagaPresencial}, no valor do pedido. Se precisar de troco para uma nota maior, use &quot;Precisa de troco?&quot; no cartão acima.
            </div>
          )}
          {modalStep === 2 && pag === 'cartao' && (
            <div
              className={
                isLightCheckout
                  ? 'rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-xs leading-relaxed text-zinc-600'
                  : 'rounded-xl border border-white/10 bg-zinc-900/80 px-3 py-2.5 text-xs leading-relaxed text-zinc-300'
              }
            >
              <span className={`font-bold ${isLightCheckout ? 'text-zinc-900' : 'text-zinc-100'}`}>Cartão:</span> débito ou crédito {ondePagaPresencial}, na maquininha — nada é cobrado pelo app neste momento.
            </div>
          )}
        </div>

        {/* Cupom de desconto */}
        <div className={`${cx.cupomBox} ${modalStep !== 2 ? 'hidden' : ''}`}>
          <div className="flex items-start justify-between gap-3 mb-2">
            <div>
              <p className={cx.cupomTitle}>
                <Tag size={15} className={checkoutTheme.mode === 'light_red' ? 'text-red-600' : 'text-cyan-300'} />
                Cupom de desconto <span className={`text-xs font-normal ${checkoutTheme.mode === 'light_red' ? 'text-zinc-500' : 'text-zinc-400'}`}>(opcional)</span>
              </p>
              <p className={`mt-1 text-xs ${checkoutTheme.mode === 'light_red' ? 'text-zinc-600' : 'text-zinc-300'}`}>Digite o codigo aqui no fechamento e veja o desconto entrar no total antes de confirmar.</p>
            </div>
            {Number(config.desconto_pix || 0) > 0 && (
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-black ${checkoutTheme.mode === 'light_red' ? 'bg-red-50 text-red-800' : 'bg-cyan-500/10 text-cyan-200'}`}>
                Pix -{Number(config.desconto_pix || 0)}%
              </span>
            )}
          </div>
          {cupomValido ? (
            <div
              className={
                isLightCheckout
                  ? 'flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-3'
                  : 'flex items-center gap-3 rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-3'
              }
            >
              <CheckCircle2 size={16} className={`shrink-0 ${isLightCheckout ? 'text-red-600' : 'text-cyan-300'}`} />
              <div className="flex-1">
                <p className={`text-sm font-black ${isLightCheckout ? 'text-red-900' : 'text-cyan-100'}`}>{cupomValido.cupom.codigo}</p>
                <p className={`text-xs ${isLightCheckout ? 'text-red-800' : 'text-cyan-200'}`}>
                  {cupomValido.cupom.tipo==='frete_gratis' ? 'Frete grátis!' : `-${fmt(cupomValido.desconto)} de desconto`}
                </p>
              </div>
              <button
                onClick={()=>{ setCupomValido(null); setCupomInput(''); setCupomErro(''); atualizarResumo(''); }}
                className={
                  isLightCheckout
                    ? 'rounded-lg p-1 text-red-600 hover:bg-red-100'
                    : 'rounded-lg p-1 text-cyan-300 hover:bg-cyan-500/10'
                }
              >
                <X size={14}/>
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input value={cupomInput} onChange={e=>setCupomInput(e.target.value.toUpperCase())}
                onKeyDown={e=>e.key==='Enter'&&validarCupom()}
                placeholder="CÓDIGO DO CUPOM"
                className={cx.cupomInput}/>
              <button onClick={validarCupom} disabled={validandoCupom||!cupomInput.trim()}
                className={cx.cupomApply}>
                {validandoCupom ? '...' : 'Aplicar'}
              </button>
            </div>
          )}
          {cupomErro && (
            <p className={`mt-1.5 flex items-center gap-1 text-xs ${isLightCheckout ? 'text-red-700' : 'text-red-300'}`}>
              <X size={11}/>{cupomErro}
            </p>
          )}
          {!cupomValido && !cupomErro && (
            <p className="mt-2 text-[11px] text-zinc-400">Se houver frete gratis ou desconto fixo/percentual, ele sera refletido no total logo abaixo.</p>
          )}
        </div>

        {config.desconto_primeiro_cliente_ativo && (
          <div
            className={`rounded-2xl border p-4 shadow-sm ${modalStep !== 2 ? 'hidden' : ''} ${
              descontoPrimeiroCliente > 0
                ? isLightCheckout
                  ? 'border-amber-200 bg-amber-50'
                  : 'border-amber-500/20 bg-amber-500/10'
                : isLightCheckout
                  ? 'border-zinc-200 bg-zinc-50'
                  : 'border-white/10 bg-zinc-900'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p
                  className={`text-sm font-black ${
                    descontoPrimeiroCliente > 0
                      ? isLightCheckout
                        ? 'text-amber-900'
                        : 'text-amber-200'
                      : isLightCheckout
                        ? 'text-zinc-900'
                        : 'text-white'
                  }`}
                >
                  Primeira compra
                </p>
                <p
                  className={`mt-1 text-xs ${
                    descontoPrimeiroCliente > 0
                      ? isLightCheckout
                        ? 'text-amber-800'
                        : 'text-amber-100'
                      : isLightCheckout
                        ? 'text-zinc-600'
                        : 'text-zinc-400'
                  }`}
                >
                  {resumoAtual.primeiro_cliente.mensagem}
                </p>
              </div>
              {descontoPrimeiroCliente > 0 && (
                <span
                  className={
                    isLightCheckout
                      ? 'rounded-full bg-amber-100 px-2.5 py-1 text-xs font-black text-amber-900'
                      : 'rounded-full bg-amber-500/20 px-2.5 py-1 text-xs font-black text-amber-200'
                  }
                >
                  -{fmt(descontoPrimeiroCliente)}
                </span>
              )}
            </div>
            {resumoAtual.primeiro_cliente.descricao && (
              <p className={`mt-2 text-[11px] ${isLightCheckout ? 'text-zinc-500' : 'text-zinc-400'}`}>
                Regra configurada: {resumoAtual.primeiro_cliente.descricao}
              </p>
            )}
          </div>
        )}

        {erro && (
          <div
            className={
              isLightCheckout
                ? 'flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800'
                : 'flex items-center gap-2 rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200'
            }
          >
            <X size={14} className="shrink-0" />
            {erro}
          </div>
        )}

        {modalStep === 3 && (
          <div className="space-y-3 pb-1">
            <ResumoComercialLinhas
              resumo={resumoAtual}
              descontoPixPercentual={descontoPixPercentual}
              zonaFallback={zonaResumo}
              bairroFallback={bairroResumo}
              tipoAtendimento={tipoAtendimento}
              temZonasEntrega={temZonas}
              mensagemAuxiliar={
                carregandoResumo
                  ? 'Atualizando beneficios e total...'
                  : tipoAtendimento == null
                    ? 'Escolha entrega ou retirada para validar o total final do pedido.'
                    : usandoResumoFallback
                      ? 'Total estimado ate concluir a validacao do checkout.'
                      : null
              }
            />
            <div className={cx.resumoCard}>
              <p className={`text-[11px] font-bold uppercase tracking-wider ${checkoutTheme.mode === 'light_red' ? 'text-zinc-500' : 'text-zinc-500'}`}>Forma de pagamento</p>
              <p className={`mt-1 font-black ${checkoutTheme.mode === 'light_red' ? 'text-zinc-900' : 'text-white'}`}>
                {pag === 'pix' ? 'Pix' : pag === 'dinheiro' ? 'Dinheiro' : 'Cartão (débito ou crédito)'}
              </p>
              {pag === 'pix' ? (
                <p className={`mt-2 text-xs ${checkoutTheme.mode === 'light_red' ? 'text-zinc-600' : 'text-zinc-400'}`}>
                  Total a pagar agora (Pix): <span className={`font-black ${checkoutTheme.mode === 'light_red' ? 'text-red-700' : 'text-cyan-300'}`}>{fmt(tot)}</span>
                </p>
              ) : (
                <>
                  <p className={`mt-2 text-xs ${checkoutTheme.mode === 'light_red' ? 'text-zinc-600' : 'text-zinc-400'}`}>
                    Total do pedido: <span className={`font-black ${checkoutTheme.mode === 'light_red' ? 'text-red-700' : 'text-cyan-300'}`}>{fmt(tot)}</span>
                  </p>
                  <p className={`mt-1.5 text-xs ${checkoutTheme.mode === 'light_red' ? 'text-zinc-500' : 'text-zinc-500'}`}>
                    Cobrança {ondePagaPresencial}
                    {pag === 'dinheiro' && precisaTroco && troco && parseFloat(troco.replace(',', '.')) > tot && (
                      <> · Troco para <span className={`font-semibold ${checkoutTheme.mode === 'light_red' ? 'text-zinc-800' : 'text-zinc-300'}`}>R$ {troco}</span> (troco de {fmt(parseFloat(troco.replace(',', '.')) - tot)})</>
                    )}
                  </p>
                </>
              )}
            </div>
            <div className={`${cx.resumoCard} text-xs ${checkoutTheme.mode === 'light_red' ? 'text-zinc-600' : 'text-zinc-300'}`}>
              Confira subtotal, taxa, descontos e total antes de confirmar.
            </div>
            {tipoAtendimento === 'entrega' &&
              (nomeQuemRecebe.trim() || contatoRecebimento.trim() || obsEntrega.trim()) && (
              <div className={cx.resumoCard}>
                <p className={`text-[11px] font-bold uppercase tracking-wider ${checkoutTheme.mode === 'light_red' ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  Entrega — quem recebe / contato / obs.
                </p>
                <div className={`mt-2 space-y-1.5 text-sm ${checkoutTheme.mode === 'light_red' ? 'text-zinc-800' : 'text-zinc-100'}`}>
                  {nomeQuemRecebe.trim() ? (
                    <p>
                      <span className={`font-bold ${checkoutTheme.mode === 'light_red' ? 'text-zinc-600' : 'text-zinc-400'}`}>Quem recebe: </span>
                      {nomeQuemRecebe.trim()}
                    </p>
                  ) : null}
                  {contatoRecebimento.trim() ? (
                    <p>
                      <span className={`font-bold ${checkoutTheme.mode === 'light_red' ? 'text-zinc-600' : 'text-zinc-400'}`}>Contato no local: </span>
                      {contatoRecebimento.trim()}
                    </p>
                  ) : null}
                  {obsEntrega.trim() ? (
                    <p>
                      <span className={`font-bold ${checkoutTheme.mode === 'light_red' ? 'text-zinc-600' : 'text-zinc-400'}`}>Obs. entrega: </span>
                      {obsEntrega.trim()}
                    </p>
                  ) : null}
                </div>
              </div>
            )}
            {pag === 'pix' && (
              <div className={`${cx.resumoCard} text-xs ${checkoutTheme.mode === 'light_red' ? 'text-zinc-600' : 'text-zinc-300'}`}>
                O QR Code final e o copia e cola deste pedido serao exibidos logo apos confirmar.
              </div>
            )}
            {false && pag === 'pix' && (
              <div className="space-y-2">
                <button
                  type="button"
                  className={`flex w-full items-center justify-center gap-2 rounded-xl border-2 py-3.5 text-sm font-black transition-all ${
                    isLightCheckout
                      ? 'border-zinc-200 bg-white text-zinc-800 hover:border-red-300'
                      : 'border-white/15 bg-zinc-950 text-zinc-100 hover:border-cyan-500/40'
                  }`}
                >
                  <CheckCircle2 size={18} />
                  Já confirmei o pagamento
                </button>
              </div>
            )}
          </div>
        )}
        </div>

        <div className={cx.footerBar}>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleFooterVoltar}
              disabled={enviando}
              className={cx.footerBack}
            >
              <ArrowLeft size={18} className="opacity-90" />
              Voltar
            </button>
            <button
              type="button"
              onClick={handleFooterPrimario}
              disabled={enviando || (modalStep === 3 && carregandoResumo)}
              className={cx.footerPrimary}
            >
              {enviando && modalStep === 3 ? (
                <div
                  className={`h-5 w-5 shrink-0 animate-spin rounded-full border-2 ${
                    isLightCheckout ? 'border-white/35 border-t-white' : 'border-zinc-950/30 border-t-zinc-950'
                  }`}
                />
              ) : modalStep === 3 ? (
                <CheckCircle2 size={18} className="shrink-0" />
              ) : modalStep === 2 ? (
                pag === 'pix' ? (
                  <CheckCircle2 size={18} className="shrink-0" />
                ) : (
                  <ChevronRight size={18} className="shrink-0" />
                )
              ) : (
                <ChevronRight size={18} className="shrink-0" />
              )}
              <span className="truncate">
                {modalStep === 3
                  ? (enviando ? 'Enviando...' : 'Confirmar pedido')
                  : modalStep === 2 /*
                      ? 'Já fiz o pagamento'
                    */ ? 'Continuar para confirmar'
                    : 'Continuar'}
              </span>
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

const PIX_WAITING_PAYMENT_STATUSES = new Set([
  'aguardando_pagamento',
  'aguardando_confirmacao',
  'pending',
  'pendente',
  'in_process',
]);

const PIX_PAID_PAYMENT_STATUSES = new Set([
  'pago',
  'paid',
  'approved',
]);

function normalizePixPaymentStatus(status: unknown): string {
  return String(status || '').trim().toLowerCase();
}

function isPixPaidStatus(status: unknown): boolean {
  return PIX_PAID_PAYMENT_STATUSES.has(normalizePixPaymentStatus(status));
}

function isPixWaitingStatus(status: unknown): boolean {
  const key = normalizePixPaymentStatus(status);
  return key ? PIX_WAITING_PAYMENT_STATUSES.has(key) : false;
}

function TelaConfirmado({ pedidoOk, config, slug, tipoAtendimento, clienteToken, onNovo }: { pedidoOk: PedidoConfirmado;config:Config;slug:string;tipoAtendimento: TipoAtendimento;clienteToken:string|null;onNovo:()=>void }) {
  const isPix = pedidoOk.pagamento_tipo === 'pix';
  const isRetirada = pedidoOk.canal === 'retirada' || tipoAtendimento === 'retirada';
  const [acompanharOpen, setAcompanharOpen] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const [pixPayload, setPixPayload] = useState('');
  const [pagamentoStatus, setPagamentoStatus] = useState<string | null>(
    pedidoOk.pagamento_status || (isPix ? 'aguardando_confirmacao' : null)
  );
  const [paymentPix, setPaymentPix] = useState<PedidoConfirmado['payment_pix']>(pedidoOk.payment_pix || null);
  const [configPixPedido, setConfigPixPedido] = useState<Partial<Config>>(pedidoOk.config_pix || {});

  // Mescla o payload do pedido com a config carregada para nao perder campos opcionais como whatsapp.
  const pxConf = { ...config, ...configPixPedido } as Config;
  const pagamentoStatusKey = normalizePixPaymentStatus(pagamentoStatus);
  const paymentPixStatusKey = normalizePixPaymentStatus(paymentPix?.status);
  const pixPago = isPixPaidStatus(pagamentoStatusKey) || isPixPaidStatus(paymentPixStatusKey);
  const pixAguardandoPagamento = !pixPago && (
    isPixWaitingStatus(pagamentoStatusKey)
    || isPixWaitingStatus(paymentPixStatusKey)
    || (!pagamentoStatusKey && !paymentPixStatusKey)
  );
  const statusPagamentoPix = pixPago ? 'Pagamento confirmado' : 'Aguardando pagamento';
  const pixQrImageBase64 =
    paymentPix?.qr_code_base64 ||
    paymentPix?.qr_code_image_base64 ||
    pxConf.qr_code_image_base64 ||
    null;
  const temPix = Boolean(
    paymentPix?.qr_code_text ||
    pixQrImageBase64 ||
    pxConf.pix_chave ||
    pxConf.pix_payload_estatico ||
    pixPayload
  );

  useEffect(() => {
    if (!isPix) return;

    let active = true;
    const syncPedido = async () => {
      try {
        const response = await fetch(`/public/delivery/${slug}/pedido/${pedidoOk.orderId}`);
        if (!response.ok) return;

        const body = await response.json();
        if (!active) return;

        setPagamentoStatus(body?.pedido?.pagamento_status || null);
        if (body?.payment_pix) setPaymentPix(body.payment_pix);
        if (body?.config_pix) setConfigPixPedido(body.config_pix);
      } catch {
        // Mantem os dados atuais quando a consulta falhar.
      }
    };

    void syncPedido();
    if (pixPago || !pixAguardandoPagamento) {
      return () => {
        active = false;
      };
    }

    const timer = setInterval(() => { void syncPedido(); }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [isPix, pedidoOk.orderId, pixAguardandoPagamento, pixPago, slug]);

  useEffect(() => {
    if (!isPix) return;
    if (paymentPix?.qr_code_text) {
      setPixPayload(paymentPix.qr_code_text);
      return;
    }
    if (pxConf.pix_payload_estatico) {
      setPixPayload(injetarValorPix(pxConf.pix_payload_estatico, pedidoOk.total));
      return;
    }
    if (pxConf.pix_chave) {
      setPixPayload(gerarPixPayload(
        pxConf.pix_chave,
        pxConf.pix_nome || 'Estabelecimento',
        pxConf.pix_cidade || 'Brasil',
        pedidoOk.total
      ));
    }
  }, [isPix, paymentPix?.qr_code_text, pxConf, pedidoOk.total]);

  const copiar = async () => {
    try { await navigator.clipboard.writeText(pixPayload); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = pixPayload; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    }
    setCopiado(true); setTimeout(()=>setCopiado(false), 4000);
  };

  const confirmando = false;
  const confirmarPagamento = () => undefined;

  const waNumber = pxConf.whatsapp?.replace(/\D/g,'');
  const waMsgPix = waNumber ? `https://wa.me/55${waNumber}?text=${encodeURIComponent(`🧾 *Comprovante Pix — Pedido #${pedidoOk.orderNumber}*\n\nOlá! Acabei de realizar o pagamento de *${fmt(pedidoOk.total)}* via Pix.\n\n📎 Segue o comprovante em anexo.`)}` : null;
  const waMsgEntrega = waNumber ? `https://wa.me/55${waNumber}?text=${encodeURIComponent(`✅ *Pedido Confirmado #${pedidoOk.orderNumber}*\n\nOlá! Meu pedido foi confirmado. Aguardo a entrega!\n💰 Pagarei *${fmt(pedidoOk.total)}* ${pedidoOk.pagamento_tipo === 'dinheiro' ? 'em dinheiro' : 'no cartão'} na entrega.`)}` : null;
  const waMsgOperacao = isRetirada ? null : waMsgEntrega;

  const headerPedidoConfirmado = !isPix || pixPago;
  const mostrarInstrucoesPixPosPedido = isPix && !pixPago;
  const mostrarBlocoPixConfirmado = isPix && pixPago;

  return (
    <>
    <div className="min-h-screen bg-zinc-50">
      <div className={`${headerPedidoConfirmado ? 'bg-zinc-900' : 'bg-amber-500'} px-4 pt-12 pb-8 text-center`}>
        <motion.div initial={{scale:0}} animate={{scale:1}} transition={{delay:0.1,type:'spring'}}
          className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-3">
          {headerPedidoConfirmado ? <CheckCircle2 size={36} className="text-white"/> : <Smartphone size={36} className="text-white"/>}
        </motion.div>
        <h2 className="text-2xl font-black text-white">
          {isPix && !pixPago ? 'Aguardando pagamento Pix' : 'Pedido confirmado!'}
        </h2>
        <p className="text-white/80 text-sm mt-1">#{pedidoOk.orderNumber}</p>
        <p className="text-4xl font-black text-white mt-2">{fmt(pedidoOk.total)}</p>
      </div>

      <div className="max-w-sm mx-auto px-4 py-5 space-y-4">

        {/* ── FLUXO PIX (legado: pedidos que não passaram pelo checkout modal) ── */}
        {mostrarInstrucoesPixPosPedido && (
          <div className="space-y-3">
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
              <p className="text-xs font-black uppercase tracking-wider text-amber-800">Status do pagamento</p>
              <div className="mt-2 flex items-center justify-between gap-3">
                <div>
                  <p className="text-lg font-black text-amber-950">{statusPagamentoPix}</p>
                  <p className="mt-1 text-sm text-amber-900/90">Atualizacao automatica a cada 3 segundos.</p>
                </div>
                <Loader2 size={18} className="shrink-0 animate-spin text-amber-700" />
              </div>
            </div>
            {temPix ? (
              <div className="bg-white rounded-2xl p-4 shadow-sm space-y-4">
                <div className="flex justify-center">
                  <div className="rounded-2xl border border-zinc-100 bg-white p-3 shadow-sm">
                    <img
                      src={
                        pixQrImageBase64
                          ? `data:image/png;base64,${pixQrImageBase64}`
                          : `https://api.qrserver.com/v1/create-qr-code/?size=192x192&ecc=M&data=${encodeURIComponent(pixPayload)}`
                      }
                      alt="QR Code Pix"
                      width={192}
                      height={192}
                      className="h-48 w-48 max-w-full rounded-xl object-contain"
                      onError={e=>{(e.target as HTMLImageElement).style.display='none';}}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={copiar}
                  disabled={!pixPayload}
                  className={`flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-black transition-all ${
                    copiado
                      ? 'bg-cyan-600 text-white'
                      : 'bg-zinc-900 text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400'
                  }`}
                >
                  <Copy size={18} />
                  {copiado ? 'Codigo Pix copiado' : 'Copiar codigo Pix'}
                </button>
              </div>
            ) : (
              <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                Nao foi possivel carregar o QR Code deste pedido agora.
              </div>
            )}
            {false && (<div className="bg-white rounded-2xl shadow-sm overflow-hidden">
              <div className="bg-amber-50 px-4 py-3 border-b border-amber-100">
                <p className="font-black text-amber-800 text-sm">Como pagar agora</p>
              </div>
              <div className="p-4 space-y-3">
                {[
                  'Abra o app do seu banco',
                  'Escolha Pix → Pagar → "Copia e Cola"',
                  'Cole o código abaixo',
                  'Confirme o pagamento',
                ].map((s,i) => (
                  <div key={i} className="flex items-center gap-3">
                    <span className="w-6 h-6 rounded-full bg-amber-500 text-white text-xs font-black flex items-center justify-center shrink-0">{i+1}</span>
                    <span className="text-sm text-zinc-700">{s}</span>
                  </div>
                ))}
              </div>
            </div>)}

            {false && temPix && (
            <div className="bg-white rounded-2xl p-4 shadow-sm">
              <p className="text-xs font-black text-zinc-500 uppercase tracking-wider mb-3">Abrir direto no seu banco</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {BANCOS_DEEPLINK.map(b => (
                  <button
                    key={b.nome}
                    type="button"
                    onClick={() => window.location.assign(b.link(pixPayload))}
                    className="flex min-h-[44px] flex-col items-center gap-1 rounded-xl border border-zinc-100 py-2 px-1 transition-all hover:bg-zinc-50 active:scale-95"
                  >
                    <span className="text-xl leading-none">{b.logo}</span>
                    <span className="text-[9px] font-bold text-zinc-500 text-center leading-tight">{b.nome}</span>
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-zinc-400 text-center mt-2">Toque no banco para abrir direto no app</p>
            </div>
            )}
            {false && temPix && (
            <div className="bg-white rounded-2xl p-4 shadow-sm space-y-3">
              <p className="text-xs font-black text-zinc-500 uppercase tracking-wider">Pix Copia e Cola</p>
              <div className="flex justify-center">
                <div className="p-2 bg-zinc-50 border border-zinc-200 rounded-xl">
                  <img
                    src={
                      pixQrImageBase64
                        ? `data:image/png;base64,${pixQrImageBase64}`
                        : `https://api.qrserver.com/v1/create-qr-code/?size=160x160&ecc=M&data=${encodeURIComponent(pixPayload)}`
                    }
                    alt="QR Code Pix" width={160} height={160}
                    className="rounded-lg"
                    onError={e=>{(e.target as HTMLImageElement).style.display='none';}}
                  />
                </div>
              </div>
              <div className="bg-zinc-50 rounded-xl px-4 py-3 space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-500">Chave Pix</span>
                  <span className="font-bold text-zinc-800 font-mono">{pxConf.pix_chave || paymentPix?.provider || 'Código Estático QR'}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-500">Valor</span>
                  <span className="font-black text-cyan-700">{fmt(pedidoOk.total)}</span>
                </div>
                {pxConf.pix_nome && (
                  <div className="flex justify-between text-sm">
                    <span className="text-zinc-500">Recebedor</span>
                    <span className="font-bold text-zinc-700">{pxConf.pix_nome}</span>
                  </div>
                )}
                {paymentPix?.expires_at && (
                  <div className="flex justify-between text-sm">
                    <span className="text-zinc-500">Expira em</span>
                    <span className="font-bold text-zinc-700">{new Date(paymentPix.expires_at).toLocaleString('pt-BR')}</span>
                  </div>
                )}
                {(paymentPix?.external_reference || pxConf.payment_external_reference) && (
                  <div className="flex justify-between text-sm">
                    <span className="text-zinc-500">Referencia</span>
                    <span className="font-bold text-zinc-700 font-mono">{paymentPix?.external_reference || pxConf.payment_external_reference}</span>
                  </div>
                )}
              </div>
              <button onClick={copiar}
                className={`w-full py-3 rounded-xl font-black text-sm transition-all flex items-center justify-center gap-2 ${copiado?'bg-cyan-600 text-white':'bg-zinc-900 hover:bg-zinc-800 text-white'}`}>
                {copiado ? '✓ Código copiado!' : '📋 Copiar código Pix'}
              </button>
            </div>
            )}

            <div className="hidden">
            <button onClick={confirmarPagamento} disabled={confirmando}
              className={`hidden w-full py-4 rounded-2xl font-black text-base transition-all items-center justify-center gap-2 shadow-lg ${
                copiado ? 'bg-cyan-600 hover:bg-cyan-700 text-white shadow-cyan-200' : 'bg-zinc-200 text-zinc-400 cursor-not-allowed'
              }`}>
              {confirmando ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"/> : <CheckCircle2 size={20}/>}
              {confirmando ? 'Confirmando...' : 'Já fiz o pagamento ✓'}
            </button>
            <p className="text-xs text-zinc-400 text-center -mt-2">O botão libera após copiar o código Pix</p>

            </div>
            <button
              type="button"
              onClick={() => setAcompanharOpen(true)}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-zinc-200 bg-white py-3.5 text-sm font-bold text-zinc-700 transition-all hover:bg-zinc-50"
            >
              <Clock size={16}/>Acompanhar pedido
            </button>
            {waMsgPix && copiado && (
              <button
                type="button"
                onClick={() => window.location.assign(waMsgPix)}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-green-500 py-3.5 text-sm font-bold text-white transition-all hover:bg-green-600"
              >
                <Smartphone size={16}/>Enviar comprovante pelo WhatsApp
              </button>
            )}
            {waMsgPix && !copiado && (
              <p className="text-center text-xs text-zinc-400">
                Copie o código Pix acima e finalize o pagamento para liberar o envio do comprovante.
              </p>
            )}
          </div>
        )}

        {/* ── PIX CONFIRMADO / checkout modal já com Pix na etapa de pagamento ── */}
        {mostrarBlocoPixConfirmado && (
          <div className="space-y-3">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4 [&>p]:hidden">
              <div>
                <p className="text-xs font-black uppercase tracking-wider text-emerald-800">Status do pagamento</p>
                <p className="mt-1 text-lg font-black text-emerald-950">{statusPagamentoPix}</p>
                <p className="mt-1 text-sm text-emerald-900/90">Tela atualizada automaticamente apos a confirmacao do Pix.</p>
              </div>
              <p className="text-lg font-black text-amber-950">Pagamento confirmado ✓</p>
              <p className="mt-1 text-sm text-amber-900/90">Pedido registrado — acompanhe o preparo abaixo quando quiser.</p>
            </div>
            <button
              type="button"
              onClick={() => setAcompanharOpen(true)}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-zinc-200 bg-white py-3.5 text-sm font-bold text-zinc-700 transition-all hover:bg-zinc-50"
            >
              <Clock size={16}/>Acompanhar pedido
            </button>
            {false && (<div className="bg-white rounded-2xl p-4 shadow-sm flex items-center gap-3">
              <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center shrink-0"><Clock size={20} className="text-amber-500"/></div>
              <div><p className="text-xs text-zinc-400">Tempo estimado</p><p className="font-black text-zinc-900">{config.tempo_preparo||35}–{(config.tempo_preparo||35)+10} min</p></div>
            </div>)}
            {waMsgPix && (
              <button
                type="button"
                onClick={() => window.location.assign(waMsgPix)}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-green-500 py-3.5 text-sm font-bold text-white transition-all hover:bg-green-600"
              >
                <Smartphone size={16}/>Enviar comprovante pelo WhatsApp
              </button>
            )}
          </div>
        )}

        {/* ── DINHEIRO / CARTÃO ── */}
        {!isPix && (
          <div className="space-y-3">
            <div className="bg-white rounded-2xl p-5 shadow-sm space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center shrink-0"><Clock size={20} className="text-amber-500"/></div>
                <div><p className="text-xs text-zinc-400">Tempo estimado</p><p className="font-black text-zinc-900">{config.tempo_preparo||35}–{(config.tempo_preparo||35)+10} min</p></div>
              </div>
              <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3">
                {pedidoOk.pagamento_tipo==='dinheiro' ? <Banknote size={20} className="shrink-0 text-amber-700"/> : <CreditCard size={20} className="shrink-0 text-amber-700"/>}
                <div>
                  <p className="text-xs font-bold text-amber-800/90">{isRetirada ? 'Pagamento na retirada' : 'Pagamento na entrega'}</p>
                  <p className="font-bold text-amber-950">{pedidoOk.pagamento_tipo==='dinheiro'?'Dinheiro':'Cartão'} — <span className="text-amber-900">{fmt(pedidoOk.total)}</span></p>
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setAcompanharOpen(true)}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-zinc-900 py-3.5 text-sm font-bold text-white transition-all hover:bg-zinc-800"
            >
              <Clock size={16}/>Acompanhar pedido online
            </button>
            {waMsgOperacao && !pedidoOk.waLink && (
              <a href={waMsgOperacao} target="_blank" rel="noreferrer"
                className="flex items-center justify-center gap-2 w-full py-3.5 bg-green-500 hover:bg-green-600 text-white rounded-2xl font-bold text-sm transition-all">
                <Smartphone size={16}/>Acompanhar pedido no WhatsApp
              </a>
            )}
          </div>
        )}

        {/* ── Cupom do Pedido ── */}
        {pedidoOk.itens && pedidoOk.itens.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm overflow-hidden border border-zinc-100">
            <div className="bg-zinc-800 px-4 py-3 flex items-center justify-between">
              <p className="font-black text-white text-sm">🧾 Cupom #{pedidoOk.orderNumber}</p>
              <p className="text-zinc-400 text-xs">{new Date().toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</p>
            </div>
            <div className="p-4 space-y-2">
              {pedidoOk.itens.map((it: any, i: number) => (
                <div key={i} className="flex items-start justify-between gap-2 py-1.5 border-b border-zinc-50 last:border-0">
                  <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-zinc-800">{it.qty}× {it.name}</p>
                        {it.obs_opcoes && <p className="text-[10px] text-zinc-400 mt-0.5">{it.obs_opcoes}</p>}
                      </div>
                  <p className="text-sm font-bold text-zinc-700 shrink-0">{fmt(it.preco_final*it.qty)}</p>
                </div>
              ))}
              <div className="pt-2 space-y-1 text-sm">
                <div className="flex justify-between text-zinc-500">
                  <span>Pagamento</span>
                  <span className="font-semibold capitalize">{pedidoOk.pagamento_tipo === 'pix' ? '💚 Pix' : pedidoOk.pagamento_tipo === 'dinheiro' ? '💵 Dinheiro' : '💳 Cartão'}</span>
                </div>
                <div className="flex justify-between font-black text-zinc-900 text-base pt-1 border-t border-zinc-100">
                  <span>Total</span>
                  <span className="text-cyan-700">{fmt(pedidoOk.total)}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        <button onClick={onNovo} className="w-full py-3 bg-white border border-zinc-200 hover:bg-zinc-50 text-zinc-600 rounded-2xl font-bold text-sm transition-all">
          Fazer novo pedido
        </button>
      </div>
    </div>
    <ModalAcompanharPedido
      open={acompanharOpen}
      onClose={() => setAcompanharOpen(false)}
      slug={slug}
      pedidoId={pedidoOk.orderId}
    />
    </>
  );
}

const BR_MOBILE_NACIONAL_LEN = 11;

function clampDeliveryCardapioMobileDigits(raw: string): string {
  let d = normalizeBrazilDeliveryPhoneDigits(raw);
  if (d.length > BR_MOBILE_NACIONAL_LEN) d = d.slice(0, BR_MOBILE_NACIONAL_LEN);
  return d;
}

/** Máscara (XX) XXXXX-XXXX para celular BR (11 dígitos nacionais após normalização). */
function formatDeliveryCardapioMobileDisplay(nacionalDigits: string): string {
  const d = nacionalDigits.replace(/\D/g, '');
  if (!d.length) return '';
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  const sub = d.slice(2);
  return `(${d.slice(0, 2)}) ${sub.slice(0, 5)}-${sub.slice(5)}`;
}

/** Celular BR com DDD: 11 dígitos, nono dígito (primeiro da linha) = 9. */
function isDeliveryCardapioMobileComplete(nacionalDigits: string): boolean {
  const d = normalizeBrazilDeliveryPhoneDigits(nacionalDigits);
  if (d.length !== BR_MOBILE_NACIONAL_LEN) return false;
  if (d[0] === '0') return false;
  return d[2] === '9';
}

function TelaIdentificar({ slug, tipoAtendimento, contexto, onSuccess, onBack }: { slug:string;tipoAtendimento: TipoAtendimento | null;contexto:'checkout'|'geral';onSuccess:(t:string,c:ClienteAuth)=>void;onBack:()=>void }) {
  const th = useDeliveryCardapioTheme();
  const isLightRed = th.mode === 'light_red';
  const [etapa, setEtapa] = useState<'tel'|'dados'>('tel');
  const [telDigits, setTelDigits] = useState('');
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [endLogradouro, setEndLogradouro] = useState('');
  const [endNumero, setEndNumero] = useState('');
  const [endBairro, setEndBairro] = useState('');
  const [endRef, setEndRef] = useState('');
  const [load, setLoad] = useState(false);
  const [erro, setErro] = useState('');
  const [telNorm, setTelNorm] = useState('');
  const inp="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-3.5 text-base focus:border-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-50 transition-all sm:px-4 sm:text-sm";

  const verificarTel=async()=>{
    if (!isDeliveryCardapioMobileComplete(telDigits)) return;
    setErro('');setLoad(true);
    try{
      const r=await fetch(`/public/delivery/${slug}/auth/identificar`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:telDigits})});
      const d=await r.json();
      if(!d.success){setErro(d.error||'Erro');return;}
      if(d.novo){setTelNorm(d.telefone);setEtapa('dados');}else onSuccess(d.token,d.cliente);
    }catch{setErro('Erro de conexão');}finally{setLoad(false);}
  };

  const cadastrar=async()=>{
    setErro('');
    if(!nome.trim()){setErro('Informe seu nome');return;}
    if(tipoAtendimento==='entrega' && !endLogradouro.trim()){setErro('Informe a rua/avenida');return;}
    setLoad(true);
    try{
      const r=await fetch(`/public/delivery/${slug}/auth/cadastrar`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefone:telNorm,nome,email})});
      const d=await r.json();
      if(!d.success){setErro(d.error||'Erro');return;}
      if (tipoAtendimento === 'entrega') {
        await fetch(`/public/delivery/${slug}/cliente/enderecos`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${d.token}`},body:JSON.stringify({label:'Casa',logradouro:endLogradouro,numero:endNumero,bairro:endBairro,referencia:endRef,principal:true})});
      }
      onSuccess(d.token,d.cliente);
    }catch{setErro('Erro de conexão');}finally{setLoad(false);}
  };

  return (
    <div className="flex min-h-screen flex-col bg-[#f8f8f8]">
      <header className="flex items-center gap-3 border-b border-zinc-100 bg-white px-3 py-3 shadow-sm sm:px-4 sm:py-4">
        <button type="button" onClick={etapa==='dados'?()=>setEtapa('tel'):onBack} className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full p-2 hover:bg-zinc-100"><ArrowLeft size={20} className="text-zinc-700"/></button>
        <div><p className="text-lg font-black text-zinc-900">{etapa==='tel'?(contexto==='checkout'?'Entre para continuar sua compra':'Entrar / Criar conta'):'Complete seu cadastro'}</p>
        {etapa==='dados'&&<p className="text-xs text-zinc-400">{contexto==='checkout'?'Preencha os dados para seguir ao checkout':'Preencha os dados para finalizar'}</p>}</div>
      </header>
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center space-y-5 px-4 py-6 sm:px-5 sm:py-8">
        {etapa==='tel'?(
          <>
            <div className="text-center">
              <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg ${isLightRed ? 'bg-red-600 shadow-red-200/50' : 'bg-cyan-600 shadow-cyan-200'}`}><Smartphone size={28} className="text-white"/></div>
              <h3 className={`text-xl font-black ${isLightRed ? 'text-[#18181b]' : 'text-white'}`}>Qual é o seu número?</h3>
              <p className="text-sm text-zinc-400 mt-1">{contexto==='checkout'?'Entre rapidamente para salvar seus dados e continuar o pedido sem retrabalho.':'Para identificar sua conta e enviar atualizações'}</p>
            </div>
            <div>
              <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider block mb-1.5">Telefone / WhatsApp</label>
              <input
                value={formatDeliveryCardapioMobileDisplay(telDigits)}
                onChange={(e) => setTelDigits(clampDeliveryCardapioMobileDigits(e.target.value))}
                placeholder="(85) 99999-0000"
                type="tel"
                inputMode="numeric"
                autoComplete="tel-national"
                className={inp}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && isDeliveryCardapioMobileComplete(telDigits)) void verificarTel();
                }}
              />
            </div>
            {erro&&<div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600 flex items-center gap-2"><X size={14}/>{erro}</div>}
            <button onClick={verificarTel} disabled={load||!isDeliveryCardapioMobileComplete(telDigits)} className={`w-full py-4 text-white rounded-2xl font-black flex items-center justify-center gap-2 transition-all active:scale-[0.98] disabled:bg-zinc-300 ${isLightRed ? 'bg-red-600 hover:bg-red-700' : 'bg-zinc-900 hover:bg-zinc-800'}`}>
              {load?<div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"/>:<>{contexto==='checkout'?'Continuar compra':'Continuar'}<ChevronRight size={16}/></>}
            </button>
            <p className="text-center text-xs text-zinc-400">{contexto==='checkout'?'Sem senha e sem complicacao: entre e volte direto para o fechamento.':'Sem senha — rápido e simples!'}</p>
          </>
        ):(
          <>
            <div className="bg-cyan-50 border border-cyan-200 rounded-2xl px-4 py-3 flex items-center gap-3">
              <div className="w-8 h-8 bg-cyan-600 rounded-full flex items-center justify-center"><Smartphone size={14} className="text-white"/></div>
              <div><p className="text-xs text-zinc-500">Número</p><p className="font-black text-cyan-700">{telNorm}</p></div>
            </div>
            {/* Dados pessoais */}
            <div className="bg-white rounded-2xl p-4 shadow-sm space-y-3">
              <p className="font-black text-zinc-900 text-sm flex items-center gap-2"><User size={14} className="text-cyan-600"/>Dados pessoais</p>
              <div><label className="text-xs font-bold text-zinc-500 uppercase tracking-wider block mb-1.5">Nome completo *</label><input value={nome} onChange={e=>setNome(e.target.value)} placeholder="João Silva" className={inp}/></div>
              <div><label className="text-xs font-bold text-zinc-500 uppercase tracking-wider block mb-1.5">E-mail (opcional)</label><input value={email} onChange={e=>setEmail(e.target.value)} placeholder="joao@email.com" type="email" className={inp}/></div>
            </div>
            {/* Endereço */}
            {tipoAtendimento === 'retirada' && (
              <div className="bg-cyan-50 border border-cyan-200 rounded-2xl px-4 py-3 text-sm text-cyan-700">
                Retirada no local selecionada. O cadastro segue sem pedir endereco.
              </div>
            )}
            {tipoAtendimento == null && contexto === 'checkout' && (
              <div className="bg-cyan-50 border border-cyan-200 rounded-2xl px-4 py-3 text-sm text-cyan-700">
                Voce escolhe entrega ou retirada no proximo passo, dentro do checkout.
              </div>
            )}
            <div className={`bg-white rounded-2xl p-4 shadow-sm space-y-3 ${tipoAtendimento !== 'entrega' ? 'hidden' : ''}`}> 
              <p className="font-black text-zinc-900 text-sm flex items-center gap-2"><MapPin size={14} className="text-cyan-600"/>Endereço de entrega *</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="sm:col-span-2"><label className="text-xs font-bold text-zinc-500 uppercase tracking-wider block mb-1.5">Rua / Avenida *</label><input value={endLogradouro} onChange={e=>setEndLogradouro(e.target.value)} placeholder="Rua das Flores" className={inp}/></div>
                <div><label className="text-xs font-bold text-zinc-500 uppercase tracking-wider block mb-1.5">Nº</label><input value={endNumero} onChange={e=>setEndNumero(e.target.value)} placeholder="123" className={inp}/></div>
              </div>
              <div><label className="text-xs font-bold text-zinc-500 uppercase tracking-wider block mb-1.5">Bairro</label><input value={endBairro} onChange={e=>setEndBairro(e.target.value)} placeholder="Centro" className={inp}/></div>
              <div><label className="text-xs font-bold text-zinc-500 uppercase tracking-wider block mb-1.5">Referencia</label><input value={endRef} onChange={e=>setEndRef(e.target.value)} placeholder="Proximo ao mercado..." className={inp}/></div>
            </div>
            {erro&&<div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600 flex items-center gap-2"><X size={14}/>{erro}</div>}
            <button onClick={cadastrar} disabled={load||!nome.trim()||(tipoAtendimento==='entrega'&&!endLogradouro.trim())} className={`w-full py-4 text-white rounded-2xl font-black flex items-center justify-center gap-2 transition-all active:scale-[0.98] disabled:bg-zinc-300 ${isLightRed ? 'bg-red-600 hover:bg-red-700' : 'bg-zinc-900 hover:bg-zinc-800'}`}>
              {load?<div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"/>:<><CheckCircle2 size={16}/>Criar conta e continuar</>}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function TelaConta({ slug, token, cliente, onLogout, onBack, onHistorico, onEnderecos, onEditarPerfil }: { slug:string;token:string|null;cliente:ClienteAuth|null;onLogout:()=>void;onBack:()=>void;onHistorico:()=>void;onEnderecos:()=>void;onEditarPerfil:()=>void }) {
  const th = useDeliveryCardapioTheme();
  const isLightRed = th.mode === 'light_red';
  if(!cliente) return <div className="min-h-screen bg-white flex items-center justify-center"><button onClick={onBack} className="px-4 py-2 bg-zinc-100 rounded-xl text-sm">Voltar</button></div>;
  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col">
      <header className="bg-white border-b border-zinc-100 px-4 py-4 flex items-center gap-3 shadow-sm">
        <button onClick={onBack} className="p-2 hover:bg-zinc-100 rounded-full"><ArrowLeft size={20} className="text-zinc-700"/></button>
        <p className="text-lg font-black text-zinc-900">Minha Conta</p>
      </header>
      <div className="flex-1 p-4 max-w-2xl mx-auto w-full space-y-3">
        <div className={`rounded-3xl p-6 text-white flex items-center gap-4 shadow-lg ${isLightRed ? 'bg-gradient-to-br from-red-600 via-red-600 to-orange-600 shadow-red-200/40' : 'bg-gradient-to-br from-zinc-900 via-zinc-800 to-cyan-700 shadow-cyan-200'}`}>
          <div className="w-16 h-16 bg-white/20 rounded-2xl flex items-center justify-center text-3xl font-black">{cliente.nome[0].toUpperCase()}</div>
          <div className="flex-1 min-w-0"><p className="font-black text-xl truncate">{cliente.nome}</p><p className={`text-sm ${isLightRed ? 'text-red-50' : 'text-cyan-100'}`}>{cliente.telefone}</p>{cliente.email&&<p className={`text-xs mt-0.5 ${isLightRed ? 'text-white/90' : 'text-cyan-200'}`}>{cliente.email}</p>}</div>
          <button onClick={onEditarPerfil} className="p-2 bg-white/20 hover:bg-white/30 rounded-xl transition-colors"><Pencil size={15}/></button>
        </div>
        {[
          {icon:<History size={19}/>,color:'text-blue-500 bg-blue-50',label:'Histórico de Pedidos',sub:'Veja e repita pedidos anteriores',fn:onHistorico},
          {icon:<MapPin size={19}/>,color:'text-orange-500 bg-orange-50',label:'Meus Endereços',sub:'Gerencie seus endereços de entrega',fn:onEnderecos},
          {icon:<Heart size={19}/>,color:'text-red-500 bg-red-50',label:`Favoritos (${cliente.favoritos.length})`,sub:'Seus produtos curtidos',fn:onBack},
        ].map(item=>(
          <button key={item.label} onClick={item.fn} className="w-full bg-white border border-zinc-100 hover:shadow-md rounded-2xl p-4 flex items-center gap-4 transition-all text-left shadow-sm">
            <div className={`w-11 h-11 ${item.color} rounded-xl flex items-center justify-center shrink-0`}>{item.icon}</div>
            <div className="flex-1 min-w-0"><p className="font-bold text-zinc-900">{item.label}</p><p className="text-xs text-zinc-400">{item.sub}</p></div>
            <ChevronRight size={16} className="text-zinc-300 shrink-0"/>
          </button>
        ))}
        <button onClick={onLogout} className="w-full bg-white border border-red-100 hover:bg-red-50 rounded-2xl p-4 flex items-center gap-3 text-red-500 font-bold text-sm transition-all shadow-sm">
          <LogOut size={16}/>Sair da conta
        </button>
      </div>
    </div>
  );
}

function TelaEditarPerfil({ slug, token, cliente, onSaved, onBack }: { slug:string;token:string|null;cliente:ClienteAuth|null;onSaved:(c:ClienteAuth)=>void;onBack:()=>void }) {
  const th = useDeliveryCardapioTheme();
  const isLightRed = th.mode === 'light_red';
  const [nome, setNome]=useState(cliente?.nome||'');
  const [email, setEmail]=useState(cliente?.email||'');
  const [load, setLoad]=useState(false);
  const [erro, setErro]=useState('');
  const inp="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-3.5 text-base focus:border-cyan-400 focus:outline-none transition-all sm:px-4 sm:text-sm";
  const salvar=async()=>{
    if(!nome.trim()){setErro('Nome obrigatório');return;}
    setLoad(true);
    try{const r=await fetch(`/public/delivery/${slug}/cliente/perfil`,{method:'PUT',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},body:JSON.stringify({nome,email})});const d=await r.json();if(d.success)onSaved({...cliente!,nome:nome.trim(),email:email||undefined});else setErro(d.error||'Erro');}
    catch{setErro('Erro de conexão');}finally{setLoad(false);}
  };
  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col">
      <header className="bg-white border-b border-zinc-100 px-4 py-4 flex items-center gap-3 shadow-sm">
        <button onClick={onBack} className="p-2 hover:bg-zinc-100 rounded-full"><ArrowLeft size={20} className="text-zinc-700"/></button>
        <p className="text-lg font-black text-zinc-900">Editar Perfil</p>
      </header>
      <div className="flex-1 p-5 max-w-sm mx-auto w-full space-y-4 pt-8">
        <div><label className="text-xs font-bold text-zinc-500 uppercase tracking-wider block mb-1.5">Nome completo</label><input value={nome} onChange={e=>setNome(e.target.value)} className={inp}/></div>
        <div><label className="text-xs font-bold text-zinc-500 uppercase tracking-wider block mb-1.5">E-mail (opcional)</label><input value={email} onChange={e=>setEmail(e.target.value)} type="email" className={inp}/></div>
        <div className="bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-3 text-sm text-zinc-500 flex items-center gap-2"><Smartphone size={13} className="text-zinc-400"/>Telefone: <strong className="text-zinc-700">{cliente?.telefone}</strong> — fixo</div>
        {erro&&<div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">{erro}</div>}
        <button onClick={salvar} disabled={load} className={`w-full py-4 text-white rounded-2xl font-black flex items-center justify-center transition-all disabled:bg-zinc-300 ${isLightRed ? 'bg-red-600 hover:bg-red-700' : 'bg-zinc-900 hover:bg-zinc-800'}`}>
          {load?<div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"/>:'Salvar'}
        </button>
      </div>
    </div>
  );
}

function TelaHistorico({ slug, token, onBack, onRepetir, categorias }: { slug:string;token:string|null;onBack:()=>void;onRepetir:(items:CartItem[])=>void;categorias:Categoria[] }) {
  const th = useDeliveryCardapioTheme();
  const isLightRed = th.mode === 'light_red';
  const [pedidos, setPedidos]=useState<PedidoHist[]>([]);
  const [load, setLoad]=useState(true);
  useEffect(()=>{if(!token)return;fetch(`/public/delivery/${slug}/cliente/pedidos`,{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.ok?r.json():[]).then(d=>{if(Array.isArray(d))setPedidos(d);}).finally(()=>setLoad(false));},[token,slug]);
  const pm=useMemo(()=>{const m:Record<number,Produto>={};categorias.forEach(c=>c.itens.forEach(p=>{m[p.id]=p;}));return m;},[categorias]);
  const repetir=(p:PedidoHist)=>{
    const itens = Array.isArray(p.itens) ? p.itens : [];
    if (!itens.length) return;
    const toAdd: CartItem[]=[];
    for (const it of itens) {
      const produto = pm[it.product_id];
      if (!produto) continue;
      const vid = it.variation_id && Number.isInteger(Number(it.variation_id)) && Number(it.variation_id)>0 ? Number(it.variation_id) : null;
      const variacao = vid && produto.variacoes_vendaveis ? produto.variacoes_vendaveis.find(v=>v.id===vid) : null;
      const cartItem: CartItem = variacao
        ? { ...produto, name: `${produto.name} - ${variacao.nome}`, preco_final: Number(variacao.preco), cart_key: `${produto.id}_v${variacao.id}`, variation_id: variacao.id }
        : { ...produto, preco_final: Number(it.price_at_time||produto.price), cart_key: `${produto.id}_` };
      for (let q=0; q<Math.max(1, it.quantity); q++) toAdd.push({ ...cartItem, qty: 1 });
    }
    if (toAdd.length) onRepetir(toAdd);
  };
  const fd=(d:string)=>new Date(d.includes('T')?d:d.replace(' ','T')).toLocaleDateString('pt-BR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
  const statusCls = (s: string) =>
    isLightRed
      ? STATUS_COR_LIGHT[s] || 'border border-zinc-200 bg-zinc-100 text-zinc-700'
      : STATUS_COR[s] || 'border border-white/10 bg-white/5 text-zinc-300';
  return (
    <div className={`min-h-screen flex flex-col ${isLightRed ? 'bg-[#f6f6f4] text-zinc-900' : 'bg-zinc-950 text-zinc-100'}`}>
      <header className={`border-b px-4 py-4 ${isLightRed ? 'border-zinc-200 bg-white shadow-sm' : 'border-white/10 bg-zinc-950 shadow-[0_12px_40px_rgba(0,0,0,0.35)]'}`}>
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <button onClick={onBack} className={`rounded-full p-2 ${isLightRed ? 'hover:bg-zinc-100' : 'hover:bg-white/5'}`}><ArrowLeft size={20} className={isLightRed ? 'text-zinc-700' : 'text-zinc-200'}/></button>
          <div><p className={`text-lg font-black ${isLightRed ? 'text-zinc-900' : 'text-white'}`}>Historico</p><p className={`text-xs ${isLightRed ? 'text-zinc-500' : 'text-zinc-500'}`}>{pedidos.length} pedidos para repetir quando quiser</p></div>
        </div>
      </header>
      <div className="mx-auto flex-1 w-full max-w-2xl overflow-y-auto p-4 space-y-3">
        {load?<div className="flex justify-center py-16"><div className={`h-8 w-8 rounded-full border-2 animate-spin ${isLightRed ? 'border-zinc-200 border-t-red-600' : 'border-zinc-800 border-t-cyan-400'}`}/></div>
        :pedidos.length===0?<div className={`rounded-[30px] border border-dashed px-6 py-16 text-center ${isLightRed ? 'border-zinc-200 bg-white text-zinc-500 shadow-sm' : 'border-white/10 bg-zinc-900/70 text-zinc-400'}`}><History size={48} className={`mx-auto mb-4 ${isLightRed ? 'text-zinc-300' : 'opacity-20'}`}/><p className={`font-semibold ${isLightRed ? 'text-zinc-900' : 'text-white'}`}>Nenhum pedido por enquanto</p><p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-zinc-500">Seus pedidos entregues aparecerao aqui para voce repetir com mais rapidez nas proximas compras.</p><button onClick={onBack} className={`mt-5 rounded-2xl border px-5 py-3 text-sm font-bold transition-colors ${isLightRed ? 'border-zinc-200 bg-white text-zinc-800 shadow-sm hover:bg-zinc-50' : 'border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10'}`}>Voltar ao cardapio</button></div>
        :pedidos.map(p=>(
          <div key={p.id} className={`rounded-[26px] border p-4 ${isLightRed ? 'border-zinc-200 bg-white shadow-sm' : 'border-white/10 bg-zinc-900 shadow-[0_18px_50px_rgba(0,0,0,0.22)]'}`}>
            <div className="mb-2 flex items-center justify-between gap-3"><span className={`font-mono font-black ${isLightRed ? 'text-zinc-900' : 'text-white'}`}>#{p.order_number}</span><span className={`text-[10px] font-bold px-2.5 py-1 rounded-full ${statusCls(p.status)}`}>{STATUS_TXT[p.status]||p.status}</span></div>
            <p className={`mb-2 line-clamp-2 text-sm ${isLightRed ? 'text-zinc-600' : 'text-zinc-400'}`}>{p.resumo_itens}</p>
            <div className="flex items-center justify-between"><span className="text-xs text-zinc-500">{fd(p.created_at)}</span><span className={`font-black ${isLightRed ? 'text-red-700' : 'text-cyan-300'}`}>{fmt(p.total_amount)}</span></div>
            {p.status==='Entregue'&&Array.isArray(p.itens)&&p.itens.length>0&&<button onClick={()=>repetir(p)} className={`mt-3 w-full rounded-xl border py-2.5 text-xs font-bold transition-all ${isLightRed ? 'border-zinc-200 bg-zinc-50 text-zinc-800 hover:bg-zinc-100' : 'border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10'}`}>Pedir novamente</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function TelaEnderecos({ slug, token, onBack, onNovo }: { slug:string;token:string|null;onBack:()=>void;onNovo:()=>void }) {
  const [ends, setEnds]=useState<Endereco[]>([]);
  const [load, setLoad]=useState(true);
  const load_=useCallback(()=>{if(!token)return;fetch(`/public/delivery/${slug}/cliente/enderecos`,{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.ok?r.json():[]).then(d=>{if(Array.isArray(d))setEnds(d);}).finally(()=>setLoad(false));},[token,slug]);
  useEffect(()=>{load_();},[load_]);
  const del=async(id:number)=>{if(!confirm('Remover?'))return;await fetch(`/public/delivery/${slug}/cliente/enderecos/${id}`,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}});load_();};
  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col">
      <header className="flex items-center justify-between border-b border-zinc-100 bg-white px-3 py-3 shadow-sm sm:px-4 sm:py-4">
        <div className="flex items-center gap-2 sm:gap-3"><button type="button" onClick={onBack} className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full p-2 hover:bg-zinc-100"><ArrowLeft size={20} className="text-zinc-700"/></button><p className="text-lg font-black text-zinc-900">Meus Endereços</p></div>
        <button type="button" onClick={onNovo} className="flex min-h-[40px] items-center gap-1.5 rounded-full bg-zinc-900 px-3 py-2 text-xs font-bold text-white transition-all hover:bg-zinc-800 sm:px-4 sm:text-sm"><Plus size={14}/>Adicionar</button>
      </header>
      <div className="mx-auto w-full max-w-2xl flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
        {load?<div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-zinc-200 border-t-zinc-800 rounded-full animate-spin"/></div>
        :ends.length===0?<div className="text-center py-16 text-zinc-400"><MapPin size={48} className="mx-auto mb-4 opacity-20"/><p className="font-semibold mb-4">Nenhum endereço</p><button onClick={onNovo} className="px-5 py-2.5 bg-zinc-900 text-white rounded-xl text-sm font-bold">Adicionar</button></div>
        :ends.map(e=>(
          <div key={e.id} className="bg-white rounded-2xl p-4 shadow-sm flex items-start gap-3">
            <div className="w-10 h-10 bg-orange-50 rounded-xl flex items-center justify-center shrink-0"><Home size={18} className="text-orange-500"/></div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-zinc-900 flex items-center gap-2">{e.label}{e.principal===1&&<span className="text-[10px] bg-cyan-100 text-cyan-700 px-2 py-0.5 rounded-full font-bold">Principal</span>}</p>
              <p className="text-sm text-zinc-500 mt-0.5">{e.logradouro}{e.numero?', '+e.numero:''}{e.complemento?' — '+e.complemento:''}</p>
              {e.bairro&&<p className="text-xs text-zinc-400">{e.bairro}</p>}
              {e.referencia&&<p className="text-xs text-zinc-400 italic">Ref: {e.referencia}</p>}
            </div>
            <button onClick={()=>del(e.id)} className="p-2 text-zinc-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"><Trash2 size={15}/></button>
          </div>
        ))}
      </div>
    </div>
  );
}

function TelaNovo({
  Endereco: _,
  slug,
  token,
  temZonas,
  onBack,
  onSaved,
}: {
  Endereco?: any;
  slug: string;
  token: string | null;
  temZonas: boolean;
  onBack: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<DeliveryNovoEnderecoForm>(() => emptyDeliveryNovoEnderecoForm(false));
  const [saving, setSaving]=useState(false);
  const [erro, setErro]=useState('');
  const inp="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-3.5 text-base focus:border-cyan-400 focus:outline-none transition-all sm:px-4 sm:text-sm";
  const salvar=async()=>{
    if (!form.campos.logradouro.trim()) { setErro('Informe o logradouro'); return; }
    if (!form.campos.numero.trim()) { setErro('Informe o número'); return; }
    if (!form.campos.bairro.trim()) { setErro('Informe o bairro'); return; }
    setSaving(true);
    try {
      const r = await fetch(`/public/delivery/${slug}/cliente/enderecos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          label: form.label,
          logradouro: form.campos.logradouro.trim(),
          numero: form.campos.numero.trim(),
          complemento: form.campos.complemento.trim() || null,
          bairro: form.campos.bairro.trim(),
          referencia: form.campos.referencia.trim() || null,
          principal: form.principal,
        }),
      });
      const d = await r.json();
      if (d.success) onSaved();
      else setErro(d.error || 'Erro');
    } catch {
      setErro('Erro de conexão');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-100 bg-white px-3 py-3 shadow-sm sm:px-4 sm:py-4">
        <button type="button" onClick={onBack} className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full p-2 hover:bg-zinc-100"><ArrowLeft size={20} className="text-zinc-700"/></button>
        <p className="text-lg font-black text-zinc-900">Novo Endereço</p>
      </header>
      <div className="mx-auto w-full max-w-2xl flex-1 space-y-4 overflow-y-auto p-3 pb-8 sm:p-4">
        <div>
          <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-zinc-500">Identificação</label>
          <DeliveryIdentificacaoEnderecoChips
            value={form.label}
            onChange={(label) => setForm((f) => ({ ...f, label }))}
            chipOn="border-cyan-400 bg-cyan-50 text-cyan-700"
            chipOff="border-zinc-200 bg-white text-zinc-500"
          />
        </div>
        <div className="space-y-3 rounded-2xl bg-white p-4 shadow-sm">
          <DeliveryEnderecoCamposInputs
            value={form.campos}
            onChange={(campos) => setForm((f) => ({ ...f, campos }))}
            inpClass={inp}
            temZonas={temZonas}
            labelClassName="text-zinc-500"
          />
        </div>
        <label className="flex cursor-pointer items-center gap-3 rounded-2xl bg-white p-4 shadow-sm">
          <button
            type="button"
            aria-pressed={form.principal}
            onClick={() => setForm((f) => ({ ...f, principal: !f.principal }))}
            className={`relative h-6 w-12 shrink-0 rounded-full transition-all ${form.principal ? 'bg-cyan-600' : 'bg-zinc-300'}`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${form.principal ? 'left-6' : 'left-0.5'}`} />
          </button>
          <span className="text-sm font-semibold text-zinc-700">Definir como principal</span>
        </label>
        {erro&&<div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">{erro}</div>}
        <button type="button" onClick={salvar} disabled={saving} className="flex w-full items-center justify-center rounded-2xl bg-zinc-900 py-4 font-black text-white transition-all hover:bg-zinc-800 active:scale-[0.98] disabled:bg-zinc-300">
          {saving?<div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white"/>:'Salvar Endereço'}
        </button>
      </div>
    </div>
  );
}