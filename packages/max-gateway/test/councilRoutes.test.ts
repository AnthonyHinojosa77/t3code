import { it, expect } from "vite-plus/test";
import { fixture, input } from "./councilTestHelpers.ts";
import { councilRoute } from "../src/council/councilRoutes.ts";
it("validates bodies, models, roles, count, limits and unknown ids/routes", async () => {
  using f = fixture();
  const route = (body: unknown) =>
    councilRoute(f.coordinator, "POST", "/api/council/rounds", Buffer.from(JSON.stringify(body)));
  for (const body of [
    {},
    { ...input, prompt: " " },
    { ...input, contenders: [] },
    { ...input, contenders: [input.contenders[0], input.contenders[0]] },
    { ...input, templateId: "missing" },
    { ...input, contenders: [{ ...input.contenders[0], roleId: "missing" }] },
  ])
    expect((await route(body)).status).toBe(400);
  expect(
    (await councilRoute(f.coordinator, "GET", "/api/council/rounds/missing", Buffer.alloc(0)))
      .status,
  ).toBe(404);
  expect(
    (await councilRoute(f.coordinator, "GET", "/api/council/nope", Buffer.alloc(0))).status,
  ).toBe(404);
  expect(
    (await councilRoute(f.coordinator, "GET", "/api/council/rounds?limit=101", Buffer.alloc(0)))
      .status,
  ).toBe(400);
  expect(
    (await councilRoute(f.coordinator, "POST", "/api/council/rounds", Buffer.alloc(262145))).status,
  ).toBe(400);
});
it("GET never starts work and built-ins return 409", async () => {
  using f = fixture();
  expect(
    (await councilRoute(f.coordinator, "GET", "/api/council/templates", Buffer.alloc(0))).status,
  ).toBe(200);
  expect(f.engine.launches).toHaveLength(0);
  expect(
    (
      await councilRoute(
        f.coordinator,
        "DELETE",
        "/api/council/templates/meta-debate",
        Buffer.alloc(0),
      )
    ).status,
  ).toBe(409);
});

it("restores only a thread belonging to the requested round", async () => {
  using f = fixture();
  const r = f.coordinator.create(input);
  const call = (id: string) =>
    councilRoute(
      f.coordinator,
      "POST",
      `/api/council/rounds/${r.id}/threads/${id}/continue`,
      Buffer.alloc(0),
    );
  expect(await call("foreign")).toMatchObject({ status: 404 });
  expect(f.engine.unarchives).toEqual([]);
  expect(await call(r.contenders[0]!.threadId!)).toEqual({
    status: 200,
    body: { threadId: r.contenders[0]!.threadId },
  });
  expect(f.engine.unarchives).toEqual([r.contenders[0]!.threadId]);
});
