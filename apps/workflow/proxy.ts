import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { TOKEN_NAME, verifyToken } from '@/lib/auth'
import { createRequestLogger } from '@/lib/logger'

import { ErrorCode, ErrorCodeMessageMap } from './lib/api-response'

/**
 * Next.js 16 的请求代理（等价于旧版的 middleware.ts，文件名与导出函数名都改成了 proxy）。
 *
 * 作用：在请求真正进入页面 / Route Handler 之前统一做登录态校验，
 * 避免每个页面和接口重复写鉴权逻辑。
 *
 * 处理顺序：
 *   1. 静态资源、公共路径 → 直接放行
 *   2. 携带有效 token → 直接放行
 *   3. 其余请求：API 返回 401，页面重定向到登录页
 */

/**
 * 登录态的三态模型。
 * 用枚举代替「token 是否存在 + 是否校验通过」的布尔组合，让后续分支直接读语义，避免隐式推导。
 *
 * - valid：token 存在且签名、有效期校验通过
 * - missing：请求没有携带 token（从未登录或已退出）
 * - expired：token 存在但校验失败（过期、被篡改或使用了旧密钥）
 */
type AuthState = 'valid' | 'missing' | 'expired'

/**
 * 公共路径：不需要登录态即可访问。
 * 包含登录 / 注册 / 邮箱验证相关页面和接口，以及插件清单等静态数据接口。
 * 漏加这里会导致：登录页自己也被重定向到登录页，形成死循环。
 */
const publicPaths = [
  '/account/login',
  '/account/verify',
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/verify',
  '/api/plugin-registry',
  '/api/plugin-assets',
]

/**
 * 静态资源路径：不需要登录，也不需要记录日志。
 *
 * - /_next：Next 的构建产物、HMR 资源、图片优化接口
 * - /favicon.ico：站点图标
 * - /public：public 目录下的静态文件
 * - /.well-known：浏览器 / DevTools 的规范探测路径
 *   （如 Chrome DevTools 自动请求的 /.well-known/appspecific/com.chrome.devtools.json）
 */
const staticPaths = ['/_next', '/favicon.ico', '/public', '/.well-known']

/**
 * 判断 pathname 是否命中给定前缀列表中的一个。
 *
 * 用 `pathname === prefix || pathname.startsWith(prefix + '/')` 而不是直接 startsWith，
 * 是为了避免 /public 误匹配 /publicity 这类同前缀但无关的路径。
 */
const isUnder = (pathname: string, prefixes: string[]) => prefixes.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))

/**
 * 读取并校验当前请求的登录态。
 *
 * 注意：这里做的是完整校验（签名 + 过期时间），不是只看 cookie 是否存在。
 * 只有「存在但校验失败」才算 expired，用于后面区分提示文案（登录过期 vs 请先登录）。
 */
const getAuthState = (request: NextRequest): AuthState => {
  const token = request.cookies.get(TOKEN_NAME)?.value
  if (!token) return 'missing'
  return verifyToken(token) ? 'valid' : 'expired'
}

/**
 * 未登录访问 API 时的统一响应。
 *
 * 返回 401 而不是重定向：fetch / XHR 不会像浏览器导航那样自动跟随 307 到 HTML 页面，
 * 只会拿到一段登录页源码，前端反而更难处理。带 code 字段便于前端区分处理。
 */
const unauthorizedResponse = (state: AuthState) => {
  const code = state === 'expired' ? ErrorCode.TOKEN_EXPIRED : ErrorCode.UNAUTHORIZED
  return NextResponse.json(
    {
      success: false,
      error: 'Unauthorized',
      code: code,
      message: ErrorCodeMessageMap[code],
    },
    { status: 401 }
  )
}

/**
 * 未登录访问页面时的重定向。
 *
 * - redirect：记录原始地址，登录成功后跳回原页面
 * - reason=expired：告诉登录页「是过期导致的」，用于弹出「登录已过期」提示
 * - 仅在 expired 时清除旧 cookie，避免带着失效凭证反复触发提示
 */
const loginRedirect = (request: NextRequest, state: AuthState) => {
  const { pathname } = request.nextUrl
  const url = new URL('/account/login', request.url)
  url.searchParams.set('redirect', pathname)
  // 注意：location 在 NextResponse.redirect() 调用时就被固定下来，
  // 因此所有 query 参数必须在创建 response 之前设置好
  if (state === 'expired') {
    url.searchParams.set('reason', 'expired')
  }

  const response = NextResponse.redirect(url)
  if (state === 'expired') {
    response.cookies.delete(TOKEN_NAME)
  }
  return response
}

/**
 * 代理入口。所有未被 staticPaths / publicPaths 排除的请求都会走到这里。
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // 1. 静态资源与公共路径直接放行（不鉴权、不记录日志，避免噪音）
  if (isUnder(pathname, staticPaths) || isUnder(pathname, publicPaths)) {
    return NextResponse.next()
  }

  // 2. 登录态有效，放行
  const state = getAuthState(request)
  if (state === 'valid') {
    return NextResponse.next()
  }
  const logger = createRequestLogger(crypto.randomUUID())
  // 3. 未授权：记录一条 warn 日志，便于排查异常访问
  logger.warn({ pathname, state }, '未授权访问')

  // 4. 按请求类型选择响应方式：接口返回 401，页面跳转登录
  return pathname.startsWith('/api/') ? unauthorizedResponse(state) : loginRedirect(request, state)
}
