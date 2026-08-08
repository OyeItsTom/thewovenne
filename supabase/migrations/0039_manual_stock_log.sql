-- 0039 — Manual stock edits belong in the movement log too
--
-- 0038 logs stock moving through a SALE or a RETURN, because those go through
-- reserve_stock and release_stock. Nothing logs an admin typing a new number
-- into the size editor — and that is exactly the moment you most want a record,
-- because a hand correction is what you are trying to explain when the counts
-- disagree with the shelf.
--
-- A log with a hole in it is worse than no log: you would trust it.
--
-- SECOND, UNRELATED BUG FIXED HERE. saveProductSizes deleted every size row for
-- a product and re-inserted the whole set. Two problems: it cannot know what
-- changed, so nothing can be logged; and if the insert failed after the delete
-- succeeded, EVERY SIZE AND ITS STOCK WOULD BE GONE. This does the whole thing
-- in one function, in one transaction, and works out the deltas as it goes.
--
-- WHY THE SIZED PATH ONLY. Stock for a product with no sizes lives on
-- product_versions, which is DRAFTED and only takes effect at publish — so an
-- edit there has not moved anything yet, and product_versions already carries
-- an audit trigger from 0014 that records the before and after. product_sizes
-- is not versioned and not audited: an edit is immediately live and, until now,
-- invisible. That is the gap.

create or replace function public.save_product_sizes(
  p_product_id uuid,
  p_sizes jsonb,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  item      jsonb;
  v_label   text;
  v_qty     integer;
  v_sort    integer := 0;
  v_before  integer;
  v_logged  integer := 0;
  keep      text[] := array[]::text[];
begin
  if not public.is_admin() then
    raise exception 'Only admins can edit stock';
  end if;

  for item in select * from jsonb_array_elements(coalesce(p_sizes, '[]'::jsonb)) loop
    v_label := btrim(item ->> 'label');
    v_qty   := greatest(coalesce((item ->> 'stock_quantity')::integer, 0), 0);

    if v_label = '' then
      continue;
    end if;

    -- Case-insensitively unique, matching the index on the table. Caught here
    -- rather than left to a constraint violation, which would abort the whole
    -- save with a message nobody can act on.
    if v_label = any(select lower(k) from unnest(keep) k) then
      raise exception 'DUPLICATE_SIZE:%', v_label;
    end if;
    keep := keep || lower(v_label);

    select stock_quantity into v_before
      from product_sizes
     where product_id = p_product_id and lower(label) = lower(v_label);

    insert into product_sizes (product_id, label, stock_quantity, sort_order)
    values (p_product_id, v_label, v_qty, v_sort)
    on conflict (product_id, lower(label)) do update
      set stock_quantity = excluded.stock_quantity,
          label          = excluded.label,
          sort_order     = excluded.sort_order;

    -- Only a real change is a movement. Re-saving a product without touching
    -- its stock must not fill the log with zero-delta noise.
    if v_before is not null and v_before <> v_qty then
      insert into stock_movements (product_id, size_label, delta, reason, note, actor_id)
      values (p_product_id, v_label, v_qty - v_before, 'correction',
              coalesce(p_note, 'Edited in the product form'), auth.uid());
      v_logged := v_logged + 1;
    elsif v_before is null and v_qty > 0 then
      -- A size that did not exist before arrives with stock: that is a restock,
      -- not a correction of something.
      insert into stock_movements (product_id, size_label, delta, reason, note, actor_id)
      values (p_product_id, v_label, v_qty, 'restock',
              coalesce(p_note, 'Size added in the product form'), auth.uid());
      v_logged := v_logged + 1;
    end if;

    v_sort := v_sort + 1;
  end loop;

  -- Sizes the admin removed. Their stock leaves the shelf as far as the shop is
  -- concerned, so it is logged as a correction taking it out — otherwise
  -- deleting a size would quietly evaporate stock the log still counts.
  insert into stock_movements (product_id, size_label, delta, reason, note, actor_id)
  select p_product_id, ps.label, -ps.stock_quantity, 'correction',
         coalesce(p_note, 'Size removed in the product form'), auth.uid()
    from product_sizes ps
   where ps.product_id = p_product_id
     and lower(ps.label) <> all(coalesce(keep, array[]::text[]))
     and ps.stock_quantity <> 0;

  delete from product_sizes
   where product_id = p_product_id
     and lower(label) <> all(coalesce(keep, array[]::text[]));

  return jsonb_build_object('saved', coalesce(array_length(keep, 1), 0), 'logged', v_logged);
end;
$fn$;

revoke execute on function public.save_product_sizes(uuid, jsonb, text) from public, anon;
grant execute on function public.save_product_sizes(uuid, jsonb, text) to authenticated, service_role;

-- The upsert above needs a unique index it can name as its conflict target.
-- 0021's index is on (product_id, lower(label)); this states it explicitly so
-- the ON CONFLICT resolves even if that index was created differently.
create unique index if not exists product_sizes_product_label_lower
  on product_sizes (product_id, lower(label));

-- ── Verify ────────────────────────────────────
select
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
    and proname = 'save_product_sizes') as function_present,
  (select count(*) from pg_indexes
    where indexname = 'product_sizes_product_label_lower') as conflict_index,
  (select count(*) from information_schema.role_routine_grants
    where routine_name = 'save_product_sizes' and grantee = 'authenticated') as admin_can_call;
