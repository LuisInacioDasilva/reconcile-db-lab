CREATE SCHEMA reconcile;

CREATE TABLE reconcile.sources (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code text NOT NULL UNIQUE,
    CONSTRAINT source_code_not_blank CHECK (btrim(code) <> '')
);

CREATE TABLE reconcile.orders (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id integer NOT NULL REFERENCES reconcile.sources(id),
    external_id text NOT NULL,
    customer_name text NOT NULL,
    amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'fulfilled', 'cancelled')),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_id, external_id),
    CONSTRAINT order_external_id_not_blank CHECK (btrim(external_id) <> ''),
    CONSTRAINT customer_name_not_blank CHECK (btrim(customer_name) <> '')
);

CREATE TABLE reconcile.inbox_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id integer NOT NULL REFERENCES reconcile.sources(id),
    external_event_id text NOT NULL,
    order_external_id text NOT NULL,
    event_type text NOT NULL CHECK (event_type IN ('approved', 'fulfilled', 'cancelled')),
    payload jsonb NOT NULL,
    payload_fingerprint text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_id, external_event_id)
);

CREATE TABLE reconcile.transitions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id bigint NOT NULL REFERENCES reconcile.orders(id),
    inbox_event_id bigint NOT NULL UNIQUE REFERENCES reconcile.inbox_events(id),
    previous_status text NOT NULL,
    requested_status text NOT NULL,
    accepted boolean NOT NULL,
    reason text,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT accepted_has_no_reason CHECK ((accepted AND reason IS NULL) OR (NOT accepted AND reason IS NOT NULL))
);

CREATE INDEX transitions_order_time_idx ON reconcile.transitions (order_id, recorded_at DESC);
CREATE INDEX inbox_events_received_idx ON reconcile.inbox_events (received_at DESC);

CREATE FUNCTION reconcile.reject_audit_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit rows are append-only';
END;
$$;

CREATE TRIGGER inbox_events_append_only
BEFORE UPDATE OR DELETE ON reconcile.inbox_events
FOR EACH ROW EXECUTE FUNCTION reconcile.reject_audit_changes();

CREATE TRIGGER transitions_append_only
BEFORE UPDATE OR DELETE ON reconcile.transitions
FOR EACH ROW EXECUTE FUNCTION reconcile.reject_audit_changes();

CREATE FUNCTION reconcile.ingest_event(
    p_source text,
    p_event_id text,
    p_order_external_id text,
    p_event_type text,
    p_payload jsonb
) RETURNS TABLE(disposition text, order_status text, order_version integer)
LANGUAGE plpgsql AS $$
DECLARE
    v_source_id integer;
    v_event_id bigint;
    v_existing reconcile.inbox_events%ROWTYPE;
    v_order_id bigint;
    v_previous text;
    v_version integer;
    v_fingerprint text;
    v_allowed boolean;
