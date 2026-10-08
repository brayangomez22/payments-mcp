import { Router, type Request } from 'express';
import { getAuth, requireScope } from '../../core/auth/authenticate.js';
import { Errors } from '../../core/errors.js';
import { parseOrThrow } from '../../core/validation.js';
import {
  CreatePaymentSchema,
  IdempotencyKeySchema,
  ListPaymentsSchema,
  PaymentIdSchema,
  RefundPaymentSchema,
} from './payment.schemas.js';
import type { MerchantContext, PaymentService } from './payment.service.js';

export function paymentRoutes(service: PaymentService): Router {
  const router = Router();

  router.post('/', requireScope('payments:write'), async (req, res) => {
    const input = parseOrThrow(CreatePaymentSchema, req.body);
    const payment = await service.create(merchantOf(req), input, idempotencyKey(req));
    // 202: accepted but the provider outcome is still unknown.
    res
      .status(payment.status === 'pending' ? 202 : 201)
      .location(`${req.baseUrl}/${payment.id}`)
      .json(payment);
  });

  router.get('/', requireScope('payments:read'), async (req, res) => {
    const input = parseOrThrow(ListPaymentsSchema, req.query);
    res.json(await service.list(getAuth(req), input));
  });

  router.get('/:id', requireScope('payments:read'), async (req, res) => {
    const id = parseOrThrow(PaymentIdSchema, req.params['id'], 'id');
    res.json(await service.get(getAuth(req), id));
  });

  router.post('/:id/refunds', requireScope('payments:refund'), async (req, res) => {
    const id = parseOrThrow(PaymentIdSchema, req.params['id'], 'id');
    const input = parseOrThrow(RefundPaymentSchema, req.body);
    res.status(201).json(await service.refund(merchantOf(req), id, input, idempotencyKey(req)));
  });

  return router;
}

function idempotencyKey(req: Request): string {
  const key = req.get('idempotency-key');
  if (key === undefined) throw Errors.idempotencyKeyRequired();
  return parseOrThrow(IdempotencyKeySchema, key, 'Idempotency-Key');
}

function merchantOf(req: Request): MerchantContext {
  return { merchantId: getAuth(req).merchantId, requestId: req.requestId };
}
