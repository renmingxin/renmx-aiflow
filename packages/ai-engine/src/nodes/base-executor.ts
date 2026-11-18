import type { ExecutionContext, ExecutionLogger, NodeExecutionResult, NodeExecutor, NodeKind, OutputVariableSchema } from '../types'

/**
 * 节点执行器基类（模板方法模式）
 *
 * 所有节点执行器（start / end / llm / http / condition / knowledge / 插件节点等）都继承它，
 * 目的只有一个：把「每个节点都要做、且写法完全一样」的横切逻辑收敛到基类，
 * 子类只专注自己的业务。
 *
 * 分工：
 *   基类 execute（对外唯一入口，final 语义）
 *     - 记录开始时间
 *     - 写「节点开始」日志
 *     - 调用子类实现的 doExecute 拿业务结果
 *     - 成功时把 outputs 写入执行上下文的变量表，供下游节点引用
 *     - 用真实耗时覆盖子类返回的 duration
 *     - 写「节点结束」日志
 *     - 捕获一切异常，转成 success:false 的结果返回（不向外抛）
 *   子类 doExecute（唯一必须实现的方法）
 *     - 只负责「拿到 config + context，算出 outputs」
 *     - 不写变量表、不计时、不记开始/结束日志（这些基类已经做了）
 *
 * 为什么异常要在这里吞掉：
 *   引擎是按节点顺序推进的，如果某个节点抛异常直接冒到最外层，
 *   上层就只剩下一个错误对象，拿不到「哪个阶段、耗时多久、已产生哪些日志」。
 *   统一转成 NodeExecutionResult 后，engine 只需判断 success 字段即可。
 */
export abstract class BaseNodeExecutor<TConfig = Record<string, unknown>> implements NodeExecutor<TConfig> {
  /**
   * 节点类型标识（如 'start'、'llm'、'plugin:xxx:yyy'）。
   *
   * 注册表以它为 key 建立「类型 -> 执行器」映射，engine 执行节点时通过
   * registry.get(node.type) 找到对应执行器，因此该值必须与工作流定义里的节点 type 完全一致。
   * 声明为 abstract readonly，强制每个子类给出自己的类型字面量。
   */
  abstract readonly type: NodeKind

  /**
   * 子类实现具体执行逻辑（唯一必须实现的抽象方法）。
   *
   * 契约（子类必须遵守）：
   *   1. 只返回本节点的输出，不要调用 context.variables.setNodeOutputs ——
   *      基类会在 success 为 true 时统一写入，避免子类漏写或写错 nodeId。
   *   2. 不要自己计算 duration，也不要写 nodeStart / nodeEnd 日志；
   *      基类会用真实耗时覆盖，并负责首尾日志。
   *   3. 可以直接 throw；异常会被基类捕获并转成 success:false 的结果，
   *      但更推荐返回带 error 的失败结果，便于在结果里带上更多上下文。
   *   4. 需要解析 config 中的 `${nodeId.field}` 变量时，调用 resolveConfigVariables。
   *
   * @param nodeId  当前节点 ID（插件节点、条件节点等需要用它区分自身或定位分支）
   * @param config  节点的业务配置（表单值），由各子类按自己的 TConfig 解读
   * @param context 执行上下文：读取 input、写/读变量表、查询上游节点、解析变量表达式
   * @param logger  执行日志器：记录 debug/info/warn/error，最终会随结果返回给上层
   * @returns 节点执行结果；失败时 success 为 false 并带上 error
   */
  protected abstract doExecute(
    nodeId: string,
    config: TConfig,
    context: ExecutionContext,
    logger: ExecutionLogger
  ): Promise<NodeExecutionResult>

