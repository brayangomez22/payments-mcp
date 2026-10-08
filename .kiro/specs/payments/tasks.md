# Plan de implementación — Pagos

- [ ] 1. Base del proyecto
  - [x] 1.1 package.json, tsconfig estricto, scripts de test con cobertura (ESLint pendiente)
  - [x] 1.2 Config de entorno validada, logger JSON con `requestId`, `AppError` + error handler
  - [x] 1.3 docker-compose con PostgreSQL y migración inicial
  - _Requisitos: 7.2, 8.1_

- [x] 2. Dominio de pagos
  - [x] 2.1 Esquemas Valibot (crear, reembolsar, listar) compartidos por REST y MCP
  - [x] 2.2 `PaymentProvider` (puerto) + `FakeProvider`
  - [x] 2.3 `PaymentRepository` (SQL, keyset pagination, `FOR UPDATE`)
  - [x] 2.4 `PaymentService`: create / get / list / refund con máquina de estados
  - [x] 2.5 Tests unitarios del service
  - _Requisitos: 1.1, 1.5–1.7, 2.1–2.4, 3.1–3.4_

- [x] 3. Idempotencia
  - [x] 3.1 `IdempotencyStore` (Postgres) + hash del request
  - [x] 3.2 Integrar en create y refund; tests de reintento y de reutilización de clave
  - _Requisitos: 1.2–1.4_

- [x] 4. API REST
  - [x] 4.1 Rutas + controller + OpenAPI 3.1 en `/docs`
  - [x] 4.2 Tests de integración HTTP
  - _Requisitos: 1, 2, 3, 8.2_

- [x] 5. Auth
  - [x] 5.1 `POST /oauth/token` (client credentials), firma ES256, JWKS
  - [x] 5.2 Middleware `authenticate` + `requireScope`
  - [x] 5.3 Tests 401/403
  - _Requisitos: 4.1–4.4_

- [x] 6. Servidor MCP
  - [x] 6.1 `/mcp` Streamable HTTP con validación del Bearer token
  - [x] 6.2 Tools filtradas por scope; `create_payment` idempotente; `refund_payment` con vista previa + confirmación
  - [x] 6.3 Tests con el `Client` del SDK
  - _Requisitos: 5.1–5.6_

- [x] 7. Eventos
  - [x] 7.1 Outbox en la misma transacción del cambio de estado
  - [x] 7.2 Relay a SQS (LocalStack) con `FOR UPDATE SKIP LOCKED` y fallos parciales de lote
  - _Requisitos: 6.1–6.2_

- [x] 8. Observabilidad
  - [x] 8.1 `/metrics` con prom-client (RED por ruta, `payments_total`, `mcp_tool_calls_total`, outbox), `/health/*`
  - [x] 8.2 Dockerfile + Prometheus (con alertas) + Loki + Alloy + Grafana (dashboard provisionado) en docker-compose
  - _Requisitos: 7.1–7.3_

- [x] 9. Agente demo con Anthropic SDK que consume `/mcp` (`npm run demo:agent`; aprobación humana en el host para tools destructivas)

- [x] 10. Terraform básico (SQS + DLQ, DynamoDB con TTL, VPC + esqueleto de EKS, rol IAM por Pod Identity) — `npm run tf:validate`
