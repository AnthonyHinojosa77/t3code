import type { CouncilContenderState } from "./councilApi";
import { MaxResponseCard } from "./MaxResponseCard";
export function MaxResponseGrid({
  contenders,
  describe,
  onContinue,
}: {
  contenders: CouncilContenderState[];
  describe: (instanceId: string, model: string) => string;
  onContinue: (id: string) => void;
}) {
  return (
    <section
      aria-label="Council responses"
      className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3"
    >
      {contenders.map((contender) => (
        <MaxResponseCard
          key={contender.key}
          contender={contender}
          displayName={describe(contender.instanceId, contender.model)}
          onContinue={onContinue}
        />
      ))}
    </section>
  );
}
