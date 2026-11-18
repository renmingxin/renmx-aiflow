import type { EndNodeConfig, ExecutionContext, ExecutionLogger, NodeExecutionResult, OutputVariableSchema } from '../../types'
import { BaseNodeExecutor } from '../base-executor'

/**
 * END 节点执行器（工作流出口）
 *
 * 职责：把配置里声明的「输出字段 -> 变量表达式」映射，按当前变量表求值，
 * 组装成本节点的 outputs。engine 执行时只收集 type === 'end' 的节点输出作为
 * 整个工作流的最终结果（返回给接口调用方）。
 *
 * 与其他节点的区别：
 *   - START 决定「工作流能接收什么」，END 决定「工作流对外返回什么」
 *   - 本节点不调用任何外部服务，只做变量求值与类型转换
 *   - 本节点没有下游（校验器会保证它是终点），因此它的输出不会写进下游输入，
 *     而是由 engine 汇总进 finalOutputs
 *
 * 关于变量表达式语法：
 *   引擎支持的是 `${nodeId.field}`（美元符 + 花括号），不是 `{{...}}`。
 *   例如 `${llm-1.output}` 表示取 ID 为 llm-1 的节点的 output 字段。
 *
 * 多个 END 节点的情况：
 *   engine 用 `{ ...finalOutputs, ...result.outputs }` 逐次合并，
 *   因此字段名重复时「后执行的 END 节点」会覆盖先执行的。
 */
export class EndExecutor extends BaseNodeExecutor<EndNodeConfig> {
  /**
   * 节点类型标识，注册表中的 key；与工作流定义里的 type 必须一致。
   * 这个字面量同时被 engine 用作「是否收集为最终输出」的判断条件。
   */
  readonly type = 'end' as const

  /**
   * 执行 END 节点：逐条解析输出配置，生成 outputs。
   *
   * 每个输出项（OutputParam）包含：
   *   name        对外输出的字段名
   *   type        目标类型（string / number / boolean / array / object）
   *   value       取值表达式，可以是单个变量，也可以是带占位符的模板文本
   *   description 字段说明（仅用于前端展示）
   *
   * @param _nodeId  节点 ID。END 的输出完全由 config 决定，不需要用自身 ID，因此有意不使用
   * @param config   节点配置，核心是 outputs 数组
   * @param context  执行上下文，提供变量表用于求值
   * @param logger   执行日志器，记录变量解析、告警与调试信息
   * @returns 成功结果，outputs 的键为输出字段名
   */
  protected async doExecute(
    _nodeId: string,
    config: EndNodeConfig,
    context: ExecutionContext,
    logger: ExecutionLogger
  ): Promise<NodeExecutionResult> {
    /** 收集所有输出字段，最终作为工作流结果的一部分 */
    const outputs: Record<string, unknown> = {}

    for (const output of config.outputs || []) {
      // 解析变量表达式
      let value: unknown
      // 这里用「是否以 ${ 开头」区分两种取值模式：
      //   - 单个变量表达式：走 resolveVariable，能保留原始类型（对象、数组、数字都不会被字符串化）
      //   - 其他（纯文本或含占位符的模板）：走 resolveText，做字符串替换，结果一定是字符串
      //
      // 注意这个判断比较粗略：
      //   - "前缀${a.b}" 会走 resolveText（结果正确）
      //   - "${a.b}后缀" 会走 resolveVariable，但它的正则要求整串完全匹配 ${...}，
      //     匹配失败时 found 为 false，于是落到下面的 warn 分支并保留原文
      if (output.value && output.value.startsWith('${')) {
        value = context.resolveVariable(output.value)
        if (value === undefined) {
          // 变量取不到（节点未执行、字段名写错、上游失败等）时不中断流程，
          // 记一条 warn 并把表达式原文当作值传下去，便于排查问题来源
          logger.warn(`Variable not resolved: ${output.value}`)
          value = output.value // 保留原始表达式
        } else {
          // 解析成功也记一条日志，方便对照「表达式 -> 实际值」
          logger.variableResolve(output.value, output.value, value)
        }
      } else {
        // 模板文本：value 为空时按空字符串处理，最终得到空串而不是 undefined
        value = context.resolveText(output.value || '')
      }

      // 类型转换
      // 表达式取到的类型未必符合配置声明（例如上游给的是 "123" 字符串），
      // 这里按 output.type 统一转成对外承诺的类型
      outputs[output.name] = this.convertType(value, output.type)

      logger.debug(`Output parameter collected: ${output.name}`, {
        name: output.name,
        expression: output.value,
        value: outputs[output.name],
        type: output.type,
      })
    }

    // 与 START 一样，真实耗时由基类补充，这里返回 0
    return {
      success: true,
      outputs,
      duration: 0,
    }
  }

