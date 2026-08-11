import { Instagram } from "lucide-react";

const INSTAGRAM_URL = "https://www.instagram.com/thewovenne";

/**
 * The invitation to follow — with no feed behind it yet.
 *
 * WHAT WAS HERE: six square cells, each one the same placehold.co image reading
 * "THE WOVENNE" in flat cream, each linking to the profile. It looked, at a
 * glance, like a real feed of six posts. It was one placeholder repeated — a
 * grid of nothing, dressed as evidence that people are posting.
 *
 * A shop that shows fake photographs is making a claim it cannot support, and
 * the customer finds out the moment they click through. So the grid is gone
 * rather than restyled. The invitation stays, because that part was always true.
 *
 * NOT A BOX. The obvious empty state — a bordered panel where the grid was — is
 * still a container drawing attention to its own emptiness. This is a
 * typographic block that reads as finished at four products and will read as
 * finished at four hundred: nothing here is waiting to be filled in.
 *
 * WHEN REAL MEDIA EXISTS, the grid returns beneath the handle, and the line of
 * copy is what gives way to it. See the Instagram integration notes in
 * README.md — reading the account's own posts needs an Instagram Business
 * account and a reviewed Meta app, neither of which is a code change.
 *
 * A SERVER COMPONENT NOW. The cells needed framer-motion for their stagger; the
 * text does not need JavaScript at all, so this section ships none. That is the
 * whole of its cost on the homepage's Largest Contentful Paint: nothing.
 */
export default function InstagramGrid() {
  return (
    <section className="section-padding container-wovenne">
      <div className="mx-auto max-w-xl text-center">
        <span className="eyebrow">Follow Along</span>
        <h2 className="mt-3 font-heading text-4xl text-ink sm:text-5xl">
          <a
            href={INSTAGRAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-terracotta"
          >
            @thewovenne
          </a>
        </h2>

        <p className="mt-6 text-base leading-relaxed text-ink/60">
          The cloth on the loom, and the people wearing it. We post it all on
          Instagram first.
        </p>

        <div className="mt-10">
          <a
            href={INSTAGRAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-ink/15 px-6 py-3 text-sm font-medium text-ink transition-colors hover:border-terracotta hover:text-terracotta"
          >
            <Instagram className="h-5 w-5" /> Follow @thewovenne
          </a>
        </div>
      </div>
    </section>
  );
}
