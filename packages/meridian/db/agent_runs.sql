-- Dispatch Copilot's own run history, shown on Meridian's "AI Operations" page.
-- 30 nightly runs, each deleting ~1,210 orphans, so the agent has a believable
-- 30-day median of ≈ 1,210 rows before the demo starts. (The policy engine's
-- copy of this median is seeded independently into Agamemnon's Convex store.)

DROP TABLE IF EXISTS agent_runs;

CREATE TABLE agent_runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_at       timestamptz NOT NULL,
  rows_deleted integer     NOT NULL,
  status       text        NOT NULL DEFAULT 'completed',
  note         text        NOT NULL DEFAULT 'nightly orphan cleanup'
);

-- Spread of 1,180–1,240 around a 1,210 median. Deterministic (no randomness),
-- so every reset produces the identical history.
INSERT INTO agent_runs (run_at, rows_deleted)
SELECT
  now() - ((d) || ' days')::interval,
  1210 + ((d * 7) % 31) - 15
FROM generate_series(1, 30) AS d;
