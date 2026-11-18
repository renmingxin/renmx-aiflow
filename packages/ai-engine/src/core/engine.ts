/**
 * ai-engine 核心：工作流引擎
 *
 * 职责：接收一份工作流定义（节点 + 连线）与输入参数，按拓扑顺序逐个执行节点，
 * 汇总「结束」节点的输出作为最终结果。
 *
 * 执行模型（线性推进 + 分支裁剪）：
 *   1. 校验工作流（节点类型是否注册、起止节点是否合法等）
 *   2. 创建执行上下文（保存输入、变量表、节点完成状态）
 *   3. 用 GraphBuilder 做拓扑排序，得到初始执行顺序；有环直接报错
 *   4. 依次执行节点，每个节点前后触发 onNodeStart / onNodeEnd 回调
 *   5. 遇到 condition 节点时按 matchedBranch 裁剪执行顺序，跳过未选中的分支
 *   6. 收集 end 节点的输出，返回 WorkflowResult
 *
 * 与 SSE 的关系：
 *   引擎本身不关心传输方式，它只通过 ExecuteOptions 里的回调向上层报告进度；
 *   上层（Next 路由）再把这些回调转成 SSE 事件推给前端。
 *
 * 错误处理约定：
 *   节点失败或校验失败不会向外抛异常，而是被 catch 后返回 success: false 的结果，
 *   保证调用方总能看到 executionId / duration / logs 等诊断信息。
 */

import { createExecutionLogger } from '../logger'
import { createDefaultRegistry, NodeRegistry } from '../nodes'
import type {
  ExecuteOptions,
  NodeExecutionResult,
  ValidationResult,
  WorkflowDefinition,
  WorkflowInput,
  WorkflowNode,
  WorkflowResult,
} from '../types'
import { createDefaultWorkflowValidator, DefaultWorkflowValidator } from '../validators'
import { createExecutionContext } from './context'
import { GraphBuilder } from './graph-builder'

/**
 * 工作流引擎配置
 */
/**
 * 工作流引擎配置项，构造时传入，缺省值见构造函数。
 */
export interface WorkflowEngineConfig {
  /** Ollama 服务地址，供 LLM 类节点调用本地模型时使用，默认 http://localhost:11434 */
  ollamaBaseUrl?: string
  /** 默认超时时间（毫秒），目前保留在配置中供节点执行器读取，默认 30000 */
  defaultTimeout?: number
  /** 是否启用详细日志：开启后 debug 级别日志也会被收集并回调 */
  verbose?: boolean
}

/**
 * 工作流引擎对外暴露的能力：执行、校验、取节点注册中心。
 * 上层依赖该接口而不是具体实现，便于替换或测试。
 */
export interface IWorkflowEngine {
  /**
   * 执行工作流
   * @param workflow 工作流定义
   * @param inputs 输入参数
   * @param options 执行选项（可选，用于实时回调）
   */
  execute(workflow: WorkflowDefinition, inputs: WorkflowInput, options?: ExecuteOptions): Promise<WorkflowResult>

  /**
   * 验证工作流定义
   */
  validate(workflow: WorkflowDefinition): ValidationResult

  /**
   * 获取节点注册中心
   */
  getRegistry(): NodeRegistry
}

/**
 * 工作流引擎默认实现。
 *
 * 三个核心依赖：
 *   registry          节点执行器注册表（内置节点 + 运行时注册的插件节点）
 *   workflowValidator 工作流结构校验器
 *   config            合并默认值后的引擎配置
 */
export class WorkflowEngine implements IWorkflowEngine {
  /** 节点类型 -> 执行器 的注册表，插件节点通过它动态注册进来 */
  private registry: NodeRegistry
  /** 已填充默认值的配置 */
  private config: Required<WorkflowEngineConfig>
  /** 工作流校验器 */
  private workflowValidator: DefaultWorkflowValidator

  /**
   * 构造引擎：合并配置默认值，初始化内置节点注册表与校验器。
   * 注意这里只注册内置节点，插件节点由调用方在执行前注册。
   */
  constructor(config: WorkflowEngineConfig = {}) {
    this.config = {
      ollamaBaseUrl: config.ollamaBaseUrl ?? 'http://localhost:11434',
      defaultTimeout: config.defaultTimeout ?? 30000,
      verbose: config.verbose ?? false,
    }

    this.registry = createDefaultRegistry()
    this.workflowValidator = createDefaultWorkflowValidator()
  }

