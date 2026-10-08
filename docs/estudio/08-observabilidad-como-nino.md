# Observabilidad explicada como a un niño (y cómo quedó en el código)

> La idea de todo: **saber qué le pasa a tu sistema sin tener que entrar a mirarlo por dentro.**
> Igual que un papá sabe si su hijo está enfermo mirando el **termómetro**, leyendo lo que **escribió en
> su diario** y viendo **todo junto en la nevera** donde pega las notas.

| Pieza | Analogía de niño | Qué es en realidad | Dónde está |
|---|---|---|---|
| `/metrics` | El **termómetro** que el niño tiene siempre puesto | Números que la app va sumando | `src/core/metrics.ts` |
| **Prometheus** | La **mamá que pasa cada 5 segundos** a leer el termómetro y lo apunta en una libreta | Base de datos de números en el tiempo | `observability/prometheus/` |
| **Logs (pino)** | El **diario** donde el niño escribe todo lo que hace | Líneas JSON en la consola | `src/core/logger.ts` |
| **Alloy** | El **cartero** que recoge las hojas del diario | Lee la consola del contenedor y la manda a Loki | `observability/alloy/config.alloy` |
| **Loki** | El **archivador** donde se guardan las hojas, con etiquetas por fuera | Base de datos de logs | `docker-compose.yml` |
| **Grafana** | La **nevera** con todas las notas y gráficas pegadas | Pantalla de dashboards | `observability/grafana/` |
| **Alertas** | La **alarma** que suena si la fiebre pasa de 39 | Reglas que Prometheus revisa sola | `observability/prometheus/alerts.yml` |

---

## 1. El termómetro: `/metrics`

**Como niño:** la app tiene unos **contadores de bolsillo**. Cada vez que pasa algo, suma 1. No manda
nada a nadie: solo **guarda los números** y, si alguien le pregunta, los muestra.

**En el código** (`src/core/metrics.ts`) hay tres tipos de contador:

| Tipo | Como niño | Ejemplo en el proyecto |
|---|---|---|
| **Counter** | Un **contador de canicas** que solo sube | `payments_total{status="failed"}`: pagos que pasaron a fallidos |
| **Gauge** | Un **vaso de agua**: sube y baja | `outbox_pending_events`: eventos esperando para ir a SQS |
| **Histogram** | **Cajitas por tamaño**: "cuántas tardaron menos de 5 ms, menos de 10 ms…" | `http_request_duration_seconds`: cuánto tarda cada petición |

Si abres `http://localhost:3000/metrics` ves texto así:

```
payments_total{status="succeeded"} 12
payments_total{status="failed"} 3
http_request_duration_seconds_count{method="POST",route="/api/v1/payments/",status_code="201"} 12
mcp_tool_calls_total{tool="get_payment",outcome="domain_error"} 1
```

### ¿Cómo se conectó al código?

1. **HTTP**: `app.use(metrics.httpMiddleware())` pone un **cronómetro** al entrar cada petición y lo
   para cuando la respuesta sale (`res.on('finish')`). Lo apunta con la **ruta**, el **método** y el
   **código**.
2. **Pagos**: el `PaymentService` llama `metrics.paymentStatus(status)` **después del COMMIT**. Si la
   base de datos deshizo el cambio, no se cuenta: el tablero nunca muestra algo que no pasó.
3. **MCP**: `runTool` (el envoltorio de todas las tools) suma 1 con el resultado: `ok`,
   `domain_error` (por ejemplo "pago no encontrado") o `internal_error`.
4. **Outbox**: el relay cuenta los eventos publicados y los intentos fallidos. El vaso
   `outbox_pending_events` se llena preguntándole a Postgres **cada vez que Prometheus pasa**.

### La regla de oro: las etiquetas (*labels*) tienen pocos valores

**Como niño:** si a cada canica le haces **su propia caja**, necesitas un millón de cajas y no caben en
el cuarto. Por eso las cajas son por **color** (pocos), no por **canica** (infinitas).

- ✅ `route="/api/v1/payments/:id"`: el **molde** de la ruta, siempre el mismo.
- ❌ `route="/api/v1/payments/8f3a…"`: un valor nuevo por cada pago → Prometheus se queda sin memoria.

Hay un test que lo comprueba: `a payment id never becomes a label` (`tests/metrics.test.ts`).

### El bug que encontraron los tests (buena historia para la entrevista)

Al principio, cuando un pago no existía (404), la métrica decía `route="/:id"` en vez de
`route="/api/v1/payments/:id"`. **¿Por qué?** Cuando un handler lanza un error, Express **sale del
router** para ir al manejador de errores y, al salir, **borra el prefijo** (`req.baseUrl`). Para cuando
la respuesta termina, el prefijo ya no está.

