alter table recommendation_catalog.stores
  add column if not exists is_open boolean not null default true,
  add column if not exists review_count integer,
  add column is_good_price boolean not null default false,
  add column is_listed boolean not null default true,
  alter column rating drop not null;

create or replace view delivery_demo_private.catalog_stores with (security_invoker=true) as
select store_id as id, name, concat_ws(' ', '서울',sigungu,dong) as district, category,
       case category
         when '치킨' then 'chicken'
         when '치킨·튀김' then 'chicken'
         when '카페·디저트' then 'dessert'
         when '피자' then 'pizza'
         when '한식' then 'korean'
         when '찜·탕' then 'korean'
         when '버거' then 'burger'
         when '패스트푸드' then 'burger'
         when '중식' then 'chinese'
         when '일식' then 'japanese'
         when '돈까스·일식' then 'japanese'
         when '양식' then 'western'
         else category
       end as category_id,
       delivery_tip as delivery_fee, rating, is_synthetic,
       is_open, impressions as exposure_count, is_good_price, review_count, is_listed
from recommendation_catalog.stores;

create or replace function recommendation_catalog.snapshot()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'stores', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.store_id, 'name', s.name, 'region', s.sigungu, 'dong', s.dong,
      'category', case when s.category = '찜·탕' then '한식' else s.category end,
      'franchise', s.is_franchise, 'tip', s.delivery_tip, 'rating', s.rating,
      'is_open', s.is_open, 'is_good_price', s.is_good_price, 'exposure_count', s.impressions
    ) order by s.store_id), '[]'::jsonb)
      from recommendation_catalog.stores s
      where s.is_synthetic and s.is_open and s.is_listed),
    'menus', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.menu_id, 'store', m.store_id, 'name', m.name, 'price', m.price, 'desc', m.description
    ) order by m.menu_id), '[]'::jsonb)
      from recommendation_catalog.menus m
      join recommendation_catalog.stores s using (store_id)
      where m.is_synthetic and s.is_synthetic and s.is_open and s.is_listed)
  );
$$;

CREATE OR REPLACE FUNCTION delivery_demo_private.run(action text, browser_key uuid, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      'stores', (select coalesce(jsonb_agg(to_jsonb(s) order by s.is_open desc,s.name,s.id),'[]')
        from delivery_demo_private.catalog_stores s
        where (s.is_synthetic and s.is_listed) or (
          payload->'include_order_stores' = 'true'::jsonb and exists (
            select 1 from delivery_demo_private.orders o where o.browser_hash=browser and o.store_id=s.id
          )
        )),
      'menus', case when payload->'stores_only' = 'true'::jsonb then '[]'::jsonb
        else (select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]') from delivery_demo_private.menus(browser) m
          join delivery_demo_private.catalog_stores s on s.id=m.store_id
          where s.is_synthetic and s.is_listed) end
    );
  elsif action = 'store_menus' then
    return (select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]')
      from delivery_demo_private.menus(browser,shop_id) m
      join delivery_demo_private.catalog_stores s on s.id=m.store_id
      where s.id=shop_id and s.is_synthetic and (s.is_listed or exists (
        select 1 from delivery_demo_private.orders o where o.browser_hash=browser and o.store_id=s.id
      )));
  elsif action = 'menu_search' then
    note := trim(payload->>'query');
    if note is null or length(note) not between 1 and 80 then return '[]'::jsonb; end if;
    return (select coalesce(jsonb_agg(distinct m.store_id),'[]')
      from delivery_demo_private.menus(browser) m
      join delivery_demo_private.catalog_stores s on s.id=m.store_id
      where s.is_synthetic and s.is_listed and m.available
        and strpos(lower(m.name),lower(note)) > 0);
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
    if not found or not shop.is_listed or not shop.is_synthetic then
      raise exception '가게 정보를 찾을 수 없습니다.';
    end if;
    if not shop.is_open then raise exception '현재 배달 주문을 받지 않는 가게입니다.'; end if;
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
$function$;
