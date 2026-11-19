import { NextRequest } from 'next/server'

import { apiError, apiPaginated, apiSuccess, ErrorCode, handleApiError } from '@/lib/api-response'
import { getCurrentUserId } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { processDocument } from '@/lib/services/document-processor'

/**
 * 知识库文档管理接口
 *
 * 路由：/api/knowledge/[id]/documents
 * 职责：管理「某个知识库」下的文档资源，包含两项能力
 * - GET ：分页查询该知识库的文档列表，支持按处理状态过滤
 * - POST：上传文本类文件到该知识库，落库后异步执行切分、嵌入、向量入库
 *
 * 权限约束：
 * - 所有请求都必须处于登录态，未登录直接返回 UNAUTHORIZED
 * - 只能操作当前用户自己创建的知识库；若知识库不属于当前用户，
 *   统一按「知识库不存在」返回，避免暴露他人资源是否存在
 */

/**
 * GET /api/knowledge/[id]/documents —— 获取指定知识库的文档列表
 *
 * 路径参数：
 * - id：知识库 ID（对应 KnowledgeBase.id）
 *
 * 查询参数：
 * - status  ：按文档处理状态过滤，可选 PENDING / PROCESSING / COMPLETED / ERROR；
 *             传入非法值时忽略该条件，等价于查询全部状态
 * - page    ：页码，从 1 开始，默认 1
 * - pageSize：每页条数，默认 20
 *
 * 返回说明：
 * - 使用统一分页结构（items + 分页元信息）
 * - items 中只返回文档元信息，不包含正文 content，避免响应体过大
 * - 时间字段统一转换为 ISO 字符串，processedAt 未处理完成时为 null
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    // 1. 鉴权：未登录直接拒绝，后续所有查询都依赖 userId 做数据隔离
    const userId = await getCurrentUserId()
    if (!userId) {
      return apiError(ErrorCode.UNAUTHORIZED)
    }

    // 2. Next.js App Router 的 params 为异步对象，需要 await 后才能取到路由参数
    const { id: knowledgeBaseId } = await params

    // 3. 校验知识库是否存在且归属当前用户
    //    先查存在性，再单独校验归属，便于区分错误文案
    const knowledgeBase = await prisma.knowledgeBase.findFirst({
      where: { id: knowledgeBaseId },
    })

    if (!knowledgeBase) {
      return apiError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND)
    }

    if (knowledgeBase.userId !== userId) {
      return apiError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND, '无权访问此知识库')
    }

    // 4. 解析查询参数；page / pageSize 解析失败时会得到 NaN，交由下方默认值兜底
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status') || undefined
    const page = parseInt(searchParams.get('page') || '1')
    const pageSize = parseInt(searchParams.get('pageSize') || '20')

    // 5. 构建查询条件：知识库 ID 为必选，status 仅在取值合法时才追加
    const where: {
      knowledgeBaseId: string
      status?: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'ERROR'
    } = {
      knowledgeBaseId,
    }

    if (status && ['PENDING', 'PROCESSING', 'COMPLETED', 'ERROR'].includes(status)) {
      where.status = status as 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'ERROR'
    }

    // 6. 分页查询：列表与总数并行执行，减少一次数据库往返
    //    排序规则为创建时间倒序，最新上传的文档排在最前面
    const [documents, total] = await Promise.all([
      prisma.document.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.document.count({ where }),
    ])

    const totalPages = Math.ceil(total / pageSize)

    // 7. 数据转换：数据库实体 → 接口返回结构
    //    目的有两个：隐去内部字段（如正文 content），并把 Date 统一转换为 ISO 字符串
    const items = documents.map(doc => ({
      id: doc.id,
      name: doc.name,
      originalName: doc.originalName,
      mimeType: doc.mimeType,
      size: doc.size,
      status: doc.status,
      errorMessage: doc.errorMessage,
      chunkCount: doc.chunkCount,
      processedAt: doc.processedAt?.toISOString() || null,
      createdAt: doc.createdAt.toISOString(),
    }))

    return apiPaginated(items, { page, pageSize, total, totalPages })
  } catch (error) {
    // 统一异常处理：将未预期异常转换为标准的错误响应
    return handleApiError(error)
  }
}

/**
 * POST /api/knowledge/[id]/documents —— 上传文档到指定知识库
 *
 * 路径参数：
 * - id：知识库 ID（对应 KnowledgeBase.id）
 *
 * 请求体：multipart/form-data，字段名固定为 file
 *
 * 校验规则：
 * - 文件必填
 * - 文件类型仅允许纯文本类：TXT / MD / JSON / CSV / HTML
 *   （既校验 MIME 类型，也兼容以 .md / .txt 结尾但 MIME 缺失的文件）
 * - 文件大小不能超过 10MB
 *
 * 处理流程：
 * 1. 读取文件文本内容
 * 2. 创建 Document 记录，初始状态为 PENDING
 * 3. 知识库 documentCount 计数 +1
 * 4. 触发异步处理（切分 → 嵌入 → 写入 Qdrant），接口本身不等待处理完成
 *
 * 返回说明：
 * - 成功时返回新文档的元信息（状态通常仍为 PENDING）
 * - 文档的最终处理结果需要通过 GET 列表或状态轮询接口获取
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    // 1. 鉴权：未登录直接拒绝
    const userId = await getCurrentUserId()
    if (!userId) {
      return apiError(ErrorCode.UNAUTHORIZED)
    }

    // 2. 取路由参数中的知识库 ID
    const { id: knowledgeBaseId } = await params

    // 3. 校验知识库是否存在且归属当前用户
    //    后续会读取该知识库的切分参数与嵌入配置，因此必须先确认归属
    const knowledgeBase = await prisma.knowledgeBase.findFirst({
      where: { id: knowledgeBaseId },
    })

    if (!knowledgeBase) {
      return apiError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND)
    }

    if (knowledgeBase.userId !== userId) {
      return apiError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND, '无权访问此知识库')
    }

    // 4. 解析 FormData，取出上传的文件
    const formData = await request.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return apiError(ErrorCode.VALIDATION_ERROR, '请选择要上传的文件')
    }

    // 5. 校验文件类型：优先匹配标准 MIME 类型，
    //    同时兼容浏览器未正确识别 MIME 时以扩展名兜底的情况
    const allowedTypes = ['text/plain', 'text/markdown', 'application/json', 'text/csv', 'text/html']
    if (!allowedTypes.includes(file.type) && !file.name.endsWith('.md') && !file.name.endsWith('.txt')) {
      return apiError(ErrorCode.VALIDATION_ERROR, '不支持的文件类型，仅支持 TXT、MD、JSON、CSV、HTML')
    }

    // 6. 校验文件大小，上限 10MB，避免超大文件拖垮后续切分与嵌入流程
    const maxSize = 10 * 1024 * 1024
    if (file.size > maxSize) {
      return apiError(ErrorCode.VALIDATION_ERROR, '文件大小不能超过 10MB')
    }

    // 7. 将文件读为纯文本，后续切分与嵌入都基于这份内容进行
    const content = await file.text()

    // 8. 创建文档记录，状态置为 PENDING 等待后台处理；
    //    name 去掉扩展名，originalName 保留原始文件名便于用户识别
    const document = await prisma.document.create({
      data: {
        name: file.name.replace(/\.[^/.]+$/, ''), // 去掉扩展名作为名称
        originalName: file.name,
        mimeType: file.type || 'text/plain',
        size: file.size,
        content,
        status: 'PENDING',
        knowledgeBaseId,
      },
    })

    // 9. 同步更新知识库的文档计数，保证列表页展示的总数与实际文档数量一致
    await prisma.knowledgeBase.update({
      where: { id: knowledgeBaseId },
      data: {
        documentCount: { increment: 1 },
      },
    })

    // 10. 异步处理文档：按知识库自身的切分参数与嵌入模型配置执行
    //     切分 → 生成向量 → 写入 Qdrant，耗时较长，因此不 await，走后台执行
    //     处理结果会回写到 Document 的 status / chunkCount / errorMessage 字段
    processDocument({
      documentId: document.id,
      knowledgeBaseId,
      content,
      fileName: file.name,
      chunkSize: knowledgeBase.chunkSize,
      chunkOverlap: knowledgeBase.chunkOverlap,
      embeddingModel: knowledgeBase.embeddingModel,
      dimensions: knowledgeBase.dimensions,
    }).catch(error => {
      // 后台处理失败不阻塞接口响应，仅记录日志，失败原因由处理器写入 document.errorMessage
      console.error('Document processing failed:', error)
    })

    // 11. 立即返回文档元信息，此时 status 通常仍是 PENDING
    return apiSuccess(
      {
        id: document.id,
        name: document.name,
        originalName: document.originalName,
        mimeType: document.mimeType,
        size: document.size,
        status: document.status,
        createdAt: document.createdAt.toISOString(),
      },
      '文档上传成功，正在处理中'
    )
  } catch (error) {
    // 统一异常处理：将未预期异常转换为标准的错误响应
    return handleApiError(error)
  }
}
