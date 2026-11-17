'use client'

/**
 * 测试运行 - 「详情」标签页
 *
 * 展示一次工作流执行的完整元信息，数据全部来自 useWorkflowRunner 维护的 TestRunState：
 *   - 执行摘要：运行状态、耗时、Token 消耗、执行 ID
 *   - 时间信息：开始时间 / 结束时间
 *   - 输入参数、输出结果的 JSON 折叠面板
 *   - 失败时的错误详情
 *
 * 纯展示组件，不发起请求，也不修改运行状态。
 */

import { AlertCircleIcon, CheckCircle2Icon, ClockIcon, CopyIcon, HashIcon, Loader2, ZapIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { TestRunState, TestRunStatus } from '@/lib/types/test-run'

interface DetailsTabProps {
  /** 完整的运行状态快照（状态、输入、结果、时间、耗时、执行 ID、token 用量） */
  state: TestRunState
}

/**
 * 把毫秒数格式化成便于阅读的时长。
 *
 * 分三档：
 *   < 1s      -> 直接显示毫秒（如 350ms）
 *   < 1min    -> 显示秒并保留两位小数（如 2.35s）
 *   >= 1min   -> 显示分 + 秒（如 1m 23.4s）
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(2)}s`
  }
  const minutes = Math.floor(ms / 60000)
  const seconds = ((ms % 60000) / 1000).toFixed(1)
  return `${minutes}m ${seconds}s`
}

/**
 * 把日期格式化为本地化的中文时间字符串。
 * 未开始的执行（endTime 为 null）统一显示为 “-”。
 */
function formatDate(date: Date | null): string {
  if (!date) return '-'
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/**
 * 运行状态图标：
 *   running -> 旋转加载图标（蓝）
 *   success -> 对勾（绿）
 *   error   -> 警告（红）
 *   其他    -> 时钟（灰，对应 idle）
 */
function StatusIcon({ status }: { status: TestRunStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
    case 'success':
      return <CheckCircle2Icon className="h-5 w-5 text-green-500" />
    case 'error':
      return <AlertCircleIcon className="h-5 w-5 text-red-500" />
    default:
      return <ClockIcon className="h-5 w-5 text-gray-400" />
  }
}

/**
 * 把运行状态映射为中文文案，供摘要卡片展示。
 */
function getStatusText(status: TestRunStatus): string {
  switch (status) {
    case 'running':
      return '运行中'
    case 'success':
      return '成功'
    case 'error':
      return '失败'
    default:
      return '等待运行'
  }
}

/**
 * 可折叠的 JSON 区块（用于输入参数 / 输出结果）。
 *
 * - 默认收起，点击标题栏展开/收起
 * - 展开后才渲染 <pre> 和复制按钮，避免长 JSON 一直占用 DOM 与布局
 * - 数据为空（null / undefined / 空对象）时显示「无数据」占位
 * - 复制按钮阻止冒泡，防止点击复制时顺带触发折叠
 */
function JsonSection({ title, data }: { title: string; data: unknown }) {
  /** 折叠面板是否展开 */
  const [isOpen, setIsOpen] = useState(false)
  /** 复制按钮的临时反馈状态（2 秒后还原） */
  const [copied, setCopied] = useState(false)

  const formattedJson = useMemo(() => {
    try {
      return JSON.stringify(data, null, 2)
    } catch {
      // 循环引用、BigInt 等无法序列化的值，退化为字符串避免渲染崩溃
      return String(data)
    }
  }, [data])

  /** 复制格式化后的 JSON 到剪贴板 */
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formattedJson)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板不可用时静默失败，不影响查看数据
    }
  }

  /** 判断是否「没有可展示的数据」：null/undefined，或空对象 */
  const isEmpty = !data || (typeof data === 'object' && Object.keys(data as object).length === 0)

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="border rounded-lg">
        <CollapsibleTrigger asChild>
          <button className="flex items-center justify-between w-full p-3 text-left hover:bg-muted/50 transition-colors">
            <span className="text-sm font-medium">{title}</span>
            <span className="text-xs text-muted-foreground">{isOpen ? '收起' : '展开'}</span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="relative border-t overflow-hidden">
            {isEmpty ? (
              <div className="p-4 text-center text-muted-foreground text-sm">无数据</div>
            ) : (
              <>
                <pre className="p-4 text-sm font-mono overflow-auto max-h-[300px] bg-muted/30 whitespace-pre-wrap break-all">
                  {formattedJson}
                </pre>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="absolute top-2 right-2"
                  onClick={e => {
                    e.stopPropagation()
                    handleCopy()
                  }}
                >
                  {copied ? <CheckCircle2Icon className="h-4 w-4 text-green-500" /> : <CopyIcon className="h-4 w-4" />}
                </Button>
              </>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

/**
 * 「详情」标签页主组件。
 *
 * 布局从上到下：
 *   执行摘要（状态 / 耗时 / Token / 执行 ID）
 *   时间信息（开始、结束时间）
 *   输入参数字段（可折叠 JSON）
 *   输出结果（可折叠 JSON）
 *   错误详情（仅失败时出现）
 */
export function DetailsTab({ state }: DetailsTabProps) {
  // 解构出本页需要的字段，避免模板里反复写 state.xxx
  const { status, inputs, result, startTime, endTime, duration, executionId, totalTokens } = state

  // 尚未运行过：没有任何执行数据可展示
  if (status === 'idle') {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <p className="text-sm">运行工作流后查看详情</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* 执行摘要卡片：四项核心指标，两列网格排列 */}
      <div className="border rounded-lg p-4 space-y-3">
        <h4 className="text-sm font-medium">执行摘要</h4>
        <div className="grid grid-cols-2 gap-4">
          {/* 状态：运行中/成功/失败/等待运行 */}
          <div className="flex items-center gap-2">
            <StatusIcon status={status} />
            <div>
              <p className="text-xs text-muted-foreground">状态</p>
              <p className="text-sm font-medium">{getStatusText(status)}</p>
            </div>
          </div>

          {/* 耗时：运行中显示“计算中...”，结束后显示格式化时长 */}
          <div className="flex items-center gap-2">
            <ClockIcon className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">耗时</p>
              <p className="text-sm font-medium">{status === 'running' ? '计算中...' : formatDuration(duration)}</p>
            </div>
          </div>

          {/* Token 消耗：为 0 时显示 “-”，避免误以为真的消耗了 0 个 token */}
          <div className="flex items-center gap-2">
            <ZapIcon className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Token 消耗</p>
              <p className="text-sm font-medium">{totalTokens > 0 ? totalTokens.toLocaleString() : '-'}</p>
            </div>
          </div>

          {/* 执行 ID：超长时截断，hover 通过 title 查看完整值 */}
          <div className="flex items-center gap-2">
            <HashIcon className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">执行 ID</p>
              <p className="text-sm font-mono truncate max-w-[120px]" title={executionId || '-'}>
                {executionId || '-'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* 时间信息：开始时间在运行中已有值，结束时间在结束后才有 */}
      <div className="border rounded-lg p-4 space-y-2">
        <h4 className="text-sm font-medium">时间信息</h4>
        <div className="space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">开始时间</span>
            <span className="font-mono">{formatDate(startTime)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">结束时间</span>
            <span className="font-mono">{formatDate(endTime)}</span>
          </div>
        </div>
      </div>

      {/* 输入参数：execute() 时提交的 inputs 快照 */}
      <JsonSection title="输入参数" data={inputs} />

      {/* 输出结果：取 result.outputs，运行中或失败时可能为空 */}
      <JsonSection title="输出结果" data={result?.outputs} />

      {/* 错误详情：仅当 result.error 存在时展示，来自引擎或节点执行器 */}
      {result?.error && (
        <div className="border border-red-200 rounded-lg p-4 bg-red-50 overflow-hidden">
          <h4 className="text-sm font-medium text-red-700 mb-2">错误详情</h4>
          <pre className="text-sm font-mono text-red-600 whitespace-pre-wrap break-all">{result.error.message}</pre>
        </div>
      )}
    </div>
  )
}
