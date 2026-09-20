import { useEffect, useRef, useState } from 'react'

type Monaco = typeof import('monaco-editor')

type WorkerCtor = new () => Worker

let monacoPromise: Promise<Monaco | null> | null = null

async function loadMonaco(): Promise<Monaco | null> {
  if (!monacoPromise) {
    monacoPromise = (async () => {
      try {
        const [monaco, editorWorker, tsWorker, jsonWorker, cssWorker, htmlWorker] = await Promise.all([
          import('monaco-editor'),
          import('monaco-editor/editor/editor.worker?worker'),
          import('monaco-editor/language/typescript/ts.worker?worker'),
          import('monaco-editor/language/json/json.worker?worker'),
          import('monaco-editor/language/css/css.worker?worker'),
          import('monaco-editor/language/html/html.worker?worker'),
        ])
        ;(self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
          // Vite emits each worker as a same-origin chunk, covered by worker-src 'self'.
          // Monaco asks by language label; the TypeScript, JSON, CSS, and HTML language
          // services each need their own worker, everything else uses the base worker.
          getWorker(_moduleId: string, label: string): Worker {
            switch (label) {
              case 'typescript':
              case 'javascript':
                return new (tsWorker.default as WorkerCtor)()
              case 'json':
                return new (jsonWorker.default as WorkerCtor)()
              case 'css':
              case 'scss':
              case 'less':
                return new (cssWorker.default as WorkerCtor)()
              case 'html':
              case 'handlebars':
              case 'razor':
                return new (htmlWorker.default as WorkerCtor)()
              default:
                return new (editorWorker.default as WorkerCtor)()
            }
          },
        }
        monaco.editor.defineTheme('sagent-light', {
          base: 'vs',
          inherit: true,
          rules: [],
          colors: {
            'editor.background': '#ffffff',
            'editor.foreground': '#2b2f3a',
            'editorLineNumber.foreground': '#9aa0ac',
            'editor.selectionBackground': '#cdd9f6',
            'editorCursor.foreground': '#4b5bd6',
          },
        })
        monaco.editor.defineTheme('sagent-dark', {
          base: 'vs-dark',
          inherit: true,
          rules: [],
          colors: {
            'editor.background': '#23262e',
            'editor.foreground': '#eceef2',
            'editorLineNumber.foreground': '#7f8590',
            'editor.selectionBackground': '#33406b',
            'editorCursor.foreground': '#93a4f0',
          },
        })
        return monaco
      } catch {
        return null
      }
    })()
  }
  return monacoPromise
}

function prefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false
}

export interface MonacoEditorProps {
  value: string
  onChange(value: string): void
  language?: string
  readOnly?: boolean
  className?: string
  ariaLabel?: string
}

/**
 * A lazily loaded Monaco instance with a plain mono textarea fallback. The
 * editor chunk never blocks the chat surface, and a worker that cannot start
 * degrades to the textarea rather than leaving the file unreachable.
 */
export function MonacoEditor({ value, onChange, language, readOnly, className, ariaLabel }: MonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const onChangeRef = useRef(onChange)
  const initialValueRef = useRef(value)
  const languageRef = useRef(language)
  const readOnlyRef = useRef(readOnly)
  const ariaLabelRef = useRef(ariaLabel)
  const [status, setStatus] = useState<'loading' | 'ready' | 'fallback'>('loading')

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    let disposed = false
    let subscription: { dispose(): void } | null = null

    void (async () => {
      const monaco = await loadMonaco()
      if (disposed) return
      if (!monaco || !containerRef.current) {
        setStatus('fallback')
        return
      }
      monacoRef.current = monaco
      const editor = monaco.editor.create(containerRef.current, {
        value: initialValueRef.current,
        language: languageRef.current ?? 'plaintext',
        readOnly: readOnlyRef.current ?? false,
        ariaLabel: ariaLabelRef.current ?? 'Code editor',
        theme: prefersDark() ? 'sagent-dark' : 'sagent-light',
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: 'var(--font-mono)',
        scrollBeyondLastLine: false,
      })
      editorRef.current = editor
      subscription = editor.onDidChangeModelContent(() => onChangeRef.current(editor.getValue()))
      setStatus('ready')
    })()

    return () => {
      disposed = true
      subscription?.dispose()
      editorRef.current?.dispose()
      editorRef.current = null
      monacoRef.current = null
    }
  }, [])

  useEffect(() => {
    const editor = editorRef.current
    if (editor && editor.getValue() !== value) editor.setValue(value)
  }, [value])

  useEffect(() => {
    const monaco = monacoRef.current
    const model = editorRef.current?.getModel()
    if (monaco && model && language) monaco.editor.setModelLanguage(model, language)
  }, [language])

  return (
    <div className={className} style={{ position: 'relative', minHeight: 0 }}>
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{ display: status === 'ready' ? 'block' : 'none' }}
      />
      {status !== 'ready' ? (
        <textarea
          value={value}
          readOnly={readOnly}
          spellCheck={false}
          aria-label={ariaLabel ?? 'Code editor'}
          onChange={(event) => onChange(event.target.value)}
          className="h-full w-full resize-none bg-surface p-3 font-mono text-sm text-ink outline-none"
        />
      ) : null}
    </div>
  )
}
