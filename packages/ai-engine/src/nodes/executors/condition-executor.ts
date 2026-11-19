import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { ChatOllama } from '@langchain/ollama'

import type { ConditionNodeConfig, ExecutionContext, ExecutionLogger, NodeExecutionResult, OutputVariableSchema } from '../../types'
import { BaseNodeExecutor } from '../base-executor'
import { createArkChatModel } from './llm-openai-executor'

/**
 * CONDITION 节点执行器（意图识别分支）
 *
 * 职责：把上游节点的文本交给大模型做「意图分类」，再根据分类结果返回一个分支标识
 * （`intent-0` / `intent-1` ...），由引擎据此裁剪执行图，只走命中分支对应的下游。
 *
 * 它在执行链路中的位置：
 *   engine.execute
 *     -> 聚合上游输入后调用 execute（基类实现）
 *     -> 本类：取上游文本 -> 组装意图识别提示词 -> 调模型 -> 解析 JSON -> 返回 matchedBranch
 *     -> engine 收到 matchedBranch 后调用 graphBuilder.selectBranch(node.id, matchedBranch)
 *     -> 重算执行顺序，未命中分支上的节点被移出执行列表
 *
 * 两个关键约定：
 *   1. 分支标识固定为 `intent-${意图在 intents 数组中的下标}`，
 *      必须与画布上该节点出口的 sourceHandle 一致，否则分支裁剪不会生效。
 *   2. 模型选择由 config.model 决定：
 *        - 'openai'  ：走接入的火山方舟（OpenAI 兼容）接口
 *        - 其他字符串：当作本地 Ollama 的模型名（如 qwen3.5:2b）
 *
 * 本节点不处理模型的超时与重试，invoke 抛错会被基类捕获并转成 success:false。
 */
export class ConditionExecutor extends BaseNodeExecutor<ConditionNodeConfig> {
  /**
   * 节点类型标识，注册表中的 key；与工作流定义里的 type 必须一致。
   */
  readonly type = 'condition' as const

