// src/middleware.ts — middlewares, multer, rate limiters
import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import type { Express } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { isDatabaseConnectivityError, pool, q1 } from './db';
import { type PlanFeature } from './config/planFeatures';
import { getTenantFeatures } from './services/tenantPlan';
import { sendInternalError } from './utils/internalServerError';
import { UPLOADS_ROOT } from './uploadsRoot';
import { useMulterMemoryForImageUploads } from './services/imageUploadPolicy';
import {
  MAX_IMAGE_UPLOAD_BYTES,
  PRODUCT_IMAGE_ALLOWED_CLIENT_MIMES,
  STATIC_IMAGE_ALLOWED_CLIENT_MIMES,
  cleanupMulterImageFile,
  hardenMulterImageFile,
  normalizeClientMime,
} from './utils/imageUploadSecurity';

type AuthenticatedSession =
  | {
      ok: true;
      user: any;
      tenantId: number;
      userCargo?: string;
      userPermissoes?: string[] | null;
      userName?: string;
    }
  | {
      ok: false;
      status: number;
      body: { error: string };
    };

const DEFAULT_ALLOWED_ORIGINS = 'http://localhost:5173,http://localhost:3001';

function normalizeAllowedOrigin(input?: string | null): string | null {
  const value = String(input || '').trim();
  if (!value) return null;
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

function parseAllowedOrigins(raw?: string | null): string[] {
  return String(raw || '')
    .split(',')
    .map((origin) => normalizeAllowedOrigin(origin))
    .filter((origin): origin is string => Boolean(origin));
}

export const ALLOWED_BROWSER_ORIGINS = parseAllowedOrigins(
  process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS
);

function extractRequestOrigin(req: Request): string | null {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0]?.trim();
  const proto = forwardedProto || req.protocol;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0]?.trim();
  if (!proto || !host) return null;
  return normalizeAllowedOrigin(`${proto}://${host}`);
}

function extractSourceOrigin(req: Request): string | null {
  const originHeader = normalizeAllowedOrigin(req.get('origin'));
  if (originHeader) return originHeader;
  return normalizeAllowedOrigin(req.get('referer'));
}

/**
 * Mitigacao pragmatica de CSRF para rotas acionadas por browser.
 * Aceita mesma origem e origens explicitamente permitidas.
 * Quando `Origin`/`Referer` estiverem ausentes, preserva integracoes legitimas por padrao.
 */
export function requireTrustedBrowserOrigin(opts?: {
  allowMissing?: boolean;
  extraAllowedOrigins?: string[];
}) {
  const allowMissing = opts?.allowMissing ?? true;
  const allowedOrigins = new Set([
    ...ALLOWED_BROWSER_ORIGINS,
    ...parseAllowedOrigins(opts?.extraAllowedOrigins?.join(',')),
  ]);

  return (req: Request, res: Response, next: NextFunction) => {
    const sourceOrigin = extractSourceOrigin(req);
    if (!sourceOrigin) {
      if (allowMissing) return next();
      return res.status(403).json({ error: 'Origem nao permitida' });
    }

    const requestOrigin = extractRequestOrigin(req);
    if ((requestOrigin && sourceOrigin === requestOrigin) || allowedOrigins.has(sourceOrigin)) {
      return next();
    }

    return res.status(403).json({ error: 'Origem nao permitida' });
  };
}

// ── Segredos ──────────────────────────────────────────────────────────────────
export const JWT_SECRET = process.env.JWT_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ FATAL: JWT_SECRET não definido no .env. Encerrando.');
    process.exit(1);
  }
  console.warn('⚠️  JWT_SECRET não definido — usando valor de desenvolvimento INSEGURO.');
  return 'dev-jwt-secret-MUDE-NO-DOT-ENV';
})();

export const ADMIN_SECRET = process.env.ADMIN_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ FATAL: ADMIN_SECRET não definido no .env. Encerrando.');
    process.exit(1);
  }
  console.warn('⚠️  ADMIN_SECRET não definido — usando valor de desenvolvimento INSEGURO.');
  return 'dev-admin-secret-MUDE-NO-DOT-ENV';
})();

