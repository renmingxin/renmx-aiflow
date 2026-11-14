// SSG（静态生成）示例：在构建时执行一次，把取到的数据直接写进静态 HTML。
// 之后所有访问都返回同一份内容，除非重新构建。
//
// 关键配置：声明为静态渲染，构建时预渲染。
// （注意：这个写法要求 nextConfig.cacheComponents 处于关闭状态）
import { serverFetch } from '@/lib/api-server'

export const dynamic = 'force-static'

type User = { id: string; name: string; email: string }

export default async function SsgPage() {
  // force-cache：构建阶段取一次并缓存进静态产物
  const users = await serverFetch<User[]>('/users', { cache: 'force-cache' })
  // 这里的「构建时间」会被固化进 HTML，运行时不会再变
  const builtAt = new Date().toISOString()

  return (
    <div className="px-12 py-6 border-2">
      <h1 className="text-xl font-bold">SSG 示例</h1>
      <p className="text-sm text-gray-500">构建时间：{builtAt}（重新 build 之前不会变）</p>
      <p className="text-sm text-gray-500">这份数据是构建时抓取的快照，之后新增用户、刷新页面都不会变</p>
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
