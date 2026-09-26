-- Did stock ever change without a reason? — READ ONLY, for the owner
--
-- One SELECT. It writes nothing, repairs nothing and decides nothing: every row
-- it returns is a question for a human, answered against the shelf and the
-- order history. Run it exactly as described in the stock-integrity PR, in the
-- Supabase SQL Editor. The tests run it inside `begin read only`, which Postgres
-- would refuse if it tried to write anything.
--
-- Three sections, one table of results:
--
-- ══ section = 'publication' — unsized products ══
--
-- Before 0060, publishing promoted the draft row wholesale, so the live stock
-- after a publish was whatever the draft held. For each publication:
--
--   prev_stock        the outgoing version's stock when it was archived (an
--                     archived row is never updated again, so its column IS it);
--   stock_at_publish  the incoming version's stock now (or when it was itself
--                     archived) minus every movement logged while it was live —
--                     unsized stock is only ever changed on the live row, and
--                     since 0038 every such change writes a movement;
--   changed_by        stock_at_publish - prev_stock: what the publish itself did
--                     to the shelf. It should be 0.
--
--   finding                     confidence
--   consistent                  conclusive     the publish left stock alone
--   first publication           conclusive     opening stock; nothing to compare
--                                              (whatever the log covers)
--   restored moved stock        candidate      the draft carried a figure from
--                                              before movements that happened
--                                              while it was open, and nobody
--                                              edited the draft's stock:
--                                              changed_by = −(net movement). The
--                                              defect's exact signature.
--   intentional draft edit      candidate      an admin changed the draft's stock
--                                              (the old workflow) and nothing
--                                              moved while it was open
--   unexplained                 needs review   anything else, including both
--   (any other finding)         inconclusive   the draft was opened before the
--                                              movement log began (params below),
--                                              so nothing about it is provable
--
-- `detail` splits the movements during the draft into sales, cancellations and
-- returns, and corrections and restocks — a draft open across a sale AND a
-- cancellation can net to zero and still read consistent, which is right: the
-- shelf ended where it should.
--
-- ══ section = 'size overwrite' — sized products, candidates only ══
--
-- Before 0060 the product form wrote every size's LOADED count back. When a sale
-- landed while the form was open, that save logged a positive 'correction'
-- ("Edited in the product form") on a size that had just sold. Listed: every
-- such correction with a sale of the same size in the 24 hours before it. A
-- genuine recount looks identical, so these are candidates, never conclusions.
-- When the sale landed between the form's read and its write, nothing was
-- logged at all; the next section is the only place that shows.
--
-- ══ section = 'size balance' — sized products ══
--
-- A size's count should equal the sum of its movements, because save_product_
-- sizes (0039 onwards) logs sizes as they are added. Listed: sizes where it does
-- not. Sizes created before 0039 were never logged, so a mismatch is only a
-- candidate; `detail` shows the earliest movement for context.
--
-- ══ What none of it can see ══
--
--   * Anything before stock_movements existed (0038), and — unless the owner
--     sets confirmed_log_start — anything before its first row.
--   * movement.created_at is its transaction's START time. A sale that began
--     just before a publish and committed after it is counted in the draft's
--     window, not the live one; that can only raise a false flag
--     (unexplained / restored), never make a bad publish read consistent
--     unless two such errors cancel exactly.
--   * It reports admin notes and product slugs only: no order, customer or
--     admin identifiers.
--   * Products that changed between sized and unsized: they appear in the
--     section matching what they are NOW.
--   * A pre-0060 cancellation whose return matched no row still wrote a
--     movement; it shows here as 'unexplained', not as itself.
--   * Audit rows name the version (from 0040) or the product (0014–0039), so the
--     draft-edit check accepts either; an admin editing the LIVE row directly in
--     the same window would count as a draft edit.
--
-- A candidate is evidence, not proof that a piece was sold twice. Whether it was
-- is answered by the orders after it.