  /**
   * 执行工作流。
   *
   * @param workflow 工作流定义（节点、连线、元信息）
   * @param inputs   本次运行的输入参数，会写入执行上下文供 start 节点读取
   * @param options  执行选项，主要是三个实时回调：
   *                 onNodeStart 节点开始、onNodeEnd 节点结束、onLog 执行日志
   * @returns 统一结果对象：成功时带 outputs，失败时带 error；两种情况都包含
   *          executionId、duration、logs，便于排查
   */
  async execute(workflow: WorkflowDefinition, inputs: WorkflowInput, options?: ExecuteOptions): Promise<WorkflowResult> {
    // 每次执行生成独立 ID，日志与结果都以它为关联键
    const executionId = this.generateExecutionId()
    const startTime = Date.now()

    // 创建执行日志器：把内部日志同时缓存到 entries 并透传给 onLog 回调
    const logger = createExecutionLogger(executionId, this.config.verbose, options?.onLog)

    logger.info('Workflow execution started', {
      workflowId: workflow.id,
      workflowName: workflow.name,
      inputs,
      nodeCount: workflow.nodes.length,
      edgeCount: workflow.edges.length,
    })

    try {
      // 1. 结构校验：节点类型是否注册、是否存在开始/结束节点、连线是否合法等
      //    校验不通过直接抛错，由外层 catch 转成 success: false 的结果
      const validation = this.validate(workflow)
      if (!validation.valid) {
        throw new Error(`Workflow validation failed: ${validation.errors?.join(', ')}`)
      }

      // 2. 创建执行上下文：保存输入、变量表、节点完成标记，贯穿整个执行过程
      const context = createExecutionContext(executionId, workflow, inputs)

      // 3. 构建执行图：根据连线做拓扑排序，得到节点的初始执行顺序
      const graphBuilder = new GraphBuilder(workflow)

      // 有环意味着永远无法确定执行先后，必须直接拒绝
      if (graphBuilder.hasCycle()) {
        throw new Error('Workflow contains a cycle')
      }

      // 注意：后续条件分支会重新计算这个顺序，所以用 let
      let executionOrder = graphBuilder.getExecutionOrder()

      logger.debug('Execution order determined', {
        order: executionOrder.map(n => `${n.id}(${n.type})`),
      })

      // 4. 按拓扑顺序逐个执行节点
      //    finalOutputs 收集 end 节点的输出；executedNodes 防止同一节点被重复执行
      let finalOutputs: Record<string, unknown> = {}
      const executedNodes = new Set<string>()

      for (const node of executionOrder) {
        // 跳过已执行节点：分支裁剪后重新排序可能把已跑过的节点再次带入列表
        if (executedNodes.has(node.id)) {
          continue
        }

        // 告诉日志器当前节点，后续该节点的日志会自动带上 nodeId
        logger.setCurrentNode(node.id)

        // 回调：节点开始（上层据此推送 SSE node:start）
        const nodeName = (node.data?.label as string) || node.id
        options?.onNodeStart?.(node.id, node.type, nodeName)

        const result = await this.executeNode(node, context, logger)

        // 回调：节点结束（上层据此推送 SSE node:end，并补齐耗时/输入输出）
        options?.onNodeEnd?.(node.id, result)

        // 任一节点失败都会中断整个工作流：后续节点不再执行
        if (!result.success) {
          throw result.error || new Error(`Node ${node.id} execution failed`)
        }

        executedNodes.add(node.id)

        // 标记完成：context 内部会记录节点输出，供下游节点聚合输入
        context.markNodeCompleted(node.id)

        // 只有 end 节点的输出才计入最终结果，其他节点的输出仅作为中间变量
        if (node.type === 'end') {
          finalOutputs = { ...finalOutputs, ...result.outputs }
        }

        // 条件节点：按命中的分支裁剪执行图，跳过未选中的路径
        if (node.type === 'condition' && result.matchedBranch) {
          graphBuilder.selectBranch(node.id, result.matchedBranch)
          // 重新排序：被裁掉的分支及其下游节点将从执行顺序中移除
          executionOrder = graphBuilder.getExecutionOrder()
          logger.debug('Branch selected, execution order updated', {
            selectedBranch: result.matchedBranch,
            newOrder: executionOrder.map(n => `${n.id}(${n.type})`),
          })
        }

        // 清空当前节点，避免循环外或下一个节点的日志被错误归到这个节点上
        logger.setCurrentNode(null)
      }

      const duration = Date.now() - startTime

      // 成功日志只记录输出字段名，不打印具体值，避免敏感数据进入日志
      logger.info('Workflow execution completed successfully', {
        duration,
        outputKeys: Object.keys(finalOutputs),
      })

      // 正常结束：返回收集到的最终输出（来自 end 节点）
      return {
        success: true,
        outputs: finalOutputs,
        executionId,
        duration,
        logs: logger.getEntries(),
      }
    } catch (error) {
      // 校验失败、成环、节点执行失败、执行器抛异常都会到这里；
      // 统一转成 success: false 的结果返回，并保留 executionId / 日志 / 耗时
      const duration = Date.now() - startTime

      logger.error('Workflow execution failed', {
        error: error instanceof Error ? error.message : String(error),
        duration,
      })

      return {
        success: false,
        outputs: {},
        error: error instanceof Error ? error : new Error(String(error)),
        executionId,
        duration,
        logs: logger.getEntries(),
      }
    }
  }

