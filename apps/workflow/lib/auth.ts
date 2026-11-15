import jwt from 'jsonwebtoken'
import { cookies } from 'next/headers'

/**
 * JWT 签名密钥，从环境变量 JWT_SECRET 读取。
 * 必须在 .env.local 中配置；缺失时签发和校验令牌都会直接抛错。
 */
const JWT_SECRET = process.env.JWT_SECRET!

/**
 * 登录令牌在 Cookie 中的键名。
 * 客户端与 /api/auth/* 接口统一使用该名称读写令牌。
 */
export const TOKEN_NAME = 'auth-token'

/**
 * 令牌有效期，单位秒（7 天）。
 * 同时用于 JWT 的 expiresIn 和 Cookie 的 maxAge，保证两者一致。
 */
const TOKEN_MAX_AGE = 60 * 60 * 24 * 7 // 7 天，单位：秒
// const TOKEN_MAX_AGE = 30 // 30 分钟，单位：秒

/**
 * JWT 载荷结构。
 * 当前只保存用户 ID，后续如需角色、权限等信息可在此扩展字段。
 */
export interface JWTPayload {
  userId: string
}

/**
 * 为指定用户签发 JWT 登录令牌。
 *
 * @param userId 用户 ID，会被写入载荷的 userId 字段
 * @returns 使用 JWT_SECRET 做 HS256 签名、有效期为 TOKEN_MAX_AGE 秒的令牌字符串
 * @remarks 密钥缺失时 jsonwebtoken 会直接抛错，因此调用前需确保环境变量已加载
 */
export function generateToken(userId: string): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: `${TOKEN_MAX_AGE}s` })
}

/**
 * 校验 JWT 令牌并解析出载荷。
 *
 * @param token 待校验的令牌字符串
 * @returns 校验通过返回载荷（含 userId）；令牌过期、签名不匹配或格式非法时返回 null
 * @remarks 内部已捕获所有异常，调用方无需再包 try/catch
 */
export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JWTPayload
  } catch {
    return null
  }
}

/**
 * 将登录令牌写入 Cookie。
 *
 * @param token generateToken 生成的 JWT 令牌
 * @remarks Cookie 选项说明：
 * - httpOnly：禁止前端 JS 读取，降低 XSS 场景下令牌被窃取的风险
 * - secure：仅生产环境开启，要求通过 HTTPS 传输
 * - sameSite=lax：跨站请求不携带，同时兼容站内跳转
 * - maxAge：与 JWT 的 7 天有效期保持一致
 */
export async function setAuthCookie(token: string): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set(TOKEN_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: TOKEN_MAX_AGE,
    path: '/',
  })
}

/**
 * 从请求 Cookie 中读取登录令牌。
 *
 * @returns 已登录返回令牌字符串，未登录返回 undefined
 * @remarks 依赖 next/headers 的 cookies()，只能在服务端组件或 Route Handler 中调用
 */
export async function getAuthToken(): Promise<string | undefined> {
  const cookieStore = await cookies()
  return cookieStore.get(TOKEN_NAME)?.value
}

/**
 * 删除登录 Cookie，实现退出登录。
 * 删除后 getCurrentUserId 将返回 null，后续请求会被视为未登录。
 */
export async function clearAuthCookie(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(TOKEN_NAME)
}

/**
 * 获取当前登录用户的 ID。
 *
 * @returns 已登录且令牌校验通过时返回 userId；未登录或令牌无效时返回 null
 * @remarks
 * 供 Route Handler / 服务端组件做鉴权判断。
 * 例如 /api/apps 在拿到 null 时会直接返回 401，提示「未登录或登录已过期」。
 */
export async function getCurrentUserId(): Promise<string | null> {
  const token = await getAuthToken()
  if (!token) return null

  //payload格式为{userId: 'cmwhd05bd0000nku44iqqjtu8', iat: 1794731023, exp: 1795335823}
  const payload = verifyToken(token)
  return payload?.userId ?? null
}
