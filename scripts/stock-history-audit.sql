-- Did any past publish change an unsized product's stock? — READ ONLY
--
-- For the owner, to run once against production AFTER reviewing it, inside a
-- read-only transaction:
--
--   begin read only;
--   \i scripts/stock-history-audit.sql
--   rollback;
--
-- It writes nothing, repairs nothing, and decides nothing. Every row it returns
-- is a question for a human, answered against the shelf and the order history.
--
-- ══ WHAT IT RECONSTRUCTS ══
--
-- Before 0060, publishing a product promoted its draft row wholesale, so the
-- live stock after a publish was whatever the draft held. For each publication
-- of an unsized product this works out:
--
--   prev_stock        the outgoing version's stock when it was archived. An
--                     archived row is never updated again (0056 skips them), so
--                     its stock_quantity IS that figure.
--   stock_at_publish  the incoming version's stock at the moment it went live:
--                     its stock now (or when it was itself archived), minus
--                     every movement logged while it was live. Unsized stock
--                     is changed only on the published row, and every such
--                     change since 0038 writes a movement.
--   changed_by        stock_at_publish - prev_stock: what the publish itself
--                     did to the shelf. It should be 0.
--
-- and classifies the difference:
--
--   consistent            the publish left stock alone.
--   first publication     a new product's opening stock; nothing to compare.
--   SUSPECT               the draft carried a figure from before movements that
--                         happened while it was open, and nobody edited the
--                         draft's stock: changed_by = -moved_while_draft. This
--                         is the defect's exact signature.
--   intentional edit      an admin changed the draft's stock (the old workflow
--                         put stock edits in the draft) and nothing moved while
--                         it was open.
--   UNEXPLAINED           anything else — including a mix of both.
--
-- ══ WHAT IT CANNOT SEE ══
--
--   * Anything before stock_movements existed (0038). A version live before the
--     first movement row reads as if nothing moved; `log_covers` says which.
--   * Sized products. Their stock lives in product_sizes and 0056 re-derives
--     the version column, so a publish could not overwrite it the same way;
--     products that have sizes NOW are excluded. A product that gained sizes
--     later is excluded with them — its unsized history needs a manual look.
--   * A pre-0060 cancellation whose release_stock matched no row still wrote a
--     movement. That surfaces here as an UNEXPLAINED window, not as itself.
--   * Audit rows name the version (from 0040) or the product (0014–0039), so the
--     draft-edit check accepts either; an admin editing the LIVE row directly in
--     the same window would be counted as a draft edit.
--
-- A SUSPECT row is evidence that stock was put back, not proof that a piece was
-- sold twice. Whether it was is answered by the orders after it.

with unsized as (
  select p.id
    from products p
   where not exists (select 1 from product_sizes s where s.product_id = p.id)
),
first_movement as (
  select min(created_at) as at from stock_movements
),
v as (
  select pv.product_id, pv.id, pv.version, pv.stock_quantity, pv.created_at, pv.published_at,
         lag(pv.stock_quantity) over w as prev_stock,
         lead(pv.published_at)  over w as archived_at
    from product_versions pv
   where pv.product_id in (select id from unsized)
     and pv.published_at is not null
  window w as (partition by pv.product_id order by pv.published_at, pv.version)
),
x as (
  select v.*,
         coalesce((select sum(m.delta) from stock_movements m
                    where m.product_id = v.product_id
                      and m.created_at >= v.published_at
                      and m.created_at <  coalesce(v.archived_at, 'infinity'::timestamptz)), 0)::int
           as moved_while_live,
         coalesce((select sum(m.delta) from stock_movements m
                    where m.product_id = v.product_id
                      and m.created_at >= v.created_at
                      and m.created_at <  v.published_at), 0)::int
           as moved_while_draft,
         exists (select 1 from admin_audit_log a
                  where a.table_name = 'product_versions'
                    and a.record_id in (v.id, v.product_id)
                    and a.action = 'update'
                    and a.actor_id is not null
                    and a.changes ? 'stock_quantity'
                    and a.created_at >= v.created_at
                    and a.created_at <  v.published_at)
           as draft_stock_edited,
         (select at from first_movement) is not null
           and v.created_at >= (select at from first_movement)
           as log_covers
    from v
)
select p.slug,
       x.version,
       x.created_at   as draft_opened,
       x.published_at,
       x.prev_stock,
       x.stock_quantity - x.moved_while_live                  as stock_at_publish,
       (x.stock_quantity - x.moved_while_live) - x.prev_stock as changed_by,
       x.moved_while_draft,
       x.draft_stock_edited,
       x.log_covers,
       case
         when x.prev_stock is null then 'first publication'
         when (x.stock_quantity - x.moved_while_live) = x.prev_stock then 'consistent'
         when not x.draft_stock_edited and x.moved_while_draft <> 0
              and (x.stock_quantity - x.moved_while_live) - x.prev_stock = -x.moved_while_draft
           then 'SUSPECT'
         when x.draft_stock_edited and x.moved_while_draft = 0 then 'intentional edit'
         else 'UNEXPLAINED'
       end as finding
  from x
  join products p on p.id = x.product_id
 order by (case when x.prev_stock is null
                  or (x.stock_quantity - x.moved_while_live) = x.prev_stock then 1 else 0 end),
          p.slug, x.published_at;
