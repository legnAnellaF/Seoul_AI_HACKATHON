create schema delivery_demo_private;
revoke all on schema delivery_demo_private from public, anon, authenticated;

create table delivery_demo_private.orders (
  browser_hash bytea not null,
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  store_id text not null,
  store_name text not null,
  address text not null,
  items jsonb not null,
  subtotal integer not null,
  delivery_fee integer not null,
  total integer generated always as (subtotal + delivery_fee) stored,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  delivery_reviews jsonb,
  unique(browser_hash, request_id)
);
create index demo_orders_browser_date on delivery_demo_private.orders(browser_hash, created_at desc);
alter table delivery_demo_private.orders enable row level security;

create table delivery_demo_private.menu_changes (
  browser_hash bytea not null,
  store_id text not null references recommendation_catalog.stores(store_id),
  id text not null,
  name text not null,
  description text not null,
  price integer not null check (price between 1 and 1000000),
  available boolean not null,
  removed boolean not null default false,
  primary key(browser_hash, store_id, id)
);
alter table delivery_demo_private.menu_changes enable row level security;

create view delivery_demo_private.catalog_stores with (security_invoker=true) as
select store_id as id, name, concat_ws(' ', '서울',sigungu,dong) as district, category,
       case category
         when '치킨' then 'chicken'
         when '치킨·튀김' then 'chicken'
         when '카페·디저트' then 'dessert'
         when '피자' then 'pizza'
         when '한식' then 'korean'
         when '버거' then 'burger'
         when '중식' then 'chinese'
         when '일식' then 'japanese'
         when '양식' then 'western'
         else category
       end as category_id,
       delivery_tip as delivery_fee, rating, is_synthetic
from recommendation_catalog.stores;

create function delivery_demo_private.menus(browser bytea, shop text default null)
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
revoke all on function delivery_demo_private.menus(bytea,text) from public;

