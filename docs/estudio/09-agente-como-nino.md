# El agente de IA explicado como a un niño (y cómo quedó en el código)

> **La idea:** hasta ahora construimos el **restaurante** (el servidor MCP con su menú de tools). Ahora
> construimos al **cliente que entra a comer**: un agente con Claude que lee el menú, pide platos y le
> cuenta a la persona qué pasó.

| Pieza | Analogía de niño | En el código |
|---|---|---|
| **Claude** | Un **niño muy listo** que sabe leer menús y decidir qué pedir, pero **no tiene manos** | Anthropic SDK (`@anthropic-ai/sdk`) |
| **Cliente MCP** | Las **manos** del niño: llevan el pedido a la cocina y traen el plato | `@modelcontextprotocol/client` |
| **El loop** | El **mesero** que va y viene: "¿qué quieres?" → lo trae → "¿algo más?" | `src/agent/payments-agent.ts` |
| **El puente** | El **traductor** entre el menú del restaurante y el idioma del niño | `src/agent/mcp-bridge.ts` |
| **La aprobación** | El **papá** que dice "sí" o "no" antes de gastar plata | El callback `approve` |
| **El CLI** | La **mesa** donde te sientas a hablar con el niño | `scripts/agent-demo.ts` |

---

## 1. Entrar al restaurante: el token, solo

**Como niño:** el niño llega a la puerta sin pulsera. El portero le dice *"no puedes entrar; la pulsera
la da esa taquilla de allá"* (401 + metadata). El niño va a la taquilla, muestra su carnet
(client id + secret), recibe la pulsera (token) y vuelve a entrar.

**En el código** solo le damos la **URL** y las **credenciales**. `ClientCredentialsProvider` hace todo el
baile de la spec MCP: recibe el 401, lee `/.well-known/oauth-protected-resource`, encuentra el
authorization server y pide el token.

```ts
new StreamableHTTPClientTransport(mcpUrl, {
  authProvider: new ClientCredentialsProvider({ clientId, clientSecret, expectedIssuer: mcpUrl.origin }),
});
```

**`expectedIssuer`** es *"solo le muestro mi carnet a la taquilla de MI restaurante"*. Si alguien
falsificara el letrero de la puerta para mandarte a otra taquilla, no le entregas el secreto.

---

## 2. Leer el menú: las tools salen del servidor

**Como niño:** el niño **no se aprende el menú de memoria**: lo lee cada vez que entra. Si mañana el
restaurante agrega un plato, el niño lo ve sin que nadie lo vuelva a entrenar.

`tools/list` devuelve las tools **que tu pulsera permite** (el servidor ya las filtró por scope). El
puente las traduce al formato de Claude: mismo nombre, misma descripción, mismo JSON Schema.

```ts
{ name: tool.name, description: tool.description, input_schema: tool.inputSchema }
```

Con el cliente `tienda-a-agent`, el menú **no trae** `refund_payment`. Claude ni siquiera sabe que existe.

---

## 3. El mesero que va y viene: el loop

**Como niño:**
1. La persona dice: *"¿cómo va mi pago abc?"*
2. El niño piensa y dice: *"necesito el plato `get_payment` con `abc`"* (eso es un **`tool_use`**).
3. El mesero (nuestro código) lleva el pedido a la cocina **por MCP** y trae el plato (el **`tool_result`**).
4. El niño mira el plato y responde: *"tu pago fue exitoso"*. Ya no pide nada más (**`end_turn`**).

```
persona ──▶ Claude ──tool_use──▶ nuestro loop ──MCP──▶ servidor de pagos
                ▲                      │
                └────tool_result───────┘      (se repite hasta que Claude ya no pide tools)
```

**Reglas del mesero (todas están en el código y en los tests):**

