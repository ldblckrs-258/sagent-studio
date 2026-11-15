import { ChevronRight, ImagePlus, X } from "lucide-react";
import { useState } from "react";
import type { DragEvent } from "react";
import type { FormValues } from "../../playground/form";
import type { FormField } from "../../playground/types";
import { MAX_UPLOAD_BYTES } from "../composer-upload";
import { useObjectUrl } from "../file-view/load";
import { Input, Row, Select, Textarea, Toggle } from "../primitives";

export interface PendingImage {
  id: string;
  name: string;
  blob: Blob;
}

export interface FormErrorState {
  field?: string;
  message: string;
}

const UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function ImageThumb({ image, onRemove, disabled }: { image: PendingImage; onRemove(): void; disabled?: boolean }) {
  const url = useObjectUrl(image.blob);
  return (
    <div className="relative size-16 overflow-hidden rounded-sm border border-rule bg-paper-sunk">
      {url ? <img src={url} alt={image.name} className="size-full object-cover" /> : null}
      <button
        type="button"
        aria-label={`Remove ${image.name}`}
        title={`Remove ${image.name}`}
        disabled={disabled}
        onClick={onRemove}
        className="absolute right-0.5 top-0.5 inline-flex size-5 items-center justify-center rounded-sm bg-paper/90 text-muted hover:text-ink"
      >
        <X size={12} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}

function ImageInput({
  field,
  images,
  disabled,
  onChange,
}: {
  field: FormField;
  images: readonly PendingImage[];
  disabled?: boolean;
  onChange(images: PendingImage[]): void;
}) {
  const [error, setError] = useState<string | null>(null);
  const multiple = field.kind === "images";

  const add = (files: Iterable<File>) => {
    const accepted: PendingImage[] = [];
    let rejection: string | null = null;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        rejection = `${file.name} is not an image.`;
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        rejection = `${file.name} is larger than ${UPLOAD_MB} MB.`;
        continue;
      }
      accepted.push({ id: crypto.randomUUID(), name: file.name, blob: file });
    }
    setError(rejection);
    if (accepted.length === 0) return;
    onChange(multiple ? [...images, ...accepted] : accepted.slice(0, 1));
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!disabled) add(Array.from(event.dataTransfer.files));
  };

  return (
    <div
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      className="flex flex-col gap-2 rounded-sm border border-dashed border-rule-strong p-2"
    >
      <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted hover:text-ink">
        <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
        {multiple ? "Choose or drop images" : "Choose or drop an image"}
        <input
          type="file"
          accept="image/*"
          multiple={multiple}
          disabled={disabled}
          aria-label={field.label}
          className="sr-only"
          onChange={(event) => {
            if (event.target.files) add(Array.from(event.target.files));
            event.target.value = "";
          }}
        />
      </label>
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {images.map((image) => (
            <ImageThumb
              key={image.id}
              image={image}
              disabled={disabled}
              onRemove={() => onChange(images.filter((entry) => entry.id !== image.id))}
            />
          ))}
        </div>
      ) : null}
      {error ? (
        <span role="alert" className="font-mono text-xs text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function NumberInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: Extract<FormField, { kind: "integer" | "number" }>;
  value: unknown;
  disabled?: boolean;
  onChange(value: unknown): void;
}) {
  const number = (
    <Input
      size="sm"
      type="number"
      aria-label={field.label}
      min={field.min}
      max={field.max}
      step={field.step}
      value={asText(value)}
      disabled={disabled}
      className="font-mono"
      onChange={(event) => onChange(event.target.value)}
    />
  );
  if (field.min === undefined || field.max === undefined) return number;
  const fallback = typeof field.default === "number" ? field.default : field.min;
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        aria-label={`${field.label} slider`}
        min={field.min}
        max={field.max}
        step={field.step}
        value={asText(value) === "" ? fallback : asText(value)}
        disabled={disabled}
        className="min-w-0 flex-1 accent-accent"
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="w-24 shrink-0">{number}</div>
    </div>
  );
}

