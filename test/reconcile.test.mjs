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
    const snapshots = await db.query('SELECT count(*)::integer AS n FROM reconcile.counterpart_snapshots');
    assert.equal(snapshots.rows[0].n, 4);
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

test('contraparte externa gera achados sem apagar evidência anterior', async () => {
  const db = await createDatabase({ seed: true });
  try {
    const initial = await db.query('SELECT order_external_id, finding FROM reconcile.counterpart_variances ORDER BY order_external_id');
    assert.deepEqual(initial.rows.map(({ order_external_id, finding }) => [order_external_id, finding]), [
      ['ERP-2001', 'status_mismatch'],
      ['ERP-2099', 'missing_local'],
      ['WEB-1001', 'matched'],
      ['WEB-1002', 'amount_mismatch'],
    ]);

    await db.query(`INSERT INTO reconcile.counterpart_snapshots
      (source_id, snapshot_id, order_external_id, observed_status, observed_amount_cents, captured_at)
      SELECT id, 'snap-web-1002-corrected', 'WEB-1002', 'cancelled', 24800, now() + interval '1 minute'
      FROM reconcile.sources WHERE code = 'storefront'`);
    const corrected = await db.query(`SELECT finding, snapshot_id FROM reconcile.counterpart_variances
      WHERE order_external_id = 'WEB-1002'`);
    assert.equal(corrected.rows[0].finding, 'matched');
    assert.equal(corrected.rows[0].snapshot_id, 'snap-web-1002-corrected');

    await db.query(`INSERT INTO reconcile.variance_reviews (snapshot_id, actor, decision, reason)
      SELECT id, 'operador-teste', 'investigating', 'Conferir fonte externa'
      FROM reconcile.counterpart_snapshots WHERE snapshot_id = 'snap-erp-2001'`);
    const reviewed = await db.query(`SELECT review_actor, review_decision FROM reconcile.counterpart_variances
      WHERE order_external_id = 'ERP-2001'`);
    assert.equal(reviewed.rows[0].review_actor, 'operador-teste');
    assert.equal(reviewed.rows[0].review_decision, 'investigating');

    await assert.rejects(db.query('DELETE FROM reconcile.variance_reviews'), /append-only/);
    await assert.rejects(db.query('UPDATE reconcile.counterpart_snapshots SET observed_amount_cents = 1'), /append-only/);
    await assert.rejects(db.query(`INSERT INTO reconcile.counterpart_snapshots
      (source_id, snapshot_id, order_external_id, observed_status, observed_amount_cents)
      VALUES (1, 'snap-web-1001', 'WEB-1001', 'fulfilled', 1)`), /unique constraint/);
  } finally {
    await db.close();
  }
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