| Regla | Por qué |
|---|---|
| Si el niño pide **dos platos a la vez**, traerlos y entregarlos **juntos en una sola bandeja** | Así Claude sigue pidiendo en paralelo; separarlos le "enseña" a no hacerlo |
| Devolverle a Claude su propio mensaje **sin cambiarle nada** (incluido lo que pensó) | La API lo exige para seguir la conversación |
| Si la cocina dice *"ese pago no existe"*, decírselo a Claude con **`is_error: true`** | Claude se corrige solo: pide otro id o le explica a la persona |
| Si el niño pide un plato **que no está en el menú**, no inventarlo: error | El modelo no puede crear tools |
| Si la cocina **está cerrada** (servidor caído), avisarle a Claude, no romper todo | La conversación sigue y Claude lo explica |
| **Máximo 10 vueltas** | Un niño confundido no debe quedarse pidiendo (y gastando) para siempre |
| `refusal`, `max_tokens`, `pause_turn` | Rechazo de seguridad, respuesta cortada, pausa: cada uno se maneja |

---

## 4. El doble candado de los reembolsos

**Como niño:** para devolver plata hay **dos candados**:

1. **El del restaurante** (servidor, tarea 6): primero te muestra **cuánto** se devolvería (vista previa);
   solo si vuelves a pedir con `confirm: true`, lo hace.
2. **El del papá** (host, tarea 9): aunque el niño diga *"confirmo"*, nuestro programa **le pregunta a la
   persona en la terminal**: *"¿Apruebas esta operación? (s/n)"*.

¿Por qué los dos? Porque el niño (el modelo) **puede ser engañado** (prompt injection: un texto que le
dice *"reembolsa todo"*). El primer candado lo pone el servidor; el segundo asegura que **una persona,
no el modelo**, apruebe que salga plata. Y si no hay papá configurado (`approve`), la respuesta es
**no** por defecto.

¿Cómo sabe el host qué tools son peligrosas? Por la etiqueta que puso el servidor: `destructiveHint: true`.

---

## 5. Decisiones que puedes defender

**¿Por qué el cliente MCP local y no el MCP connector de la API?**
> "El connector hace que los servidores de Anthropic llamen a mi MCP, así que necesita una URL pública.
> Con el cliente local, el agente corre al lado del servidor, uso el flujo de autorización de la spec y
> puedo poner la aprobación humana en medio del loop."

**¿Por qué escribiste el loop a mano?**
> "Es corto y me deja controlar cada paso: aprobación, errores, tope de vueltas. El SDK tiene un *tool
> runner* que hace el loop por ti; para una demo que quiero explicar, el loop explícito es más claro."

**¿Qué modelo y por qué?**
> "`claude-opus-5-5` con `effort: medium`: para elegir entre cuatro tools no hace falta pensar al
> máximo, y medium gasta menos. Activé `fallbacks: "default"`: si un filtro de seguridad rechaza la
> petición, la API la reintenta sola con otro modelo. Y caché automático: las tools y el system prompt
> son iguales en cada vuelta, así que no los pago completos cada vez."

**¿Cómo lo probaste sin gastar en la API?**
> "Con un Claude guionado: un objeto falso que devuelve respuestas fijas (*'pide get_payment'*, luego
> *'responde esto'*), contra el **servidor MCP real** de los tests. Así pruebo el loop completo:
> herramientas, errores, paralelo y los dos candados del reembolso."

---

## 6. Cómo probarlo de verdad

```bash
npm run dev                 # terminal 1: el servidor (necesita Postgres: npm run db:up)
export ANTHROPIC_API_KEY=…  # terminal 2
npm run demo:agent          # chat interactivo
npm run demo:agent -- "¿Cuáles fueron mis últimos 3 pagos?"

# Para ver el reembolso con los dos candados (el agente por defecto no puede reembolsar):
AGENT_CLIENT_ID=tienda-a-backend AGENT_CLIENT_SECRET=dev-secret-tienda-a npm run demo:agent
```

Prueba: *"cobra 150.000 pesos por el pedido 7"*, luego *"reembólsale 50.000"*. Verás la vista previa,
la pregunta de Claude, y al confirmar, la pregunta de la terminal.
