# Plan de implementación — Pagos

- [ ] 1. Base del proyecto
  - [ ] 1.1 package.json, tsconfig estricto, ESLint, scripts de test con cobertura
  - [ ] 1.2 Config de entorno validada, logger JSON con `requestId`, `AppError` + error handler
  - [ ] 1.3 docker-compose con PostgreSQL y migración inicial
  - _Requisitos: 7.2, 8.1_

- [ ] 2. Dominio de pagos
  - [ ] 2.1 Esquemas Valibot (crear, reembolsar, listar) compartidos por REST y MCP
  - [ ] 2.2 `PaymentProvider` (puerto) + `FakeProvider`
  - [ ] 2.3 `PaymentRepository` (SQL, keyset pagination, `FOR UPDATE`)
  - [ ] 2.4 `PaymentService`: create / get / list / refund con máquina de estados
  - [ ] 2.5 Tests unitarios del service
  - _Requisitos: 1.1, 1.5–1.7, 2.1–2.4, 3.1–3.4_

- [ ] 3. Idempotencia
  - [ ] 3.1 `IdempotencyStore` (Postgres) + hash del request
  - [ ] 3.2 Integrar en create y refund; tests de reintento y de reutilización de clave
  - _Requisitos: 1.2–1.4_

- [ ] 4. API REST
  - [ ] 4.1 Rutas + controller + OpenAPI 3.1 en `/docs`
  - [ ] 4.2 Tests de integración HTTP
  - _Requisitos: 1, 2, 3, 8.2_

- [ ] 5. Auth
  - [ ] 5.1 `POST /oauth/token` (client credentials), firma ES256, JWKS
  - [ ] 5.2 Middleware `authenticate` + `requireScope`
  - [ ] 5.3 Tests 401/403
  - _Requisitos: 4.1–4.4_

- [ ] 6. Servidor MCP
  - [ ] 6.1 `/mcp` Streamable HTTP con validación del Bearer token
  - [ ] 6.2 Tools filtradas por scope; `refund_payment` con confirmación
  - [ ] 6.3 Tests con el `Client` del SDK
  - _Requisitos: 5.1–5.6_

- [ ] 7. Eventos
  - [ ] 7.1 Outbox en la misma transacción del cambio de estado
  - [ ] 7.2 Relay a SQS (LocalStack)
  - _Requisitos: 6.1–6.2_

- [ ] 8. Observabilidad
  - [ ] 8.1 `/metrics` con prom-client, `/health/*`
  - [ ] 8.2 Prometheus + Loki + Grafana en docker-compose
  - _Requisitos: 7.1–7.3_

- [ ] 9. Agente demo con Anthropic SDK que consume `/mcp`

- [ ] 10. Terraform básico (SQS, DynamoDB con TTL, esqueleto de EKS)
