-- 0036 — Product reviews, from verified purchasers only
--
-- "VERIFIED PURCHASE" IS ENFORCED IN THE DATABASE, NOT THE FORM. A review form
-- that only appears for buyers is a UI convenience; the rule has to live where
-- it cannot be skipped by anyone willing to open a console. So the check is a
-- SECURITY DEFINER function reading the customer's own paid orders, and the RLS
-- policy calls it — there is no INSERT path that avoids it.
--
-- WHAT COUNTS AS A PURCHASE: a paid order, containing this product, that has
-- actually been delivered. Delivery matters — someone who paid an hour ago has
-- an opinion about the checkout, not the cloth. Cancelled orders never count.
--
-- ONE REVIEW PER PERSON PER PRODUCT, enforced by a unique index rather than a
-- check in the app. Buying twice is not two opinions; editing the existing one
-- is the honest way to change your mind.
--
-- Reviews are attributed to the name on the profile. No display-name field,
-- because inventing one is a new piece of personal data to hold, and the
-- account already has a name the customer chose.

create table if not exists product_reviews (
  id          uuid primary key default gen_random_uuid(),
  -- Identity id, not a version id. A review is about the piece, and it must
  -- survive the product being edited and republished.
  product_id  uuid not null references products(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  rating      smallint not null check (rating between 1 and 5),
  body        text not null check (length(btrim(body)) between 10 and 2000),
  -- Hidden by an admin. NOT deleted: a shop quietly removing criticism it
  -- dislikes should at least have to look at the row it is hiding, and a
  -- moderation decision that leaves no trace is not a moderation decision.
  hidden_at   timestamptz,
  hidden_by   uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists product_reviews_one_per_customer
  on product_reviews (product_id, user_id);

create index if not exists product_reviews_visible_idx
  on product_reviews (product_id, created_at desc)
  where hidden_at is null;

-- ── Has this person actually bought this thing? ──
create or replace function public.has_purchased(p_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
      from orders o,
           lateral jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) item
     where lower(o.customer_email) = lower(auth.email())
       and o.payment_status = 'paid'
       and o.status = 'delivered'
       -- Compared as TEXT, not cast to uuid. One malformed id anywhere in the
       -- order history would make the cast throw, and this function sits
       -- inside an RLS policy — a single bad row would start refusing reviews
       -- for everybody, with an error nobody could connect to the cause.
       and item ->> 'id' = p_product_id::text
  );
$fn$;

revoke execute on function public.has_purchased(uuid) from public, anon;
grant execute on function public.has_purchased(uuid) to authenticated;

alter table product_reviews enable row level security;

-- Anyone may read the reviews that are not hidden — that is the whole point of
-- them. Hidden rows are invisible to customers, including their author: an
-- author who can still see their own hidden review will conclude it is live.
do $$ begin
  create policy "Visible reviews are public" on product_reviews
    for select to anon, authenticated
    using (hidden_at is null);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Admins read every review" on product_reviews
    for select to authenticated
    using (public.is_admin());
exception when duplicate_object then null; end $$;

-- The rule, in the only place it cannot be bypassed.
do $$ begin
  create policy "Verified purchasers may review" on product_reviews
    for insert to authenticated
    with check (user_id = auth.uid() and public.has_purchased(product_id));
exception when duplicate_object then null; end $$;

-- Editing your own review is allowed; hiding it is not something a customer
-- does, so hidden_at is kept out of their reach by the column grants below.
do $$ begin
  create policy "Customers edit their own review" on product_reviews
    for update to authenticated
    using (user_id = auth.uid() and hidden_at is null)
    with check (user_id = auth.uid());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Customers delete their own review" on product_reviews
    for delete to authenticated
    using (user_id = auth.uid());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Admins moderate reviews" on product_reviews
    for all to authenticated
    using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null; end $$;

grant select on product_reviews to anon, authenticated;
grant insert (product_id, user_id, rating, body) on product_reviews to authenticated;
grant update (rating, body, updated_at) on product_reviews to authenticated;
grant delete on product_reviews to authenticated;
grant all on product_reviews to service_role;

-- ── Reviews for a product, with the reviewer's name ──
-- A function rather than a view with a join to profiles: reviewers' email
-- addresses live on that table, and a join is one careless select away from
-- publishing them. This returns a name and nothing else identifying.
create or replace function public.product_reviews_for(p_product_id uuid)
returns table (
  id uuid,
  rating smallint,
  body text,
  author text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $fn$
  select r.id,
         r.rating,
         r.body,
         coalesce(nullif(btrim(p.full_name), ''), 'A customer') as author,
         r.created_at
    from product_reviews r
    left join profiles p on p.id = r.user_id
   where r.product_id = p_product_id
     and r.hidden_at is null
   order by r.created_at desc;
$fn$;

grant execute on function public.product_reviews_for(uuid) to anon, authenticated, service_role;

-- ── Rating summary, for the product card and page header ──
create or replace function public.product_rating(p_product_id uuid)
returns table (average numeric, total bigint)
language sql
stable
security definer
set search_path = public
as $fn$
  select round(avg(rating)::numeric, 1) as average,
         count(*) as total
    from product_reviews
   where product_id = p_product_id
     and hidden_at is null;
$fn$;

grant execute on function public.product_rating(uuid) to anon, authenticated, service_role;

-- ── Admin moderation list ──
-- Includes hidden reviews and the reviewer's email, which is exactly why it
-- checks is_admin() first rather than relying on the caller to be careful.
create or replace function public.admin_reviews(p_include_hidden boolean default true)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only admins can read the review list';
  end if;

  select coalesce(jsonb_agg(row_to_json(x) order by x.created_at desc), '[]'::jsonb)
    into result
  from (
    select r.id,
           r.product_id,
           pv.name as product_name,
           pv.slug as product_slug,
           r.rating,
           r.body,
           coalesce(nullif(btrim(p.full_name), ''), 'A customer') as author,
           p.email as author_email,
           r.hidden_at,
           r.created_at
      from product_reviews r
      left join profiles p on p.id = r.user_id
      left join product_versions pv
        on pv.product_id = r.product_id and pv.state = 'published'
     where p_include_hidden or r.hidden_at is null
  ) x;

  return result;
end;
$fn$;

revoke execute on function public.admin_reviews(boolean) from public, anon;
grant execute on function public.admin_reviews(boolean) to authenticated, service_role;

-- ── Hide / unhide, stamping who did it ──
create or replace function public.set_review_hidden(p_id uuid, p_hidden boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.is_admin() then
    raise exception 'Only admins can moderate reviews';
  end if;

  update product_reviews
     set hidden_at = case when p_hidden then now() else null end,
         hidden_by = case when p_hidden then auth.uid() else null end
   where id = p_id;

  return found;
end;
$fn$;

revoke execute on function public.set_review_hidden(uuid, boolean) from public, anon;
grant execute on function public.set_review_hidden(uuid, boolean) to authenticated, service_role;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'product_reviews') as table_present,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
    and proname in ('has_purchased', 'product_reviews_for', 'product_rating',
                    'admin_reviews', 'set_review_hidden')) as functions_present,
  (select count(*) from pg_policies
    where tablename = 'product_reviews') as policies_present,
  (select count(*) from pg_indexes
    where tablename = 'product_reviews'
      and indexname = 'product_reviews_one_per_customer') as unique_index_present;
