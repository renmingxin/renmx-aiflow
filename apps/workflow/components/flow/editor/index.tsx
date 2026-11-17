'use client'

/**
 * 工作流编辑器
 *
 * 基于 React Flow 的流程画布，负责：
 * - 渲染内置节点（开始 / 大模型 / HTTP / 条件分支 / 结束 / 知识库）与插件节点；
 * - 维护节点、连线状态，并在变更后触发防抖自动保存；
 * - 提供节点配置面板、测试运行面板与执行详情面板；
 * - 启动时加载已安装插件，并把缺失插件元数据的节点补全（hydrate）。
 *
 * 组件分为两层：FlowEditor 只负责提供 ReactFlowProvider，
 * 真正的状态与交互逻辑都在 EditorInner 中。
 */

import '@xyflow/react/dist/base.css'

import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Connection,
  Controls,
  Edge,
  EdgeChange,
  MiniMap,
  Node,
  NodeChange,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { v4 as uuidv4 } from 'uuid'

import type { BuiltInNodeKind, NodeKind } from '@/components/flow/settings/types'
import type { RegisteredPluginNode } from '@/components/plugin/plugin-registry-client'
import { initializePluginRegistry, pluginRegistryClient } from '@/components/plugin/plugin-registry-client'
import { workflowService } from '@/lib/services/workflow-service'
import type { FlowEdge as WorkflowFlowEdge, FlowNode as WorkflowFlowNode } from '@/lib/types/workflow'

import { ExecutionDetailPanel } from '../execution-history'
import { createNodeTypes } from '../nodes'
import { buildPluginNodeType, extractSchemaDefaults, isPluginNodeType } from '../plugin-node-utils'
import { Settings } from '../settings'
import { TestRunPanel } from '../test-run'
import { FlowEditorContext } from './context'
import { type EditorMode, FlowEditorHeader } from './header'
import { builtInNodeItems, createPluginNodeItems } from './node-catalog'

/**
 * 节点上挂载的业务数据。
 * React Flow 只关心 id/type/position，节点长什么样、能配什么，都由这里描述。
 */
export type FlowNodeData = {
  /** 节点标题，显示在节点卡片与配置面板标题上 */
  label?: string
  /** 节点配置项，结构由节点类型决定（内置节点见 defaultNodeConfigs，插件节点见 configSchema） */
  config?: Record<string, unknown>
  /** 插件节点所属插件 ID（内置节点没有） */
  pluginId?: string
  /** 插件节点在插件内的类型标识 */
  pluginType?: string
  /** 插件节点的输出端口定义，用于连线校验与下游变量选择 */
  outputs?: Array<{
    name: string
    type: string
    description?: string
  }>
  /** 插件节点的主题色 */
  color?: string
  /** 插件节点的图标 */
  icon?: string
  /** 插件节点的配置 schema，用于生成表单默认值与字段类型 */
  configSchema?: RegisteredPluginNode['configSchema']
  /** 插件自定义渲染组件的远程地址（可选） */
  customComponentUrl?: string
  /** 插件自定义渲染组件的名称（可选） */
  customComponentName?: string
  /** 插件声明的权限列表，运行时用于能力校验 */
  permissions?: string[]
}

/** 画布节点的最小结构（与 React Flow 的 Node 兼容，但只声明本项目用到的字段）。 */
export type FlowNode = {
  id: string
  type: NodeKind
  position: { x: number; y: number }
  data?: FlowNodeData
}

/** 画布连线：记录起点、终点以及可选的端口（sourceHandle）。 */
export type FlowEdge = {
  id: string
  source: string
  sourceHandle?: string
  target: string
}

/** LangGraph 执行图中的节点：id + 类型 + 参数。 */
export type LangGraphNode = {
  id: string
  kind: NodeKind
  params?: Record<string, unknown>
}

/** LangGraph 执行图中的边：可选 condition 表示条件分支的走向。 */
export type LangGraphEdge = {
  source: string
  target: string
  condition?: string
}

/** 交给后端执行引擎的完整图定义。 */
export type LangGraphSpec = {
  nodes: LangGraphNode[]
  edges: LangGraphEdge[]
}

/**
 * 新建工作流时的初始画布：只有一个开始节点。
 * 坐标放在画布中心附近（350, 250），配合初始 fitView 直接可见。
 */
