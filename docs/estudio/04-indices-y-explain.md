# Guía de estudio: índices, EXPLAIN ANALYZE y paginación por cursor

> Todo lo de esta guía se puede reproducir: `npm run demo:explain` (Postgres real vía PGlite, sin Docker).
> Las cifras son de una corrida con 300.000 pagos (100.000 de `tienda_A`). Tus tiempos variarán; las
> **proporciones** y las **páginas leídas** (`Buffers`) deberían ser muy parecidas.

---

## 1. ¿Qué es un índice?

Una tabla en Postgres es un montón de filas **sin orden garantizado**. Para encontrar "los pagos de
`tienda_A`" sin índice, Postgres tiene que leer **todas** las filas y quedarse con las que sirven
(*Seq Scan*).

Un **índice B-tree** es una copia **ordenada** de una o varias columnas, con un puntero a la fila real.
Es como el directorio telefónico: está ordenado por apellido, así que vas directo a la "M" sin leer
desde la "A".

```
Índice (merchant_id, created_at, id)          Tabla payments (desordenada)
─────────────────────────────────────         ──────────────────────────
tienda_A | 2026-01-01 00:00:03 | 4f2a  ──────▶ fila 81.233
tienda_A | 2026-01-01 00:00:06 | 91bc  ──────▶ fila 7
   ... 100.000 entradas, ya ordenadas ...
tienda_A | 2026-01-04 11:19:57 | 7d01  ──────▶ fila 299.998
tienda_B | 2026-01-01 00:00:01 | ...
```

Buscar en un B-tree cuesta **O(log n)**: con 1 millón de filas son ~3–4 saltos; con 1.000 millones, ~5–6.

---

## 2. EXPLAIN vs EXPLAIN ANALYZE

| Comando | Qué hace |
|---|---|
| `EXPLAIN <query>` | Muestra el plan **estimado**. **No** ejecuta la query. |
| `EXPLAIN ANALYZE <query>` | **Ejecuta** la query y muestra el plan con tiempos y filas **reales**. |
| `EXPLAIN (ANALYZE, BUFFERS) <query>` | Además muestra cuántas páginas de 8 KB leyó. La mejor medida del trabajo. |

> ⚠️ `EXPLAIN ANALYZE` **ejecuta de verdad**. Con un `UPDATE` o `DELETE`, modifica datos. Para analizarlos sin
> efectos: `BEGIN; EXPLAIN ANALYZE UPDATE ...; ROLLBACK;`

> 💡 Si el `rows` **estimado** (sin ANALYZE) es muy distinto del **real**, las estadísticas están
> desactualizadas → `ANALYZE payments;`. Postgres elige planes según esas estadísticas.

---

## 3. Cómo leer un plan

**Regla #1: se lee de adentro hacia afuera** (de la línea más indentada hacia arriba). Cada `->` es un
paso que le entrega filas al paso de arriba.

```
Limit  rows=21                                  ← 4. se queda con 21
  -> Sort  (Sort Key: created_at DESC, id DESC) ← 3. ordena
       -> Seq Scan on payments  rows=100000     ← 1. lee toda la tabla
            Filter: (merchant_id = 'tienda_A')  ← 2. filtra
            Rows Removed by Filter: 200000
```

### Nodos más comunes

| Nodo | Qué significa | ¿Bueno o malo? |
|---|---|---|
| `Seq Scan` | Lee **toda** la tabla | 🚩 en tablas grandes cuando buscas pocas filas. ✅ si necesitas casi toda la tabla |
| `Index Scan` | Usa el índice y luego va a la tabla por cada fila | ✅ para pocas filas |
| `Index Scan Backward` | Igual, pero recorre el índice al revés (para `DESC`) | ✅ |
| `Index Only Scan` | Todo lo que pide la query está **en el índice**; casi no toca la tabla | ✅✅ |
| `Bitmap Index Scan` + `Bitmap Heap Scan` | Junta muchos punteros del índice y luego lee la tabla en orden | ✅ para cantidades "medianas" |
| `Sort` | Ordena en memoria (o en disco si no cabe: `external merge`) | 🚩 si ordena muchas filas |
| `Incremental Sort` | Los datos ya vienen **parcialmente** ordenados y solo ordena los empates | 🟡 aceptable |
| `Limit` | Corta en N filas | — |
| `Aggregate` | `count`, `sum`, etc. | — |
| `Nested Loop` / `Hash Join` / `Merge Join` | Formas de hacer JOIN | (tema aparte) |

### Campos a mirar

