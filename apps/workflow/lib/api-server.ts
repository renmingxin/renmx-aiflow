// 服务端专用请求助手。
// 注意：Node 环境下的 fetch 必须使用绝对地址，不能像浏览器那样写相对路径，
// 所以这里显式拼接 API_SERVER_URL（来自 .env.local）。
const BASE = process.env.API_SERVER_URL ?? 'http://localhost:4001'

export async function serverFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path.startsWith('/') ? path : `/${path}`}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}
