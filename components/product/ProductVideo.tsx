"use client";

import { useState } from "react";
import { Play } from "lucide-react";
import { youtubeEmbedUrl, youtubeThumbnail } from "@/lib/youtube";

/**
 * The product's own video.
 *
 * A FACADE, NOT AN IFRAME. Nothing from YouTube is requested until the visitor
 * clicks: no player script, no cookies, no third-party requests on a page most
 * people will never press play on. An iframe that merely lazy-loads still pulls
 * several hundred kilobytes the moment it scrolls into view, and #74 spent real
 * effort getting weight off these pages.
 *
 * The thumbnail is a plain img with loading="lazy" rather than next/image. The
 * original reason — i.ytimg.com not being in the remote host allow-list — no
 * longer holds (#105 added it for customer video submissions), but the reason it
 * stays is unchanged: this is one already-sized 480px JPEG on a CDN, and routing
 * it through the optimizer would spend a transform on something that needs none.
 */
export default function ProductVideo({
  videoId,
  productName,
}: {
  videoId: string;
  productName: string;
}) {
  const [playing, setPlaying] = useState(false);

  return (
    /* The first thing below the fold, so it carries the same rhythm as every
       section under it — rule, script line, serif heading — rather than reading
       as a small block bolted under the buy panel. */
    <section className="mt-24 border-t border-ink/10 pt-16" aria-labelledby="see-it-worn">
      <div className="text-center">
        <span className="font-script text-2xl text-terracotta">In motion</span>
        <h2 id="see-it-worn" className="mt-2 font-heading text-3xl text-ink sm:text-4xl">
          See it worn
        </h2>
      </div>
      <div className="mx-auto mt-10 max-w-3xl overflow-hidden rounded-2xl bg-ink/5">
        {playing ? (
          <div className="relative aspect-video">
            <iframe
              src={`${youtubeEmbedUrl(videoId)}&autoplay=1`}
              title={`${productName} — video`}
              // autoplay is in the URL because the visitor has just clicked
              // play. It never autoplays on load, which is the thing that
              // actually annoys people.
              allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              className="absolute inset-0 h-full w-full"
            />
          </div>
        ) : (
          <button
            onClick={() => setPlaying(true)}
            className="group relative block aspect-video w-full"
            aria-label={`Play the video for ${productName}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element --
                next/image would require adding i.ytimg.com to the remote host
                allow-list in next.config.mjs, and widening that for one 480px
                JPEG that is already lazy and already served from a CDN is a
                worse trade than the warning. */}
            <img
              src={youtubeThumbnail(videoId)}
              alt=""
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover"
            />
            <span className="absolute inset-0 flex items-center justify-center bg-ink/20 transition-colors group-hover:bg-ink/30">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-cream/90 text-ink shadow-lg transition-transform group-hover:scale-105">
                <Play className="ml-1 h-6 w-6" fill="currentColor" />
              </span>
            </span>
          </button>
        )}
      </div>
    </section>
  );
}