| Campo | Significado |
|---|---|
| `actual time=0.010..0.017` | ms hasta la **primera** fila .. ms hasta la **última** |
| `rows=21` | Filas que **salieron** de ese paso |
| `loops=1` | Cuántas veces se ejecutó el paso (en JOINs puede ser > 1: multiplica) |
| `Rows Removed by Filter` | Filas leídas **para nada**. Alto = 🚩 falta un índice o no se está usando |
| `Buffers: shared hit=5` | Páginas de 8 KB leídas desde la caché (`read=` serían desde disco) |
| `Index Cond` | Condición que se resolvió **dentro** del índice ✅ |
| `Filter` | Condición que se aplicó **después** de leer la fila (más costoso) |
| `Heap Fetches` | En un Index Only Scan, cuántas veces igual tuvo que ir a la tabla |
| `Index Searches` | (Postgres 18) cuántos descensos al B-tree hizo |
| `Execution Time` | Tiempo total |

**Qué buscar primero:** `Seq Scan` en tabla grande → `Rows Removed by Filter` alto → `Sort` sobre muchas
filas → `Buffers` alto comparado con las filas devueltas.

---

## 4. Índices compuestos: las reglas

Un índice compuesto `(a, b, c)` está ordenado por `a`, luego por `b` dentro de cada `a`, luego por `c`.
Como el directorio: apellido → nombre → segundo nombre.

### Regla 1: prefijo izquierdo

El índice `(a, b, c)` sirve para:
- `WHERE a = ?` ✅
- `WHERE a = ? AND b = ?` ✅
- `WHERE a = ? AND b = ? AND c = ?` ✅
- `WHERE b = ?` ❌ (en general) — es como buscar por **nombre** en un directorio ordenado por **apellido**.

> Postgres 18 añadió *skip scan*, que a veces puede usar el índice sin la primera columna si esta tiene
> pocos valores distintos. No cuentes con eso al diseñar: en nuestro ejercicio A (abajo) no lo usó.

### Regla 2: Igualdad → Orden → Rango

Pon primero las columnas que se comparan con `=`, después las del `ORDER BY`, y el rango (`<`, `>`,
`BETWEEN`) sobre las columnas de orden.

Nuestra query del listado:
```sql
WHERE merchant_id = $1                     -- igualdad
  AND (created_at, id) < ($2, $3)          -- rango (sobre las mismas columnas del orden)
ORDER BY created_at DESC, id DESC          -- orden
```
→ índice `(merchant_id, created_at, id)`. Con filtro de estado: `(merchant_id, status, created_at, id)`
(dos igualdades, luego el orden).

### Regla 3: la dirección

Un B-tree se puede recorrer **en ambas direcciones**. Por eso el índice ASC sirve para
`ORDER BY created_at DESC, id DESC` (`Index Scan Backward`). Lo que **no** sirve completo es mezclar
direcciones: `ORDER BY created_at DESC, id ASC` → `Incremental Sort` (ver ejercicio F). Si necesitaras
esa mezcla con frecuencia, crearías el índice `(merchant_id, created_at DESC, id ASC)`.

### Regla 4: no envuelvas la columna en una función

`WHERE lower(merchant_id) = 'tienda_a'` **no** puede usar el índice de `merchant_id`: el índice tiene
los valores originales, no los de `lower(...)`. Ver ejercicio E (110 ms, Seq Scan).

Soluciones: guardar el dato ya normalizado, o crear un **índice de expresión**:
`CREATE INDEX ON payments (lower(merchant_id));`

Lo mismo con fechas: en vez de `WHERE date(created_at) = '2026-01-02'` usa un rango que sí aprovecha el
índice: `WHERE created_at >= '2026-01-02' AND created_at < '2026-01-03'`.

### Regla 5: selectividad — si vas a leer media tabla, el índice no ayuda

Un índice es útil cuando filtras una **porción pequeña** de la tabla. `SELECT count(*) WHERE merchant_id
= 'tienda_A'` necesita contar 1/3 de la tabla, y Postgres eligió **Seq Scan** aunque existe el índice
(ejercicio C): leer la tabla de corrido es más barato que saltar 100.000 veces. **El planificador
decide; tu trabajo es darle buenas opciones y verificar con EXPLAIN.**

---

## 5. Nuestros resultados

| # | Experimento | Plan | Páginas | Tiempo |
|---|---|---|---|---|
| 1 | Página 1, **sin** índice | Seq Scan + Sort, 200.000 filas descartadas | 4.286 | 65 ms |
| 2 | Página 1, **con** índice | Index Scan Backward | **5** | **0,036 ms** |
| 3a | Página profunda con `OFFSET 90000` | Index Scan Backward, pero lee **90.021** filas | 4.505 | 34 ms |
| 3b | La misma página con **cursor** | Index Scan Backward, lee 21 filas | **5** | **0,065 ms** |
| 4 | Filtro por `status` | Usa `payments_merchant_status_created_idx` | 8 | 0,06 ms |

