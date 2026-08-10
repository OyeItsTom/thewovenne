import Link from "next/link";
import { cPath } from "@/lib/country";
import { getStyleForProduct } from "@/lib/style";
import StyleGallery from "./StyleGallery";

/**
 * "Styled by our customers", on a product page.
 *
 * THE SAME CARDS AS THE GALLERY, in fewer columns. Two components drawing the
 * same thing differently is how a photograph ends up cropped on one page and not
 * the other; this reuses StyleCard so the two cannot disagree, and the layout
 * follows from the column count alone.
 *
 * IT FETCHES ITS OWN DATA rather than taking a prop. The product page already
 * makes several reads in parallel and this is one more, but it means the section
 * can be dropped into either product route — or into the redesign — without the
 * page above it having to know it exists. Renders nothing at all when there is
 * nothing approved for this piece, which is most pieces most of the time.
 */
export default async function ProductStyleSection({
  productId,
  productName,
}: {
  productId: string;
  productName: string;
}) {
  const items = await getStyleForProduct(productId, 6);
  if (items.length === 0) return null;

  return (
    <section className="mt-24 border-t border-ink/10 pt-16" aria-labelledby="customer-style">
      <div className="text-center">
        <span className="font-script text-2xl text-terracotta">In real life</span>
        <h2 id="customer-style" className="mt-2 font-heading text-3xl text-ink sm:text-4xl">
          Styled by our customers
        </h2>
        <p className="mx-auto mt-3 max-w-md text-sm text-ink/60">
          How people are wearing the {productName}.
        </p>
      </div>

      <div className="mx-auto mt-10 max-w-4xl">
        <StyleGallery items={items} />
      </div>

      <p className="mt-6 text-center">
        <Link
          href={cPath("/customer-style")}
          className="text-xs uppercase tracking-wider text-ink/55 underline decoration-ink/20 underline-offset-4 transition-colors hover:text-terracotta"
        >
          See everything customers have sent us
        </Link>
      </p>
    </section>
  );
}