const defaultNodes: Node[] = [
  {
    id: 'start-1',
    type: 'start',
    position: { x: 350, y: 250 },
    data: {
      label: '开始',
      config: {
        inputs: [],
      },
    },
  },
]

/** 新建工作流时没有任何连线。 */
const defaultEdges: Edge[] = []

/**
 * 内置节点的默认数据表。
 *
 * 新增节点时用对应项初始化：
 * - label：节点卡片上显示的标题；
 * - config：配置面板的初始值。
 * 插件节点的默认值不在这里，而是由插件的 configSchema 经 extractSchemaDefaults 生成。
 */
const defaultNodeConfigs: Record<BuiltInNodeKind, { label: string; config: Record<string, unknown> }> = {
  start: {
    label: '开始',
    config: {
      inputs: [],
    },
  },
  llm: {
    label: '大模型',
    config: {
      model: 'qwen3.5:2b',
      systemPrompt: '',
      userPrompt: '',
      assistantPrompt: '',
      temperature: 0.7,
      maxTokens: 2000,
    },
  },
  http: {
    label: 'HTTP 请求',
    config: {
      url: '',
      method: 'GET',
      headers: [],
      params: [],
      bodyType: 'none',
      body: '',
      formData: [],
      timeout: 30000,
    },
  },
  condition: {
    label: '条件分支',
    config: {
      model: 'qwen3.5:2b',
      intents: [],
    },
  },
  end: {
    label: '结束输出',
    config: {},
  },
  knowledge: {
    label: '知识库',
    config: {
      knowledgeBaseIds: [],
      query: '',
      retrievalMode: 'vector',
      topK: 5,
      threshold: 0.2,
      outputFormat: 'text',
    },
  },
}

/**
 * 编辑器的外部入参。
 */
interface FlowEditorProps {
  /** 应用 ID，保存工作流、请求执行记录时使用 */
  appId: string
  /** 应用名称，展示在顶部工具栏 */
  appName: string
  /** 初始节点；为空时退回 defaultNodes（仅一个开始节点） */
  initialNodes?: WorkflowFlowNode[]
  /** 初始连线；为空时没有连线 */
  initialEdges?: WorkflowFlowEdge[]
}

/** 自动保存防抖延迟（毫秒）：最后一次变更后等待这么久再落库。 */
const AUTO_SAVE_DELAY = 2000

/** 已安装插件返回体中单个节点的原始结构。 */
interface InstalledPluginNodePayload {
  type: string
  name: string
  description?: string
  icon: string
  color: string
  category: string
  configSchema: RegisteredPluginNode['configSchema']
  outputs: RegisteredPluginNode['outputs']
  customComponent?: string
}

/** 已安装插件列表项：插件 ID + 当前版本的权限、组件地址与节点定义。 */
interface InstalledPluginApiItem {
  pluginId: string
  version: {
    permissions?: string[]
    componentsUrl?: string
    nodes?: InstalledPluginNodePayload[]
  }
}

/**
 * 用插件注册表补全画布节点上的插件元数据。
 *
 * 工作流只持久化节点的 type 与 config，插件升级后 name / icon / outputs / schema 可能变化，
 * 因此加载时按 `pluginId + nodeType` 重新绑定最新元数据，并把 schema 默认值与已存配置合并
 * （已存配置优先，保证用户改过的值不被覆盖）。
 */
function hydratePluginNodes(nodes: Node[], pluginNodes: RegisteredPluginNode[]): Node[] {
  const pluginNodeMap = new Map(pluginNodes.map(node => [buildPluginNodeType(node.pluginId, node.nodeType), node]))

  return nodes.map(node => {
    const nodeType = typeof node.type === 'string' ? node.type : undefined

    if (!nodeType || !isPluginNodeType(nodeType)) {
      return node
    }

    const pluginNode = pluginNodeMap.get(nodeType as NodeKind)
    if (!pluginNode) {
      return node
    }

    const currentData = (node.data || {}) as FlowNodeData
    const normalizedConfig = normalizePluginNodeConfig(currentData.config)
    const normalizedLabel = currentData.label || getLegacyPluginNodeLabel(currentData.config) || pluginNode.name

    return {
      ...node,
      data: {
        ...currentData,
        label: normalizedLabel,
        config: {
          ...extractSchemaDefaults(pluginNode.configSchema),
          ...normalizedConfig,
        },
        pluginId: pluginNode.pluginId,
        pluginType: pluginNode.nodeType,
        outputs: pluginNode.outputs,
        color: pluginNode.color,
        icon: pluginNode.icon,
        configSchema: pluginNode.configSchema,
        customComponentUrl: pluginNode.customComponentUrl,
        customComponentName: pluginNode.customComponentName,
        permissions: pluginNode.permissions,
      } satisfies FlowNodeData,
    }
  })
}