**Arreglo:** `rememberMountPath` guarda el prefijo en `res.locals` **mientras todavía estamos dentro**.

> 💬 *"Lo descubrí porque escribí un test que pedía un pago inexistente y revisaba la etiqueta. Sin
> ese test, el dashboard habría mezclado los 404 de todas las rutas con `:id`."*

---

## 2. La mamá que pasa a mirar: Prometheus

**Como niño:** la app **no llama a nadie**. Es Prometheus el que **pasa cada 5 segundos** y pregunta
*"¿cómo vas?"* (`GET /metrics`). Apunta los números con la hora. Eso se llama modelo ***pull***.

**¿Por qué pull y no que la app mande los datos?**
- Si la app se cae, Prometheus **se da cuenta solo**: ya no le contesta (la métrica `up` pasa a 0).
- La app no necesita saber dónde está Prometheus.

**En el proyecto** (`observability/prometheus/prometheus.yml`) mira dos lugares: el contenedor `app` y
tu máquina (`host.docker.internal:3000`), por si corres `npm run dev`. En Kubernetes esa lista fija se
cambia por **descubrimiento automático** de pods.

### Cómo se le hacen preguntas: PromQL

```promql
# ¿Cuántas peticiones por segundo? (R de RED)
sum(rate(http_request_duration_seconds_count[1m]))
```
**Como niño:** `rate(...[1m])` es *"¿cuántas canicas nuevas cayeron por segundo en el último minuto?"*.
`sum` junta todas las cajas en una.

```promql
# ¿Qué porcentaje falla? (E de RED)
100 * sum(rate(http_request_duration_seconds_count{status_code=~"5.."}[5m]))
    / sum(rate(http_request_duration_seconds_count[5m]))
```
Canicas rojas divididas entre todas las canicas.

```promql
# ¿Cuánto tarda el 5 % más lento? (D de RED)
histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))
```
**Como niño:** de 100 niños en la fila, ¿cuánto esperó el **número 95**? Eso es el **p95**. El promedio
esconde a los que esperaron mucho; el p95 los muestra.

> 💡 No hizo falta un contador aparte `http_requests_total`: el histograma ya trae `_count`, que **es**
> ese contador.

---

## 3. La alarma: las alertas

**Como niño:** la mamá no mira la libreta todo el día. Pone **una regla**: *"si la fiebre pasa de 39 por
más de 5 minutos, que suene la alarma"*. El "por más de 5 minutos" (`for: 5m`) evita que suene por un
estornudo.

`observability/prometheus/alerts.yml` tiene tres:

| Alerta | Cuándo suena | Por qué importa |
|---|---|---|
| `PaymentsHighErrorRate` | Más del 5 % de respuestas son 5xx durante 5 min | Algo está roto de nuestro lado |
| `PaymentsHighLatencyP95` | El p95 pasa de 1 s durante 10 min | Probablemente el procesador está lento |
| `OutboxBacklog` | Más de 100 eventos esperando durante 5 min | SQS caído o el relay apagado: los pagos funcionan pero los avisos no salen |

---

## 4. El diario: los logs

**Como niño:** el niño escribe en su diario **cada cosa que hace**, una línea por cosa, siempre con el
mismo formato. Así cualquiera lo puede leer rápido.

Una línea de log del proyecto:

```json
{"level":"warn","time":"2026-10-08T00:48:28.057Z","service":"payments-mcp","requestId":"r1","msg":"charge outcome unknown, left pending for reconciliation"}
```

- **JSON**: las máquinas lo leen sin adivinar.
- **`requestId`**: el **número de guía del paquete**. Con él sigues una petición de principio a fin:
  logs, eventos de SQS (sí, también va en el evento) y la respuesta (`X-Request-Id`).
- **`level` como texto** (`"warn"`): antes pino escribía `40`. Se cambió para que en Loki puedas
  filtrar `level="error"` sin aprenderte números.
- **Sin secretos**: `authorization` y `cookie` se borran (`redact`).

**La app no sabe que Loki existe.** Solo escribe en la consola (stdout). Eso es lo correcto en
contenedores: la app escribe y la plataforma recoge.

---

## 5. El cartero y el archivador: Alloy y Loki

**Como niño:** el **cartero (Alloy)** pasa por la puerta del contenedor `app`, recoge las hojas del
diario y las lleva al **archivador (Loki)**. A cada hoja le pega **dos etiquetas por fuera**:
`app="payments-mcp"` y `level="warn"`.

