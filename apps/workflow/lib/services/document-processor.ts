import {
  type ChunkWithVector,
  createMarkdownSplitter,
  createOllamaEmbeddingService,
  createQdrantVectorStore,
  createTextSplitter,
} from '@renmx-aiflow/ai-engine'

import { prisma } from '@/lib/prisma'

/**
 * 文档处理参数
 *
 * 由上传接口（POST /api/knowledge/[id]/documents）传入，
 * 其中 chunkSize / chunkOverlap / embeddingModel / dimensions
 * 均取自所属知识库的配置，保证同一知识库内的文档使用一致的切分与向量化策略。
 */
interface ProcessDocumentParams {
  /** 文档 ID，用于回写处理状态与组装向量主键 */
  documentId: string
  /** 知识库 ID，写入向量 payload 用于后续按知识库检索与过滤 */
  knowledgeBaseId: string
  /** 文档纯文本内容，切分与嵌入都基于此内容 */
  content: string
  /** 原始文件名，用于判断是否走 Markdown 专用切分器 */
  fileName: string
  /** 单个切片的字符长度（由知识库配置决定） */
  chunkSize: number
  /** 相邻切片的重叠字符数，用于保留跨切片的上下文（由知识库配置决定） */
  chunkOverlap: number
  /** 嵌入模型名称，需与知识库配置一致，否则向量不可比较 */
  embeddingModel: string
  /** 嵌入向量维度，必须与 Qdrant collection 的维度保持一致 */
  dimensions: number
}

/**
 * 处理文档：切分 → 生成嵌入向量 → 存储到 Qdrant → 回写状态
 *
 * 执行流程：
 * 1. 将文档状态置为 PROCESSING，避免前端把待处理文档误认为已完成
 * 2. 根据文件类型选择切分器（Markdown 走结构化切分，其余走通用文本切分）
 * 3. 批量调用嵌入服务，把每个切片的文本转成向量
 * 4. 确保 Qdrant collection 存在，然后批量写入切片与向量
 * 5. 更新文档状态为 COMPLETED，并记录切片数与完成时间
 * 6. 累加知识库的切片总数
 *
 * 失败处理：
 * 任意步骤抛错时，会把文档状态置为 ERROR 并写入 errorMessage，
 * 随后继续向上抛出，由调用方决定是否记录日志。
 */
export async function processDocument(params: ProcessDocumentParams): Promise<void> {
  const { documentId, knowledgeBaseId, content, fileName, chunkSize, chunkOverlap, embeddingModel, dimensions } = params

  try {
    // 进入处理流程，先把状态从 PENDING 改为 PROCESSING，便于前端展示处理中状态
    await prisma.document.update({
      where: { id: documentId },
      data: { status: 'PROCESSING' },
    })

    // 1. 切分文档
    //    Markdown 使用专用切分器，尽量按标题层级等结构切分；
    //    其他纯文本文件使用通用切分器，按字符长度 + 重叠窗口切分
    const isMarkdown = fileName.endsWith('.md') || fileName.endsWith('.markdown')
    const splitter = isMarkdown ? createMarkdownSplitter({ chunkSize, chunkOverlap }) : createTextSplitter({ chunkSize, chunkOverlap })

    const chunks = splitter.split(content)

    // 内容为空或全部被过滤时无法生成切片，直接判为失败
    if (chunks.length === 0) {
      throw new Error('文档内容为空或无法切分')
    }

    // 2. 生成嵌入向量
    //    使用知识库配置的模型与维度，模型或维度不一致会导致向量无法与已有数据比对
    const embeddingService = createOllamaEmbeddingService({
      model: embeddingModel,
      dimensions,
    })

    // 批量嵌入：只把切片文本传给嵌入服务，向量与切片按下标一一对应
    const chunkTexts = chunks.map(c => c.content)
    const embeddings = await embeddingService.embedTexts(chunkTexts)

    // 3. 存储到 Qdrant
    //    所有知识库共用同一个 collection，通过 payload 中的 documentId / knowledgeBaseId 区分归属
    const vectorStore = createQdrantVectorStore({
      url: process.env.QDRANT_URL || 'http://localhost:6333',
      collectionName: 'knowledge_chunks',
    })

    // 确保 collection 存在且维度正确（首次上传或维度变更时需要创建）
    await vectorStore.ensureCollection(dimensions)

    // 组装写入 Qdrant 的数据：切片文本 + 位置信息 + 归属信息 + 对应向量
    // id 采用 `${documentId}_${idx}` 形式，保证同一文档重复处理时能覆盖而非重复写入
    const vectorChunks: ChunkWithVector[] = chunks.map((chunk, idx) => ({
      id: `${documentId}_${idx}`,
      content: chunk.content,
      index: chunk.index,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      documentId,
      knowledgeBaseId,
      vector: embeddings[idx],
    }))

    // 批量写入 / 更新向量，upsert 语义保证重复处理同一文档时结果幂等
    await vectorStore.upsertVectors(vectorChunks)

    // 4. 更新文档状态
    //    记录切片数、完成时间，并把状态置为 COMPLETED，表示该文档可用于检索
    await prisma.document.update({
      where: { id: documentId },
      data: {
        status: 'COMPLETED',
        chunkCount: chunks.length,
        processedAt: new Date(),
      },
    })

    // 5. 更新知识库切片计数
    //    使用 increment 自增，避免并发处理多个文档时出现计数覆盖
    await prisma.knowledgeBase.update({
      where: { id: knowledgeBaseId },
      data: {
        chunkCount: { increment: chunks.length },
      },
    })
  } catch (error) {
    // 处理失败：把状态置为 ERROR 并记录失败原因，方便前端展示与后续重试
    await prisma.document.update({
      where: { id: documentId },
      data: {
        status: 'ERROR',
        errorMessage: error instanceof Error ? error.message : '处理失败',
      },
    })
    // 继续向上抛出，由调用方（上传接口的后台任务）统一记录日志
    throw error
  }
}

/**
 * 删除文档关联的向量数据
 *
 * 用途：删除文档或删除知识库时清理 Qdrant 中的残留向量，
 * 否则旧向量仍可能被检索到，造成「已删除文档仍出现在回答依据中」的问题。
 *
 * @param documentId 文档 ID，作为 payload 中的过滤条件
 */
export async function deleteDocumentVectors(documentId: string): Promise<void> {
  // 与写入时使用同一个 collection，保证清理到的是同一批数据
  const vectorStore = createQdrantVectorStore({
    url: process.env.QDRANT_URL || 'http://localhost:6333',
    collectionName: 'knowledge_chunks',
  })

  // 按 documentId 过滤删除该文档的全部切片
  await vectorStore.deleteByDocumentId(documentId)
}
