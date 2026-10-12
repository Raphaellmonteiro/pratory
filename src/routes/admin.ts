// src/routes/admin.ts — painel administrativo FlowPDV
import fs from 'fs';
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { q1, qAll, qRun, qInsert, withTx, txInsert, txRun, txQ1, txQAll } from '../db';
import {
  loginRateLimiter,
  authenticateToken,
  authenticateAdmin,
  ADMIN_SECRET,
  JWT_SECRET,
  requireTrustedBrowserOrigin,
} from '../middleware';
import { logError } from '../utils/logger';
import { isAppError } from '../utils/errors';
import { sendInternalError } from '../utils/internalServerError';
import { parseBodyOrReply, replyZod400ErrorKey } from '../validation/zodHttp';
import { adminLgpdStatusPatchSchema } from '../validation/schemas/privacidade';
import { generatePublicId } from '../utils/publicIds';
import { notifyTenantOrderStreams } from '../sse';
import { coerceDeliveryConfigRow } from '../utils/deliveryConfigPersist';
import { getPlanFeatures, type PaidTenantPlan, type PlanFeature } from '../config/planFeatures';
import { ADMIN_AUDIT_ACTIONS } from '../services/adminAuditActions';
import { registerGestaoDeliveryRoutes } from './adminGestaoDelivery';
import { listAdminAuditEvents, writeAdminAuditEvent } from '../services/adminAuditService';
import { invalidateTenantPlanCache } from '../services/tenantPlan';
import { revalidatePixPaymentByOrder } from '../services/pixPaymentRevalidationService';
import { normalizeProductProductionInput } from '../utils/preparation';
import { hashPlainSecurityPassword } from '../utils/securityPasswordStorage';
import { resolveProductUploadDiskPath } from '../utils/productPhotoFs';
import { normalizeProductPhotoPublicUrl } from '../utils/productPhotoUrl';
import {
  emitWhatsAppOrderStatusEvent,
  orderCancelledWhatsAppEvent,
} from '../services/whatsAppEventsService';
import {
  getWhatsAppConversationMessages,
  listWhatsAppConversations,
  normalizeWhatsAppConversationPhone,
  sendWhatsAppConversationMessage,
  type WhatsAppConversationPeriod,
} from '../services/whatsAppConversationService';

const TZ = 'America/Sao_Paulo';
const ADMIN_PLAN_OPTIONS = ['basico', 'basico_delivery', 'completo'] as const;
type AdminManagedPlan = (typeof ADMIN_PLAN_OPTIONS)[number];
type ApprovalPlanContext = {
  storedPlan: AdminManagedPlan;
  effectivePlan: PaidTenantPlan;
  features: PlanFeature[];
  trialDays: number;
  trialActive: boolean;
  trialWindow: ReturnType<typeof buildTrialWindow>;
};

function getTodayDateInTimeZone(): string {
  const today = new Date().toLocaleString('en-US', { timeZone: TZ }).split(',')[0];
  const date = new Date(today);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizeAdminPlan(rawPlan?: unknown): AdminManagedPlan {
  const plan = String(rawPlan || '').trim().toLowerCase();
  if (ADMIN_PLAN_OPTIONS.includes(plan as AdminManagedPlan)) {
    return plan as AdminManagedPlan;
  }
  return 'completo';
}

function parseTrialDays(rawValue: unknown, fallback = 7): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(365, Math.floor(parsed)));
}

/** COUNT(*) no pg pode vir como string ou bigint; normaliza para número JSON-safe. */
function sqlCount(row: { c?: unknown } | null | undefined): number {
  const v = row?.c;
  if (v == null) return 0;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sendAdminRouteError(res: Response, context: string, error: unknown) {
  if (isAppError(error)) {
    return res.status(error.statusCode).json({
      success: false,
      error: error.message,
      code: error.code,
    });
  }

  sendInternalError(res, context, error);
}

function buildTrialWindow(days: number) {
  if (days <= 0) {
    return {
      trialInicio: null,
      trialFim: null,
      vencimento: null,
    };
  }

  const trialInicio = new Date();
  const trialFim = new Date(trialInicio);
  trialFim.setDate(trialFim.getDate() + days);

  return {
    trialInicio: trialInicio.toISOString(),
    trialFim: trialFim.toISOString(),
    vencimento: trialFim.toISOString(),
  };
}

function buildApprovalPlanContext(rawPlan: unknown, rawTrialDays: unknown): ApprovalPlanContext {
  const storedPlan = normalizeAdminPlan(rawPlan);
  const trialDays = parseTrialDays(rawTrialDays, 7);
  const trialWindow = buildTrialWindow(trialDays);
  const trialActive = trialDays > 0;
  const effectivePlan: PaidTenantPlan = storedPlan;

  return {
    storedPlan,
    effectivePlan,
    features: getPlanFeatures(effectivePlan),
    trialDays,
    trialActive,
    trialWindow,
  };
}

function readOptionalQueryText(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized : null;
}

function normalizeAuditDateQuery(value: unknown, endOfDay = false): string | null {
  const normalized = readOptionalQueryText(value);
  if (!normalized) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return `${normalized}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}-03:00`;
  }
  return normalized;
}

function normalizeWhatsAppPeriodQuery(value: unknown): WhatsAppConversationPeriod {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'today' || normalized === '7d' || normalized === '30d' || normalized === 'all') {
    return normalized;
  }
  return '30d';
}

async function buildUniqueTenantUsername(
  client: Parameters<typeof txQ1>[0],
  rawEmail: unknown
): Promise<string> {
  const email = String(rawEmail || '').trim().toLowerCase();
  const emailBase = email.includes('@') ? email.split('@')[0] : email;
  const normalizedBase = emailBase.replace(/[^a-z0-9]/g, '') || 'cliente';

  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = suffix === 0 ? normalizedBase : `${normalizedBase}${suffix + 1}`;
    const existing = await txQ1<{ username?: string | null; usuario?: string | null }>(
      client,
      `SELECT username, NULL::text AS usuario FROM usuarios WHERE username=?
       UNION ALL
       SELECT NULL::text AS username, usuario FROM clientes WHERE usuario=?
       LIMIT 1`,
      [candidate, candidate]
    );

    if (!existing) return candidate;
  }

  throw new Error('Nao foi possivel gerar um usuario unico para a solicitacao');
}

type DiagnosticProblem = {
  id: string;
  category: 'caixa' | 'pedidos' | 'estoque';
  severity: 'low' | 'medium' | 'high';
  title: string;
  description: string;
  action: string;
  data: Record<string, unknown>;
};

async function runDiagnostics(tenantIdFilter?: number): Promise<{ tenant_id: number; nome_estabelecimento: string; problems: DiagnosticProblem[] }[]> {
  const tenants = await qAll<{ id: number; nome_estabelecimento: string }>(
    tenantIdFilter
      ? 'SELECT id, nome_estabelecimento FROM clientes WHERE id=?'
      : 'SELECT id, nome_estabelecimento FROM clientes ORDER BY nome_estabelecimento ASC',
    tenantIdFilter ? [tenantIdFilter] : []
  );
  const todayStr = getTodayDateInTimeZone();
  const result: { tenant_id: number; nome_estabelecimento: string; problems: DiagnosticProblem[] }[] = [];

  for (const t of tenants) {
    const tenantId = t.id;
    const problems: DiagnosticProblem[] = [];

    // 1. Caixa
    const caixasAbertos = await qAll<{ id: number; data: string }>(
      "SELECT id, data FROM caixa WHERE status='aberto' AND tenant_id=? ORDER BY data ASC",
      [tenantId]
    );
    if (caixasAbertos.length > 1) {
      problems.push({
        id: 'caixa_multiplos',
        category: 'caixa',
        severity: 'high',
        title: 'Mais de um caixa aberto',
        description: `${caixasAbertos.length} caixas abertos: ${caixasAbertos.map((c) => `#${c.id} (${c.data})`).join(', ')}`,
        action: 'force_close',
        data: { caixa_ids: caixasAbertos.map((c) => c.id), tenant_id: tenantId },
      });
    }
    if (caixasAbertos.length >= 1) {
      const caixaDiaAnterior = caixasAbertos.find((c) => c.data !== todayStr);
      if (caixaDiaAnterior) {
        problems.push({
          id: 'caixa_dia_anterior',
          category: 'caixa',
          severity: 'medium',
          title: 'Caixa aberto em dia anterior',
          description: `Caixa #${caixaDiaAnterior.id} aberto em ${caixaDiaAnterior.data}, ainda não fechado`,
          action: 'force_close',
          data: { caixa_id: caixaDiaAnterior.id, tenant_id: tenantId },
        });
      }
    }

    // 2. Pedidos
    const pedidosTravados = await qAll<{ id: number; order_number: string; status: string; created_at: string }>(
      `SELECT id, order_number, status, created_at FROM pedidos
       WHERE tenant_id=? AND status IN ('Criado','Pedido Recebido','Em Preparo','Pronto','Pronto para Entrega','Saiu para Entrega','Aguardando confirmação')
       AND created_at < NOW() - INTERVAL '24 hours'
       AND cancelado_at IS NULL`,
      [tenantId]
    );
    for (const p of pedidosTravados) {
      problems.push({
        id: 'pedidos_travados',
        category: 'pedidos',
        severity: 'medium',
        title: 'Pedido travado há mais de 24h',
        description: `Pedido #${p.order_number || p.id} (${p.status}) desde ${new Date(p.created_at).toLocaleString('pt-BR')}`,
        action: 'fix_status',
        data: { tenant_id: tenantId, order_id: p.id, order_number: p.order_number, current_status: p.status },
      });
    }
    const pedidosSemFinal = await qAll<{ id: number; order_number: string; status: string }>(
      `SELECT id, order_number, status FROM pedidos
       WHERE tenant_id=? AND status NOT IN ('Concluído', 'Entregue', 'Cancelado', 'cancelado')
       AND cancelado_at IS NULL
       AND created_at < NOW() - INTERVAL '7 days'
       LIMIT 20`,
      [tenantId]
    );
    for (const p of pedidosSemFinal) {
      problems.push({
        id: 'pedidos_sem_status_final',
        category: 'pedidos',
        severity: 'low',
        title: 'Pedido antigo sem status final',
        description: `Pedido #${p.order_number || p.id} (${p.status}) há mais de 7 dias`,
        action: 'fix_status',
        data: { tenant_id: tenantId, order_id: p.id, order_number: p.order_number, current_status: p.status },
      });
    }

    // 3. Estoque — produtos ativos sem vínculo
    const produtosSemVinculo = await qAll<{ id: number; name: string }>(
      `SELECT p.id, p.name FROM produtos p
       WHERE p.tenant_id=? AND COALESCE(p.active, 1) = 1
       AND NOT EXISTS (SELECT 1 FROM produto_ingrediente pi WHERE pi.product_id=p.id AND pi.tenant_id=p.tenant_id)
       AND NOT EXISTS (
         SELECT 1 FROM produto_variacoes_vendaveis pv
         WHERE pv.produto_id=p.id AND pv.tenant_id=p.tenant_id AND pv.ingrediente_id IS NOT NULL AND pv.ingrediente_id > 0
       )
       ORDER BY p.name ASC
       LIMIT 50`,
      [tenantId]
    );
    if (produtosSemVinculo.length > 0) {
      problems.push({
        id: 'produtos_sem_vinculo',
        category: 'estoque',
        severity: 'low',
        title: 'Produtos ativos sem vínculo de estoque',
        description: `${produtosSemVinculo.length} produto(s): ${produtosSemVinculo.slice(0, 3).map((pr) => pr.name).join(', ')}${produtosSemVinculo.length > 3 ? '...' : ''}`,
        action: 'fix_links',
        data: { tenant_id: tenantId, count: produtosSemVinculo.length, product_ids: produtosSemVinculo.map((pr) => pr.id) },
      });
    }

    result.push({ tenant_id: tenantId, nome_estabelecimento: t.nome_estabelecimento, problems });
  }
  return result;
}

