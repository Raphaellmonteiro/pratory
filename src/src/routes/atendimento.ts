import { Router, Request, Response } from 'express';
import { qAll } from '../db';
import { requireAnyPermission } from '../middleware';
import { validateDeliveryItems } from '../services/deliveryItemValidation';
import {
  lookupStoreCustomerByPhone,
  normalizeStoreCustomerPhone,
} from '../services/storeCustomerService';
import { AppError } from '../utils/errors';
import { sendInternalError } from '../utils/internalServerError';
import { normalizeProductPhotoPublicUrl } from '../utils/productPhotoUrl';

type TenantRequest = Request & { tenantId: number | string };

function getTenantId(req: TenantRequest): number {
  const tenantId = Number(req.tenantId);
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new AppError('Tenant inválido', 400);
  }
  return tenantId;
}

export function createAtendimentoRouter() {
  const router = Router();
  router.use(requireAnyPermission('orders', 'delivery', 'pos'));

  router.get('/prefill', async (req: TenantRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);
      const raw = typeof req.query.telefone === 'string' ? req.query.telefone : '';
      const telefone = normalizeStoreCustomerPhone(raw);
      if (!telefone || telefone.length < 8) {
        return res.status(400).json({ error: 'Telefone inválido (mín. 8 dígitos)' });
      }

      const cliente = await lookupStoreCustomerByPhone(tenantId, telefone);
      if (!cliente) {
        res.json({ telefone_normalizado: telefone, cliente: null, enderecos: [] });
        return;
      }

      const enderecos = await qAll(
        `SELECT id, label, logradouro, numero, complemento, bairro, referencia, principal, created_at
         FROM delivery_enderecos
         WHERE tenant_id=? AND cliente_id=?
         ORDER BY principal DESC, id DESC`,
        [tenantId, cliente.id]
      );

      res.json({
        telefone_normalizado: telefone,
        cliente: { id: cliente.id, nome: cliente.nome, telefone: cliente.telefone },
        enderecos,
      });
    } catch (e: unknown) {
      sendInternalError(res, 'routes/atendimento:prefill', e);
    }
  });

  router.get('/produtos', async (req: TenantRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (q.length < 2) {
        res.json([]);
        return;
      }

      const term = `%${q}%`;
      const rows = await qAll(
        `SELECT id, name, price, category, photo_url, COALESCE(is_combo,0) AS is_combo
         FROM produtos
         WHERE tenant_id=?
           AND COALESCE(active,0)=1
           AND (name ILIKE ? OR category ILIKE ?)
         ORDER BY name ASC
         LIMIT 30`,
        [tenantId, term, term]
      );

      const withPhoto = rows.map((r: any) => ({
        ...r,
        photo_url: normalizeProductPhotoPublicUrl(r.photo_url),
      }));

      res.json(withPhoto);
    } catch (e: unknown) {
      sendInternalError(res, 'routes/atendimento:produtos', e);
    }
  });

  router.post('/delivery/itens/validate', async (req: TenantRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);
      const items = req.body?.items;
      const result = await validateDeliveryItems(tenantId, Array.isArray(items) ? items : []);
      res.json(result);
    } catch (e: unknown) {
      if (e instanceof AppError) {
        res.status(e.statusCode).json({ error: e.message });
        return;
      }
      sendInternalError(res, 'routes/atendimento:deliveryValidateItems', e);
    }
  });

  return router;
}

