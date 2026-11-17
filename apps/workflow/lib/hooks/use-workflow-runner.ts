'use client'

/**
 * 工作流试运行 Hook
 *
 * 职责：把画布上的 nodes/edges 提交给后端执行接口，并消费后端以 SSE 推送的
 * 执行过程事件，实时更新每个节点的运行状态、日志和最终结果。
 *
 * 数据流：
 *   execute(inputs)
 *     -> POST /api/apps/{appId}/workflow/run（请求体包含 nodes/edges/inputs）
 *     -> 后端返回 text/event-stream
 *     -> 逐条解析 `data: {...}` 并分发到 handleSSEEvent
 *     -> 更新 TestRunState（节点状态、日志、耗时、token 用量、最终输出）
 *
 * 关键设计：
 *   - 用 AbortController 支持「取消执行」以及「重复点击执行时终止上一次请求」
 *   - 节点初始状态全部置为 pending，后续由服务端事件逐条推进
 *   - SSE 按 `\n\n` 分帧，未收完的半帧留在 buffer 中等待下一块数据
 */

import type { ExecutionLogEntry, NodeKind } from '@miaoma-aiflow/ai-engine'
import { useCallback, useRef, useState } from 'react'

import type {
  ErrorEventData,
  NodeEndEventData,
  NodeStartEventData,
  NodeTraceInfo,
  SSEEvent,
  TestRunState,
  WorkflowEndEventData,
  WorkflowStartEventData,
} from '@/lib/types/test-run'
import { createInitialTestRunState } from '@/lib/types/test-run'

/**
 * 提交给后端的节点结构（只取执行所需的最小字段）。
 * 完整的节点数据在画布上可能还带有 UI 状态，这里做一次裁剪，避免把无关字段发给服务端。
 */
interface FlowNode {
  /** 节点唯一 ID，SSE 事件靠它定位到具体节点 */
  id: string
  /** 节点类型，例如 start / llm / http / condition / end 或 plugin:{pluginId}:{nodeType} */
  type: string
  /** 画布坐标，执行阶段不使用，但后端可能用于可视化或日志，所以一并传递 */
  position: { x: number; y: number }
  data?: {
    /** 节点显示名称，仅用于运行面板展示 */
    label?: string
    /** 节点业务配置（表单值），由各节点的执行器消费 */
    config?: Record<string, unknown>
  }
}

/**
 * 提交给后端的边结构。
 * sourceHandle 用于区分条件分支等「一个节点多个出口」的场景。
 */
interface FlowEdge {
  /** 边唯一 ID */
  id: string
  /** 起点节点 ID */
  source: string
  /** 起点具体出口（条件分支的 case 标识），普通节点可为空 */
  sourceHandle?: string
  /** 终点节点 ID */
  target: string
}

interface UseWorkflowRunnerOptions {
  /** 当前应用 ID，拼进运行接口的 URL */
  appId: string
  /** 当前画布节点 */
  nodes: FlowNode[]
  /** 当前画布连线 */
  edges: FlowEdge[]
}

interface UseWorkflowRunnerReturn {
  /** 当前的运行状态快照（节点轨迹、日志、结果等） */
  state: TestRunState
  /** 触发一次执行；重复调用会先中断上一次请求 */
  execute: (inputs: Record<string, unknown>) => Promise<void>
  /** 清空运行状态，回到初始态（会中止进行中的请求） */
  reset: () => void
  /** 是否正在运行，本质是 state.status === 'running' */
  isRunning: boolean
  /** 中止当前执行，并把状态标记为错误态 */
  abort: () => void
}

/**
 * 工作流执行 Hook：发起运行请求 + 消费 SSE 实时更新执行状态。
 *
 * @param options 应用 ID，以及执行时使用的画布快照（nodes/edges）
 * @returns 运行状态与 execute/reset/abort 控制方法
 */
