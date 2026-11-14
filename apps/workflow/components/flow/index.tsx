'use client'
// 重点标记-引入ReactFlow组件, 用于绘制流程图, 包含背景, 处理, 地图, 位置, 反应流, 节点类型, 边类型, 节点数据, 边数据
import { Background, Handle, MiniMap, Position, ReactFlow } from '@xyflow/react'
import { useState } from 'react'

const initialNodes = [
  { id: 'n1', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Node 1' } },
  { id: 'n2', type: 'end', position: { x: 0, y: 100 }, data: { label: 'Node 2' } },
]
const initialEdges = [{ id: 'n1-n2', source: 'n1', target: 'n2' }]

const startNode = ({ id, position, data }: any) => {
  return (
    <div className="border-green-600 bg-blue-700 text-white p-2 rounded-md w-20 h-20 ">
      {data.label}
      <Handle type="target" position={Position.Left} />
      {/* position是节点的相对位置有LEFT, RIGHT, TOP, BOTTOM，四个点 */}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
const endNode = ({ id, position, data }: any) => {
  return (
    <div className="border-red-600 bg-red-500 text-white p-2 rounded-md w-20 h-20 ">
      {data.label}
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const nodeTypes = {
  start: startNode,
  end: endNode,
}

export function Flow() {
  const [nodes, setNodes] = useState(initialNodes)
  const [edges, setEdges] = useState(initialEdges)
  return (
    <div className="h-screen w-full">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes}>
        <Background />
        <MiniMap />
      </ReactFlow>
    </div>
  )
}
