/**
 * Minimal raw-fetch client for DeepSeek's OpenAI-compatible Chat Completions
 * API, ported from wazoo-memorybench's proven `src/utils/deepseek-client.ts`.
 *
 * Raw fetch instead of the AI SDK because DeepSeek-specific top-level body
 * params (notably `thinking`) are stripped by the SDK's OpenAI provider.
 * A missing DEEPSEEK_API_KEY fails fast: silently borrowing another key is
 * how runs leak into the wrong provider. Inside the benchmark sandbox the
 * only allowed host is the memory model's API host, which is exactly this
 * client's base URL — nothing else here touches the network.
 */

export interface DeepSeekChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface DeepSeekChatOptions {
  model: string
  prompt?: string
  messages?: DeepSeekChatMessage[]
  maxTokens?: number
  temperature?: number
  responseFormat?: "json_object"
  /** DeepSeek reasoning models: `thinking` must go top-level, not in a nested provider options object. */
  thinking?: "enabled" | "disabled"
  signal?: AbortSignal
}

export interface DeepSeekChatResult {
  text: string
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
}

export class DeepSeekClient {
  readonly apiKey: string
  readonly baseUrl: string

  constructor(opts?: { apiKey?: string; baseUrl?: string }) {
    this.apiKey = opts?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? ""
    if (!this.apiKey) {
      throw new Error(
        "DEEPSEEK_API_KEY is not set — refusing to borrow OPENAI_API_KEY. " +
          "Set DEEPSEEK_API_KEY (and DEEPSEEK_BASE_URL if not using api.deepseek.com)."
      )
    }
    this.baseUrl = (
      opts?.baseUrl ??
      process.env.DEEPSEEK_BASE_URL ??
      "https://api.deepseek.com"
    ).replace(/\/$/, "")
  }

  async chatCompletion(opts: DeepSeekChatOptions): Promise<DeepSeekChatResult> {
    const messages: DeepSeekChatMessage[] =
      opts.messages ?? (opts.prompt !== undefined ? [{ role: "user", content: opts.prompt }] : [])
    if (messages.length === 0) {
      throw new Error("DeepSeek chat completion requires either prompt or messages")
    }

    const body: Record<string, unknown> = {
      model: opts.model,
      messages,
      stream: false,
    }
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens
    if (opts.temperature !== undefined) body.temperature = opts.temperature
    if (opts.responseFormat === "json_object") body.response_format = { type: "json_object" }
    body.thinking = { type: opts.thinking ?? "disabled" }

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    })

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "")
      throw new Error(`DeepSeek API error ${resp.status}: ${detail.slice(0, 300)}`)
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    }
    const text = data.choices?.[0]?.message?.content ?? ""
    return {
      text,
      usage: data.usage && {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
    }
  }
}

/** Retry with exponential backoff + jitter; bounded, never unbounded. */
export async function withRetries<T>(
  fn: () => Promise<T>,
  opts?: { maxRetries?: number; baseDelayMs?: number; signal?: AbortSignal }
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 4
  const baseDelayMs = opts?.baseDelayMs ?? 2000
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const jitter = Math.random() * baseDelayMs * 0.25
      const delay = baseDelayMs * 2 ** (attempt - 1) + jitter
      await new Promise((resolve) => setTimeout(resolve, delay))
      if (opts?.signal?.aborted) throw new Error("Aborted while retrying")
    }
    try {
      return await fn()
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
