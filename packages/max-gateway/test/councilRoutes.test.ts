import { it, expect } from "vite-plus/test";
import { fixture, input } from "./councilTestHelpers.ts";
import { councilRoute } from "../src/council/councilRoutes.ts";
it("validates bodies, models, roles, count, limits and unknown ids/routes", () => {
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
    expect(route(body).status).toBe(400);
  expect(
    councilRoute(f.coordinator, "GET", "/api/council/rounds/missing", Buffer.alloc(0)).status,
  ).toBe(404);
  expect(councilRoute(f.coordinator, "GET", "/api/council/nope", Buffer.alloc(0)).status).toBe(404);
  expect(
    councilRoute(f.coordinator, "GET", "/api/council/rounds?limit=101", Buffer.alloc(0)).status,
  ).toBe(400);
  expect(
    councilRoute(f.coordinator, "POST", "/api/council/rounds", Buffer.alloc(262145)).status,
  ).toBe(400);
});
it("GET never starts work and built-ins return 409", () => {
  using f = fixture();
  expect(councilRoute(f.coordinator, "GET", "/api/council/templates", Buffer.alloc(0)).status).toBe(
    200,
  );
  expect(f.engine.launches).toHaveLength(0);
  expect(
    councilRoute(f.coordinator, "DELETE", "/api/council/templates/meta-debate", Buffer.alloc(0))
      .status,
  ).toBe(409);
});
