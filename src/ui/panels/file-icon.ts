import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  Share2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { extensionOf, kindForPath } from '../file-view/kind'

export interface FileLook {
  Icon: LucideIcon
  /** A text colour token, so the icon follows both themes. */
  className: string
}

/**
 * The viewer's `FileKind` answers "how do we open this", which is a coarser
 * question than "what is this": everything it cannot render specially, from a
 * TypeScript module to a zip, is `text`. The tree splits that bucket further
 * for the icon only, and defers to `kindForPath` everywhere else so the two
 * never disagree about what a `.csv` is.
 */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash',
  'zsh', 'fish', 'sql', 'vue', 'svelte', 'astro', 'css', 'scss', 'sass', 'less',
])

const CONFIG_EXTENSIONS = new Set([
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'lock', 'xml', 'properties',
])

const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'rar', '7z'])

const DEFAULT_LOOK: FileLook = { Icon: File, className: 'text-faint' }

export function fileLookFor(path: string): FileLook {
  switch (kindForPath(path)) {
    case 'image':
      return { Icon: FileImage, className: 'text-file-media' }
    case 'video':
      return { Icon: FileVideo, className: 'text-file-media' }
    case 'audio':
      return { Icon: FileAudio, className: 'text-file-media' }
    case 'csv':
    case 'spreadsheet':
      return { Icon: FileSpreadsheet, className: 'text-file-sheet' }
    case 'json':
      return { Icon: FileJson, className: 'text-file-data' }
    case 'html':
      return { Icon: FileCode, className: 'text-file-code' }
    case 'diagram':
      return { Icon: Share2, className: 'text-file-media' }
    case 'markdown':
    case 'docx':
      return { Icon: FileText, className: 'text-muted' }
    default:
      break
  }

  const extension = extensionOf(path)
  if (CODE_EXTENSIONS.has(extension)) return { Icon: FileCode, className: 'text-file-code' }
  if (CONFIG_EXTENSIONS.has(extension)) return { Icon: FileCog, className: 'text-file-data' }
  if (ARCHIVE_EXTENSIONS.has(extension)) return { Icon: FileArchive, className: 'text-faint' }
  if (extension === 'txt') return { Icon: FileText, className: 'text-muted' }
  return DEFAULT_LOOK
}

export function folderLookFor(expanded: boolean): FileLook {
  return { Icon: expanded ? FolderOpen : Folder, className: 'text-muted' }
}
