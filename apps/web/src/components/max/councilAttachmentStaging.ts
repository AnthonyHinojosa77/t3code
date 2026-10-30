import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";

import {
  classifyComposerAttachmentFile,
  composerFileAttachmentMimeType,
  normalizeComposerImageFileMimeType,
} from "../chat/composerAttachmentFiles";

/** A file chosen with the plus button, not yet uploaded. */
export interface StagedCouncilAttachment {
  readonly id: string;
  readonly file: File;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly kind: "image" | "file";
  /** Object URL for image thumbnails; the composer revokes it when the file is removed. */
  readonly previewUrl: string | null;
}

export interface RejectedCouncilFile {
  readonly name: string;
  readonly reason: string;
}

let stagedCounter = 0;

/** Checks every file before anything is sent, so no contender silently loses one. */
export function stageCouncilFiles(
  files: ReadonlyArray<File>,
  existing: ReadonlyArray<StagedCouncilAttachment>,
  createPreviewUrl: (file: File) => string | null = (file) =>
    typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null,
): { staged: StagedCouncilAttachment[]; rejected: RejectedCouncilFile[] } {
  const staged: StagedCouncilAttachment[] = [];
  const rejected: RejectedCouncilFile[] = [];
  let count = existing.length;
  for (const original of files) {
    if (count >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      rejected.push({
        name: original.name,
        reason: `Up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files can go with one question.`,
      });
      continue;
    }
    const file = normalizeComposerImageFileMimeType(original);
    const classification = classifyComposerAttachmentFile(file);
    if (classification === "unsupported-image") {
      rejected.push({
        name: file.name,
        reason: `${file.name} is an image type the models can’t read. Use PNG, JPEG, WebP or GIF.`,
      });
      continue;
    }
    if (file.size === 0) {
      rejected.push({ name: file.name, reason: `${file.name} is empty.` });
      continue;
    }
    const kind = classification;
    const limit =
      kind === "image" ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
    if (file.size > limit) {
      rejected.push({
        name: file.name,
        reason: `${file.name} is ${formatAttachmentSize(file.size)}. The limit is ${formatAttachmentSize(limit)}.`,
      });
      continue;
    }
    const mimeType =
      kind === "image" ? file.type.toLowerCase() : composerFileAttachmentMimeType(file);
    staged.push({
      id: `council-file-${++stagedCounter}`,
      file,
      name: file.name,
      mimeType,
      sizeBytes: file.size,
      kind,
      previewUrl: kind === "image" ? createPreviewUrl(file) : null,
    });
    count += 1;
  }
  return { staged, rejected };
}

export function releaseStagedAttachment(attachment: StagedCouncilAttachment): void {
  if (attachment.previewUrl && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}
