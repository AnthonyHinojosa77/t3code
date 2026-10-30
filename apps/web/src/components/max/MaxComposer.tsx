import type { EnvironmentId } from "@t3tools/contracts";
import {
  ArrowUpIcon,
  FileIcon,
  MicIcon,
  PaperclipIcon,
  PlusIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "../../lib/utils";
import { useProjects, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  releaseStagedAttachment,
  stageCouncilFiles,
  type StagedCouncilAttachment,
} from "./councilAttachmentStaging";
import { uploadCouncilAttachments } from "./councilAttachments";
import { councilApi, type CouncilRound, type CouncilTemplate } from "./councilApi";
import type { CouncilSelection } from "./councilSelection";
import {
  MaxModelWindow,
  summarizeCouncilSelection,
  type CouncilSelectionUpdate,
} from "./MaxModelWindow";
import { useSpeechDictation } from "./useSpeechDictation";

const SEND_REASON_ID = "max-council-send-reason";
const MAX_PROMPT_CHARS = 20000;

function joinDictation(base: string, spoken: string): string {
  const text = spoken.trim();
  if (!text) return base;
  return base.trim().length === 0 ? text : `${base.replace(/\s+$/, "")} ${text}`;
}

/**
 * The composer that stays docked at the bottom of the chat window: text, plus (files and round
 * settings), the model button, the mic and send. Every other control lives in the model window.
 */
export function MaxComposer({
  selection,
  onSelectionChange,
  templates,
  apiError,
  onRefresh,
  onCreated,
  placeholder,
}: {
  readonly templates: CouncilTemplate[];
  readonly apiError: string | null;
  readonly onRefresh: () => void;
  readonly onCreated: (round: CouncilRound, environmentId: EnvironmentId) => void;
  readonly selection: CouncilSelection;
  readonly onSelectionChange: CouncilSelectionUpdate;
  readonly placeholder: string;
}) {
  const projects = useProjects();
  const threads = useThreadShells();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<StagedCouncilAttachment[]>([]);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [projectKey, setProjectKey] = useState("");
  const [templateId, setTemplateId] = useState("meta-debate");
  const [modelsOpen, setModelsOpen] = useState(false);
  const [phase, setPhase] = useState<"idle" | "uploading" | "starting">("idle");
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitLock = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dictationBase = useRef("");
  const dictation = useSpeechDictation((text, isFinal) => {
    if (isFinal) {
      dictationBase.current = joinDictation(dictationBase.current, text);
      setPrompt(dictationBase.current);
    } else {
      setPrompt(joinDictation(dictationBase.current, text));
    }
  });

  const project =
    projects.find((entry) => `${entry.environmentId}:${entry.id}` === projectKey) ?? null;
  const environmentId = project?.environmentId ?? primaryEnvironmentId;
  const availableProjects = sortScopedProjectsForSidebar(projects, threads, "updated_at")
    .filter((entry) => entry.environmentId === environmentId)
    .map((entry) => ({ key: `${entry.environmentId}:${entry.id}`, title: entry.title }));
  const template = templates.find((entry) => entry.id === templateId) ?? templates[0];
  const trimmed = prompt.trim();
  const reason =
    apiError ??
    (templates.length === 0
      ? "Connecting to council…"
      : !trimmed
        ? "Enter a question."
        : trimmed.length > MAX_PROMPT_CHARS
          ? "Keep your question under 20,000 characters."
          : selection.contenders.length === 0
            ? "Choose at least one contender."
            : selection.contenders.length > 8
              ? "Choose at most eight contenders."
              : !selection.synthesizer
                ? "Choose a synthesizer."
                : !environmentId
                  ? "Connect a computer."
                  : null);
  // The empty field explains itself; everything else is worth a line.
  const visibleReason = error ?? (reason && reason !== "Enter a question." ? reason : null);
  const busy = phase !== "idle";

  const addFiles = (chosen: File[]) => {
    const { staged, rejected } = stageCouncilFiles(chosen, files);
    if (staged.length) setFiles((current) => [...current, ...staged]);
    setFileNotice(rejected.length ? rejected.map((entry) => entry.reason).join(" ") : null);
  };
  const removeFile = (id: string) => {
    setFiles((current) => {
      const target = current.find((entry) => entry.id === id);
      if (target) releaseStagedAttachment(target);
      return current.filter((entry) => entry.id !== id);
    });
  };

  const submit = () => {
    if (reason || submitLock.current || !template || !selection.synthesizer || !environmentId)
      return;
    submitLock.current = true;
    setError(null);
    const contenders = selection.contenders.map((entry, index) => ({
      ...entry,
      roleId:
        entry.roleId === undefined
          ? (template.roles[index % template.roles.length]?.id ?? null)
          : entry.roleId,
    }));
    const sent = files;
    setPhase(files.length ? "uploading" : "starting");
    void uploadCouncilAttachments({
      environmentId,
      staged: files,
      copies: contenders.length,
      onProgress: (uploaded, total) => setUploadProgress(`Sending files ${uploaded} of ${total}…`),
    })
      .then((attachments) => {
        setPhase("starting");
        return councilApi.createRound({
          prompt: trimmed,
          projectId: project?.id ?? null,
          templateId: template.id,
          contenders: contenders.map((entry, index) => ({
            ...entry,
            attachments: attachments[index] ?? [],
          })),
          synthesizer: selection.synthesizer!,
        });
      })
      .then(({ round }) => {
        for (const file of sent) releaseStagedAttachment(file);
        setFiles([]);
        setPrompt("");
        dictationBase.current = "";
        onCreated(round, environmentId);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Couldn’t start council");
      })
      .finally(() => {
        submitLock.current = false;
        setPhase("idle");
        setUploadProgress(null);
      });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends where there is a real keyboard; touch keyboards keep Enter for a new line.
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      window.matchMedia("(pointer: fine)").matches
    ) {
      event.preventDefault();
      submit();
    }
  };

  const resize = (element: HTMLTextAreaElement) => {
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  };

  return (
    <div className="max-composer" data-phase={phase}>
      {fileNotice ? (
        <p role="alert" className="max-composer-note">
          {fileNotice}
          <button type="button" className="max-link" onClick={() => setFileNotice(null)}>
            Dismiss
          </button>
        </p>
      ) : null}
      {dictation.message ? (
        <p role="status" className="max-composer-note">
          {dictation.message}
          <button type="button" className="max-link" onClick={dictation.dismissMessage}>
            Dismiss
          </button>
        </p>
      ) : null}
      <div
        className="max-composer-field"
        data-listening={dictation.state === "listening" || undefined}
      >
        {files.length ? (
          <ul aria-label="Attached files" className="max-attachments">
            {files.map((file) => (
              <li key={file.id} className="max-attachment">
                {file.previewUrl ? (
                  <img src={file.previewUrl} alt="" className="max-attachment-thumb" />
                ) : (
                  <FileIcon aria-hidden="true" className="size-4 shrink-0" />
                )}
                <span className="truncate">{file.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  className="max-icon-button max-icon-button-small"
                  disabled={busy}
                  onClick={() => removeFile(file.id)}
                >
                  <XIcon aria-hidden="true" className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <label htmlFor="max-council-prompt" className="sr-only">
          Question for the council
        </label>
        <textarea
          ref={textareaRef}
          id="max-council-prompt"
          value={prompt}
          rows={1}
          placeholder={placeholder}
          disabled={busy}
          aria-describedby={visibleReason ? SEND_REASON_ID : undefined}
          onChange={(event) => {
            setPrompt(event.target.value);
            dictationBase.current = event.target.value;
            resize(event.target);
          }}
          onKeyDown={onKeyDown}
          className="max-composer-input"
        />
        <div className="max-composer-row">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              addFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
            }}
          />
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  className="max-icon-button"
                  aria-label="Add files or settings"
                  disabled={busy}
                />
              }
            >
              <PlusIcon aria-hidden="true" className="size-5" />
            </MenuTrigger>
            <MenuPopup align="start" side="top">
              <div className="max-scope max-menu">
                <MenuItem onClick={() => fileInputRef.current?.click()}>
                  <PaperclipIcon aria-hidden="true" className="size-4" />
                  Add files or photos
                </MenuItem>
                <MenuItem onClick={() => setModelsOpen(true)}>
                  <Settings2Icon aria-hidden="true" className="size-4" />
                  Template and project
                </MenuItem>
              </div>
            </MenuPopup>
          </Menu>
          <button
            type="button"
            className="max-model-button"
            aria-label="Choose models"
            aria-haspopup="dialog"
            aria-expanded={modelsOpen}
            disabled={busy}
            onClick={() => setModelsOpen(true)}
          >
            <SlidersHorizontalIcon aria-hidden="true" className="size-4" />
            <span className="truncate">{summarizeCouncilSelection(selection, environmentId)}</span>
          </button>
          <span className="flex-1" />
          <button
            type="button"
            className={cn(
              "max-icon-button",
              dictation.state === "listening" && "max-icon-button-live",
            )}
            aria-label={
              dictation.state === "listening" ? "Stop dictation" : "Dictate your question"
            }
            aria-pressed={dictation.state === "listening"}
            disabled={busy}
            onClick={() => {
              dictationBase.current = prompt;
              dictation.toggle();
              textareaRef.current?.focus();
            }}
          >
            {dictation.state === "listening" ? (
              <SquareIcon aria-hidden="true" className="size-4" />
            ) : (
              <MicIcon aria-hidden="true" className="size-5" />
            )}
          </button>
          <button
            type="button"
            disabled={reason !== null || busy}
            onClick={submit}
            aria-label="Send to council"
            aria-describedby={visibleReason ? SEND_REASON_ID : undefined}
            className="max-send"
          >
            <ArrowUpIcon aria-hidden="true" className="size-5" />
          </button>
        </div>
      </div>
      {visibleReason || uploadProgress ? (
        <p
          id={SEND_REASON_ID}
          className={cn("max-composer-reason", error && "max-composer-reason-error")}
        >
          {uploadProgress ?? visibleReason}
        </p>
      ) : null}
      <MaxModelWindow
        open={modelsOpen}
        onOpenChange={setModelsOpen}
        environmentId={environmentId ?? null}
        projectId={project?.id ?? null}
        template={template}
        templates={templates}
        selection={selection}
        onSelectionChange={onSelectionChange}
        onTemplateChange={(id) => {
          setTemplateId(id);
          onSelectionChange((current) => ({
            ...current,
            contenders: current.contenders.map(({ roleId: _, ...entry }) => entry),
          }));
        }}
        onRefreshTemplates={onRefresh}
        projectKey={projectKey}
        projects={availableProjects}
        onProjectChange={setProjectKey}
      />
    </div>
  );
}
