// @effect-diagnostics nodeBuiltinImport:off - Tests use isolated template files.
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";

import { it, expect } from "vite-plus/test";
import { fixture } from "./councilTestHelpers.ts";
const custom = {
  name: "Code review",
  description: "Review code",
  format: "freeform",
  roles: [{ name: "Skeptic", instruction: "Find errors" }],
  synthesizerInstruction: "Summarize",
};
it("keeps the code built-in first and never overwrites its disk file", () => {
  using f = fixture();
  const p = NodePath.join(f.templates.directory, "meta-debate.md");
  NodeFS.writeFileSync(p, "user edited");
  expect(f.templates.list()[0]?.builtIn).toBe(true);
  expect(NodeFS.readFileSync(p, "utf8")).toBe("user edited");
  expect(() => f.templates.save(custom, "meta-debate")).toThrow();
  expect(() => f.templates.delete("meta-debate")).toThrow();
});
it("round trips custom markdown, stable role slugs, updates and deletion", () => {
  using f = fixture();
  const t = f.templates.save(custom);
  expect(f.templates.get(t.id)).toEqual(t);
  expect(t.roles[0]?.id).toBe("skeptic");
  expect(() => f.templates.save(custom)).toThrow();
  f.templates.save({ ...custom, description: "changed" }, t.id);
  expect(f.templates.get(t.id).description).toBe("changed");
  f.templates.delete(t.id);
  expect(() => f.templates.get(t.id)).toThrow();
});
it("rejects traversal and duplicate role names", () => {
  using f = fixture();
  expect(() => f.templates.get("../secret")).toThrow();
  expect(() =>
    f.templates.save({ ...custom, roles: [...custom.roles, ...custom.roles] }),
  ).toThrow();
});
