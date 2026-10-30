import type { CouncilRuntimeMode } from "./engineClient.ts";
import type { ModelSelection } from "../../../contracts/src/modelSelection.ts";
export type ModelSelectionOptions = ModelSelection["options"];
export interface CouncilModelInput {
  instanceId: string;
  model: string;
  options?: ModelSelectionOptions | null;
}
export interface CouncilRole {
  id: string;
  name: string;
  instruction: string;
}
export interface CouncilTemplate {
  id: string;
  name: string;
  description: string;
  format: "meta-debate" | "freeform";
  builtIn: boolean;
  roles: CouncilRole[];
  synthesizerInstruction: string;
}
export interface CouncilContenderInput extends CouncilModelInput {
  roleId?: string | null;
}
export interface CouncilRoundInput {
  prompt: string;
  templateId: string;
  projectId: string | null;
  contenders: CouncilContenderInput[];
  synthesizer: CouncilModelInput;
}
export type ContenderStatus =
  | "pending"
  | "running"
  | "needs-attention"
  | "complete"
  | "failed"
  | "timed-out"
  | "cancelled";
export interface CouncilContenderState extends CouncilModelInput {
  key: string;
  options: ModelSelectionOptions | null;
  roleId: string | null;
  roleName: string | null;
  runtimeMode?: CouncilRuntimeMode | null;
  threadId: string | null;
  status: ContenderStatus;
  text: string;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface CouncilStructuredSynthesis {
  consensus: string[];
  disagreements: string[];
  verdict: string;
  uncertainties: string[];
}
export interface CouncilSynthesisState extends CouncilModelInput {
  options: ModelSelectionOptions | null;
  runtimeMode?: CouncilRuntimeMode | null;
  threadId: string | null;
  status: "pending" | "running" | "complete" | "failed" | "skipped" | "cancelled";
  format: "meta-debate" | "freeform";
  text: string;
  structured: CouncilStructuredSynthesis | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface CouncilRound {
  id: string;
  prompt: string;
  templateId: string;
  templateName: string;
  projectId: string | null;
  status: "running" | "synthesizing" | "complete" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  contenders: CouncilContenderState[];
  synthesis: CouncilSynthesisState;
}
export class CouncilError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
