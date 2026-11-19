import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '../types'

/**
 * 执行图构建器
 * 负责拓扑排序和分支选择
 */
export class GraphBuilder {
  private workflow: WorkflowDefinition
  private outgoingEdges: Map<string, WorkflowEdge[]>
  private reverseAdjacencyList: Map<string, string[]>
  private inDegree: Map<string, number>
  private selectedBranches: Map<string, string>

  constructor(workflow: WorkflowDefinition) {
    this.workflow = workflow
    this.outgoingEdges = new Map()
    this.reverseAdjacencyList = new Map()
    this.inDegree = new Map()
    this.selectedBranches = new Map()

    this.buildGraph()
  }

  /**
   * 构建图结构
   */
  private buildGraph(): void {
    // 初始化
    for (const node of this.workflow.nodes) {
      this.outgoingEdges.set(node.id, [])
      this.reverseAdjacencyList.set(node.id, [])
      this.inDegree.set(node.id, 0)
    }

    // 添加边
    for (const edge of this.workflow.edges) {
      const outgoing = this.outgoingEdges.get(edge.source) || []
      outgoing.push(edge)
      this.outgoingEdges.set(edge.source, outgoing)

      const sources = this.reverseAdjacencyList.get(edge.target) || []
      sources.push(edge.source)
      this.reverseAdjacencyList.set(edge.target, sources)

      const degree = this.inDegree.get(edge.target) || 0
      this.inDegree.set(edge.target, degree + 1)
    }
  }

  /**
   * 获取执行顺序（拓扑排序）
   */
  getExecutionOrder(): WorkflowNode[] {
    const result: WorkflowNode[] = []
    const queue: string[] = []
    const reachable = new Set<string>()

    // 创建入度副本
    const inDegreeCopy = new Map(this.inDegree)

    // 找到所有入度为0的节点（起始节点）
    for (const [nodeId, degree] of inDegreeCopy) {
      if (degree === 0) {
        queue.push(nodeId)
        reachable.add(nodeId)
      }
    }

    while (queue.length > 0) {
      const nodeId = queue.shift()!

      const canRun = reachable.has(nodeId)
      const selectedBranch = this.selectedBranches.get(nodeId)
      if (canRun) {
        const node = this.workflow.nodes.find(n => n.id === nodeId)
        if (node) {
          result.push(node)
        }
      }

      for (const { target, sourceHandle } of this.outgoingEdges.get(nodeId) || []) {
        // 可达状态只沿选中的出口传播，共用的结束节点有一条有效来路即可执行。
        if (canRun && (selectedBranch === undefined || sourceHandle === selectedBranch)) {
          reachable.add(target)
        }

        // 未选路径的入边也要处理，否则汇合节点会一直等待该路径。
        const degree = inDegreeCopy.get(target)! - 1
        inDegreeCopy.set(target, degree)

        if (degree === 0) {
          queue.push(target)
        }
      }
    }

    return result
  }

  /**
   * 选择分支（用于条件节点）
   * 记录选中的出口，由 getExecutionOrder 重新计算可达节点。
   */
  selectBranch(conditionNodeId: string, selectedBranchId: string): void {
    this.selectedBranches.set(conditionNodeId, selectedBranchId)
  }

  /**
   * 获取上游节点
   */
  getUpstreamNodes(nodeId: string): string[] {
    return this.reverseAdjacencyList.get(nodeId) || []
  }

  /**
   * 获取所有上游节点（递归）
   */
  getAllUpstreamNodes(nodeId: string): string[] {
    const result = new Set<string>()
    const visited = new Set<string>()

    const dfs = (id: string) => {
      if (visited.has(id)) return
      visited.add(id)

      const predecessors = this.reverseAdjacencyList.get(id) || []
      for (const pred of predecessors) {
        result.add(pred)
        dfs(pred)
      }
    }

    dfs(nodeId)
    return Array.from(result)
  }

  /**
   * 检查是否有环
   */
  hasCycle(): boolean {
    const visited = new Set<string>()
    const inStack = new Set<string>()

    const dfs = (nodeId: string): boolean => {
      if (inStack.has(nodeId)) return true
      if (visited.has(nodeId)) return false

      visited.add(nodeId)
      inStack.add(nodeId)

      for (const { target } of this.outgoingEdges.get(nodeId) || []) {
        if (dfs(target)) return true
      }

      inStack.delete(nodeId)
      return false
    }

    for (const node of this.workflow.nodes) {
      if (!visited.has(node.id)) {
        if (dfs(node.id)) return true
      }
    }

    return false
  }
}

/**
 * 创建图构建器实例
 */
export function createGraphBuilder(workflow: WorkflowDefinition): GraphBuilder {
  return new GraphBuilder(workflow)
}