  /**
   * 执行节点（带错误处理和计时）。
   *
   * 这是引擎唯一会调用的方法，子类通常不应该重写它。
   * 整个方法被 try/catch 包裹，保证无论发生什么都不向外抛异常，
   * 调用方永远拿到一个结构完整的 NodeExecutionResult。
   *
   * @returns 一定包含 success、outputs、duration；失败时还包括 error
   */
  async execute(nodeId: string, config: TConfig, context: ExecutionContext, logger: ExecutionLogger): Promise<NodeExecutionResult> {
    // 计时起点：耗时包含子类 doExecute 的全部执行时间（含网络请求、模型调用等）
    const startTime = Date.now()

    try {
      // 记录「节点开始」，日志里会带上节点类型与配置，便于排查执行到哪一步
      logger.nodeStart(nodeId, this.type, config)

      // 交给子类执行具体业务
      const result = await this.doExecute(nodeId, config, context, logger)

      // 只有成功的结果才写入变量表：
      // 失败节点不产出可信数据，写进去会污染下游的输入聚合逻辑
      if (result.success) {
        context.variables.setNodeOutputs(nodeId, result.outputs)
      }

      // 用基类测得的真实耗时覆盖子类返回的 duration，
      // 子类通常返回 0，真正的耗时只有这里才知道
      const finalResult = {
        ...result,
        duration: Date.now() - startTime,
      }

      // 记录「节点结束」（成功路径），上层会据此推送 SSE node:end
      logger.nodeEnd(nodeId, finalResult)

      return finalResult
    } catch (error) {
      // 走到这里说明子类抛了异常（必填参数缺失、模型调用失败、JSON 解析失败等）
      // 统一包成失败结果：outputs 为空、保留错误对象、带上已消耗的耗时
      const result: NodeExecutionResult = {
        success: false,
        outputs: {},
        error: error instanceof Error ? error : new Error(String(error)),
        duration: Date.now() - startTime,
      }

      // 失败路径同样要写「节点结束」日志，否则前端看到的节点会一直停在 running
      logger.nodeEnd(nodeId, result)

      return result
    }
  }

  /**
   * 校验节点配置是否合法（默认实现：一律通过）。
   *
   * 由子类按需重写，用于检查自己的 config 结构（例如 start 节点要求 inputs 是数组）。
   * 注意：这里只做静态结构检查，不执行节点，也不访问运行时数据；
   * engine 的 validate 会遍历所有节点调用它，可在保存工作流前用来提前报错。
   *
   * @returns valid 表示是否合法；errors 仅在存在错误时返回，供前端展示
   */
  validate(_config: TConfig): { valid: boolean; errors?: string[] } {
    return { valid: true }
  }

  /**
   * 声明本节点的输出变量结构（默认实现：无输出）。
   *
   * 供前端「变量选择器」展示该节点可以引用哪些字段，
   * 子类重写时应返回与 doExecute 实际写入 outputs 的键一一对应的描述。
   */
  getOutputSchema(_config: TConfig): OutputVariableSchema[] {
    return []
  }

  /**
   * 解析配置对象中所有 `${...}` 形式的变量占位符。
   *
   * 典型用法：子类在 doExecute 开头对 config 调用本方法，
   * 把用户配置里引用的上游变量（如 `${start-1.query}`）替换成运行时真实值，
   * 然后再执行 HTTP 请求 / 拼接提示词等。
   *
   * 特性：
   *   - 深度遍历：字符串、数组、嵌套对象都会被处理
   *   - 返回新对象，不修改传入的 config（避免同一份工作流定义在多次执行间被污染）
   *   - 解析失败不会报错，只是保留原占位符文本
   */
  protected resolveConfigVariables(config: TConfig, context: ExecutionContext, logger: ExecutionLogger): TConfig {
    return this.deepResolve(config, context, logger)
  }

  /**
   * 深度解析对象中的变量（resolveConfigVariables 的递归实现）。
   *
   * 递归规则：
   *   - 字符串：交给 context.resolveText 做模板替换；若替换后内容有变化，
   *     额外记一条 variableResolve 日志，便于追溯「哪个表达式解析成了什么」
   *   - 数组：逐项递归，返回新数组
   *   - 普通对象：逐 key 递归，返回新对象
   *   - 其他类型（数字、布尔、null、undefined）：原样返回，不做处理
   *
   * 注意：
   *   - 这里刻意只处理字符串里的占位符，不会把 `"${x}"` 转成非字符串类型，
   *     所以解析结果始终是字符串；需要数字/布尔时应由子类自行转换
   *   - 只适用于可 JSON 化的纯数据配置；Date、Map、函数等特殊对象会被当成普通对象遍历，
   *     可能得到空对象，因此 config 中不应放这类值
   */
  private deepResolve(obj: unknown, context: ExecutionContext, logger: ExecutionLogger): any {
    if (typeof obj === 'string') {
      const resolved = context.resolveText(obj)
      // 只有真正发生了替换才记日志，避免为每个不含占位符的字符串刷日志
      if (resolved !== obj) {
        logger.variableResolve(obj, obj, resolved)
      }
      return resolved
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.deepResolve(item, context, logger))
    }

    // 必须先排除 null：typeof null 也是 'object'，否则会被当成对象遍历
    if (obj !== null && typeof obj === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.deepResolve(value, context, logger)
      }
      return result
    }

    // 数字、布尔、undefined、null 等直接返回
    return obj
  }
}
