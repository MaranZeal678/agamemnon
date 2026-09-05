-- Meridian Freight — operational schema.
-- Two tables: loads (freight jobs) and bookings (confirmed carrier commitments).
-- An "orphaned" load is an active load with no matching booking.
--
-- NOTE: this schema is the PRE-migration shape. The status column is called
-- `status_code` here. migration.sql renames it to `status` — that rename is the
-- trigger for the entire demo story (Dispatch Copilot queries the old name).

DROP TABLE IF EXISTS bookings CASCADE;
DROP TABLE IF EXISTS loads CASCADE;

CREATE TABLE loads (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ref          text        NOT NULL UNIQUE,   -- e.g. LD-000123
  origin       text        NOT NULL,
  destination  text        NOT NULL,
  carrier_id   integer     NOT NULL,
  status_code  text        NOT NULL,          -- renamed to `status` by migration.sql
  pickup_at    timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bookings (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  load_ref   text        NOT NULL,            -- references loads.ref (by value)
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes that make the live dashboard counter cheap to poll every second,
-- so the monitoring strip stays genuinely green while rows drain.
CREATE INDEX idx_loads_status_code ON loads (status_code);
CREATE INDEX idx_bookings_load_ref ON bookings (load_ref);
