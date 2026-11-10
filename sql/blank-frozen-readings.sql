-- Blank out readings from stations whose display froze on the Port Nelson image.
-- A station counts as frozen when its numbers stayed exactly the same for
-- 6 or more webcam frames in a row (30 min) for wind, or 12 or more (1 hour)
-- for the current at No 2 Pile. The same rule now runs in scraper.py for new rows.
-- Run the whole file in the Supabase SQL Editor. It only sets the frozen
-- station's columns to null; other columns in those rows are kept.

begin;

create temp table frozen_frames on commit drop as
with f as (
  select distinct on (image_update) image_update, created_at,
         main_wharf_wind, main_wharf_gust, main_wharf_dir,
         fairway_wind, fairway_gust, fairway_dir,
         no2_pile_velocity, no2_pile_dir
  from harbor_conditions
  order by image_update, created_at
),
o as (select *, row_number() over (order by created_at) rn from f),
g as (
  select *,
    rn - row_number() over (partition by main_wharf_wind, main_wharf_gust, main_wharf_dir order by created_at) gm,
    rn - row_number() over (partition by fairway_wind, fairway_gust, fairway_dir order by created_at) gf,
    rn - row_number() over (partition by no2_pile_velocity, no2_pile_dir order by created_at) gp
  from o
),
c as (
  select *,
    count(*) over (partition by main_wharf_wind, main_wharf_gust, main_wharf_dir, gm) nm,
    count(*) over (partition by fairway_wind, fairway_gust, fairway_dir, gf) nf,
    count(*) over (partition by no2_pile_velocity, no2_pile_dir, gp) np
  from g
)
select image_update,
       main_wharf_wind is not null and nm >= 6 as wharf,
       fairway_wind is not null and nf >= 6 as fairway,
       no2_pile_velocity is not null and np >= 12 as pile
from c
where (main_wharf_wind is not null and nm >= 6)
   or (fairway_wind is not null and nf >= 6)
   or (no2_pile_velocity is not null and np >= 12);

update harbor_conditions h
set main_wharf_wind = null, main_wharf_gust = null, main_wharf_dir = null
from frozen_frames z where z.image_update = h.image_update and z.wharf;

update harbor_conditions h
set fairway_wind = null, fairway_gust = null, fairway_dir = null, fairway_arrow = '•'
from frozen_frames z where z.image_update = h.image_update and z.fairway;

update harbor_conditions h
set no2_pile_velocity = null, no2_pile_dir = null
from frozen_frames z where z.image_update = h.image_update and z.pile;

commit;