// ── Rate limiters ─────────────────────────────────────────────────────────────
const loginWindowMs = 15 * 60 * 1000;
const loginMaxAttempts = process.env.NODE_ENV === 'production' ? 5 : 15;

export const loginRateLimiter = rateLimit({
  windowMs: loginWindowMs,
  max: loginMaxAttempts,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Muitas tentativas de login falhas. Aguarde 15 minutos e tente novamente.',
  },
  skipSuccessfulRequests: true,
});

export const publicRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em instantes.' },
});

/** POST público de resumo de checkout (delivery) — por IP; rota custosa mas sem escrita; limite entre cardápio e criação de pedido. */
export const deliveryPublicPedidoResumoRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 45 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em instantes.' },
});

/** POST público de criação de pedido (delivery) — por IP; mais restrito que o cardápio (DB, estoque, notificações). */
export const deliveryPublicPedidoCreateRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 20 : 80,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em instantes.' },
});

/** POST /api/privacidade/solicitar-exclusao — por tenant (após JWT); reduz spam em lgpd_solicitacoes. */
export const lgpdSolicitacaoExclusaoRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Limite de solicitações de exclusão (LGPD) atingido para esta loja. Tente novamente em até 1 hora.',
  },
  keyGenerator: (req) => {
    const raw = (req as Request & { tenantId?: number | string }).tenantId;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      return `lgpd_solicitacao_exclusao:tenant:${n}`;
    }
    return `lgpd_solicitacao_exclusao:ip:${ipKeyGenerator(req.ip || '')}`;
  },
});

const PRODUCT_MIME_FILTER_SET = new Set<string>(PRODUCT_IMAGE_ALLOWED_CLIENT_MIMES);
const STATIC_MIME_FILTER_SET = new Set<string>(STATIC_IMAGE_ALLOWED_CLIENT_MIMES);

/**
 * Valida nome/extensão/MIME, magic bytes, alinhamento extensão × conteúdo × MIME,
 * reencode leve (sharp) para JPEG/PNG/WEBP e grava buffer + disco alinhados ao fluxo Cloudinary/local.
 */
export function hardenUploadedImageFile(opts: { allowGif: boolean }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) return next();
    try {
      const result = await hardenMulterImageFile(file, opts);
      if (result.ok === false) {
        cleanupMulterImageFile(file);
        return res.status(400).json({ success: false, message: result.message });
      }
      next();
    } catch (e) {
      cleanupMulterImageFile(file);
      next(e);
    }
  };
}

// ── Multer — fotos de produto ─────────────────────────────────────────────────
const productDiskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_ROOT),
  filename: (_req, file, cb) => cb(null, `produto-${Date.now()}${path.extname(file.originalname)}`),
});

export const upload = multer({
  storage: useMulterMemoryForImageUploads() ? multer.memoryStorage() : productDiskStorage,
  limits: { fileSize: MAX_IMAGE_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    PRODUCT_MIME_FILTER_SET.has(normalizeClientMime(file.mimetype))
      ? cb(null, true)
      : cb(new Error('Apenas imagens são permitidas'));
  },
});

// ── Multer — logo do tenant ───────────────────────────────────────────────────
const logoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, path.join(UPLOADS_ROOT, 'logo')),
  filename: (req: any, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const suffix = crypto.randomBytes(8).toString('hex');
    cb(null, `logo_${req.tenantId || 'admin'}_${suffix}${ext}`);
  },
});

export const uploadLogo = multer({
  storage: useMulterMemoryForImageUploads() ? multer.memoryStorage() : logoStorage,
  limits: { fileSize: MAX_IMAGE_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    STATIC_MIME_FILTER_SET.has(normalizeClientMime(file.mimetype))
      ? cb(null, true)
      : cb(new Error('Apenas JPEG, PNG ou WEBP'));
  },
});

const deliveryCardapioDir = path.join(UPLOADS_ROOT, 'delivery');

const deliveryCardapioLogoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(deliveryCardapioDir)) fs.mkdirSync(deliveryCardapioDir, { recursive: true });
    cb(null, deliveryCardapioDir);
  },
  filename: (req: any, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `delivery_${req.tenantId}_cardapio_logo${ext}`);
  },
});

/** Logo exclusiva do cardápio online (delivery); arquivos em uploads/delivery/ */
export const uploadDeliveryCardapioLogo = multer({
  storage: useMulterMemoryForImageUploads() ? multer.memoryStorage() : deliveryCardapioLogoStorage,
  limits: { fileSize: MAX_IMAGE_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    STATIC_MIME_FILTER_SET.has(normalizeClientMime(file.mimetype))
      ? cb(null, true)
      : cb(new Error('Apenas JPEG, PNG ou WEBP'));
  },
});

const deliveryCardapioBannerStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(deliveryCardapioDir)) fs.mkdirSync(deliveryCardapioDir, { recursive: true });
    cb(null, deliveryCardapioDir);
  },
  filename: (req: any, file, cb) => {
    const raw = parseInt(String(req.params?.index ?? ''), 10);
    const idx = Number.isFinite(raw) ? Math.min(3, Math.max(0, raw)) : 0;
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `delivery_${req.tenantId}_banner_${idx}${ext}`);
  },
});

/** Banner do topo do cardápio; campo `banner`; rota deve incluir `:index` (0–3). */
export const uploadDeliveryCardapioBanner = multer({
  storage: useMulterMemoryForImageUploads() ? multer.memoryStorage() : deliveryCardapioBannerStorage,
  limits: { fileSize: MAX_IMAGE_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    STATIC_MIME_FILTER_SET.has(normalizeClientMime(file.mimetype))
      ? cb(null, true)
      : cb(new Error('Apenas JPEG, PNG ou WEBP'));
  },
});

const deliveryCardapioReactivationMediaStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(deliveryCardapioDir)) fs.mkdirSync(deliveryCardapioDir, { recursive: true });
    cb(null, deliveryCardapioDir);
  },
  filename: (req: any, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `delivery_${req.tenantId}_reativacao_cardapio${ext}`);
  },
});

/** Imagem opcional para campanhas de reativação via WhatsApp. */
export const uploadDeliveryCardapioReactivationMedia = multer({
  storage: useMulterMemoryForImageUploads() ? multer.memoryStorage() : deliveryCardapioReactivationMediaStorage,
  limits: { fileSize: MAX_IMAGE_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    STATIC_MIME_FILTER_SET.has(normalizeClientMime(file.mimetype))
      ? cb(null, true)
      : cb(new Error('Apenas JPEG, PNG ou WEBP'));
  },
});

// ── Multer — foto de funcionário ──────────────────────────────────────────────
const fotoFuncStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(UPLOADS_ROOT, 'funcionarios');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => cb(null, `func-${Date.now()}${path.extname(file.originalname)}`),
});

export const uploadFotoFunc = multer({
  storage: useMulterMemoryForImageUploads() ? multer.memoryStorage() : fotoFuncStorage,
  limits: { fileSize: MAX_IMAGE_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    STATIC_MIME_FILTER_SET.has(normalizeClientMime(file.mimetype))
      ? cb(null, true)
      : cb(new Error('Apenas imagens'));
  },
});

// ── authenticateAdmin ─────────────────────────────────────────────────────────
function applyAuthenticatedSession(req: Request, session: Extract<AuthenticatedSession, { ok: true }>) {
  req.user = session.user;
  req.tenantId = session.tenantId;
  req.userCargo = session.userCargo;
  req.userPermissoes = session.userPermissoes;
  req.userName = session.userName;
}

/**
 * JWT somente em `Authorization: Bearer <token>` (não aceita token solto no header nem na query).
 */
export function extractBearerToken(req: Request): string | null {
  const raw = req.headers['authorization'];
  const authHeader = Array.isArray(raw) ? raw[0] : raw;
  if (!authHeader || typeof authHeader !== 'string') return null;
  const m = authHeader.match(/^\s*Bearer\s+(\S+)/i);
  return m ? m[1] : null;
}