function FieldControl({
  field,
  value,
  images,
  disabled,
  onValueChange,
  onImagesChange,
}: {
  field: FormField;
  value: unknown;
  images: readonly PendingImage[];
  disabled?: boolean;
  onValueChange(value: unknown): void;
  onImagesChange(images: PendingImage[]): void;
}) {
  switch (field.kind) {
    case "text":
      if (field.secret) {
        return (
          <Input
            size="sm"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={field.label}
            value={asText(value)}
            disabled={disabled}
            className="font-mono"
            onChange={(event) => onValueChange(event.target.value)}
          />
        );
      }
      return field.multiline ? (
        <Textarea
          size="sm"
          aria-label={field.label}
          value={asText(value)}
          disabled={disabled}
          onChange={(event) => onValueChange(event.target.value)}
        />
      ) : (
        <Input
          size="sm"
          aria-label={field.label}
          value={asText(value)}
          disabled={disabled}
          onChange={(event) => onValueChange(event.target.value)}
        />
      );
    case "select":
      return (
        <Select
          size="sm"
          aria-label={field.label}
          value={asText(value)}
          disabled={disabled}
          onChange={(event) => onValueChange(event.target.value)}
        >
          {asText(value) === "" || !field.required ? <option value="">Default</option> : null}
          {field.options.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </Select>
      );
    case "integer":
    case "number":
      return <NumberInput field={field} value={value} disabled={disabled} onChange={onValueChange} />;
    case "boolean":
      return (
        <Toggle
          label={field.label}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => onValueChange(checked)}
        />
      );
    case "image":
    case "images":
      return <ImageInput field={field} images={images} disabled={disabled} onChange={onImagesChange} />;
    case "json":
      return (
        <Textarea
          size="sm"
          aria-label={field.label}
          spellCheck={false}
          value={typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2)}
          disabled={disabled}
          className="font-mono"
          onChange={(event) => onValueChange(event.target.value)}
        />
      );
  }
}

function isPrimary(field: FormField): boolean {
  return field.required || field.kind === "image" || field.kind === "images" || (field.kind === "text" && field.multiline);
}

export function SchemaForm({
  fields,
  values,
  images,
  owner,
  error,
  disabled,
  onValueChange,
  onImagesChange,
}: {
  fields: readonly FormField[];
  values: FormValues;
  images: Record<string, PendingImage[]>;
  owner: string;
  error: FormErrorState | null;
  disabled?: boolean;
  onValueChange(name: string, value: unknown): void;
  onImagesChange(name: string, images: PendingImage[]): void;
}) {
  if (fields.length === 0) {
    return <p className="py-2 text-xs text-faint">This model publishes no inputs.</p>;
  }
  const row = (field: FormField) => (
    <Row
      key={field.name}
      label={field.required ? `${field.label} *` : field.label}
      hint={field.name}
      error={error?.field === field.name ? error.message : undefined}
    >
      <FieldControl
        field={field}
        value={values[field.name]}
        images={images[field.name] ?? []}
        disabled={disabled}
        onValueChange={(value) => onValueChange(field.name, value)}
        onImagesChange={(next) => onImagesChange(field.name, next)}
      />
      {field.secret ? (
        <p className="text-xs leading-relaxed text-caution">
          This value goes to the model author {owner}. It is never saved.
        </p>
      ) : null}
      {field.description ? <p className="text-xs leading-relaxed text-faint">{field.description}</p> : null}
    </Row>
  );
  const primary = fields.filter(isPrimary);
  const rest = fields.filter((field) => !isPrimary(field));
  if (primary.length === 0 || rest.length === 0) {
    return <div className="flex flex-col">{fields.map(row)}</div>;
  }
  return (
    <div className="flex flex-col">
      <div className="flex flex-col">{primary.map(row)}</div>
      <details open className="group mt-2 border-t border-rule">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 py-2 text-xs text-muted transition-colors duration-150 hover:text-ink [&::-webkit-details-marker]:hidden">
          <ChevronRight
            size={14}
            strokeWidth={1.75}
            aria-hidden="true"
            className="shrink-0 text-faint transition-transform duration-150 ease-out-quart group-open:rotate-90"
          />
          <span className="font-medium">Parameters</span>
          <span className="numeric font-mono text-faint">{rest.length}</span>
        </summary>
        <div className="flex flex-col border-t border-rule">{rest.map(row)}</div>
      </details>
    </div>
  );
}