-- When the movement log began. NOT KNOWN: 0038 (which created
-- stock_movements) was merged on 8 August 2026 (dac9dcc), but the moment it was
-- applied to production was never recorded — 0057's ledger backfill has no
-- timestamps. So by default the log is taken to start at its EARLIEST ROW,
-- which it provably cannot predate. That is conservative: a draft opened
-- before the first logged movement reads 'inconclusive' rather than being
-- vouched for. If the owner establishes the real application time from other
-- evidence, set confirmed_log_start to it; nothing else should go here.
with params as (
  select null::timestamptz as confirmed_log_start
),
first_movement as (
  select coalesce((select confirmed_log_start from params),
                  (select min(created_at) from stock_movements),
                  'infinity'::timestamptz) as at
),
unsized as (
  select p.id from products p
   where not exists (select 1 from product_sizes s where s.product_id = p.id)
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
         (select jsonb_build_object(
                   'net',                  coalesce(sum(m.delta), 0),
                   'sales',                coalesce(sum(m.delta) filter (where m.reason = 'sale'), 0),
                   'cancellations_returns',coalesce(sum(m.delta) filter (where m.reason in ('cancellation', 'return')), 0),
                   'corrections_restocks', coalesce(sum(m.delta) filter (where m.reason in ('correction', 'restock')), 0))
            from stock_movements m
           where m.product_id = v.product_id
             and m.created_at >= v.created_at
             and m.created_at <  v.published_at)
           as while_draft,
         exists (select 1 from admin_audit_log a
                  where a.table_name = 'product_versions'
                    and a.record_id in (v.id, v.product_id)
                    and a.action = 'update'
                    and a.actor_id is not null
                    and a.changes ? 'stock_quantity'
                    and a.created_at >= v.created_at
                    and a.created_at <  v.published_at)
           as draft_stock_edited,
         v.created_at >= (select at from first_movement)
           as log_covers
    from v
),
publication as (
  select 'publication'::text                                     as section,
         p.slug,
         null::text                                              as size_label,
         x.published_at                                          as at,
         case
           when x.prev_stock is null then 'first publication'
           when (x.stock_quantity - x.moved_while_live) = x.prev_stock then 'consistent'
           when not x.draft_stock_edited and (x.while_draft ->> 'net')::int <> 0
                and (x.stock_quantity - x.moved_while_live) - x.prev_stock = -(x.while_draft ->> 'net')::int
             then 'restored moved stock'
           when x.draft_stock_edited and (x.while_draft ->> 'net')::int = 0 then 'intentional draft edit'
           else 'unexplained'
         end                                                     as finding,
         x.log_covers,
         (x.stock_quantity - x.moved_while_live) - x.prev_stock  as changed_by,
         jsonb_build_object(
           'version', x.version, 'draft_opened', x.created_at,
           'prev_stock', x.prev_stock, 'stock_at_publish', x.stock_quantity - x.moved_while_live,
           'movements_while_draft', x.while_draft, 'draft_stock_edited', x.draft_stock_edited) as detail
    from x join products p on p.id = x.product_id
),
size_overwrite as (
  select 'size overwrite'::text, p.slug, c.size_label, c.created_at,
         'correction re-added a size that had just sold'::text,
         true,
         c.delta,
         jsonb_build_object(
           'correction_note', c.note,
           'sales_of_that_size_in_prior_24h',
             (select coalesce(sum(-s.delta), 0) from stock_movements s
               where s.product_id = c.product_id and s.reason = 'sale'
                 and lower(coalesce(s.size_label, '')) = lower(c.size_label)
                 and s.created_at between c.created_at - interval '24 hours' and c.created_at))
    from stock_movements c
    join products p on p.id = c.product_id
   where c.reason = 'correction' and c.delta > 0 and c.size_label is not null
     and c.note = 'Edited in the product form'
     and exists (select 1 from stock_movements s
                  where s.product_id = c.product_id and s.reason = 'sale'
                    and lower(coalesce(s.size_label, '')) = lower(c.size_label)
                    and s.created_at between c.created_at - interval '24 hours' and c.created_at)
),
size_balance as (
  select 'size balance'::text, p.slug, ps.label, now(),
         'size count differs from its movement history'::text,
         false,
         ps.stock_quantity - coalesce(m.total, 0),
         jsonb_build_object('count', ps.stock_quantity, 'movements_total', coalesce(m.total, 0),
                            'first_movement', m.first_at)
    from product_sizes ps
    join products p on p.id = ps.product_id
    left join lateral (
      select sum(sm.delta)::int as total, min(sm.created_at) as first_at
        from stock_movements sm
       where sm.product_id = ps.product_id and lower(coalesce(sm.size_label, '')) = lower(ps.label)
    ) m on true
   where ps.stock_quantity <> coalesce(m.total, 0)
),
everything as (
  select * from publication
  union all select * from size_overwrite
  union all select * from size_balance
)
select section,
       slug,
       size_label,
       at,
       finding,
       case
         when finding = 'first publication' then 'conclusive'
         when not log_covers and section = 'publication' then 'inconclusive'
         when finding = 'consistent' then 'conclusive'
         when finding = 'unexplained' then 'needs review'
         else 'candidate'
       end as confidence,
       changed_by,
       detail
  from everything
 order by case when finding in ('consistent', 'first publication') then 1 else 0 end,
          section, slug, at;
