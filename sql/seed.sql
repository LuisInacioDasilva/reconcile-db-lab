INSERT INTO reconcile.sources (code) VALUES ('storefront'), ('erp')
ON CONFLICT (code) DO NOTHING;

INSERT INTO reconcile.orders (source_id, external_id, customer_name, amount_cents)
SELECT s.id, v.external_id, v.customer_name, v.amount_cents
FROM reconcile.sources s
JOIN (VALUES
    ('storefront', 'WEB-1001', 'Ana Lima', 12990::bigint),
    ('storefront', 'WEB-1002', 'Bruno Reis', 24800::bigint),
    ('erp', 'ERP-2001', 'Camila Costa', 7850::bigint),
    ('erp', 'ERP-2002', 'Daniel Rocha', 46000::bigint)
) AS v(source, external_id, customer_name, amount_cents) ON v.source = s.code
ON CONFLICT (source_id, external_id) DO NOTHING;

SELECT * FROM reconcile.ingest_event('storefront', 'ev-1001-approved', 'WEB-1001', 'approved', '{"channel":"web"}');
SELECT * FROM reconcile.ingest_event('storefront', 'ev-1001-fulfilled', 'WEB-1001', 'fulfilled', '{"channel":"web"}');
SELECT * FROM reconcile.ingest_event('storefront', 'ev-1002-cancelled', 'WEB-1002', 'cancelled', '{"channel":"web"}');
SELECT * FROM reconcile.ingest_event('erp', 'ev-2001-fulfilled-too-early', 'ERP-2001', 'fulfilled', '{"reason":"out_of_order"}');
SELECT * FROM reconcile.ingest_event('erp', 'ev-2001-approved', 'ERP-2001', 'approved', '{"channel":"erp"}');
