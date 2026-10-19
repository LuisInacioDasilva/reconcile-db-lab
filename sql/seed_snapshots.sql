INSERT INTO reconcile.counterpart_snapshots
    (source_id, snapshot_id, order_external_id, observed_status, observed_amount_cents)
SELECT s.id, v.snapshot_id, v.order_external_id, v.observed_status, v.observed_amount_cents
FROM reconcile.sources s
JOIN (VALUES
    ('storefront', 'snap-web-1001', 'WEB-1001', 'fulfilled', 12990::bigint),
    ('storefront', 'snap-web-1002', 'WEB-1002', 'cancelled', 25000::bigint),
    ('erp', 'snap-erp-2001', 'ERP-2001', 'fulfilled', 7850::bigint),
    ('erp', 'snap-erp-2099', 'ERP-2099', 'approved', 5000::bigint)
) AS v(source, snapshot_id, order_external_id, observed_status, observed_amount_cents)
ON v.source = s.code
ON CONFLICT (source_id, snapshot_id) DO NOTHING;
