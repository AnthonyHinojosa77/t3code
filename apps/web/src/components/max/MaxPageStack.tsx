import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import type { CouncilPage } from "./councilPages";

/** Pages behind the front one sit this much further right each, like a stack of paper. */
const PEEK_STEP_PX = 8;
const PEEK_PAGES = 3;
const AXIS_LOCK_PX = 8;
const TURN_FRACTION = 0.25;
const TURN_VELOCITY = 0.4;
const RUBBER_BAND = 0.3;
const EASING = "cubic-bezier(0.22, 0.9, 0.3, 1)";
/** How far the moving page tilts about its spine at the middle of a turn. */
const LIFT_DEG = 12;
/** Keyframes sampled along a settle so the tilt and shadow rise and fall with the slide. */
const SETTLE_SAMPLES = 9;

function peek(k: number): number {
  return k <= 0 ? 0 : Math.min(k, PEEK_PAGES) * PEEK_STEP_PX;
}

/**
 * Resting x (px) of a page `k` positions from the front, for a stack `width` px wide. Turned
 * pages wait fully off to the left; pages behind step to the right so their edges show.
 */
export function restingX(k: number, width: number): number {
  return k <= 0 ? k * width : peek(k);
}

/**
 * x (px) of page `k` while turning: `progress` is -1..1, negative when turning forward. Each
 * page slides linearly to the position it will rest at after the turn, so the next page's edge
 * lands exactly where the front page sits.
 */
export function turningX(k: number, width: number, progress: number, canTurn: boolean): number {
  const from = restingX(k, width);
  if (!canTurn) return from + progress * width * RUBBER_BAND;
  const to = restingX(progress < 0 ? k - 1 : k + 1, width);
  return from + (to - from) * Math.abs(progress);
}

/** The page moving over the stack: the front page going forward, the previous one coming back. */
export function liftingPage(progress: number): -1 | 0 {
  return progress > 0 ? -1 : 0;
}

/** The page under the moving one; it carries the moving page's shadow. */
export function shadedPage(progress: number): 0 | 1 {
  return progress > 0 ? 0 : 1;
}

/**
 * How far page `k` is lifted off the stack, 0..1: flat at rest at either end of a turn, highest
 * halfway, and only ever the moving page. Rubber-banding at the ends lifts nothing.
 */
export function lift(k: number, progress: number, canTurn: boolean): number {
  if (!canTurn || progress === 0 || k !== liftingPage(progress)) return 0;
  const value = Math.sin(Math.PI * Math.min(1, Math.abs(progress)));
  return value < 1e-6 ? 0 : value;
}

/** The inline transform for page `k` mid-turn: the slide, plus a tilt about the spine for the moving page. */
export function pageTransform(
  k: number,
  width: number,
  progress: number,
  canTurn: boolean,
): string {
  const x = `translateX(${turningX(k, width, progress, canTurn)}px)`;
  const tilt = lift(k, progress, canTurn);
  return tilt === 0 ? x : `${x} rotateY(${(-LIFT_DEG * tilt).toFixed(3)}deg)`;
}

export function settleDecision(input: {
  readonly progress: number;
  readonly velocity: number;
  readonly canNext: boolean;
  readonly canPrev: boolean;
}): -1 | 0 | 1 {
  if (input.canNext && (input.progress < -TURN_FRACTION || input.velocity < -TURN_VELOCITY))
    return 1;
  if (input.canPrev && (input.progress > TURN_FRACTION || input.velocity > TURN_VELOCITY))
    return -1;
  return 0;
}

export function settleDuration(remainingPx: number, velocityPxPerMs: number): number {
  const speed = Math.max(Math.abs(velocityPxPerMs), 0.9);
  return Math.min(420, Math.max(180, Math.round(remainingPx / speed)));
}

interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  offset: number;
  width: number;
  locked: "x" | "y" | null;
  samples: { x: number; t: number }[];
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function shadeOf(page: HTMLElement): HTMLElement | null {
  return page.querySelector<HTMLElement>(":scope > .max-page-shade");
}

/** Clears the inline motion so the page sits where its CSS variables put it. */
function restPage(page: HTMLElement): void {
  page.style.transform = "";
  page.style.opacity = "";
  const shade = shadeOf(page);
  if (shade) shade.style.opacity = "";
}

function isTextTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

export function MaxPageStack({
  pages,
  index,
  onIndexChange,
  renderPage,
  label,
}: {
  readonly pages: ReadonlyArray<CouncilPage>;
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly renderPage: (page: CouncilPage, current: boolean) => ReactNode;
  readonly label: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const animations = useRef<Animation[]>([]);
  const settling = useRef(false);
  const lastWheel = useRef(0);
  const [turning, setTurning] = useState(false);
  const count = pages.length;

  const pageElements = () =>
    Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-max-page]") ?? []);

  // The resting layout comes from CSS variables set on each page below, so after React commits a
  // new index the held animations are released before paint and nothing jumps.
  // oxlint-disable-next-line t3code/react-effect-budget -- Web Animations hold inline transforms until the committed layout matches; only a layout effect can release them after the commit and before paint.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.dataset.pageIndex = String(index);
    root.dataset.pageCount = String(count);
    for (const animation of animations.current) animation.cancel();
    animations.current = [];
    for (const page of root.querySelectorAll<HTMLElement>("[data-max-page]")) restPage(page);
    settling.current = false;
    root.removeAttribute("data-turning");
  }, [index, count]);

  const measureWidth = () => rootRef.current?.getBoundingClientRect().width ?? 0;

  const positionPages = (progress: number, width: number) => {
    const canTurn = progress < 0 ? index < count - 1 : index > 0;
    const shaded = shadedPage(progress);
    const shadow = lift(liftingPage(progress), progress, canTurn);
    pageElements().forEach((page) => {
      const k = Number(page.dataset.k);
      page.style.transform = pageTransform(k, width, progress, canTurn);
      const shade = shadeOf(page);
      if (shade) shade.style.opacity = String(k === shaded ? shadow : 0);
    });
  };

  /** Animates every page from where it is to its resting place at `index + delta`, then commits. */
  const settle = (delta: -1 | 0 | 1, width: number, fromProgress: number, velocity: number) => {
    const elements = pageElements();
    const target = index + delta;
    const finish = () => {
      if (delta === 0) {
        for (const animation of animations.current) animation.cancel();
        animations.current = [];
        for (const page of elements) restPage(page);
        settling.current = false;
        rootRef.current?.removeAttribute("data-turning");
        setTurning(false);
        return;
      }
      setTurning(false);
      onIndexChange(target);
    };
    settling.current = true;
    rootRef.current?.setAttribute("data-turning", "true");
    setTurning(true);
    if (reducedMotion()) {
      // A short crossfade instead of a slide.
      const current = elements.find((page) => Number(page.dataset.k) === 0);
      const next = elements.find((page) => Number(page.dataset.k) === delta);
      for (const page of elements) page.style.transform = "";
      const pending: Animation[] = [];
      if (delta !== 0 && current && next) {
        next.style.transform = "translateX(0px)";
        next.style.opacity = "0";
        pending.push(
          current.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" }),
        );
        pending.push(
          next.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, fill: "forwards" }),
        );
      }
      animations.current = pending;
      void Promise.all(pending.map((animation) => animation.finished.catch(() => {}))).then(finish);
      return;
    }
    const canTurn = fromProgress < 0 ? index < count - 1 : index > 0;
    // Progress at the end of the settle: back to rest, or a full turn in the chosen direction.
    const endProgress = delta === 0 ? 0 : -delta;
    const remaining = Math.abs(endProgress - fromProgress) * width;
    const duration = settleDuration(Math.max(remaining, width * 0.1), velocity);
    const options = { duration, easing: EASING, fill: "forwards" as const };
    // Sampled keyframes: the slide is linear in progress, the lift rises and falls with it.
    const samples = Array.from(
      { length: SETTLE_SAMPLES },
      (_, i) =>
        [
          i / (SETTLE_SAMPLES - 1),
          fromProgress + (endProgress - fromProgress) * (i / (SETTLE_SAMPLES - 1)),
        ] as const,
    );
    const pending = elements.flatMap((page) => {
      const k = Number(page.dataset.k);
      const list = [
        page.animate(
          samples.map(([offset, progress]) => ({
            offset,
            transform: pageTransform(k, width, progress, canTurn),
          })),
          options,
        ),
      ];
      const shade = shadeOf(page);
      if (shade)
        list.push(
          shade.animate(
            samples.map(([offset, progress]) => ({
              offset,
              opacity:
                k === shadedPage(progress) ? lift(liftingPage(progress), progress, canTurn) : 0,
            })),
            options,
          ),
        );
      return list;
    });
    animations.current = pending;
    void Promise.all(pending.map((animation) => animation.finished.catch(() => {}))).then(finish);
  };

  const turnTo = (target: number) => {
    if (target < 0 || target >= count || target === index || settling.current) return;
    const delta: -1 | 1 = target > index ? 1 : -1;
    // Keyboard, buttons and the wheel jump one page at a time; farther targets commit directly.
    if (Math.abs(target - index) > 1) {
      onIndexChange(target);
      return;
    }
    settle(delta, measureWidth(), 0, 0);
  };

  /** Starts a drag at a screen point; `offset` carries over a settle that was interrupted. */
  const beginGesture = useStableCallback((x: number, y: number, pointerId: number) => {
    if (count < 2) return false;
    let offset = 0;
    const width = measureWidth();
    if (settling.current) {
      // Take over a settling turn where it is: the front page's current translate is the offset.
      const front = pageElements().find((page) => Number(page.dataset.k) === 0);
      if (front) offset = new DOMMatrix(getComputedStyle(front).transform).m41;
      for (const animation of animations.current) animation.cancel();
      animations.current = [];
      settling.current = false;
      rootRef.current?.removeAttribute("data-turning");
      setTurning(false);
      if (width > 0) positionPages(Math.max(-1, Math.min(1, offset / width)), width);
    }
    gesture.current = {
      pointerId,
      startX: x,
      startY: y,
      offset,
      width,
      locked: offset === 0 ? null : "x",
      samples: [{ x, t: performance.now() }],
    };
    return offset !== 0;
  });

  /** Returns the locked axis after this move, so touch handlers know whether to stop scrolling. */
  const moveGesture = useStableCallback((x: number, y: number, t: number): "x" | "y" | null => {
    const g = gesture.current;
    if (!g || g.locked === "y" || g.width === 0) return g?.locked ?? null;
    const dx = x - g.startX + g.offset;
    const dy = y - g.startY;
    if (g.locked === null) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK_PX) return null;
      g.locked = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (g.locked === "y") return "y";
      rootRef.current?.setAttribute("data-dragging", "true");
    }
    g.samples.push({ x, t });
    if (g.samples.length > 6) g.samples.shift();
    positionPages(Math.max(-1, Math.min(1, dx / g.width)), g.width);
    return "x";
  });

  const endGesture = useStableCallback((x: number, cancelled: boolean) => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    rootRef.current?.removeAttribute("data-dragging");
    if (g.locked !== "x" || g.width === 0) return;
    const dx = x - g.startX + g.offset;
    const progress = Math.max(-1, Math.min(1, dx / g.width));
    const first = g.samples[0]!;
    const last = g.samples[g.samples.length - 1]!;
    const velocity = last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
    const delta = cancelled
      ? 0
      : settleDecision({ progress, velocity, canNext: index < count - 1, canPrev: index > 0 });
    settle(delta, g.width, progress, velocity);
  });

  const startsOnControl = (target: EventTarget | null) =>
    target instanceof Element && target.closest("button, a, select, input, textarea") !== null;

  // Mouse and pen arrive as pointer events. Touch is handled below with native listeners:
  // Chromium cancels the pointer sequence as soon as a finger moves over a scrollable page,
  // so a horizontal finger drag has to stop the scroll itself with preventDefault.
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch" || !event.isPrimary || event.button !== 0) return;
    if (startsOnControl(event.target)) return;
    if (beginGesture(event.clientX, event.clientY, event.pointerId)) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (event.pointerType === "touch" || !g || g.pointerId !== event.pointerId) return;
    const wasLocked = g.locked;
    const locked = moveGesture(event.clientX, event.clientY, event.timeStamp);
    if (locked === "x" && wasLocked !== "x") event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const g = gesture.current;
    if (event.pointerType === "touch" || !g || g.pointerId !== event.pointerId) return;
    endGesture(event.clientX, cancelled);
  };

  const [attachTouch] = useState(() => (node: HTMLDivElement | null) => {
    if (!node) return;
    const controller = new AbortController();
    const { signal } = controller;
    let touchId: number | null = null;
    node.addEventListener(
      "touchstart",
      (event) => {
        if (touchId !== null || event.touches.length !== 1) return;
        const touch = event.touches[0]!;
        if (startsOnControl(event.target)) return;
        touchId = touch.identifier;
        beginGesture(touch.clientX, touch.clientY, touch.identifier);
      },
      { passive: true, signal },
    );
    node.addEventListener(
      "touchmove",
      (event) => {
        if (touchId === null) return;
        const touch = Array.from(event.changedTouches).find((t) => t.identifier === touchId);
        if (!touch) return;
        const locked = moveGesture(touch.clientX, touch.clientY, event.timeStamp);
        // Only a horizontal drag claims the gesture; vertical moves keep native scrolling.
        if (locked === "x" && event.cancelable) event.preventDefault();
      },
      { passive: false, signal },
    );
    const finish = (cancelled: boolean) => (event: TouchEvent) => {
      if (touchId === null) return;
      const touch = Array.from(event.changedTouches).find((t) => t.identifier === touchId);
      if (!touch) return;
      touchId = null;
      endGesture(touch.clientX, cancelled);
    };
    node.addEventListener("touchend", finish(false), { passive: true, signal });
    node.addEventListener("touchcancel", finish(true), { passive: true, signal });
    return () => controller.abort();
  });

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isTextTarget(event.target)) return;
    const next =
      event.key === "ArrowRight" || event.key === "PageDown"
        ? index + 1
        : event.key === "ArrowLeft" || event.key === "PageUp"
          ? index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? count - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    turnTo(next);
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (Math.abs(event.deltaX) < 20 || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    if (event.timeStamp - lastWheel.current < 600) return;
    lastWheel.current = event.timeStamp;
    turnTo(event.deltaX > 0 ? index + 1 : index - 1);
  };

  return (
    <div className="max-pages-frame">
      <div
        ref={(node) => {
          rootRef.current = node;
          return attachTouch(node);
        }}
        role="region"
        aria-label={label}
        aria-roledescription="pages"
        tabIndex={0}
        className="max-pages"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => onPointerEnd(event, false)}
        onPointerCancel={(event) => onPointerEnd(event, true)}
        onKeyDown={onKeyDown}
        onWheel={onWheel}
      >
        {pages.map((page, i) => {
          const k = i - index;
          return (
            <article
              key={page.id}
              data-max-page=""
              data-page-id={page.id}
              data-k={k}
              data-position={k === 0 ? "current" : k > 0 ? "behind" : "turned"}
              inert={k !== 0 || undefined}
              aria-hidden={k !== 0 || undefined}
              className="max-page"
              style={
                {
                  "--k": k,
                  "--peek": `${peek(k)}px`,
                  // Turned pages come back over the front page; pages behind stay under it.
                  zIndex: k < 0 ? 2 * count - k : count - k,
                  visibility: k > PEEK_PAGES ? "hidden" : undefined,
                } as CSSProperties
              }
            >
              {renderPage(page, k === 0)}
              <div className="max-page-shade" aria-hidden="true" />
            </article>
          );
        })}
        {index < count - 1 ? (
          <button
            type="button"
            className="max-page-edge"
            aria-label="Next page"
            onClick={() => turnTo(index + 1)}
          />
        ) : null}
      </div>
      <div className="max-pages-nav" data-turning={turning || undefined}>
        <button
          type="button"
          className="max-icon-button"
          aria-label="Previous page"
          disabled={index === 0}
          onClick={() => turnTo(index - 1)}
        >
          <ChevronLeftIcon aria-hidden="true" className="size-4" />
        </button>
        <p className="max-pages-position" aria-live="polite">
          <span data-page-position="">
            {index + 1} of {count}
          </span>
          {count <= 8 ? (
            <span className="max-pages-dots" aria-hidden="true">
              {pages.map((page, i) => (
                <span key={page.id} data-active={i === index || undefined} />
              ))}
            </span>
          ) : null}
        </p>
        <button
          type="button"
          className="max-icon-button"
          aria-label="Next page"
          disabled={index >= count - 1}
          onClick={() => turnTo(index + 1)}
        >
          <ChevronRightIcon aria-hidden="true" className="size-4" />
        </button>
      </div>
    </div>
  );
}
