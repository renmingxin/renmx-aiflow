import { describe, expect, it, vi } from 'vitest'

import type { NodeExecutor, WorkflowDefinition } from '../../types'
import { createWorkflowEngine } from '../engine'
import { GraphBuilder } from '../graph-builder'

const workflow: WorkflowDefinition = {
  id: 'age-routing',
  name: '年龄条件分支',
  nodes: [
    {
      id: 'start-1',
      type: 'start',
      data: {
        config: {
          inputs: [
            { name: 'name', type: 'string', required: true, defaultValue: 'renmx' },
            { name: 'age', type: 'number', defaultValue: '20' },
          ],
        },
      },
    },
    {
      id: 'end-571e2119',
      type: 'end',
      data: {
        config: {
          outputs: [
            { name: 'result_name', type: 'string', value: '${start-1.name}' },
            { name: 'result_age', type: 'string', value: '${start-1.age}' },
            { name: 'result_agent', type: 'string', value: '${openai-5d7393bc.output}' },
            { name: 'result_agent_match', type: 'string', value: '${condition-5ee5493b.matchedIntent}' },
            { name: 'result_agent_match_num', type: 'string', value: '${condition-5ee5493b.confidence}' },
          ],
        },
      },
    },
    { id: 'openai-5d7393bc', type: 'openai', data: { config: { model: 'huoshan', userPrompt: '写日记' } } },
    {
      id: 'condition-5ee5493b',
      type: 'condition',
      data: {
        config: {
          model: 'openai',
          intents: [
            { name: '年龄大于20', description: '${start-1.age}>20' },
            { name: '年龄小于20', description: '${start-1.age}<20' },
          ],
        },
      },
    },
  ],
  edges: [
    { id: 'one', source: 'openai-5d7393bc', target: 'end-571e2119' },
    { id: 'two', source: 'start-1', target: 'condition-5ee5493b' },
    { id: 'three', source: 'condition-5ee5493b', sourceHandle: 'intent-0', target: 'openai-5d7393bc' },
    { id: 'four', source: 'condition-5ee5493b', sourceHandle: 'intent-1', target: 'end-571e2119' },
  ],
}

async function runAge(age: number, branch: number) {
  const engine = createWorkflowEngine()
  // 模拟模型回复，保留执行器基类的输出写入和引擎的实际调度。
  const condition = engine.getRegistry().get('condition')! as unknown as { doExecute: NodeExecutor['execute'] }
  vi.spyOn(condition, 'doExecute').mockResolvedValue({
    success: true,
    outputs: { matchedIntent: branch === 1 ? '年龄小于20' : '年龄大于20', confidence: 0.95 },
    matchedBranch: `intent-${branch}`,
    duration: 0,
  })
  const openai = engine.getRegistry().get('openai')! as unknown as { doExecute: NodeExecutor['execute'] }
  const diary = vi.spyOn(openai, 'doExecute').mockResolvedValue({ success: true, outputs: { output: '日记正文' }, duration: 0 })
  const started: string[] = []
  const result = await engine.execute(
    workflow,
    { name: 'renmx', age },
    {
      onNodeStart: id => {
        started.push(id)
      },
    }
  )
  return { result, started, diary }
}

describe('年龄条件分支的执行路径', () => {
  it('年龄 10 命中 intent-1，直接执行结束节点，跳过写日记的 OpenAI 节点', async () => {
    const { result, started, diary } = await runAge(10, 1)
    expect(result.success).toBe(true)
    expect(started).toEqual(['start-1', 'condition-5ee5493b', 'end-571e2119'])
    expect(diary).not.toHaveBeenCalled()
    expect(result.outputs).toMatchObject({ result_name: 'renmx', result_age: '10', result_agent_match: '年龄小于20' })
  })

  it('年龄 30 命中 intent-0，先执行写日记的 OpenAI 节点，再结束', async () => {
    const { result, started, diary } = await runAge(30, 0)
    expect(result.success).toBe(true)
    expect(started).toEqual(['start-1', 'condition-5ee5493b', 'openai-5d7393bc', 'end-571e2119'])
    expect(diary).toHaveBeenCalledOnce()
    expect(result.outputs).toMatchObject({ result_agent: '日记正文', result_agent_match: '年龄大于20' })
  })

  it('两个条件出口指向同一结束节点时保留有效路径', () => {
    const graph = new GraphBuilder({
      ...workflow,
      nodes: workflow.nodes.filter(node => node.type !== 'openai'),
      edges: [workflow.edges[1], { ...workflow.edges[2], target: 'end-571e2119' }, workflow.edges[3]],
    })
    graph.selectBranch('condition-5ee5493b', 'intent-1')
    expect(graph.getExecutionOrder().map(node => node.id)).toEqual(['start-1', 'condition-5ee5493b', 'end-571e2119'])
  })
})
