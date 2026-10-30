import type { CouncilRound, CouncilTemplate } from "./councilApi";
export function councilFixture(): { round: CouncilRound; template: CouncilTemplate } {
  const answer = {
    instanceId: "codex",
    model: "gpt-5",
    options: null,
    threadId: "thread-1",
    text: "Start with one well-tested path. **Keep the rollout reversible.**",
    error: null,
    startedAt: "2026-10-29T18:00:00Z",
    finishedAt: null,
  };
  return {
    template: {
      id: "meta-debate",
      name: "Meta-debate",
      description: "Compare independent perspectives",
      format: "meta-debate",
      builtIn: true,
      roles: [{ id: "critic", name: "Critic", instruction: "Find risks" }],
      synthesizerInstruction: "Compare the answers",
    },
    round: {
      id: "round-1",
      prompt: "How should we launch the council?",
      templateId: "meta-debate",
      templateName: "Meta-debate",
      projectId: null,
      status: "running",
      createdAt: answer.startedAt,
      updatedAt: answer.startedAt,
      contenders: [
        { ...answer, key: "c0", roleId: "critic", roleName: "Critic", status: "running" },
      ],
      synthesis: {
        ...answer,
        threadId: null,
        text: "",
        status: "pending",
        format: "meta-debate",
        structured: null,
      },
    },
  };
}