**¿Por qué no le pega también el `requestId` como etiqueta?** Por la misma regla de las canicas:
habría un cajón por cada petición. Loki es barato justamente porque **tiene pocos cajones** y solo
abre las hojas cuando buscas algo:

```logql
{app="payments-mcp", level="error"}                          # abre solo el cajón de errores
{app="payments-mcp"} | json | requestId="rest-trace-1"       # y aquí lee las hojas buscando ese id
```

> Alloy es el reemplazo de **Promtail**, que Grafana ya dejó de mantener.

---

## 6. La nevera: Grafana

**Como niño:** la nevera donde la familia pega **todo junto**: la gráfica de la fiebre, la libreta de
la mamá y las hojas del diario.

Grafana arranca **ya configurado** (eso se llama *provisioning*): sabe dónde están Prometheus y Loki
(`provisioning/datasources/`) y carga el dashboard `payments-mcp` (`dashboards/payments-mcp.json`):

```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ Requests / s │ % de 5xx     │ p95          │ Outbox       │   ← los 4 números grandes
├──────────────┴──────┬───────┴──────────────┴──────────────┤
│ Requests por ruta   │ Latencia p95/p99 por ruta           │
├─────────────────────┼─────────────────────────────────────┤
│ Pagos por estado    │ Tools MCP por resultado             │
├─────────────────────┴─────────────────────────────────────┤
│ Outbox: publicados vs errores                             │
├───────────────────────────────────────────────────────────┤
│ Logs  [caja requestId: ______]  [level: warn, error]      │
└───────────────────────────────────────────────────────────┘
```

Escribes un `requestId` en la caja de arriba y los logs muestran **solo esa petición**.

---

## 7. La lonchera: el Dockerfile

Para que el cartero pueda recoger el diario, la app tiene que vivir en un **contenedor**. El
`Dockerfile` tiene **dos etapas**:

1. **La cocina** (`node:22-slim`): instala todo, compila TypeScript y luego **bota lo que no se come**
   (`npm prune --omit=dev`).
2. **La lonchera** (`node:22-alpine`): solo lleva el JS compilado, las dependencias de producción y las
   migraciones. Nada de compilador ni tests. Más pequeña y con menos cosas que atacar.

Además corre como el usuario `node`, **nunca como root**.

---

## 8. Cómo verlo funcionando

```bash
npm run obs:up       # Postgres, LocalStack, la app, Prometheus, Loki, Alloy y Grafana
```

| Qué | Dónde |
|---|---|
| La app | http://localhost:3000 (docs en `/docs`, números en `/metrics`) |
| Grafana | http://localhost:3001 → dashboard **payments-mcp** |
| Prometheus | http://localhost:9090 (pestaña *Alerts* para ver las alarmas) |

Crea unos pagos con `api.http` (prueba montos terminados en `13` → rechazado y en `99` → timeout) y
mira cómo se mueven las gráficas. Para apagar todo: `npm run obs:down`.

---

## 9. Preguntas probables (respuesta corta: qué → por qué → ejemplo)

**¿Qué métricas pusiste?**
> "RED por ruta: requests por segundo, porcentaje de errores y latencia p95/p99, con un solo
> histograma. Además métricas de negocio: pagos por estado y llamadas MCP por tool y resultado. Y el
> backlog del outbox, porque si crece, los webhooks no están saliendo aunque los pagos funcionen."

**¿Qué es la cardinalidad y cómo la cuidaste?**
> "Cada combinación de etiquetas es una serie nueva en memoria. Uso el patrón de la ruta y no la URL,
> y el `requestId` nunca va como etiqueta, ni en Prometheus ni en Loki. Tengo un test que verifica
> que un id de pago no aparezca en `/metrics`."

**¿Pull o push?**
> "Prometheus es pull: él visita `/metrics`. La ventaja es que detecta solo si un pod se cae, y la app
> no necesita saber dónde está Prometheus."

**¿Cómo llegan los logs a Loki?**
> "La app solo escribe JSON en stdout. Alloy lee el stdout del contenedor y lo manda a Loki. En
> Kubernetes, Alloy corre como DaemonSet, uno por nodo."

**¿Por qué cuentas los pagos después del COMMIT?**
> "Si cuento antes y la transacción se deshace, el dashboard muestra un pago que no existe."

**¿Cómo investigas un incidente?**
> "Suena la alerta de errores → en Grafana veo qué ruta y desde cuándo → en el panel de logs filtro
> `level=error` → tomo un `requestId` y veo toda la historia de esa petición, incluso el evento
> que mandó a SQS."

**¿`/metrics` es público?**
> "No debería. En EKS lo dejo en la red interna, con NetworkPolicy o en un puerto aparte, fuera del
> Ingress."
