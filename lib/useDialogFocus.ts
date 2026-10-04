"use client";

import { useEffect, useRef, type RefObject } from "react";
import { focusableWithin, nextTrapTarget } from "./focusTrap";

/**
 * What a modal dialog owes the keyboard, for dialogs that are not the centred
 * <Modal> — the mobile filter drawer is the first.
 *
 * The same contract components/ui/Modal.tsx keeps, on the same trap decision
 * (lib/focusTrap): focus moves into the panel on open; every other child of
 * <body> is made `inert` (only what this marked is unmarked); Tab wraps inside;
 * Escape closes; body scroll is locked and restored rather than cleared; focus
 * returns to the opener if it is still on the page. The panel must therefore be
 * PORTALLED to <body>, with `root` the portal's outermost element.
 *
 * Modal keeps its own inline copy, deliberately: scripts/a11y-foundation.test.ts
 * pins that file's source, and moving it here belongs to its own change.
 */
export function useDialogFocus(
  isOpen: boolean,
  onClose: () => void,
  root: RefObject<HTMLElement>,
  panel: RefObject<HTMLElement>
) {
  // A ref, so a fresh arrow function from the parent each render does not tear
  // the trap down and pull focus back to the panel.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;

    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const madeInert: Element[] = [];
    const rootNode = root.current;
    if (rootNode) {
      for (const sibling of Array.from(document.body.children)) {
        if (sibling === rootNode || sibling.hasAttribute("inert")) continue;
        if (sibling.tagName === "SCRIPT" || sibling.tagName === "STYLE") continue;
        sibling.setAttribute("inert", "");
        madeInert.push(sibling);
      }
    }

    panel.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const node = panel.current;
      if (!node) return;
      const target = nextTrapTarget(
        focusableWithin(node),
        document.activeElement,
        node,
        event.shiftKey
      );
      if (target) {
        event.preventDefault();
        target.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      for (const el of madeInert) el.removeAttribute("inert");
      if (opener && opener.isConnected) opener.focus?.();
    };
    // The refs are stable objects; only opening and closing rebuild the trap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
}
