import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPostBySlug, getPublishedPosts } from "@/lib/journal";
import { DEFAULT_OG_IMAGE } from "@/lib/seo";

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
  const description = post.body?.slice(0, 155) ?? undefined;
  return {
    title: `${post.title} | THE WOVENNE Journal`,
    description,
    openGraph: {
      title: post.title,
      description,
      images: [post.image_url ?? DEFAULT_OG_IMAGE],
    },
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
        href="/journal"
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