/**
 * Caminho completo da rota após os mounts do Express (`baseUrl` + `req.path`).
 * `req.path` sozinho é relativo ao sub-router (ex.: só `/clientes` em `/api/admin/clientes`), o que quebraria checagens por prefixo.
 */
function resolveRequestPathname(req: Request): string {
  const base = req.baseUrl || '';
  const pathPart = req.path || '';
  let full = base + pathPart;
  if (full.length > 1 && full.endsWith('/')) {
    full = full.slice(0, -1);
  }
  return full;
}

/** Rotas /api/admin/* e /api/v1/admin/* (exceto login): JWT de admin não passa em resolveAuthenticatedSession; este fallback mantém o painel com um único Bearer. */
function isProtectedPlatformAdminApiPath(req: Request): boolean {
  const reqPath = resolveRequestPathname(req);
  const legacy = reqPath === '/api/admin' || reqPath.startsWith('/api/admin/');
  const v1 = reqPath === '/api/v1/admin' || reqPath.startsWith('/api/v1/admin/');
  if (!legacy && !v1) return false;
  if (legacy && reqPath === '/api/admin/login') return false;
  if (v1 && reqPath === '/api/v1/admin/login') return false;
  return true;
}

function tryApplyPlatformAdminBearer(req: Request): boolean {
  const token = extractBearerToken(req);
  if (!token) return false;
  try {
    const decoded: any = jwt.verify(token, ADMIN_SECRET);
    if (decoded.role !== 'admin') return false;
    req.user = { id: 0, username: 'platform_admin', role: 'platform_admin' };
    req.userCargo = 'dono';
    req.userPermissoes = null;
    req.userName = 'platform_admin';
    delete (req as any).tenantId;
    return true;
  } catch {
    return false;
  }
}

function normalizeCargo(value?: string | null) {
  return String(value || '').trim().toLowerCase();
}

function isFullAccessSession(req: Request) {
  const cargo = normalizeCargo(req.userCargo);
  if (!cargo && (req.userPermissoes === undefined || req.userPermissoes === null)) return true;
  if (cargo === 'dono') return true;
  return false;
}

export function hasModulePermission(req: Request, permission: string) {
  if (!permission) return true;
  if (isFullAccessSession(req)) return true;
  if (!Array.isArray(req.userPermissoes)) return false;
  return req.userPermissoes.includes(permission);
}

export function requireAnyPermission(...permissions: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (permissions.length === 0 || permissions.some((permission) => hasModulePermission(req, permission))) {
      return next();
    }

    return res.status(403).json({
      error: 'Acesso negado',
      required_permissions: permissions,
    });
  };
}

export function requirePlanFeature(feature: PlanFeature) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.tenantId) {
        return res.status(401).json({ error: 'Tenant não identificado' });
      }

      const features = await getTenantFeatures(req.tenantId);
      if (features.includes(feature)) {
        return next();
      }

      return res.status(403).json({
        error: 'Plano não inclui este recurso',
        feature,
      });
    } catch (err: unknown) {
      sendInternalError(res, 'middleware.requirePlanFeature', err, { feature });
      return;
    }
  };
}

function buildAuthenticationErrorResponse(err: unknown): Extract<AuthenticatedSession, { ok: false }> {
  const message = err instanceof Error ? err.message : String(err ?? 'Erro desconhecido');
  const isDbUnavailable = isDatabaseConnectivityError(err);

  console.error('[resolveAuthenticatedSession] erro:', {
    message,
    code:
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code ?? '')
        : undefined,
  });

  return {
    ok: false,
    status: isDbUnavailable ? 503 : 500,
    body: {
      error: isDbUnavailable ? 'Serviço de autenticação temporariamente indisponível' : 'Erro de autenticação',
    },
  };
}

async function touchTenantLastAccess(tenantId: number) {
  try {
    await pool.query('UPDATE clientes SET ultimo_acesso=NOW() WHERE id=$1', [tenantId]);
  } catch (err) {
    console.warn('[resolveAuthenticatedSession] falha ao atualizar ultimo_acesso:', {
      tenantId,
      message: err instanceof Error ? err.message : String(err ?? 'Erro desconhecido'),
    });
  }
}

