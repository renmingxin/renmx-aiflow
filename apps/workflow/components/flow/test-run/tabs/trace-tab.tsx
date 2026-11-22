'use client'

/**
 * 测试运行 - 「追踪」标签页
 *
 * 按工作流的拓扑执行顺序展示每个节点的运行轨迹：
 *   - 顶部汇总：总数，以及成功 / 运行中 / 失败 / 等待中的数量
 *   - 每个节点可展开，查看错误、输入、输出和日志
 *
 * 节点顺序由 edges 做拓扑排序得出，而不是按画布上的坐标或数组顺序，
 * 这样即使节点在画布上被拖乱，追踪列表也始终符合真实执行顺序。
 */

import type { ExecutionLogEntry, NodeKind } from '@renmx-aiflow/ai-engine'
import type { Edge, Node } from '@xyflow/react'
import { AlertCircleIcon, CheckCircle2Icon, ChevronDownIcon, ClockIcon, Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'

import { getColor, getIconComponent } from '@/components/flow/icon-map'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { NodeTraceInfo, NodeTraceStatus } from '@/lib/types/test-run'
import { cn } from '@/lib/utils'

interface TraceTabProps {
  /** nodeId -> 节点运行轨迹（状态、耗时、输入输出、日志） */
  nodeTraces: Map<string, NodeTraceInfo>
  /** 画布节点，用于读取节点类型图标和计算执行顺序 */
  nodes: Node[]
  /** 画布连线，用于拓扑排序 */
  edges: Edge[]
}

/**
 * 格式化节点耗时。
 * 未执行过（duration 为 undefined）显示 “-”，小于 1 秒按毫秒展示，否则保留两位小数显示秒。
 */
function formatDuration(ms?: number): string {
  if (ms === undefined) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/**
 * 节点轨迹的状态图标：
 *   running -> 旋转（蓝） / success -> 对勾（绿） / error -> 警告（红） / 其他 -> 时钟（灰）
 */
function StatusIcon({ status }: { status: NodeTraceStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
    case 'success':
      return <CheckCircle2Icon className="h-3 w-3 text-green-500" />
    case 'error':
      return <AlertCircleIcon className="h-3 w-3 text-red-500" />
    default:
      return <ClockIcon className="h-3 w-3 text-gray-400" />
  }
}

/**
 * 日志级别徽标：用不同底色区分 debug / info / warn / error。
 * 遇到未知级别时回退到 info 的配色，避免样式丢失。
 */
function LogLevelBadge({ level }: { level: ExecutionLogEntry['level'] }) {
  const colors: Record<string, string> = {
    debug: 'bg-gray-100 text-gray-600',
    info: 'bg-blue-100 text-blue-600',
    warn: 'bg-yellow-100 text-yellow-600',
    error: 'bg-red-100 text-red-600',
  }
  return <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${colors[level] || colors.info}`}>{level}</span>
}

/**
 * 节点类型图标：从 icon-map 取该类型对应的图标与主题色，
 * 渲染成带底色的小方块；未匹配到颜色时用灰色兜底。
 */
function NodeTypeIcon({ type }: { type: NodeKind }) {
  const Icon = getIconComponent(type)
  const colorClass = getColor(type) || 'bg-gray-700'

  return (
    <div className={cn('rounded p-1', colorClass)}>
      <Icon className="h-3 w-3 text-white" />
    </div>
  )
}

/**
 * 轨迹详情中的通用小节：左侧标题（可带数量徽标），下方放具体内容。
 * 把「错误 / 输入 / 输出 / 日志」四块的标题样式统一起来。
 */
function DetailSection({ label, children, badge }: { label: string; children: React.ReactNode; badge?: React.ReactNode }) {
  return (
    <div className="overflow-hidden">
      <div className="flex items-center gap-2 mb-1">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {badge}
      </div>
      {children}
    </div>
  )
}

/**
 * 单个节点的轨迹条目。
 *
 * 折叠逻辑：
 *   - 只有存在输入/输出/错误/日志时才允许展开，否则按钮 disabled，避免点了没内容
 *   - 收起时只显示图标、名称、耗时和状态；展开后展示四个详情小节
 */
function NodeTraceItem({ trace, nodeType }: { trace: NodeTraceInfo; nodeType: NodeKind }) {
  /** 当前节点详情是否展开 */
  const [isOpen, setIsOpen] = useState(false)

  // 是否具备可展开的详情：任意一项非空即可
  const hasDetails =
    (trace.inputs && Object.keys(trace.inputs).length > 0) ||
    (trace.outputs && Object.keys(trace.outputs).length > 0) ||
    trace.error ||
    (trace.logs && trace.logs.length > 0)

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="rounded-md overflow-hidden shadow-md">
        <CollapsibleTrigger asChild>
          <button
            className="flex items-center justify-between w-full px-2 py-1.5 text-left hover:bg-black/5 transition-colors"
            disabled={!hasDetails}
          >
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <NodeTypeIcon type={nodeType} />
              <span className="text-sm font-medium truncate">{trace.nodeName}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {trace.duration !== undefined && <span className="text-xs text-muted-foreground">{formatDuration(trace.duration)}</span>}
              <StatusIcon status={trace.status} />
              {hasDetails && (
                <ChevronDownIcon className={cn('h-3 w-3 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
              )}
            </div>
          </button>
        </CollapsibleTrigger>

        {hasDetails && (
          <CollapsibleContent>
            <div className="bg-muted/30 p-2 space-y-2">
              {/* 错误：节点执行失败时的错误信息 */}
              {trace.error && (
                <DetailSection label="错误">
                  <div className="bg-red-50 border border-red-200 rounded p-2 overflow-hidden">
                    <p className="text-xs font-mono text-red-600 break-all">{trace.error}</p>
                  </div>
                </DetailSection>
              )}

              {/* 输入：节点执行时收到的入参，标题右侧显示字段数量 */}
              {trace.inputs && Object.keys(trace.inputs).length > 0 && (
                <DetailSection
                  label="输入"
                  badge={<span className="text-xs text-muted-foreground">({Object.keys(trace.inputs).length})</span>}
                >
                  <pre className="text-xs font-mono bg-white p-2 rounded border overflow-auto max-h-[150px] whitespace-pre-wrap break-all">
                    {JSON.stringify(trace.inputs, null, 2)}
                  </pre>
                </DetailSection>
              )}

              {/* 输出：节点执行产生的出参，标题右侧显示字段数量 */}
              {trace.outputs && Object.keys(trace.outputs).length > 0 && (
                <DetailSection
                  label="输出"
                  badge={<span className="text-xs text-muted-foreground">({Object.keys(trace.outputs).length})</span>}
                >
                  <pre className="text-xs font-mono bg-white p-2 rounded border overflow-auto max-h-[150px] whitespace-pre-wrap break-all">
                    {JSON.stringify(trace.outputs, null, 2)}
                  </pre>
                </DetailSection>
              )}

              {/* 日志：该节点执行期间产生的日志，带级别徽标 */}
              {trace.logs && trace.logs.length > 0 && (
                <DetailSection label="日志" badge={<span className="text-xs text-muted-foreground">({trace.logs.length})</span>}>
                  <div className="space-y-1 max-h-[120px] overflow-auto">
                    {trace.logs.map((log, idx) => (
                      <div key={idx} className="text-xs font-mono bg-white p-1.5 rounded border flex gap-2 items-start">
                        <LogLevelBadge level={log.level} />
                        <span className="flex-1 break-all">{log.message}</span>
                      </div>
                    ))}
                  </div>
                </DetailSection>
              )}
            </div>
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  )
}

/**
 * 基于 edges 计算节点的拓扑执行顺序（Kahn 算法）。
 *
 * 思路：
 *   1. 建立邻接表 adjacency（source -> target[]）和入度表 inDegree
 *   2. 把所有入度为 0 的节点入队（通常是「开始」节点）
 *   3. 逐个出队并加入结果，同时把邻居入度减 1，减到 0 就入队
 *
 * 注意：若图中存在环，环上的节点不会进入结果，属于可接受的降级
 * （正常的工作流不应存在环）。
 */
function getExecutionOrder(nodes: Node[], edges: Edge[]): Node[] {
  // 入度表：nodeId -> 指向它的边数量
  const inDegree = new Map<string, number>()
  // 邻接表：nodeId -> 它指向的下游节点 ID 列表
  const adjacency = new Map<string, string[]>()
  // 用于过滤掉指向不存在节点的脏边
  const nodeSet = new Set(nodes.map(n => n.id))

  // 初始化：所有节点入度为 0，邻接表为空数组
  for (const node of nodes) {
    inDegree.set(node.id, 0)
    adjacency.set(node.id, [])
  }

  // 遍历边构建图：只统计两端节点都存在的边
  for (const edge of edges) {
    if (nodeSet.has(edge.source) && nodeSet.has(edge.target)) {
      const targets = adjacency.get(edge.source) || []
      targets.push(edge.target)
      adjacency.set(edge.source, targets)
      inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1)
    }
  }

  // Kahn 算法：队列存放入度为 0 的节点，result 保存最终顺序
  const queue: string[] = []
  const result: Node[] = []

  // 起点：所有没有上游依赖的节点（一般只有「开始」节点）
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0) {
      queue.push(nodeId)
    }
  }

  const nodeMap = new Map(nodes.map(n => [n.id, n]))

  while (queue.length > 0) {
    // 出队一个节点，按 ID 取回节点对象加入结果
    const nodeId = queue.shift()!
    const node = nodeMap.get(nodeId)
    if (node) {
      result.push(node)
    }

    // 遍历下游节点：入度减 1，减到 0 说明它所有上游都已处理完，可以入队
    const neighbors = adjacency.get(nodeId) || []
    for (const neighbor of neighbors) {
      const newDegree = (inDegree.get(neighbor) || 0) - 1
      inDegree.set(neighbor, newDegree)
      if (newDegree === 0) {
        queue.push(neighbor)
      }
    }
  }

  return result
}

/**
 * 「追踪」标签页主组件。
 *
 * 职责：
 *   1. 把画布 nodes 按拓扑执行顺序排序，并与 nodeTraces 合并成展示列表
 *   2. 统计各状态数量，渲染顶部汇总
 *   3. 逐条渲染 NodeTraceItem
 *
 * 注意：nodeTraces 里可能存在画布上已删除的节点（或反之），
 * 这里以画布节点为准做匹配，找不到轨迹的节点不会展示。
 */
export function TraceTab({ nodeTraces, nodes, edges }: TraceTabProps) {
  // 按拓扑执行顺序整理轨迹，保证列表顺序与实际运行顺序一致
  const orderedTraces = useMemo(() => {
    // 先对画布做拓扑排序，得到节点的执行先后
    const sortedNodes = getExecutionOrder(nodes, edges)

    const traces: Array<{ trace: NodeTraceInfo; nodeType: NodeKind }> = []

    // 按排序结果依次取对应轨迹；没有轨迹的节点直接跳过
    for (const node of sortedNodes) {
      const trace = nodeTraces.get(node.id)
      if (trace) {
        traces.push({
          trace,
          nodeType: node.type as NodeKind,
        })
      }
    }

    return traces
  }, [nodeTraces, nodes, edges])

  // 汇总各状态数量，用于顶部一行统计展示
  const stats = useMemo(() => {
    let pending = 0
    let running = 0
    let success = 0
    let error = 0

    for (const { trace } of orderedTraces) {
      switch (trace.status) {
        case 'pending':
          pending++
          break
        case 'running':
          running++
          break
        case 'success':
          success++
          break
        case 'error':
          error++
          break
      }
    }

    return { pending, running, success, error, total: orderedTraces.length }
  }, [orderedTraces])

  // 没有任何轨迹（尚未运行，或画布为空）
  if (orderedTraces.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <p className="text-sm">运行工作流后查看执行追踪</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* 顶部汇总：总数 + 各状态数量（数量为 0 的状态不展示，保持简洁） */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground px-1">
        <span>
          共 <strong className="text-foreground">{stats.total}</strong> 个节点
        </span>
        {stats.success > 0 && (
          <span className="flex items-center gap-1">
            <CheckCircle2Icon className="h-3 w-3 text-green-500" />
            {stats.success}
          </span>
        )}
        {stats.running > 0 && (
          <span className="flex items-center gap-1">
            <Loader2 className="h-3 w-3 text-blue-500 animate-spin" />
            {stats.running}
          </span>
        )}
        {stats.error > 0 && (
          <span className="flex items-center gap-1">
            <AlertCircleIcon className="h-3 w-3 text-red-500" />
            {stats.error}
          </span>
        )}
        {stats.pending > 0 && (
          <span className="flex items-center gap-1">
            <ClockIcon className="h-3 w-3 text-gray-400" />
            {stats.pending}
          </span>
        )}
      </div>

      {/* 节点轨迹列表：已按拓扑顺序排列 */}
      <div className="space-y-1.5">
        {orderedTraces.map(({ trace, nodeType }) => (
          <NodeTraceItem key={trace.nodeId} trace={trace} nodeType={nodeType} />
        ))}
      </div>
    </div>
  )
}
