// @effect-diagnostics nodeBuiltinImport:off - The companion is a standalone Node process with a small import graph.
// @effect-diagnostics globalTimers:off - Companion lifecycle and transport use native timers.
// @effect-diagnostics globalDate:off - Persisted lifecycle timestamps use ISO wall-clock time.
import * as NodeSqlite from "node:sqlite";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFS from "node:fs";

import { CouncilError, type CouncilRound, type CouncilTemplate } from "./types.ts";
export class CouncilStore {
  private readonly db: NodeSqlite.DatabaseSync;
  constructor(
    filename = process.env.MAX_COUNCIL_DB ??
      NodePath.join(NodeOS.homedir(), ".t3/max-council.sqlite"),
  ) {
    if (filename !== ":memory:") NodeFS.mkdirSync(NodePath.dirname(filename), { recursive: true });
    this.db = new NodeSqlite.DatabaseSync(filename);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS rounds(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, body TEXT NOT NULL, template TEXT NOT NULL); INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);",
    );
    const version = this.db.prepare("SELECT version FROM schema_version").get();
    if (version?.version !== 1) throw new Error("Unsupported council schema version");
  }
  save(round: CouncilRound, template?: CouncilTemplate) {
    if (template)
      this.db
        .prepare(
          "INSERT INTO rounds VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
        )
        .run(round.id, round.createdAt, JSON.stringify(round), JSON.stringify(template));
    else
      this.db.prepare("UPDATE rounds SET body=? WHERE id=?").run(JSON.stringify(round), round.id);
  }
  get(id: string): CouncilRound {
    const r = this.db.prepare("SELECT body FROM rounds WHERE id=?").get(id);
    if (!r) throw new CouncilError(404, "Round not found");
    return JSON.parse(String(r.body));
  }
  template(id: string): CouncilTemplate {
    const r = this.db.prepare("SELECT template FROM rounds WHERE id=?").get(id);
    if (!r) throw new CouncilError(404, "Round not found");
    return JSON.parse(String(r.template));
  }
  all(): CouncilRound[] {
    return this.db
      .prepare("SELECT body FROM rounds ORDER BY created_at DESC, rowid DESC")
      .all()
      .map((r) => JSON.parse(String(r.body)) as CouncilRound);
  }
  list(limit = 20) {
    return this.all()
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        prompt: r.prompt.slice(0, 200),
        status: r.status,
        templateName: r.templateName,
        contenderCount: r.contenders.length,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
  }
  close() {
    this.db.close();
  }
}
