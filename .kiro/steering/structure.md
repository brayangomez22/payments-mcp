# Estructura

```
src/
  config/            # entorno validado
  core/              # errores, logger, http, auth, métricas (transversal)
  features/
    payments/        # routes → controller → service → repository
    auth/            # emisión de tokens (OAuth2 client credentials)
  integrations/
    provider/        # adaptador del procesador de pagos externo (puerto + implementaciones)
  mcp/               # servidor MCP: tools que llaman al service (no al HTTP)
  app.ts             # composición de Express
  server.ts          # arranque
db/migrations/       # SQL versionado
tests/               # unit + integration
```

## Reglas de capas

- `routes/controller` solo traducen HTTP ↔ dominio.
- `service` contiene la lógica de negocio y es el **único** punto que usan REST y MCP.
- `repository` es el único que habla SQL.
- `integrations/provider` es un puerto: el service depende de la interfaz, no del proveedor.
