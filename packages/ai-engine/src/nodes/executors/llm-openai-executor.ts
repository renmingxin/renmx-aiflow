import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'

import type { ExecutionContext, ExecutionLogger, LLMNodeConfig, NodeExecutionResult, OutputVariableSchema } from '../../types'
import { BaseNodeExecutor } from '../base-executor'

/**
 * LLM 节点执行器
 *
 * 职责：把一个「提示词配置」变成一次真实的大模型调用，并把模型回复作为节点输出写入变量表，
 * 供下游节点通过 `${llm节点ID.output}` 引用。
 *
 * 技术选型：
 *   用 @langchain/openai 的 ChatOpenAI 调用 OpenAI 兼容接口（当前指向火山方舟 Ark），
 *   因此 model / apiKey / baseURL 三个参数必须与目标服务匹配。
 *
 * 一次执行的完整链路：
 *   1. 解析 config 中的 `${nodeId.field}` 变量（提示词里通常引用了上游节点的输出）
 *   2. 按 system -> human -> assistant 的顺序组装 LangChain 消息数组
 *   3. 记录请求日志（模型名、消息、温度、最大 token）
 *   4. 创建 ChatOpenAI 实例并 invoke（同步等待完整回复，非流式）
 *   5. 统计耗时、估算 token，记录响应日志
 *   6. 返回 { output, tokens } 作为输出
 *
 * 注意：本类不处理超时与重试，invoke 抛错会被基类 execute 捕获并转成 success:false。
 */
export class OpenAIExecutor extends BaseNodeExecutor<LLMNodeConfig> {
  /**
   * 节点类型标识，注册表中的 key；与工作流定义里的 type 必须一致。
   */
  readonly type = 'openai' as const

  /**
   * 执行 LLM 节点。
   *
   * @param nodeId  当前节点 ID，用于写请求/响应日志，便于把日志归到具体节点
   * @param config  节点配置：model、systemPrompt、userPrompt、assistantPrompt、temperature、maxTokens
   * @param context 执行上下文，提供变量表用于解析提示词中的占位符
   * @param logger  执行日志器，记录 llmRequest / llmResponse 事件
   * @returns 成功时 outputs 为 { output: 模型回复文本, tokens: 估算的 token 数 }
   */
  protected async doExecute(
    nodeId: string,
    config: LLMNodeConfig,
    context: ExecutionContext,
    logger: ExecutionLogger
  ): Promise<NodeExecutionResult> {
    // 解析配置中的变量
    // 例如 userPrompt 为 "总结一下：${start-1.query}"，
    // 这里会把它替换成真实的用户输入。注意只做字符串替换，
    // 返回的是新的 config 对象，不会修改原始工作流定义。
    const resolvedConfig = this.resolveConfigVariables(config, context, logger)

    // 构建消息
    // 按「系统设定 -> 用户输入 -> 助手前缀」的顺序压入数组，
    // 该顺序即为发给模型的消息顺序。
    const messages: Array<SystemMessage | HumanMessage | AIMessage> = []

    // 系统消息：设定角色、语气、输出格式等全局约束（可选）
    if (resolvedConfig.systemPrompt) {
      messages.push(new SystemMessage(resolvedConfig.systemPrompt))
    }

    // 用户消息：本次真正要模型处理的内容（通常含上游变量）
    if (resolvedConfig.userPrompt) {
      messages.push(new HumanMessage(resolvedConfig.userPrompt))
    }

    // 助手消息：作为「模型已经说过的话」拼在末尾（可选）。
    // 由于它在用户消息之后，实际效果是给模型一段回复前缀，让它顺着续写；
    // 不需要这种用法时应留空。
    if (resolvedConfig.assistantPrompt) {
      messages.push(new AIMessage(resolvedConfig.assistantPrompt))
    }

    // 记录请求
    // 注意 role 取自 LangChain 消息的 _getType()，值为 system / human / ai，
    // 与 OpenAI 风格的 system / user / assistant 不同，排查日志时不要混淆。
    logger.llmRequest(nodeId, {
      model: resolvedConfig.model,
      messages: messages.map(m => ({
        role: m._getType(),
        content: m.content as string,
      })),
      temperature: resolvedConfig.temperature,
      maxTokens: resolvedConfig.maxTokens,
    })

    // 计时起点放在请求日志之后：
    // 因此最终 duration 只包含真正的模型调用时间，不含配置解析与日志开销
    const startTime = Date.now()

    // 创建 ChatOpenAI 实例（当前为写死的火山方舟配置）
    // - model：方舟支持的模型名
    // - apiKey：方舟 API Key（当前硬编码在代码里，后续应改为读环境变量）
    // - configuration.baseURL：方舟 OpenAI 兼容端点，注意这里用的是 /api/plan/v3
    //
    // 注意：节点的 model / temperature 等表单配置目前被这里的三项写死值覆盖，
    // 修改节点设置不会影响实际请求。

    // const llm = new ChatOllama({
    //   model: resolvedConfig.model,
    //   temperature: resolvedConfig.temperature ?? 0.7,
    //   numPredict: resolvedConfig.maxTokens,
    // })
    const llm = new ChatOpenAI({
      model: 'deepseek-v4.1-flash',
      apiKey: process.env.ARK_API_KEY ?? '',
      configuration: {
        baseURL: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      },
    })

    // 调用 LLM
    // invoke 会等待模型生成完毕才返回（非流式），期间整个节点处于运行中状态
    const response = await llm.invoke(messages)

    const duration = Date.now() - startTime

    // 把回复内容统一按字符串处理。
    // LangChain 的 content 理论上可能是消息块数组（多模态/工具调用场景），
    // 这里直接断言为 string，当前只面向纯文本模型。
    const content = response.content as string

    // 估算 token 数（简化实现）
    const tokens = this.estimateTokens(content)

    // 记录响应
    // 只记录输出内容、token 估算值与耗时；请求侧的输入在 llmRequest 里已经记过
    logger.llmResponse(nodeId, {
      content,
      tokens,
      duration,
    })

    // 输出两个变量：
    //   output -> 模型回复正文，最常用
    //   tokens -> 估算消耗，可用于成本/用量展示
    // 基类会把这组 outputs 写入变量表
    return {
      success: true,
      outputs: {
        output: content,
        tokens,
      },
      duration,
    }
  }

