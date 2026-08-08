import React, { Fragment, useMemo } from 'react';
import { AnimatePresence } from 'motion/react';
import { buildDeliveryCardapioTheme, type DeliveryCardapioThemeMode } from '../segments/delivery/deliveryCardapioTheme';
import { CardapioThemeShell } from '../segments/delivery/DeliveryCardapioThemeContext';
import {
  ProductOptionsModal,
  type ProductOptionsCartItem,
  type ProductOptionsProduto,
} from './ProductOptionsModal';

type POSProductOptionsDialogProps = {
  produto: ProductOptionsProduto;
  onClose: () => void;
  onAdicionar: (item: ProductOptionsCartItem) => void;
  /** Enquanto a API de variações/opções do PDV carrega; bloqueia confirmar até os dados chegarem. */
  carregandoOpcoes?: boolean;
  resolveComboComponente?: (productId: number) => ProductOptionsProduto | null;
  loadComboComponenteOpcoes?: (
    productId: number
  ) => Promise<Pick<ProductOptionsProduto, 'grupos_opcao' | 'variacoes_vendaveis'> | null>;
  /**
   * Tema visual do modal. Padrão 'dark_premium' (ciano/âmbar, usado no PDV/balcão).
   * Telas com identidade vermelha (ex.: Mesas/Garçom, cores #EA1D2C) devem passar
   * 'light_red' para herdar o acento vermelho já existente no tema, mantendo o
   * mesmo fundo escuro (zinc-950) — sem duplicar estilos nem criar tema novo.
   */
  themeMode?: DeliveryCardapioThemeMode;
};

export default function POSProductOptionsDialog({
  produto,
  onClose,
  onAdicionar,
  carregandoOpcoes = false,
  resolveComboComponente,
  loadComboComponenteOpcoes,
  themeMode = 'dark_premium',
}: POSProductOptionsDialogProps) {
  const posProductOptionsTheme = useMemo(() => buildDeliveryCardapioTheme(themeMode), [themeMode]);
  return (
    <CardapioThemeShell theme={posProductOptionsTheme}>
      <AnimatePresence>
        <Fragment key={produto.id}>
          <ProductOptionsModal
            produto={produto}
            addDestination="pedido"
            visualVariant="pos"
            carregandoOpcoes={carregandoOpcoes}
            onClose={onClose}
            onAdicionar={onAdicionar}
            resolveComboComponente={resolveComboComponente}
            loadComboComponenteOpcoes={loadComboComponenteOpcoes}
          />
        </Fragment>
      </AnimatePresence>
    </CardapioThemeShell>
  );
}
