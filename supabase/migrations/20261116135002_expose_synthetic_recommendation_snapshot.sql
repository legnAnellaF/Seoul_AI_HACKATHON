create function recommendation_catalog.snapshot()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'stores', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.store_id, 'name', s.name, 'region', s.sigungu, 'dong', s.dong,
      'category', s.category, 'franchise', s.is_franchise, 'tip', s.delivery_tip,
      'rating', s.rating
    ) order by s.store_id), '[]'::jsonb)
      from recommendation_catalog.stores s where s.is_synthetic),
    'menus', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.menu_id, 'store', m.store_id, 'name', m.name, 'price', m.price, 'desc', m.description
    ) order by m.menu_id), '[]'::jsonb)
      from recommendation_catalog.menus m
      join recommendation_catalog.stores s using (store_id)
      where m.is_synthetic and s.is_synthetic)
  );
$$;
revoke all on function recommendation_catalog.snapshot() from public, anon, authenticated;
grant usage on schema recommendation_catalog to anon, authenticated;
grant execute on function recommendation_catalog.snapshot() to anon, authenticated;

create function public.seoul_recommendation_snapshot()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select recommendation_catalog.snapshot();
$$;
revoke all on function public.seoul_recommendation_snapshot() from public, anon, authenticated;
grant execute on function public.seoul_recommendation_snapshot() to anon, authenticated;