  /**
   * 按目标类型转换值（尽力而为，不抛错）。
   *
   * 各分支行为：
   *   - undefined / null：原样返回，保持「空值」语义，不强行转成 0 或 ""
   *   - number ：本身是数字直接用；否则 parseFloat；转不出来（NaN）时返回 0
   *   - boolean：本身是布尔直接用；否则只有忽略大小写等于 "true" 才为 true，
   *              "1"、"yes"、"TRUE "（带空格）都会得到 false
   *   - array  ：本身是数组直接用；否则尝试 JSON.parse，解析结果是数组就用它；
   *              否则把「原始值」包成单元素数组（注意包的是原值，不是解析结果）
   *   - object ：本身是非数组对象直接用；否则尝试 JSON.parse（此分支不校验结果是否为对象，
   *              所以 "[]" 会被解析成数组返回）；解析失败时退化为 { value: 原值 }
   *   - string （默认）：对象或数组用 JSON.stringify，其他用 String()
   *
   * @param value 待转换的值
   * @param type  目标类型
   * @returns 转换后的值
   */
  private convertType(value: unknown, type: string): unknown {
    // 空值不参与转换：否则 null 会变成 "null"、undefined 变成 "undefined"，语义被破坏
    if (value === undefined || value === null) {
      return value
    }

    switch (type) {
      case 'number': {
        if (typeof value === 'number') return value
        const num = parseFloat(String(value))
        // 无法解析（如 "abc"）时兜底为 0，避免下游拿到 NaN
        return isNaN(num) ? 0 : num
      }
      case 'boolean':
        if (typeof value === 'boolean') return value
        return String(value).toLowerCase() === 'true'
      case 'array':
        if (Array.isArray(value)) return value
        try {
          const parsed = JSON.parse(String(value))
          return Array.isArray(parsed) ? parsed : [value]
        } catch {
          // 不是合法 JSON：按「单个元素」处理
          return [value]
        }
      case 'object':
        // 注意 Array 也是 object，所以要额外排除数组
        if (typeof value === 'object' && !Array.isArray(value)) return value
        try {
          return JSON.parse(String(value))
        } catch {
          // 解析失败时包一层，保证返回值一定是对象，下游可按 key 取值
          return { value }
        }
      case 'string':
      default:
        // 如果值是对象或数组，使用 JSON.stringify
        if (typeof value === 'object') {
          return JSON.stringify(value)
        }
        return String(value)
    }
  }

  /**
   * 校验 END 节点配置（保存工作流时调用）。
   *
   * 规则很宽松：outputs 可以完全不配置（允许工作流不返回任何数据）；
   * 一旦配置了，数组里每一项都必须有 name（否则前端拿不到字段名、下游无法引用）。
   * 不校验 value 表达式语法与 type 取值是否合法。
   *
   * @returns valid 表示是否合法；errors 仅在存在错误时返回
   */
  override validate(config: EndNodeConfig): { valid: boolean; errors?: string[] } {
    const errors: string[] = []

    if (config.outputs) {
      for (const output of config.outputs) {
        if (!output.name) {
          errors.push('Each output must have a name')
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    }
  }

  /**
   * 声明本节点的输出变量结构（即工作流最终结果包含哪些字段）。
   *
   * 供前端展示与文档生成使用；type 未配置时按 string 处理，
   * description 原样透传。这里的顺序与 config.outputs 保持一致。
   */
  override getOutputSchema(config: EndNodeConfig): OutputVariableSchema[] {
    return (config.outputs || []).map(output => ({
      name: output.name,
      type: output.type || 'string',
      description: output.description,
    }))
  }
}
