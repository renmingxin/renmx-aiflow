/**
 * 执行上下文
 *
 * 作用：在「一次工作流执行」的整个生命周期内，承载所有共享状态，供各节点执行器读写。
 * 每个节点执行器拿到的都是同一个 context 实例，因此可以：
 *   - 读取用户输入（inputs）
 *   - 把本节点输出写入变量表（variables），供下游节点引用
 *   - 解析 `${nodeId.field}` 形式的变量表达式
 *   - 查询上游节点、判断某个节点是否已完成
 *
 * 生命周期：由 engine.execute 在开始时创建，执行结束即丢弃，不跨请求复用。
 */

import type { ExecutionContext, VariableStore, WorkflowDefinition, WorkflowInput } from '../types'
import { GraphBuilder } from './graph-builder'
import { VariableResolver } from './variable-resolver'

/**
 * 变量存储的默认实现。
 *
 * 数据结构：nodeId -> { 变量名 -> 值 }
 * 即按「产生输出的节点」分组保存，这样下游节点既能取单个字段，
 * 也能一次性拿到某个上游节点的全部输出用于合并输入。
 */
class DefaultVariableStore implements VariableStore {
  /** 内部存储；用 Map 保证插入顺序稳定，便于调试时观察 */
  private store: Map<string, Record<string, unknown>> = new Map()

  /**
   * 读取某个节点的单个变量值；节点或变量不存在时返回 undefined。
   */
  get(nodeId: string, variableName: string): unknown {
    const nodeOutputs = this.store.get(nodeId)
    return nodeOutputs?.[variableName]
  }

  /**
   * 写入某个节点的一个变量；该节点还没有输出记录时先建一个空对象。
   */
  set(nodeId: string, variableName: string, value: unknown): void {
    const nodeOutputs = this.store.get(nodeId) || {}
    nodeOutputs[variableName] = value
    this.store.set(nodeId, nodeOutputs)
  }

  /**
   * 取某个节点的完整输出对象；未执行过的节点返回 undefined。
   */
  getNodeOutputs(nodeId: string): Record<string, unknown> | undefined {
    return this.store.get(nodeId)
  }

  /**
   * 整体覆盖某个节点的输出（节点执行结束后通常一次性写入）。
   */
  setNodeOutputs(nodeId: string, outputs: Record<string, unknown>): void {
    this.store.set(nodeId, outputs)
  }

  /**
   * 返回全部变量的浅拷贝，避免调用方直接修改内部 Map 结构
   * （注意：拷贝的是 Map 本身，内部的输出对象仍是同一引用）。
   */
  getAll(): Map<string, Record<string, unknown>> {
    return new Map(this.store)
  }
}

/**
 * 执行上下文的默认实现。
 *
 * 包含四类状态：
 *   1. 元信息：executionId、workflow、startTime
 *   2. 输入：用户提交的 inputs
 *   3. 变量表：各节点输出，供变量表达式与下游输入聚合使用
 *   4. 执行进度：completedNodes 记录哪些节点已跑完
 *
 * 另外持有 GraphBuilder 与 VariableResolver：
 *   前者用于查询上游节点（同时也被 engine 用于拓扑排序），
 *   后者负责解析 `${...}` 表达式。
 */
class DefaultExecutionContext implements ExecutionContext {
  /** 本次执行的唯一 ID，与日志、结果关联 */
  readonly executionId: string
  /** 工作流定义（节点 + 连线） */
  readonly workflow: WorkflowDefinition
  /** 变量表：nodeId -> 节点输出 */
  readonly variables: VariableStore
  /** 用户提交的输入参数 */
  readonly inputs: WorkflowInput
  /** 执行开始时间，用于计算耗时 */
  readonly startTime: Date

  /** 已完成的节点 ID 集合，防止重复执行与用于依赖判断 */
  private completedNodes: Set<string> = new Set()
  /** 图结构工具：查询上游节点等 */
  private graphBuilder: GraphBuilder
  /** 变量表达式解析器 */
  private variableResolver: VariableResolver

  /**
   * 构造上下文：初始化变量表，并为该工作流构建一份图结构。
   * 注意这里会重新构建一次 GraphBuilder（engine 中还有一份），
   * 代价很小，换取上下文自身可独立查询拓扑信息。
   */
  constructor(executionId: string, workflow: WorkflowDefinition, inputs: WorkflowInput) {
    this.executionId = executionId
    this.workflow = workflow
    this.inputs = inputs
    this.startTime = new Date()
    this.variables = new DefaultVariableStore()
    this.graphBuilder = new GraphBuilder(workflow)
    this.variableResolver = new VariableResolver()
  }

  /**
   * 解析单个变量表达式（如 `${node-1.text}`），返回其值。
   * 解析不到时统一返回 undefined，由调用方决定回落策略。
   */
  resolveVariable(expression: string): unknown {
    const { value, found } = this.variableResolver.resolveExpression(expression, this.variables)
    return found ? value : undefined
  }

  /**
   * 解析一段可能包含多个变量占位符的文本。
   * 与 resolveVariable 的区别：这里做的是模板替换，结果仍是字符串。
   */
  resolveText(text: string): string {
    return this.variableResolver.resolveText(text, this.variables)
  }

  /**
   * 返回某个节点的所有直接上游节点 ID。
   * 节点执行器用它来决定「该从哪些节点读取输出作为自己的输入」。
   */
  getUpstreamNodes(nodeId: string): string[] {
    return this.graphBuilder.getUpstreamNodes(nodeId)
  }

  /**
   * 判断节点是否已执行完成。
   */
  isNodeCompleted(nodeId: string): boolean {
    return this.completedNodes.has(nodeId)
  }

  /**
   * 标记节点已完成；engine 会在每个节点执行成功后调用。
   */
  markNodeCompleted(nodeId: string): void {
    this.completedNodes.add(nodeId)
  }
}

/**
 * 创建执行上下文的工厂函数。
 * 上层（engine）只依赖 ExecutionContext 接口，不直接接触实现类。
 */
export function createExecutionContext(executionId: string, workflow: WorkflowDefinition, inputs: WorkflowInput): ExecutionContext {
  return new DefaultExecutionContext(executionId, workflow, inputs)
}
