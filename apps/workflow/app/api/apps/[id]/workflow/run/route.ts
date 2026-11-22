/**
 * POST /api/apps/[id]/workflow/run
 *
 * 工作流「测试运行」接口，以 SSE（text/event-stream）流式返回执行过程。
 *
 * 整体流程：
 *   1. 登录校验 + 应用归属校验（只能运行自己的应用）
 *   2. 校验请求体中的 nodes / edges，并转换为 ai-engine 的 WorkflowDefinition
 *   3. 在数据库中创建一条 RUNNING 状态的执行记录
 *   4. 创建引擎、注册该工作流用到的远程插件节点
 *   5. 边执行边推送 SSE 事件（workflow:start / node:start / node:end / log / workflow:end）
 *   6. 执行结束后把结果与节点轨迹回写到执行记录
 *
 * 为什么用 SSE 而不是普通 JSON 响应：
 *   工作流执行可能持续较久，前端需要实时看到每个节点的状态流转，
 *   用流式响应可以边跑边推送，而不是等全部结束才返回。
 */

import { createWorkflowEngine, NodeKind, WorkflowDefinition } from '@renmx-aiflow/ai-engine'
import { NextRequest } from 'next/server'

import { ExecutionStatus } from '@/app/generated/prisma/enums'
import { apiError, ErrorCode } from '@/lib/api-response'
import { getCurrentUserId } from '@/lib/auth'
import { createRequestLogger } from '@/lib/logger'
import { prisma } from '@/lib/prisma'
import { registerRemotePluginNodesForWorkflow, type WorkflowEngineLike } from '@/lib/services/plugin-runtime-service'
import type {
  ErrorEventData,
  NodeEndEventData,
  NodeStartEventData,
  SSEEvent,
  WorkflowEndEventData,
  WorkflowStartEventData,
} from '@/lib/types/test-run'

/**
 * 落库用的节点轨迹记录（最终存进 WorkflowExecution.nodeTraces）。
 * 与前端 NodeTraceInfo 结构基本一致，时间用 ISO 字符串以便 JSON 序列化。
 */
interface NodeTraceRecord {
  /** 节点 ID */
  nodeId: string
  /** 节点显示名称 */
  nodeName: string
  /** 节点类型 */
  nodeType: string
  /** 执行状态 */
  status: 'pending' | 'running' | 'success' | 'error'
  /** 开始时间（ISO 字符串） */
  startTime?: string
  /** 结束时间（ISO 字符串） */
  endTime?: string
  /** 耗时（毫秒） */
  duration?: number
  /** 节点输入 */
  inputs?: Record<string, unknown>
  /** 节点输出 */
  outputs?: Record<string, unknown>
  /** 失败时的错误信息 */
  error?: string
}

// ============================================================
// 请求类型定义
// ============================================================

/**
 * 前端提交的节点结构（与画布数据保持一致，只取执行需要的字段）。
 */
interface FlowNode {
  id: string
  type: string
  position: { x: number; y: number }
  data?: {
    label?: string
    config?: Record<string, unknown>
  }
}

/**
 * 前端提交的连线结构；sourceHandle 用于条件分支等有多个出口的节点。
 */
interface FlowEdge {
  id: string
  source: string
  sourceHandle?: string
  target: string
}

/**
 * 运行请求体：画布快照 + 本次运行的输入参数。
 */
interface RunWorkflowRequest {
  nodes: FlowNode[]
  edges: FlowEdge[]
  inputs: Record<string, unknown>
}

