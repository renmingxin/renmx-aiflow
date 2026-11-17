'use client'

import { useParams } from 'next/navigation'
import { use, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { FlowEditor } from '@/components/flow/editor'
import { appService } from '@/lib/services/app-service'
import { workflowService } from '@/lib/services/workflow-service'
import type { FlowEdge, FlowNode } from '@/lib/types/workflow'

export default function WorkflowPage() {
  const { id: appId } = useParams<{ id: string }>()
  const [loading, setLoading] = useState(true)
  const [appName, setAppName] = useState('')
  const [initialNodes, setInitialNodes] = useState<FlowNode[]>([])
  const [initialEdges, setInitialEdges] = useState<FlowEdge[]>([])

  useEffect(() => {
    const loadData = async () => {
      setLoading(true)
      try {
        // 并行加载应用和工作流数据
        const [app, workflow] = await Promise.all([
          appService.getById(appId),
          workflowService.getByAppId(appId).catch(() => ({ nodes: [], edges: [] })),
        ])

        setAppName(app.name)
        setInitialNodes(workflow.nodes)
        setInitialEdges(workflow.edges)
      } catch (error) {
        console.error('加载数据失败:', error)
        toast.error(error instanceof Error ? error.message : '加载数据失败')
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [appId])

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-muted-foreground">加载中...</div>
      </div>
    )
  }

  // 该页面不在 (main) 路由组内，没有 layout 提供高度；
  // FlowEditor 根节点是 h-full，必须由这层容器给出高度，否则画布会塌陷成 0 高度（白屏）。
  return (
    <div className="h-screen w-full">
      <FlowEditor appId={appId} appName={appName} initialNodes={initialNodes} initialEdges={initialEdges} />
    </div>
  )
}