export async function resolveAuthenticatedSession(req: Request): Promise<AuthenticatedSession> {
  const token = extractBearerToken(req);

  if (!token) {
    return {
      ok: false,
      status: 401,
      body: { error: 'Token não fornecido. Envie Authorization: Bearer <token>.' },
    };
  }

  let user: any;
  try {
    user = jwt.verify(token, JWT_SECRET) as any;
  } catch {
    return { ok: false, status: 403, body: { error: 'Token inválido ou expirado' } };
  }

  try {
    const userId = Number(user?.id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return { ok: false, status: 401, body: { error: 'Sessão inválida ou expirada' } };
    }

    const row = await q1<{
      token_version: number;
      ativo: number | null;
      cliente_id: number | null;
      cargo: string | null;
      permissoes: string | null;
      nome: string | null;
      owner_id: number | null;
      owner_status: string | null;
      owner_vencimento: string | Date | null;
      sub_status: string | null;
      sub_vencimento: string | Date | null;
    }>(
      `SELECT
         u.token_version,
         u.ativo,
         u.cliente_id,
         u.cargo,
         u.permissoes,
         u.nome,
         c_owner.id AS owner_id,
         c_owner.status AS owner_status,
         c_owner.vencimento AS owner_vencimento,
         c_sub.status AS sub_status,
         c_sub.vencimento AS sub_vencimento
       FROM usuarios u
       LEFT JOIN clientes c_owner ON c_owner.usuario = u.username
       LEFT JOIN clientes c_sub ON c_sub.id = u.cliente_id
       WHERE u.id = ?
       LIMIT 1`,
      [userId]
    );

    if (!row) {
      return { ok: false, status: 401, body: { error: 'Sessão inválida. Por favor, faça login novamente.' } };
    }

    const jwtVersion = Number(user.token_version ?? 0);
    const dbVersion = Number(row.token_version ?? 1);
    if (jwtVersion !== dbVersion) {
      return { ok: false, status: 401, body: { error: 'Sessão inválida ou expirada' } };
    }

    if (Number(row.ativo) === 0) {
      return { ok: false, status: 403, body: { error: 'bloqueado' } };
    }

    if (row.owner_id != null) {
      if (row.owner_status === 'bloqueado') return { ok: false, status: 403, body: { error: 'bloqueado' } };
      if (row.owner_vencimento && new Date() > new Date(row.owner_vencimento)) {
        return { ok: false, status: 403, body: { error: 'trial_expirado' } };
      }

      void touchTenantLastAccess(Number(row.owner_id));

      return {
        ok: true,
        user,
        tenantId: row.owner_id,
      };
    }

    if (row.cliente_id) {
      if (row.sub_status === 'bloqueado') return { ok: false, status: 403, body: { error: 'bloqueado' } };
      if (row.sub_vencimento && new Date() > new Date(row.sub_vencimento)) {
        return { ok: false, status: 403, body: { error: 'trial_expirado' } };
      }

      return {
        ok: true,
        user,
        tenantId: row.cliente_id,
        userCargo: row.cargo || 'atendente',
        userPermissoes: row.permissoes ? JSON.parse(row.permissoes) : null,
        userName: row.nome || user.username,
      };
    }

    return { ok: false, status: 401, body: { error: 'Sessão inválida. Por favor, faça login novamente.' } };
  } catch (err) {
    return buildAuthenticationErrorResponse(err);
  }
}

export const authenticateToken = async (req: Request, res: Response, next: NextFunction) => {
  const session = await resolveAuthenticatedSession(req);
  if (session.ok === true) {
    applyAuthenticatedSession(req, session);
    return next();
  }

  if (isProtectedPlatformAdminApiPath(req) && tryApplyPlatformAdminBearer(req)) {
    return next();
  }

  return res.status(session.status).json(session.body);
};

