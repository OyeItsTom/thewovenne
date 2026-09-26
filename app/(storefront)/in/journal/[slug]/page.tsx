import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPostBySlug, getPublishedPosts } from "@/lib/storefront";
import { openGraph } from "@/lib/seo";
import { journalHref } from "@/lib/urls";
import { metaDescription } from "@/lib/metadata";

export const revalidate = 60;

export async function generateStaticParams() {
  const posts = await getPublishedPosts();
  return posts.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const post = await getPostBySlug(params.slug);
  if (!post) return { title: "Story not found | THE WOVENNE" };
  /*
   * A JOURNAL BODY IS PARAGRAPHS. `post.body?.slice(0, 155)` pasted the raw
   * blank lines between them straight into the tag and, far more often than
   * not, ended halfway through a word. metaDescription() collapses the
   * whitespace and cuts at the last space before the limit. THE ARTICLE ITSELF
   * IS UNTOUCHED — this reads it and stores nothing.
   */
  const description = metaDescription(post.body);
  return {
    title: `${post.title} | THE WOVENNE Journal`,
    description,
    // From the post that RESOLVED, not the requested slug. A miss returns above
    // with no canonical at all, and its 404 takes the not-found boundary's
    // noindex metadata instead of this.
    alternates: { canonical: journalHref(post.slug) },
    // "article" — the one route on the site where Next's OpenGraph union has
    // the type that is actually true.
    openGraph: openGraph({
      type: "article",
      title: post.title,
      description,
      path: journalHref(post.slug),
      images: [post.image_url],
    }),
  };
}

export default async function JournalPostPage({
  params,
}: {
  params: { slug: string };
}) {
  const post = await getPostBySlug(params.slug);
  if (!post) notFound();

  return (
    <article className="container-wovenne section-padding max-w-3xl">
      <Link
        href="/in/journal"
        className="text-eyebrow uppercase text-terracotta hover:underline"
      >
        ← The Journal
      </Link>
      <h1 className="mt-6 font-heading text-display-sm text-ink md:text-display-md">
        {post.title}
      </h1>
      {post.image_url && (
        <div className="relative mt-8 aspect-[3/2] overflow-hidden rounded-2xl bg-linen">
          <Image
            src={post.image_url}
            alt={post.title}
            fill
            sizes="(min-width: 768px) 768px, 100vw"
            className="object-cover"
            priority
          />
        </div>
      )}
      <div className="prose-wovenne mt-8 whitespace-pre-wrap text-lg leading-relaxed text-ink/80">
        {post.body}
      </div>
    </article>
  );
}
