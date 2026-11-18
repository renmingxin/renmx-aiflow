import type { ExecutionContext, ExecutionLogger, HttpNodeConfig, NodeExecutionResult, OutputVariableSchema } from '../../types'
import { BaseNodeExecutor } from '../base-executor'

/**
 * HTTP 节点执行器
 *
 * 职责：按节点配置发出一次 HTTP 请求，把响应整理成统一的输出变量，
 * 供下游节点通过 `${http节点ID.data}` 等方式引用。
 *
 * 完整处理链路：
 *   1. 解析 config 中的变量占位符（URL、header、body 里通常引用了上游输出）
 *   2. 把 params 拼成 query string 追加到 URL
 *   3. 把 headers 数组转成对象
 *   4. 按 method + bodyType 组装请求体，并按类型补 Content-Type
 *   5. 记请求日志 -> fetch（带超时）-> 按 content-type 解析响应 -> 记响应日志
 *   6. 返回 data / status / headers / success / error 五个输出变量
 *
 * 重要设计：HTTP 层面的失败（非 2xx、超时、网络错误）都不算节点执行失败。
 * 本方法始终返回 success: true，把失败信息放在 outputs.success / outputs.error 里，
 * 这样工作流可以继续往下走，由后续的条件节点决定如何分支，
 * 而不是一个接口报错就整条流程中断。
 */
export class HTTPExecutor extends BaseNodeExecutor<HttpNodeConfig> {
  /**
   * 节点类型标识，注册表中的 key；与工作流定义里的 type 必须一致。
   */
  readonly type = 'http' as const

