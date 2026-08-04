import crypto from 'node:crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { q1, qAll, qInsert, qRun } from '../db';
import {
  authenticateToken,
  authenticateTokenOrGarcomTemp,
  restrictGarcomTempScope,
  signGarcomTempToken,
  extractBearerToken,
  JWT_SECRET,
  publicRateLimit,
  requireTrustedBrowserOrigin,
  requireAnyPermission,
  requirePlanFeature,
  resolveAuthenticatedSession,
} from '../middleware';
import { AppError } from '../utils/errors';
import { sendInternalError } from '../utils/internalServerError';
import { createExpensesRouter } from '../expenses/expenses';
import { createAdminRouter } from './admin';
import { createAiRouter } from './ai';
import { createAuthRouter } from './auth';
import { createCaixaRouter, createDashboardRouter } from './dashboard';
import { createDeliveryRouter } from './delivery';
import { createEstoqueRouter } from './estoque';
import { createLogsRouter, createUsuariosRouter, createAcessoFuncRouter } from './logs';
import { createMesasRouter } from './mesas';
import { createOrdersRouter } from './orders';
import { createClientesRouter } from './clientes';
import { createChatbotRouter } from './chatbot';
import { createPrintRouter } from './print';
import { createProductsRouter } from './products';
import { createRhRouter } from './rh';
import { createSettingsRouter, createCategoriesRouter } from './settings';
import { createLegalRouter } from './legal';
import { createPrivacidadeRouter } from './privacidade';
import { createWhatsAppRouter } from './whatsapp';
import { createWebhooksRouter } from './webhooks';
import { createAtendimentoRouter } from './atendimento';
import { deletePointRecord, updatePointRecord } from '../services/pointService';
import { setupSseStream } from '../sse';

type TenantRequest = Request & {
  tenantId: number | string;
};

type AsyncRouteHandler = (
  req: TenantRequest,
  res: Response,
  next: NextFunction
) => Promise<void>;

function asyncHandler(handler: AsyncRouteHandler) {
  return (req: TenantRequest, res: Response, next: NextFunction) => {
    void handler(req, res, next).catch(next);
  };
}

function createPontosRouter() {
  const router = Router();

  router.put(
    '/:pontId',
    asyncHandler(async (req, res) => {
      const { hora, tipo } = req.body ?? {};
      const result = await updatePointRecord({
        tenantId: req.tenantId,
        pointId: req.params.pontId,
        hora: String(hora || ''),
        tipo: tipo != null ? String(tipo) : null,
      });
      if (result.ok === false) {
        throw new AppError(result.error, result.status);
      }

      res.json({ success: true });
    })
  );

  router.delete(
    '/:pontId',
    asyncHandler(async (req, res) => {
      const result = await deletePointRecord({
        tenantId: req.tenantId,
        pointId: req.params.pontId,
      });
      if (result.ok === false) {
        throw new AppError(result.error, result.status);
      }

      res.json({ success: true });
    })
  );

  return router;
}

