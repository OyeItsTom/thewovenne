"use client";

import { useEffect, useRef } from "react";

/**
 * §0 layer 3 — interactive weave on the product image. A faint thread grid
 * overlaid on the photo; the threads bow away from the pointer, like running a
 * hand across cloth. Click-transparent (pointer-events-none) so the lightbox
 * still opens. The parent passes pointer coords; reduced-motion renders nothing.
 */
export default function ImageWeaveOverlay({
  pointer,
}: {
  pointer: { x: number; y: number; active: boolean };
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef(pointer);
  pointerRef.current = pointer;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let disposed = false;
    let w = 0;
    let h = 0;
    const gap = 22;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = () => {
      const pt = pointerRef.current;
      ctx.clearRect(0, 0, w, h);
      const strength = pt.active ? 1 : 0;
      if (strength === 0) {
        // idle: keep a whisper-faint static weave so the cloth reads as woven
        ctx.globalAlpha = 0.05;
      } else {
        ctx.globalAlpha = 0.12;
      }
      ctx.strokeStyle = "#C9A84C";
      ctx.lineWidth = 1;

      const bow = (x: number, y: number) => {
        if (!pt.active) return 0;
        const d = Math.hypot(x - pt.x, y - pt.y);
        const r = 90;
        return d > r ? 0 : (1 - d / r) * 8;
      };

      for (let y = gap; y < h; y += gap) {
        ctx.beginPath();
        for (let x = 0; x <= w; x += 8) {
          const yy = y + bow(x, y);
          x === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
      for (let x = gap; x < w; x += gap) {
        ctx.beginPath();
        for (let y = 0; y <= h; y += 8) {
          const xx = x + bow(x, y);
          y === 0 ? ctx.moveTo(xx, y) : ctx.lineTo(xx, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    resize();
    const loop = () => {
      if (disposed) return;
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    window.addEventListener("resize", resize);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
