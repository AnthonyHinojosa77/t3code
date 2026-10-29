import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { returnToCouncil } from "./maxMode";

/** Agent mode's way back to the council home, sized for T3's existing header rows. */
export function MaxCouncilReturn({ className }: { readonly className?: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      aria-label="Back to Council"
      onClick={() => returnToCouncil(() => navigate({ to: "/" }))}
      className={cn(
        "max-scope inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-(--max-line-strong) px-2 text-xs text-(--max-green) hover:border-(--max-green) focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-(--max-green) motion-safe:transition-colors",
        className,
      )}
    >
      <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
      <span aria-hidden="true" className="max-wordmark font-bold">
        MAX
      </span>
      <span aria-hidden="true" className="max-sm:hidden">
        Council
      </span>
    </button>
  );
}
