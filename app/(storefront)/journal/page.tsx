import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { getPublishedPosts } from "@/lib/storefront";
import WovenSeam from "@/components/weave/WovenSeam";
import { DEFAULT_OG_IMAGE } from "@/lib/seo";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "The Journal | THE WOVENNE",
  description:
    "Stories from our Kerala weavers, care guides, and notes from the loom.",
  openGraph: {
    title: "The Journal | THE WOVENNE",
    description:
      "Stories from our Kerala weavers, care guides, and notes from the loom.",
    images: [DEFAULT_OG_IMAGE],
  },
};

export default async function JournalPage() {
  const posts = await getPublishedPosts();

  return (
    <div className="bg-weave">
      <div className="container-wovenne section-padding">
        <header className="text-center">
          <p className="eyebrow">From the loom</p>
          <h1 className="mt-3 font-heading text-display-sm text-ink md:text-display-md">
            The Journal
          </h1>
          <p className="mx-auto mt-4 max-w-prose text-base leading-relaxed text-ink/70">
            Stories from our weavers, care guides, and notes on the journey from
            the Kerala loom to your home.
          </p>
        </header>

        <WovenSeam />

        {posts.length === 0 ? (
          <p className="py-16 text-center text-ink/60">
            New stories are on the loom — check back soon.
          </p>
        ) : (
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {posts.map((post) => (
              <Link
                key={post.id}
                href={`/journal/${post.slug}`}
                className="group block overflow-hidden rounded-2xl bg-cream shadow-soft transition-shadow hover:shadow-lift"
              >
                <div className="relative aspect-[3/2] overflow-hidden bg-linen">
                  <Image
                    src={post.image_url ?? "https://placehold.co/1200x800/F0EAD6/1C1F3B?text=THE+WOVENNE"}
                    alt={post.title}
                    fill
                    sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                    className="object-cover transition-transform duration-700 ease-cloth group-hover:scale-105"
                  />
                </div>
                <div className="p-6">
                  <h2 className="font-heading text-2xl text-ink">{post.title}</h2>
                  {post.body && (
                    <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-ink/70">
                      {post.body}
                    </p>
                  )}
                  <span className="mt-4 inline-block text-eyebrow uppercase text-terracotta">
                    Read the story →
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