export const authenticateAdmin = (req: any, res: any, next: any) => {
  const token = extractBearerToken(req);
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  try {
    const decoded: any = jwt.verify(token, ADMIN_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
    next();
  } catch {
    return res.status(403).json({ error: 'Token inválido' });
  }
};

// ── authDeliveryCliente ───────────────────────────────────────────────────────
export const authDeliveryCliente = (req: any, res: any, next: any) => {
  const token = extractBearerToken(req);
  if (!token) return res.status(401).json({ error: 'Token de cliente necessário' });
  try {
    const dec: any = jwt.verify(token, JWT_SECRET);
    if (dec.tipo !== 'delivery_cliente') return res.status(403).json({ error: 'Token inválido' });
    req.clienteId = dec.clienteId;
    req.tenantId  = dec.tenantId;
    next();
  } catch { return res.status(403).json({ error: 'Token de cliente inválido' }); }
};

// ── QR temporário do garçom (abrir mesa + lançar pedidos, sem login pessoal) ──
// Gerado sob demanda em Mesas → "Gerar QR Garçom" por quem já está autenticado
// normalmente (dono/gerente). Token stateless, expira sozinho — nada gravado no banco.
const GARCOM_TEMP_TOKEN_TTL = '6h';

// Tamanho máximo aceito pro nome autodeclarado do garçom (enviado no header
// abaixo). Não é autenticação — é somente rastreabilidade operacional em
// system_logs (quem abriu/fechou qual mesa).
const GARCOM_NOME_MAX_LEN = 60;
const GARCOM_NOME_HEADER = 'x-garcom-nome';

export function signGarcomTempToken(tenantId: number | string) {
  return jwt.sign({ tipo: 'garcom_temp', tenantId }, JWT_SECRET, { expiresIn: GARCOM_TEMP_TOKEN_TTL });
}

/**
 * Token de garçom já identificado: emitido só depois que ele escolheu seu
 * nome na lista de garçons cadastrados e acertou o PIN (ver `POST
 * /api/mesas/garcom-login`). Carrega `garcomId`/`garcomNome` no próprio JWT
 * (stateless, igual ao QR temporário) — dessa forma toda ação feita com esse
 * token já sai carimbada com o garçom certo, sem depender de header de texto
 * livre digitado pelo cliente.
 */
export function signGarcomIdentifiedToken(tenantId: number | string, garcomId: number, garcomNome: string) {
  return jwt.sign(
    { tipo: 'garcom_temp', tenantId, garcomId, garcomNome: String(garcomNome || '').slice(0, GARCOM_NOME_MAX_LEN) },
    JWT_SECRET,
    { expiresIn: GARCOM_TEMP_TOKEN_TTL }
  );
}

/**
 * Extrai o nome autodeclarado do garçom enviado no header `x-garcom-nome`
 * (guardado no navegador do aparelho após a telinha "Qual seu nome?").
 * Isso NÃO é autenticação: é texto livre, usado só pra carimbar as ações
 * em system_logs. Sem header, cai no fallback genérico.
 */
function extractGarcomNome(req: Request): string {
  const raw = req.headers[GARCOM_NOME_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = String(value || '').trim().slice(0, GARCOM_NOME_MAX_LEN);
  return trimmed || 'Garçom (sem nome)';
}

/**
 * Aceita tanto o JWT normal de sessão quanto o QR temporário do garçom.
 * Quando é QR temporário, monta uma sessão sintética com escopo mínimo
 * (apenas o módulo "mesas") — a restrição fina de rota fica a cargo de
 * `restrictGarcomTempScope`, aplicado só no router de mesas. Também anexa
 * `req.garcomNome` (autodeclarado, ver `extractGarcomNome`) pra quem for
 * gravar log de ação (abrir/fechar mesa).
 */
export const authenticateTokenOrGarcomTemp = async (req: Request, res: Response, next: NextFunction) => {
  const token = extractBearerToken(req);
  if (token) {
    try {
      const dec: any = jwt.verify(token, JWT_SECRET);
      if (dec?.tipo === 'garcom_temp' && dec?.tenantId) {
        req.tenantId = dec.tenantId;
        req.user = { id: 0, username: 'garcom_temp', role: 'garcom_temp' } as any;
        req.userCargo = 'garcom_temp';
        req.userPermissoes = ['mesas'];
        (req as any).isGarcomTemp = true;
        (req as any).garcomId = typeof dec.garcomId === 'number' ? dec.garcomId : null;
        (req as any).garcomNome = dec.garcomNome ? String(dec.garcomNome).slice(0, GARCOM_NOME_MAX_LEN) : extractGarcomNome(req);
        return next();
      }
    } catch {
      // Não é (ou não é mais) um QR de garçom válido — segue para a sessão normal abaixo.
    }
  }
  return authenticateToken(req, res, next);
};

/**
 * Aplicado só nas rotas de /mesas: quando a sessão veio do QR temporário do
 * garçom, permite listar mesas, ver comanda, abrir mesa, ver os grupos de
 * adicionais/combo de um produto, lançar/editar/remover itens, pedir a conta
 * (avisar o balcão) e fechar mesa (finalizar pagamento) — nunca reconfigurar
 * mesas nem gerar novo QR.
 */
export function restrictGarcomTempScope(req: Request, res: Response, next: NextFunction) {
  if (!(req as any).isGarcomTemp) return next();

  // Antes de se identificar (escolher o nome na lista de garçons cadastrados
  // + digitar o PIN), o QR só pode listar os garçons e tentar o login.
  const preLogin =
    (req.method === 'GET' && req.path === '/garcons-publico') ||
    (req.method === 'POST' && req.path === '/garcom-login');
  if (preLogin) return next();

  if (!(req as any).garcomId) {
    return res.status(401).json({ error: 'Selecione seu nome e informe o PIN para continuar.' });
  }

  const allowed =
    (req.method === 'GET' && (
      req.path === '/'
      || req.path === '/produtos-garcom'
      || /^\/produtos-garcom\/[^/]+\/opcoes$/.test(req.path)
      || /^\/[^/]+\/comanda$/.test(req.path)
    )) ||
    (req.method === 'PUT' && (/^\/[^/]+\/abrir$/.test(req.path) || /^\/comanda\/item\/[^/]+$/.test(req.path))) ||
    (req.method === 'DELETE' && /^\/comanda\/item\/[^/]+$/.test(req.path)) ||
    (req.method === 'POST' && (/^\/[^/]+\/comanda\/adicionar$/.test(req.path) || /^\/[^/]+\/comanda\/finalizar$/.test(req.path) || /^\/[^/]+\/solicitar-conta$/.test(req.path)));

  if (!allowed) {
    return res.status(403).json({ error: 'QR temporário do garçom não permite esta ação.' });
  }
  return next();
}

/** JWT de cliente delivery quando enviado; se o header existir e for inválido, responde 403. Pedidos sem vínculo de cliente não exigem token na rota que usar isto. */
export const optionalAuthDeliveryCliente = (req: any, res: any, next: any) => {
  const token = extractBearerToken(req);
  if (!token) return next();
  try {
    const dec: any = jwt.verify(token, JWT_SECRET);
    if (dec.tipo !== 'delivery_cliente') {
      return res.status(403).json({ error: 'Token inválido' });
    }
    req.clienteId = dec.clienteId;
    req.tenantId = dec.tenantId;
    next();
  } catch {
    return res.status(403).json({ error: 'Token de cliente inválido' });
  }
};

// ── Logging: nunca registrar credenciais / segredos em texto puro ─────────────
const FULL_REDACT_BODY_PATHS = new Set([
  '/api/login',
  '/api/auth/verify-admin',
  '/api/auth/verify-caixa',
  '/api/admin/login',
]);

const SENSITIVE_KEY_EXACT = new Set([
  'password',
  'pass',
  'pwd',
  'senha',
  'nova_senha',
  'senha_admin',
  'senha_caixa',
  'subsenha',
  'pin',
  'token',
  'authorization',
  'secret',
  'api_key',
  'apikey',
  'cvv',
  'cvc',
  'clientetoken',
]);

function isSensitiveLogKey(key: string): boolean {
  const k = key.toLowerCase().replace(/-/g, '_');
  if (SENSITIVE_KEY_EXACT.has(k)) return true;
  if (k.includes('password') || k.includes('senha')) return true;
  if (k.endsWith('_token')) return true;
  return false;
}

function redactBodyForLogs(value: unknown, depth = 0): unknown {
  if (depth > 10) return '[Profundidade máxima]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactBodyForLogs(item, depth + 1));
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return '[Objeto]';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveLogKey(k) ? '[REDACTED]' : redactBodyForLogs(v, depth + 1);
    }
    return out;
  }
  return value;
}

