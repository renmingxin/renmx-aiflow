// SSR（服务端渲染）示例：每次请求都会在服务端重新执行这个组件、重新取数。
// 与 CSR 的区别：首屏 HTML 里已经带着用户数据，不需要等浏览器执行 JS 再发请求。
//
// 关键配置：声明为动态渲染，禁止在构建时预渲染。
// （注意：这个写法要求 nextConfig.cacheComponents 处于关闭状态）
import { serverFetch } from '@/lib/api-server'

export const dynamic = 'force-dynamic'

type User = { id: string; name: string; email: string }

export default async function SsrPage() {
  // no-store：不读取任何缓存，每次请求都真实打到后端
  const users = await serverFetch<User[]>('/users', { cache: 'no-store' })
  const renderedAt = new Date().toISOString()

  return (
    <div className="px-12 py-6 border-2">
      <h1 className="text-xl font-bold">SSR 示例</h1>
      <p className="text-sm text-gray-500">服务端渲染时间：{renderedAt}（每次刷新都会变）</p>
      <p className="text-sm text-gray-500">用户数：{users.length}</p>
      <ul className="mt-4 space-y-1">
        {users.map(user => (
          <li key={user.id}>
            {user.id} - {user.name}（{user.email}）
          </li>
        ))}
      </ul>
    </div>
  )
}
