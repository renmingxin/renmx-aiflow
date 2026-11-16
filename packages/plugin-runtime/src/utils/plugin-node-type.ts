export const PLUGIN_NODE_PREFIX = 'plugin:'

export interface ParsedPluginNodeType {
  pluginId: string
  nodeType: string
}

export function buildPluginNodeType(pluginId: string, nodeType: string): `plugin:${string}:${string}` {
  return `${PLUGIN_NODE_PREFIX}${pluginId}:${nodeType}`
}

export function isPluginNodeType(type: string): type is `plugin:${string}:${string}` {
  return type.startsWith(PLUGIN_NODE_PREFIX)
}

export function parsePluginNodeType(type: string): ParsedPluginNodeType | null {
  if (!isPluginNodeType(type)) {
    return null
  }

  const rawType = type.slice(PLUGIN_NODE_PREFIX.length)
  const separatorIndex = rawType.lastIndexOf(':')

  if (separatorIndex <= 0 || separatorIndex >= rawType.length - 1) {
    return null
  }

  return {
    pluginId: rawType.slice(0, separatorIndex),
    nodeType: rawType.slice(separatorIndex + 1),
  }
}