export function createAdminRouter() {
  const router = Router();
  const requireBrowserOrigin = requireTrustedBrowserOrigin();

  const adminUser = process.env.ADMIN_USER?.trim();
  const adminPassword = process.env.ADMIN_PASSWORD?.trim();
  if (process.env.NODE_ENV === 'production') {
    if (!adminUser || !adminPassword) {
      console.error('❌ FATAL: ADMIN_USER e ADMIN_PASSWORD são obrigatórios no .env em produção.');
      process.exit(1);
    }
  }

  // POST /api/admin/login
  router.post('/admin/login', loginRateLimiter, requireBrowserOrigin, (req, res) => {
    const { usuario, senha } = req.body;
    if (!adminUser || !adminPassword) {
      return res.status(503).json({
        success: false,
        message: 'Login administrativo não configurado. Defina ADMIN_USER e ADMIN_PASSWORD no ambiente.',
      });
    }
    if (usuario === adminUser && senha === adminPassword) {
      const token = jwt.sign({ role: 'admin' }, ADMIN_SECRET, { expiresIn: '8h' });
      return res.json({ success: true, token });
    }
    res.status(401).json({ success: false, message: 'Credenciais inválidas' });
  });

  // Todas as rotas abaixo: sessão validada (tenant ou admin) + papel admin
  const admin = Router();
  admin.use(authenticateToken);
  admin.use(authenticateAdmin);
  registerGestaoDeliveryRoutes(admin);

  admin.get('/solicitacoes', async (_req, res) => {
    try { res.json(await qAll('SELECT * FROM solicitacoes ORDER BY created_at DESC', [])); }
    catch (e: unknown) { sendInternalError(res, 'routes/admin:solicitacoes', e); }
  });

  admin.post('/solicitacoes/:id/aprovar', async (req, res) => {
    try {
      const sol = await q1('SELECT * FROM solicitacoes WHERE id=?', [req.params.id]);
      if (!sol) return res.status(404).json({ success: false });
      const segmentoFinal = req.body?.segmento || sol.segmento || 'Restaurante/Food';
      const approvalPlan = buildApprovalPlanContext(req.body?.plano, req.body?.trial_dias);
      const senha   = Math.random().toString(36).slice(-8);
      const hash    = bcrypt.hashSync(senha, 10);

      const result = await withTx(async (client) => {
        const usuario = await buildUniqueTenantUsername(client, sol.email);
        const initialProductProduction = normalizeProductProductionInput(
          { production_type: 'kitchen' },
          { name: 'Produto Exemplo', category: 'Geral' }
        );

        const cid = await txInsert(client,
          `INSERT INTO clientes (solicitacao_id,nome_estabelecimento,razao_social,documento_tipo,documento_numero,nome_responsavel,email,whatsapp,cidade,usuario,senha,status,vencimento,segmento,plano,trial_inicio,trial_fim) VALUES (?,?,?,?,?,?,?,?,?,?,?,'ativo',?,?,?,?,?)`,
          [
            sol.id,
            sol.nome_estabelecimento,
            sol.razao_social,
            sol.documento_tipo,
            sol.documento_numero,
            sol.nome_responsavel,
            sol.email,
            sol.whatsapp,
            sol.cidade,
            usuario,
            hash,
            approvalPlan.trialWindow.vencimento,
            segmentoFinal,
            approvalPlan.storedPlan,
            approvalPlan.trialWindow.trialInicio,
            approvalPlan.trialWindow.trialFim,
          ]
        );
        await txRun(client, "UPDATE solicitacoes SET status='aprovado', segmento=? WHERE id=?", [segmentoFinal, sol.id]);
        await txRun(client,
          `INSERT INTO usuarios (username,password,cargo,nome,cliente_id,ativo,token_version) VALUES (?,?,'dono',?,?,1,1)
           ON CONFLICT(username) DO UPDATE SET password=EXCLUDED.password,cargo='dono',nome=EXCLUDED.nome,cliente_id=EXCLUDED.cliente_id,ativo=1`,
          [usuario, hash, sol.nome_responsavel, cid]
        );
        await txRun(
          client,
          "INSERT INTO produtos (public_id,name,price,category,active,requires_preparation,production_type,tenant_id) VALUES (?, 'Produto Exemplo',10.00,'Geral',1,?,?,?)",
          [
            generatePublicId('prd'),
            initialProductProduction.requiresPreparation,
            initialProductProduction.productionType,
            cid,
          ]
        );
        await writeAdminAuditEvent({
          tx: client,
          req,
          tenantId: Number(cid),
          action: ADMIN_AUDIT_ACTIONS.APROVAR_SOLICITACAO,
          legacyDetails: `Solicitacao #${sol.id} aprovada e tenant #${cid} criado.`,
          scope: {
            type: 'solicitacao',
            id: sol.id,
          },
          entity: {
            type: 'tenant',
            id: cid,
          },
          metadata: {
            solicitacao_id: sol.id,
            nome_estabelecimento: sol.nome_estabelecimento,
            usuario: usuario,
            plano: approvalPlan.storedPlan,
            trial_dias: approvalPlan.trialDays,
            segmento: segmentoFinal,
          },
          before: {
            status: sol.status ?? 'pendente',
            segmento: sol.segmento ?? null,
          },
          after: {
            status: 'aprovado',
            tenant_id: cid,
            usuario,
            plano: approvalPlan.storedPlan,
            trial_inicio: approvalPlan.trialWindow.trialInicio,
            trial_fim: approvalPlan.trialWindow.trialFim,
            segmento: segmentoFinal,
          },
        });

        return { clienteId: cid, usuario };
      });
      res.json({
        success: true,
        cliente_id: result.clienteId,
        usuario: result.usuario,
        senha,
        segmento: segmentoFinal,
        plano: approvalPlan.storedPlan,
        plan_type: approvalPlan.storedPlan,
        plan_features: approvalPlan.features,
        trial_ativo: approvalPlan.trialActive,
        trial_dias: approvalPlan.trialDays,
        trial_inicio: approvalPlan.trialWindow.trialInicio,
        trial_fim: approvalPlan.trialWindow.trialFim,
        vencimento: approvalPlan.trialWindow.vencimento,
      });
    } catch (e: unknown) {
      sendInternalError(res, 'routes/admin:aprovarSolicitacao', e, { solicitacaoId: req.params.id });
    }
  });

  admin.post('/solicitacoes/:id/recusar', async (req, res) => {
    try {
      const result = await withTx(async (client) => {
        const solicitacao = await txQ1<{ id: number; status: string | null; nome_estabelecimento: string | null }>(
          client,
          'SELECT id, status, nome_estabelecimento FROM solicitacoes WHERE id=?',
          [req.params.id]
        );
        if (!solicitacao) return null;

        await txRun(client, "UPDATE solicitacoes SET status='recusado' WHERE id=?", [req.params.id]);
        await writeAdminAuditEvent({
          tx: client,
          req,
          action: ADMIN_AUDIT_ACTIONS.RECUSAR_SOLICITACAO,
          legacyDetails: `Solicitacao #${solicitacao.id} recusada.`,
          scope: {
            type: 'solicitacao',
            id: solicitacao.id,
          },
          entity: {
            type: 'solicitacao',
            id: solicitacao.id,
          },
          metadata: {
            solicitacao_id: solicitacao.id,
            nome_estabelecimento: solicitacao.nome_estabelecimento,
          },
          before: {
            status: solicitacao.status ?? 'pendente',
          },
          after: {
            status: 'recusado',
          },
        });

        return { success: true };
      });
      if (!result) return res.status(404).json({ success: false });
      res.json({ success: true });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Nenhum caixa aberto encontrado') {
        return res.status(400).json({ success: false, error: e.message });
      }
      sendInternalError(res, 'routes/admin', e);
    }
  });

  admin.get('/clientes', async (_req, res) => {
    try {
      const now = new Date();
      const lista = await qAll('SELECT * FROM clientes ORDER BY created_at DESC', []);
      res.json(
        lista.map((c: any) => {
          const { senha_admin, senha_caixa, ...rest } = c;
          const td = c.vencimento ? new Date(c.vencimento) : c.trial_fim ? new Date(c.trial_fim) : null;
          return {
            ...rest,
            senha_admin_configurada: !!String(senha_admin ?? '').trim(),
            senha_caixa_configurada: !!String(senha_caixa ?? '').trim(),
            dias_restantes: td ? Math.ceil((td.getTime() - now.getTime()) / 86400000) : null,
          };
        })
      );
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Pedido nao encontrado') {
        return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      }
      if (e instanceof Error && e.message === 'Pedido ja cancelado') {
        return res.status(400).json({ success: false, error: 'Pedido ja cancelado' });
      }
      sendInternalError(res, 'routes/admin', e);
    }
  });

  admin.put('/clientes/:id', async (req, res) => {
    try {
      const {
        nome_estabelecimento,razao_social,documento_tipo,documento_numero,nome_responsavel,email,whatsapp,cidade,
        plano,valor_plano,vencimento,status,segmento,trial_inicio,trial_fim,usuario,
      } = req.body;
      const usuarioNormalizado = String(usuario || '').trim();
      if (!usuarioNormalizado) {
        return res.status(400).json({ success: false, error: 'Usuário é obrigatório' });
      }
      if (usuarioNormalizado.length < 3 || usuarioNormalizado.length > 60 || !/^[A-Za-z0-9._-]+$/.test(usuarioNormalizado)) {
        return res.status(400).json({ success: false, error: 'Usuário inválido (3-60, letras, números, ponto, hífen e underscore)' });
      }
      const planoFinal = normalizeAdminPlan(plano);
      await withTx(async (client) => {
        const ant = await txQ1<any>(
          client,
          `SELECT id,nome_estabelecimento,razao_social,documento_tipo,documento_numero,nome_responsavel,email,whatsapp,cidade,
                  plano,valor_plano,vencimento,status,segmento,trial_inicio,trial_fim,usuario
           FROM clientes WHERE id=?`,
          [req.params.id]
        );
        if (!ant) {
          throw new Error('Cliente nao encontrado');
        }

        const nextSnapshot = {
          nome_estabelecimento,
          razao_social,
          documento_tipo,
          documento_numero,
          nome_responsavel,
          email,
          whatsapp,
          cidade,
          plano: planoFinal,
          valor_plano,
          vencimento: vencimento || null,
          status,
          segmento: segmento || 'Restaurante/Food',
          trial_inicio: trial_inicio || null,
          trial_fim: trial_fim || null,
          usuario: usuarioNormalizado,
        };

        if (usuarioNormalizado !== String(ant.usuario || '').trim()) {
          const conflito = await txQ1<{ id: number }>(
            client,
            `SELECT id FROM clientes WHERE LOWER(usuario)=LOWER(?) AND id<>?
             UNION ALL
             SELECT id FROM usuarios WHERE LOWER(username)=LOWER(?) AND cliente_id<>?
             LIMIT 1`,
            [usuarioNormalizado, req.params.id, usuarioNormalizado, req.params.id]
          );
          if (conflito) {
            throw new Error('Usuario ja em uso');
          }
        }

        await txRun(
          client,
          `UPDATE clientes SET nome_estabelecimento=?,razao_social=?,documento_tipo=?,documento_numero=?,nome_responsavel=?,email=?,whatsapp=?,cidade=?,usuario=?,plano=?,valor_plano=?,vencimento=?,status=?,segmento=?,trial_inicio=?,trial_fim=? WHERE id=?`,
          [
            nextSnapshot.nome_estabelecimento,
            nextSnapshot.razao_social,
            nextSnapshot.documento_tipo,
            nextSnapshot.documento_numero,
            nextSnapshot.nome_responsavel,
            nextSnapshot.email,
            nextSnapshot.whatsapp,
            nextSnapshot.cidade,
            nextSnapshot.usuario,
            nextSnapshot.plano,
            nextSnapshot.valor_plano,
            nextSnapshot.vencimento,
            nextSnapshot.status,
            nextSnapshot.segmento,
            nextSnapshot.trial_inicio,
            nextSnapshot.trial_fim,
            req.params.id,
          ]
        );
        if (usuarioNormalizado !== String(ant.usuario || '').trim()) {
          await txRun(client, 'UPDATE usuarios SET username=? WHERE cliente_id=? AND LOWER(username)=LOWER(?)', [
            usuarioNormalizado,
            req.params.id,
            String(ant.usuario || '').trim(),
          ]);
        }
        if (vencimento !== ant?.vencimento || planoFinal !== ant?.plano) {
          await txRun(
            client,
            "INSERT INTO renovacoes (cliente_id,plano,valor,vencimento_anterior,novo_vencimento,origem) VALUES (?,?,?,?,?,'edicao')",
            [req.params.id, planoFinal, valor_plano, ant?.vencimento, vencimento]
          );
        }
        await writeAdminAuditEvent({
          tx: client,
          req,
          tenantId: Number(req.params.id),
          action: ADMIN_AUDIT_ACTIONS.ATUALIZAR_CLIENTE,
          legacyDetails: `Tenant #${req.params.id} atualizado pelo painel admin.`,
          entity: {
            type: 'tenant',
            id: req.params.id,
          },
          before: {
            nome_estabelecimento: ant.nome_estabelecimento,
            razao_social: ant.razao_social,
            documento_tipo: ant.documento_tipo,
            documento_numero: ant.documento_numero,
            nome_responsavel: ant.nome_responsavel,
            email: ant.email,
            whatsapp: ant.whatsapp,
            cidade: ant.cidade,
            plano: ant.plano,
            valor_plano: ant.valor_plano,
            vencimento: ant.vencimento,
            status: ant.status,
            segmento: ant.segmento,
            trial_inicio: ant.trial_inicio,
            trial_fim: ant.trial_fim,
            usuario: ant.usuario,
          },
          after: nextSnapshot,
        });
      });
      invalidateTenantPlanCache(req.params.id);
      res.json({ success: true });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Usuario ja em uso') {
        return res.status(409).json({ success: false, error: e.message });
      }
      if (e instanceof Error && e.message === 'Cliente nao encontrado') {
        return res.status(404).json({ success: false, error: e.message });
      }
      sendInternalError(res, 'routes/admin', e);
    }
  });

  admin.put('/clientes/:id/senha', async (req, res) => {
    try {
      const { nova_senha, senha_admin, senha_caixa } = req.body;
      await withTx(async (client) => {
        const before = await txQ1<{ senha_admin: string | null; senha_caixa: string | null }>(
          client,
          'SELECT senha_admin, senha_caixa FROM clientes WHERE id=?',
          [req.params.id]
        );
        if (!before) {
          throw new Error('Cliente nao encontrado');
        }

        const loginPasswordUpdated = Boolean(nova_senha?.trim());
        const adminPasswordUpdated = Boolean(senha_admin?.trim());
        const caixaPasswordUpdated = Boolean(senha_caixa?.trim());

        if (loginPasswordUpdated) {
          await txRun(client, 'UPDATE usuarios SET password=? WHERE cliente_id=?', [bcrypt.hashSync(nova_senha, 10), req.params.id]);
        }
        if (adminPasswordUpdated) {
          await txRun(client, 'UPDATE clientes SET senha_admin=? WHERE id=?', [hashPlainSecurityPassword(senha_admin), req.params.id]);
        }
        if (caixaPasswordUpdated) {
          await txRun(client, 'UPDATE clientes SET senha_caixa=? WHERE id=?', [hashPlainSecurityPassword(senha_caixa), req.params.id]);
        }

        await writeAdminAuditEvent({
          tx: client,
          req,
          tenantId: Number(req.params.id),
          action: ADMIN_AUDIT_ACTIONS.ATUALIZAR_SENHAS_CLIENTE,
          legacyDetails: `Credenciais do tenant #${req.params.id} atualizadas pelo painel admin.`,
          entity: {
            type: 'tenant',
            id: req.params.id,
          },
          metadata: {
            login_password_updated: loginPasswordUpdated,
            senha_admin_updated: adminPasswordUpdated,
            senha_caixa_updated: caixaPasswordUpdated,
          },
          before: {
            senha_admin_configurada: !!String(before.senha_admin ?? '').trim(),
            senha_caixa_configurada: !!String(before.senha_caixa ?? '').trim(),
            login_password_reset: false,
          },
          after: {
            senha_admin_configurada: adminPasswordUpdated || !!String(before.senha_admin ?? '').trim(),
            senha_caixa_configurada: caixaPasswordUpdated || !!String(before.senha_caixa ?? '').trim(),
            login_password_reset: loginPasswordUpdated,
          },
        });
      });
      res.json({ success: true });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Cliente nao encontrado') {
        return res.status(404).json({ success: false, error: e.message });
      }
      sendInternalError(res, 'routes/admin:clientesSenha', e);
    }
  });

  admin.delete('/clientes/:id', async (req, res) => {
    try {
      await withTx(async (client) => {
        const c = await txQ1<{ id: number; usuario: string | null; nome_estabelecimento: string | null; status: string | null }>(
          client,
          'SELECT id, usuario, nome_estabelecimento, status FROM clientes WHERE id=?',
          [req.params.id]
        );
        if (!c) {
          throw new Error('Cliente nao encontrado');
        }
        // Apaga os dados de TODAS as tabelas com tenant_id (exceto logs/auditoria, que ficam como histórico).
        // A ordem das chaves estrangeiras não é conhecida de antemão: cada DELETE roda num SAVEPOINT e,
        // se uma FK (23503) bloquear, tenta de novo na rodada seguinte, depois que os filhos já foram apagados.
        const tabelasTenant = await txQAll<{ table_name: string }>(
          client,
          `SELECT c.table_name FROM information_schema.columns c
             JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
            WHERE c.table_schema='public' AND c.column_name='tenant_id'
              AND c.table_name NOT IN ('admin_audit_events','system_logs','clientes')`,
          []
        );
        let pendentes = tabelasTenant.map((r) => r.table_name).filter((n) => /^[a-z0-9_]+$/.test(n));
        for (let rodada = 0; rodada < 8 && pendentes.length > 0; rodada++) {
          const aindaBloqueadas: string[] = [];
          let ultimoErro: unknown = null;
          for (const t of pendentes) {
            await client.query('SAVEPOINT del_tenant');
            try {
              await txRun(client, `DELETE FROM "${t}" WHERE tenant_id=?`, [req.params.id]);
              await client.query('RELEASE SAVEPOINT del_tenant');
            } catch (err: any) {
              await client.query('ROLLBACK TO SAVEPOINT del_tenant');
              if (err?.code !== '23503') throw err;
              ultimoErro = err;
              aindaBloqueadas.push(t);
            }
          }
          if (aindaBloqueadas.length === pendentes.length) throw ultimoErro; // sem progresso: erro real
          pendentes = aindaBloqueadas;
        }
        if (pendentes.length > 0) throw new Error('Nao foi possivel remover todos os dados do cliente: ' + pendentes.join(', '));
        await txRun(client, 'DELETE FROM renovacoes WHERE cliente_id=?', [req.params.id]);
        // Gestão Delivery: o restaurante continua cadastrado, só perde o vínculo com o cliente do software.
        await txRun(client, 'UPDATE gd_estabelecimentos SET cliente_id=NULL WHERE cliente_id=?', [req.params.id]);
        if (c.usuario) await txRun(client, 'DELETE FROM usuarios WHERE username=?', [c.usuario]);
        await writeAdminAuditEvent({
          tx: client,
          req,
          tenantId: Number(req.params.id),
          action: ADMIN_AUDIT_ACTIONS.REMOVER_CLIENTE,
          legacyDetails: `Tenant #${req.params.id} removido pelo painel admin.`,
          entity: {
            type: 'tenant',
            id: req.params.id,
          },
          before: {
            usuario: c.usuario,
            nome_estabelecimento: c.nome_estabelecimento,
            status: c.status,
          },
          after: {
            deleted: true,
          },
        });
        await txRun(client, 'DELETE FROM clientes WHERE id=?', [req.params.id]);
      });
      invalidateTenantPlanCache(req.params.id);
      res.json({ success: true });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Cliente nao encontrado') {
        return res.status(404).json({ success: false, error: e.message });
      }
      sendInternalError(res, 'routes/admin', e);
    }
  });

  admin.post('/clientes/:id/disconnect', async (req, res) => {
    try {
      await withTx(async (client) => {
        const c = await txQ1<{ usuario: string | null }>(client, 'SELECT usuario FROM clientes WHERE id=?', [req.params.id]);
        if (!c) {
          throw new Error('Cliente nao encontrado');
        }
        if (c.usuario) {
          await txRun(client, 'UPDATE usuarios SET token_version=token_version+1 WHERE username=?', [c.usuario]);
        }
        await writeAdminAuditEvent({
          tx: client,
          req,
          tenantId: Number(req.params.id),
          action: ADMIN_AUDIT_ACTIONS.DESCONECTAR_CLIENTE,
          legacyDetails: `Sessoes do tenant #${req.params.id} invalidadas manualmente.`,
          entity: {
            type: 'tenant',
            id: req.params.id,
          },
          metadata: {
            usuario: c.usuario,
          },
          after: {
            sessions_invalidated: true,
          },
        });
      });
      res.json({ success: true });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Cliente nao encontrado') {
        return res.status(404).json({ error: 'Cliente nao encontrado' });
      }
      sendInternalError(res, 'routes/admin', e);
    }
  });

  admin.post('/clientes/:id/bloquear', async (req, res) => {
    try {
      await withTx(async (client) => {
        const c = await txQ1<{ usuario: string | null; status: string | null }>(
          client,
          'SELECT usuario, status FROM clientes WHERE id=?',
          [req.params.id]
        );
        if (!c) {
          throw new Error('Cliente nao encontrado');
        }
        await txRun(client, "UPDATE clientes SET status='bloqueado' WHERE id=?", [req.params.id]);
        if (c.usuario) {
          await txRun(client, 'UPDATE usuarios SET ativo=0 WHERE username=?', [c.usuario]);
        }
        await writeAdminAuditEvent({
          tx: client,
          req,
          tenantId: Number(req.params.id),
          action: ADMIN_AUDIT_ACTIONS.BLOQUEAR_CLIENTE,
          legacyDetails: `Tenant #${req.params.id} bloqueado pelo painel admin.`,
          entity: {
            type: 'tenant',
            id: req.params.id,
          },
          metadata: {
            usuario: c.usuario,
          },
          before: {
            status: c.status,
          },
          after: {
            status: 'bloqueado',
          },
        });
      });
      res.json({ success: true });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Cliente nao encontrado') {
        return res.status(404).json({ error: 'Cliente nao encontrado' });
      }
      sendInternalError(res, 'routes/admin', e);
    }
  });

  admin.post('/clientes/:id/desbloquear', async (req, res) => {
    try {
      const { dias_extras } = req.body;
      const d = new Date();
      d.setDate(d.getDate() + (dias_extras || 7));
      await withTx(async (client) => {
        const c = await txQ1<{ usuario: string | null; status: string | null; vencimento: string | null }>(
          client,
          'SELECT usuario, status, vencimento FROM clientes WHERE id=?',
          [req.params.id]
        );
        if (!c) {
          throw new Error('Cliente nao encontrado');
        }
        await txRun(client, "UPDATE clientes SET status='ativo', vencimento=? WHERE id=?", [d.toISOString(), req.params.id]);
        if (c.usuario) {
          await txRun(client, 'UPDATE usuarios SET ativo=1 WHERE username=?', [c.usuario]);
        }
        await writeAdminAuditEvent({
          tx: client,
          req,
          tenantId: Number(req.params.id),
          action: ADMIN_AUDIT_ACTIONS.DESBLOQUEAR_CLIENTE,
          legacyDetails: `Tenant #${req.params.id} desbloqueado e reativado ate ${d.toISOString()}.`,
          entity: {
            type: 'tenant',
            id: req.params.id,
          },
          metadata: {
            usuario: c.usuario,
            dias_extras: dias_extras || 7,
          },
          before: {
            status: c.status,
            vencimento: c.vencimento,
          },
          after: {
            status: 'ativo',
            vencimento: d.toISOString(),
          },
        });
      });
      invalidateTenantPlanCache(req.params.id);
      res.json({ success: true });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Cliente nao encontrado') {
        return res.status(404).json({ error: 'Cliente nao encontrado' });
      }
      sendInternalError(res, 'routes/admin', e);
    }
  });

  admin.post('/clientes/:id/estender', async (req, res) => {
    try {
      const { dias } = req.body;
      const extensionDays = dias || 7;
      const newDueAt = await withTx(async (client) => {
        const c = await txQ1<{ vencimento: string | null; status: string | null }>(
          client,
          'SELECT vencimento, status FROM clientes WHERE id=?',
          [req.params.id]
        );
        if (!c) {
          throw new Error('Cliente nao encontrado');
        }
        const base = c.vencimento && new Date(c.vencimento) > new Date() ? new Date(c.vencimento) : new Date();
        base.setDate(base.getDate() + extensionDays);
        await txRun(client, "UPDATE clientes SET vencimento=?,status='ativo' WHERE id=?", [base.toISOString(), req.params.id]);
        await writeAdminAuditEvent({
          tx: client,
          req,
          tenantId: Number(req.params.id),
          action: ADMIN_AUDIT_ACTIONS.ESTENDER_CLIENTE,
          legacyDetails: `Tenant #${req.params.id} estendido em ${extensionDays} dia(s).`,
          entity: {
            type: 'tenant',
            id: req.params.id,
          },
          metadata: {
            dias: extensionDays,
          },
          before: {
            status: c.status,
            vencimento: c.vencimento,
          },
          after: {
            status: 'ativo',
            vencimento: base.toISOString(),
          },
        });
        return base.toISOString();
      });
      invalidateTenantPlanCache(req.params.id);
      res.json({ success: true, novo_vencimento: newDueAt });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Cliente nao encontrado') {
        return res.status(404).json({ success: false });
      }
      sendInternalError(res, 'routes/admin', e);
    }
  });

  admin.get('/financeiro', async (_req, res) => {
    try {
      const TZ = 'America/Sao_Paulo';
      const [mrr, ativos, proxVenc, fatMensal, pagantes] = await Promise.all([
        q1("SELECT SUM(valor_plano) as total FROM clientes WHERE status='ativo' AND (trial_fim IS NULL OR trial_fim < NOW())", []),
        q1("SELECT COUNT(*) as total FROM clientes WHERE status='ativo' AND (trial_fim IS NULL OR trial_fim < NOW())", []),
        qAll(`SELECT nome_estabelecimento,plano,valor_plano,vencimento,whatsapp,
               EXTRACT(DAY FROM (vencimento - NOW())) as dias
               FROM clientes WHERE status='ativo' AND vencimento IS NOT NULL
               AND vencimento <= NOW() + INTERVAL '7 days' ORDER BY vencimento ASC`, []),
        qAll(`SELECT TO_CHAR(data_pagamento AT TIME ZONE '${TZ}', 'MM/YYYY') as mes, SUM(valor) as total
              FROM renovacoes WHERE origem IS DISTINCT FROM 'edicao' GROUP BY mes ORDER BY MIN(data_pagamento) DESC LIMIT 6`, []),
        qAll("SELECT nome_estabelecimento,plano,valor_plano,vencimento,ultimo_acesso FROM clientes WHERE (trial_fim IS NULL OR trial_fim < NOW()) ORDER BY vencimento ASC", []),
      ]);
      res.json({
        mrr: mrr?.total||0, arr: (mrr?.total||0)*12,
        clientes_pagantes: ativos?.total||0,
        ticket_medio: ativos?.total ? (mrr?.total/ativos?.total) : 0,
        proximos_vencimentos: proxVenc, faturamento_mensal: fatMensal, todos_pagantes: pagantes,
      });
    } catch (e: unknown) { sendInternalError(res, 'routes/admin', e); }
  });

  admin.get('/dashboard', async (_req, res) => {
    try {
      const [total, ativos, bloqueados, pendentes, expirados] = await Promise.all([
        q1('SELECT COUNT(*) as c FROM clientes', []),
        q1("SELECT COUNT(*) as c FROM clientes WHERE status='ativo'", []),
        q1("SELECT COUNT(*) as c FROM clientes WHERE status='bloqueado'", []),
        q1("SELECT COUNT(*) as c FROM solicitacoes WHERE status='pendente'", []),
        q1("SELECT COUNT(*) as c FROM clientes WHERE status='ativo' AND vencimento IS NOT NULL AND vencimento<NOW()", []),
      ]);
      res.json({
        total: sqlCount(total),
        ativos: sqlCount(ativos),
        bloqueados: sqlCount(bloqueados),
        pendentes: sqlCount(pendentes),
        expirados: sqlCount(expirados),
      });
    } catch (e: unknown) {
      sendInternalError(res, 'admin.dashboard', e, {
        route: '/api/admin/dashboard',
        code: (e as { code?: unknown })?.code,
        detail: (e as { detail?: unknown })?.detail,
      });
    }
  });

  admin.get('/clientes/:id/usuarios', async (req, res) => {
    try {
      const u = await qAll('SELECT id,username,nome,cargo,permissoes,ativo FROM usuarios WHERE cliente_id=? ORDER BY nome ASC', [req.params.id]);
      res.json(u.map((x: any) => ({ ...x, permissoes: x.permissoes ? JSON.parse(x.permissoes) : null })));
    } catch (e: unknown) { sendInternalError(res, 'routes/admin', e); }
  });

  admin.put('/clientes/:id/usuarios/:uid/senha', async (req, res) => {
    try {
      const { senha } = req.body;
      if (!senha) return res.status(400).json({ error: 'Senha obrigatória' });
      await withTx(async (client) => {
        const user = await txQ1<{ id: number; username: string | null; nome: string | null }>(
          client,
          'SELECT id, username, nome FROM usuarios WHERE id=? AND cliente_id=?',
          [req.params.uid, req.params.id]
        );
        if (!user) {
          throw new Error('Usuario nao encontrado');
        }
        await txRun(client, 'UPDATE usuarios SET password=? WHERE id=? AND cliente_id=?', [await bcrypt.hash(senha,10), req.params.uid, req.params.id]);
        await writeAdminAuditEvent({
          tx: client,
          req,
          tenantId: Number(req.params.id),
          action: ADMIN_AUDIT_ACTIONS.ATUALIZAR_SENHA_USUARIO_CLIENTE,
          legacyDetails: `Senha do usuario #${req.params.uid} do tenant #${req.params.id} redefinida.`,
          entity: {
            type: 'usuario',
            id: req.params.uid,
          },
          metadata: {
            username: user.username,
            nome: user.nome,
          },
          after: {
            password_reset: true,
          },
        });
      });
      res.json({ success: true });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Usuario nao encontrado') {
        return res.status(404).json({ error: 'Usuario nao encontrado' });
      }
      sendInternalError(res, 'routes/admin', e);
    }
  });

  admin.patch('/clientes/:id/usuarios/:uid/toggle', async (req, res) => {
    try {
      const ativo = await withTx(async (client) => {
        const u = await txQ1<{ ativo: number | boolean | null; username: string | null; nome: string | null }>(
          client,
          'SELECT ativo, username, nome FROM usuarios WHERE id=? AND cliente_id=?',
          [req.params.uid, req.params.id]
        );
        if (!u) {
          throw new Error('Usuario nao encontrado');
        }
        const nextActive = u.ativo ? 0 : 1;
        await txRun(client, 'UPDATE usuarios SET ativo=? WHERE id=? AND cliente_id=?', [nextActive, req.params.uid, req.params.id]);
        await writeAdminAuditEvent({
          tx: client,
          req,
          tenantId: Number(req.params.id),
          action: ADMIN_AUDIT_ACTIONS.ALTERNAR_STATUS_USUARIO_CLIENTE,
          legacyDetails: `Status do usuario #${req.params.uid} do tenant #${req.params.id} alterado para ${nextActive ? 'ativo' : 'inativo'}.`,
          entity: {
            type: 'usuario',
            id: req.params.uid,
          },
          metadata: {
            username: u.username,
            nome: u.nome,
          },
          before: {
            ativo: Boolean(u.ativo),
          },
          after: {
            ativo: Boolean(nextActive),
          },
        });
        return Boolean(nextActive);
      });
      res.json({ success: true, ativo });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Usuario nao encontrado') {
        return res.status(404).json({ error: 'Usuario nao encontrado' });
      }
      sendInternalError(res, 'routes/admin', e);
    }
  });

  // ─── Motor de ações administrativas críticas ─────────────────────────────
  type ActionContext = { req: Request; tenantId: number; payload?: Record<string, unknown>; reason: string };
  type ActionHandler = (ctx: ActionContext) => Promise<Record<string, unknown>>;

  type AdminActionLogOptions = {
    tx?: Parameters<typeof txRun>[0];
    legacyAction?: string;
    reason?: string | null;
    entityType?: string | null;
    entityId?: string | number | bigint | null;
    metadata?: Record<string, unknown>;
    before?: unknown;
    after?: unknown;
  };

  async function logAdminAction(
    req: Request,
    tenantId: number,
    action: string,
    detalhes: string,
    options: AdminActionLogOptions = {}
  ) {
    await writeAdminAuditEvent({
      tx: options.tx,
      req,
      tenantId,
      action,
      legacyAction: options.legacyAction,
      legacyDetails: detalhes,
      reason: options.reason,
      entity: {
        type: options.entityType,
        id: options.entityId,
      },
      metadata: options.metadata,
      before: options.before,
      after: options.after,
    });
  }

  async function resetCaixaState(req: Request, tenantId: number, reason: string) {
    const caixasAbertos = await qAll<{ id: number; data: string; observacao?: string | null }>(
      "SELECT id, data, observacao FROM caixa WHERE status='aberto' AND tenant_id=? ORDER BY data ASC",
      [tenantId]
    );

    if (caixasAbertos.length === 0) {
      await logAdminAction(
        req,
        tenantId,
        ADMIN_AUDIT_ACTIONS.RESET_CAIXA,
        `Reset de caixa solicitado sem caixas abertos. Motivo: ${reason}`,
        {
          reason,
          entityType: 'caixa',
          metadata: {
            caixas_ids: [],
            reset_count: 0,
            status: 'fechado',
          },
        }
      );

      return {
        reset_count: 0,
        caixas_ids: [],
        status: 'fechado',
      };
    }

    await withTx(async (client) => {
      for (const caixa of caixasAbertos) {
        const observacoes = [caixa.observacao || '', `[Reset admin: ${reason}]`].filter(Boolean);
        await txRun(
          client,
          "UPDATE caixa SET status='fechado', closed_at=COALESCE(closed_at, NOW()), valor_contado=COALESCE(valor_contado,0), observacao=? WHERE id=? AND tenant_id=?",
          [observacoes.join(' '), caixa.id, tenantId]
        );
      }
      await logAdminAction(
        req,
        tenantId,
        ADMIN_AUDIT_ACTIONS.RESET_CAIXA,
        `Reset de caixa concluiu ${caixasAbertos.length} fechamento(s) administrativo(s): ${caixasAbertos.map((caixa) => `#${caixa.id} (${caixa.data})`).join(', ')}. Motivo: ${reason}`,
        {
          tx: client,
          reason,
          entityType: 'caixa',
          metadata: {
            caixas_ids: caixasAbertos.map((caixa) => caixa.id),
            reset_count: caixasAbertos.length,
            status: 'fechado',
          },
        }
      );
    });

    return {
      reset_count: caixasAbertos.length,
      caixas_ids: caixasAbertos.map((caixa) => caixa.id),
      status: 'fechado',
    };
  }

  const actionHandlers: Record<string, ActionHandler> = {
    async login_as_cliente({ req, tenantId, reason }) {
      const cliente = await q1<{ id: number; usuario: string; nome_estabelecimento: string; status: string }>(
        'SELECT id, usuario, nome_estabelecimento, status FROM clientes WHERE id=?',
        [tenantId]
      );
      if (!cliente) throw new Error('Cliente não encontrado');
      if (cliente.status !== 'ativo') throw new Error('Cliente bloqueado ou inativo');

      const user = await q1<{ id: number; username: string; token_version: number }>(
        'SELECT id, username, token_version FROM usuarios WHERE username=? LIMIT 1',
        [cliente.usuario]
      );
      if (!user) throw new Error('Usuário do cliente não encontrado');

      const token = jwt.sign(
        { id: user.id, username: user.username, token_version: user.token_version || 1 },
        JWT_SECRET,
        { expiresIn: '2h' }
      );

      await logAdminAction(
        req,
        tenantId,
        ADMIN_AUDIT_ACTIONS.LOGIN_AS_CLIENTE,
        `Admin logou como cliente "${cliente.nome_estabelecimento}" (usuario=${cliente.usuario}). Motivo: ${reason}`,
        {
          reason,
          entityType: 'tenant',
          entityId: tenantId,
          metadata: {
            nome_estabelecimento: cliente.nome_estabelecimento,
            usuario: cliente.usuario,
          },
        }
      );

      return { token, usuario: cliente.usuario, nome_estabelecimento: cliente.nome_estabelecimento };
    },

    async open_caixa({ req, tenantId, payload, reason }) {
      const dateStr = getTodayDateInTimeZone();
      const ex = await q1("SELECT * FROM caixa WHERE data=? AND status='aberto' AND tenant_id=?", [dateStr, tenantId]);
      if (ex) throw new Error('Já existe um caixa aberto hoje.');

      const fundoInicial = Number(payload?.fundo_inicial ?? 0);
      const observacao = String(payload?.observacao ?? '').trim();

      const caixaId = await qInsert(
        "INSERT INTO caixa (data,fundo_inicial,observacao,status,tenant_id) VALUES (?,?,?,'aberto',?)",
        [dateStr, fundoInicial, observacao || null, tenantId]
      );

      await logAdminAction(
        req,
        tenantId,
        ADMIN_AUDIT_ACTIONS.OPEN_CAIXA,
        `Caixa aberto para ${dateStr}. Fundo: R$ ${fundoInicial.toFixed(2)}. Motivo: ${reason}`,
        {
          reason,
          entityType: 'caixa',
          entityId: caixaId,
          metadata: {
            data: dateStr,
            fundo_inicial: fundoInicial,
            observacao,
          },
          after: {
            data: dateStr,
            fundo_inicial: fundoInicial,
            observacao: observacao || null,
            status: 'aberto',
          },
        }
      );

      return { data: dateStr, fundo_inicial: fundoInicial };
    },

    async force_close_caixa({ req, tenantId, payload, reason }) {
      const caixaId = payload?.caixa_id ? Number(payload.caixa_id) : undefined;
      const valorContado = payload?.valor_contado != null ? Number(payload.valor_contado) : 0;
      const observacaoPayload = String(payload?.observacao ?? '').trim();

      let caixa: { id: number; data: string; observacao?: string | null } | null;
      if (caixaId) {
        caixa = await q1('SELECT id, data, observacao FROM caixa WHERE id=? AND tenant_id=? AND status=?', [caixaId, tenantId, 'aberto']);
      } else {
        caixa = await q1("SELECT id, data, observacao FROM caixa WHERE status='aberto' AND tenant_id=? ORDER BY data ASC LIMIT 1", [tenantId]);
      }
      if (!caixa) throw new Error('Nenhum caixa aberto encontrado');

      const parts: string[] = [caixa.observacao || '', observacaoPayload, `[Admin: ${reason}]`].filter(Boolean);
      const observacaoFinal = parts.join(' ');

      await qRun(
        "UPDATE caixa SET status='fechado', closed_at=NOW(), valor_contado=?, observacao=? WHERE id=? AND tenant_id=?",
        [valorContado, observacaoFinal, caixa.id, tenantId]
      );

      await logAdminAction(
        req,
        tenantId,
        ADMIN_AUDIT_ACTIONS.FORCE_CLOSE_CAIXA,
        `Caixa #${caixa.id} (${caixa.data}) fechado. Valor contado: R$ ${valorContado.toFixed(2)}. Motivo: ${reason}`,
        {
          reason,
          entityType: 'caixa',
          entityId: caixa.id,
          metadata: {
            data: caixa.data,
            valor_contado: valorContado,
          },
          before: {
            data: caixa.data,
            observacao: caixa.observacao ?? null,
            status: 'aberto',
          },
          after: {
            data: caixa.data,
            observacao: observacaoFinal,
            status: 'fechado',
            valor_contado: valorContado,
          },
        }
      );

      return { caixa_id: caixa.id, data: caixa.data, valor_contado: valorContado };
    },

    async reset_caixa({ req, tenantId, reason }) {
      return resetCaixaState(req, tenantId, reason);
    },

    async reset_caixa_state({ req, tenantId, reason }) {
      return resetCaixaState(req, tenantId, reason);
    },

    async force_cancel_order({ req, tenantId, payload, reason }) {
      const orderId = Number(payload?.order_id);
      if (!orderId) throw new Error('order_id obrigatório no payload');

      const pedido = await q1<{ id: number; order_number: string; status: string; cancelado_at: string | null }>(
        'SELECT id, order_number, status, cancelado_at FROM pedidos WHERE id=? AND tenant_id=?',
        [orderId, tenantId]
      );
      if (!pedido) throw new Error('Pedido não encontrado');
      if (pedido.cancelado_at) throw new Error('Pedido já cancelado');

      await qRun(
        `UPDATE pedidos SET status='Cancelado', cancelado_at=NOW(), cancelamento_motivo=?, cancelado_por=NULL WHERE id=? AND tenant_id=?`,
        [reason, orderId, tenantId]
      );
      await orderCancelledWhatsAppEvent({
        tenantId,
        orderId,
        source: 'routes.admin.forceCancelOrder',
      });
      notifyTenantOrderStreams(tenantId, 'status', { orderId });

      await logAdminAction(
        req,
        tenantId,
        ADMIN_AUDIT_ACTIONS.FORCE_CANCEL_ORDER,
        `Pedido #${pedido.order_number || orderId} cancelado. Motivo: ${reason}`,
        {
          reason,
          entityType: 'pedido',
          entityId: orderId,
          metadata: {
            order_number: pedido.order_number,
          },
          before: {
            cancelado_at: pedido.cancelado_at,
            status: pedido.status,
          },
          after: {
            cancelado_at: '[server_now]',
            status: 'Cancelado',
          },
        }
      );

      return { order_id: orderId, order_number: pedido.order_number };
    },

    async ver_logs_sistema({ req, tenantId, payload, reason }) {
      const limite = Math.min(Math.max(1, Number(payload?.limite) || 200), 500);

      const logs = await qAll<{
        id: number;
        tenant_id: number;
        usuario_nome: string;
        cargo: string;
        acao: string;
        detalhes: string | null;
        created_at: string;
      }>(
        'SELECT id, tenant_id, usuario_nome, cargo, acao, detalhes, created_at FROM system_logs WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?',
        [tenantId, limite]
      );

      await logAdminAction(req, tenantId, ADMIN_AUDIT_ACTIONS.VER_LOGS_SISTEMA, `Admin consultou ${logs.length} logs. Motivo: ${reason}`, {
        reason,
        entityType: 'system_logs',
        metadata: {
          limite,
          total_retornado: logs.length,
        },
      });

      return { logs: logs.map((l) => ({ ...l, created_at: l.created_at })) };
    },

    async clear_sessions({ req, tenantId, reason }) {
      const updatedRows = await withTx(async (client) => {
        const rows = await txRun<{ id: number }>(
          client,
          'UPDATE usuarios SET token_version=COALESCE(token_version,1)+1 WHERE cliente_id=? RETURNING id',
          [tenantId]
        );
        await writeAdminAuditEvent({
          tx: client,
          req,
          tenantId,
          action: ADMIN_AUDIT_ACTIONS.CLEAR_SESSIONS,
          legacyDetails: `Sessoes invalidadas (${rows.length} usuario(s)).`,
          entity: {
            type: 'usuario',
          },
          metadata: {
            users_affected: rows.length,
          },
        });
        return rows;
      });
      const count = updatedRows.length;
      return { users_affected: count };
      /*

        `Sessões invalidadas para todos os usuários do tenant (${count} afetados). Motivo: ${reason}`,
    },

      */
    },

    async force_pix_check({ req, tenantId, payload, reason }) {
      const orderId = Number(payload?.order_id);
      if (!orderId) throw new Error('order_id obrigatório no payload');

      const pedido = await q1<{ id: number; order_number: string; pagamento_tipo: string; pagamento_status: string }>(
        'SELECT id, order_number, pagamento_tipo, pagamento_status FROM pedidos WHERE id=? AND tenant_id=?',
        [orderId, tenantId]
      );
      if (!pedido) throw new Error('Pedido não encontrado');
      if (pedido.pagamento_tipo !== 'pix') throw new Error('Pedido não é pagamento PIX');
      if (pedido.pagamento_status === 'pago') throw new Error('Pedido já está pago');

      const result = await revalidatePixPaymentByOrder({ orderId, tenantId });
      if (!['approved', 'paid'].includes(String(result.externalStatus || '').trim().toLowerCase())) {
        throw new Error(
          `Pagamento externo ainda nao consta como pago${result.externalStatus ? ` (${result.externalStatus})` : ''}`
        );
      }

      await logAdminAction(
        req,
        tenantId,
        ADMIN_AUDIT_ACTIONS.FORCE_PIX_CHECK,
        `Pedido #${pedido.order_number || orderId} PIX revalidado manualmente. Externo: ${result.externalStatus || 'desconhecido'}. Motivo: ${reason}`,
        {
          reason,
          entityType: 'pedido',
          entityId: orderId,
          metadata: {
            external_status: result.externalStatus,
            order_number: pedido.order_number,
            order_updated: result.orderUpdated,
            payment_updated: result.paymentUpdated,
          },
        }
      );

      return {
        order_id: orderId,
        order_number: pedido.order_number,
        payment_updated: result.paymentUpdated,
        order_updated: result.orderUpdated,
        external_status: result.externalStatus,
      };
    },

    async recalculate_stock({ req, tenantId, reason }) {
      const cliente = await q1<{ id: number }>('SELECT id FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) throw new Error('Cliente não encontrado');

      const rows = await qAll<{ id: number; total_entrada: number; total_saida: number }>(
        `SELECT i.id,
          COALESCE((SELECT SUM(quantidade) FROM estoque_movimentacoes WHERE ingrediente_id=i.id AND tipo='entrada' AND tenant_id=i.tenant_id),0)::numeric as total_entrada,
          COALESCE((SELECT SUM(quantidade) FROM estoque_movimentacoes WHERE ingrediente_id=i.id AND tipo='saida' AND tenant_id=i.tenant_id),0)::numeric as total_saida
         FROM ingredientes i WHERE i.tenant_id=?`,
        [tenantId]
      );

      let updated = 0;
      for (const r of rows) {
        const novoEstoque = Math.max(0, Number(r.total_entrada || 0) - Number(r.total_saida || 0));
        await qRun('UPDATE ingredientes SET estoque_atual=? WHERE id=? AND tenant_id=?', [novoEstoque, r.id, tenantId]);
        updated++;
      }

      await logAdminAction(
        req,
        tenantId,
        ADMIN_AUDIT_ACTIONS.RECALCULATE_STOCK,
        `${updated} ingrediente(s) reprocessados pelo histórico de movimentações (entradas - saídas). Motivo: ${reason}`,
        {
          reason,
          entityType: 'ingrediente',
          metadata: {
            ingredientes_atualizados: updated,
          },
        }
      );

      return { ingredientes_atualizados: updated };
    },

    async delivery_enable({ req, tenantId, reason }) {
      const cliente = await q1<{ id: number }>('SELECT id FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) throw new Error('Cliente não encontrado');
      await qRun('UPDATE clientes SET delivery_ativo=1 WHERE id=?', [tenantId]);
      await logAdminAction(req, tenantId, ADMIN_AUDIT_ACTIONS.DELIVERY_ENABLE, `Delivery ativado para o tenant. Motivo: ${reason}`, {
        reason,
        entityType: 'tenant',
        entityId: tenantId,
      });
      return { ativo: true };
    },

    async delivery_disable({ req, tenantId, reason }) {
      const cliente = await q1<{ id: number }>('SELECT id FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) throw new Error('Cliente não encontrado');
      await qRun('UPDATE clientes SET delivery_ativo=0 WHERE id=?', [tenantId]);
      await logAdminAction(req, tenantId, ADMIN_AUDIT_ACTIONS.DELIVERY_DISABLE, `Delivery desativado para o tenant. Motivo: ${reason}`, {
        reason,
        entityType: 'tenant',
        entityId: tenantId,
      });
      return { ativo: false };
    },
  };

  admin.post('/actions', async (req: Request, res) => {
    try {
      const { action, tenant_id, payload, reason } = req.body;
      const tenantId = Number(tenant_id);
      const reasonStr = String(reason || '').trim();

      if (!action || typeof action !== 'string') {
        return res.status(400).json({ success: false, error: 'action obrigatório' });
      }
      if (!tenantId) {
        return res.status(400).json({ success: false, error: 'tenant_id obrigatório' });
      }
      if (reasonStr.length < 10) {
        return res.status(400).json({ success: false, error: 'reason obrigatório (mínimo 10 caracteres)' });
      }

      const cliente = await q1('SELECT id FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) {
        return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
      }

      const handler = actionHandlers[action];
      if (!handler) {
        return res.status(400).json({ success: false, error: `Ação não reconhecida: ${action}` });
      }

      const result = await handler({
        req,
        tenantId,
        payload: payload && typeof payload === 'object' ? payload : undefined,
        reason: reasonStr,
      });

      res.json({ success: true, ...result });
    } catch (e: any) {
      logError('admin.actions', e, {
        route: '/api/admin/actions',
        action: req.body?.action,
        tenantId: req.body?.tenant_id,
        code: e?.code,
        detail: e?.detail,
      });
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // ─── Diagnósticos e ações administrativas ─────────────────────────────────
  admin.get('/diagnostics', async (req: Request, res) => {
    try {
      const tenantId = req.query.tenant_id ? Number(req.query.tenant_id) : undefined;
      const tenants = await runDiagnostics(tenantId);
      res.json({ tenants });
    } catch (e: unknown) { sendInternalError(res, 'routes/admin', e); }
  });

  admin.post('/caixa/force-close', async (req, res) => {
    try {
      const { tenant_id, caixa_id } = req.body;
      const tenantId = Number(tenant_id);
      if (!tenantId) return res.status(400).json({ success: false, error: 'tenant_id obrigatório' });

      const closedCaixaId = await withTx(async (client) => {
        let caixa: { id: number; data: string } | null;
        if (caixa_id) {
          caixa = await txQ1(client, 'SELECT id, data FROM caixa WHERE id=? AND tenant_id=? AND status=?', [caixa_id, tenantId, 'aberto']);
        } else {
          caixa = await txQ1(client, "SELECT id, data FROM caixa WHERE status='aberto' AND tenant_id=? ORDER BY data ASC LIMIT 1", [tenantId]);
        }
        if (!caixa) {
          throw new Error('Nenhum caixa aberto encontrado');
        }

        await txRun(
          client,
          "UPDATE caixa SET status='fechado', closed_at=NOW(), valor_contado=COALESCE(valor_contado,0), observacao=COALESCE(observacao,'') || ' [Fechamento admin]' WHERE id=? AND tenant_id=?",
          [caixa.id, tenantId]
        );
        await writeAdminAuditEvent({
          tx: client,
          req,
          tenantId,
          action: ADMIN_AUDIT_ACTIONS.FORCE_CLOSE_CAIXA,
          legacyDetails: `Caixa #${caixa.id} (data ${caixa.data}) fechado pelo painel admin`,
          entity: {
            type: 'caixa',
            id: caixa.id,
          },
          before: {
            data: caixa.data,
            status: 'aberto',
          },
          after: {
            data: caixa.data,
            status: 'fechado',
          },
        });
        return caixa.id;
      });
      res.json({ success: true, caixa_id: closedCaixaId });
    } catch (e: unknown) { sendInternalError(res, 'routes/admin', e); }
  });

  admin.post('/caixa/reset', async (req, res) => {
    try {
      const tenantId = Number(req.body?.tenant_id);
      const reason = String(req.body?.reason || '').trim();

      if (!tenantId) return res.status(400).json({ success: false, error: 'tenant_id obrigatorio' });
      if (reason.length < 10) {
        return res.status(400).json({ success: false, error: 'reason obrigatorio (minimo 10 caracteres)' });
      }

      const cliente = await q1('SELECT id FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) return res.status(404).json({ success: false, error: 'Cliente nao encontrado' });

      const result = await resetCaixaState(req, tenantId, reason);
      res.json({ success: true, ...result });
    } catch (e: unknown) {
      sendInternalError(res, 'admin.caixa.reset', e, {
        route: '/api/admin/caixa/reset',
        tenantId: req.body?.tenant_id,
        code: (e as { code?: unknown })?.code,
        detail: (e as { detail?: unknown })?.detail,
      });
    }
  });

  admin.post('/pedidos/fix-status', async (req, res) => {
    try {
      const { tenant_id, order_id, new_status } = req.body;
      const tenantId = Number(tenant_id);
      const orderId = Number(order_id);
      const status = String(new_status || 'Concluído').trim();
      const allowed = ['Concluído', 'Entregue', 'Cancelado', 'cancelado'];
      if (!tenantId || !orderId) return res.status(400).json({ success: false, error: 'tenant_id e order_id obrigatórios' });
      if (!allowed.includes(status)) return res.status(400).json({ success: false, error: 'new_status deve ser Concluído, Entregue ou Cancelado' });

      const txPedido = await withTx(async (client) => {
        const current = await txQ1<{ id: number; order_number: string; status: string; cancelado_at: string | null }>(
          client,
          'SELECT id, order_number, status, cancelado_at FROM pedidos WHERE id=? AND tenant_id=?',
          [orderId, tenantId]
        );
        if (!current) {
          throw new Error('Pedido nao encontrado');
        }
        if (current.cancelado_at) {
          throw new Error('Pedido ja cancelado');
        }

        await txRun(client, 'UPDATE pedidos SET status=? WHERE id=? AND tenant_id=?', [status, orderId, tenantId]);
        await writeAdminAuditEvent({
          tx: client,
          req,
          tenantId,
          action: ADMIN_AUDIT_ACTIONS.FIX_PEDIDO_STATUS,
          legacyDetails: `Pedido #${current.order_number || orderId} alterado de "${current.status}" para "${status}"`,
          entity: {
            type: 'pedido',
            id: orderId,
          },
          metadata: {
            order_number: current.order_number,
          },
          before: {
            status: current.status,
          },
          after: {
            status,
          },
        });
        return current;
      });
      await emitWhatsAppOrderStatusEvent({
        tenantId,
        orderId,
        status,
        source: 'routes.admin.fixOrderStatus',
      });
      notifyTenantOrderStreams(tenantId, 'status', { orderId });
      return res.json({ success: true, order_id: orderId, new_status: status, previous_status: txPedido.status });

      const pedido = await q1<{ id: number; order_number: string; status: string; cancelado_at: string | null }>('SELECT id, order_number, status, cancelado_at FROM pedidos WHERE id=? AND tenant_id=?', [orderId, tenantId]);
      if (!pedido) return res.status(404).json({ success: false, error: 'Pedido não encontrado' });
      if (pedido.cancelado_at) return res.status(400).json({ success: false, error: 'Pedido já cancelado' });

      await qRun('UPDATE pedidos SET status=? WHERE id=? AND tenant_id=?', [status, orderId, tenantId]);
      await emitWhatsAppOrderStatusEvent({
        tenantId,
        orderId,
        status,
        source: 'routes.admin.fixOrderStatus',
      });
      notifyTenantOrderStreams(tenantId, 'status', { orderId });
      await writeAdminAuditEvent({
        req,
        tenantId,
        action: 'fix_pedido_status',
        legacyAction: 'ADMIN_FIX_PEDIDO_STATUS',
        legacyDetails: `Pedido #${pedido.order_number || orderId} alterado de "${pedido.status}" para "${status}"`,
        entity: {
          type: 'pedido',
          id: orderId,
        },
        metadata: {
          order_number: pedido.order_number,
        },
        before: {
          status: pedido.status,
        },
        after: {
          status,
        },
      });
      res.json({ success: true, order_id: orderId, new_status: status });
    } catch (e: unknown) { sendInternalError(res, 'routes/admin', e); }
  });

  admin.post('/estoque/fix-links', async (_req, res) => {
    res.json({ success: true, message: 'Ação em desenvolvimento. Use a tela de Estoque para vincular produtos a ingredientes.' });
  });

  // ─── Dados operacionais por tenant (para painel individual) ───────────────────
  admin.get('/tenant/:id/pedidos', async (req: Request, res) => {
    try {
      const tenantId = Number(req.params.id);
      if (!tenantId) return res.status(400).json({ error: 'tenant_id inválido' });
      const cliente = await q1('SELECT id FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });

      const limit = Math.min(Math.max(1, Number(req.query.limit) || 30), 100);
      const rows = await qAll(
        `SELECT id, order_number, status, canal, total_amount, pagamento_tipo, pagamento_status, created_at, cancelado_at
         FROM pedidos WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?`,
        [tenantId, limit]
      );
      res.json(rows.map((p: any) => ({
        ...p,
        total_amount: Number(p.total_amount || 0),
        created_at: p.created_at,
      })));
    } catch (e: unknown) { sendInternalError(res, 'routes/admin', e); }
  });

  admin.get('/tenant/:id/pedidos/:orderId', async (req: Request, res) => {
    try {
      const tenantId = Number(req.params.id);
      const orderId = Number(req.params.orderId);
      if (!tenantId || !orderId) return res.status(400).json({ error: 'tenant_id ou pedido inválido' });
      const cliente = await q1('SELECT id FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });

      const pedido = await q1(
        `SELECT id, order_number, status, canal, total_amount, pagamento_tipo, pagamento_status,
                observation, created_at, cancelado_at, tipo_retirada, tenant_id
         FROM pedidos WHERE id=? AND tenant_id=?`,
        [orderId, tenantId]
      );
      if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado' });

      const itens = await qAll(
        `SELECT ip.id, ip.product_id, ip.quantity, ip.type, ip.price_at_time, ip.variation_id,
                COALESCE(p.name, 'Produto') AS product_name
         FROM itens_pedido ip
         LEFT JOIN produtos p ON p.id = ip.product_id AND p.tenant_id = ip.tenant_id
         WHERE ip.order_id=? AND ip.tenant_id=?
         ORDER BY ip.id ASC`,
        [orderId, tenantId]
      );

      const pagamentos = await qAll(
        `SELECT id, method, amount_paid, change_given, created_at
         FROM pagamentos WHERE order_id=? AND tenant_id=? ORDER BY id ASC`,
        [orderId, tenantId]
      );

      res.json({
        pedido: {
          ...(pedido as object),
          total_amount: Number((pedido as any).total_amount || 0),
        },
        itens: (itens || []).map((r: any) => ({
          ...r,
          quantity: Number(r.quantity || 0),
          price_at_time: Number(r.price_at_time || 0),
        })),
        pagamentos: (pagamentos || []).map((r: any) => ({
          ...r,
          amount_paid: Number(r.amount_paid || 0),
          change_given: Number(r.change_given || 0),
        })),
      });
    } catch (e: unknown) { sendInternalError(res, 'routes/admin', e); }
  });

  admin.get('/tenant/:id/caixa', async (req: Request, res) => {
    try {
      const tenantId = Number(req.params.id);
      if (!tenantId) return res.status(400).json({ error: 'tenant_id inválido' });
      const cliente = await q1('SELECT id FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });

      const caixasAbertos = await qAll(
        "SELECT id, data, fundo_inicial, status FROM caixa WHERE status='aberto' AND tenant_id=? ORDER BY data ASC",
        [tenantId]
      );
      const ultimoFechado = await q1(
        `SELECT id, data, valor_contado, closed_at FROM caixa WHERE status='fechado' AND tenant_id=? ORDER BY closed_at DESC LIMIT 1`,
        [tenantId]
      );
      res.json({
        caixas_abertos: caixasAbertos,
        status: caixasAbertos.length > 0 ? 'aberto' : 'fechado',
        ultimo_fechado: ultimoFechado,
      });
    } catch (e: unknown) { sendInternalError(res, 'routes/admin', e); }
  });

  admin.get('/tenant/:id/estoque', async (req: Request, res) => {
    try {
      const tenantId = Number(req.params.id);
      if (!tenantId) return res.status(400).json({ error: 'tenant_id inválido' });
      const cliente = await q1('SELECT id FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });

      const [resumo, abaixoMinimo, produtosSemVinculo] = await Promise.all([
        q1(`SELECT COUNT(*) as total_ingredientes, COALESCE(SUM(estoque_atual),0) as total_estoque FROM ingredientes WHERE tenant_id=?`, [tenantId]),
        qAll(`SELECT id, nome, estoque_atual, estoque_minimo FROM ingredientes WHERE tenant_id=? AND estoque_minimo>0 AND estoque_atual<estoque_minimo ORDER BY estoque_atual ASC LIMIT 20`, [tenantId]),
        qAll(`SELECT p.id, p.name FROM produtos p WHERE p.tenant_id=? AND COALESCE(p.active, 1) = 1
          AND NOT EXISTS (SELECT 1 FROM produto_ingrediente pi WHERE pi.product_id=p.id AND pi.tenant_id=p.tenant_id)
          AND NOT EXISTS (SELECT 1 FROM produto_variacoes_vendaveis pv WHERE pv.produto_id=p.id AND pv.tenant_id=p.tenant_id AND pv.ingrediente_id IS NOT NULL AND pv.ingrediente_id > 0)
          ORDER BY p.name ASC LIMIT 50`, [tenantId]),
      ]);
      res.json({
        total_ingredientes: Number(resumo?.total_ingredientes || 0),
        total_estoque: Number(resumo?.total_estoque || 0),
        abaixo_minimo: abaixoMinimo || [],
        produtos_sem_vinculo: produtosSemVinculo || [],
      });
    } catch (e: unknown) { sendInternalError(res, 'routes/admin', e); }
  });

  admin.get('/tenant/:id/logs', async (req: Request, res) => {
    try {
      const tenantId = Number(req.params.id);
      const limit = Math.min(Math.max(10, Number(req.query.limit) || 15), 20);
      if (!tenantId) return res.status(400).json({ error: 'tenant_id inválido' });
      const cliente = await q1('SELECT id FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });

      const logs = await qAll<{
        id: number;
        tenant_id: number;
        usuario_nome: string;
        cargo: string;
        acao: string;
        detalhes: string | null;
        created_at: string;
      }>(
        'SELECT id, tenant_id, usuario_nome, cargo, acao, detalhes, created_at FROM system_logs WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?',
        [tenantId, limit]
      );
      res.json(logs);
    } catch (e: unknown) {
      sendInternalError(res, 'routes/admin:tenantLogs', e);
    }
  });

  admin.get('/tenant/:id/delivery', async (req: Request, res) => {
    try {
      const tenantId = Number(req.params.id);
      if (!tenantId) return res.status(400).json({ error: 'tenant_id inválido' });
      const cliente = await q1('SELECT id, delivery_ativo, delivery_config FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });

      const cfg = coerceDeliveryConfigRow((cliente as any).delivery_config ?? null);
      const todayStr = getTodayDateInTimeZone();
      const notCanceled = "cancelado_at IS NULL AND LOWER(COALESCE(status,'')) <> 'cancelado'";

      const [pedidosHoje, emPreparo, emRota, motoboys] = await Promise.all([
        q1(`SELECT COUNT(*) as n, COALESCE(SUM(total_amount),0) as fat FROM pedidos WHERE tenant_id=? AND canal='delivery' AND ${notCanceled} AND (created_at AT TIME ZONE '${TZ}')::date=?`, [tenantId, todayStr]),
        q1(`SELECT COUNT(*) as n FROM pedidos WHERE tenant_id=? AND canal='delivery' AND ${notCanceled} AND status IN ('Criado','Pedido Recebido','Em Preparo')`, [tenantId]),
        q1(`SELECT COUNT(*) as n FROM pedidos WHERE tenant_id=? AND canal='delivery' AND ${notCanceled} AND status='Saiu para Entrega'`, [tenantId]),
        qAll('SELECT id, nome, telefone, ativo FROM delivery_motoboys WHERE tenant_id=? ORDER BY nome', [tenantId]),
      ]);

      res.json({
        ativo: !!((cliente as any).delivery_ativo),
        config: cfg,
        pedidos_hoje: Number(pedidosHoje?.n || 0),
        faturamento_hoje: Number(pedidosHoje?.fat || 0),
        em_preparo: Number(emPreparo?.n || 0),
        em_rota: Number(emRota?.n || 0),
        motoboys: motoboys || [],
      });
    } catch (e: unknown) { sendInternalError(res, 'routes/admin', e); }
  });

  admin.get('/lgpd-solicitacoes', async (req: Request, res) => {
    try {
      const tenantId = Number(req.query.tenant_id);
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: 'Informe tenant_id válido na query.' });
      }
      const tenant = await q1<{ id: number }>('SELECT id FROM clientes WHERE id=? LIMIT 1', [tenantId]);
      if (!tenant) return res.status(404).json({ error: 'Tenant não encontrado.' });

      const rows = await qAll<{
        id: number;
        tenant_id: number;
        tipo: string;
        entidade_id: number;
        status: string;
        created_at: string;
        motivo: string | null;
      }>(
        'SELECT id, tenant_id, tipo, entidade_id, status, created_at, motivo FROM lgpd_solicitacoes WHERE tenant_id=? ORDER BY created_at DESC',
        [tenantId]
      );

      const items = rows.map((r) => ({
        id: r.id,
        tenant_id: r.tenant_id,
        tipo: r.tipo,
        entidade_id: r.entidade_id,
        status: r.status,
        created_at: r.created_at,
        motivo_resumo:
          r.motivo == null || String(r.motivo).trim() === ''
            ? null
            : String(r.motivo).length > 240
              ? `${String(r.motivo).slice(0, 237)}...`
              : String(r.motivo),
      }));

      res.json({ items });
    } catch (e: unknown) {
      sendInternalError(res, 'routes/admin:lgpd-solicitacoes', e);
    }
  });

  admin.patch('/lgpd-solicitacoes/:id/status', async (req: Request, res) => {
    try {
      const tenantId = Number(req.query.tenant_id);
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: 'Informe tenant_id válido na query.' });
      }
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'id inválido.' });
      }

      const tenant = await q1<{ id: number }>('SELECT id FROM clientes WHERE id=? LIMIT 1', [tenantId]);
      if (!tenant) return res.status(404).json({ error: 'Tenant não encontrado.' });

      const body = parseBodyOrReply(res, adminLgpdStatusPatchSchema, req.body, replyZod400ErrorKey);
      if (!body) return;

      const existing = await q1<{ id: number; status: string | null }>(
        'SELECT id, status FROM lgpd_solicitacoes WHERE id=? AND tenant_id=?',
        [id, tenantId]
      );
      if (!existing) {
        return res.status(404).json({ error: 'Solicitação não encontrada para este tenant.' });
      }

      await withTx(async (client) => {
        await txRun(client, 'UPDATE lgpd_solicitacoes SET status=? WHERE id=? AND tenant_id=?', [body.status, id, tenantId]);
        await writeAdminAuditEvent({
          tx: client,
          req,
          tenantId,
          action: ADMIN_AUDIT_ACTIONS.ATUALIZAR_STATUS_SOLICITACAO_LGPD,
          legacyDetails: `Status da solicitacao LGPD #${id} atualizado para ${body.status}.`,
          entity: {
            type: 'lgpd_solicitacao',
            id,
          },
          metadata: {
            lgpd_solicitacao_id: id,
          },
          before: {
            status: existing.status,
          },
          after: {
            status: body.status,
          },
        });
      });
      res.json({ ok: true });
    } catch (e: unknown) {
      sendInternalError(res, 'routes/admin:lgpd-solicitacoes-status', e);
    }
  });

  // ─── Suporte operacional (query tenant_id; não altera rotas legadas) ─────────
  function adminAbsoluteUrl(req: Request, publicPath: string): string {
    const pathNorm = publicPath.startsWith('/') ? publicPath : `/${publicPath}`;
    const host = req.get('host');
    if (!host) return pathNorm;
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
    return `${proto}://${host}${pathNorm}`;
  }

  async function remoteImageRespondsOk(url: string): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      let r = await fetch(url, { method: 'HEAD', signal: ctrl.signal, redirect: 'follow' });
      if (r.status === 405 || r.status === 501) {
        r = await fetch(url, {
          method: 'GET',
          signal: ctrl.signal,
          redirect: 'follow',
          headers: { Range: 'bytes=0-0' },
        });
      }
      return r.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  admin.get('/cliente-overview', async (req: Request, res) => {
    try {
      const tenantId = Number(req.query.tenant_id);
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: 'tenant_id inválido' });
      }
      const cliente = await q1<{
        id: number;
        nome_estabelecimento: string;
        status: string;
        vencimento: string | null;
        trial_fim: string | null;
        ultimo_acesso: string | null;
        usuario: string;
        email: string;
        plano: string | null;
      }>(
        `SELECT id, nome_estabelecimento, status, vencimento, trial_fim, ultimo_acesso, usuario, email, plano
         FROM clientes WHERE id=?`,
        [tenantId]
      );
      if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });

      const todayStr = getTodayDateInTimeZone();
      const [caixaRow, pedidosHoje, usuariosRow] = await Promise.all([
        q1<{ n: unknown }>(
          "SELECT COUNT(*)::int AS n FROM caixa WHERE status='aberto' AND tenant_id=?",
          [tenantId]
        ),
        q1<{ n: unknown }>(
          `SELECT COUNT(*)::int AS n FROM pedidos WHERE tenant_id=?
           AND (created_at AT TIME ZONE '${TZ}')::date = ?`,
          [tenantId, todayStr]
        ),
        q1<{ n: unknown }>('SELECT COUNT(*)::int AS n FROM usuarios WHERE cliente_id=?', [tenantId]),
      ]);

      const caixaCount = sqlCount(caixaRow ? { c: caixaRow.n } : null);
      const pedidosCount = sqlCount(pedidosHoje ? { c: pedidosHoje.n } : null);
      const usuariosCount = sqlCount(usuariosRow ? { c: usuariosRow.n } : null);

      res.json({
        tenant_id: cliente.id,
        nome_estabelecimento: cliente.nome_estabelecimento,
        status: cliente.status,
        vencimento: cliente.vencimento,
        trial_fim: cliente.trial_fim,
        plano: cliente.plano,
        usuario: cliente.usuario,
        email: cliente.email,
        caixa_aberto: caixaCount > 0,
        caixas_abertos_count: caixaCount,
        pedidos_hoje: pedidosCount,
        usuarios: usuariosCount,
        ultima_atividade: cliente.ultimo_acesso,
      });
    } catch (e: unknown) {
      sendInternalError(res, 'routes/admin:cliente-overview', e);
    }
  });

  admin.get('/logs', async (req: Request, res) => {
    try {
      const tenantId = Number(req.query.tenant_id);
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: 'tenant_id inválido' });
      }
      const cliente = await q1('SELECT id FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });

      const limit = Math.min(Math.max(1, Number(req.query.limit) || 100), 500);
      const logs = await qAll<{
        id: number;
        tenant_id: number;
        usuario_nome: string;
        cargo: string;
        acao: string;
        detalhes: string | null;
        created_at: string;
      }>(
        'SELECT id, tenant_id, usuario_nome, cargo, acao, detalhes, created_at FROM system_logs WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?',
        [tenantId, limit]
      );
      res.json({ logs });
    } catch (e: unknown) {
      sendInternalError(res, 'routes/admin:logs-query', e);
    }
  });

  admin.get('/audit-events', async (req: Request, res) => {
    try {
      const tenantIdText = readOptionalQueryText(req.query.tenant_id);
      const tenantId = tenantIdText == null ? undefined : Number(tenantIdText);
      if (tenantIdText != null && (!Number.isInteger(tenantId) || tenantId <= 0)) {
        return res.status(400).json({ error: 'tenant_id inválido' });
      }

      if (tenantId != null) {
        const cliente = await q1('SELECT id FROM clientes WHERE id=?', [tenantId]);
        if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });
      }

      const scopeType = readOptionalQueryText(req.query.scope_type);
      const scopeId = readOptionalQueryText(req.query.scope_id);
      if ((scopeType && !scopeId) || (!scopeType && scopeId)) {
        return res.status(400).json({ error: 'scope_type e scope_id devem ser informados em conjunto' });
      }

      const dateFrom = normalizeAuditDateQuery(req.query.date_from);
      const dateTo = normalizeAuditDateQuery(req.query.date_to, true);
      if (dateFrom && Number.isNaN(Date.parse(dateFrom))) {
        return res.status(400).json({ error: 'date_from inválido' });
      }
      if (dateTo && Number.isNaN(Date.parse(dateTo))) {
        return res.status(400).json({ error: 'date_to inválido' });
      }
      if (dateFrom && dateTo && new Date(dateFrom).getTime() > new Date(dateTo).getTime()) {
        return res.status(400).json({ error: 'date_from não pode ser maior que date_to' });
      }

      const items = await listAdminAuditEvents({
        tenantId,
        action: readOptionalQueryText(req.query.action),
        requestId: readOptionalQueryText(req.query.request_id),
        sessionFingerprint: readOptionalQueryText(req.query.session_fingerprint),
        entityType: readOptionalQueryText(req.query.entity_type),
        entityId: readOptionalQueryText(req.query.entity_id),
        scopeType,
        scopeId,
        dateFrom,
        dateTo,
        limit: Math.min(Math.max(1, Number(req.query.limit) || 100), 200),
      });

      res.json({ items });
    } catch (e: unknown) {
      sendInternalError(res, 'routes/admin:audit-events', e);
    }
  });

  admin.post('/forcar-logout', async (req, res) => {
    try {
      const tenantId = Number(req.body?.tenant_id);
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ success: false, error: 'tenant_id inválido' });
      }
      const cliente = await q1('SELECT id FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) return res.status(404).json({ success: false, error: 'Cliente não encontrado' });

      const updated = await qAll<{ id: number }>(
        'UPDATE usuarios SET token_version=COALESCE(token_version,1)+1 WHERE cliente_id=? RETURNING id',
        [tenantId]
      );
      await writeAdminAuditEvent({
        req,
        tenantId,
        action: 'forcar_logout',
        legacyAction: 'ADMIN_FORCAR_LOGOUT',
        legacyDetails: `Sessões invalidadas (${updated.length} usuário(s)).`,
        entity: {
          type: 'usuario',
        },
        metadata: {
          users_affected: updated.length,
        },
      });
      res.json({ success: true, users_affected: updated.length });
    } catch (e: unknown) {
      sendInternalError(res, 'routes/admin:forcar-logout', e);
    }
  });

  admin.post('/reset-senha', async (req, res) => {
    try {
      const tenantId = Number(req.body?.tenant_id);
      const novaSenha = String(req.body?.nova_senha ?? '').trim();
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ success: false, error: 'tenant_id inválido' });
      }
      if (novaSenha.length < 6) {
        return res.status(400).json({ success: false, error: 'nova_senha deve ter pelo menos 6 caracteres' });
      }
      const cliente = await q1('SELECT id FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) return res.status(404).json({ success: false, error: 'Cliente não encontrado' });

      await withTx(async (client) => {
        await txRun(client, 'UPDATE usuarios SET password=? WHERE cliente_id=?', [bcrypt.hashSync(novaSenha, 10), tenantId]);
        await writeAdminAuditEvent({
          tx: client,
          req,
          tenantId,
          action: ADMIN_AUDIT_ACTIONS.RESET_SENHA,
          legacyDetails: 'Senha de login dos usuarios do tenant redefinida via API admin.',
          entity: {
            type: 'usuario',
          },
          after: {
            password_reset: true,
          },
        });
      });
      return res.json({ success: true });

      await qRun('UPDATE usuarios SET password=? WHERE cliente_id=?', [bcrypt.hashSync(novaSenha, 10), tenantId]);
      await writeAdminAuditEvent({
        req,
        tenantId,
        action: 'reset_senha',
        legacyAction: 'ADMIN_RESET_SENHA',
        legacyDetails: 'Senha de login dos usuários do tenant redefinida via API admin.',
        entity: {
          type: 'usuario',
        },
      });
      res.json({ success: true });
    } catch (e: unknown) {
      sendInternalError(res, 'routes/admin:reset-senha', e);
    }
  });

  admin.get('/pedidos', async (req: Request, res) => {
    try {
      const tenantId = Number(req.query.tenant_id);
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: 'tenant_id inválido' });
      }
      const cliente = await q1('SELECT id FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });

      const limit = Math.min(Math.max(1, Number(req.query.limit) || 30), 100);
      const rows = await qAll(
        `SELECT id, order_number, status, canal, total_amount, pagamento_tipo, pagamento_status, created_at, cancelado_at
         FROM pedidos WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?`,
        [tenantId, limit]
      );
      res.json(
        rows.map((p: any) => ({
          ...p,
          total_amount: Number(p.total_amount || 0),
          created_at: p.created_at,
        }))
      );
    } catch (e: unknown) {
      sendInternalError(res, 'routes/admin:pedidos-list', e);
    }
  });

  admin.get('/pedidos/:orderId', async (req: Request, res) => {
    try {
      const tenantId = Number(req.query.tenant_id);
      const orderId = Number(req.params.orderId);
      if (!Number.isInteger(tenantId) || tenantId <= 0 || !Number.isInteger(orderId) || orderId <= 0) {
        return res.status(400).json({ error: 'tenant_id e orderId válidos são obrigatórios' });
      }
      const cliente = await q1('SELECT id FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });

      const pedido = await q1(
        `SELECT id, order_number, status, canal, total_amount, pagamento_tipo, pagamento_status,
                observation, created_at, cancelado_at, tipo_retirada, tenant_id
         FROM pedidos WHERE id=? AND tenant_id=?`,
        [orderId, tenantId]
      );
      if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado' });

      const itens = await qAll(
        `SELECT ip.id, ip.product_id, ip.quantity, ip.type, ip.price_at_time, ip.variation_id,
                COALESCE(p.name, 'Produto') AS product_name
         FROM itens_pedido ip
         LEFT JOIN produtos p ON p.id = ip.product_id AND p.tenant_id = ip.tenant_id
         WHERE ip.order_id=? AND ip.tenant_id=?
         ORDER BY ip.id ASC`,
        [orderId, tenantId]
      );

      const pagamentos = await qAll(
        `SELECT id, method, amount_paid, change_given, created_at
         FROM pagamentos WHERE order_id=? AND tenant_id=? ORDER BY id ASC`,
        [orderId, tenantId]
      );

      res.json({
        pedido: {
          ...(pedido as object),
          total_amount: Number((pedido as any).total_amount || 0),
        },
        itens: (itens || []).map((r: any) => ({
          ...r,
          quantity: Number(r.quantity || 0),
          price_at_time: Number(r.price_at_time || 0),
        })),
        pagamentos: (pagamentos || []).map((r: any) => ({
          ...r,
          amount_paid: Number(r.amount_paid || 0),
          change_given: Number(r.change_given || 0),
        })),
      });
    } catch (e: unknown) {
      sendInternalError(res, 'routes/admin:pedidos-detalhe', e);
    }
  });

  admin.get('/verificar-imagens', async (req: Request, res) => {
    try {
      const tenantId = Number(req.query.tenant_id);
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: 'tenant_id inválido' });
      }
      const cliente = await q1('SELECT id FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });

      const produtos = await qAll<{ id: number; name: string | null; photo_url: string | null }>(
        `SELECT id, name, photo_url FROM produtos
         WHERE tenant_id=? AND photo_url IS NOT NULL AND TRIM(photo_url) <> ''
         ORDER BY id ASC
         LIMIT 400`,
        [tenantId]
      );

      const urls_invalidas: { product_id: number; name: string | null; raw: string; motivo: string }[] = [];
      const imagens_quebradas: { product_id: number; name: string | null; url: string }[] = [];

      for (const p of produtos) {
        const raw = String(p.photo_url || '').trim();
        const norm = normalizeProductPhotoPublicUrl(raw);
        if (!norm) {
          urls_invalidas.push({ product_id: p.id, name: p.name, raw, motivo: 'URL não normalizável' });
          continue;
        }

        const disk = resolveProductUploadDiskPath(raw);
        if (disk) {
          if (!fs.existsSync(disk)) {
            imagens_quebradas.push({ product_id: p.id, name: p.name, url: norm });
          }
          continue;
        }

        if (/^https?:\/\//i.test(norm)) {
          const ok = await remoteImageRespondsOk(norm);
          if (!ok) imagens_quebradas.push({ product_id: p.id, name: p.name, url: norm });
          continue;
        }

        const absolute = adminAbsoluteUrl(req, norm);
        const okLocal = await remoteImageRespondsOk(absolute);
        if (!okLocal) imagens_quebradas.push({ product_id: p.id, name: p.name, url: norm });
      }

      res.json({
        tenant_id: tenantId,
        verificados: produtos.length,
        urls_invalidas,
        imagens_quebradas,
      });
    } catch (e: unknown) {
      sendInternalError(res, 'routes/admin:verificar-imagens', e);
    }
  });

  admin.get('/whatsapp/conversations', async (req: Request, res) => {
    try {
      const tenantId = Number(req.query.tenant_id);
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: 'tenant_id inválido' });
      }
      const cliente = await q1('SELECT id FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });

      const period = normalizeWhatsAppPeriodQuery(req.query.period);
      const conversations = await listWhatsAppConversations(tenantId, period);
      res.json({ conversations });
    } catch (e: unknown) {
      sendAdminRouteError(res, 'routes/admin:whatsapp-conversations', e);
    }
  });

  admin.get('/whatsapp/conversations/:phone', async (req: Request, res) => {
    try {
      const tenantId = Number(req.query.tenant_id);
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: 'tenant_id inválido' });
      }
      const cliente = await q1('SELECT id FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });

      const customerPhone = normalizeWhatsAppConversationPhone(req.params.phone);
      if (!customerPhone) {
        return res.status(400).json({ error: 'Telefone inválido' });
      }

      const period = normalizeWhatsAppPeriodQuery(req.query.period);
      const conversation = await getWhatsAppConversationMessages(tenantId, customerPhone, period);
      if (!conversation) {
        return res.status(404).json({ error: 'Conversa não encontrada' });
      }

      res.json(conversation);
    } catch (e: unknown) {
      sendAdminRouteError(res, 'routes/admin:whatsapp-conversation-detail', e);
    }
  });

  admin.post('/whatsapp/conversations/:phone/send', async (req: Request, res) => {
    try {
      const tenantId = Number(req.body?.tenant_id);
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        return res.status(400).json({ error: 'tenant_id inválido' });
      }
      const cliente = await q1('SELECT id FROM clientes WHERE id=?', [tenantId]);
      if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });

      const customerPhone = normalizeWhatsAppConversationPhone(req.params.phone);
      if (!customerPhone) {
        return res.status(400).json({ error: 'Telefone inválido' });
      }

      const result = await sendWhatsAppConversationMessage({
        tenantId,
        customerPhone,
        message: req.body?.message,
        period: normalizeWhatsAppPeriodQuery(req.body?.period),
      });

      res.status(result.status === 'erro' ? 502 : 200).json(result);
    } catch (e: unknown) {
      sendAdminRouteError(res, 'routes/admin:whatsapp-conversation-send', e);
    }
  });

  // Monta /api/admin/* com proteção
  router.use('/admin', admin);
  return router;
}
