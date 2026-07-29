import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getVisibleCategoryTree } from "@/lib/categories";
import { getProductsByCategoryIds } from "@/lib/products";
import ProductGrid from "@/components/shop/ProductGrid";

// Root-level dynamic segment for parent categories (/men, /women, …). Next
// resolves static routes first, so /shop, /cart, /journal, /admin, /product/*
// and /api/* are unaffected; anything else unmatched lands here and 404s.
export const revalidate = 60;

export async function generateStaticParams() {
  const tree = await getVisibleCategoryTree();
  return tree.map((parent) => ({ parent: parent.slug }));
}

async function findParent(slug: string) {
  const tree = await getVisibleCategoryTree();
  return tree.find((p) => p.slug === slug) ?? null;
}

export async function generateMetadata({
  params,
}: {
  params: { parent: string };
}): Promise<Metadata> {
  const parent = await findParent(params.parent);
  if (!parent) return {};

  const title = `${parent.name} | THE WOVENNE`;
  const description = `Handloom linen for ${parent.name.toLowerCase()} — woven in Kerala, sent direct from the loom.`;

  return { title, description, openGraph: { title, description } };
}

export default async function CategoryLandingPage({
  params,
}: {
  params: { parent: string };
}) {
  const parent = await findParent(params.parent);
  if (!parent) notFound();

  const products = await getProductsByCategoryIds(
    parent.children.map((c) => c.id)
  );

  return (
    <div className="container-wovenne section-padding">
      <div className="text-center">
        <p className="eyebrow">The Collection</p>
        <h1 className="mt-3 font-heading text-display-sm text-ink md:text-display-md">
          {parent.name}
        </h1>
      </div>

      {parent.children.length > 1 && (
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          {parent.children.map((child) => (
            <Link
              key={child.id}
              href={`/shop?category=${child.slug}`}
              className="rounded-full border border-ink/15 px-4 py-2 text-xs uppercase tracking-widest text-ink/70 transition-colors hover:border-terracotta hover:text-terracotta"
            >
              {child.name}
            </Link>
          ))}
        </div>
      )}

      <div className="mt-12">
        {products.length === 0 ? (
          <p className="py-20 text-center text-sm text-ink/60">
            This collection is still on the loom. Please check back soon.
          </p>
        ) : (
          <ProductGrid products={products} />
        )}
      </div>
    </div>
  );
}