Conclusiones:
- El índice correcto convirtió **65 ms → 0,036 ms** (~1.800×) y **4.286 → 5 páginas**.
- Tener índice **no basta** si paginas con `OFFSET`: el 3a usa el índice y aun así tarda 34 ms.
- Con cursor, la página 1 y la página 4.500 **cuestan lo mismo**.

---

## 6. OFFSET vs cursor (keyset pagination)

### Por qué OFFSET es lento
`OFFSET 90000 LIMIT 21` = "lee 90.000 filas, **descártalas**, dame 21". El índice no sabe "qué fila está
en la posición 90.000"; tiene que contar. Costo **O(offset)**: crece con cada página.

### Cómo funciona el cursor
En lugar de "sáltate N", se dice "**dame los que vienen después de este registro**":
```sql
WHERE merchant_id = $1 AND (created_at, id) < ($2, $3)  -- $2,$3 = fecha e id del último de la página anterior
ORDER BY created_at DESC, id DESC
LIMIT 21
```
Como el índice está ordenado, Postgres **salta directo** a ese punto (`Index Cond: ... ROW(created_at, id) < ROW(...)`).

En nuestro código: `nextCursor = base64url("2026-10-04T03:52:53.386Z|2f210651-...")`. El cliente lo
trata como caja negra (opaco).

### Comparación

| | OFFSET | Cursor |
|---|---|---|
| Costo de una página profunda | O(n) | O(log n) |
| Inserciones mientras paginas | Repite o salta filas | Estable |
| Saltar a "página 37" | Sí | No (solo siguiente/anterior) |
| Total de páginas | Requiere `COUNT(*)` (costoso) | No se calcula |

### Tres detalles que lo hacen correcto
1. **Desempate con `id`**: varias filas pueden tener la misma `created_at`. Con solo la fecha, se
   saltarían filas empatadas. `(created_at, id)` es único → orden total.
2. **Precisión de la fecha**: Postgres guarda microsegundos; JavaScript `Date`, milisegundos. Si la BD
   asignara `now()`, el cursor recortaría `.123456` a `.123` y se **saltarían filas** en silencio. Por eso
   la app asigna `created_at`.
3. **`limit + 1`**: se piden 21 filas para mostrar 20. Si llegan 21, hay otra página. Evita `COUNT(*)`.

### Query dinámica vs `($2 IS NULL OR status = $2)`
Con el atajo `IS NULL OR`, Postgres puede reutilizar un plan genérico que no sabe si habrá filtro, y
elegir mal. Armando la query según los filtros presentes, cada forma usa **su** índice (experimento 4).

---

## 7. Los índices no son gratis

- Cada `INSERT`/`UPDATE`/`DELETE` actualiza **todos** los índices de la tabla → escrituras más lentas.
- Ocupan disco y memoria (compiten por la caché con los datos).
- Índices sin uso son puro costo. Para encontrarlos: `SELECT * FROM pg_stat_user_indexes WHERE idx_scan = 0;`

**Regla:** crea índices para las **queries que realmente ejecutas**, verifica con EXPLAIN y no indexes
"por si acaso".

---

## 8. Ejercicios

Pega cada query en la zona de ejercicios de `scripts/explain-demo.mjs`:
`await explain('Mi experimento', \`SELECT ...\`);` y corre `npm run demo:explain`.

**Primero predice** qué plan saldrá y por qué; luego compara con la respuesta.

**A.** `SELECT id FROM payments WHERE status = 'failed' ORDER BY created_at DESC LIMIT 21`
<details><summary>Respuesta</summary>

Seq Scan + Sort, 240.000 filas descartadas, ~47 ms. Ningún índice empieza por `status` (regla 1: prefijo
izquierdo). El índice `(merchant_id, status, ...)` no sirve sin `merchant_id`.
</details>

**B.** `SELECT id FROM payments WHERE created_at > '2026-01-03' ORDER BY created_at LIMIT 21`
<details><summary>Respuesta</summary>

Seq Scan + Sort, ~63 ms. `created_at` es la **segunda** columna del índice; sin `merchant_id` no hay
prefijo. Si esta query fuera frecuente (p. ej. un reporte global), necesitaría su propio índice en `(created_at)`.
</details>

**C.** `SELECT count(*) FROM payments WHERE merchant_id = 'tienda_A'`
<details><summary>Respuesta</summary>

**Seq Scan aunque existe el índice**, ~45 ms. Hay que contar 100.000 filas (1/3 de la tabla) y leer la
tabla de corrido es más barato que 100.000 saltos (regla 5: selectividad). Por eso no hacemos `COUNT(*)`
en la paginación.
</details>

**D.** `SELECT id FROM payments WHERE merchant_id = 'tienda_A' AND date(created_at) = '2026-01-02' LIMIT 21`
<details><summary>Respuesta</summary>

