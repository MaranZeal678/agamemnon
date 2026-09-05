-- THE MIGRATION THAT BREAKS EVERYTHING.
--
-- A well-meaning platform team renames loads.status_code to loads.status for
-- consistency. Dispatch Copilot's orphan query hardcodes `status_code`, so from
-- this moment its first query fails — which is where the whole story begins.
--
-- Applied automatically at the end of `make seed`.

ALTER TABLE loads RENAME COLUMN status_code TO status;

ALTER INDEX idx_loads_status_code RENAME TO idx_loads_status;