/**
 * 兼容历史数据结构：旧版本把表单值包在 `config.config` 里，
 * 这里统一取出真正的配置对象；不是普通对象时返回空对象。
 */
function normalizePluginNodeConfig(config: FlowNodeData['config']): Record<string, unknown> {
  if (!isPlainObject(config)) {
    return {}
  }

  if (isPlainObject(config.config)) {
    return config.config
  }

  return config
}

/** 从旧数据中读取节点标题（旧版本把 label 存在 config 里）。 */
function getLegacyPluginNodeLabel(config: FlowNodeData['config']): string | undefined {
  if (!isPlainObject(config)) {
    return undefined
  }

  return typeof config.label === 'string' && config.label.trim() ? config.label : undefined
}

/** 判断是否为普通对象（排除 null 与数组），用于安全读取历史数据。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 过滤并规范化 `/api/plugins/installed` 的返回：
 * 只保留至少包含一个节点定义的插件，并补齐 permissions / nodes 的默认值。
 */
function normalizeInstalledPlugins(items: InstalledPluginApiItem[]) {
  return items
    .filter(item => Array.isArray(item.version?.nodes) && item.version.nodes.length > 0)
    .map(item => ({
      pluginId: item.pluginId,
      permissions: item.version.permissions || [],
      componentsUrl: item.version.componentsUrl,
      nodes: item.version.nodes || [],
    }))
}

/**
 * 编辑器主体：持有画布与面板的全部状态。
 *
 * 状态分为两组：
 * - 画布数据：nodes / edges，同时用 ref 保存最新值，供防抖保存读取；
 * - UI 状态：选中节点、脏标记、保存中、最后保存时间、添加菜单、测试运行、执行详情。
 */
