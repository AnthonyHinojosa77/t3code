import { Dialog } from "@base-ui/react/dialog";
import { useRef, useState } from "react";
import {
  councilApi,
  type CouncilTemplate,
  type TemplateInput,
  type CouncilRole,
} from "./councilApi";

export function RoleTemplatePicker({
  templates,
  value,
  onChange,
  onRefresh,
}: {
  templates: CouncilTemplate[];
  value: string;
  onChange: (id: string) => void;
  onRefresh: () => void;
}) {
  const [managing, setManaging] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label>
        Template{" "}
        <select
          aria-label="Template"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="max-council-button" onClick={() => setManaging(true)}>
        Manage templates
      </button>
      {managing && (
        <TemplateManager
          templates={templates}
          onRefresh={onRefresh}
          onClose={() => setManaging(false)}
        />
      )}
    </div>
  );
}
type TemplateDraft = Omit<TemplateInput, "roles"> & { roles: CouncilRole[] };
const emptyTemplate: TemplateDraft = {
  name: "",
  description: "",
  format: "meta-debate",
  roles: [],
  synthesizerInstruction: "",
};
function TemplateManager({
  templates,
  onRefresh,
  onClose,
}: {
  templates: CouncilTemplate[];
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [id, setId] = useState("");
  const [draft, setDraft] = useState<TemplateDraft>(emptyTemplate);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const nextRoleId = useRef(0);
  const readOnly = templates.find((template) => template.id === id)?.builtIn ?? false;
  const edit = (nextId: string) => {
    setId(nextId);
    setDraft(templates.find((template) => template.id === nextId) ?? emptyTemplate);
    setError(null);
  };
  const save = (remove: boolean) => {
    if (lock.current || readOnly) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    const operation = remove
      ? councilApi.deleteTemplate(id).then(() => edit(""))
      : councilApi
          .saveTemplate(
            {
              name: draft.name,
              description: draft.description,
              format: draft.format,
              synthesizerInstruction: draft.synthesizerInstruction,
              roles: draft.roles.map(({ name, instruction }) => ({ name, instruction })),
            },
            id || undefined,
          )
          .then(({ template }) => {
            setId(template.id);
            setDraft(template);
          });
    void operation
      .then(onRefresh)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Couldn’t save template"))
      .finally(() => {
        lock.current = false;
        setBusy(false);
      });
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="max-scope max-council-overlay" />
        <Dialog.Popup
          className="max-scope max-council-sheet fixed right-0 top-0 z-90"
          aria-labelledby="template-manager-title"
        >
          <div className="flex items-center justify-between gap-3">
            <Dialog.Title id="template-manager-title">Manage templates</Dialog.Title>
            <button type="button" className="max-council-button" onClick={onClose}>
              Close
            </button>
          </div>
          <label>
            Edit template
            <select
              aria-label="Edit template"
              value={id}
              onChange={(event) => edit(event.target.value)}
              disabled={busy}
            >
              <option value="">New template</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>
          {readOnly && (
            <p>Built-in templates are read-only. Choose New template to create your own.</p>
          )}
          <fieldset disabled={readOnly || busy} className="flex flex-col gap-3">
            <label>
              Name
              <input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label>
              Description
              <textarea
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </label>
            <label>
              Format
              <select
                value={draft.format}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    format: event.target.value === "freeform" ? "freeform" : "meta-debate",
                  })
                }
              >
                <option value="meta-debate">Meta-debate</option>
                <option value="freeform">Freeform</option>
              </select>
            </label>
            <label>
              Judge instruction
              <textarea
                rows={4}
                value={draft.synthesizerInstruction}
                onChange={(event) =>
                  setDraft({ ...draft, synthesizerInstruction: event.target.value })
                }
              />
            </label>
            <h3>Roles</h3>
            {draft.roles.map((role, index) => (
              <div key={role.id} className="rounded-sm border border-(--max-line) p-2">
                <label>
                  Role name
                  <input
                    value={role.name}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        roles: draft.roles.map((entry, position) =>
                          position === index ? { ...entry, name: event.target.value } : entry,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Role instruction
                  <textarea
                    value={role.instruction}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        roles: draft.roles.map((entry, position) =>
                          position === index
                            ? { ...entry, instruction: event.target.value }
                            : entry,
                        ),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="max-council-button"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      roles: draft.roles.filter((_, position) => position !== index),
                    })
                  }
                >
                  Remove role {index + 1}
                </button>
              </div>
            ))}
            <button
              type="button"
              className="max-council-button"
              onClick={() =>
                setDraft({
                  ...draft,
                  roles: [
                    ...draft.roles,
                    { id: `draft-role-${nextRoleId.current++}`, name: "", instruction: "" },
                  ],
                })
              }
            >
              Add role
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                className="max-council-button"
                disabled={!draft.name.trim() || !draft.synthesizerInstruction.trim()}
                onClick={() => void save(false)}
              >
                {busy ? "Saving…" : "Save template"}
              </button>
              {id && (
                <button
                  type="button"
                  className="max-council-button"
                  onClick={() => void save(true)}
                >
                  Delete template
                </button>
              )}
            </div>
          </fieldset>
          {error && <p role="alert">{error}</p>}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
