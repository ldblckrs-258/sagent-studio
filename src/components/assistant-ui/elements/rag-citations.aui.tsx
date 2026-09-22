interface RagPassageLike {
  id?: string
  docTitle?: string
  ordinal?: number
  text?: string
}

interface RagSearchResultLike {
  query?: string
  reason?: string
  passages?: RagPassageLike[]
  conflicting?: RagPassageLike[]
  injectionWithheld?: boolean
  untrustedNotice?: string
}

const EMPTY_REASON_TEXT: Record<string, string> = {
  no_relevant: 'No relevant passage found in the library.',
  premise_conflict: 'The query premise was rejected by the library router.',
  skipped: 'The library router skipped retrieval for this query.',
  injection_filtered: 'The library withheld every passage it found.',
}

interface ToolResultLike {
  ok?: boolean
  code?: string
  message?: string
  hint?: string
  value?: unknown
}

/**
 * Renders a `search_documents` result as a readable citation list: the query,
 * each passage's document, ordinal, and the passage text itself, with the chunk
 * id kept as a small hoverable reference so a citation in the answer can be
 * matched back to its source. Telemetry (counts, scores, provider/model, index
 * mode) is not part of the model-visible result, so it is not shown here either.
 * Text is rendered as text nodes only, never as raw HTML.
 */
export function RagCitations({ result }: { result?: unknown }) {
  if (result === undefined || result === null) return null
  const envelope = result as ToolResultLike
  if (envelope.ok === false) {
    return (
      <div className="rounded-sm border border-danger-rule bg-danger-soft px-2.5 py-2 text-xs text-danger">
        <div className="font-medium">Document search {envelope.code ?? 'failed'}</div>
        {envelope.message ? <div className="mt-1 leading-relaxed">{envelope.message}</div> : null}
        {envelope.hint ? <div className="mt-1 leading-relaxed text-danger/80">{envelope.hint}</div> : null}
      </div>
    )
  }

  const value = (envelope.value ?? {}) as RagSearchResultLike
  const passages = value.passages ?? []
  const conflicting = value.conflicting ?? []
  const reason = value.reason ?? 'no_relevant'

  return (
    <div className="flex flex-col gap-2 rounded-sm border border-rule bg-surface px-2.5 py-2 text-xs">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-medium text-foreground">Library search</span>
        {value.query ? <span className="truncate text-faint">{value.query}</span> : null}
        {reason !== 'ok' ? (
          <span className="rounded-sm border border-caution-rule bg-caution-soft px-1.5 py-0.5 text-caution">
            {reason.replace(/_/g, ' ')}
          </span>
        ) : null}
        {value.injectionWithheld ? (
          <span className="rounded-sm border border-caution-rule bg-caution-soft px-1.5 py-0.5 text-caution">
            withheld: injected instruction
          </span>
        ) : null}
      </div>

      {passages.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {passages.map((passage, index) => (
            <PassageRow key={passage.id ?? index} passage={passage} />
          ))}
        </ul>
      ) : (
        <p className="leading-relaxed text-muted">
          {EMPTY_REASON_TEXT[reason] ?? EMPTY_REASON_TEXT.no_relevant}
        </p>
      )}

      {conflicting.length > 0 ? (
        <div className="flex flex-col gap-1.5 rounded-sm border border-danger-rule bg-danger-soft px-2 py-1.5">
          <span className="font-medium text-danger">Conflicting evidence, report the conflict</span>
          <ul className="flex flex-col gap-1.5">
            {conflicting.map((passage, index) => (
              <PassageRow key={passage.id ?? index} passage={passage} tone="danger" />
            ))}
          </ul>
        </div>
      ) : null}

      {value.untrustedNotice ? (
        <p className="leading-relaxed text-faint">{value.untrustedNotice}</p>
      ) : null}
    </div>
  )
}

function PassageRow({
  passage,
  tone,
}: {
  passage: RagPassageLike
  tone?: 'danger'
}) {
  const title = passage.docTitle || 'Untitled'
  const text = passage.text ?? ''
  return (
    <li className="flex flex-col gap-1 rounded-sm bg-paper-sunk/40 px-2 py-1.5">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span
          className={`min-w-0 truncate font-medium ${tone === 'danger' ? 'text-danger' : 'text-foreground'}`}
          title={title}
        >
          {title}
        </span>
        {passage.ordinal !== undefined ? (
          <span className="numeric shrink-0 font-mono text-[10px] text-faint">#{passage.ordinal}</span>
        ) : null}
        {passage.id ? (
          <span
            className="ms-auto max-w-[9rem] shrink-0 truncate font-mono text-[10px] text-faint/80"
            title={passage.id}
          >
            {passage.id}
          </span>
        ) : null}
      </div>
      {text.length > 0 ? (
        <p className="line-clamp-6 leading-relaxed whitespace-pre-wrap text-foreground/90">
          {text}
        </p>
      ) : null}
    </li>
  )
}