function EditorInner({ appId, appName, initialNodes = [], initialEdges = [] }: FlowEditorProps) {
  // 有初始数据（从服务端加载的工作流）就用初始数据，否则使用默认的开始节点画布
  const [nodes, setNodes] = useState<Node[]>(initialNodes.length > 0 ? (initialNodes as Node[]) : defaultNodes)
  const [edges, setEdges] = useState<Edge[]>(initialEdges.length > 0 ? (initialEdges as Edge[]) : defaultEdges)
  const [selectedNode, setSelectedNode] = useState<Node | null>(null)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [testRunOpen, setTestRunOpen] = useState(false)
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null)
  const [pluginNodes, setPluginNodes] = useState<RegisteredPluginNode[]>([])

  // 由状态推导当前模式，两种模式互斥：
  // - edit：正常编辑，可打开节点配置与测试运行面板；
  // - detail：查看某次执行详情，只显示执行详情面板。
  const mode: EditorMode = useMemo(() => {
    if (selectedExecutionId) return 'detail'
    return 'edit'
  }, [selectedExecutionId])

  // 自动保存定时器引用
  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null)

  // 使用 ref 存储最新的 nodes 和 edges，避免 setState 异步导致保存旧数据
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)

  // 把最新状态同步到 ref：防抖保存触发时从 ref 读取，避免拿到过期的闭包值
  useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])

  useEffect(() => {
    edgesRef.current = edges
  }, [edges])

  /**
   * 初始化插件（仅在挂载时执行一次）：
   * 1. 拉取已安装且启用的插件；
   * 2. 重建插件注册表，并取出注册后的节点定义；
   * 3. 用最新元数据补全当前画布节点。
   *
   * cancelled 用于兼容 React 严格模式下的重复挂载：卸载后不再 setState。
   */
  useEffect(() => {
    let cancelled = false

    const loadInstalledPlugins = async () => {
      try {
        const response = await fetch('/api/plugins/installed?isEnabled=true&pageSize=100')

        if (!response.ok) {
          throw new Error('加载已安装插件失败')
        }

        const result = await response.json()
        const installedItems = (result?.data?.items || []) as InstalledPluginApiItem[]
        const normalizedPlugins = normalizeInstalledPlugins(installedItems)

        pluginRegistryClient.clear()
        initializePluginRegistry(normalizedPlugins)

        const registeredNodes = pluginRegistryClient.getAllPluginNodes()
        if (cancelled) {
          return
        }

        setPluginNodes(registeredNodes)
        setNodes(currentNodes => hydratePluginNodes(currentNodes, registeredNodes))
      } catch (error) {
        pluginRegistryClient.clear()
        if (!cancelled) {
          setPluginNodes([])

          console.error('加载已安装插件失败:', error)
        }
      }
    }

    loadInstalledPlugins()

    return () => {
      cancelled = true
    }
  }, [])

  /** 是否已存在开始节点：工作流只允许一个开始节点。 */
  const hasStartNode = useMemo(() => {
    return nodes.some(node => node.type === 'start')
  }, [nodes])

  /** 添加菜单可选的节点：内置节点（排除开始） + 已安装插件节点。 */
  const availableNodes = useMemo(() => {
    const builtInNodes = builtInNodeItems.filter(item => item.type !== 'start')
    return [...builtInNodes, ...createPluginNodeItems(pluginNodes)]
  }, [pluginNodes])

  /** React Flow 的 nodeTypes 映射：内置节点与插件节点由 createNodeTypes 统一组装。 */
  const flowNodeTypes = useMemo(() => {
    return createNodeTypes(pluginNodes)
  }, [pluginNodes])

  /** 插件节点类型 -> 插件元数据，新增节点与 hydrate 时按类型查找。 */
  const pluginNodeMap = useMemo(() => {
    return new Map(pluginNodes.map(node => [buildPluginNodeType(node.pluginId, node.nodeType), node]))
  }, [pluginNodes])

  // 清理定时器
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
      }
    }
  }, [])

  // 节点数据被配置面板修改后，nodes 中的对象会被替换成新引用；
  // 这里把 selectedNode 同步到新对象，避免 Settings 面板继续持有旧引用。
  // 若节点已被删除（找不到 id），保留当前值，由面板关闭逻辑处理。
  useEffect(() => {
    if (selectedNode) {
      const updatedNode = nodes.find(n => n.id === selectedNode.id)
      if (updatedNode) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSelectedNode(updatedNode)
      }
    }
  }, [nodes, selectedNode])

  /**
   * 保存工作流（手动保存与自动保存共用）。
   * - 无未保存变更时直接返回，避免无意义请求；
   * - 从 ref 读取最新 nodes/edges，因为防抖回调执行时闭包里的 state 可能已过期；
   * - 成功后清除脏标记并记录保存时间，失败用 toast 提示。
   */
  const saveWorkflow = useCallback(async () => {
    if (!hasUnsavedChanges) {
      return
    }

    setIsSaving(true)
    try {
      // 使用 ref 中的最新值，避免保存旧数据
      await workflowService.save(appId, {
        nodes: nodesRef.current as WorkflowFlowNode[],
        edges: edgesRef.current as WorkflowFlowEdge[],
      })
      setHasUnsavedChanges(false)
      setLastSavedAt(new Date())
    } catch (error) {
      console.error('保存工作流失败:', error)
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setIsSaving(false)
    }
  }, [appId, hasUnsavedChanges])

  /** 标记为「有未保存变更」，并重启防抖计时器；连续操作只会在最后一次后落库。 */
  const triggerAutoSave = useCallback(() => {
    setHasUnsavedChanges(true)
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
    }
    autoSaveTimerRef.current = setTimeout(() => {
      saveWorkflow()
    }, AUTO_SAVE_DELAY)
  }, [saveWorkflow])

  /**
   * 添加节点。
   * 先校验开始节点唯一性；内置节点取 defaultNodeConfigs，插件节点取注册表元数据与 schema 默认值；
   * id 采用「类型-随机串」避免冲突，位置在画布中心附近随机偏移，最后触发自动保存。
   */
  const onAddNode = useCallback(
    (type: NodeKind) => {
      // 如果是开始节点且已存在，则不允许添加
      if (type === 'start' && hasStartNode) {
        toast.error('工作流只能有一个开始节点')
        return
      }

      const builtInNodeConfig = type in defaultNodeConfigs ? defaultNodeConfigs[type as BuiltInNodeKind] : undefined
      const pluginNode = isPluginNodeType(type) ? pluginNodeMap.get(type) : undefined

      if (!builtInNodeConfig && !pluginNode) {
        toast.error('未找到该节点类型')
        return
      }

      const newNode: Node = {
        id: `${(pluginNode?.nodeType || type).replace(/[^a-zA-Z0-9_-]/g, '-')}-${uuidv4().slice(0, 8)}`,
        type,
        position: {
          // 放在画布中心附近，稍微偏移避免重叠
          x: 350 + Math.random() * 200,
          y: 200 + Math.random() * 200,
        },
        data: (pluginNode
          ? {
              label: pluginNode.name,
              config: extractSchemaDefaults(pluginNode.configSchema),
              pluginId: pluginNode.pluginId,
              pluginType: pluginNode.nodeType,
              outputs: pluginNode.outputs,
              color: pluginNode.color,
              icon: pluginNode.icon,
              configSchema: pluginNode.configSchema,
              customComponentUrl: pluginNode.customComponentUrl,
              customComponentName: pluginNode.customComponentName,
              permissions: pluginNode.permissions,
            }
          : builtInNodeConfig) as Record<string, unknown>,
      }

      setNodes(nodes => [...nodes, newNode])
      triggerAutoSave()
      toast.success(`已添加${pluginNode?.name || builtInNodeConfig?.label}节点`)
      setAddMenuOpen(false)
    },
    [hasStartNode, pluginNodeMap, triggerAutoSave]
  )

  /** 新增连线：开始节点只能作为起点，禁止把连线指向它。 */
  const onConnect = useCallback(
    (connection: Connection) => {
      console.log('onConnect', { connection })
      // 检查是否尝试连接到开始节点
      const targetIsStart = nodes.some(n => n.id === connection.target && n.type === 'start')
      if (targetIsStart) {
        toast.error('不能连接到开始节点')
        return
      }

      setEdges(eds => addEdge(connection, eds))
      triggerAutoSave()
    },
    [nodes, triggerAutoSave]
  )

  /** 节点变更：交给 applyNodeChanges 处理，同时拦截「删除开始节点」的操作。 */
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      console.log('onNodesChange', { changes, nodes })
      // 阻止删除开始节点
      const hasRemoveStart = changes.some(change => change.type === 'remove' && nodes.some(n => n.id === change.id && n.type === 'start'))
      if (hasRemoveStart) {
        toast.error('不能删除开始节点')
        return
      }

      setNodes(nodes => applyNodeChanges(changes, nodes))
      triggerAutoSave()
    },
    [nodes, triggerAutoSave]
  )

  /** 连线变更：交给 applyEdgeChanges 处理，并触发自动保存。 */
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      console.log('onEdgesChange', { changes, edges })
      setEdges(edges => applyEdgeChanges(changes, edges))
      triggerAutoSave()
    },
    [triggerAutoSave]
  )

  /** 用配置面板提交的新 data 整体覆盖指定节点，并触发自动保存。 */
  const onUpdateNode = useCallback(
    (nodeId: string, newData: any) => {
      setNodes(nodes =>
        nodes.map(node => {
          if (node.id === nodeId) {
            return {
              ...node,
              data: newData,
            }
          }
          return node
        })
      )
      triggerAutoSave()
    },
    [triggerAutoSave]
  )

  /** 只更新节点标题，避免整体覆盖 data 中的配置等其他字段。 */
  const onUpdateNodeLabel = useCallback(
    (nodeId: string, newLabel: string) => {
      setNodes(nodes =>
        nodes.map(node => {
          if (node.id === nodeId) {
            return {
              ...node,
              data: {
                ...node.data,
                label: newLabel,
              },
            }
          }
          return node
        })
      )
      triggerAutoSave()
    },
    [triggerAutoSave]
  )

  /** 初始视图适配参数：四周留 20% 边距，隐藏节点也参与边界计算。 */
  const fitViewOptions = useMemo(() => ({ padding: 0.2, includeHiddenNodes: true }), [])

  /** 把最后保存时间格式化为 HH:mm，供顶部工具栏展示；从未保存时返回 null。 */
  const formatLastSavedTime = useCallback(() => {
    if (!lastSavedAt) return null
    return lastSavedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }, [lastSavedAt])

  /** 打开测试运行面板，同时关闭节点配置与执行详情，保证右侧只显示一个面板。 */
  const handleTestRun = () => {
    setTestRunOpen(true)
    setSelectedNode(null)
    setSelectedExecutionId(null)
  }

  /** 关闭测试运行与执行详情，回到纯编辑状态。 */
  const handleExit = () => {
    setTestRunOpen(false)
    setSelectedExecutionId(null)
  }

  return (
    <div className="h-full relative flex flex-col">
      <FlowEditorHeader
        appName={appName}
        appId={appId}
        mode={mode}
        hasUnsavedChanges={hasUnsavedChanges}
        isSaving={isSaving}
        lastSavedAt={formatLastSavedTime()}
        onSave={saveWorkflow}
        onTestRun={handleTestRun}
        onExitTestRun={handleExit}
        onSelectExecution={executionId => {
          setSelectedExecutionId(executionId)
          setSelectedNode(null)
        }}
      />

      <div className="flex-1">
        {/* 通过 Context 把节点操作暴露给节点内部组件（例如节点卡片上的快捷操作） */}
        <FlowEditorContext.Provider value={{ onAddNode, hasStartNode, nodes, availableNodes }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_, node) => {
              console.log('onNodeClick', { _, node, mode })
              if (mode === 'edit') {
                setSelectedNode(node)
              }
            }}
            onConnect={onConnect}
            nodeTypes={flowNodeTypes}
            // 点击画布空白处关闭配置面板
            onPaneClick={() => {
              if (mode === 'edit') {
                setSelectedNode(null)
              }
            }}
            // 注意：不要用 onSelectionChange 同步 selectedNode。
            // 表单自动保存会更新 nodes，React Flow 随之触发的 selection 事件
            // 会把用户刚关闭的面板重新打开（表现为点 X「完全没反应」）。
            // 面板的打开统一由 onNodeClick 负责。
            fitView
            fitViewOptions={fitViewOptions}
            proOptions={{
              hideAttribution: true,
            }}
          >
            <Background bgColor="#f4f6fb" />
            {/* 小地图位置随右侧面板动态让位，避免被设置 / 测试 / 详情面板遮挡 */}
            <MiniMap
              pannable
              zoomable
              style={{
                right: mode === 'detail' ? 420 : selectedNode && testRunOpen ? 830 : selectedNode ? 400 : testRunOpen ? 420 : 0,
                width: 120,
                height: 80,
              }}
            />
            {/* 控制面板 显示+ - 放大缩小的按钮*/}
            <Controls />
          </ReactFlow>
        </FlowEditorContext.Provider>
      </div>

      {/* 右侧面板区：mode 决定显示哪一组面板；edit 模式下配置面板与测试运行面板可并排 */}
      {/* z-20 必须高于 FlowEditorHeader(z-10) 和 React Flow 的 pane(1)/renderer(4)，
          否则面板只是视觉上浮起来，点击会穿透到下层画布，X 看起来「点不动」 */}
      <div className="absolute top-12 right-4 z-20 flex gap-1">
        {/* Detail mode - only show execution detail panel */}
        {mode === 'detail' && (
          <ExecutionDetailPanel
            open={!!selectedExecutionId}
            onOpenChange={open => !open && setSelectedExecutionId(null)}
            appId={appId}
            executionId={selectedExecutionId}
            nodes={nodes}
            edges={edges}
          />
        )}

        {/* Edit mode - show settings panel and test run panel side by side */}
        {mode === 'edit' && (
          <>
            {selectedNode && (
              <Settings
                node={selectedNode}
                onUpdateNode={onUpdateNode}
                onUpdateNodeLabel={onUpdateNodeLabel}
                onClose={() => setSelectedNode(null)}
                nodes={nodes}
                edges={edges}
              />
            )}
            {testRunOpen && <TestRunPanel open={testRunOpen} onOpenChange={setTestRunOpen} appId={appId} nodes={nodes} edges={edges} />}
          </>
        )}
      </div>
    </div>
  )
}

/** FlowEditor 的对外入参，与 FlowEditorProps 字段保持一致。 */
interface FlowEditorPropsWrapper {
  appId: string
  appName: string
  initialNodes?: WorkflowFlowNode[]
  initialEdges?: WorkflowFlowEdge[]
}

/**
 * 对外导出的编辑器组件。
 * React Flow 的 hooks 必须在 ReactFlowProvider 内部调用，
 * 所以这里只负责包裹 Provider，真正的状态与交互逻辑在 EditorInner。
 */
export function FlowEditor({ appId, appName, initialNodes, initialEdges }: FlowEditorPropsWrapper) {
  return (
    <ReactFlowProvider>
      <EditorInner appId={appId} appName={appName} initialNodes={initialNodes} initialEdges={initialEdges} />
    </ReactFlowProvider>
  )
}

export default FlowEditor
