# El viaje de un pago: una sola historia para recordar todo

> **No memorices respuestas.** Recuerda **una historia** (el camino de un pago por tu sistema) y, en
> cada parada, **3 palabras clave**. Con ellas armas la respuesta con tus palabras, siguiendo
> **qué → por qué → ejemplo**.
>
> Si una pregunta te bloquea, pregúntate: **"¿en qué parada del viaje estoy?"**

## La historia completa (léela en voz alta 2 veces)

> Un **agente de IA** quiere cobrarle a un cliente. Primero **pide su pulsera** (el token). Con ella
> **entra al restaurante** (el servidor MCP) y solo **ve en el menú los platos que su pulsera permite**.
> Pide un cobro **con su ticket** (la clave de idempotencia). El cobro **se guarda** en Postgres, rápido
> gracias a los **índices**. El procesador **tarda demasiado**, así que el pago queda **pendiente**.
> Después llegan **dos reembolsos a la vez**, pero el **seguro del baño** y la **regla de la bóveda** lo
> impiden. Cada cambio deja un **aviso en el cuaderno** (outbox) que llega a la **bandeja** (SQS). Todo
> queda en el **tablero y la caja negra** (métricas y logs). Y todo corre en **loncheras dirigidas por
> un gerente** (Docker y Kubernetes), construido **con receta y probado** (spec y tests).

## Las 10 paradas

| # | Parada | Pregunta típica | 3 palabras clave | Tu ejemplo |
|---|---|---|---|---|
| 1 | 🎟️ **La pulsera** (token) | ¿Cómo se autentica el agente? / ¿Qué es OAuth2 y JWT? | **máquina a máquina** · **firmado, no cifrado** · **ES256 + JWKS** | Token de 15 min con `merchant_id` y scopes |
| 2 | 🍽️ **El menú** (MCP) | ¿Qué es MCP? ¿Por qué no la API REST directa? | **descripciones para IA** · **menú pequeño** · **mismo service** | 4 tools que llaman al `PaymentService` |
| 3 | 🚫 **Lo que no ves** (seguridad) | ¿Cómo proteges el servidor MCP? ¿Prompt injection? | **filtrar por scope** · **confirmar** · **validar en el servidor** | Sin `payments:refund`, la tool no aparece; vista previa + `confirm: true` |
| 4 | 🎫 **El ticket** (idempotencia) | ¿Cómo evitas el doble cobro? | **misma clave = misma respuesta** · **409 / 422** · **la PK decide** | `Idempotency-Key`; la trampa: la IA inventa una clave nueva |
| 5 | 📖 **El índice del libro** (Postgres) | Una consulta está lenta, ¿qué haces? | **EXPLAIN ANALYZE** · **índice que siga la query** · **cursor, no OFFSET** | 65 ms → 0,036 ms |
| 6 | ⏳ **El que no contesta** (timeout) | ¿Qué pasa si el procesador no responde? | **no sé ≠ falló** · **pending + 202** · **conciliación** | Se guarda `pending` antes de llamar al procesador |
| 7 | 🚪 **El baño con seguro** (concurrencia) | ¿Dos reembolsos al mismo tiempo? | **FOR UPDATE** · **CHECK** · **defensa en profundidad** | La segunda espera y se rechaza con `REFUND_EXCEEDS_AMOUNT` |
| 8 | 📒 **El cuaderno y la bandeja** (outbox + SQS) | ¿Qué es outbox? ¿SQS o Kafka? | **misma transacción** · **relay publica** · **consumidor idempotente** | Tabla `outbox` con índice parcial en el diseño |
| 9 | 🚗 **El tablero del carro** (observabilidad + Kubernetes) | ¿Qué métricas? ¿Liveness vs readiness? | **RED + percentiles** · **requestId** · **BD solo en readiness** | `/health/live` y `/health/ready` |
| 10 | 📋 **La receta y la prueba** (SDD + tests) | ¿Qué es SDD? ¿Cómo trabajas con IA? ¿Cobertura? | **spec antes del código** · **la responsabilidad es mía** · **cobertura ≠ calidad** | 79 tests, 94,5 %, tests con el número del requisito |

**Y una parada extra, la más probable: "¿Qué mejorarías?"** → **llamada al procesador dentro de la
transacción** · **agota conexiones** · **dividir en 3 pasos**.

## Cómo convertir 3 palabras en una respuesta

Ejemplo con la parada 7. Las palabras son **FOR UPDATE · CHECK · defensa en profundidad**:

> "**Qué:** es una condición de carrera; las dos peticiones leen el mismo saldo. **Cómo lo evito:** con
> `FOR UPDATE` la primera bloquea la fila y la segunda espera, lee el saldo actualizado y la rechazo.
> **Por qué dos defensas:** además tengo un `CHECK` en la tabla, por si algún día el código falla; eso es
> defensa en profundidad."

No tiene que salir igual cada vez. **Si dices las 3 ideas, la respuesta es buena.**

## El plan de práctica

### Esta noche (máximo 30 minutos)

1. **Lee la historia completa en voz alta**, 2 veces.
2. **Recorre las 10 paradas tapando la columna "3 palabras clave".** Para cada una, intenta decirlas.
   Después destapa y revisa.
3. **Marca con ✗ las que no recordaste.** Repasa solo esas.
4. **Elige 3 paradas y responde en voz alta**, como en la entrevista, usando las 3 palabras. Mejor si
   te grabas con el celular y te escuchas.
5. **Duerme.** Mientras duermes, el cerebro ordena lo que aprendiste. Esto está comprobado.

### Mañana temprano (15 minutos)

1. Lee la historia una vez.
2. Recorre las 10 paradas tapando las palabras clave. **Repasa solo las que fallen.**
3. Repasa los números: **79 tests · 94,5 % · 65 ms → 0,036 ms · tokens de 15 min · timeout de 5 s**.
4. **No estudies nada nuevo.** Solo repasa.

## Por qué este método funciona

| Técnica | Qué hace |
|---|---|
| **Una historia** en vez de una lista | El cerebro recuerda recorridos y lugares mucho mejor que datos sueltos |
| **Analogías** (pulsera, ticket, baño…) | Una imagen se recuerda más fácil que una definición |
| **Tapar y recordar** (*recuerdo activo*) | Intentar sacar la información de la memoria la fija mucho más que releerla |
| **Hablar en voz alta** | Practicas lo que harás mañana: explicar, no leer |
| **Dormir** | El cerebro consolida lo aprendido durante el sueño |
