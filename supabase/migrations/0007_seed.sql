-- 0007 — Seed data
-- Categories, placeholder products, homepage content, journal posts.
-- All idempotent; safe to skip entirely on a database that already has data.

-- ── Seed: categories (Men / Women → sub-categories) ─
-- Only Women → Sarees is visible at launch; the rest are hidden until their
-- product lines are ready. Toggle visibility later from the admin Category tab.
insert into categories (name, slug, parent_id, is_visible, sort_order) values
  ('Men', 'men', null, true, 1),
  ('Women', 'women', null, true, 2)
on conflict (slug) do nothing;

insert into categories (name, slug, parent_id, is_visible, sort_order)
select v.name, v.slug, p.id, v.is_visible, v.sort_order
from (values
  ('Shirts',        'shirts',        'men',   false, 1),
  ('Kurtas',        'kurtas',        'men',   false, 2),
  ('Trousers',      'trousers',      'men',   false, 3),
  ('Nehru Jackets', 'nehru-jackets', 'men',   false, 4),
  ('Sarees',        'sarees',        'women', true,  1),
  ('Kurtis',        'kurtis',        'women', false, 2),
  ('Dresses',       'dresses',       'women', false, 3),
  ('Blouses',       'blouses',       'women', false, 4),
  ('Sets',          'sets',          'women', false, 5),
  ('Home',          'home',          'women', false, 6),
  ('Accessories',   'accessories',   'women', false, 7)
) as v(name, slug, parent_slug, is_visible, sort_order)
join categories p on p.slug = v.parent_slug
on conflict (slug) do nothing;

-- ── Seed: 10 sample products (temporary placeholders) ─
-- Prices in INR (₹) — launching in Kerala, India first. Images are placeholders;
-- replace with real photos via the admin dashboard (Supabase Storage upload).
insert into products (name, slug, description, price_inr, fabric, colour, stock_quantity, image_url, is_active)
values
  ('Kochi Linen Shirt', 'kochi-linen-shirt', 'A breathable pure-linen shirt, hand-loomed on the Malabar coast. Relaxed collar, mother-of-pearl buttons, softens beautifully with every wash.', 1899, 'Pure Linen', 'Natural', 14, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Malabar Kurta', 'malabar-kurta', 'A straight-cut kurta in a soft linen-cotton blend — light enough for Kerala heat, elegant enough for evenings. Side slits, deep pockets.', 2299, 'Linen-Cotton', 'Off-White', 9, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Varkala Linen Trousers', 'varkala-linen-trousers', 'Wide-leg trousers in heavyweight linen with an elasticated drawstring waist. Woven to move with you, from beach to table.', 1799, 'Linen', 'Sand', 11, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Onam Ivory Saree', 'onam-ivory-saree', 'A handwoven kasavu-inspired saree in ivory with a fine gold border — a quiet, ceremonial classic from the Kerala loom.', 3999, 'Handloom Cotton', 'Ivory / Gold', 5, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Kerala Handloom Throw', 'kerala-handloom-throw', 'A handwoven cotton throw in a natural stripe, finished with hand-tied tassels. Made on a traditional pit loom.', 1499, 'Handloom Cotton', 'Natural / Indigo', 18, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Backwater Linen Dress', 'backwater-linen-dress', 'An easy midi dress in washed linen — unstructured, pocketed, and endlessly wearable. Cut for airflow and grace.', 2599, 'Washed Linen', 'Sage', 7, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Fort Kochi Overshirt', 'fort-kochi-overshirt', 'An unstructured overshirt in undyed raw linen. Slubby texture, patch pockets — gets better with every wear.', 2199, 'Raw Linen', 'Undyed', 0, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Alleppey Lounge Set', 'alleppey-lounge-set', 'A matched linen shirt-and-shorts set for slow mornings. Breathable, soft, and quietly refined.', 2999, 'Linen', 'Clay', 6, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Muslin Scarf', 'muslin-scarf', 'A featherlight handwoven muslin scarf — the finishing note. Folds to nothing, drapes like air.', 999, 'Handloom Muslin', 'Ecru', 20, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Coir & Linen Tote', 'coir-linen-tote', 'A sturdy market tote woven from coir and linen, with reinforced handles. Kerala craft, built for daily life.', 1199, 'Coir / Linen', 'Natural', 13, 'https://placehold.co/900x1200/F0EAD6/1C1F3B?text=THE+WOVENNE', true)
on conflict (slug) do nothing;

-- Map the seed products onto the new relational categories (only where unset,
-- so re-running never clobbers categories set later from the admin panel).
update products p set category_id = c.id
from categories c
where p.category_id is null and c.slug = case p.slug
  when 'kochi-linen-shirt'       then 'shirts'
  when 'malabar-kurta'           then 'kurtas'
  when 'varkala-linen-trousers'  then 'trousers'
  when 'onam-ivory-saree'        then 'sarees'
  when 'kerala-handloom-throw'   then 'home'
  when 'backwater-linen-dress'   then 'dresses'
  when 'fort-kochi-overshirt'    then 'shirts'
  when 'alleppey-lounge-set'     then 'sets'
  when 'muslin-scarf'            then 'accessories'
  when 'coir-linen-tote'         then 'accessories'
end;

-- ── Seed: editable homepage content ──────────
insert into site_content (key, value) values
  ('home_hero', '{"eyebrow":"Woven in India · Worn for life","heading":"THE WOVENNE","subheading":"Authentic, handcrafted linen — sent direct from the loom houses of Kerala to your door. From the loom, to you. Nothing in between.","cta_label":"Explore the Collection","cta_href":"/shop"}'),
  ('why_linen', '{"title":"Why linen","cards":[{"title":"Kind to your skin","text":"Naturally breathable and hypoallergenic — linen keeps you cool and comfortable all day."},{"title":"Kinder to the earth","text":"Flax needs little water and no irrigation. Woven by hand, it treads lightly."},{"title":"Made to last","text":"Linen softens with every wash and outlives fast fashion by decades."}]}'),
  ('brand_story', '{"title":"From the loom, to you","body":"THE WOVENNE works directly with handloom artisans across Kerala. No middleman, no compromise — just honest cloth, woven the way it has been for generations, sent straight to you."}')
on conflict (key) do nothing;

-- ── Seed: journal posts ──────────────────────
insert into journal_posts (title, slug, body, image_url, published)
values
  ('The pit loom of Kerala', 'the-pit-loom-of-kerala', 'For centuries, Kerala''s weavers have worked at the pit loom — feet below the ground, hands at the warp. Every metre of our cloth begins here.', 'https://placehold.co/1200x800/F0EAD6/1C1F3B?text=THE+WOVENNE', true),
  ('Why we choose linen', 'why-we-choose-linen', 'Linen is the oldest woven fibre known to us. It breathes, it lasts, and it asks little of the land. This is why every WOVENNE piece begins with flax.', 'https://placehold.co/1200x800/F0EAD6/1C1F3B?text=THE+WOVENNE', true)
on conflict (slug) do nothing;