  /**
   * 粗略估算 token 数（仅用于展示，不是真实计费数据）。
   *
   * 算法：
   *   - 先数出中文字符个数（Unicode 区间 \u4e00-\u9fa5）
   *   - 其余字符按英文处理
   *   - 中文按 1.5 字符/token、其他按 4 字符/token 折算，最后向上取整
   *
   * 局限：
   *   - 只统计「输出」，不包含输入提示词
   *   - 与具体模型的分词器无关，长短文本都可能有偏差
   *
   * @param text 模型回复文本
   * @returns 估算的 token 数量
   */
  private estimateTokens(text: string): number {
    // 简单估算：中文约1.5字符/token，英文约4字符/token
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
    const otherChars = text.length - chineseChars
    return Math.ceil(chineseChars / 1.5 + otherChars / 4)
  }

  /**
   * 校验 LLM 节点配置（保存工作流时调用，不发起真实请求）。
   *
   * 两条必填规则：
   *   1. 必须指定 model，否则无法确定调用哪个本地模型
   *   2. systemPrompt 与 userPrompt 至少要有一个，否则没有可发送的内容
   *      （只有 assistantPrompt 不算有效，因为那只是回复前缀）
   *
   * @returns valid 表示是否合法；errors 仅在存在错误时返回
   */
  override validate(config: LLMNodeConfig): { valid: boolean; errors?: string[] } {
    const errors: string[] = []

    if (!config.model) {
      errors.push('Model is required')
    }

    if (!config.userPrompt && !config.systemPrompt) {
      errors.push('At least one prompt (user or system) is required')
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    }
  }

  /**
   * 声明本节点的输出变量结构，供前端变量选择器展示可引用的字段。
   *
   * 必须与 doExecute 返回的 outputs 键保持一致：
   *   output -> string
   *   tokens -> number
   */
  override getOutputSchema(): OutputVariableSchema[] {
    return [
      { name: 'output', type: 'string', description: 'LLM 生成的文本内容' },
      { name: 'tokens', type: 'number', description: '消耗的 token 数量' },
    ]
  }
}
