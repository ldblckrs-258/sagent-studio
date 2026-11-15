import { Braces, CircleCheck, CircleX } from "lucide-react";
import { useMemo } from "react";
import { InputJsonError, parseInputJson } from "../../playground/form";
import { MonacoEditor } from "../monaco-editor";
import { Button } from "../primitives";

type Parsed = { ok: true; keys: number } | { ok: false; message: string };

function check(text: string): Parsed {
  try {
    return { ok: true, keys: Object.keys(parseInputJson(text)).length };
  } catch (error) {
    return { ok: false, message: error instanceof InputJsonError ? error.message : String(error) };
  }
}

export function JsonInput({
  value,
  imageFieldsWithUploads,
  onChange,
}: {
  value: string;
  imageFieldsWithUploads: readonly string[];
  onChange(value: string): void;
}) {
  const parsed = useMemo(() => check(value), [value]);

  return (
    <div className="flex flex-col gap-2 py-2">
      <div className="flex items-center justify-between gap-2">
        {parsed.ok ? (
          <span className="flex items-center gap-1.5 font-mono text-xs text-positive">
            <CircleCheck size={14} strokeWidth={1.75} aria-hidden="true" />
            <span className="numeric">{parsed.keys === 1 ? "1 key" : `${parsed.keys} keys`}</span>
          </span>
        ) : (
          <span className="flex items-center gap-1.5 font-mono text-xs text-danger">
            <CircleX size={14} strokeWidth={1.75} aria-hidden="true" />
            Not a valid object
          </span>
        )}
        <Button
          type="button"
          size="sm"
          variant="quiet"
          disabled={!parsed.ok}
          onClick={() => onChange(JSON.stringify(parseInputJson(value), null, 2))}
          icon={<Braces size={14} strokeWidth={1.75} aria-hidden="true" />}
        >
          Format
        </Button>
      </div>
      <MonacoEditor
        value={value}
        onChange={onChange}
        language="json"
        ariaLabel="JSON input"
        className="h-88 overflow-hidden rounded-sm border border-rule-strong bg-surface"
      />
      {parsed.ok ? null : (
        <p role="alert" className="font-mono text-xs text-danger">
          {parsed.message}
        </p>
      )}
      <p className="text-xs leading-relaxed text-faint">
        Sent as the prediction input. Keys the model does not declare are sent as typed. Keys named like credentials are
        never saved with the run.
      </p>
      {imageFieldsWithUploads.length > 0 ? (
        <p className="text-xs leading-relaxed text-muted">
          Images attached in Form mode are uploaded for{" "}
          <span className="font-mono text-ink">{imageFieldsWithUploads.join(", ")}</span> unless the JSON sets that key.
        </p>
      ) : null}
    </div>
  );
}
