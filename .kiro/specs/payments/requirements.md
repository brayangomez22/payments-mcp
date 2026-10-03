# Requisitos — Pagos

## Introducción

Middleware que permite a servicios internos y a agentes de IA crear, consultar y reembolsar pagos
contra un procesador externo, de forma segura, idempotente y observable.

---

### Requisito 1 — Crear un pago

**Historia:** Como servicio interno o agente autorizado, quiero crear un pago para cobrarle a un
cliente sin riesgo de cobros duplicados.

#### Criterios de aceptación

1. CUANDO se recibe `POST /api/v1/payments` con un cuerpo válido y un `Idempotency-Key`, EL SISTEMA
   DEBERÁ registrar el pago, enviarlo al procesador y responder `201` con el pago y su `status`.
2. SI falta el header `Idempotency-Key`, ENTONCES EL SISTEMA DEBERÁ responder `400 IDEMPOTENCY_KEY_REQUIRED`.
3. CUANDO llega una petición con un `Idempotency-Key` ya usado **y el mismo cuerpo**, EL SISTEMA
   DEBERÁ devolver la respuesta original sin volver a llamar al procesador.
4. SI llega un `Idempotency-Key` ya usado **con un cuerpo distinto**, ENTONCES EL SISTEMA DEBERÁ
   responder `422 IDEMPOTENCY_KEY_REUSED`.
5. SI `amountMinor` no es un entero positivo o `currency` no es un código ISO-4217 soportado
   (`COP`, `USD`), ENTONCES EL SISTEMA DEBERÁ responder `400 VALIDATION_ERROR` con el detalle.
6. SI el procesador rechaza el cobro, ENTONCES EL SISTEMA DEBERÁ guardar el pago con `status = failed`
   y `failureReason`, y responder `201` (el recurso se creó; el cobro falló).
7. SI el procesador no responde en 5 s, ENTONCES EL SISTEMA DEBERÁ dejar el pago en `pending` y
   responder `202`, para conciliarlo después.

### Requisito 2 — Consultar pagos

**Historia:** Como servicio o agente, quiero consultar un pago o listar los de un comercio para
conocer su estado.

1. CUANDO se recibe `GET /api/v1/payments/:id` de un pago existente del mismo `merchantId` que el
   token, EL SISTEMA DEBERÁ responder `200` con el pago.
2. SI el pago no existe **o pertenece a otro comercio**, ENTONCES EL SISTEMA DEBERÁ responder
   `404 PAYMENT_NOT_FOUND` (no se revela la existencia de recursos ajenos).
3. CUANDO se recibe `GET /api/v1/payments?status=&limit=&cursor=`, EL SISTEMA DEBERÁ devolver los
   pagos del comercio ordenados por fecha descendente con **paginación por cursor (keyset)**.
4. EL SISTEMA DEBERÁ limitar `limit` a un máximo de 100.

### Requisito 3 — Reembolsar un pago

**Historia:** Como servicio o agente con permiso de reembolso, quiero devolver total o parcialmente
un pago exitoso.

1. CUANDO se recibe `POST /api/v1/payments/:id/refunds` con `amountMinor` y `Idempotency-Key`,
   y el pago está en `succeeded` o `partially_refunded`, EL SISTEMA DEBERÁ registrar el reembolso
   y actualizar el estado a `partially_refunded` o `refunded`.
2. SI la suma de reembolsos supera el monto del pago, ENTONCES EL SISTEMA DEBERÁ responder
   `409 REFUND_EXCEEDS_AMOUNT`.
3. SI el pago no está en un estado reembolsable, ENTONCES EL SISTEMA DEBERÁ responder
   `409 PAYMENT_NOT_REFUNDABLE`.
4. MIENTRAS se procesa un reembolso, EL SISTEMA DEBERÁ bloquear la fila del pago
   (`SELECT … FOR UPDATE`) para evitar reembolsos concurrentes que excedan el monto.

### Requisito 4 — Autenticación y autorización

**Historia:** Como equipo de seguridad, quiero que solo clientes autorizados y con el scope
adecuado operen sobre pagos.

1. CUANDO un cliente envía `POST /oauth/token` con `grant_type=client_credentials` y credenciales
   válidas, EL SISTEMA DEBERÁ emitir un JWT firmado (RS256 o ES256) con `sub`, `merchant_id`,
   `scope` y `exp` ≤ 15 min.
2. SI una ruta protegida recibe un token ausente, inválido o expirado, ENTONCES EL SISTEMA DEBERÁ
   responder `401` con `WWW-Authenticate: Bearer`.
3. SI el token es válido pero no tiene el scope requerido, ENTONCES EL SISTEMA DEBERÁ responder `403`.
4. Scopes: `payments:read` (consultar), `payments:write` (crear), `payments:refund` (reembolsar).

### Requisito 5 — Exposición vía MCP

**Historia:** Como agente de IA, quiero usar tools MCP para operar pagos sin conocer la API REST.

1. EL SISTEMA DEBERÁ exponer en `/mcp` (Streamable HTTP) las tools `create_payment`,
   `get_payment`, `list_payments` y `refund_payment`.
2. CUANDO un cliente MCP se conecta sin un Bearer token válido, EL SISTEMA DEBERÁ responder `401`.
3. EL SISTEMA DEBERÁ listar únicamente las tools permitidas por los scopes del token.
4. CUANDO se invoca una tool, EL SISTEMA DEBERÁ validar la entrada con el mismo esquema que REST y
   ejecutar la misma lógica de servicio (sin duplicar reglas de negocio).
5. SI se invoca `refund_payment` sin `confirm: true`, ENTONCES EL SISTEMA DEBERÁ devolver una vista
   previa del reembolso sin ejecutarlo (*human-in-the-loop*).
6. SI una tool falla, ENTONCES EL SISTEMA DEBERÁ devolver `isError: true` con un mensaje útil para
   el modelo y sin exponer detalles internos (stack, SQL).

### Requisito 6 — Eventos

1. CUANDO un pago cambia de estado, EL SISTEMA DEBERÁ publicar un evento `payment.<status>` en SQS
   con `paymentId`, `merchantId`, `status`, `requestId` y `occurredAt`.
2. SI la publicación falla, ENTONCES EL SISTEMA NO DEBERÁ revertir el pago; DEBERÁ registrar el
   evento como pendiente (patrón *outbox*) y reintentarlo.

### Requisito 7 — Observabilidad

1. EL SISTEMA DEBERÁ exponer métricas Prometheus en `/metrics`: latencia HTTP por ruta y código,
   pagos por estado, invocaciones MCP por tool y resultado.
2. EL SISTEMA DEBERÁ emitir logs JSON estructurados con `requestId`, sin datos sensibles.
3. EL SISTEMA DEBERÁ exponer `/health/live` y `/health/ready` (este último verifica la BD).

### Requisito 8 — Calidad y documentación

1. EL SISTEMA DEBERÁ mantener cobertura de pruebas ≥ 85 % de líneas.
2. EL SISTEMA DEBERÁ publicar la especificación OpenAPI 3.1 en `/docs`.
