import { expect, it, vi } from "vite-plus/test";
import { councilApi, GATEWAY_MESSAGE, isRoundActive } from "./councilApi";

it("sends same-origin credentials, options and roles unchanged", async () => {
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ round: { id: "round-1" } }), { status: 201 }));
  const input = {
    prompt: "Question",
    templateId: "meta-debate",
    projectId: null,
    contenders: [
      {
        instanceId: "codex",
        model: "gpt",
        options: [{ id: "fastMode", value: true }],
        roleId: "critic",
      },
    ],
    synthesizer: { instanceId: "codex", model: "gpt" },
  };
  await expect(councilApi.createRound(input)).resolves.toEqual({ round: { id: "round-1" } });
  expect(fetch).toHaveBeenCalledWith(
    "/api/council/rounds",
    expect.objectContaining({
      credentials: "include",
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
});
it("explains an absent gateway and preserves server validation errors", async () => {
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("{}", { status: 404 }))
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Too many contenders" }), { status: 400 }),
    );
  await expect(councilApi.templates()).rejects.toThrow(GATEWAY_MESSAGE);
  await expect(councilApi.rounds()).rejects.toThrow(GATEWAY_MESSAGE);
  await expect(
    councilApi.createRound({
      prompt: "",
      templateId: "x",
      projectId: null,
      contenders: [],
      synthesizer: { instanceId: "x", model: "y" },
    }),
  ).rejects.toThrow("Too many contenders");
  expect(fetch).toHaveBeenCalledTimes(3);
});
it("encodes resource identifiers and accepts empty delete responses", async () => {
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 204 }));
  await councilApi.deleteTemplate("a/b");
  expect(fetch).toHaveBeenCalledWith(
    "/api/council/templates/a%2Fb",
    expect.objectContaining({ method: "DELETE" }),
  );
});
it("polls only running and synthesizing rounds", () => {
  expect(isRoundActive("running")).toBe(true);
  expect(isRoundActive("synthesizing")).toBe(true);
  for (const status of ["complete", "failed", "cancelled"] as const)
    expect(isRoundActive(status)).toBe(false);
});
