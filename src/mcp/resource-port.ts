import type {
  McpResourceContent,
  McpResourcePort,
  McpResourceServerSummary,
} from '../tools/types'
import type { McpConnectionManager } from './manager'

export const MCP_RESOURCE_LIST_MAX = 200

function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

export function createMcpResourcePort(
  manager: Pick<McpConnectionManager, 'views' | 'readResource' | 'isDisposed'>,
): McpResourcePort {
  return {
    servers(): McpResourceServerSummary[] {
      if (manager.isDisposed()) return []
      return manager
        .views()
        .filter(
          (view) =>
            view.state === 'ready' &&
            (view.catalog.resources.length > 0 || view.catalog.resourceTemplates.length > 0),
        )
        .map((view) => ({
          id: view.config.id,
          name: view.config.name,
          resources: view.catalog.resources.slice(0, MCP_RESOURCE_LIST_MAX).map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
            ...(resource.description ? { description: resource.description } : {}),
            ...(typeof resource.size === 'number' ? { size: resource.size } : {}),
          })),
          templates: view.catalog.resourceTemplates.slice(0, MCP_RESOURCE_LIST_MAX).map((template) => ({
            uriTemplate: template.uriTemplate,
            name: template.name,
            ...(template.mimeType ? { mimeType: template.mimeType } : {}),
            ...(template.description ? { description: template.description } : {}),
          })),
          truncated:
            view.catalog.resources.length > MCP_RESOURCE_LIST_MAX ||
            view.catalog.resourceTemplates.length > MCP_RESOURCE_LIST_MAX ||
            view.catalog.truncated.includes('resources') ||
            view.catalog.truncated.includes('resourceTemplates'),
        }))
    },
    async read(serverId, uri, signal): Promise<McpResourceContent[]> {
      const result = await manager.readResource(serverId, uri, signal)
      return result.contents.map((content) => ({
        uri: content.uri,
        ...(content.mimeType ? { mimeType: content.mimeType } : {}),
        ...('text' in content && typeof content.text === 'string' ? { text: content.text } : {}),
        ...('blob' in content && typeof content.blob === 'string' ? { bytes: base64Bytes(content.blob) } : {}),
      }))
    },
  }
}
