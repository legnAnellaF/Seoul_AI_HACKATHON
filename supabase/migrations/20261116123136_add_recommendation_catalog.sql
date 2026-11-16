create schema recommendation_catalog;
revoke all on schema recommendation_catalog from public, anon, authenticated;

create table recommendation_catalog.stores (
  store_id text primary key,
  name text not null,
  sigungu text not null,
  dong text not null,
  category text not null,
  is_franchise boolean not null,
  delivery_tip integer not null check (delivery_tip >= 0),
  rating numeric(3, 2) not null check (rating between 0 and 5),
  impressions integer not null check (impressions >= 0),
  is_synthetic boolean not null,
  data_source text not null
);

create table recommendation_catalog.menus (
  menu_id text primary key,
  store_id text not null references recommendation_catalog.stores(store_id),
  name text not null,
  price integer not null check (price >= 0),
  description text not null,
  is_synthetic boolean not null
);

create index recommendation_stores_category_location_idx
  on recommendation_catalog.stores(category, sigungu, dong);
create index recommendation_menus_store_price_idx
  on recommendation_catalog.menus(store_id, price);

alter table recommendation_catalog.stores enable row level security;
alter table recommendation_catalog.menus enable row level security;
revoke all on recommendation_catalog.stores, recommendation_catalog.menus from public, anon, authenticated;
comment on schema recommendation_catalog is 'Synthetic catalog for future recommendations, isolated from ordering and application APIs.';
comment on table recommendation_catalog.stores is 'Source: supplied stores.csv.';
comment on table recommendation_catalog.menus is 'Source: supplied menus.csv. Portion size is not a structured source field.';
