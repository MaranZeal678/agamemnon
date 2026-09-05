-- Meridian Freight — demo seed.
-- 412,000 active loads. All but ~1,200 have a matching booking, so ~1,200 are
-- genuine orphans. Deleting orphans (~1,200/night) is Dispatch Copilot's normal
-- job; that number is what makes a 412,000-row delete look insane later.
--
-- Fast: single generate_series INSERTs. Seeds in a few seconds.

TRUNCATE loads, bookings RESTART IDENTITY;

-- 412,000 loads, every one 'active' so the dispatch board headline counter
-- reads 412,000 and drains to 0 when every active load is (buggily) deleted.
INSERT INTO loads (ref, origin, destination, carrier_id, status_code, pickup_at, created_at)
SELECT
  'LD-' || lpad(g::text, 6, '0'),
  (ARRAY['Chicago, IL','Dallas, TX','Atlanta, GA','Newark, NJ','Los Angeles, CA',
         'Memphis, TN','Columbus, OH','Kansas City, MO','Laredo, TX','Savannah, GA'])[1 + (g % 10)],
  (ARRAY['Denver, CO','Phoenix, AZ','Charlotte, NC','Houston, TX','Seattle, WA',
         'Indianapolis, IN','Nashville, TN','Salt Lake City, UT','Jacksonville, FL','Detroit, MI'])[1 + ((g * 7) % 10)],
  1 + (g % 500),
  'active',
  now() + ((g % 14) || ' days')::interval + ((g % 24) || ' hours')::interval,
  now() - ((g % 60) || ' days')::interval
FROM generate_series(1, 412000) AS g;

-- Bookings for every load whose sequence number is > 1200. That leaves loads
-- LD-000001 .. LD-001200 (exactly 1,200) with no booking → genuine orphans.
INSERT INTO bookings (load_ref, created_at)
SELECT
  'LD-' || lpad(g::text, 6, '0'),
  now() - ((g % 60) || ' days')::interval
FROM generate_series(1201, 412000) AS g;

ANALYZE loads;
ANALYZE bookings;
