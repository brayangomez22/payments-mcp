# Stack técnico

| Área | Elección | Motivo |
|---|---|---|
| Runtime | Node.js ≥ 22, TypeScript estricto, ESM | Ecosistema MCP/Anthropic más maduro |
| HTTP | Express 5 | Async errors nativos, conocido por el equipo |
| Validación | Valibot | Esquemas tipados, liviano |
| Base de datos | PostgreSQL 17 con `pg` (SQL explícito, sin ORM) | Control total sobre queries e índices |
| Idempotencia | Tabla en Postgres → luego DynamoDB con TTL | Ver `design.md` |
| Auth | OAuth2 client credentials + JWT (`jose`) con scopes | Máquina-a-máquina |
| MCP | `@modelcontextprotocol/sdk`, transporte Streamable HTTP | Estándar oficial |
| Eventos | SQS (LocalStack) | Desacoplar webhooks/notificaciones |
| Tests | `node:test` + cobertura `--experimental-test-coverage` | Sin dependencias extra; meta ≥ 85 % |
| Docs API | OpenAPI 3.1 + Swagger UI | Requisito del equipo |
| Observabilidad | Prometheus (`prom-client`), Loki (logs JSON), Grafana | Requisito del equipo |
| Infra | Docker Compose local, Terraform para AWS (EKS/SQS/DynamoDB) | IaC básica |

## Convenciones

- Imports con extensión `.js` (NodeNext).
- Errores de dominio con `AppError(code, status, message)`; nunca `throw new Error` en features.
- Ningún secreto en código; todo por variables de entorno validadas al arrancar.
