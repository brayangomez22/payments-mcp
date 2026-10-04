// Laboratorio de EXPLAIN ANALYZE: índices compuestos y paginación OFFSET vs cursor.
// Corre Postgres real (PGlite, compilado a WebAssembly) en memoria: no necesita Docker.
//
//   npm run demo:explain              → 300.000 pagos (por defecto)
//   ROWS=1000000 npm run demo:explain → prueba con más filas y compara cómo cambian los tiempos
//
// Guía de estudio: docs/estudio/04-indices-y-explain.md
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const ROWS = Number(process.env.ROWS ?? 300_000);
const db = new PGlite();

console.log(`Cargando la migración real y ${ROWS.toLocaleString('es-CO')} pagos de 3 tiendas...`);
await db.exec(readFileSync(new URL('../db/migrations/001_init.sql', import.meta.url), 'utf8'));
await db.exec(`
  INSERT INTO payments (id, merchant_id, amount_minor, currency, status, created_at, updated_at)
  SELECT gen_random_uuid(),
         (ARRAY['tienda_A','tienda_B','tienda_C'])[1 + i % 3],
         1000 + (i % 500) * 100, 'COP',
         (ARRAY['succeeded','succeeded','succeeded','failed','refunded'])[1 + i % 5],
         ts, ts
  FROM generate_series(1, ${ROWS}) AS i,
       LATERAL (SELECT timestamptz '2026-01-01' + i * interval '1 second' AS ts) t;
  ANALYZE payments;
`);

const COLS = 'id, amount_minor, status, created_at';
const DEEP = Math.floor((ROWS / 3) * 0.9); // ~90 % del recorrido de tienda_A

async function explain(title, sql, params = []) {
  let plan = [];
  // Se ejecuta 3 veces y se muestra la última: así la caché está "caliente" y la comparación es justa.
  for (let i = 0; i < 3; i++) {
    plan = (await db.query(`EXPLAIN (ANALYZE, COSTS OFF, SUMMARY ON) ${sql}`, params)).rows.map((r) => r['QUERY PLAN']);
  }
  console.log(`\n───── ${title} ─────`);
  console.log(sql.replace(/\s+/g, ' ').trim());
  console.log(plan.filter((l) => !/Planning Time/.test(l)).map((l) => '  ' + l).join('\n'));
}

const page1 = `SELECT ${COLS} FROM payments WHERE merchant_id = 'tienda_A' ORDER BY created_at DESC, id DESC LIMIT 21`;

await db.exec('DROP INDEX payments_merchant_created_idx; DROP INDEX payments_merchant_status_created_idx;');
await explain('1. Primera página SIN índice', page1);

await db.exec(`
  CREATE INDEX payments_merchant_created_idx ON payments (merchant_id, created_at, id);
  CREATE INDEX payments_merchant_status_created_idx ON payments (merchant_id, status, created_at, id);
  ANALYZE payments;
`);
await explain('2. Primera página CON índice', page1);

await explain(
  `3a. Página profunda con OFFSET (se salta ${DEEP.toLocaleString('es-CO')} filas)`,
  `SELECT ${COLS} FROM payments WHERE merchant_id = 'tienda_A' ORDER BY created_at DESC, id DESC OFFSET ${DEEP} LIMIT 21`,
);
const { rows } = await db.query(
  `SELECT created_at, id FROM payments WHERE merchant_id = 'tienda_A'
   ORDER BY created_at DESC, id DESC OFFSET ${DEEP - 1} LIMIT 1`,
);
await explain(
  '3b. La MISMA página con cursor (keyset)',
  `SELECT ${COLS} FROM payments WHERE merchant_id = 'tienda_A' AND (created_at, id) < ($1, $2)
   ORDER BY created_at DESC, id DESC LIMIT 21`,
  [rows[0].created_at, rows[0].id],
);

await explain(
  '4. Filtro por estado (usa el segundo índice)',
  `SELECT ${COLS} FROM payments WHERE merchant_id = 'tienda_A' AND status = 'failed'
   ORDER BY created_at DESC, id DESC LIMIT 21`,
);

// ── Zona de ejercicios: agrega aquí tus propias queries (ver la guía, sección 8) ──
// await explain('Mi experimento', `SELECT ...`);
