import { describe, expect, test } from "bun:test"
import {
  FusionRouter,
  MODEL_ID,
  PROVIDER_ID,
  buildUpstreamRequest,
  createStableSseStream,
  extractPrompt,
  modelInfo,
  normalizeSseFrame,
  prepareResponsesBody,
  providerInfo,
  routeKey,
  stableEvent,
  upsertProvider,
  type FetchImpl,
  type FusionRoute,
  type IdSlot,
  type ModelInfo,
  type ProviderEditor,
  type ProviderInfo,
} from "../src/fusion"

const route = (model = "selected-model", expires = 2_000): FusionRoute => ({
  session_token: "session-token",
  selected_model: { id: model, supported_endpoints: ["/responses"] },
  expires_at: expires,
})

const router = (fetchImpl: FetchImpl, now = () => 1_000) =>
  new FusionRouter({ token: "oauth-token", fetchImpl, now, timeoutMs: 1_000 })

describe("Fusion routing", () => {
  test("sends an intelligence anchor and caches by session and prompt", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const instance = router(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify(route()))
    })
    const first = await instance.route("session-a", "Build app")
    const second = await instance.route("session-a", "Build app")
    await instance.route("session-a", "New prompt")
    await instance.route("session-b", "Build app")

    expect(first).toEqual(second)
    expect(calls).toHaveLength(3)
    expect(calls[0].url).toBe("https://api.githubcopilot.com/auto")
    expect(calls[0].init.body).toBe(JSON.stringify({
      prompt: "Build app",
      has_image: false,
      multi_turn: { routing_intent: "anchor", turns_since_anchor: 0 },
      tier: "intelligence",
      hydra_rl_multi_turn: {},
      fusion: true,
    }))
    expect(calls[0].init.headers).toEqual({
      Authorization: "Bearer oauth-token",
      "Content-Type": "application/json",
      Accept: "application/json",
      "Copilot-Integration-Id": "copilot-developer-cli",
      "User-Agent": "opencode-copilot-fusion/0.1",
      "X-GitHub-Api-Version": "2026-08-01",
      "OpenAI-Intent": "conversation-agent",
      "X-Initiator": "user",
      "X-Interaction-Id": "session-a",
      "X-Client-Session-Id": "session-a",
    })
  })

  test("rejects fallback, GPT-4.1, unsupported endpoints and expiry", async () => {
    for (const value of [
      { ...route("fallback-model"), fallback: true },
      route("gpt-4.1"),
      { ...route(), selected_model: { id: "selected-model", supported_endpoints: ["/chat/completions"] } },
      route("selected-model", 1_020),
    ]) {
      const instance = router(async () => new Response(JSON.stringify(value)))
      await expect(instance.route("session", "hi")).rejects.toThrow()
    }
  })

  test("rejects malformed and failed routing responses", async () => {
    for (const response of [
      new Response("not-json", { status: 200 }),
      new Response(JSON.stringify({ selected_model: { id: "m" } })),
      new Response("upstream-secret", { status: 403 }),
    ]) {
      const instance = router(async () => response)
      await expect(instance.route("session", "hi")).rejects.toThrow()
    }
  })

  test("computes a stable route key", () => {
    expect(routeKey("a", "hi")).toBe(routeKey("a", "hi"))
    expect(routeKey("a", "hi")).not.toBe(routeKey("b", "hi"))
  })
})