export function createApiRouter() {
  const router = Router();
  const protectedRouter = Router();
  const requireBrowserOrigin = requireTrustedBrowserOrigin();

  router.use(createAuthRouter());
  router.use(createAdminRouter());
  router.use('/webhooks', createWebhooksRouter());
  router.get('/events', async (req, res) => {
    const session = await resolveAuthenticatedSession(req);
    if (session.ok === false) {
      return res.status(session.status).end();
    }

    const tenantId = Number(session.tenantId);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(401).end();
    }

    setupSseStream(tenantId, req, res);
  });

  router.post(
    '/products/suggestions/event',
    publicRateLimit,
    requireBrowserOrigin,
    async (req: Request, res: Response) => {
      try {
        let tenantId: number | null = null;

        if (extractBearerToken(req)) {
          const session = await resolveAuthenticatedSession(req);
          if (session.ok === false) {
            return res.status(session.status).json(session.body);
          }
          tenantId = session.tenantId;
        } else {
          const slug = typeof req.query.slug === 'string' ? req.query.slug.trim() : '';
          if (!slug) {
            return res.status(400).json({ error: 'slug obrigatório' });
          }
          const tenant = await q1<{ id: number }>(
            'SELECT id FROM clientes WHERE usuario=? AND status=?',
            [slug, 'ativo']
          );
          if (!tenant) {
            return res.status(404).json({ error: 'Loja não encontrada' });
          }
          tenantId = tenant.id;
        }

        const sourceProductId = Number(req.body?.sourceProductId);
        const suggestedProductId = Number(req.body?.suggestedProductId);

        if (
          !Number.isInteger(sourceProductId) ||
          sourceProductId <= 0 ||
          !Number.isInteger(suggestedProductId) ||
          suggestedProductId <= 0
        ) {
          return res.status(400).json({ error: 'sourceProductId e suggestedProductId são obrigatórios' });
        }

        if (sourceProductId === suggestedProductId) {
          return res.status(400).json({ error: 'Produto de origem e sugerido devem ser diferentes' });
        }

        const produtosOk = await qAll<{ id: number }>(
          'SELECT id FROM produtos WHERE tenant_id=? AND id IN (?,?) AND active=1',
          [tenantId, sourceProductId, suggestedProductId]
        );

        if (produtosOk.length !== 2) {
          return res.status(400).json({ error: 'Produtos inválidos para este estabelecimento' });
        }

        await qInsert(
          'INSERT INTO sugestoes_eventos (tenant_id, produto_origem_id, produto_sugerido_id) VALUES (?, ?, ?)',
          [tenantId, sourceProductId, suggestedProductId]
        );

        return res.json({ success: true });
      } catch (e: unknown) {
        sendInternalError(res, 'POST /products/suggestions/event', e);
      }
    }
  );

  protectedRouter.use(authenticateToken);
  protectedRouter.use('/legal', createLegalRouter());
  protectedRouter.use('/privacidade', createPrivacidadeRouter());
  protectedRouter.use('/products', requirePlanFeature('products'), createProductsRouter());
  protectedRouter.use('/settings', requirePlanFeature('configuracoes'), requireAnyPermission('configuracoes'), createSettingsRouter());
  protectedRouter.use('/categories', requirePlanFeature('products'), requireAnyPermission('products'), createCategoriesRouter());
  protectedRouter.use('/print', requirePlanFeature('print'), createPrintRouter());
  protectedRouter.use('/orders', requirePlanFeature('orders'), createOrdersRouter());
  protectedRouter.use('/clientes', createClientesRouter());
  protectedRouter.use('/expenses', requirePlanFeature('finance'), requireAnyPermission('finance'), createExpensesRouter());
  protectedRouter.use('/dashboard', requirePlanFeature('dashboard'), requireAnyPermission('dashboard'), createDashboardRouter());
  protectedRouter.use('/caixa', requirePlanFeature('caixa'), requireAnyPermission('finance'), createCaixaRouter());
  protectedRouter.use('/estoque', requirePlanFeature('estoque'), createEstoqueRouter());
  protectedRouter.use('/delivery', requirePlanFeature('delivery'), createDeliveryRouter());
  protectedRouter.use('/atendimento', requirePlanFeature('delivery'), createAtendimentoRouter());
  protectedRouter.use('/whatsapp', createWhatsAppRouter());
  protectedRouter.use('/chatbot', createChatbotRouter());
  protectedRouter.use('/ai', createAiRouter());
  protectedRouter.use('/logs', requirePlanFeature('logs'), requireAnyPermission('logs'), createLogsRouter());
  protectedRouter.use('/usuarios', requirePlanFeature('funcionarios'), requireAnyPermission('funcionarios'), createUsuariosRouter());
  protectedRouter.use('/funcionarios', requirePlanFeature('funcionarios'), requireAnyPermission('funcionarios'), createRhRouter());
  protectedRouter.use('/funcionarios', requirePlanFeature('funcionarios'), requireAnyPermission('funcionarios'), createAcessoFuncRouter());
  protectedRouter.use('/pontos', requirePlanFeature('funcionarios'), requireAnyPermission('funcionarios'), createPontosRouter());

  // ── Gerador de tokens para telas operacionais (KDS / Ponto) ─────────────
  // GET /api/kiosk-token?purpose=kds  |  GET /api/kiosk-token?purpose=ponto
  // Requer JWT válido (authenticateToken já aplicado pelo protectedRouter).
  // O frontend armazena o token em memória e envia via header X-Kiosk-Token.
  protectedRouter.get('/kiosk-token', async (req: any, res: Response) => {
    try {
      const purpose = String(req.query.purpose || '').trim() as 'kds' | 'ponto';
      if (purpose !== 'kds' && purpose !== 'ponto') {
        return res.status(400).json({ error: "purpose deve ser 'kds' ou 'ponto'" });
      }

      const tenant = await q1<{ usuario: string }>(
        'SELECT usuario FROM clientes WHERE id=?',
        [req.tenantId]
      );
      if (!tenant) return res.status(404).json({ error: 'Tenant não encontrado' });

      const secret = process.env.KIOSK_TOKEN_SECRET || JWT_SECRET;
      const token = crypto
        .createHmac('sha256', secret)
        .update(`${purpose}:${tenant.usuario}`)
        .digest('hex');

      res.json({ token, slug: tenant.usuario, purpose });
    } catch (e: unknown) {
      sendInternalError(res, 'GET /kiosk-token', e);
    }
  });

  // /mesas usa um middleware de auth próprio (aceita sessão normal OU o QR
  // temporário do garçom), por isso fica fora do protectedRouter — que exige
  // sempre o JWT completo de sessão.
  router.use(
    '/mesas',
    authenticateTokenOrGarcomTemp,
    restrictGarcomTempScope,
    requirePlanFeature('mesas'),
    requireAnyPermission('mesas'),
    createMesasRouter()
  );

  router.use(protectedRouter);

  return router;
}