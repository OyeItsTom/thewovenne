#!/bin/sh
# Point a worktree's Next image cache at the main checkout's, so a second
# checkout never re-downloads every product photograph from Supabase.
#
#   scripts/share-image-cache.sh <worktree-path> [main-checkout-path]
#
# WHY. A local `next start` / `next dev` optimizes images exactly like Vercel:
# on a cache miss it downloads the WHOLE source object from Supabase Storage.
# A fresh worktree has an empty .next/cache/images, so its first walk through
# the catalogue pulls every master again. In October 2026 that local traffic
# was over half of the project's Supabase cached egress (see
# docs/image-derivatives.md). Sharing one cache means a photograph is fetched
# once per width on this machine, not once per checkout.
#
# Safe: the cache is content-addressed by Next (url + width + quality + format),
# so two checkouts on different branches can share it. It touches nothing but
# the worktree's .next/cache/images, and refuses if that already holds files
# rather than deleting them.
set -eu

worktree="${1:?usage: scripts/share-image-cache.sh <worktree-path> [main-checkout-path]}"
main="${2:-$(git -C "$worktree" worktree list --porcelain | awk '/^worktree /{print $2; exit}')}"

src="$main/.next/cache/images"
dst="$worktree/.next/cache/images"

if [ "$(cd "$worktree" && pwd)" = "$(cd "$main" && pwd)" ]; then
  echo "That is the main checkout; nothing to share." >&2
  exit 1
fi

mkdir -p "$src" "$worktree/.next/cache"

if [ -L "$dst" ]; then
  echo "Already shared: $dst -> $(readlink "$dst")"
  exit 0
fi
if [ -d "$dst" ] && [ -n "$(ls -A "$dst" 2>/dev/null)" ]; then
  echo "Refusing: $dst already holds cached images. Move them into $src yourself if you want to keep them." >&2
  exit 1
fi
[ -d "$dst" ] && rmdir "$dst"

ln -s "$src" "$dst"
echo "Shared: $dst -> $src"