Seq Scan con `Filter: date(created_at) = ...`: la función impide usar el índice para la fecha (regla 4).
Puede salir rápido por "suerte" (encuentra 21 coincidencias pronto y el `LIMIT` corta), pero el costo
depende de dónde estén los datos. **Ejercicio extra:** reescríbela con un rango
(`created_at >= '2026-01-02' AND created_at < '2026-01-03'`) y compara el plan.
</details>

**E.** `SELECT id FROM payments WHERE lower(merchant_id) = 'tienda_a' ORDER BY created_at DESC LIMIT 21`
<details><summary>Respuesta</summary>

Seq Scan + Sort, **~110 ms** (el peor de todos: además calcula `lower()` 300.000 veces). Regla 4.
**Ejercicio extra:** agrega `await db.exec("CREATE INDEX ON payments (lower(merchant_id), created_at)")`
antes y vuelve a correrla.
</details>

**F.** `SELECT id FROM payments WHERE merchant_id = 'tienda_A' ORDER BY created_at DESC, id ASC LIMIT 21`
<details><summary>Respuesta</summary>

`Index Only Scan Backward` + **`Incremental Sort`** (`Presorted Key: created_at`). El índice entrega los
datos ordenados por fecha, pero `id ASC` va en dirección contraria; Postgres solo reordena los empates.
Sigue siendo rápido (~0,05 ms) porque hay pocos empates (regla 3).
</details>

**G.** `SELECT created_at, id FROM payments WHERE merchant_id = 'tienda_A' ORDER BY created_at DESC, id DESC LIMIT 21`
<details><summary>Respuesta</summary>

**`Index Only Scan`**: todas las columnas pedidas están en el índice, no necesita ir a la tabla.
Verás `Heap Fetches: 21` porque la tabla es recién creada y Postgres aún no marcó las páginas como
"visibles para todos" (eso lo hace `VACUUM`). Tras un `VACUUM payments`, `Heap Fetches` baja a 0.
Pregunta para pensar: ¿por qué `SELECT *` no puede ser Index Only Scan?
</details>

**H. (Reto)** Corre `ROWS=1000000 npm run demo:explain`. ¿Qué tiempos cambian mucho y cuáles casi nada? ¿Por qué?

---

## 9. Preguntas de entrevista

**"Un endpoint de listado se volvió lento a medida que creció la tabla. ¿Cómo lo diagnosticas?"**
> Corro `EXPLAIN (ANALYZE, BUFFERS)` con la query real. Busco `Seq Scan` en una tabla grande, `Rows
> Removed by Filter` alto o un `Sort` sobre muchas filas. Creo un índice compuesto que siga la query:
> columnas de igualdad del `WHERE` primero y luego las del `ORDER BY`, para que Postgres lea las filas ya
> ordenadas y se detenga en el `LIMIT`. Si pagina con `OFFSET`, lo cambio por cursor sobre
> `(created_at, id)`. En una prueba con 300 mil filas bajé la primera página de 65 ms a 0,04 ms y una
> página profunda de 34 ms a 0,06 ms.

**"¿Por qué no poner índice en todas las columnas?"**
> Porque cada escritura actualiza todos los índices y ocupan memoria. Indexo según las queries reales y
> reviso `pg_stat_user_indexes` para eliminar los que no se usan.

**"¿Qué diferencia hay entre `EXPLAIN` y `EXPLAIN ANALYZE`?"**
> `EXPLAIN` muestra el plan estimado sin ejecutar; `ANALYZE` ejecuta y da tiempos y filas reales. Si
> estimado y real difieren mucho, corro `ANALYZE` en la tabla para actualizar estadísticas. Con
> `UPDATE`/`DELETE` lo envuelvo en `BEGIN … ROLLBACK`.

**"¿Por qué existe el índice y Postgres no lo usa?"**
> Puede ser: la query no usa el prefijo izquierdo; hay una función sobre la columna; el tipo no coincide
> (comparar texto con número); o la condición devuelve una parte grande de la tabla y el Seq Scan es más
> barato. También estadísticas desactualizadas.

**"¿OFFSET o cursor?"**
> Cursor para APIs y feeds: costo constante y estable ante inserciones. OFFSET solo si necesito saltar a
> una página arbitraria en tablas pequeñas, como un panel administrativo.

---

## 10. Para profundizar

- Documentación oficial: *Using EXPLAIN* — https://www.postgresql.org/docs/current/using-explain.html
- *Use The Index, Luke* (libro gratuito sobre índices SQL) — https://use-the-index-luke.com
- Visualizador de planes: pega la salida de EXPLAIN en https://explain.dalibo.com
- En el código: `src/features/payments/pg-payment.repository.ts` (`list`), `db/migrations/001_init.sql`.