BEGIN
    IF p_event_id IS NULL OR btrim(p_event_id) = '' OR p_order_external_id IS NULL OR btrim(p_order_external_id) = '' THEN
        RAISE EXCEPTION 'event and order identifiers are required';
    END IF;
    IF p_payload IS NULL OR p_event_type NOT IN ('approved', 'fulfilled', 'cancelled') THEN
        RAISE EXCEPTION 'invalid event type or payload';
    END IF;

    SELECT id INTO v_source_id FROM reconcile.sources WHERE code = p_source;
    IF v_source_id IS NULL THEN
        RAISE EXCEPTION 'unknown source: %', p_source;
    END IF;

    v_fingerprint := md5(p_payload::text);
    INSERT INTO reconcile.inbox_events (source_id, external_event_id, order_external_id, event_type, payload, payload_fingerprint)
    VALUES (v_source_id, p_event_id, p_order_external_id, p_event_type, p_payload, v_fingerprint)
    ON CONFLICT (source_id, external_event_id) DO NOTHING
    RETURNING id INTO v_event_id;

    IF v_event_id IS NULL THEN
        SELECT * INTO v_existing FROM reconcile.inbox_events
        WHERE source_id = v_source_id AND external_event_id = p_event_id;
        IF v_existing.order_external_id <> p_order_external_id
           OR v_existing.event_type <> p_event_type
           OR v_existing.payload_fingerprint <> v_fingerprint THEN
            RAISE EXCEPTION 'event ID reused with different content';
        END IF;
        SELECT o.status, o.version INTO order_status, order_version
        FROM reconcile.orders o WHERE o.source_id = v_source_id AND o.external_id = p_order_external_id;
        disposition := 'duplicate';
        RETURN NEXT;
        RETURN;
    END IF;

    SELECT o.id, o.status, o.version INTO v_order_id, v_previous, v_version
    FROM reconcile.orders o
    WHERE o.source_id = v_source_id AND o.external_id = p_order_external_id
    FOR UPDATE;
    IF v_order_id IS NULL THEN
        RAISE EXCEPTION 'unknown order: %', p_order_external_id;
    END IF;

    v_allowed := (v_previous = 'pending' AND p_event_type IN ('approved', 'cancelled'))
              OR (v_previous = 'approved' AND p_event_type IN ('fulfilled', 'cancelled'));
    INSERT INTO reconcile.transitions
        (order_id, inbox_event_id, previous_status, requested_status, accepted, reason)
    VALUES
        (v_order_id, v_event_id, v_previous, p_event_type, v_allowed,
         CASE WHEN v_allowed THEN NULL ELSE 'invalid_transition' END);

    IF v_allowed THEN
        UPDATE reconcile.orders
        SET status = p_event_type, version = version + 1, updated_at = now()
        WHERE id = v_order_id;
        order_status := p_event_type;
        order_version := v_version + 1;
        disposition := 'applied';
    ELSE
        order_status := v_previous;
        order_version := v_version;
        disposition := 'rejected';
    END IF;
    RETURN NEXT;
END;
$$;

CREATE VIEW reconcile.source_health AS
WITH order_counts AS (
    SELECT source_id, count(*) AS orders
    FROM reconcile.orders GROUP BY source_id
), event_counts AS (
    SELECT e.source_id, count(*) AS received_events,
           count(t.id) FILTER (WHERE t.accepted) AS applied_events,
           count(t.id) FILTER (WHERE NOT t.accepted) AS rejected_events
    FROM reconcile.inbox_events e
    LEFT JOIN reconcile.transitions t ON t.inbox_event_id = e.id
    GROUP BY e.source_id
)
SELECT s.code AS source,
       coalesce(o.orders, 0) AS orders,
       coalesce(e.received_events, 0) AS received_events,
       coalesce(e.applied_events, 0) AS applied_events,
       coalesce(e.rejected_events, 0) AS rejected_events
FROM reconcile.sources s
LEFT JOIN order_counts o ON o.source_id = s.id
LEFT JOIN event_counts e ON e.source_id = s.id;

CREATE VIEW reconcile.order_snapshot AS
SELECT s.code AS source, o.external_id, o.customer_name, o.amount_cents,
       o.status, o.version, o.updated_at,
       count(t.id) FILTER (WHERE t.accepted) AS accepted_transitions,
       count(t.id) FILTER (WHERE NOT t.accepted) AS rejected_transitions
FROM reconcile.orders o
JOIN reconcile.sources s ON s.id = o.source_id
LEFT JOIN reconcile.transitions t ON t.order_id = o.id
GROUP BY o.id, s.code;

CREATE VIEW reconcile.order_integrity AS
WITH decisions AS (
    SELECT order_id,
           count(*) FILTER (WHERE accepted) AS accepted_count,
           (array_agg(requested_status ORDER BY id DESC) FILTER (WHERE accepted))[1] AS latest_accepted_status
    FROM reconcile.transitions GROUP BY order_id
)
SELECT s.code AS source, o.external_id, o.status, o.version,
       1 + coalesce(d.accepted_count, 0) AS expected_version,
       coalesce(d.latest_accepted_status, 'pending') AS expected_status,
       o.version = 1 + coalesce(d.accepted_count, 0)
           AND o.status = coalesce(d.latest_accepted_status, 'pending') AS consistent
FROM reconcile.orders o
JOIN reconcile.sources s ON s.id = o.source_id
LEFT JOIN decisions d ON d.order_id = o.id;