  /**
   * 执行 CONDITION 节点。
   *
   * 处理流程：
   *   1. 解析配置里的变量占位符（意图描述里可能引用上游输出）
   *   2. 从直接上游节点的输出中提取待识别文本
   *   3. 用意图清单 + 待识别文本拼出系统提示词与用户提示词
   *   4. 按 config.model 选择模型客户端并调用（temperature 固定 0）
   *   5. 从模型回复中解析 `{ intent, confidence }`
   *   6. 把意图名映射回下标，得到分支标识返回给引擎
   *
   * @param nodeId  当前节点 ID，用于查询上游节点、写日志
   * @param config  节点配置：model（模型选择）、intents（意图清单）
   * @param context 执行上下文，提供变量表与上游节点信息
   * @param logger  执行日志器，记录输入文本、命中结果等调试信息
   * @returns outputs 为 { matchedIntent, confidence }，matchedBranch 为分支标识
   */
  protected async doExecute(
    nodeId: string,
    config: ConditionNodeConfig,
    context: ExecutionContext,
    logger: ExecutionLogger
  ): Promise<NodeExecutionResult> {
    // 解析配置中的变量占位符，返回新的 config 对象，不修改原始工作流定义。
    // 意图的 name / description 若引用上游变量（如 `${llm-1.output}`）会在这里被替换。
    const resolvedConfig = this.resolveConfigVariables(config, context, logger)

    // 获取上游输入（通常是 LLM 的输出或用户输入）
    // 只取「直接前驱」节点，不做跨层回溯。
    const upstreamNodes = context.getUpstreamNodes(nodeId)
    let inputText = ''

    // 从上游节点获取输入文本
    // 优先取约定字段 output（LLM 节点的标准输出），拿到第一个就停止，
    // 因为条件节点只做单输入的意图判断，多上游时以最先遍历到的为准。
    for (const upstreamId of upstreamNodes) {
      const outputs = context.variables.getNodeOutputs(upstreamId)
      if (outputs?.output) {
        // 如果是对象或数组，转换为 JSON 字符串
        // （真值判断会把 '' / 0 / false 视为「没有」，往下走兜底逻辑）
        if (typeof outputs.output === 'object') {
          inputText = JSON.stringify(outputs.output)
        } else {
          inputText = String(outputs.output)
        }
        break
      }
    }

    // 如果没有找到 output，尝试获取其他可能的输入
    // 典型场景：上游是 START 节点，它的输出字段名由用户自定义（如 name / age），并不叫 output。
    // 这里把该上游节点的「全部输出」序列化成 JSON 文本（如 {"name":"renmx","age":10}），
    // 而不是只取第一个字符串字段 —— 否则 age 这类数字字段会被 name 挤掉，
    // 模型拿不到年龄，只能猜意图，分支就会随机走。
    if (!inputText) {
      for (const upstreamId of upstreamNodes) {
        const outputs = context.variables.getNodeOutputs(upstreamId)
        if (outputs) {
          // 过滤掉 undefined，避免序列化后出现无意义的字段
          const plain = Object.fromEntries(Object.entries(outputs).filter(([, value]) => value !== undefined))
          if (Object.keys(plain).length > 0) {
            inputText = JSON.stringify(plain)
            break
          }
        }
      }
    }

    // 两条路都没取到文本时不让流程失败，而是用空串继续跑：
    // 模型大概率会返回默认意图，节点仍会给出一个分支，避免整条流程无谓中断。
    if (!inputText) {
      logger.warn('No input text found for intent recognition, using empty string')
      inputText = ''
    }

    // 记录本次识别的输入摘要（截断 200 字符）与可选意图列表，便于排查误判
    logger.debug('Condition evaluation started', {
      inputText: inputText.substring(0, 200),
      intents: resolvedConfig.intents.map(i => i.name),
    })

    // 构建意图识别提示词
    // 每行形如「1. 意图名: 补充说明」，编号只是给模型看的序号，
    // 真正用于匹配分支的是意图名本身（下标由 intents 数组顺序决定）。
    // description 为空时回退到 condition 字段（历史配置兼容）。
    const intentList = resolvedConfig.intents
      .map((intent, i) => {
        const desc = intent.description || intent.condition || ''
        return `${i + 1}. ${intent.name}${desc ? `: ${desc}` : ''}`
      })
      .join('\n')

    // 系统提示词：给出角色、意图清单、输出格式与约束。
    // 刻意强调「完全匹配意图名称」和「只返回 JSON」，
    // 因为后面的解析强依赖这两点，模型自由发挥会导致解析失败。
    const systemPrompt = `你是一个意图识别助手。分析用户输入并识别其意图。
可能的意图列表：
${intentList}

请严格按照以下 JSON 格式返回，不要添加任何其他内容：
{"intent": "意图名称", "confidence": 0.95}

注意：
1. intent 必须完全匹配意图列表中的某个意图名称（不要添加或修改任何字符）
2. confidence 是 0 到 1 之间的数字，表示置信度
3. 只返回 JSON，不要包含任何解释或其他文本`

    // 用户提示词：只放待识别文本，避免与系统提示词里的规则重复
    const userPrompt = `请分析以下用户输入，判断其意图：

用户输入：${inputText}

请返回 JSON 格式的结果。`

    // 计时起点：后面的 duration 只统计模型调用耗时，不含输入提取与提示词拼接
    const startTime = Date.now()

    // 组装意图识别请求：系统提示词里带意图清单，用户消息里带待识别文本
    // 注意：用户消息不能省。只发系统提示词时模型看不到「待识别内容」，
    // 只能凭意图描述猜测，同一份输入可能随机命中不同分支。
    const messages = [new SystemMessage(systemPrompt), new HumanMessage(userPrompt)]

    // 按配置的 model 选择模型客户端：
    //   - 'openai'：走接入的火山方舟（OpenAI 兼容）接口，模型与密钥由 createArkChatModel 统一提供
    //   - 其他值 ：视为本地 Ollama 的模型名（如 qwen3.5:2b）
    // 意图识别需要稳定输出，两边都把 temperature 设为 0。
    const response =
      resolvedConfig.model === 'openai'
        ? await createArkChatModel(0).invoke(messages)
        : await new ChatOllama({ model: resolvedConfig.model, temperature: 0 }).invoke(messages)

    console.log('response----', response)

    const duration = Date.now() - startTime

    // content 直接按字符串使用：当前只面向纯文本模型，
    // 多模态 / 工具调用场景下它可能是消息块数组，这里不做兼容。
    const content = response.content as string

    // 解析响应
    let matchedIntent = ''
    let confidence = 0

    try {
      // 尝试从响应中提取 JSON
      // 正则取「第一个 { 到最后一个 }」之间的内容，可以容忍模型在 JSON 前后
      // 多说了话（如 ```json 包裹或一句解释）。但如果回复里含多个 JSON 对象，
      // 贪婪匹配会把它们连在一起，导致 JSON.parse 失败并进入 catch 兜底。
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        matchedIntent = parsed.intent || ''
        // confidence 必须是数字才采用，字符串 "0.9" 会被当作 0
        confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0
      }
    } catch {
      // 如果解析失败，尝试匹配意图名称
      // 兜底策略：直接在回复文本里找意图名，找到即命中，置信度给一个中等值 0.5；
      // 找不到时保持 matchedIntent 为空，交给下面的默认逻辑。
      for (const intent of resolvedConfig.intents) {
        if (content.includes(intent.name)) {
          matchedIntent = intent.name
          confidence = 0.5
          break
        }
      }
    }

