"use client";

import { useEffect, useRef, useState } from "react";

/**
 * THE SIGNATURE — the hero weave.
 *
 * A full-width canvas of warp (vertical) and weft (horizontal) threads that
 * interlace into place over ~2.5s, in the brand palette, then rest. Hovering
 * (or touching) gently displaces nearby threads — like a hand across cloth.
 *
 * Performance guardrails (all mandatory, all here):
 *  - prefers-reduced-motion  → render a single static woven frame, no rAF loop.
 *  - low-power / small screen → caller shows the CSS `.weave-fallback` instead
 *    (see `useWeaveTier`); this component only mounts for the full canvas tier.
 *  - lazy-init: the rAF loop starts on the first frame after mount (post-paint),
 *    so it never blocks first paint.
 *  - thread counts are capped and scaled to width to hold 60fps on mid-range mobile.
 */

const INK = "#1C1F3B";
const TERRACOTTA = "#C2714F";
const GOLD = "#C9A84C";
const THREAD_COLORS = [INK, TERRACOTTA, GOLD, INK, GOLD];

const DRAW_MS = 2500;
const EASE = (t: number) => 1 - Math.pow(1 - t, 3); // easeOutCubic — cloth settling

type Pointer = { x: number; y: number; active: boolean };

export default function WeaveCanvas({
  onComplete,
  className = "",
}: {
  onComplete?: () => void;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointer = useRef<Pointer>({ x: 0, y: 0, active: false });
  const [prefersReduced, setPrefersReduced] = useState(false);
  const completedRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReduced(mq.matches);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let start = 0;
    let disposed = false;

    // Grid sizing — capped and width-scaled for a steady 60fps on mobile.
    let spacing = 26;
    let warp = 0; // vertical thread count
    let weft = 0; // horizontal thread count
    let width = 0;
    let height = 0;

    const layout = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Wider spacing on small screens keeps the thread count (and cost) down.
      spacing = width < 640 ? 34 : width < 1024 ? 28 : 24;
      warp = Math.min(Math.ceil(width / spacing) + 1, 90);
      weft = Math.min(Math.ceil(height / spacing) + 1, 70);
    };

    const drawFrame = (progress: number) => {
      const p = EASE(Math.min(progress, 1));
      ctx.clearRect(0, 0, width, height);
      ctx.lineWidth = 1.4;
      ctx.lineCap = "round";

      const pt = pointer.current;
      const displace = (x: number, y: number) => {
        if (!pt.active) return 0;
        const dx = x - pt.x;
        const dy = y - pt.y;
        const dist = Math.hypot(dx, dy);
        const radius = 120;
        if (dist > radius) return 0;
        // Push away from the pointer, softened at the edge of the radius.
        return (1 - dist / radius) * 10;
      };

      // Weft — horizontal threads grow left→right, staggered top to bottom.
      for (let r = 0; r < weft; r++) {
        const y = r * spacing + spacing / 2;
        const stagger = r / (weft + warp);
        const local = Math.max(0, Math.min((p - stagger * 0.5) / 0.5, 1));
        if (local <= 0) continue;
        ctx.globalAlpha = 0.22 + 0.35 * local;
        ctx.strokeStyle = THREAD_COLORS[r % THREAD_COLORS.length];
        ctx.beginPath();
        const end = width * local;
        for (let x = 0; x <= end; x += 6) {
          const wobble = Math.sin((x / spacing) * Math.PI) * 1.1; // over/under interlace
          const yy = y + wobble + displace(x, y);
          x === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }

      // Warp — vertical threads grow top→bottom, offset stagger for the interlace.
      for (let c = 0; c < warp; c++) {
        const x = c * spacing + spacing / 2;
        const stagger = c / (weft + warp);
        const local = Math.max(0, Math.min((p - stagger * 0.5) / 0.5, 1));
        if (local <= 0) continue;
        ctx.globalAlpha = 0.18 + 0.3 * local;
        ctx.strokeStyle = THREAD_COLORS[(c + 2) % THREAD_COLORS.length];
        ctx.beginPath();
        const end = height * local;
        for (let y = 0; y <= end; y += 6) {
          const wobble = Math.cos((y / spacing) * Math.PI) * 1.1;
          const xx = x + wobble + displace(x, y);
          y === 0 ? ctx.moveTo(xx, y) : ctx.lineTo(xx, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    const finish = () => {
      if (completedRef.current) return;
      completedRef.current = true;
      onComplete?.();
    };

    const loop = (ts: number) => {
      if (disposed) return;
      if (!start) start = ts;
      const progress = (ts - start) / DRAW_MS;
      drawFrame(progress);
      if (progress < 1) {
        raf = requestAnimationFrame(loop);
      } else {
        finish();
        // Keep a light idle loop only while the pointer is interacting.
        const idle = (t: number) => {
          if (disposed) return;
          drawFrame(1);
          if (pointer.current.active) raf = requestAnimationFrame(idle);
        };
        raf = requestAnimationFrame(idle);
      }
    };

    layout();

    if (prefersReduced) {
      // Static single frame — no animation, no loop.
      drawFrame(1);
      finish();
    } else {
      raf = requestAnimationFrame(loop);
    }

    const onResize = () => {
      layout();
      if (prefersReduced || completedRef.current) drawFrame(1);
    };

    const setPointer = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      pointer.current = { x: clientX - rect.left, y: clientY - rect.top, active: true };
      // Resume the idle loop so the distortion renders once the weave has settled.
      if (completedRef.current && !prefersReduced) {
        cancelAnimationFrame(raf);
        const idle = (t: number) => {
          if (disposed) return;
          drawFrame(1);
          if (pointer.current.active) raf = requestAnimationFrame(idle);
        };
        raf = requestAnimationFrame(idle);
      }
    };
    const onMove = (e: PointerEvent) => setPointer(e.clientX, e.clientY);
    const onLeave = () => {
      pointer.current.active = false;
      if (completedRef.current) drawFrame(1);
    };

    window.addEventListener("resize", onResize);
    if (!prefersReduced) {
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerleave", onLeave);
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, [prefersReduced, onComplete]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={`h-full w-full ${className}`}
    />
  );
}