export function useWorkflowRunner({ appId, nodes, edges }: UseWorkflowRunnerOptions): UseWorkflowRunnerReturn {
  const [state, setState] = useState<TestRunState>(createInitialTestRunState())
  const abortControllerRef = useRef<AbortController | null>(null)

  const execute = useCallback(
    async (inputs: Record<string, unknown>) => {
      // 若已有正在进行的执行，先中止它，保证同一时刻只有一个运行实例
      // （避免旧请求的 SSE 事件混进新一轮状态里）
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }

      // 为本次执行创建独立的 AbortController，供 abort()/reset() 取消请求使用
      abortControllerRef.current = new AbortController()

      // 用当前画布节点初始化「节点轨迹」：先把所有节点标成 pending，
      // 后续由服务端的 node:start / node:end 事件逐个推进状态
      const initialNodeTraces = new Map<string, NodeTraceInfo>()
      for (const node of nodes) {
        initialNodeTraces.set(node.id, {
          nodeId: node.id,
          nodeName: (node.data?.label as string) || node.id,
          nodeType: node.type as NodeKind,
          status: 'pending',
          logs: [],
        })
      }
      console.log('initialNodeTraces:', { appId, nodes, edges, initialNodeTraces, inputs })
      // 立即把 UI 切到 running：记录本次输入、开始时间，清空上一次的结果
      setState({
        status: 'running',
        inputs,
        result: null,
        startTime: new Date(),
        endTime: null,
        duration: 0,
        executionId: null,
        nodeTraces: initialNodeTraces,
        totalTokens: 0,
      })

      try {
        // 发起执行请求：后端会把画布快照（nodes/edges）与用户输入一起交给工作流引擎，
        // 并以 SSE（text/event-stream）持续回传执行过程；signal 用于支持中途取消
        const response = await fetch(`/api/apps/${appId}/workflow/run`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ nodes, edges, inputs }),
          signal: abortControllerRef.current.signal,
        })

        // 非 2xx 说明请求在进入流式响应前就失败了（鉴权失败、参数错误等），
        // 尝试读取后端返回的 message 来展示更具体的错误
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          throw new Error(errorData.message || `HTTP ${response.status}`)
        }

        // 正常的 SSE 响应一定带有可读流，没有则视为服务端实现异常
        if (!response.body) {
          throw new Error('No response body')
        }

        // 用 reader 手动消费字节流，再用 TextDecoder 转成字符串；
        // buffer 用于拼接「跨 chunk 被截断」的 SSE 帧
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          // SSE 以空行（\n\n）作为一帧的结束符：
          // 前面的都是完整帧，最后一段可能是半帧，留在 buffer 里等下一块数据
          const lines = buffer.split('\n\n')
          buffer = lines.pop() || '' // 保留未收完的半帧

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const eventData = JSON.parse(line.slice(6)) as SSEEvent
                handleSSEEvent(eventData)
              } catch {
                // 单条事件解析失败（脏数据/半包）直接跳过，不能影响后续事件
              }
            }
          }
        }

        // 流结束后 buffer 里可能还剩最后一帧（末尾没有空行），需要补处理一次
        if (buffer.startsWith('data: ')) {
          try {
            const eventData = JSON.parse(buffer.slice(6)) as SSEEvent
            handleSSEEvent(eventData)
          } catch {
            // 同上：尾帧解析失败时忽略，避免抛到外层被当成执行失败
          }
        }
      } catch (error) {
        // 主动取消（abort/reset）会抛 AbortError，此时不应把状态改成错误，
        // 否则用户点了「停止」还会看到一条失败提示
        if ((error as Error).name === 'AbortError') {
          return
        }

        // 网络错误、HTTP 错误、流解析异常等统一落到错误态，并结束计时
        setState(prev => ({
          ...prev,
          status: 'error',
          endTime: new Date(),
          duration: prev.startTime ? Date.now() - prev.startTime.getTime() : 0,
          result: {
            success: false,
            outputs: {},
            error: error instanceof Error ? error : new Error(String(error)),
            executionId: prev.executionId || '',
            duration: prev.startTime ? Date.now() - prev.startTime.getTime() : 0,
            logs: [],
          },
        }))
      }
    },
    [appId, nodes, edges]
  )

  /**
   * 解析单条 SSE 事件并更新状态。
   *
   * 后端约定的事件类型：
   *   workflow:start -> 执行开始，带回 executionId
   *   node:start     -> 某个节点开始执行
   *   node:end       -> 某个节点执行结束（成功/失败、耗时、输入输出）
   *   log            -> 节点内的一条日志
   *   workflow:end   -> 整体结束（成功/失败、总耗时、token 用量、最终输出）
   *   error          -> 引擎级错误
   *
   * 所有更新都基于 prev 做不可变更新，保证 React 能正确触发重渲染。
   */
  const handleSSEEvent = useCallback((event: SSEEvent) => {
    console.log('handleSSEEvent:', { event })
    switch (event.type) {
      // 执行开始：主要记录 executionId，后续用于查询执行历史
      case 'workflow:start': {
        const data = event.data as WorkflowStartEventData
        setState(prev => ({
          ...prev,
          executionId: data.executionId,
        }))
        break
      }

      // 节点开始执行：把该节点标记为 running，并记录开始时间；
      // 已有日志要保留，避免同一节点重复执行时丢掉之前的输出
      case 'node:start': {
        const data = event.data as NodeStartEventData
        setState(prev => {
          const newTraces = new Map(prev.nodeTraces)
          const existing = newTraces.get(data.nodeId)
          newTraces.set(data.nodeId, {
            nodeId: data.nodeId,
            nodeName: data.nodeName,
            nodeType: data.nodeType,
            status: 'running',
            startTime: new Date(event.timestamp),
            logs: existing?.logs || [],
          })
          return { ...prev, nodeTraces: newTraces }
        })
        break
      }

      // 节点执行结束：根据 success 落到 success/error，并补齐耗时、
      // 输入输出和错误信息，供运行面板展示节点详情
      case 'node:end': {
        const data = event.data as NodeEndEventData
        setState(prev => {
          const newTraces = new Map(prev.nodeTraces)
          const existing = newTraces.get(data.nodeId)
          if (existing) {
            newTraces.set(data.nodeId, {
              ...existing,
              status: data.success ? 'success' : 'error',
              endTime: new Date(event.timestamp),
              duration: data.duration,
              inputs: data.inputs,
              outputs: data.outputs,
              error: data.error?.message,
            })
          }
          return { ...prev, nodeTraces: newTraces }
        })
        break
      }

      // 节点日志：只追加到对应节点的 logs 里；
      // 没有 nodeId 的日志（例如引擎全局日志）当前 UI 不展示，直接忽略
      case 'log': {
        const logData = event.data as ExecutionLogEntry & { timestamp: string }
        if (logData.nodeId) {
          setState(prev => {
            const newTraces = new Map(prev.nodeTraces)
            const existing = newTraces.get(logData.nodeId!)
            if (existing) {
              newTraces.set(logData.nodeId!, {
                ...existing,
                logs: [
                  ...existing.logs,
                  {
                    ...logData,
                    timestamp: new Date(logData.timestamp),
                  },
                ],
              })
            }
            return { ...prev, nodeTraces: newTraces }
          })
        }
        break
      }

      // 整体结束：写入最终状态、总耗时、token 用量和输出结果；
      // executionId 沿用 workflow:start 里的值（正常都会先收到 start）
      case 'workflow:end': {
        const data = event.data as WorkflowEndEventData
        setState(prev => ({
          ...prev,
          status: data.success ? 'success' : 'error',
          endTime: new Date(event.timestamp),
          duration: data.duration,
          totalTokens: data.totalTokens || 0,
          result: {
            success: data.success,
            outputs: data.outputs,
            error: data.error ? new Error(data.error) : undefined,
            executionId: prev.executionId || '',
            duration: data.duration,
            logs: [],
          },
        }))
        break
      }

      // 引擎级错误：直接结束本次执行并展示错误信息
      case 'error': {
        const data = event.data as ErrorEventData
        setState(prev => ({
          ...prev,
          status: 'error',
          endTime: new Date(event.timestamp),
          duration: prev.startTime ? Date.now() - prev.startTime.getTime() : 0,
          result: {
            success: false,
            outputs: {},
            error: new Error(data.message),
            executionId: prev.executionId || '',
            duration: prev.startTime ? Date.now() - prev.startTime.getTime() : 0,
            logs: [],
          },
        }))
        break
      }
    }
  }, [])

  /**
   * 重置运行状态：
   * 先中止仍在进行的请求，避免它继续往已清空的状态里写数据，然后回到初始态
   */
  const reset = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setState(createInitialTestRunState())
  }, [])

  /**
   * 中止执行：
   * 1. abort 掉 fetch，浏览器会以 AbortError 结束读取循环（该异常会被吞掉，不改状态）
   * 2. 主动把状态标记为 error 并结束计时，让 UI 立刻反映「已停止」
   */
  const abort = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setState(prev => ({
      ...prev,
      status: 'error',
      endTime: new Date(),
      duration: prev.startTime ? Date.now() - prev.startTime.getTime() : 0,
    }))
  }, [])

  return {
    state,
    execute,
    reset,
    isRunning: state.status === 'running',
    abort,
  }
}