  /**
   * 执行 HTTP 节点。
   *
   * @param nodeId  当前节点 ID，用于把请求/响应日志归到具体节点
   * @param config  节点配置：url、method、headers、params、bodyType、body、formData、timeout
   * @param context 执行上下文，提供变量表用于解析 URL/请求体中的占位符
   * @param logger  执行日志器，记录 httpRequest / httpResponse 事件
   * @returns 始终 success: true，响应结果放在 outputs 中
   */
  protected async doExecute(
    nodeId: string,
    config: HttpNodeConfig,
    context: ExecutionContext,
    logger: ExecutionLogger
  ): Promise<NodeExecutionResult> {
    // 解析配置中的变量
    // 深度遍历 config，把 `${nodeId.field}` 替换成运行时真实值，
    // 返回的是新的 config 对象，不会污染原始工作流定义。
    const resolvedConfig = this.resolveConfigVariables(config, context, logger)

    // 构建 URL（带 query 参数）
    // params 是「键值对数组」而不是对象，因此可以保留重复 key（如 a=1&a=2）。
    // key 为空的条目会被跳过，避免生成 `=value` 这种非法参数。
    let url = resolvedConfig.url
    if (resolvedConfig.params && resolvedConfig.params.length > 0) {
      const searchParams = new URLSearchParams()
      for (const param of resolvedConfig.params) {
        if (param.key) {
          searchParams.append(param.key, param.value)
        }
      }
      const queryString = searchParams.toString()
      if (queryString) {
        // URL 里已经有 `?` 时用 `&` 续接，否则用 `?` 开头
        url += (url.includes('?') ? '&' : '?') + queryString
      }
    }

    // 构建请求头
    // 数组转对象：同名 header 后出现的会覆盖先出现的。
    const headers: Record<string, string> = {}
    for (const header of resolvedConfig.headers || []) {
      if (header.key) {
        headers[header.key] = header.value
      }
    }

    // 构建请求体
    // 只有非 GET / 非 DELETE 才构造 body；即使配置里写了 body，
    // GET/DELETE 也不会发送（这两个方法通常不带请求体）。
    let body: string | undefined
    if (resolvedConfig.method !== 'GET' && resolvedConfig.method !== 'DELETE') {
      switch (resolvedConfig.bodyType) {
        case 'json':
          // body 已经是 JSON 字符串文本，直接原样发送；
          // 这里不做 JSON.stringify（因为 body 本身就是字符串）
          headers['Content-Type'] = 'application/json'
          body = resolvedConfig.body
          break
        case 'form-data': {
          // 对于 form-data，使用 multipart/form-data
          // 简化实现：转换为 JSON
          // 注意：这不是真正的 multipart 表单 —— 不会生成 boundary、无法上传文件，
          // 而是把键值对序列化为 JSON 并声明 Content-Type: application/json。
          // 对接要求严格 multipart 的接口时需要改写这里。
          const formData: Record<string, string> = {}
          for (const item of resolvedConfig.formData || []) {
            if (item.key) {
              formData[item.key] = item.value
            }
          }
          headers['Content-Type'] = 'application/json'
          body = JSON.stringify(formData)
          break
        }
        case 'x-www-form-urlencoded': {
          // 标准表单编码：key=value&key2=value2，URLSearchParams 会自动做 URL 编码
          headers['Content-Type'] = 'application/x-www-form-urlencoded'
          const urlEncoded = new URLSearchParams()
          for (const item of resolvedConfig.formData || []) {
            if (item.key) {
              urlEncoded.append(item.key, item.value)
            }
          }
          body = urlEncoded.toString()
          break
        }
        case 'raw':
          // 原始文本：完全按用户填写的内容发送，不设置 Content-Type，
          // 需要什么类型由用户在 headers 里自行声明
          body = resolvedConfig.body
          break
        case 'none':
        default:
          // 不发送请求体
          break
      }
    }

    // 记录请求
    // 此时 url 已含 query、body 已序列化、headers 已补齐 Content-Type，
    // 日志里看到的就是真正发出去的内容（注意可能包含敏感信息）。
    logger.httpRequest(nodeId, {
      method: resolvedConfig.method,
      url,
      headers,
      body,
    })

    // 计时起点在请求日志之后：duration 只统计网络往返，不含配置解析与日志开销
    const startTime = Date.now()

    try {
      // 发起请求；AbortSignal.timeout 在到达超时时间后自动中断请求并抛错，
      // 默认超时 30 秒（配置为 0 或未配置时也走 30000）
      const response = await fetch(url, {
        method: resolvedConfig.method,
        headers,
        body,
        signal: AbortSignal.timeout(resolvedConfig.timeout || 30000),
      })

      const duration = Date.now() - startTime

      // 解析响应
      // 判断依据是响应头 content-type 是否包含 'application/json' 子串：
      //   - application/json; charset=utf-8 -> 按 JSON 解析
      //   - text/plain、text/html、空值     -> 按纯文本读取
      //   - application/problem+json 这类子类型不包含该子串，也会落到文本分支
      let data: unknown
      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        data = await response.json()
      } else {
        data = await response.text()
      }

      // 收集响应头
      // Headers 遍历时 key 已被规范化为小写，且同名头会被合并成逗号分隔的字符串
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })

      // 记录响应（含状态码、响应头、解析后的数据、耗时）
      logger.httpResponse(nodeId, {
        status: response.status,
        headers: responseHeaders,
        data,
        duration,
      })

      // response.ok 表示状态码在 200-299 之间。
      // 非 2xx 时依然返回 success: true（节点本身执行成功），
      // 只把 outputs.success 置为 false 并给出 `HTTP 4xx/5xx` 的错误描述。
      return {
        success: true,
        outputs: {
          data,
          status: response.status,
          headers: responseHeaders,
          success: response.ok,
          error: response.ok ? null : `HTTP ${response.status}`,
        },
        duration,
      }
    } catch (error) {
      // 能到这里的典型情况：DNS 解析失败、连接被拒、超时中断、TLS 错误、
      // 以及响应体按 JSON 解析失败（content-type 撒谎时）
      const duration = Date.now() - startTime
      const errorMessage = error instanceof Error ? error.message : String(error)

      // 失败也记一条响应日志，但 status 只能是 0、headers/data 为空，
      // 真正的错误原因只保留在 outputs.error 里（日志中看不到）
      logger.httpResponse(nodeId, {
        status: 0,
        headers: {},
        data: null,
        duration,
      })

      // HTTP 错误不算执行失败，错误信息在 outputs 中
      // 这样下游可以继续执行，并通过条件节点判断 ${http节点.success} 走不同分支
      return {
        success: true,
        outputs: {
          data: null,
          status: 0,
          headers: {},
          success: false,
          error: errorMessage,
        },
        duration,
      }
    }
  }

  /**
   * 校验 HTTP 节点配置（保存工作流时调用，不发起真实请求）。
   *
   * 只检查两个最基本的前提：url 与 method 必须存在。
   * 不校验 URL 格式、method 取值是否合法、timeout 是否为正数，
   * 这些错误会在真正发请求时暴露。
   *
   * @returns valid 表示是否合法；errors 仅在存在错误时返回
   */
  override validate(config: HttpNodeConfig): { valid: boolean; errors?: string[] } {
    const errors: string[] = []

    if (!config.url) {
      errors.push('URL is required')
    }

    if (!config.method) {
      errors.push('HTTP method is required')
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    }
  }

  /**
   * 声明本节点的输出变量结构，供前端变量选择器展示可引用的字段。
   *
   * 与 doExecute 的 outputs 一一对应：
   *   data    响应体（JSON 已解析为对象/数组，文本则为字符串）
   *   status  HTTP 状态码；请求未发出去（异常）时为 0
   *   headers 响应头（key 均为小写）
   *   success 是否 2xx
   *   error   失败描述；成功时为 null（schema 上仍标为 string）
   */
  override getOutputSchema(): OutputVariableSchema[] {
    return [
      { name: 'data', type: 'any', description: 'HTTP 响应的 body 数据' },
      { name: 'status', type: 'number', description: 'HTTP 响应状态码' },
      { name: 'headers', type: 'object', description: 'HTTP 响应头' },
      { name: 'success', type: 'boolean', description: '请求是否成功（2xx 状态码）' },
      { name: 'error', type: 'string', description: '请求失败时的错误信息' },
    ]
  }
}
