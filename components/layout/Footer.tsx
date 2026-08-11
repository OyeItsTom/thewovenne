import Image from "next/image";
import { cPath } from "@/lib/country";
import Link from "next/link";
import { Instagram, Mail, MessageCircle } from "lucide-react";
import { getPublishedPages } from "@/lib/storefront";
import { whatsappHref } from "@/lib/whatsapp";

const INSTAGRAM_URL = "https://www.instagram.com/thewovenne";

/**
 * Our Story has a hand-written link, in a deliberate position, so the CMS page
 * that points at the same route must not print a second one.
 *
 * Matching on the ROUTE, not the title: an admin renaming the page to "About
 * us" would slip past a title match and the duplicate would quietly return.
 */
const HARDCODED_PAGE_SLUGS = new Set(["about"]);

export default async function Footer() {
  // Footer links come from the pages themselves, so adding a page adds its link.
  const pages = (await getPublishedPages()).filter(
    (p) => p.in_footer && !HARDCODED_PAGE_SLUGS.has(p.slug)
  );

  // No number, no link — see lib/whatsapp for why that is the only safe answer.
  const waHref = whatsappHref("Hi, I'm interested in THE WOVENNE products");

  return (
    <footer className="relative overflow-hidden bg-ink text-cream">
      <div className="bg-weave-light absolute inset-0" aria-hidden />

      <div className="container-wovenne section-padding relative grid gap-12 md:grid-cols-4">
        <div className="md:col-span-2">
          <Link href="/in" className="flex items-center gap-2 font-heading text-3xl">
            {/* The emblem is dark maroon on transparent, so it would vanish on
                the ink footer — invert it to white to sit with the cream text. */}
            <Image
              src="/logo_emblem_transparent.png"
              alt=""
              width={3096}
              height={2792}
              sizes="44px"
              className="h-9 w-auto brightness-0 invert"
            />
            THE WOVENNE
          </Link>
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-cream/70">
            Woven in India. Worn for life. Authentic handloom linen, sent
            direct from the source to your door in the UK.
          </p>
        </div>

        <div>
          <h3 className="font-heading text-lg text-gold">Explore</h3>
          <ul className="mt-4 space-y-2 text-sm text-cream/70">
            <li>
              <Link href="/in" className="transition-colors hover:text-cream">
                Home
              </Link>
            </li>
            <li>
              <Link href="/in/shop" className="transition-colors hover:text-cream">
                Shop
              </Link>
            </li>
            <li>
              {/* /about, not the old /#story anchor — that homepage section no
                  longer exists. */}
              <Link href="/in/about" className="transition-colors hover:text-cream">
                Our Story
              </Link>
            </li>
            <li>
              <Link href="/in/journal" className="transition-colors hover:text-cream">
                Journal
              </Link>
            </li>
            <li>
              {/* The same name the header uses. Two labels for one page is how
                  a customer concludes they are two pages. */}
              <Link
                href="/in/customer-style"
                className="transition-colors hover:text-cream"
              >
                Worn by You
              </Link>
            </li>
            {pages.map((page) => (
              <li key={page.id}>
                <Link
                  href={cPath(`/${page.slug}`)}
                  className="transition-colors hover:text-cream"
                >
                  {page.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="font-heading text-lg text-gold">Connect</h3>
          <ul className="mt-4 space-y-2 text-sm text-cream/70">
            {waHref && (
              <li>
                <a
                  href={waHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 transition-colors hover:text-cream"
                >
                  <MessageCircle className="h-4 w-4" /> WhatsApp
                </a>
              </li>
            )}
            <li>
              {/* A written address, spelled out rather than hidden behind the
                  word "email": somebody deciding whether to trust a shop wants
                  to see that there is a person at the other end. */}
              <a
                href="mailto:hello@thewovenne.com"
                className="inline-flex items-center gap-2 transition-colors hover:text-cream"
              >
                <Mail className="h-4 w-4" /> hello@thewovenne.com
              </a>
            </li>
          </ul>
          {/* NO FACEBOOK ICON UNTIL THERE IS A FACEBOOK PAGE. It linked to "#",
              which scrolls to the top and looks like a bug. An icon that goes
              nowhere costs more trust than an absent one. */}
          <div className="mt-5 flex gap-4 text-cream/70">
            <a
              href={INSTAGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="THE WOVENNE on Instagram (@thewovenne)"
              className="transition-colors hover:text-cream"
            >
              <Instagram className="h-5 w-5" />
            </a>
          </div>
        </div>
      </div>

      <div className="container-wovenne relative border-t border-cream/10 py-6 text-center text-xs text-cream/50">
        Made with care in India · © {new Date().getFullYear()} THE WOVENNE
      </div>
    </footer>
  );
}
