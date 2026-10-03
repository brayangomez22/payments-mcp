# Producto

`payments-mcp` es un middleware que expone una API interna de pagos a dos tipos de clientes:

1. **Servicios internos** vía REST (`/api/v1/payments`).
2. **Agentes de IA** vía MCP (Model Context Protocol), con tools acotadas y permisos explícitos.

## Principios

- **Seguridad primero**: ningún agente puede mover dinero sin un token con el scope correcto.
  Las operaciones destructivas (reembolsos) requieren un scope distinto al de lectura.
- **Idempotencia**: toda operación que mueve dinero acepta `Idempotency-Key`. Un reintento nunca
  genera un cobro doble.
- **Trazabilidad**: cada request lleva un `requestId` que aparece en logs, métricas y eventos.
- **Montos en unidades menores** (`amountMinor`, entero) + `currency` ISO-4217. Nunca `float`.