  /**
   * 执行单个节点。
   *
   * 执行前会先聚合该节点的输入：
   *   - 普通节点：把所有上游节点的输出合并（同名键后写入的覆盖先写入的）
   *   - start 节点：额外合并工作流输入，作为整个流程的入口数据
   *
   * 执行结束后把聚合出的输入回填到 result.inputs，
   * 供上层（SSE node:end 事件）展示该节点「收到了什么」。
   */
  private async executeNode(
    node: WorkflowNode,
    context: ReturnType<typeof createExecutionContext>,
    logger: ReturnType<typeof createExecutionLogger>
  ): Promise<NodeExecutionResult> {
    // 从注册表取执行器；取不到通常意味着该节点类型未注册（例如插件节点未加载）
    const executor = this.registry.get(node.type)

    if (!executor) {
      throw new Error(`No executor registered for node type: ${node.type}`)
    }

    // 聚合上游输入：遍历直接前驱节点，把它们的输出逐层合并
    const nodeInputs: Record<string, unknown> = {}
    const upstreamNodes = context.getUpstreamNodes(node.id)

    for (const upstreamId of upstreamNodes) {
      const outputs = context.variables.getNodeOutputs(upstreamId)
      if (outputs) {
        // 合并上游输出：多个上游存在同名键时，靠后的会覆盖靠前的
        Object.assign(nodeInputs, outputs)
      }
    }

    // start 节点没有上游，它的输入就是用户提交的工作流输入
    if (node.type === 'start') {
      Object.assign(nodeInputs, context.inputs)
    }
    // 执行节点：调用执行器的 doExecute 方法，传入聚合出的输入
    // 并返回执行结果
    const result = await executor.execute(node.id, node.data.config || {}, context, logger)

    // 把聚合出的输入写回结果，供上层日志、SSE 事件和调试面板展示
    result.inputs = nodeInputs

    return result
  }

  /**
   * 校验工作流结构，返回是否合法以及错误列表。
   * 只做静态检查，不执行任何节点，可被前端在保存前调用。
   */
  validate(workflow: WorkflowDefinition): ValidationResult {
    return this.workflowValidator.validate(workflow)
  }

  /**
   * 暴露节点注册表，供调用方在执行前动态注册插件节点。
   */
  getRegistry(): NodeRegistry {
    return this.registry
  }

  /**
   * 生成执行 ID：时间戳 base36 + 6 位随机串。
   * 仅用于本次执行内部关联，不保证全局唯一性（并发极高时理论上可能碰撞）。
   */
  private generateExecutionId(): string {
    const timestamp = Date.now().toString(36)
    const random = Math.random().toString(36).substring(2, 8)
    return `exec-${timestamp}-${random}`
  }
}

/**
 * 创建工作流引擎实例的工厂函数。
 * 相比 new WorkflowEngine()，工厂函数便于后续在不改调用方的情况下替换实现。
 */
export function createWorkflowEngine(config?: WorkflowEngineConfig): WorkflowEngine {
  return new WorkflowEngine(config)
}
