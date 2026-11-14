// ISR（增量静态再生成）示例：页面整体仍按静态生成，但每隔一段时间
// 允许在后台重新生成一次，兼顾「静态的速度」和「数据的时效」。
//
// 它和 SSG 的区别：SSG 只有重新 build 才会更新；ISR 会按 revalidate 周期自动更新。
import { serverFetch } from '@/lib/api-server'

// 关键配置：最短重新验证间隔（秒）。
// 含义：页面被访问时，如果距上次生成已超过 10 秒，就触发一次后台重新生成；
// 本次请求仍先返回旧内容（stale-while-revalidate），下次请求才能看到新内容。
export const revalidate = 10

type User = { id: string; name: string; email: string }

export default async function IsrPage() {
  // force-cache：读取构建/上次再生成时缓存的产物
  const users = await serverFetch<User[]>('/users', { cache: 'force-cache' })
  // 这一时间会随每次「再生成」而更新，可用来观察 ISR 是否生效
  const generatedAt = new Date().toISOString()

  return (
    <div className="px-12 py-6 border-2">
      <h1 className="text-xl font-bold">ISR 示例</h1>
      <p className="text-sm text-gray-500">页面生成时间：{generatedAt}（每隔 10 秒后的首次访问会触发重新生成）</p>
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
