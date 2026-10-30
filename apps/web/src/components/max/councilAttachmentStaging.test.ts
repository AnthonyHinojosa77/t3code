import { describe, expect, it } from "vite-plus/test";

import { stageCouncilFiles } from "./councilAttachmentStaging";

const noPreview = () => null;

describe("stageCouncilFiles", () => {
  it("stages images and documents with the type the engine expects", () => {
    const { staged, rejected } = stageCouncilFiles(
      [
        new File([new Uint8Array(10)], "chart.png", { type: "image/png" }),
        new File([new Uint8Array(10)], "notes.pdf", { type: "application/pdf" }),
        new File([new Uint8Array(10)], "photo.JPG", { type: "" }),
        // Previewable but not provider-readable image types travel as files, like T3's composer.
        new File([new Uint8Array(10)], "scan.bmp", { type: "image/bmp" }),
      ],
      [],
      noPreview,
    );
    expect(rejected).toEqual([]);
    expect(staged.map((entry) => [entry.kind, entry.mimeType])).toEqual([
      ["image", "image/png"],
      ["file", "application/pdf"],
      ["image", "image/jpeg"],
      ["file", "image/bmp"],
    ]);
    expect(new Set(staged.map((entry) => entry.id)).size).toBe(4);
  });

  it("rejects images the models cannot read, empty files and oversized files, by name", () => {
    const { staged, rejected } = stageCouncilFiles(
      [
        new File([new Uint8Array(10)], "scan.img", { type: "image/x-unknown" }),
        new File([], "empty.txt", { type: "text/plain" }),
        new File([new Uint8Array(11 * 1024 * 1024)], "huge.png", { type: "image/png" }),
      ],
      [],
      noPreview,
    );
    expect(staged).toEqual([]);
    expect(rejected.map((entry) => entry.name)).toEqual(["scan.img", "empty.txt", "huge.png"]);
    expect(rejected[0]?.reason).toMatch(/PNG, JPEG, WebP or GIF/);
    expect(rejected[2]?.reason).toMatch(/limit is 10.0 MB/);
  });

  it("caps the total number of files per question", () => {
    const existing = stageCouncilFiles(
      Array.from(
        { length: 100 },
        (_, i) => new File([new Uint8Array(1)], `f${i}.txt`, { type: "text/plain" }),
      ),
      [],
      noPreview,
    ).staged;
    const { staged, rejected } = stageCouncilFiles(
      [new File([new Uint8Array(1)], "extra.txt", { type: "text/plain" })],
      existing,
      noPreview,
    );
    expect(staged).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/Up to 100 files/);
  });
});
