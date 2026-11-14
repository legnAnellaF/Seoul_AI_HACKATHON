create schema if not exists delivery_private;

create table public.categories (
  id text primary key,
  name text not null,
  position integer not null unique
);

create table public.stores (
  id text primary key,
  category_id text not null references public.categories(id) on delete cascade,
  name text not null,
  district text not null,
  description text not null,
  minimum integer not null check (minimum >= 0),
  delivery_fee integer not null check (delivery_fee >= 0),
  delivery_time text not null,
  active boolean not null default true
);
create index stores_category on public.stores(category_id);

create table public.menu_items (
  id bigint generated always as identity primary key,
  store_id text not null references public.stores(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  description text not null default '' check (length(description) <= 240),
  price integer not null check (price between 1 and 1000000),
  available boolean not null default true
);
create index menu_items_store on public.menu_items(store_id);

-- Orders retain store and menu snapshots when catalog entries are deleted.
create table public.delivery_orders (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  customer_id uuid not null references auth.users(id) on delete cascade,
  store_id text not null,
  store_name text not null,
  address text not null,
  items jsonb not null,
  subtotal integer not null,
  delivery_fee integer not null,
  total integer generated always as (subtotal + delivery_fee) stored,
  status text not null default 'pending' check (status in ('pending','accepted','delivering','completed','rejected')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (customer_id, request_id)
);
create index delivery_orders_customer on public.delivery_orders(customer_id, created_at desc);
create index delivery_orders_store on public.delivery_orders(store_id, created_at desc);

create table public.delivery_reviews (
  order_id uuid primary key references public.delivery_orders(id) on delete cascade,
  rating integer not null check (rating between 1 and 5),
  body text not null check (length(trim(body)) between 1 and 800),
  reply text check (length(trim(reply)) between 1 and 800),
  created_at timestamptz not null default now()
);

create table delivery_private.owners (
  store_id text primary key,
  email text not null
);
alter table delivery_private.owners enable row level security;

create function delivery_private.owns_store(target text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from delivery_private.owners o
    join auth.users u on lower(u.email) = o.email
    where u.id = (select auth.uid()) and u.email_confirmed_at is not null and o.store_id = target
  );
$$;
revoke all on function delivery_private.owns_store(text) from public;
grant usage on schema delivery_private to authenticated;
grant execute on function delivery_private.owns_store(text) to authenticated;

alter table public.categories enable row level security;
alter table public.stores enable row level security;
alter table public.menu_items enable row level security;
alter table public.delivery_orders enable row level security;
alter table public.delivery_reviews enable row level security;
revoke all on public.categories, public.stores, public.menu_items, public.delivery_orders, public.delivery_reviews from anon, authenticated;
grant select on public.categories, public.stores, public.menu_items to anon, authenticated;
grant insert (store_id,name,description,price,available), update (name,description,price,available), delete on public.menu_items to authenticated;
grant select on public.delivery_orders, public.delivery_reviews to authenticated;
grant insert (order_id,rating,body), update (reply) on public.delivery_reviews to authenticated;
grant usage on sequence public.menu_items_id_seq to authenticated;

create policy categories_read on public.categories for select to anon,authenticated using (true);
create policy stores_read on public.stores for select to anon,authenticated using (active);
create policy menu_read on public.menu_items for select to anon,authenticated using
  (available and exists (select 1 from public.stores s where s.id = store_id));
create policy owner_menu_read on public.menu_items for select to authenticated using (delivery_private.owns_store(store_id));
create policy owner_menu_add on public.menu_items for insert to authenticated with check (delivery_private.owns_store(store_id));
create policy owner_menu_edit on public.menu_items for update to authenticated
  using (delivery_private.owns_store(store_id)) with check (delivery_private.owns_store(store_id));
create policy owner_menu_remove on public.menu_items for delete to authenticated using (delivery_private.owns_store(store_id));
create policy order_read on public.delivery_orders for select to authenticated using
  (customer_id = (select auth.uid()) or delivery_private.owns_store(store_id));
create policy review_read on public.delivery_reviews for select to authenticated using
  (exists (select 1 from public.delivery_orders o where o.id = order_id));
create policy review_add on public.delivery_reviews for insert to authenticated with check
  (exists (select 1 from public.delivery_orders o where o.id = order_id and o.customer_id = (select auth.uid()) and o.status = 'completed'));
create policy review_reply on public.delivery_reviews for update to authenticated using
  (exists (select 1 from public.delivery_orders o where o.id = order_id and delivery_private.owns_store(o.store_id)))
  with check (exists (select 1 from public.delivery_orders o where o.id = order_id and delivery_private.owns_store(o.store_id)));

create function delivery_private.place_order(
  target text, selections jsonb, delivery_address text, retry_key uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  buyer uuid := auth.uid();
  shop public.stores%rowtype;
  order_id uuid;
  entries jsonb;
  cost integer;
  matched integer;
begin
  if buyer is null then raise exception '로그인해 주세요.'; end if;
  select id into order_id from public.delivery_orders where customer_id = buyer and request_id = retry_key;
  if order_id is not null then return order_id; end if;
  if delivery_address is null or length(trim(delivery_address)) not between 3 and 250 then
    raise exception '배송 주소를 확인해 주세요.';
  end if;
  if jsonb_typeof(selections) is distinct from 'array' then raise exception '메뉴를 선택해 주세요.'; end if;
  if jsonb_array_length(selections) not between 1 and 30 then raise exception '메뉴를 1~30종 선택해 주세요.'; end if;
  select * into shop from public.stores where id = target and active for share;
  if not found then raise exception '현재 주문할 수 없는 가게입니다.'; end if;
  with requested as (
    select m.id, m.name, m.price, x.quantity
    from jsonb_to_recordset(selections) as x(id bigint, quantity integer)
    join public.menu_items m on m.id = x.id
    where m.store_id = target and m.available and x.quantity between 1 and 20
    for share of m
  )
  select jsonb_agg(jsonb_build_object('id',id,'name',name,'price',price,'quantity',quantity) order by id),
         sum(price * quantity), count(distinct id)
    into entries,cost,matched from requested;
  if matched <> jsonb_array_length(selections) then raise exception '품절되었거나 삭제된 메뉴가 있습니다. 장바구니를 확인해 주세요.'; end if;
  if cost < shop.minimum then raise exception '최소주문금액에 미달합니다.'; end if;
  insert into public.delivery_orders(request_id,customer_id,store_id,store_name,address,items,subtotal,delivery_fee)
  values (retry_key,buyer,shop.id,shop.name,trim(delivery_address),entries,cost,shop.delivery_fee)
  on conflict (customer_id,request_id) do nothing returning id into order_id;
  if order_id is null then
    select id into order_id from public.delivery_orders where customer_id = buyer and request_id = retry_key;
  end if;
  return order_id;
end;
$$;

create function delivery_private.change_order(target uuid, next_status text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception '로그인해 주세요.'; end if;
  update public.delivery_orders o
  set status = next_status, completed_at = case when next_status = 'completed' then now() end
  where o.id = target and delivery_private.owns_store(o.store_id) and
    ((o.status = 'pending' and next_status in ('accepted','rejected')) or
     (o.status = 'accepted' and next_status = 'delivering') or
     (o.status = 'delivering' and next_status = 'completed'));
  if not found then raise exception '주문 상태가 변경됐거나 권한이 없습니다.'; end if;
end;
$$;

create function public.place_delivery_order(target text, selections jsonb, delivery_address text, retry_key uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select delivery_private.place_order(target,selections,delivery_address,retry_key);
$$;
create function public.change_delivery_order(target uuid, next_status text)
returns void language sql security invoker set search_path = '' as $$
  select delivery_private.change_order(target,next_status);
$$;
create function public.manages_delivery_store(target text)
returns boolean language sql stable security invoker set search_path = '' as $$
  select delivery_private.owns_store(target);
$$;
revoke all on function delivery_private.place_order(text,jsonb,text,uuid), delivery_private.change_order(uuid,text),
  public.place_delivery_order(text,jsonb,text,uuid), public.change_delivery_order(uuid,text), public.manages_delivery_store(text) from public, anon;
grant execute on function delivery_private.place_order(text,jsonb,text,uuid), delivery_private.change_order(uuid,text),
  public.place_delivery_order(text,jsonb,text,uuid), public.change_delivery_order(uuid,text), public.manages_delivery_store(text) to authenticated;

insert into public.categories values
('chicken','치킨',1),('dessert','카페/디저트',2),('pizza','피자',3),('korean','한식',4),
('burger','버거',5),('chinese','중식',6),('japanese','일식',7),('western','양식',8);

insert into public.stores values
('alley-chicken','chicken','서초 골목통닭','서울 서초구 서초동','주문이 들어오면 바삭하게 튀기는 동네 통닭집입니다.',15000,2000,'25~40분',true),
('butter-room','dessert','버터룸 서초','서울 서초구 서초동','매일 굽는 디저트와 커피를 준비합니다.',9000,1500,'20~35분',true),
('brick-pizza','pizza','벽돌화덕 피자','서울 서초구 방배동','숙성 도우로 굽는 동네 피자집입니다.',17000,2000,'30~45분',true),
('rice-table','korean','서초 한끼상','서울 서초구 서초동','매일 준비한 반찬과 든든한 한 끼를 담습니다.',10000,1500,'20~35분',true),
('patty-shop','burger','서리풀 버거','서울 서초구 방배동','그릴에 구운 패티를 넣은 수제 버거를 만듭니다.',11000,2000,'25~40분',true),
('red-wok','chinese','홍등 주방','서울 서초구 서초동','센 불에서 볶은 면과 밥을 준비합니다.',10000,1800,'25~40분',true),
('sora-kitchen','japanese','소라 식당','서울 서초구 반포동','덮밥과 우동을 만드는 작은 일식집입니다.',12000,2200,'25~40분',true),
('pasta-room','western','오후 파스타','서울 서초구 반포동','소스를 직접 만드는 작은 파스타 집입니다.',14000,2500,'30~45분',true);

insert into public.menu_items(store_id,name,description,price) values
('alley-chicken','옛날 후라이드','겉은 바삭하고 속은 촉촉한 한 마리',18500),
('alley-chicken','매콤 양념치킨','달콤하고 매콤한 소스를 버무린 치킨',19900),
('alley-chicken','바삭 감자튀김','치킨과 함께 먹기 좋은 감자튀김',4500),
('butter-room','버터 휘낭시에 세트','버터 향을 살린 휘낭시에 세 개',9900),
('butter-room','아이스 바닐라 라테','바닐라 시럽과 에스프레소',5300),
('brick-pizza','페퍼로니 피자','페퍼로니와 토마토소스',21900),
('brick-pizza','버섯 크림 피자','구운 버섯과 크림소스',23900),
('rice-table','제육 한상','매콤한 제육볶음과 밥, 반찬',11900),
('rice-table','나물 비빔밥','제철 나물과 참기름',10500),
('patty-shop','더블 치즈버거','쇠고기 패티 두 장과 치즈',12900),
('patty-shop','오리지널 감자튀김','바삭하게 튀긴 감자',3900),
('red-wok','고추잡채 덮밥','고기와 피망을 센 불에 볶은 덮밥',11900),
('red-wok','유린기','채소와 산뜻한 소스를 곁들인 닭튀김',17900),
('sora-kitchen','구운 연어 덮밥','연어 구이와 간장 소스',14900),
('sora-kitchen','유부 우동','유부를 올린 따뜻한 우동',8900),
('pasta-room','새우 오일 파스타','새우와 마늘을 올린 오일 파스타',15800),
('pasta-room','토마토 리소토','토마토와 채소로 끓인 리소토',14900);
