import { NextRequest } from 'next/server'
import { z } from 'zod'

import { apiError, apiSuccess, ErrorCode, handleApiError } from '@/lib/api-response'
import { getCurrentUserId } from '@/lib/auth'
import { createRequestLogger } from '@/lib/logger'
import { prisma } from '@/lib/prisma'
import { APP_TYPE_MAP, formatDate, toAppInfo } from '@/lib/types/app'

/**
 * 应用详情路由：/api/apps/[id]
 *
 * 统一处理单个应用的读取、更新与删除：
 * - GET    /api/apps/[id]  获取应用详情
 * - PUT    /api/apps/[id]  更新应用（选择性字段更新 + version 自增）
 * - DELETE /api/apps/[id]  软删除应用（仅标记 isDeleted）
 *
 * 通用约定：
 * - 鉴权：通过 cookie 中的 token 解析当前用户，未登录统一返回 UNAUTHORIZED；
 * - 归属：操作前校验 app.userId 是否等于当前用户，非本人资源按「不存在」处理；
 * - 过滤：所有查询都带 isDeleted: false，软删除后的应用对接口不可见；
 * - 错误：业务异常通过 apiError 返回，未知异常交给 handleApiError 统一兜底。
 */

/**
 * 获取应用详情。
 *
 * 请求：GET /api/apps/[id]
 *
 * 路径参数：
 * - params.id：应用 ID；Next.js 16 中 params 为 Promise，需 await 后取值
 *
 * 响应（成功）：
 * - 应用基础信息（由 toAppInfo 转换）
 * - createdAt / updatedAt / publishedAt：格式化后的时间字符串
 * - version：版本号；config：应用配置（结构随应用类型而定）
 *
 * 处理流程：
 * 1. 解析当前登录用户，未登录直接返回 UNAUTHORIZED
 * 2. 按 id + isDeleted: false 查询应用（软删除的应用视为不存在）
 * 3. 校验归属：非本人的应用按「不存在」返回，避免暴露资源是否存在
 * 4. 组装详情字段并返回
 *
 * 错误码：
 * - UNAUTHORIZED   未登录
 * - APP_NOT_FOUND  应用不存在、已软删除或不属于当前用户
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getCurrentUserId()
    if (!userId) {
      return apiError(ErrorCode.UNAUTHORIZED)
    }

    const { id } = await params

    const app = await prisma.app.findFirst({
      where: {
        id,
        isDeleted: false,
      },
      include: {
        user: {
          select: { name: true },
        },
      },
    })

    if (!app) {
      return apiError(ErrorCode.APP_NOT_FOUND)
    }

    // 检查权限
    if (app.userId !== userId) {
      return apiError(ErrorCode.APP_NOT_FOUND, '无权访问此应用')
    }

    return apiSuccess({
      ...toAppInfo({
        ...app,
        type: app.type,
      }),
      updatedAt: formatDate(app.updatedAt),
      createdAt: formatDate(app.createdAt),
      version: app.version,
      config: app.config,
      publishedAt: app.publishedAt ? formatDate(app.publishedAt) : null,
    })
  } catch (error) {
    return handleApiError(error)
  }
}

/**
 * PUT 请求体的校验规则。
 *
 * 所有字段均为 optional：只更新请求体中显式出现的字段（undefined 表示「不修改」），
 * 前端因此可以只提交发生变化的字段；空对象 {} 也合法，此时仅将 version + 1。
 *
 * - name        应用名称，1~50 个字符
 * - description 应用描述，最长 200 个字符；传空字符串会被转成 null
 * - icon        应用图标（URL 或图标标识）
 * - type        应用类型，入参为小写枚举，落库前经 APP_TYPE_MAP 转为大写
 * - tags        标签数组
 * - config      应用配置，结构由各类型应用自行约定，故用 z.any() 不做约束
 */
const updateAppSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  description: z.string().max(200).optional(),
  icon: z.string().optional(),
  type: z.enum(['workflow', 'chatbot', 'agent']).optional(),
  tags: z.array(z.string()).optional(),
  config: z.any().optional(),
})

