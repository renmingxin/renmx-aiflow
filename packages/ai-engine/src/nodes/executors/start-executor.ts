import type { ExecutionContext, ExecutionLogger, NodeExecutionResult, OutputVariableSchema, StartNodeConfig } from '../../types'
import { BaseNodeExecutor } from '../base-executor'

/**
 * START 节点执行器（工作流入口）
 *
 * 职责：把「本次运行用户提交的输入参数」按节点配置里声明的输入清单整理成一份输出对象，
 * 写入执行上下文的变量表，供下游节点通过 `${start节点ID.字段名}` 引用。
 *
 * 它在整个执行链路中的位置：
 *   engine.execute
 *     -> 聚合上游输入（START 没有上游，因此合并的是 context.inputs）
 *     -> 调用本执行器的 execute（基类实现）
 *     -> 基类做计时 / 记日志 / 捕获异常 / 把 outputs 写入 context.variables
 *     -> 本类只负责具体的「取值 + 默认值 + 必填校验」逻辑
 *
 * 注意：本节点不产生任何副作用（不发请求、不调模型），只是数据搬运与格式转换。
 */
export class StartExecutor extends BaseNodeExecutor<StartNodeConfig> {
  /**
   * 节点类型标识。
   * 注册表以该字符串为 key 建立「类型 -> 执行器」映射，engine 执行时用它查找执行器，
   * 因此必须与工作流定义里节点的 type 完全一致。
   */
  readonly type = 'start' as const

  /**
   * 执行 START 节点的具体逻辑。
   *
   * 处理流程（遍历配置中声明的每一个输入项）：
   *   1. 从 context.inputs 取用户实际提交的值
   *   2. 若用户没传（值为 undefined）而配置了 defaultValue，则解析默认值
   *   3. 若仍为 undefined 且该项标记为必填，则直接抛错，中断整个工作流
   *   4. 把结果写入 outputs，键名即变量名
   *
   * @param _nodeId  节点 ID。START 节点无需按 ID 区分自身，因此有意不使用（下划线前缀表示这一点）
   * @param config   节点配置，核心是 inputs 数组：声明本工作流需要哪些输入、类型、默认值、是否必填
   * @param context  执行上下文，这里只读取其中的 inputs（用户提交的原始参数）
   * @param logger   执行日志器，用于记录默认值生效、每个参数的解析结果等调试信息
   * @returns 成功结果，outputs 的键为输入参数名，值为解析后的实际值
   */
  protected async doExecute(
    _nodeId: string,
    config: StartNodeConfig,
    context: ExecutionContext,
    logger: ExecutionLogger
  ): Promise<NodeExecutionResult> {
    console.log('START inputs:', { _nodeId, config, inputs: context.inputs })
    /** 收集解析后的输入，最终作为本节点的输出写入变量表 */
    const outputs: Record<string, unknown> = {}

    // 遍历配置中声明的输入清单，而不是遍历用户提交的对象。
    // 这样输出字段是可控的：用户多传的字段会被忽略，避免脏数据流入下游。
    for (const input of config.inputs || []) {
      // 用户实际提交的值；未提交时为 undefined
      let value = context.inputs[input.name]

      // 使用默认值
      // 默认值在配置里以字符串形式保存（表单输入），需要按声明的类型转换成真实类型，
      // 否则下游拿到的是字符串 "1" 而不是数字 1，条件判断、数值计算都会出错。
      if (value === undefined && input.defaultValue !== undefined) {
        value = this.parseDefaultValue(input.defaultValue, input.type)
        logger.debug(`Using default value for input: ${input.name}`, {
          name: input.name,
          defaultValue: input.defaultValue,
          parsedValue: value,
        })
      }

      // 检查必填
      // 走到这里还没值，说明用户没传且没有默认值；若该项必填则直接抛错，
      // 异常会被基类 execute 捕获并转成 success:false，工作流随即中断。
      if (value === undefined && input.required) {
        throw new Error(`Required input parameter missing: ${input.name}`)
      }

      // 无论是否有值都写入：非必填且未提供时值为 undefined，
      // 这样下游引用该字段时能明确知道「存在这个变量但为空」，而不是完全取不到。
      outputs[input.name] = value

      logger.debug(`Input parameter resolved: ${input.name}`, {
        name: input.name,
        value,
        type: input.type,
      })
    }

    // 基类会补充真实的 duration 并写日志，这里返回 0 即可
    return {
      success: true,
      outputs,
      duration: 0,
    }
  }

  /**
   * 把配置里的字符串默认值按声明类型转换成运行时真实类型。
   *
   * 之所以需要转换：配置来自前端表单，defaultValue 统一是字符串，
   * 而工作流里下游节点按 type 使用这个值（例如 number 参与算术、boolean 参与条件判断）。
   *
   * 各分支行为：
   *   - number ：parseFloat 转换；非法数字会得到 NaN（当前不做拦截）
   *   - boolean：只有忽略大小写等于 "true" 才算 true，其余一律 false
   *   - array / object：按 JSON 解析；解析失败时原样返回字符串，避免直接抛错
   *   - 其他（string 等）：原样返回
   *
   * @param value 配置中的默认值（字符串）
   * @param type  输入项声明的类型
   * @returns 转换后的值；无法转换时回退为原始字符串
   */
  private parseDefaultValue(value: string, type: string): unknown {
    switch (type) {
      case 'number':
        return parseFloat(value)
      case 'boolean':
        return value.toLowerCase() === 'true'
      case 'array':
      case 'object':
        try {
          return JSON.parse(value)
        } catch {
          // JSON 格式不合法时不做兜底结构，直接返回原字符串，由使用方自行判断
          return value
        }
      default:
        return value
    }
  }

  /**
   * 校验节点配置是否合法（保存工作流时由引擎的 validate 调用）。
   *
   * 检查两条规则：
   *   1. inputs 必须存在且是数组
   *   2. 数组中的每一项都必须有 name（name 是下游引用变量的键，不能为空）
   *
   * 这里只做结构校验，不校验默认值与类型是否匹配。
   *
   * @returns valid 表示是否合法；errors 仅在存在错误时返回
   */
  override validate(config: StartNodeConfig): { valid: boolean; errors?: string[] } {
    const errors: string[] = []

    if (!config.inputs || !Array.isArray(config.inputs)) {
      errors.push('inputs must be an array')
    } else {
      for (const input of config.inputs) {
        if (!input.name) {
          errors.push('Each input must have a name')
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    }
  }

  /**
   * 声明本节点的输出变量结构，供前端变量选择器展示「START 节点有哪些可引用字段」。
   *
   * 规则：配置里声明的每个输入项就是本节点的一个输出变量；
   * 类型未填写时按 string 处理，description 原样透传。缺省的默认值不影响 schema。
   */
  override getOutputSchema(config: StartNodeConfig): OutputVariableSchema[] {
    return (config.inputs || []).map(input => ({
      name: input.name,
      type: input.type || 'string',
      description: input.description,
    }))
  }
}
