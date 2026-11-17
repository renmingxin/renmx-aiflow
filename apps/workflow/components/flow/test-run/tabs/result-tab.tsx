'use client'

/**
 * 测试运行 - 「结果」标签页
 *
 * 负责把 useWorkflowRunner 返回的 WorkflowResult 渲染成用户可读的结果面板：
 *   - idle / running / 无结果：展示对应的占位提示
 *   - 有结果：状态横幅（成功/失败）→ 错误信息 → 输出数据（JSON 查看器）
 *
 * 组件本身不发起任何请求，只做纯展示；结果数据完全由父组件传入。
 */

import type { WorkflowResult } from '@miaoma-aiflow/ai-engine'
import { AlertCircleIcon, CheckCircle2Icon, CopyIcon, Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { TestRunStatus } from '@/lib/types/test-run'

interface ResultTabProps {
  /** 工作流执行结果；运行中或尚未运行时为 null */
  result: WorkflowResult | null
  /** 当前运行状态，用来区分「未运行 / 运行中 / 已结束」三种展示分支 */
  status: TestRunStatus
}

/**
 * 带复制按钮的 JSON 查看器。
 *
 * - 用 JSON.stringify(data, null, 2) 做格式化缩进，方便阅读
 * - 数据中若存在循环引用或 BigInt，stringify 会抛错，此时退化为 String(data) 兜底展示
 * - 复制成功后图标切换为对勾，2 秒后自动还原
 */
function JsonViewer({ data, className }: { data: unknown; className?: string }) {
  const formattedJson = useMemo(() => {
    try {
      return JSON.stringify(data, null, 2)
    } catch {
      // 循环引用、BigInt 等无法序列化的数据，直接转字符串保证不白屏
      return String(data)
    }
  }, [data])

  /** 复制按钮的临时反馈：点击后短暂显示「已复制」图标 */
  const [copied, setCopied] = useState(false)

  /** 把格式化后的 JSON 写入剪贴板，并在 2 秒后恢复图标 */
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formattedJson)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 浏览器不支持或用户拒绝剪贴板权限时静默失败，不打断查看结果
    }
  }

  return (
    <div className={`relative group overflow-hidden ${className || ''}`}>
      <pre className="bg-muted p-4 rounded-lg overflow-auto text-sm font-mono max-h-[400px] whitespace-pre-wrap break-all">
        {formattedJson}
      </pre>
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={handleCopy}
      >
        {copied ? <CheckCircle2Icon className="h-4 w-4 text-green-500" /> : <CopyIcon className="h-4 w-4" />}
      </Button>
    </div>
  )
}

/**
 * 「结果」标签页主组件
 *
 * 渲染优先级（自上而下短路返回）：
 *   1. idle        -> 提示先运行工作流
 *   2. running     -> 加载动画
 *   3. result 为空 -> 暂无结果（通常是运行异常中断但状态已结束）
 *   4. 有结果      -> 状态横幅 + 错误信息 + 输出数据
 */
export function ResultTab({ result, status }: ResultTabProps) {
  // 尚未运行过：不展示任何结果区域
  if (status === 'idle') {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <p className="text-sm">运行工作流后查看结果</p>
      </div>
    )
  }

  // 执行中：结果还没产生，先展示 loading
  if (status === 'running') {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin mb-4" />
        <p className="text-sm">工作流正在运行中...</p>
      </div>
    )
  }

  // 已结束但拿不到结果对象（例如请求直接失败且未生成 WorkflowResult）
  if (!result) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <p className="text-sm">暂无结果</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* 状态横幅：用绿色/红色区分执行成功与失败 */}
      <div
        className={`flex items-center gap-2 p-3 rounded-lg ${
          result.success ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
        }`}
      >
        {result.success ? <CheckCircle2Icon className="h-5 w-5" /> : <AlertCircleIcon className="h-5 w-5" />}
        <span className="font-medium">{result.success ? '执行成功' : '执行失败'}</span>
      </div>

      {/* 错误信息：只有 result.error 存在时展示，失败原因来自引擎或节点执行器 */}
      {result.error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 overflow-hidden">
          <h4 className="text-sm font-medium text-red-700 mb-2">错误信息</h4>
          <p className="text-sm text-red-600 font-mono break-all">{result.error.message}</p>
        </div>
      )}

      {/* 输出数据：有输出时用 JSON 查看器展示，空对象则给出占位提示 */}
      <div className="space-y-2">
        <h4 className="text-sm font-medium">输出数据</h4>
        {result.outputs && Object.keys(result.outputs).length > 0 ? (
          <JsonViewer data={result.outputs} />
        ) : (
          <div className="text-center py-6 text-muted-foreground border border-dashed rounded-md">
            <p className="text-sm">无输出数据</p>
          </div>
        )}
      </div>
    </div>
  )
}