function normalizeApiPathForRedaction(path: string): string {
  if (path === '/api/v1' || path.startsWith('/api/v1/')) {
    return '/api' + path.slice('/api/v1'.length);
  }
  return path;
}

function shouldRedactEntireRequestBody(path: string): boolean {
  const p = normalizeApiPathForRedaction(path);
  if (FULL_REDACT_BODY_PATHS.has(p)) return true;
  if (p.endsWith('/login-func')) return true;
  return false;
}

/** Evita vazar JWT e segredos em access logs quando aparecem na query (ex. tentativas antigas de SSE). */
function redactSensitiveQueryInUrl(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const pathPart = url.slice(0, q);
  const qs = url.slice(q + 1);
  try {
    const sp = new URLSearchParams(qs);
    const keys = [...new Set(sp.keys())];
    let changed = false;
    for (const key of keys) {
      const lower = key.toLowerCase();
      if (
        lower === 'token' ||
        lower === 'access_token' ||
        lower === 'id_token' ||
        lower === 'refresh_token' ||
        lower === 'authorization' ||
        lower === 'auth' ||
        lower === 'jwt' ||
        lower.endsWith('_token')
      ) {
        sp.set(key, '[REDACTED]');
        changed = true;
      }
    }
    return changed ? `${pathPart}?${sp.toString()}` : url;
  } catch {
    return `${pathPart}?[query]`;
  }
}