describe("request preparation", () => {
  test("extracts the latest user text and ignores tool output", () => {
    expect(extractPrompt({ input: [{ role: "user", content: [{ type: "input_text", text: "first" }] },
      { type: "function_call_output", output: "written" }] })).toBe("first")
    expect(extractPrompt({ input: "plain" })).toBe("plain")
    expect(() => extractPrompt({ input: [{ role: "user", content: [{ type: "input_image" }] }] })).toThrow()
  })

  test("preserves tools and adds encrypted reasoning", () => {
    const tools = [{ type: "function", name: "write" }]
    const prepared = prepareResponsesBody({ model: "fusion", input: "hi", tools, include: [] }, route())
    expect(prepared.model).toBe("selected-model")
    expect(prepared.store).toBe(false)
    expect(prepared.tools).toEqual(tools)
    expect(prepared.include).toEqual(["reasoning.encrypted_content"])
  })

  test("rewrites the request to /responses and retains OpenCode headers", () => {
    const original = new Request("https://api.githubcopilot.com/responses", {
      method: "POST",
      headers: { authorization: "Bearer placeholder", "x-opencode-session-id": "oc-session" },
      body: "{}",
    })
    const request = buildUpstreamRequest(original, { model: "selected-model" }, route(), "oauth-token",
      "https://api.githubcopilot.com", "oc-session", true)
    expect(request.url).toBe("https://api.githubcopilot.com/responses")
    expect(request.headers.get("authorization")).toBe("Bearer oauth-token")
    expect(request.headers.get("copilot-session-token")).toBe("session-token")
    expect(request.headers.get("x-initiator")).toBe("agent")
    expect(request.headers.get("x-opencode-session-id")).toBe("oc-session")
  })
})

describe("stream normalization", () => {
  test("uses the first ID for each output slot", () => {
    const slots = new Map<number, IdSlot>()
    const frames = [
      { output_index: 0, item: { id: "one", call_id: "call-1" } },
      { output_index: 0, item_id: "two" },
      { output_index: 0, item: { id: "three" } },
      { response: { output: [{ id: "four", call_id: "call-1" }] } },
    ]
    const values = frames.map((event) => stableEvent(structuredClone(event), slots))
    expect(values[0]).toMatchObject({ item: { id: "one" } })
    expect(values[1]).toMatchObject({ item_id: "one" })
    expect(values[2]).toMatchObject({ item: { id: "one" } })
    expect(values[3]).toMatchObject({ response: { output: [{ id: "one" }] } })
  })

  test("keeps SSE framing and non-data fields", () => {
    const slots = new Map<number, IdSlot>()
    const frame = ["event: response.output_item.added", 'data: {"output_index":0,"item":{"id":"one"}}']
    expect(normalizeSseFrame(frame, slots)).toContain("event: response.output_item.added")
    expect(normalizeSseFrame(["data: [DONE]"], slots)).toBe("data: [DONE]")
  })

  test("normalizes SSE across arbitrary chunk boundaries", async () => {
    const wire = [
      'event: response.output_item.added\ndata: {"output_index":0,"item":{"id":"one"}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"output_index":0,"item_id":"two","delta":"{}"}\n\n',
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"id":"three"}}\n\n',
      'data: [DONE]\n\n',
    ].join("")
    const bytes = new TextEncoder().encode(wire)
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 17))
        controller.enqueue(bytes.slice(17, 91))
        controller.enqueue(bytes.slice(91))
        controller.close()
      },
    })
    const output = await new Response(createStableSseStream(source)).text()
    expect(output).toContain('"item_id":"one"')
    expect(output).toContain('"id":"one"')
    expect(output).toContain("data: [DONE]")
  })
})

describe("provider registration", () => {
  test("adds a tools-capable Responses model", () => {
    const added: Array<{ info: ProviderInfo; models: readonly ModelInfo[] }> = []
    const editor: ProviderEditor = {
      get: () => undefined,
      add: (value) => added.push(value),
      update: () => {},
      models: { set: () => {} },
    }
    upsertProvider(editor)
    expect(added).toHaveLength(1)
    expect(added[0].info).toEqual(providerInfo())
    expect(added[0].models[0]).toEqual(modelInfo())
    expect(added[0].models[0].capabilities.tools).toBe(true)
    expect(added[0].models[0].id).toBe(MODEL_ID)
    expect(added[0].info.id).toBe(PROVIDER_ID)
  })
})
