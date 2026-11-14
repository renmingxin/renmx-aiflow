'use client'

// Sonner 的 Toast 容器（shadcn/ui 风格的封装）。
// 作用：在应用根部渲染一个全局消息提示器，统一主题、图标和配色，
// 业务代码只需调用 sonner 的 toast() 即可弹出提示。
import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

const Toaster = ({ ...props }: ToasterProps) => {
  // 读取当前主题（light / dark / system），用于让 Toast 跟随站点主题切换。
  // 默认值 'system' 是为了在 ThemeProvider 尚未挂载完成时也有合法值。
  const { theme = 'system' } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      // 自定义各类型提示的图标，替换 Sonner 默认图标，保持与项目图标库一致
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      // 把主题色变量映射到 Sonner 的 CSS 变量上：
      // 这样 Toast 的背景、文字、边框、圆角都跟随项目的设计令牌，而不是写死颜色
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      // 允许调用方覆盖任意 Sonner 配置，例如 position、duration、richColors
      {...props}
    />
  )
}

export { Toaster }