// ============================================================
// POST /api/apps/[id]/workflow/run —— 以 SSE 方式执行工作流
// ============================================================

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const logger = createRequestLogger(crypto.randomUUID())
    const { id: appId } = await params
    const userId = await getCurrentUserId()

    // 未登录直接返回 401：运行工作流会消耗模型额度，必须校验身份
    if (!userId) {
      return apiError(ErrorCode.UNAUTHORIZED, '请先登录')
    }

    // 校验应用存在且属于当前用户；不满足时统一按「应用不存在」处理，
    // 避免泄露他人应用是否存在
    const app = await prisma.app.findFirst({
      where: {
        id: appId,
        userId,
        isDeleted: false,
      },
    })

    if (!app) {
      return apiError(ErrorCode.APP_NOT_FOUND, '应用不存在')
    }

    // 解析并校验请求体：nodes/edges 必须都是数组，否则引擎无法构图
    const body = (await request.json()) as RunWorkflowRequest
    const { nodes, edges, inputs } = body
    logger.info({ nodes, edges, inputs }, '运行工作流请求体')

    if (!nodes || !Array.isArray(nodes)) {
      return apiError(ErrorCode.VALIDATION_ERROR, '节点数据格式错误')
    }

    if (!edges || !Array.isArray(edges)) {
      return apiError(ErrorCode.VALIDATION_ERROR, '边数据格式错误')
    }

    // 转换为 ai-engine 的 WorkflowDefinition：
    // 画布上的坐标、选中态等 UI 字段在这里被丢弃，只保留执行需要的 id/type/data
    const workflow: WorkflowDefinition = {
      id: `test-${appId}-${Date.now()}`,
      name: `${app.name} - 测试运行`,
      nodes: nodes.map(n => ({
        id: n.id,
        type: n.type as NodeKind,
        data: {
          label: n.data?.label,
          config: n.data?.config,
        },
      })),
      edges: edges.map(e => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle,
        target: e.target,
      })),
    }
    logger.info({ workflow }, '转换后的工作流定义')

    // 创建 SSE 可读流：start 回调会在 Response 返回后异步执行整个工作流
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder()

        // SSE 发送工具：统一编码为 `data: {json}\n\n` 格式
        // （\n\n 是 SSE 的帧分隔符，前端按空行切分）
        const send = <T>(event: SSEEvent<T>) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
          } catch {
            // 客户端已断开时 enqueue 会抛错，这里忽略即可，避免中断引擎执行
          }
        }

        // 本次执行的起始时间、累计 token 消耗、节点轨迹（按 nodeId 索引）
        const startTime = Date.now()
        let totalTokens = 0
        const nodeTraces: Record<string, NodeTraceRecord> = {}

        // 生成对外可见的执行 ID：时间戳 base36 + 随机串，便于日志检索与前端关联
        const executionId = `exec-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`

        // 先落一条 RUNNING 记录：即使后续执行崩溃，也能在执行历史里看到这次尝试
        const execution = await prisma.workflowExecution.create({
          data: {
            executionId,
            status: ExecutionStatus.RUNNING,
            inputs: inputs as object,
            appId,
            startedAt: new Date(),
          },
        })

        try {
          // 创建引擎实例（verbose 打开详细日志，便于开发调试）
          const engine = createWorkflowEngine({ verbose: true })

          // 关键一步：把该工作流里用到的远程插件节点注册进引擎，
          // 否则执行到 plugin:xxx 类型节点时会因「未知节点类型」失败
          await registerRemotePluginNodesForWorkflow({
            engine: engine as unknown as WorkflowEngineLike,
            workflow,
            userId,
          })

          // 先通知前端「执行已开始」，前端据此记录 executionId
          send<WorkflowStartEventData>({
            type: 'workflow:start',
            data: { executionId },
            timestamp: new Date().toISOString(),
          })

          // 执行工作流，并通过回调实时把过程转成 SSE 事件
          // 三个回调分别对应：节点开始、节点结束、节点日志
          const result = await engine.execute(workflow, inputs, {
            onNodeStart: (nodeId, nodeType, nodeName) => {
              // 记录节点轨迹的初始态（running），后续 onNodeEnd 会补全结果
              nodeTraces[nodeId] = {
                nodeId,
                nodeName: nodeName || nodeId,
                nodeType,
                status: 'running',
                startTime: new Date().toISOString(),
              }

              send<NodeStartEventData>({
                type: 'node:start',
                data: { nodeId, nodeType, nodeName },
                timestamp: new Date().toISOString(),
              })
            },
            onNodeEnd: (nodeId, nodeResult) => {
              // 如果节点输出里带 tokens 字段，就累加到本次执行的总 token 消耗
              if (nodeResult.outputs?.tokens && typeof nodeResult.outputs.tokens === 'number') {
                totalTokens += nodeResult.outputs.tokens
              }

              // 用节点执行结果补全轨迹：状态、结束时间、耗时、输入输出、错误
              if (nodeTraces[nodeId]) {
                nodeTraces[nodeId].status = nodeResult.success ? 'success' : 'error'
                nodeTraces[nodeId].endTime = new Date().toISOString()
                nodeTraces[nodeId].duration = nodeResult.duration
                nodeTraces[nodeId].inputs = nodeResult.inputs
                nodeTraces[nodeId].outputs = nodeResult.outputs
                if (nodeResult.error) {
                  nodeTraces[nodeId].error = nodeResult.error.message
                }
              }

              // 发送节点结束事件：包含节点执行结果
              send<NodeEndEventData>({
                type: 'node:end',
                data: {
                  nodeId,
                  success: nodeResult.success,
                  inputs: nodeResult.inputs,
                  outputs: nodeResult.outputs,
                  error: nodeResult.error,
                  duration: nodeResult.duration,
                  matchedBranch: nodeResult.matchedBranch,
                },
                timestamp: new Date().toISOString(),
              })
            },
            onLog: entry => {
              send({
                type: 'log',
                data: {
                  ...entry,
                  // Date 无法直接 JSON 序列化，这里手动转成 ISO 字符串
                  timestamp: entry.timestamp.toISOString(),
                },
                timestamp: new Date().toISOString(),
              })
            },
          })

          const duration = Date.now() - startTime

          // 执行结束后回写执行记录：最终状态、输出、错误、耗时、token、节点轨迹
          await prisma.workflowExecution.update({
            where: { id: execution.id },
            data: {
              status: result.success ? ExecutionStatus.SUCCESS : ExecutionStatus.ERROR,
              outputs: result.outputs as object,
              error: result.error?.message,
              duration,
              totalTokens,
              nodeTraces: nodeTraces as object,
              completedAt: new Date(),
            },
          })

          // 最后推送 workflow:end：前端据此结束 loading 并展示结果
          send<WorkflowEndEventData>({
            type: 'workflow:end',
            data: {
              success: result.success,
              outputs: result.outputs,
              duration,
              totalTokens,
              error: result.error?.message,
            },
            timestamp: new Date().toISOString(),
          })
        } catch (error) {
          // 引擎初始化失败、插件加载失败、节点执行抛异常等都会走到这里
          console.error('Workflow execution error:', error)

          const duration = Date.now() - startTime
          const errorMessage = error instanceof Error ? error.message : '执行工作流失败'

          // 失败也要回写执行记录，保证执行历史里能看到失败原因与已跑完的节点轨迹
          await prisma.workflowExecution.update({
            where: { id: execution.id },
            data: {
              status: ExecutionStatus.ERROR,
              error: errorMessage,
              duration,
              totalTokens,
              nodeTraces: nodeTraces as object,
              completedAt: new Date(),
            },
          })

          send<ErrorEventData>({
            type: 'error',
            data: {
              message: errorMessage,
            },
            timestamp: new Date().toISOString(),
          })
        } finally {
          // 无论成功失败都要关闭流，否则前端 reader 会一直挂起
          controller.close()
        }
      },
    })

    // 返回 SSE 响应：禁用缓存并保持长连接，浏览器会边接收边解析
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  } catch (error) {
    // 进入流式响应之前就失败（如 JSON 解析失败、数据库不可用），按普通 JSON 错误返回
    console.error('执行工作流失败:', error)
    return apiError(ErrorCode.INTERNAL_SERVER_ERROR, error instanceof Error ? error.message : '执行工作流失败')
  }
}
