// src/routes/products.ts
import { Router, Request, Response, NextFunction } from 'express';
import { q1, qAll, qRun, qInsert, withTx, txQ1, txQAll, txInsert, txRun } from '../db';
import { deleteStoredUpload } from '../services/uploadPersistence';
import { uploadProductImageToCloudinary } from '../services/cloudinaryProduct';
import { persistMulterImageFile } from '../services/imageUploadPolicy';
import { upload, hardenUploadedImageFile, requireAnyPermission } from '../middleware';
import { validateSecurityPassword } from '../utils/securityPassword';
import { normalizeBarcode } from '../utils/barcode';
import { generatePublicId } from '../utils/publicIds';
import { sendInternalError } from '../utils/internalServerError';
import { normalizeProductProductionInput } from '../utils/preparation';
import { normalizeProductPhotoPublicUrl } from '../utils/productPhotoUrl';
import { isAppError } from '../utils/errors';
import {
  assertProdutoPermitidoComoComponenteCombo,
  assertComponentesComboDefinicao,
  loadComboGruposForProduto,
  parseComboGrupoFields,
  parseProductComboDefinicaoBody,
} from '../services/productComboValidation';

const REPORT_TZ = 'America/Sao_Paulo';

function withNormalizedProductPhoto<T extends { photo_url?: unknown }>(row: T): T {
  return { ...row, photo_url: normalizeProductPhotoPublicUrl(row.photo_url) };
}

function withNormalizedProductPhotos<T extends { photo_url?: unknown }>(rows: T[]): T[] {
  return rows.map(withNormalizedProductPhoto);
}

/** Ordem na listagem admin / cardápio: ativos primeiro; depois ordem manual e nome. */
const ORDER_CARDAPIO_LISTAGEM =
  'ORDER BY CASE WHEN COALESCE(active,0)=1 THEN 0 ELSE 1 END ASC, COALESCE(ordem,0) ASC, name ASC';

async function produtoTemItensEmPedidos(tenantId: number, productId: number): Promise<boolean> {
  const row = await q1<{ one: number }>(
    'SELECT 1 AS one FROM itens_pedido WHERE tenant_id=? AND product_id=? LIMIT 1',
    [tenantId, productId]
  );
  return Boolean(row);
}

/** Carrega os grupos de opções (adicionais) de um produto, com os itens de cada grupo.
 *  Exportada pra ser reaproveitada fora do router de produtos (ex.: `/api/mesas/produtos-garcom`,
 *  que usa o mesmo contrato pra montar o modal de opções na tela do garçom). */
export async function loadProdutoGruposOpcao(
  tenantId: number,
  productId: number,
  opts?: { onlyActiveItens?: boolean }
) {
  const onlyActiveItens = opts?.onlyActiveItens !== false;
  const itensActiveSql = onlyActiveItens ? ' AND ativo=1' : '';
  const grupos = await qAll(
    'SELECT * FROM produto_grupos_opcao WHERE produto_id=? AND tenant_id=? ORDER BY ordem ASC, id ASC',
    [productId, tenantId]
  );
  const result: any[] = [];
  for (const g of grupos) {
    const itens = await qAll(
      `SELECT * FROM produto_opcao_itens WHERE grupo_id=? AND tenant_id=?${itensActiveSql} ORDER BY ordem ASC, id ASC`,
      [g.id, tenantId]
    );
    result.push({ ...g, itens });
  }
  return result;
}

/** Mesma exportação: usada pelo `/pdv-opcoes` do PDV e pelo endpoint equivalente do garçom em mesas.ts. */
export function mapComboGruposPublic(
  rows: Awaited<ReturnType<typeof loadComboGruposForProduto>>,
  forCustomer: boolean
) {
  return rows
    .filter((g) => (forCustomer ? Number(g.ativo) === 1 : true))
    .filter((g) => (forCustomer ? g.produtos.length > 0 : true))
    .map((g) => ({
      id: g.id,
      nome: g.nome,
      ordem: g.ordem,
      obrigatorio: Number(g.obrigatorio) === 1,
      qtd_min: Math.max(0, Number(g.qtd_min || 0)),
      qtd_max: Math.max(0, Number(g.qtd_max || 0)),
      ativo: Number(g.ativo) === 1,
      produtos: g.produtos.map((p) => ({
        link_id: p.id,
        product_id: p.product_id,
        name: p.name,
      })),
    }));
}

