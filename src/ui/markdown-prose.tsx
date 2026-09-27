import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/*
  `react-markdown` escapes raw HTML by default and `rehype-raw` is deliberately
  not enabled, so model-authored text cannot inject markup into the app.
*/
const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="mt-4 mb-2 text-lg font-semibold text-ink">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-4 mb-2 text-base font-semibold text-ink">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-sm font-semibold text-ink">{children}</h3>,
  p: ({ children }) => <p className="my-2 text-sm leading-relaxed text-ink">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc pl-5 text-sm text-ink">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal pl-5 text-sm text-ink">{children}</ol>,
  li: ({ children }) => <li className="my-0.5 leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-rule pl-3 text-sm text-muted">{children}</blockquote>
  ),
  a: ({ href, children }) => (
    <a href={href} className="text-accent underline" rel="noreferrer">
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-rule" />,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  table: ({ children }) => (
    <div className="my-2 overflow-auto">
      <table className="border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-rule bg-paper-sunk px-2 py-1 text-left font-medium text-ink">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border border-rule px-2 py-1 text-ink">{children}</td>,
  code: ({ className, children }) =>
    typeof className === 'string' && className.startsWith('language-') ? (
      <code className={`font-mono text-xs ${className}`}>{children}</code>
    ) : (
      <code className="rounded-sm bg-paper-sunk px-1 py-0.5 font-mono text-xs text-ink">
        {children}
      </code>
    ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-auto rounded-sm border border-rule bg-paper-sunk p-2">
      {children}
    </pre>
  ),
}

/**
 * Renders model-authored markdown outside the assistant-ui runtime, where
 * `MarkdownText` (which needs a message-part context) is unavailable. The
 * shared `COMPONENTS` map keeps every surface on one style.
 */
export function MarkdownProse({ children, className }: { children: string; className?: string }) {
  return (
    <div className={className}>
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </Markdown>
    </div>
  )
}
