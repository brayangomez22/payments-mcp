import { Router, type Request } from 'express';
import { getAuth } from '../../core/auth/placeholder-auth.js';
import { Errors } from '../../core/errors.js';
import { parseOrThrow } from '../../core/validation.js';
import {
  CreatePaymentSchema,
  IdempotencyKeySchema,
  ListPaymentsSchema,
  PaymentIdSchema,
  RefundPaymentSchema,
} from './payment.schemas.js';
import type { PaymentService } from './payment.service.js';

export function paymentRoutes(service: PaymentService): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const input = parseOrThrow(CreatePaymentSchema, req.body);
    const payment = await service.create(getAuth(req), input, idempotencyKey(req));
    // 202: accepted but the provider outcome is still unknown.
    res
      .status(payment.status === 'pending' ? 202 : 201)
      .location(`${req.baseUrl}/${payment.id}`)
      .json(payment);
  });

  router.get('/', async (req, res) => {
    const input = parseOrThrow(ListPaymentsSchema, req.query);
    res.json(await service.list(getAuth(req), input));
  });

  router.get('/:id', async (req, res) => {
    const id = parseOrThrow(PaymentIdSchema, req.params['id']);
    res.json(await service.get(getAuth(req), id));
  });

  router.post('/:id/refunds', async (req, res) => {
    const id = parseOrThrow(PaymentIdSchema, req.params['id']);
    const input = parseOrThrow(RefundPaymentSchema, req.body);
    res.status(201).json(await service.refund(getAuth(req), id, input, idempotencyKey(req)));
  });

  return router;
}

function idempotencyKey(req: Request): string {
  const key = req.get('idempotency-key');
  if (key === undefined) throw Errors.idempotencyKeyRequired();
  return parseOrThrow(IdempotencyKeySchema, key);
}