/**
 * 更新应用。
 *
 * 请求：PUT /api/apps/[id]
 *
 * 路径参数：
 * - params.id：应用 ID
 * 请求体：
 * - 见 updateAppSchema，所有字段可选，仅更新请求体中出现的字段
 * 响应（成功）：
 * - 更新后的应用信息（含格式化时间、version、config），提示语「应用更新成功」
 *
 * 处理流程：
 * 1. 解析登录用户，未登录返回 UNAUTHORIZED
 * 2. 解析 JSON 请求体并用 zod 校验，失败返回 VALIDATION_ERROR
 * 3. 按 id + isDeleted: false 查询应用并校验归属
 * 4. 构建更新数据：version 在原有基础上 +1，其余字段按是否出现选择性覆盖
 * 5. 写库并返回最新数据
 *
 * 错误码：
 * - UNAUTHORIZED     未登录
 * - VALIDATION_ERROR 请求体不满足 schema
 * - APP_NOT_FOUND    应用不存在、已软删除或不属于当前用户
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getCurrentUserId()
    if (!userId) {
      return apiError(ErrorCode.UNAUTHORIZED)
    }

    const { id } = await params
    // 解析 JSON 请求体；内容不是合法 JSON 时会抛异常，由 handleApiError 兜底
    const body = await request.json()
    // safeParse 验证请求体是否符合 schema：与 parse 不同，校验失败不抛异常，
    // 可以直接从 result.error 中取出 issues 返回统一的 VALIDATION_ERROR
    const result = updateAppSchema.safeParse(body)

    if (!result.success) {
      return apiError(ErrorCode.VALIDATION_ERROR, result.error.issues[0]?.message)
    }

    // 检查应用是否存在且属于当前用户,findFirst为查询第一个符合条件的应用,如果不存在则返回null
    const existingApp = await prisma.app.findFirst({
      where: {
        id,
        isDeleted: false,
      },
    })

    if (!existingApp) {
      return apiError(ErrorCode.APP_NOT_FOUND)
    }
    // 检查权限如果应用不属于当前用户,则无权修改
    // 非本人应用同样返回 APP_NOT_FOUND 而不是 403，避免泄露资源是否存在
    if (existingApp.userId !== userId) {
      return apiError(ErrorCode.APP_NOT_FOUND, '无权修改此应用')
    }

    // 构建更新数据：version 每次更新自增；其余字段只有在请求体中出现时才覆盖，
    // 因此用「!== undefined」判断，避免把未提交的字段误清空
    const updateData: Record<string, unknown> = {
      version: existingApp.version + 1,
    }

    if (result.data.name !== undefined) updateData.name = result.data.name
    if (result.data.description !== undefined) {
      // 空字符串统一落库为 null，避免出现 '' 与 null 两种「无描述」状态
      updateData.description = result.data.description || null
    }
    if (result.data.icon !== undefined) updateData.icon = result.data.icon
    if (result.data.type !== undefined) {
      updateData.type = APP_TYPE_MAP[result.data.type]
    }
    if (result.data.tags !== undefined) updateData.tags = result.data.tags
    if (result.data.config !== undefined) updateData.config = result.data.config

    // 更新应用，返回更新后的应用信息,include代表关联查询用户信息,如果不存在则返回null
    const app = await prisma.app.update({
      where: { id },
      data: updateData as any,
      include: {
        user: {
          select: { name: true },
        },
      },
    })

    return apiSuccess(
      {
        ...toAppInfo({
          ...app,
          type: app.type,
        }),
        updatedAt: formatDate(app.updatedAt),
        createdAt: formatDate(app.createdAt),
        version: app.version,
        config: app.config,
      },
      '应用更新成功'
    )
  } catch (error) {
    return handleApiError(error)
  }
}

/**
 * 删除应用（软删除）。
 *
 * 请求：DELETE /api/apps/[id]
 *
 * 路径参数：
 * - params.id：应用 ID
 * 响应（成功）：{ id }，提示语「应用删除成功」
 *
 * 说明：
 * - 只把 isDeleted 置为 true，不物理删除记录，便于回溯与恢复；
 * - 列表、详情、更新接口均带 isDeleted: false 过滤，删除后对接口不可见。
 *
 * 错误码：
 * - UNAUTHORIZED       未登录
 * - APP_NOT_FOUND      应用不存在或已软删除
 * - APP_DELETE_FAILED  应用不属于当前用户（复用该错误码表示无权删除）
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getCurrentUserId()
    if (!userId) {
      return apiError(ErrorCode.UNAUTHORIZED)
    }

    const { id } = await params

    // 检查应用是否存在且属于当前用户
    const existingApp = await prisma.app.findFirst({
      where: {
        id,
        isDeleted: false,
      },
    })

    if (!existingApp) {
      return apiError(ErrorCode.APP_NOT_FOUND)
    }

    if (existingApp.userId !== userId) {
      return apiError(ErrorCode.APP_DELETE_FAILED, '无权删除此应用')
    }

    // 软删除：只置 isDeleted 标记，保留原始数据；后续查询通过 isDeleted: false 过滤
    await prisma.app.update({
      where: { id },
      data: {
        isDeleted: true,
      },
    })

    return apiSuccess({ id }, '应用删除成功')
  } catch (error) {
    return handleApiError(error)
  }
}
