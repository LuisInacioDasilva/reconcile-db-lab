CREATE TABLE reconcile.counterpart_snapshots (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id integer NOT NULL REFERENCES reconcile.sources(id),
    snapshot_id text NOT NULL,
    order_external_id text NOT NULL,
    observed_status text NOT NULL CHECK (observed_status IN ('pending', 'approved', 'fulfilled', 'cancelled')),
    observed_amount_cents bigint NOT NULL CHECK (observed_amount_cents >= 0),
    captured_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_id, snapshot_id),
    CONSTRAINT snapshot_id_not_blank CHECK (btrim(snapshot_id) <> ''),
    CONSTRAINT snapshot_order_not_blank CHECK (btrim(order_external_id) <> '')
);

CREATE INDEX counterpart_snapshots_latest_idx
ON reconcile.counterpart_snapshots (source_id, order_external_id, captured_at DESC, id DESC);

CREATE TRIGGER counterpart_snapshots_append_only
BEFORE UPDATE OR DELETE ON reconcile.counterpart_snapshots
FOR EACH ROW EXECUTE FUNCTION reconcile.reject_audit_changes();

CREATE TABLE reconcile.variance_reviews (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    snapshot_id bigint NOT NULL REFERENCES reconcile.counterpart_snapshots(id),
    actor text NOT NULL CHECK (btrim(actor) <> ''),
    decision text NOT NULL CHECK (decision IN ('investigating', 'escalated', 'resolved_externally')),
    reason text NOT NULL CHECK (btrim(reason) <> ''),
    recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX variance_reviews_snapshot_time_idx
ON reconcile.variance_reviews (snapshot_id, recorded_at DESC, id DESC);

CREATE TRIGGER variance_reviews_append_only
BEFORE UPDATE OR DELETE ON reconcile.variance_reviews
FOR EACH ROW EXECUTE FUNCTION reconcile.reject_audit_changes();

CREATE VIEW reconcile.counterpart_variances AS
WITH latest AS (
    SELECT DISTINCT ON (source_id, order_external_id)
           id, source_id, snapshot_id, order_external_id, observed_status, observed_amount_cents, captured_at
    FROM reconcile.counterpart_snapshots
    ORDER BY source_id, order_external_id, captured_at DESC, id DESC
), latest_review AS (
    SELECT DISTINCT ON (snapshot_id) snapshot_id, actor, decision, reason, recorded_at
    FROM reconcile.variance_reviews
    ORDER BY snapshot_id, recorded_at DESC, id DESC
)
SELECT s.code AS source, l.snapshot_id, l.order_external_id,
       o.status AS local_status, l.observed_status,
       o.amount_cents AS local_amount_cents, l.observed_amount_cents,
       CASE
           WHEN o.id IS NULL THEN 'missing_local'
           WHEN o.amount_cents <> l.observed_amount_cents AND o.status <> l.observed_status THEN 'amount_and_status'
           WHEN o.amount_cents <> l.observed_amount_cents THEN 'amount_mismatch'
           WHEN o.status <> l.observed_status THEN 'status_mismatch'
           ELSE 'matched'
       END AS finding,
       l.captured_at, r.actor AS review_actor, r.decision AS review_decision, r.reason AS review_reason
FROM latest l
JOIN reconcile.sources s ON s.id = l.source_id
LEFT JOIN reconcile.orders o ON o.source_id = l.source_id AND o.external_id = l.order_external_id
LEFT JOIN latest_review r ON r.snapshot_id = l.id;
