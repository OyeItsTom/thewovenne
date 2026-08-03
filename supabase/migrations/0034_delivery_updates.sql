-- 0034 — How the customer wants to hear about their delivery
--
-- ONE CHANNEL THAT WORKS, ONE THAT IS HONEST ABOUT WAITING.
--
-- Email is the default because it is the only channel actually wired up:
-- Resend, on a verified domain, costing nothing at this volume. It is also the
-- channel the order confirmation and the receipt already use, so choosing it
-- adds no new failure mode.
--
-- WhatsApp is offered because in India it is where people actually read
-- things — but its send path is still a TODO in app/api/whatsapp/webhook,
-- and it needs a Business API provider plus template approval before a single
-- message goes out. So the preference is RECORDED and not yet acted on, and
-- the checkout says exactly that rather than implying a message is coming.
--
-- SMS is deliberately absent. India's DLT regime requires registering the
-- entity, the sender ID and every template with the telecom operators before
-- anything sends, and it costs per message — a lot of compliance for the
-- weakest of the three experiences.
--
-- Email always gets the confirmation regardless of this choice: it is the
-- receipt for a payment, not marketing, and it is not the customer's to
-- decline. This column governs the PROGRESS updates that follow.

do $$ begin
  create type delivery_update_channel as enum ('email', 'whatsapp');
exception when duplicate_object then null; end $$;

alter table orders
  add column if not exists delivery_updates delivery_update_channel
    not null default 'email';

comment on column orders.delivery_updates is
  'Channel the customer chose for delivery progress updates. whatsapp is
   recorded but not yet sent — no provider is connected. The order
   confirmation always goes by email regardless.';

-- Lets the sending job find "whatsapp was chosen but never sent" once a
-- provider exists, without scanning every order ever placed.
create index if not exists orders_delivery_updates_idx
  on orders (delivery_updates)
  where delivery_updates <> 'email';

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name = 'delivery_updates') as column_present,
  (select count(*) from pg_type where typname = 'delivery_update_channel') as enum_present,
  (select count(*) from orders where delivery_updates = 'email') as existing_default_to_email;