export function createProductsRouter() {
  const router = Router();

  router.use((req, res, next) => {
    const canReadOperationalProducts = req.method === 'GET'
      && (
        req.path === '/'
        || req.path.startsWith('/barcode/')
        || /\/variacoes-vendaveis(?:\/|$)/.test(req.path)
        || /\/opcoes(?:\/|$)/.test(req.path)
        || /\/pdv-opcoes(?:\/|$)/.test(req.path)
        || /\/combo(?:\/|$)/.test(req.path)
      );

    if (canReadOperationalProducts) {
      return requireAnyPermission('products', 'pos', 'estoque')(req, res, next);
    }

    return requireAnyPermission('products')(req, res, next);
  });

  async function ensureBarcodeAvailable(
    tenantId: number,
    barcode: string | null,
    currentId?: number
  ) {
    if (!barcode) {
      return;
    }

    const existing = await q1<{ id: number }>(
      `SELECT id
       FROM produtos
       WHERE tenant_id=?
         AND id <> COALESCE(?, 0)
         AND codigo_barras IS NOT NULL
         AND UPPER(REGEXP_REPLACE(codigo_barras, '\\s+', '', 'g'))=?
       LIMIT 1`,
      [tenantId, currentId ?? null, barcode]
    );

    if (existing) {
      throw new Error('J\u00E1 existe um produto com este c\u00F3digo de barras.');
    }
  }

function normalizeProductPromotionInput(
  payload: { price?: unknown; em_promocao?: unknown; preco_original?: unknown },
  current?: { price?: unknown; em_promocao?: unknown; preco_original?: unknown } | null
) {
  const hasPromotionFlag = Object.prototype.hasOwnProperty.call(payload, 'em_promocao');
  const hasOriginalPrice = Object.prototype.hasOwnProperty.call(payload, 'preco_original');

  const priceRaw = payload.price ?? current?.price;
  const currentPrice = Number(priceRaw);

  const promotionRaw = hasPromotionFlag ? payload.em_promocao : current?.em_promocao;
  const promotionEnabled = promotionRaw === true || promotionRaw === 1 || String(promotionRaw) === '1';

  const originalRaw = hasOriginalPrice ? payload.preco_original : current?.preco_original;
  const originalPrice = originalRaw === null || originalRaw === undefined || originalRaw === ''
    ? null
    : Number(originalRaw);

  if (!promotionEnabled) {
    return { emPromocao: 0, precoOriginal: null as number | null };
  }

  if (!Number.isFinite(currentPrice) || currentPrice < 0) {
    throw new Error('Preco atual invalido para ativar promocao.');
  }

  if (!Number.isFinite(originalPrice) || originalPrice === null) {
    throw new Error('Informe um preco de antes valido para ativar promocao.');
  }

  if (originalPrice <= currentPrice) {
    throw new Error('Preco de antes deve ser maior que o preco atual para ativar promocao.');
  }

  return { emPromocao: 1, precoOriginal: originalPrice };
}

  router.get('/', async (req: Request, res) => {
    const { q, active, limit, offset } = req.query;
    try {
      if (q) {
        const term = `%${q}%`;
        const activeFilter = active !== undefined ? ' AND active=?' : '';
        const activeParam = active !== undefined ? [Number(active)] : [];
        return res.json(
          withNormalizedProductPhotos(
            await qAll(
              `SELECT * FROM produtos WHERE tenant_id=? AND (name ILIKE ? OR codigo_barras ILIKE ? OR marca ILIKE ? OR descricao ILIKE ?) ${activeFilter} ${ORDER_CARDAPIO_LISTAGEM} LIMIT 200`,
              [req.tenantId, term, term, term, term, ...activeParam]
            )
          )
        );
      }
      const activeFilter = active !== undefined ? ' AND active=?' : '';
      const activeParam = active !== undefined ? [Number(active)] : [];
      if (limit) {
        const lim = Math.min(Number(limit) || 50, 500);
        const off = Number(offset) || 0;
        return res.json(
          withNormalizedProductPhotos(
            await qAll(
              `SELECT * FROM produtos WHERE tenant_id=? ${activeFilter} ${ORDER_CARDAPIO_LISTAGEM} LIMIT ? OFFSET ?`,
              [req.tenantId, ...activeParam, lim, off]
            )
          )
        );
      }
      res.json(
        withNormalizedProductPhotos(
          await qAll(
            `SELECT * FROM produtos WHERE tenant_id=? ${activeFilter} ${ORDER_CARDAPIO_LISTAGEM}`,
            [req.tenantId, ...activeParam]
          )
        )
      );
    } catch (e: unknown) {
      const msg = String((e as Error)?.message ?? '');
      if (msg.includes('c\u00F3digo de barras')) {
        return res.status(400).json({ error: msg });
      }
      sendInternalError(res, 'routes/products:list', e);
    }
  });

  router.get('/barcode/:code', async (req: Request, res) => {
    const barcode = normalizeBarcode(req.params.code);
    if (!barcode) return res.status(400).json({ found: false, message: 'C\u00F3digo de barras inv\u00E1lido' });
    const product = await q1(
      `SELECT *
       FROM produtos
       WHERE tenant_id=?
         AND active=1
         AND codigo_barras IS NOT NULL
         AND UPPER(REGEXP_REPLACE(codigo_barras, '\\s+', '', 'g'))=?
       LIMIT 1`,
      [req.tenantId, barcode]
    );
    if (!product) return res.status(404).json({ found: false });
    res.json({ found: true, product: withNormalizedProductPhoto(product) });
  });

  router.post('/suggestions', async (req: Request, res) => {
    try {
      const rawIds = Array.isArray(req.body?.productIds) ? req.body.productIds : [];
      const productIds = [...new Set(
        rawIds
          .map((id: any) => Number(id))
          .filter((id: number) => Number.isInteger(id) && id > 0)
      )];

      if (!productIds.length) return res.json([]);

      const sourcePlaceholders = productIds.map(() => '?').join(',');
      const excludePlaceholders = productIds.map(() => '?').join(',');
      const manualRows = await qAll(
        `SELECT
           p.id,
           p.name,
           p.price,
           p.category,
           p.photo_url,
           MAX(ps.prioridade) AS prioridade,
           COALESCE(MAX(se.total_eventos), 0) AS total_eventos,
           (array_agg(ps.produto_id ORDER BY ps.prioridade DESC, ps.produto_id ASC))[1] AS source_product_id
         FROM produto_sugestoes ps
         JOIN produtos p
           ON p.id = ps.produto_sugerido_id
          AND p.tenant_id = ps.tenant_id
         LEFT JOIN (
           SELECT produto_sugerido_id, COUNT(id) AS total_eventos
           FROM sugestoes_eventos
           WHERE tenant_id = ?
           GROUP BY produto_sugerido_id
         ) se ON se.produto_sugerido_id = p.id
         WHERE ps.tenant_id = ?
           AND ps.ativo = 1
           AND p.active = 1
           AND ps.produto_id IN (${sourcePlaceholders})
           AND ps.produto_id <> ps.produto_sugerido_id
           AND ps.produto_sugerido_id NOT IN (${excludePlaceholders})
         GROUP BY p.id, p.name, p.price, p.category, p.photo_url
         ORDER BY MAX(ps.prioridade) DESC, COALESCE(MAX(se.total_eventos), 0) DESC, p.name ASC
         LIMIT 3`,
        [req.tenantId, req.tenantId, ...productIds, ...productIds]
      );

      const suggestions = [...manualRows];
      if (suggestions.length < 3) {
        const cartProfile = await qAll(
          `SELECT production_type, category
           FROM produtos
           WHERE tenant_id = ?
             AND id IN (${sourcePlaceholders})`,
          [req.tenantId, ...productIds]
        );

        const hasKitchen = cartProfile.some((p: any) => String(p.production_type || '').toLowerCase() === 'kitchen');
        const hasDrink = cartProfile.some((p: any) => {
          const productionType = String(p.production_type || '').toLowerCase();
          const category = String(p.category || '').toLowerCase();
          return productionType === 'bar' || category.includes('bebida');
        });

        if (hasKitchen || hasDrink) {
          const alreadySuggestedIds = suggestions.map((s: any) => Number(s.id)).filter((id: number) => Number.isInteger(id) && id > 0);
          const excludedIds = [...new Set([...productIds, ...alreadySuggestedIds])];
          const excludedPlaceholders = excludedIds.map(() => '?').join(',');
          const fallbackFilters: string[] = [];

          if (hasKitchen) {
            fallbackFilters.push(`(LOWER(COALESCE(p.production_type, '')) = 'bar' OR LOWER(COALESCE(p.category, '')) LIKE '%bebida%')`);
          }
          if (hasDrink) {
            fallbackFilters.push(`LOWER(COALESCE(p.production_type, '')) = 'kitchen'`);
          }

          if (fallbackFilters.length > 0) {
            const missing = 3 - suggestions.length;
            const fallbackRows = await qAll(
              `SELECT
                 p.id,
                 p.name,
                 p.price,
                 p.category,
                 p.photo_url,
                 0 AS prioridade,
                 CAST(NULL AS INTEGER) AS source_product_id
               FROM produtos p
               WHERE p.tenant_id = ?
                 AND p.active = 1
                 AND p.id NOT IN (${excludedPlaceholders})
                 AND (${fallbackFilters.join(' OR ')})
               ORDER BY p.name ASC
               LIMIT ?`,
              [req.tenantId, ...excludedIds, missing]
            );
            suggestions.push(...fallbackRows);
          }
        }
      }

      res.json(withNormalizedProductPhotos(suggestions.slice(0, 3)));
    } catch (e: unknown) { sendInternalError(res, 'routes/products', e); }
  });

  router.get('/suggestions/events/summary', async (req: Request, res) => {
    try {
      const { periodo } = req.query;
      let pKey = periodo ? String(periodo).toLowerCase().replace(/ /g, '').replace('_', '') : '';
      if (pKey === '7dias') pKey = '7d';
      if (pKey === '30dias') pKey = '30d';
      if (pKey === 'estemes') pKey = 'mes';

      const periodoMap: Record<string, string> = {
        hoje: `(se.created_at AT TIME ZONE '${REPORT_TZ}')::date = (NOW() AT TIME ZONE '${REPORT_TZ}')::date`,
        '7d': `(se.created_at AT TIME ZONE '${REPORT_TZ}')::date >= (NOW() AT TIME ZONE '${REPORT_TZ}')::date - INTERVAL '6 days'`,
        '30d': `(se.created_at AT TIME ZONE '${REPORT_TZ}')::date >= (NOW() AT TIME ZONE '${REPORT_TZ}')::date - INTERVAL '29 days'`,
        mes: `DATE_TRUNC('month', se.created_at AT TIME ZONE '${REPORT_TZ}') = DATE_TRUNC('month', NOW() AT TIME ZONE '${REPORT_TZ}')`,
      };
      const dateFilter = pKey && periodoMap[pKey] ? ` AND ${periodoMap[pKey]}` : '';

      const rows = await qAll(
        `SELECT
           se.produto_origem_id,
           se.produto_sugerido_id,
           COUNT(*)::int AS total,
           MAX(po.name) AS origem_name,
           MAX(ps.name) AS sugerido_name
         FROM sugestoes_eventos se
         LEFT JOIN produtos po ON po.id = se.produto_origem_id AND po.tenant_id = se.tenant_id
         LEFT JOIN produtos ps ON ps.id = se.produto_sugerido_id AND ps.tenant_id = se.tenant_id
         WHERE se.tenant_id = ?${dateFilter}
         GROUP BY se.produto_origem_id, se.produto_sugerido_id
         ORDER BY total DESC
         LIMIT 500`,
        [req.tenantId]
      );
      res.json(rows);
    } catch (e: unknown) {
      sendInternalError(res, 'routes/products:suggestionsReport', e);
    }
  });

  router.get('/:id/suggestions', async (req: Request, res) => {
    try {
      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ error: 'Produto invalido' });
      }

      const rows = await qAll(
        `SELECT
           ps.produto_sugerido_id AS id,
           p.name,
           p.price,
           p.category,
           p.photo_url,
           ps.prioridade
         FROM produto_sugestoes ps
         JOIN produtos p
           ON p.id = ps.produto_sugerido_id
          AND p.tenant_id = ps.tenant_id
         WHERE ps.tenant_id = ?
           AND ps.produto_id = ?
           AND ps.ativo = 1
         ORDER BY ps.prioridade DESC, p.name ASC`,
        [req.tenantId, productId]
      );

      res.json(withNormalizedProductPhotos(rows));
    } catch (e: unknown) { sendInternalError(res, 'routes/products', e); }
  });

  router.post('/:id/suggestions', async (req: Request, res) => {
    try {
      const productId = Number(req.params.id);
      const suggestedProductId = Number(req.body?.suggestedProductId);
      const priority = Number(req.body?.priority ?? 0);

      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ error: 'Produto invalido' });
      }
      if (!Number.isInteger(suggestedProductId) || suggestedProductId <= 0) {
        return res.status(400).json({ error: 'Produto sugerido invalido' });
      }
      if (productId === suggestedProductId) {
        return res.status(400).json({ error: 'Nao e permitido sugerir o proprio produto' });
      }

      const [origem, sugerido] = await Promise.all([
        q1('SELECT id FROM produtos WHERE id=? AND tenant_id=?', [productId, req.tenantId]),
        q1('SELECT id FROM produtos WHERE id=? AND tenant_id=?', [suggestedProductId, req.tenantId]),
      ]);
      if (!origem || !sugerido) {
        return res.status(404).json({ error: 'Produto nao encontrado' });
      }

      const existente = await q1(
        `SELECT id
         FROM produto_sugestoes
         WHERE tenant_id=?
           AND produto_id=?
           AND produto_sugerido_id=?
         LIMIT 1`,
        [req.tenantId, productId, suggestedProductId]
      );
      if (existente) {
        return res.status(400).json({ error: 'Sugestao ja cadastrada' });
      }

      await qRun(
        `INSERT INTO produto_sugestoes
          (tenant_id, produto_id, produto_sugerido_id, prioridade, ativo)
         VALUES (?, ?, ?, ?, 1)`,
        [req.tenantId, productId, suggestedProductId, Number.isFinite(priority) ? priority : 0]
      );

      res.json({ success: true });
    } catch (e: unknown) { sendInternalError(res, 'routes/products', e); }
  });

  router.get('/:id/variacoes-vendaveis', async (req: Request, res) => {
    try {
      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ error: 'Produto invalido' });
      }

      const produto = await q1('SELECT id FROM produtos WHERE id=? AND tenant_id=?', [productId, req.tenantId]);
      if (!produto) return res.status(404).json({ error: 'Produto nao encontrado' });

      const includeInactive = String(req.query.includeInactive || '') === '1';
      const activeFilter = includeInactive ? '' : ' AND ativo=1';

      const rows = await qAll(
        `SELECT id, produto_id, nome, preco, codigo_barras, ativo, ordem, ingrediente_id
         FROM produto_variacoes_vendaveis
         WHERE tenant_id=?
           AND produto_id=?${activeFilter}
         ORDER BY ordem ASC, nome ASC`,
        [req.tenantId, productId]
      );

      res.json(rows);
    } catch (e: unknown) { sendInternalError(res, 'routes/products', e); }
  });

  /** Uma ida e volta HTTP: variações ativas + grupos/opções (mesmo contrato que os GETs separados). */
  router.get('/:id/pdv-opcoes', async (req: Request, res) => {
    try {
      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ error: 'Produto invalido' });
      }

      const produto = await q1<{ id: number; is_combo: number }>(
        'SELECT id, COALESCE(is_combo,0) AS is_combo FROM produtos WHERE id=? AND tenant_id=?',
        [productId, req.tenantId]
      );
      if (!produto) return res.status(404).json({ error: 'Produto nao encontrado' });

      const [variacoesRows, gruposOpcao, comboGruposRaw] = await Promise.all([
        qAll(
          `SELECT id, produto_id, nome, preco, codigo_barras, ativo, ordem, ingrediente_id
           FROM produto_variacoes_vendaveis
           WHERE tenant_id=?
             AND produto_id=?
             AND ativo=1
           ORDER BY ordem ASC, nome ASC`,
          [req.tenantId, productId]
        ),
        loadProdutoGruposOpcao(req.tenantId, productId, { onlyActiveItens: true }),
        loadComboGruposForProduto(req.tenantId, productId, true),
      ]);

      res.json({
        variacoes_vendaveis: variacoesRows,
        grupos_opcao: gruposOpcao,
        combo_grupos: mapComboGruposPublic(comboGruposRaw, true),
        is_combo: Number(produto.is_combo) === 1,
      });
    } catch (e: unknown) { sendInternalError(res, 'routes/products', e); }
  });

  router.post('/:id/variacoes-vendaveis', async (req: Request, res) => {
    try {
      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ error: 'Produto invalido' });
      }

      const produto = await q1('SELECT id FROM produtos WHERE id=? AND tenant_id=?', [productId, req.tenantId]);
      if (!produto) return res.status(404).json({ error: 'Produto nao encontrado' });

      const nome = String(req.body?.nome || '').trim();
      if (!nome) {
        return res.status(400).json({ error: 'Nome obrigatorio' });
      }

      const preco = Number(req.body?.preco);
      if (!Number.isFinite(preco) || preco < 0) {
        return res.status(400).json({ error: 'Preco invalido' });
      }

      const ordem = Number(req.body?.ordem ?? 0);
      const ativo = req.body?.ativo === false || req.body?.ativo === 0 ? 0 : 1;
      const codigoBarras = normalizeBarcode(req.body?.codigo_barras);

      let ingredienteId: number | null = null;
      if (req.body?.ingrediente_id != null && req.body?.ingrediente_id !== '') {
        const iid = Number(req.body.ingrediente_id);
        if (!Number.isInteger(iid) || iid <= 0) {
          return res.status(400).json({ error: 'ingrediente_id invalido' });
        }
        const ing = await q1('SELECT id FROM ingredientes WHERE id=? AND tenant_id=?', [iid, req.tenantId]);
        if (!ing) {
          return res.status(400).json({ error: 'Ingrediente nao encontrado' });
        }
        ingredienteId = iid;
      }

      const dupNome = await q1(
        `SELECT id FROM produto_variacoes_vendaveis
         WHERE tenant_id=?
           AND produto_id=?
           AND LOWER(TRIM(nome)) = LOWER(?)
         LIMIT 1`,
        [req.tenantId, productId, nome]
      );
      if (dupNome) {
        return res.status(400).json({ error: 'Ja existe variacao com este nome neste produto' });
      }

      await qInsert(
        `INSERT INTO produto_variacoes_vendaveis
          (tenant_id, produto_id, nome, preco, codigo_barras, ativo, ordem, ingrediente_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.tenantId, productId, nome, preco, codigoBarras || null, ativo, Number.isFinite(ordem) ? ordem : 0, ingredienteId]
      );

      res.json({ success: true });
    } catch (e: unknown) { sendInternalError(res, 'routes/products', e); }
  });

  router.delete('/:id/variacoes-vendaveis/:variationId', async (req: Request, res) => {
    try {
      const productId = Number(req.params.id);
      const variationId = Number(req.params.variationId);
      if (!Number.isInteger(productId) || productId <= 0 || !Number.isInteger(variationId) || variationId <= 0) {
        return res.status(400).json({ error: 'Parametros invalidos' });
      }

      await qRun(
        `DELETE FROM produto_variacoes_vendaveis
         WHERE id=?
           AND tenant_id=?
           AND produto_id=?`,
        [variationId, req.tenantId, productId]
      );

      res.json({ success: true });
    } catch (e: unknown) { sendInternalError(res, 'routes/products', e); }
  });

  router.put('/:id/variacoes-vendaveis/:variationId', async (req: Request, res) => {
    try {
      const productId = Number(req.params.id);
      const variationId = Number(req.params.variationId);
      if (!Number.isInteger(productId) || productId <= 0 || !Number.isInteger(variationId) || variationId <= 0) {
        return res.status(400).json({ error: 'Parametros invalidos' });
      }

      const produto = await q1('SELECT id FROM produtos WHERE id=? AND tenant_id=?', [productId, req.tenantId]);
      if (!produto) return res.status(404).json({ error: 'Produto nao encontrado' });

      const variacao = await q1(
        'SELECT id FROM produto_variacoes_vendaveis WHERE id=? AND tenant_id=? AND produto_id=?',
        [variationId, req.tenantId, productId]
      );
      if (!variacao) return res.status(404).json({ error: 'Variacao nao encontrada' });

      const nome = String(req.body?.nome || '').trim();
      if (!nome) {
        return res.status(400).json({ error: 'Nome obrigatorio' });
      }

      const preco = Number(req.body?.preco);
      if (!Number.isFinite(preco) || preco < 0) {
        return res.status(400).json({ error: 'Preco invalido' });
      }

      const ordem = Number(req.body?.ordem ?? 0);
      const ativo = req.body?.ativo === false || req.body?.ativo === 0 ? 0 : 1;
      const codigoBarras = normalizeBarcode(req.body?.codigo_barras);

      let ingredienteId: number | null | undefined;
      if (Object.hasOwn(req.body || {}, 'ingrediente_id')) {
        ingredienteId = null;
        if (req.body?.ingrediente_id != null && req.body?.ingrediente_id !== '') {
          const iid = Number(req.body.ingrediente_id);
          if (!Number.isInteger(iid) || iid <= 0) {
            return res.status(400).json({ error: 'ingrediente_id invalido' });
          }
          const ing = await q1('SELECT id FROM ingredientes WHERE id=? AND tenant_id=?', [iid, req.tenantId]);
          if (!ing) {
            return res.status(400).json({ error: 'Ingrediente nao encontrado' });
          }
          ingredienteId = iid;
        }
      }

      const dupNome = await q1(
        `SELECT id FROM produto_variacoes_vendaveis
         WHERE tenant_id=?
           AND produto_id=?
           AND LOWER(TRIM(nome)) = LOWER(?)
           AND id <> ?
         LIMIT 1`,
        [req.tenantId, productId, nome, variationId]
      );
      if (dupNome) {
        return res.status(400).json({ error: 'Ja existe variacao com este nome neste produto' });
      }

      if (ingredienteId === undefined) {
        await qRun(
          `UPDATE produto_variacoes_vendaveis
           SET nome=?, preco=?, codigo_barras=?, ativo=?, ordem=?
           WHERE id=? AND tenant_id=? AND produto_id=?`,
          [nome, preco, codigoBarras || null, ativo, Number.isFinite(ordem) ? ordem : 0, variationId, req.tenantId, productId]
        );
      } else {
        await qRun(
          `UPDATE produto_variacoes_vendaveis
           SET nome=?, preco=?, codigo_barras=?, ativo=?, ordem=?, ingrediente_id=?
           WHERE id=? AND tenant_id=? AND produto_id=?`,
          [nome, preco, codigoBarras || null, ativo, Number.isFinite(ordem) ? ordem : 0, ingredienteId, variationId, req.tenantId, productId]
        );
      }

      res.json({ success: true });
    } catch (e: unknown) { sendInternalError(res, 'routes/products', e); }
  });

  router.delete('/:id/suggestions/:suggestedId', async (req: Request, res) => {
    try {
      const productId = Number(req.params.id);
      const suggestedId = Number(req.params.suggestedId);
      if (!Number.isInteger(productId) || productId <= 0 || !Number.isInteger(suggestedId) || suggestedId <= 0) {
        return res.status(400).json({ error: 'Parametros invalidos' });
      }

      await qRun(
        `DELETE FROM produto_sugestoes
         WHERE tenant_id=?
           AND produto_id=?
           AND produto_sugerido_id=?`,
        [req.tenantId, productId, suggestedId]
      );

      res.json({ success: true });
    } catch (e: unknown) { sendInternalError(res, 'routes/products', e); }
  });

  router.post('/', async (req: Request, res) => {
    try {
      const {
        name,
        price,
        category,
        active,
        color,
        codigo_barras,
        marca,
        descricao,
        custo,
        destaque,
        em_promocao,
        preco_original,
        disponivel_de,
        disponivel_ate,
        requires_preparation,
        production_type,
        mais_vendido,
        is_combo,
      } = req.body;
      const normalizedBarcode = normalizeBarcode(codigo_barras);
      const normalizedProduction = normalizeProductProductionInput(
        { production_type, requires_preparation },
        { name, category }
      );
      const normalizedPromotion = normalizeProductPromotionInput({ price, em_promocao, preco_original });
      await ensureBarcodeAvailable(req.tenantId, normalizedBarcode);
      const maxOrdem = await q1('SELECT COALESCE(MAX(ordem),0)+1 AS next FROM produtos WHERE tenant_id=?', [req.tenantId]);
      const isComboVal = is_combo === true || is_combo === 1 || String(is_combo) === '1' ? 1 : 0;
      const id = await qInsert(
        'INSERT INTO produtos (public_id,name,price,category,active,color,codigo_barras,marca,descricao,custo,destaque,em_promocao,preco_original,ordem,disponivel_de,disponivel_ate,requires_preparation,production_type,mais_vendido,is_combo,tenant_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [generatePublicId('prd'), name, price, category, active?1:0, color||'zinc', normalizedBarcode, marca||null, descricao||null, custo||0, destaque?1:0, normalizedPromotion.emPromocao, normalizedPromotion.precoOriginal, maxOrdem?.next||0, disponivel_de||null, disponivel_ate||null, normalizedProduction.requiresPreparation, normalizedProduction.productionType, mais_vendido ? 1 : 0, isComboVal, req.tenantId]
      );
      res.json({ id });
    } catch (e: unknown) {
      const errorMsg = String((e as Error)?.message || '');
      const isBiz =
        errorMsg.includes('c\u00F3digo de barras') ||
        errorMsg.toLowerCase().includes('promoc') ||
        errorMsg.toLowerCase().includes('preco');
      if (isBiz) {
        return res.status(400).json({ error: errorMsg });
      }
      sendInternalError(res, 'routes/products:post', e);
    }
  });

  router.put('/reorder', async (req: Request, res) => {
    try {
      const { items } = req.body;
      if (!Array.isArray(items)) return res.status(400).json({ error: 'items deve ser array' });
      for (const item of items) await qRun('UPDATE produtos SET ordem=? WHERE id=? AND tenant_id=?', [item.ordem, item.id, req.tenantId]);
      res.json({ success: true });
    } catch (e: unknown) {
      const msg = String((e as Error)?.message ?? '');
      if (msg.includes('c\u00F3digo de barras')) {
        return res.status(400).json({ error: msg });
      }
      sendInternalError(res, 'routes/products:reorder', e);
    }
  });

  router.put('/:id', async (req: Request, res) => {
    try {
      const {
        name,
        price,
        category,
        active,
        color,
        codigo_barras,
        marca,
        descricao,
        custo,
        destaque,
        em_promocao,
        preco_original,
        disponivel_de,
        disponivel_ate,
        requires_preparation,
        production_type,
        mais_vendido,
        is_combo,
      } = req.body;
      const current = await q1<{
        codigo_barras?: string | null;
        requires_preparation?: number | null;
        production_type?: string | null;
        name?: string | null;
        category?: string | null;
        price?: number | null;
        em_promocao?: number | null;
        preco_original?: number | null;
      }>(
        'SELECT codigo_barras, requires_preparation, production_type, name, category, price, em_promocao, preco_original FROM produtos WHERE id=? AND tenant_id=?',
        [req.params.id, req.tenantId]
      );
      const normalizedBarcode = normalizeBarcode(codigo_barras);
      const normalizedProduction = normalizeProductProductionInput(
        {
          production_type,
          requires_preparation,
        },
        { name: name ?? current?.name ?? null, category: category ?? current?.category ?? null },
        {
          production_type: current?.production_type,
          requires_preparation: current?.requires_preparation,
        },
      );
      if (normalizedBarcode !== normalizeBarcode(current?.codigo_barras)) {
        await ensureBarcodeAvailable(req.tenantId, normalizedBarcode, Number(req.params.id));
      }
      const normalizedPromotion = normalizeProductPromotionInput(
        { price, em_promocao, preco_original },
        current
      );
      const hasIsCombo = Object.prototype.hasOwnProperty.call(req.body, 'is_combo');
      const isComboVal = hasIsCombo
        ? (is_combo === true || is_combo === 1 || String(is_combo) === '1' ? 1 : 0)
        : undefined;
      if (isComboVal !== undefined) {
        await qRun(
          'UPDATE produtos SET name=?,price=?,category=?,active=?,color=?,codigo_barras=?,marca=?,descricao=?,custo=?,destaque=?,em_promocao=?,preco_original=?,disponivel_de=?,disponivel_ate=?,requires_preparation=?,production_type=?,mais_vendido=?,is_combo=? WHERE id=? AND tenant_id=?',
          [name, price, category, active?1:0, color||'zinc', normalizedBarcode, marca||null, descricao||null, custo||0, destaque?1:0, normalizedPromotion.emPromocao, normalizedPromotion.precoOriginal, disponivel_de||null, disponivel_ate||null, normalizedProduction.requiresPreparation, normalizedProduction.productionType, mais_vendido ? 1 : 0, isComboVal, req.params.id, req.tenantId]
        );
      } else {
        await qRun(
          'UPDATE produtos SET name=?,price=?,category=?,active=?,color=?,codigo_barras=?,marca=?,descricao=?,custo=?,destaque=?,em_promocao=?,preco_original=?,disponivel_de=?,disponivel_ate=?,requires_preparation=?,production_type=?,mais_vendido=? WHERE id=? AND tenant_id=?',
          [name, price, category, active?1:0, color||'zinc', normalizedBarcode, marca||null, descricao||null, custo||0, destaque?1:0, normalizedPromotion.emPromocao, normalizedPromotion.precoOriginal, disponivel_de||null, disponivel_ate||null, normalizedProduction.requiresPreparation, normalizedProduction.productionType, mais_vendido ? 1 : 0, req.params.id, req.tenantId]
        );
      }
      res.json({ success: true });
    } catch (e: unknown) {
      const errorMsg = String((e as Error)?.message || '');
      const isBiz =
        errorMsg.toLowerCase().includes('promoc') || errorMsg.toLowerCase().includes('preco');
      if (isBiz) {
        return res.status(400).json({ error: errorMsg });
      }
      sendInternalError(res, 'routes/products:put', e);
    }
  });

  router.post('/:id/duplicar', async (req: Request, res) => {
    try {
      const sourceId = Number(req.params.id);
      if (!Number.isInteger(sourceId) || sourceId <= 0) {
        return res.status(400).json({ error: 'Produto inv\u00E1lido' });
      }
      const tenantId = req.tenantId;

      const newId = await withTx(async (client) => {
        const p = await txQ1<Record<string, unknown>>(
          client,
          'SELECT * FROM produtos WHERE id=? AND tenant_id=?',
          [sourceId, tenantId]
        );
        if (!p) return null;

        const maxOrdem = await txQ1<{ next: number }>(
          client,
          'SELECT COALESCE(MAX(ordem),0)+1 AS next FROM produtos WHERE tenant_id=?',
          [tenantId]
        );

        const dupName = `${String(p.name ?? '')} (c\u00F3pia)`;
        const normalizedProduction = normalizeProductProductionInput(
          {
            production_type: p.production_type,
            requires_preparation: p.requires_preparation,
          },
          { name: dupName, category: (p.category as string) ?? null },
          {
            production_type: p.production_type,
            requires_preparation: p.requires_preparation,
          }
        );

        const emPromo = p.em_promocao === true || p.em_promocao === 1 || String(p.em_promocao) === '1' ? 1 : 0;
        const precoOriginalClone =
          emPromo ? (p.preco_original === null || p.preco_original === undefined ? null : Number(p.preco_original)) : null;
        const isComboSource =
          p.is_combo === true || p.is_combo === 1 || String(p.is_combo) === '1' ? 1 : 0;

        const newProductId = await txInsert(
          client,
          `INSERT INTO produtos (
            public_id,name,price,category,active,color,codigo_barras,marca,descricao,custo,destaque,em_promocao,preco_original,ordem,
            disponivel_de,disponivel_ate,requires_preparation,production_type,mais_vendido,is_combo,tenant_id
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            generatePublicId('prd'),
            dupName,
            p.price,
            p.category,
            p.active === true || p.active === 1 || String(p.active) === '1' ? 1 : 0,
            p.color || 'zinc',
            null,
            p.marca ?? null,
            p.descricao ?? null,
            p.custo ?? 0,
            p.destaque === true || p.destaque === 1 || String(p.destaque) === '1' ? 1 : 0,
            emPromo,
            precoOriginalClone,
            maxOrdem?.next ?? 0,
            p.disponivel_de ?? null,
            p.disponivel_ate ?? null,
            normalizedProduction.requiresPreparation,
            normalizedProduction.productionType,
            p.mais_vendido === true || p.mais_vendido === 1 || String(p.mais_vendido) === '1' ? 1 : 0,
            isComboSource,
            tenantId,
          ]
        );

        const grupos = await txQAll<Record<string, unknown>>(
          client,
          'SELECT * FROM produto_grupos_opcao WHERE produto_id=? AND tenant_id=? ORDER BY ordem ASC, id ASC',
          [sourceId, tenantId]
        );

        for (const g of grupos) {
          const newGrupoId = await txInsert(
            client,
            `INSERT INTO produto_grupos_opcao (produto_id,tenant_id,nome,tipo,min_selecoes,max_selecoes,obrigatorio,ordem,ativo,modo_preco)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [
              newProductId,
              tenantId,
              g.nome,
              (g.tipo as string) || 'radio',
              Number(g.min_selecoes) || 0,
              Number(g.max_selecoes) || 1,
              g.obrigatorio === true || g.obrigatorio === 1 || String(g.obrigatorio) === '1' ? 1 : 0,
              Number(g.ordem) || 0,
              g.ativo === false || g.ativo === 0 || String(g.ativo) === '0' ? 0 : 1,
              (g.modo_preco as string) || 'adicional',
            ]
          );

          const itens = await txQAll<Record<string, unknown>>(
            client,
            'SELECT * FROM produto_opcao_itens WHERE grupo_id=? AND tenant_id=? ORDER BY ordem ASC, id ASC',
            [Number(g.id), tenantId]
          );

          for (const it of itens) {
            await txRun(
              client,
              `INSERT INTO produto_opcao_itens (grupo_id,tenant_id,nome,preco_adicional,ordem,ativo)
               VALUES (?,?,?,?,?,?)`,
              [
                newGrupoId,
                tenantId,
                it.nome,
                Number(it.preco_adicional) || 0,
                Number(it.ordem) || 0,
                it.ativo === false || it.ativo === 0 || String(it.ativo) === '0' ? 0 : 1,
              ]
            );
          }
        }

        const comboGrupos = await txQAll<Record<string, unknown>>(
          client,
          'SELECT * FROM produto_combo_grupos WHERE produto_id=? AND tenant_id=? ORDER BY ordem ASC, id ASC',
          [sourceId, tenantId]
        );
        for (const cg of comboGrupos) {
          const newGrupoId = await txInsert(
            client,
            `INSERT INTO produto_combo_grupos (tenant_id, produto_id, nome, ordem, obrigatorio, qtd_min, qtd_max, ativo)
             VALUES (?,?,?,?,?,?,?,?)`,
            [
              tenantId,
              newProductId,
              cg.nome,
              Number(cg.ordem) || 0,
              cg.obrigatorio === true || cg.obrigatorio === 1 || String(cg.obrigatorio) === '1' ? 1 : 0,
              Math.max(0, Number(cg.qtd_min) || 0),
              Math.max(0, Number(cg.qtd_max) || 0),
              cg.ativo === false || cg.ativo === 0 || String(cg.ativo) === '0' ? 0 : 1,
            ]
          );
          const cLinks = await txQAll<Record<string, unknown>>(
            client,
            'SELECT * FROM produto_combo_grupo_produtos WHERE grupo_id=? AND tenant_id=? ORDER BY ordem ASC, id ASC',
            [Number(cg.id), tenantId]
          );
          for (const cl of cLinks) {
            const compId = Number(cl.produto_componente_id);
            if (!Number.isInteger(compId) || compId <= 0) continue;
            const exists = await txQ1(client, 'SELECT id FROM produtos WHERE id=? AND tenant_id=?', [compId, tenantId]);
            if (!exists) continue;
            await txRun(
              client,
              `INSERT INTO produto_combo_grupo_produtos (tenant_id, grupo_id, produto_componente_id, ordem, ativo)
               VALUES (?,?,?,?,?)`,
              [
                tenantId,
                newGrupoId,
                compId,
                Number(cl.ordem) || 0,
                cl.ativo === false || cl.ativo === 0 || String(cl.ativo) === '0' ? 0 : 1,
              ]
            );
          }
        }

        const variacoes = await txQAll<Record<string, unknown>>(
          client,
          `SELECT nome, preco, ativo, ordem, ingrediente_id
           FROM produto_variacoes_vendaveis
           WHERE tenant_id=? AND produto_id=?
           ORDER BY ordem ASC, id ASC`,
          [tenantId, sourceId]
        );
        for (const v of variacoes) {
          let ingredienteId: number | null = null;
          if (v.ingrediente_id != null && v.ingrediente_id !== '') {
            const iid = Number(v.ingrediente_id);
            if (Number.isInteger(iid) && iid > 0) {
              const ing = await txQ1(client, 'SELECT id FROM ingredientes WHERE id=? AND tenant_id=?', [
                iid,
                tenantId,
              ]);
              if (ing) ingredienteId = iid;
            }
          }
          await txRun(
            client,
            `INSERT INTO produto_variacoes_vendaveis (tenant_id, produto_id, nome, preco, codigo_barras, ativo, ordem, ingrediente_id)
             VALUES (?,?,?,?,?,?,?,?)`,
            [
              tenantId,
              newProductId,
              v.nome,
              Number(v.preco) || 0,
              null,
              v.ativo === false || v.ativo === 0 || String(v.ativo) === '0' ? 0 : 1,
              Number(v.ordem) || 0,
              ingredienteId,
            ]
          );
        }

        const ings = await txQAll<Record<string, unknown>>(
          client,
          'SELECT ingrediente_id, quantidade_usada, unidade FROM produto_ingrediente WHERE product_id=? AND tenant_id=?',
          [sourceId, tenantId]
        );
        for (const row of ings) {
          await txRun(
            client,
            `INSERT INTO produto_ingrediente (product_id,ingrediente_id,quantidade_usada,unidade,tenant_id)
             VALUES (?,?,?,?,?)`,
            [
              newProductId,
              row.ingrediente_id,
              Number(row.quantidade_usada) || 0,
              (row.unidade as string) || 'unidade',
              tenantId,
            ]
          );
        }

        return Number(newProductId);
      });

      if (newId == null) {
        return res.status(404).json({ error: 'Produto n\u00E3o encontrado' });
      }
      res.json({ id: newId, success: true });
    } catch (e: unknown) {
      sendInternalError(res, 'routes/products:duplicar', e);
    }
  });

  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ success: false, message: 'ID de produto inv\u00E1lido.' });
      }

      await validateSecurityPassword({
        tenantId: req.tenantId,
        userId: req.user?.id,
        password: req.body?.senha,
        type: 'admin',
      });

      const existe = await q1<{ id: number }>(
        'SELECT id FROM produtos WHERE id=? AND tenant_id=?',
        [productId, req.tenantId]
      );
      if (!existe) {
        return res.status(404).json({ success: false, message: 'Produto n\u00E3o encontrado.' });
      }

      const temHistoricoVenda = await produtoTemItensEmPedidos(req.tenantId, productId);
      if (temHistoricoVenda) {
        return res.status(400).json({
          success: false,
          code: 'PRODUCT_HAS_SALES_HISTORY',
          message:
            'Este produto j\u00E1 possui hist\u00F3rico de vendas em pedidos e n\u00E3o pode ser exclu\u00EDdo. Os pedidos antigos e relat\u00F3rios continuam v\u00E1lidos. Para ocult\u00E1-lo de novas vendas e do card\u00E1pio online, inative o produto em vez de excluir.',
        });
      }

      const produto = await q1<{ photo_url?: string | null }>(
        'SELECT photo_url FROM produtos WHERE id=? AND tenant_id=?',
        [productId, req.tenantId]
      );
      await deleteStoredUpload(produto?.photo_url ?? null);
      const grupos = await qAll('SELECT id FROM produto_grupos_opcao WHERE produto_id=? AND tenant_id=?', [
        productId,
        req.tenantId,
      ]);
      for (const g of grupos) await qRun('DELETE FROM produto_opcao_itens WHERE grupo_id=? AND tenant_id=?', [g.id, req.tenantId]);
      await qRun('DELETE FROM produto_grupos_opcao WHERE produto_id=? AND tenant_id=?', [productId, req.tenantId]);
      await qRun('DELETE FROM produtos WHERE id=? AND tenant_id=?', [productId, req.tenantId]);
      res.json({ success: true });
    } catch (e: any) {
      if (e.code === '23503') {
        return res.status(400).json({
          success: false,
          code: 'PRODUCT_HAS_SALES_HISTORY',
          message:
            'Este produto n\u00E3o pode ser exclu\u00EDdo porque ainda h\u00E1 refer\u00EAncias em vendas ou pedidos. Inative o produto para retir\u00E1-lo do card\u00E1pio sem perder o hist\u00F3rico.',
        });
      }
      next(e);
    }
  });

  router.post('/:id/photo', upload.single('photo'), hardenUploadedImageFile({ allowGif: true }), async (req: any, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado' });
      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ success: false, message: 'Produto inv\u00E1lido' });
      }
      const old = await q1('SELECT photo_url FROM produtos WHERE id=? AND tenant_id=?', [productId, req.tenantId]);
      await deleteStoredUpload(old?.photo_url ?? null);
      let photoUrl: string;
      try {
        photoUrl = await persistMulterImageFile({
          file: req.file,
          uploadToCloudinary: () =>
            uploadProductImageToCloudinary({
              buffer: req.file.buffer as Buffer,
              tenantId: req.tenantId,
              productId,
            }),
          localPublicPath: `/uploads/${req.file.filename}`,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : '';
        if (msg === 'EMPTY_IMAGE_BUFFER') {
          return res.status(400).json({ success: false, message: 'Arquivo vazio ou n\u00E3o recebido' });
        }
        throw e;
      }
      await qRun('UPDATE produtos SET photo_url=? WHERE id=? AND tenant_id=?', [photoUrl, productId, req.tenantId]);
      res.json({ success: true, photo_url: photoUrl });
    } catch (e: unknown) { sendInternalError(res, 'routes/products', e); }
  });

  router.delete('/:id/photo', async (req: Request, res) => {
    try {
      const p = await q1('SELECT photo_url FROM produtos WHERE id=? AND tenant_id=?', [req.params.id, req.tenantId]);
      await deleteStoredUpload(p?.photo_url ?? null);
      await qRun('UPDATE produtos SET photo_url=NULL WHERE id=? AND tenant_id=?', [req.params.id, req.tenantId]);
      res.json({ success: true });
    } catch (e: unknown) { sendInternalError(res, 'routes/products', e); }
  });

  router.get('/:id/combo', async (req: Request, res) => {
    try {
      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ error: 'Produto invalido' });
      }
      const produto = await q1<{ is_combo: number }>(
        'SELECT COALESCE(is_combo,0) AS is_combo FROM produtos WHERE id=? AND tenant_id=?',
        [productId, req.tenantId]
      );
      if (!produto) return res.status(404).json({ error: 'Produto nao encontrado' });
      const rows = await loadComboGruposForProduto(req.tenantId, productId, false);
      res.json({
        is_combo: Number(produto.is_combo) === 1,
        grupos: mapComboGruposPublic(rows, false),
      });
    } catch (e: unknown) {
      sendInternalError(res, 'routes/products:combo-get', e);
    }
  });

  /** Substitui grupos e produtos permitidos do combo em uma transacao (validacao centralizada). */
  router.put('/:id/combo/definicao', async (req: Request, res) => {
    try {
      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ error: 'Produto invalido' });
      }
      const p = await q1<{ is_combo: number }>(
        'SELECT COALESCE(is_combo,0) AS is_combo FROM produtos WHERE id=? AND tenant_id=?',
        [productId, req.tenantId]
      );
      if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });
      if (Number(p.is_combo) !== 1) {
        return res.status(400).json({ error: 'Marque o produto como combo antes de salvar a definicao.' });
      }
      const grupos = parseProductComboDefinicaoBody(req.body);
      await assertComponentesComboDefinicao(req.tenantId, productId, grupos);

      await withTx(async (client) => {
        await txRun(
          client,
          'DELETE FROM produto_combo_grupos WHERE produto_id=? AND tenant_id=?',
          [productId, req.tenantId]
        );
        for (const g of grupos) {
          const gid = await txInsert(
            client,
            `INSERT INTO produto_combo_grupos (tenant_id, produto_id, nome, ordem, obrigatorio, qtd_min, qtd_max, ativo)
             VALUES (?,?,?,?,?,?,?,?)`,
            [req.tenantId, productId, g.nome, g.ordem, g.obrigatorio, g.qtd_min, g.qtd_max, g.ativo]
          );
          let ordemLink = 0;
          for (const compId of g.product_ids) {
            await txRun(
              client,
              `INSERT INTO produto_combo_grupo_produtos (tenant_id, grupo_id, produto_componente_id, ordem, ativo)
               VALUES (?,?,?,?,1)`,
              [req.tenantId, Number(gid), compId, ordemLink++]
            );
          }
        }
      });

      const rows = await loadComboGruposForProduto(req.tenantId, productId, false);
      res.json({
        success: true,
        grupos: mapComboGruposPublic(rows, false),
      });
    } catch (e: unknown) {
      if (isAppError(e)) return res.status(e.statusCode).json({ error: e.message });
      sendInternalError(res, 'routes/products:combo-definicao-put', e);
    }
  });

  router.post('/:id/combo/grupos', async (req: Request, res) => {
    try {
      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ error: 'Produto invalido' });
      }
      const p = await q1<{ is_combo: number }>(
        'SELECT COALESCE(is_combo,0) AS is_combo FROM produtos WHERE id=? AND tenant_id=?',
        [productId, req.tenantId]
      );
      if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });
      if (Number(p.is_combo) !== 1) {
        return res.status(400).json({ error: 'Marque o produto como combo antes de criar grupos.' });
      }
      const fields = parseComboGrupoFields(req.body, { defaultQtdMax: 1 });
      const maxOrdem = await q1<{ next: number }>(
        'SELECT COALESCE(MAX(ordem),0)+1 AS next FROM produto_combo_grupos WHERE produto_id=? AND tenant_id=?',
        [productId, req.tenantId]
      );
      const ordem = fields.ordem !== undefined ? fields.ordem : Number(maxOrdem?.next ?? 0);
      const id = await qInsert(
        `INSERT INTO produto_combo_grupos (tenant_id, produto_id, nome, ordem, obrigatorio, qtd_min, qtd_max, ativo)
         VALUES (?,?,?,?,?,?,?,1)`,
        [req.tenantId, productId, fields.nome, ordem, fields.obrigatorio, fields.qtd_min, fields.qtd_max]
      );
      res.json({ success: true, id });
    } catch (e: unknown) {
      if (isAppError(e)) return res.status(e.statusCode).json({ error: e.message });
      sendInternalError(res, 'routes/products:combo-grupo-post', e);
    }
  });

  router.put('/combo/grupos/:grupoId', async (req: Request, res) => {
    try {
      const grupoId = Number(req.params.grupoId);
      if (!Number.isInteger(grupoId) || grupoId <= 0) {
        return res.status(400).json({ error: 'Grupo invalido' });
      }
      const g = await q1(
        'SELECT id FROM produto_combo_grupos WHERE id=? AND tenant_id=?',
        [grupoId, req.tenantId]
      );
      if (!g) return res.status(404).json({ error: 'Grupo nao encontrado' });
      const fields = parseComboGrupoFields(req.body, { defaultQtdMax: 0 });
      const ordem = fields.ordem !== undefined ? fields.ordem : 0;
      await qRun(
        `UPDATE produto_combo_grupos SET nome=?, ordem=?, obrigatorio=?, qtd_min=?, qtd_max=?, ativo=?
         WHERE id=? AND tenant_id=?`,
        [fields.nome, ordem, fields.obrigatorio, fields.qtd_min, fields.qtd_max, fields.ativo, grupoId, req.tenantId]
      );
      res.json({ success: true });
    } catch (e: unknown) {
      if (isAppError(e)) return res.status(e.statusCode).json({ error: e.message });
      sendInternalError(res, 'routes/products:combo-grupo-put', e);
    }
  });

  router.delete('/combo/grupos/:grupoId', async (req: Request, res) => {
    try {
      const grupoId = Number(req.params.grupoId);
      if (!Number.isInteger(grupoId) || grupoId <= 0) {
        return res.status(400).json({ error: 'Grupo invalido' });
      }
      await qRun('DELETE FROM produto_combo_grupos WHERE id=? AND tenant_id=?', [grupoId, req.tenantId]);
      res.json({ success: true });
    } catch (e: unknown) {
      sendInternalError(res, 'routes/products:combo-grupo-del', e);
    }
  });

  router.post('/combo/grupos/:grupoId/produtos', async (req: Request, res) => {
    try {
      const grupoId = Number(req.params.grupoId);
      if (!Number.isInteger(grupoId) || grupoId <= 0) {
        return res.status(400).json({ error: 'Grupo invalido' });
      }
      const g = await q1<{ produto_id: number }>(
        'SELECT produto_id FROM produto_combo_grupos WHERE id=? AND tenant_id=?',
        [grupoId, req.tenantId]
      );
      if (!g) return res.status(404).json({ error: 'Grupo nao encontrado' });
      const componentId = Number(req.body?.product_id);
      if (!Number.isInteger(componentId) || componentId <= 0) {
        return res.status(400).json({ error: 'product_id invalido' });
      }
      await assertProdutoPermitidoComoComponenteCombo({
        tenantId: req.tenantId,
        comboProductId: Number(g.produto_id),
        componentProductId: componentId,
      });
      const dup = await q1(
        'SELECT id FROM produto_combo_grupo_produtos WHERE tenant_id=? AND grupo_id=? AND produto_componente_id=?',
        [req.tenantId, grupoId, componentId]
      );
      if (dup) return res.status(400).json({ error: 'Este produto ja esta no grupo.' });
      const maxOrdem = await q1(
        'SELECT COALESCE(MAX(ordem),0)+1 AS next FROM produto_combo_grupo_produtos WHERE grupo_id=? AND tenant_id=?',
        [grupoId, req.tenantId]
      );
      const id = await qInsert(
        `INSERT INTO produto_combo_grupo_produtos (tenant_id, grupo_id, produto_componente_id, ordem, ativo)
         VALUES (?,?,?,?,1)`,
        [req.tenantId, grupoId, componentId, maxOrdem?.next ?? 0]
      );
      res.json({ success: true, id });
    } catch (e: unknown) {
      if (isAppError(e)) return res.status(e.statusCode).json({ error: e.message });
      sendInternalError(res, 'routes/products:combo-prod-post', e);
    }
  });

  router.delete('/combo/produtos/:linkId', async (req: Request, res) => {
    try {
      const linkId = Number(req.params.linkId);
      if (!Number.isInteger(linkId) || linkId <= 0) {
        return res.status(400).json({ error: 'Link invalido' });
      }
      await qRun('DELETE FROM produto_combo_grupo_produtos WHERE id=? AND tenant_id=?', [linkId, req.tenantId]);
      res.json({ success: true });
    } catch (e: unknown) {
      sendInternalError(res, 'routes/products:combo-prod-del', e);
    }
  });

  router.get('/:id/opcoes', async (req: Request, res) => {
    try {
      const result = await loadProdutoGruposOpcao(req.tenantId, Number(req.params.id), {
        onlyActiveItens: false,
      });
      res.json(result);
    } catch (e: unknown) { sendInternalError(res, 'routes/products', e); }
  });

  router.post('/:id/opcoes/grupos', async (req: Request, res) => {
    try {
      const { nome, tipo, min_selecoes, max_selecoes, obrigatorio, ordem, modo_preco } = req.body;
      if (!nome?.trim()) return res.status(400).json({ error: 'Nome obrigat\u00F3rio' });
      const maxOrdem = await q1('SELECT COALESCE(MAX(ordem),0)+1 AS next FROM produto_grupos_opcao WHERE produto_id=? AND tenant_id=?', [req.params.id, req.tenantId]);
      const id = await qInsert(
        'INSERT INTO produto_grupos_opcao (produto_id,tenant_id,nome,tipo,min_selecoes,max_selecoes,obrigatorio,ordem,modo_preco) VALUES (?,?,?,?,?,?,?,?,?)',
        [req.params.id, req.tenantId, nome.trim(), tipo||'radio', min_selecoes||0, max_selecoes||1, obrigatorio?1:0, ordem??maxOrdem?.next??0, modo_preco||'adicional']
      );
      res.json({ success: true, id });
    } catch (e: unknown) { sendInternalError(res, 'routes/products', e); }
  });

  router.put('/opcoes/grupos/:grupoId', async (req: Request, res) => {
    try {
      const { nome, tipo, min_selecoes, max_selecoes, obrigatorio, ordem, ativo, modo_preco } = req.body;
      await qRun(
        'UPDATE produto_grupos_opcao SET nome=?,tipo=?,min_selecoes=?,max_selecoes=?,obrigatorio=?,ordem=?,ativo=?,modo_preco=? WHERE id=? AND tenant_id=?',
        [nome, tipo||'radio', min_selecoes||0, max_selecoes||1, obrigatorio?1:0, ordem||0, ativo!==false&&ativo!==0?1:0, modo_preco||'adicional', req.params.grupoId, req.tenantId]
      );
      res.json({ success: true });
    } catch (e: unknown) { sendInternalError(res, 'routes/products', e); }
  });

  router.delete('/opcoes/grupos/:grupoId', async (req: Request, res) => {
    try {
      await qRun('DELETE FROM produto_opcao_itens WHERE grupo_id=? AND tenant_id=?', [req.params.grupoId, req.tenantId]);
      await qRun('DELETE FROM produto_grupos_opcao WHERE id=? AND tenant_id=?', [req.params.grupoId, req.tenantId]);
      res.json({ success: true });
    } catch (e: unknown) { sendInternalError(res, 'routes/products', e); }
  });

  router.post('/opcoes/grupos/:grupoId/itens', async (req: Request, res) => {
    try {
      const { nome, preco_adicional, ordem } = req.body;
      if (!nome?.trim()) return res.status(400).json({ error: 'Nome obrigat\u00F3rio' });
      const maxOrdem = await q1('SELECT COALESCE(MAX(ordem),0)+1 AS next FROM produto_opcao_itens WHERE grupo_id=? AND tenant_id=?', [req.params.grupoId, req.tenantId]);
      const id = await qInsert(
        'INSERT INTO produto_opcao_itens (grupo_id,tenant_id,nome,preco_adicional,ordem) VALUES (?,?,?,?,?)',
        [req.params.grupoId, req.tenantId, nome.trim(), parseFloat(preco_adicional)||0, ordem??maxOrdem?.next??0]
      );
      res.json({ success: true, id });
    } catch (e: unknown) { sendInternalError(res, 'routes/products', e); }
  });

  router.put('/opcoes/itens/:itemId', async (req: Request, res) => {
    try {
      const { nome, preco_adicional, ordem, ativo } = req.body;
      if (ativo === undefined) {
        await qRun('UPDATE produto_opcao_itens SET nome=?,preco_adicional=?,ordem=? WHERE id=? AND tenant_id=?',
          [nome, parseFloat(preco_adicional)||0, ordem||0, req.params.itemId, req.tenantId]);
      } else {
        await qRun('UPDATE produto_opcao_itens SET nome=?,preco_adicional=?,ordem=?,ativo=? WHERE id=? AND tenant_id=?',
          [nome, parseFloat(preco_adicional)||0, ordem||0, ativo?1:0, req.params.itemId, req.tenantId]);
      }
      res.json({ success: true });
    } catch (e: unknown) { sendInternalError(res, 'routes/products', e); }
  });

  router.delete('/opcoes/itens/:itemId', async (req: Request, res) => {
    try {
      await qRun('DELETE FROM produto_opcao_itens WHERE id=? AND tenant_id=?', [req.params.itemId, req.tenantId]);
      res.json({ success: true });
    } catch (e: unknown) { sendInternalError(res, 'routes/products', e); }
  });

  return router;
}