    // 如果没有匹配到任何意图，使用第一个作为默认
    // 包括三种情况：解析失败且文本里没出现意图名、模型返回空 intent、
    // 模型返回的 intent 不在清单里（例如多了空格或同义改写）。
    // 置信度 0.3 仅作标识，当前不会据此拒绝执行。
    if (!matchedIntent && resolvedConfig.intents.length > 0) {
      matchedIntent = resolvedConfig.intents[0].name
      confidence = 0.3
      logger.warn('No intent matched, using first intent as default', {
        defaultIntent: matchedIntent,
      })
    }

    // 找到匹配的意图索引
    // branchId 的格式必须与画布边的 sourceHandle 完全一致（intent-0、intent-1 ...），
    // 否则 engine 的 selectBranch 找不到对应出口，分支裁剪不会生效。
    // 若意图名对不上任何配置项，branchId 为 undefined，引擎将保持原执行顺序、不裁剪。
    const intentIndex = resolvedConfig.intents.findIndex(i => i.name === matchedIntent)
    const branchId = intentIndex >= 0 ? `intent-${intentIndex}` : undefined

    // 记录最终判定结果，便于对照「模型原文 -> 解析结果 -> 分支」
    logger.debug('Condition evaluation completed', {
      matchedIntent,
      confidence,
      branchId,
      duration,
    })

    // 输出两个变量供下游引用；matchedBranch 是给引擎的分支指令，不属于输出变量
    return {
      success: true,
      outputs: {
        matchedIntent,
        confidence,
      },
      matchedBranch: branchId,
      duration,
    }
  }

  /**
   * 校验条件节点配置（保存工作流时调用，不发起真实请求）。
   *
   * 两条规则：
   *   1. model 必填；'openai' 作为一个特殊取值同样算合法
   *   2. 至少配置一个意图，否则没有可供分类的目标
   *
   * 注意这里不校验：意图名是否重复、模型名在本地是否已 pull、
   * OpenAI 的 key / 地址是否可用——这些要到真正执行时才会暴露。
   *
   * @returns valid 表示是否合法；errors 仅在存在错误时返回
   */
  override validate(config: ConditionNodeConfig): { valid: boolean; errors?: string[] } {
    const errors: string[] = []

    if (!config.model) {
      errors.push('Model is required')
    }

    if (!config.intents || config.intents.length === 0) {
      errors.push('At least one intent is required')
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
   *   matchedIntent -> string，命中（或兜底）的意图名称
   *   confidence    -> number，置信度；兜底命中时为 0.3
   */
  override getOutputSchema(): OutputVariableSchema[] {
    return [
      { name: 'matchedIntent', type: 'string', description: '匹配到的意图名称' },
      { name: 'confidence', type: 'number', description: '匹配的置信度' },
    ]
  }
}
