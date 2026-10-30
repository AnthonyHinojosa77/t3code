import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
} from "@t3tools/client-runtime/state/attachments";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { attachmentEnvironment } from "../../state/attachments";
import { readEnvironmentScope, readPreparedConnection } from "../../state/session";
import type { CouncilAttachmentMeta } from "./councilApi";
import type { StagedCouncilAttachment } from "./councilAttachmentStaging";

function postBytes(url: string, file: File, mimeType: string) {
  const controller = new AbortController();
  const done = fetch(url, {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: file,
    credentials: "include",
    signal: controller.signal,
  }).then(async (response) => {
    // Read the body to the end; an unread body is cancelled and logged as an aborted request.
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) throw new Error(`Upload rejected (${response.status})`);
  });
  return { done, abort: () => controller.abort() };
}

/**
 * Uploads every staged file once per contender through the engine's own upload route (the
 * request crosses the MAX gateway tunnel like any engine call). The engine moves a pending
 * upload into exactly one thread, so each contender needs its own copy.
 */
export async function uploadCouncilAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly staged: ReadonlyArray<StagedCouncilAttachment>;
  readonly copies: number;
  readonly onProgress?: (uploaded: number, total: number) => void;
}): Promise<CouncilAttachmentMeta[][]> {
  if (input.staged.length === 0) return Array.from({ length: input.copies }, () => []);
  if (!readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope)) {
    throw new Error("This connection cannot upload files.");
  }
  const total = input.staged.length * input.copies;
  let uploaded = 0;
  const minted: string[] = [];
  const release = () => {
    for (const attachmentId of minted) {
      deletePendingAttachmentUpload({
        registry: appAtomRegistry,
        remove: attachmentEnvironment.remove,
        environmentId: input.environmentId,
        attachmentId,
      });
    }
  };
  const copies: CouncilAttachmentMeta[][] = [];
  for (let copy = 0; copy < input.copies; copy++) {
    const metas: CouncilAttachmentMeta[] = [];
    for (const staged of input.staged) {
      const result = await runAttachmentUploadCycle({
        registry: appAtomRegistry,
        createUploadUrl: attachmentEnvironment.createUploadUrl,
        remove: attachmentEnvironment.remove,
        environmentId: input.environmentId,
        upload: {
          ...(staged.kind === "file" ? { type: "file" as const } : {}),
          name: staged.name,
          mimeType: staged.mimeType,
          sizeBytes: staged.sizeBytes,
        },
        resolveUploadUrl: (relativeUrl) => {
          const connection = readPreparedConnection(input.environmentId);
          return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
        },
        transport: (url) => postBytes(url, staged.file, staged.mimeType),
        onMinted: (attachmentId) => {
          minted.push(attachmentId);
          return "continue";
        },
      });
      if (result.status !== "uploaded") {
        release();
        const detail =
          result.status === "failed" && result.error instanceof Error
            ? result.error.message
            : "the upload did not finish";
        throw new Error(`Couldn’t send ${staged.name}: ${detail}.`);
      }
      metas.push({
        type: staged.kind,
        id: result.attachmentId,
        name: staged.name,
        mimeType: staged.mimeType,
        sizeBytes: staged.sizeBytes,
      });
      uploaded += 1;
      input.onProgress?.(uploaded, total);
    }
    copies.push(metas);
  }
  return copies;
}
