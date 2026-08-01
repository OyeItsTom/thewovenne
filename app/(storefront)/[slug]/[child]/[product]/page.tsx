import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import {
  getAllProducts,
  getProductBySlug,
  getProductImages,
  getRelatedProducts,
  getVisibleCategoryTree,
} from "@/lib/storefront";
import { resolveOldPath } from "@/lib/redirects";
import { productHref } from "@/lib/urls";
import ProductDetail from "@/components/product/ProductDetail";
import { DEFAULT_OG_IMAGE } from "@/lib/seo";

/**
 * The canonical product URL — /women/sarees/kerala-kasavu.
 *
 * The path is not just decoration: a product reached through the wrong category
 * redirects to its real one, so the same product cannot be indexed at several
 * URLs and split its own ranking.
 */
export const revalidate = 60;

// A newly published product works without a deploy, which matters because
// adding stock is a routine act. Safe at three segments deep: it cannot swallow
// unrelated paths, and misses render the normal not-found page.
export const dynamicParams = true;

export async function generateStaticParams() {
  const products = await getAllProducts();
  return products
    .filter((p) => p.category_parent_slug && p.category_slug)
    .map((p) => ({
      slug: p.category_parent_slug!,
      child: p.category_slug!,
      product: p.slug,
    }));
}

export async function generateMetadata({
  params,
}: {
  params: { slug: string; child: string; product: string };
}): Promise<Metadata> {
  const product = await getProductBySlug(params.product);
  if (!product) return { title: "Product not found | THE WOVENNE" };

  const description =
    product.description?.slice(0, 155) ??
    "Authentic handloom linen from Kerala.";

  return {
    title: `${product.name} | THE WOVENNE`,
    description,
    // Points at the product's real path, so even if it is reachable elsewhere
    // search engines are told which URL counts.
    alternates: { canonical: productHref(product) },
    openGraph: {
      title: product.name,
      description,
      images: [product.image_url ?? DEFAULT_OG_IMAGE],
    },
  };
}

export default async function ProductPage({
  params,
}: {
  params: { slug: string; child: string; product: string };
}) {
  const product = await getProductBySlug(params.product);

  // Unknown slug: it may be a path this product used to live at, from before a
  // rename or a move between categories. The history table is what keeps those
  // links working instead of quietly 404ing.
  if (!product) {
    const moved = await resolveOldPath(
      `/${params.slug}/${params.child}/${params.product}`
    );
    if (moved) permanentRedirect(moved);
    notFound();
  }

  // Right product, wrong category in the URL — send it to the canonical path
  // rather than serving the same page at two addresses.
  const canonical = productHref(product);
  if (canonical !== `/${params.slug}/${params.child}/${params.product}`) {
    permanentRedirect(canonical);
  }

  const [related, gallery, tree] = await Promise.all([
    getRelatedProducts(product.category_id, product.slug, 4),
    getProductImages(product.id),
    getVisibleCategoryTree(),
  ]);

  // Fall back to the cover image if the gallery is empty, so a product with one
  // photo still renders while its extra shots are being added.
  const images = (gallery.length ? gallery : [product.image_url]).filter(
    (src): src is string => Boolean(src)
  );

  const parent = tree.find((p) => p.slug === params.slug);
  const child = parent?.children.find((c) => c.slug === params.child);

  return (
    <ProductDetail
      product={product}
      images={images}
      related={related}
      breadcrumb={
        parent && child
          ? {
              parent: { slug: parent.slug, name: parent.name },
              child: { slug: child.slug, name: child.name },
            }
          : undefined
      }
    />
  );
}