// ── Logging middleware ────────────────────────────────────────────────────────
/** Em produção, `true` força o mesmo log detalhado (IP, UA, body) do desenvolvimento. */
const LOG_REQUEST_BODY =
  process.env.LOG_REQUEST_BODY === 'true' || process.env.LOG_REQUEST_BODY === '1';

function logVerboseRequestStart(req: Request) {
  const agente = req.headers['user-agent']?.substring(0, 35) || 'Desconhecido';
  const safeUrl = redactSensitiveQueryInUrl(req.url);
  console.log(`[${new Date().toISOString()}] IP: ${req.ip} | Agente: ${agente}... | ${req.method} ${safeUrl}`);
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const safe = shouldRedactEntireRequestBody(req.path) ? '[REDACTED]' : redactBodyForLogs(req.body);
    console.log('Body:', typeof safe === 'string' ? safe : JSON.stringify(safe));
  }
}

/**
 * Desenvolvimento: log imediato com IP, user-agent, rota e body (POST/PUT/PATCH), com redação.
 * Produção (padrão): uma linha ao final com rid=, método, rota, status e duração; ip= só se status >= 400; body só se status >= 400 em POST/PUT/PATCH.
 * Produção + LOG_REQUEST_BODY=true: mesmo comportamento do desenvolvimento.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  req.requestId = crypto.randomBytes(4).toString('hex');

  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd || LOG_REQUEST_BODY) {
    logVerboseRequestStart(req);
    return next();
  }

  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    const safeUrl = redactSensitiveQueryInUrl(req.url);
    const ipSuffix = res.statusCode >= 400 ? ` ip=${req.ip}` : '';
    console.log(
      `[${new Date().toISOString()}] rid=${req.requestId} ${req.method} ${safeUrl} ${res.statusCode} ${ms}ms${ipSuffix}`
    );
    if (
      res.statusCode >= 400 &&
      ['POST', 'PUT', 'PATCH'].includes(req.method)
    ) {
      const safe = shouldRedactEntireRequestBody(req.path) ? '[REDACTED]' : redactBodyForLogs(req.body);
      console.log('Body:', typeof safe === 'string' ? safe : JSON.stringify(safe));
    }
  });
  next();
}
