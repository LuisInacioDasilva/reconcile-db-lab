import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, rollbackDatabase, seedDatabase } from '../src/db.mjs';

test('reconciliação preserva idempotência, integridade e auditoria', async (t) => {
  const db = await createDatabase({ seed: true });
  t.after(() => db.close());

  await t.test('seed repetido não duplica pedidos ou eventos', async () => {
    await seedDatabase(db);
    const { rows } = await db.query('SELECT count(*)::integer AS n FROM reconcile.inbox_events');
    assert.equal(rows[0].n, 5);
    const orders = await db.query('SELECT count(*)::integer AS n FROM reconcile.orders');
    assert.equal(orders.rows[0].n, 4);
  });

  await t.test('mesmo ID e mesmo payload é replay sem nova transição', async () => {
    const { rows } = await db.query(
      'SELECT * FROM reconcile.ingest_event($1,$2,$3,$4,$5::jsonb)',
      ['storefront', 'ev-1001-approved', 'WEB-1001', 'approved', '{"channel":"web"}'],
    );
    assert.equal(rows[0].disposition, 'duplicate');
    assert.equal(rows[0].order_status, 'fulfilled');
    const transitions = await db.query('SELECT count(*)::integer AS n FROM reconcile.transitions');
    assert.equal(transitions.rows[0].n, 5);
  });

  await t.test('mesmo ID com payload diferente não é aceito', async () => {
    await assert.rejects(
      db.query('SELECT * FROM reconcile.ingest_event($1,$2,$3,$4,$5::jsonb)',
        ['storefront', 'ev-1001-approved', 'WEB-1001', 'approved', '{"channel":"other"}']),
      /event ID reused with different content/,
    );
  });

  await t.test('evento fora da ordem é auditado, sem alterar pedido', async () => {
    const { rows } = await db.query(`SELECT status, version, rejected_transitions
      FROM reconcile.order_snapshot WHERE external_id = 'ERP-2001'`);
    assert.equal(rows[0].status, 'approved');
    assert.equal(rows[0].version, 2);
    assert.equal(Number(rows[0].rejected_transitions), 1);
  });

  await t.test('restrições físicas e trilha imutável resistem a escrita direta', async () => {
    await assert.rejects(db.query(`INSERT INTO reconcile.orders
      (source_id, external_id, customer_name, amount_cents)
      VALUES (1, 'INVALID', 'Ninguém', -1)`), /check constraint/);
    await assert.rejects(db.query('DELETE FROM reconcile.transitions'), /append-only/);
    await assert.rejects(db.query('UPDATE reconcile.inbox_events SET event_type = event_type'), /append-only/);
  });

  await t.test('visão de saúde reconcilia entradas e resultados', async () => {
    const { rows } = await db.query('SELECT * FROM reconcile.source_health ORDER BY source');
    assert.equal(rows.length, 2);
    assert.equal(rows.reduce((sum, row) => sum + Number(row.received_events), 0), 5);
    assert.equal(rows.reduce((sum, row) => sum + Number(row.rejected_events), 0), 1);
  });

  await t.test('integridade detecta alteração direta sem evento de auditoria', async () => {
    const healthy = await db.query('SELECT count(*)::integer AS n FROM reconcile.order_integrity WHERE NOT consistent');
    assert.equal(healthy.rows[0].n, 0);
    await db.query("UPDATE reconcile.orders SET version = version + 1 WHERE external_id = 'WEB-1001'");
    const drift = await db.query("SELECT * FROM reconcile.order_integrity WHERE external_id = 'WEB-1001'");
    assert.equal(drift.rows[0].consistent, false);
    assert.equal(drift.rows[0].expected_status, 'fulfilled');
  });
});

test('migration tem rollback verificável em base descartável', async () => {
  const db = await createDatabase();
  try {
    await rollbackDatabase(db);
    const { rows } = await db.query("SELECT to_regnamespace('reconcile') AS namespace");
    assert.equal(rows[0].namespace, null);
  } finally {
    await db.close();
  }
});
