import type { FileTarget } from '../../session/file-view-state'
import { ViewerNotice } from './feedback'
import { PREVIEW_SANDBOX } from './sandbox'

export function EmbedView({ target }: { target: FileTarget }) {
  const url = target.kind === 'url' ? target.url : null
  if (!url) return <ViewerNotice>There is nothing to embed.</ViewerNotice>

  return (
    <div className="flex h-full min-h-0 flex-col">
      <iframe
        title={url}
        src={url}
        sandbox={PREVIEW_SANDBOX}
        referrerPolicy="no-referrer"
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </div>
  )
}
