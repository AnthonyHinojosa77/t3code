import { CouncilError } from "./types.ts";
import type { CouncilCoordinator } from "./councilCoordinator.ts";
export const COUNCIL_BODY_LIMIT = 256 * 1024;
export interface CouncilResponse {
  status: number;
  body?: unknown;
}
export async function councilRoute(
  coordinator: CouncilCoordinator,
  method: string,
  path: string,
  body: Buffer,
): Promise<CouncilResponse> {
  try {
    if (body.length > COUNCIL_BODY_LIMIT)
      throw new CouncilError(400, "Request body exceeds 256 KB");
    const url = new URL(path, "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const json = () => {
      try {
        return JSON.parse(body.toString("utf8")) as unknown;
      } catch {
        throw new CouncilError(400, "Invalid JSON");
      }
    };
    if (parts[0] !== "api" || parts[1] !== "council")
      throw new CouncilError(404, "Unknown council route");
    if (parts[2] === "templates") {
      if (parts.length === 3 && method === "GET")
        return { status: 200, body: { templates: coordinator.templates.list() } };
      if (parts.length === 3 && method === "POST")
        return { status: 201, body: { template: coordinator.templates.save(json()) } };
      if (parts.length === 4 && method === "PUT")
        return { status: 200, body: { template: coordinator.templates.save(json(), parts[3]!) } };
      if (parts.length === 4 && method === "DELETE") {
        coordinator.templates.delete(parts[3]!);
        return { status: 204 };
      }
    }
    if (parts[2] === "rounds") {
      if (
        parts.length === 7 &&
        parts[4] === "threads" &&
        parts[6] === "continue" &&
        method === "POST"
      )
        return coordinator.continueThread(parts[3]!, parts[5]!).then(
          (body) => ({ status: 200, body }),
          (error: unknown) => ({
            status: error instanceof CouncilError ? error.status : 502,
            body: {
              error:
                error instanceof CouncilError ? error.message : "Could not restore council thread",
            },
          }),
        );

      if (parts.length === 3 && method === "POST")
        return { status: 201, body: { round: coordinator.create(json()) } };
      if (parts.length === 3 && method === "GET") {
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 20;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
          throw new CouncilError(400, "limit must be 1..100");
        return { status: 200, body: { rounds: coordinator.store.list(limit) } };
      }
      if (parts.length === 4 && method === "GET")
        return { status: 200, body: { round: coordinator.store.get(parts[3]!) } };
      if (parts.length === 5 && parts[4] === "cancel" && method === "POST")
        return { status: 200, body: { round: coordinator.cancel(parts[3]!) } };
    }
    throw new CouncilError(404, "Unknown council route");
  } catch (error) {
    return {
      status: error instanceof CouncilError ? error.status : error instanceof URIError ? 400 : 500,
      body: { error: error instanceof CouncilError ? error.message : "Council request failed" },
    };
  }
}
