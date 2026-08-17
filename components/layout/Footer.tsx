import Image from "next/image";
import Link from "next/link";
import { Instagram, Mail, MessageCircle } from "lucide-react";
import { cPath } from "@/lib/country";
import { getContent, getPublishedPages } from "@/lib/storefront";
import { whatsappHrefFor } from "@/lib/whatsapp";
import { resolveConnectRows, resolveExploreItems } from "@/lib/footer";

/**
 * The footer.
 *
 * EDITABLE, BUT NOT THE IDENTITY. Wording, links and contact destinations come
 * from the `footer` block in site_content, so the owner changes them in Admin →
 * Footer and publishes them like any other copy. The emblem, the wordmark and
 * the copyright do not: they are what the business is rather than what it says,
 * and a text field is the wrong place to be able to lose them.
 *
 * NOTHING HERE DECIDES WHETHER A LINK IS SAFE. Every judgement — is this an
 * internal path, is that an Instagram address, is that a usable number — lives
 * in lib/footer and lib/whatsapp as a pure function, and each returns either a
 * value or null. This component renders what survives that and nothing else, so
 * an unconfigured or mistyped row is an absent row rather than a broken link.
 *
 * PREVIEW COMES FREE. getContent() runs through lib/storefront, so an admin
 * previewing drafts sees the draft footer on every page.
 */

const ROW =
  "group/row -mx-2 grid grid-cols-[1rem_1fr] items-center gap-x-3 rounded-sm px-2 py-1.5 " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/70";

const ICON = "h-4 w-4 text-cream/40 transition-colors group-hover/row:text-gold/90";

const ROW_TEXT =
  "min-w-0 text-sm leading-6 text-cream/65 transition-colors group-hover/row:text-cream";

const HEADING =
  "font-body text-[11px] font-medium uppercase tracking-[0.16em] text-gold/90";

const CONNECT_ICON = {
  whatsapp: MessageCircle,
  email: Mail,
  instagram: Instagram,
} as const;

export default async function Footer() {
  const [footer, allPages] = await Promise.all([
    getContent("footer"),
    getPublishedPages(),
  ]);

  const explore = resolveExploreItems(
    allPages.filter((page) => page.in_footer).map(({ slug, title }) => ({ slug, title })),
    footer.explore
  );

  // The owner's number if they have set one, the environment's otherwise, and
  // no WhatsApp row at all if neither is usable.
  const waHref =
    whatsappHrefFor(footer.whatsapp?.number, "Hi, I'm interested in THE WOVENNE products") ??
    whatsappHrefFor(
      process.env.NEXT_PUBLIC_WHATSAPP_NUMBER,
      "Hi, I'm interested in THE WOVENNE products"
    );

  const connect = resolveConnectRows(footer, waHref);
  const description = footer.brand_description_visible === false
    ? ""
    : (footer.brand_description ?? "").trim();
  const bottomNote =
    footer.bottom_note_visible === false ? "" : (footer.bottom_note ?? "").trim();

  return (
    <footer className="relative overflow-hidden bg-ink text-cream">
      <div className="bg-weave-light absolute inset-0" aria-hidden />

      {/*
       * Slightly tighter than the site's section-padding. A footer is read last
       * and briefly; the page's own rhythm would leave it standing taller than
       * anything it contains.
       */}
      <div className="container-wovenne relative grid gap-x-8 gap-y-12 py-14 md:grid-cols-12 md:py-20">
        {/* Brand — the widest column, because the description sets the tone. */}
        <div className="md:col-span-5">
          <Link
            href="/in"
            className="inline-flex items-center gap-2.5 font-heading text-2xl leading-none tracking-[0.01em] md:text-3xl rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/70"
          >
            {/* The emblem is dark maroon on transparent, so it would vanish on
                the ink footer — invert it to white to sit with the cream text. */}
            <Image
              src="/logo_emblem_transparent.png"
              alt=""
              width={3096}
              height={2792}
              sizes="44px"
              className="h-8 w-auto brightness-0 invert md:h-9"
            />
            THE WOVENNE
          </Link>
          {description && (
            <p className="mt-5 max-w-[34ch] text-sm leading-relaxed text-cream/55">
              {description}
            </p>
          )}
        </div>

        {explore.length > 0 && (
          <nav aria-labelledby="footer-explore" className="md:col-span-3">
            <h2 id="footer-explore" className={HEADING}>
              Explore
            </h2>
            {/*
             * Two columns on a phone, one from the point the footer becomes
             * columns of its own. Nine links stacked is most of a screen for
             * something nobody came here to read; two short columns is the same
             * list, deliberately set. The 380px floor keeps the longest label
             * off a second line on the narrowest phones.
             */}
            <ul className="mt-5 grid grid-cols-1 gap-x-6 min-[380px]:grid-cols-2 md:grid-cols-1">
              {explore.map((item) => (
                <li key={item.id}>
                  <Link
                    href={cPath(item.href)}
                    className="-mx-2 inline-block rounded-sm px-2 py-1.5 text-sm leading-6 text-cream/65 transition-colors hover:text-cream focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/70"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}

        {connect.length > 0 && (
          <div className="md:col-span-4">
            <h2 id="footer-connect" className={HEADING}>
              Connect
            </h2>
            {/*
             * ONE ROW SYSTEM, NOT THREE LINKS.
             *
             * WhatsApp, the address and Instagram used to be laid out
             * separately — two in a list with inline icons, Instagram in its own
             * block below as a bare icon with no account name. They read as
             * three things that happened to end up near each other.
             *
             * They are now one grid: a fixed 1rem icon column, one gap, one text
             * column. Same icon width, same text origin, same row height, same
             * type, same hover. The icons are quiet on purpose — they mark the
             * row, they are not the content of it.
             */}
            <ul aria-labelledby="footer-connect" className="mt-5">
              {connect.map((row) => {
                const Icon = CONNECT_ICON[row.kind];
                return (
                  <li key={row.kind}>
                    <a
                      href={row.href}
                      aria-label={
                        row.external ? `${row.label} (opens in a new tab)` : row.label
                      }
                      {...(row.external
                        ? { target: "_blank", rel: "noopener noreferrer" }
                        : {})}
                      className={ROW}
                    >
                      <Icon className={ICON} aria-hidden />
                      <span className={ROW_TEXT}>{row.text}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {/*
       * The quietest line on the site. The year is read from the clock rather
       * than typed, so nothing needs doing on 1 January; the business name is
       * not editable here for the same reason the wordmark above it is not.
       */}
      <div className="container-wovenne relative">
        <div
          className={`flex flex-col items-center gap-1.5 border-t border-cream/10 py-6 text-xs text-cream/45 sm:flex-row sm:gap-4 ${
            bottomNote ? "sm:justify-between" : "sm:justify-center"
          }`}
        >
          {bottomNote && <p>{bottomNote}</p>}
          <p>© {new Date().getFullYear()} THE WOVENNE</p>
        </div>
      </div>
    </footer>
  );
}