create function delivery_demo_private.run(action text, browser_key uuid, payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  browser bytea := pg_catalog.sha256(pg_catalog.convert_to(browser_key::text,'UTF8'));
  shop_id text := payload->>'target';
  item_id text := payload->>'id';
  shop delivery_demo_private.catalog_stores%rowtype;
  menu_row record;
  order_ref uuid;
  retry_key uuid;
  matched integer;
  order_cost integer;
  entries jsonb;
  selected jsonb := payload->'selections';
  note text := trim(payload->>'delivery_address');
  next_status text := payload->>'next_status';
  review_body text := trim(payload->>'body');
  rating_number integer;
  order_result jsonb;
begin
  if browser_key is null or substring(browser_key::text,15,1) <> '4' then
    raise exception '시연 세션을 새로 시작해 주세요.';
  end if;

  if action = 'catalog' then
    return jsonb_build_object(
      'stores',(select coalesce(jsonb_agg(to_jsonb(s) order by name,id),'[]') from delivery_demo_private.catalog_stores s),
      'menus',(select coalesce(jsonb_agg(to_jsonb(m) order by id),'[]') from delivery_demo_private.menus(browser) m)
    );
  elsif action = 'orders' then
    return (select coalesce(jsonb_agg(to_jsonb(o)-'browser_hash'-'request_id' order by o.created_at desc),'[]')
            from delivery_demo_private.orders o where o.browser_hash=browser);
  elsif action = 'place' then
    retry_key := (payload->>'retry_key')::uuid;
    if retry_key is null then raise exception '주문 요청 번호가 없습니다.'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(browser_key::text,0));
    select id into order_ref from delivery_demo_private.orders where browser_hash=browser and request_id=retry_key;
    if order_ref is not null then return to_jsonb(order_ref); end if;
    if (select count(*) from delivery_demo_private.orders where browser_hash=browser) >= 100 then
      raise exception '이 브라우저의 시연 주문 한도에 도달했습니다.';
    end if;
    if jsonb_typeof(selected) is distinct from 'array' or note is null or length(note) not between 3 and 250 then
      raise exception '메뉴와 배달 주소를 확인해 주세요.';
    end if;
    if jsonb_array_length(selected) not between 1 and 30 then raise exception '메뉴를 1~30종 선택해 주세요.'; end if;
    select * into shop from delivery_demo_private.catalog_stores where id=shop_id;
    if not found then raise exception '가게 정보를 찾을 수 없습니다.'; end if;
    select count(distinct m.id),sum(m.price * x.quantity),
           jsonb_agg(jsonb_build_object('id',m.id,'name',m.name,'price',m.price,'quantity',x.quantity) order by m.id)
    into matched,order_cost,entries
    from jsonb_to_recordset(selected) x(id text,quantity integer)
    join delivery_demo_private.menus(browser,shop_id) m on m.id=x.id
    where m.available and x.quantity between 1 and 20;
    if matched <> jsonb_array_length(selected) then raise exception '판매 중인 메뉴를 다시 선택해 주세요.'; end if;
    insert into delivery_demo_private.orders(browser_hash,request_id,store_id,store_name,address,items,subtotal,delivery_fee)
    values(browser,retry_key,shop.id,shop.name,note,entries,order_cost,shop.delivery_fee)
    returning id into order_ref;
    return to_jsonb(order_ref);
  elsif action in ('state','review','reply') then
    order_ref := (payload->>'order_id')::uuid;
    if action = 'state' then
      update delivery_demo_private.orders o
      set status=next_status, completed_at=case when next_status='completed' then now() end
      where o.browser_hash=browser and o.id=order_ref and
        ((o.status='pending' and next_status in ('accepted','rejected')) or
         (o.status='accepted' and next_status='delivering') or
         (o.status='delivering' and next_status='completed'))
      returning to_jsonb(o)-'browser_hash'-'request_id' into order_result;
    elsif action='review' then
      rating_number := (payload->>'rating')::integer;
      if review_body is null or length(review_body) not between 1 and 800 or rating_number is null or rating_number not between 1 and 5 then
        raise exception '별점과 리뷰를 확인해 주세요.';
      end if;
      update delivery_demo_private.orders o
      set delivery_reviews=jsonb_build_object('body',review_body,'rating',rating_number,'created_at',now())
      where o.browser_hash=browser and o.id=order_ref and o.status='completed' and o.delivery_reviews is null
      returning to_jsonb(o)-'browser_hash'-'request_id' into order_result;
    else
      if review_body is null or length(review_body) not between 1 and 800 then raise exception '답변 내용을 확인해 주세요.'; end if;
      update delivery_demo_private.orders o
      set delivery_reviews=jsonb_set(o.delivery_reviews,'{reply}',to_jsonb(review_body))
      where o.browser_hash=browser and o.id=order_ref and o.delivery_reviews is not null
      returning to_jsonb(o)-'browser_hash'-'request_id' into order_result;
    end if;
    if order_result is null then raise exception '이 브라우저에서 처리할 수 있는 주문이 없습니다.'; end if;
    return order_result;
  elsif action in ('save_menu','remove_menu') then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(browser_key::text,0));
    if not exists (select 1 from recommendation_catalog.stores where store_id=shop_id) then
      raise exception '가게 정보를 찾을 수 없습니다.';
    end if;
    if item_id is not null then
      select * into menu_row from delivery_demo_private.menus(browser,shop_id) m where m.id=item_id;
      if not found then raise exception '메뉴 정보를 찾을 수 없습니다.'; end if;
    end if;
    if action='remove_menu' then
      if item_id is null then raise exception '삭제할 메뉴를 선택해 주세요.'; end if;
      insert into delivery_demo_private.menu_changes(browser_hash,store_id,id,name,description,price,available,removed)
      values(browser,shop_id,item_id,menu_row.name,menu_row.description,menu_row.price,false,true)
      on conflict(browser_hash,store_id,id) do update set removed=true,available=false;
    else
      if jsonb_typeof(payload->'available') is distinct from 'boolean'
          or length(trim(coalesce(payload->>'name',''))) not between 1 and 80
          or length(coalesce(payload->>'description','')) > 240 then raise exception '메뉴 내용을 확인해 주세요.'; end if;
      if item_id is null then
        if (select count(*) from delivery_demo_private.menu_changes where browser_hash=browser and left(id,5)='demo-' and not removed) >= 100 then
          raise exception '이 브라우저의 시연 메뉴 등록 한도에 도달했습니다.';
        end if;
        item_id := 'demo-' || gen_random_uuid()::text;
      end if;
      insert into delivery_demo_private.menu_changes(browser_hash,store_id,id,name,description,price,available)
      values(browser,shop_id,item_id,trim(payload->>'name'),coalesce(payload->>'description',''),(payload->>'price')::integer,(payload->>'available')::boolean)
      on conflict(browser_hash,store_id,id) do update
      set name=excluded.name,description=excluded.description,price=excluded.price,available=excluded.available,removed=false;
    end if;
    return to_jsonb(item_id);
  end if;
  raise exception '지원하지 않는 시연 요청입니다.';
end;
$$;
revoke all on function delivery_demo_private.run(text,uuid,jsonb) from public, anon, authenticated;
grant usage on schema delivery_demo_private to anon, authenticated;
grant execute on function delivery_demo_private.run(text,uuid,jsonb) to anon, authenticated;

create function public.seoul_delivery_demo(action text, browser_key uuid, payload jsonb default '{}')
returns jsonb language sql security invoker set search_path = '' as $$
  select delivery_demo_private.run(action,browser_key,payload);
$$;
revoke all on function public.seoul_delivery_demo(text,uuid,jsonb) from public;
grant execute on function public.seoul_delivery_demo(text,uuid,jsonb) to anon, authenticated;
