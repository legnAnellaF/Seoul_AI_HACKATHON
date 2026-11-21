create or replace function delivery_demo_private.menus(browser bytea, shop text default null)
returns table(id text, store_id text, name text, description text, price integer, available boolean)
language sql stable set search_path = '' as $$
  select m.menu_id,m.store_id,m.name,m.description,m.price,true
  from recommendation_catalog.menus m
  where (shop is null or m.store_id=shop) and not exists (
    select 1 from delivery_demo_private.menu_changes c
    where c.browser_hash=browser and c.store_id=m.store_id and c.id=m.menu_id
  )
  union all
  select c.id,c.store_id,c.name,c.description,c.price,c.available
  from delivery_demo_private.menu_changes c
  where c.browser_hash=browser and (shop is null or c.store_id=shop) and not c.removed;
$$;
