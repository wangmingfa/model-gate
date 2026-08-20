// 本地 mock 上游：OpenAI 兼容 /v1/chat/completions（含流式），用于无真实 key 时自测网关
// 用法: bun scripts/mock-upstream.ts [端口，默认 9999]（argv[0]=bun, argv[1]=脚本, 第一个参数是 argv[2]）
const PORT = Number(process.argv[2] ?? 9999);
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = (await req.json()) as { stream?: boolean; model?: string };
      if (body.stream === true) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"id":"mock","object":"chat.completion.chunk","model":"mock-model","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'),
            );
            controller.enqueue(
              encoder.encode('data: {"id":"mock","object":"chat.completion.chunk","model":"mock-model","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n'),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return Response.json(
        {
          id: "mock",
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        },
        { status: 200 },
      );
    }
    return Response.json({ error: { message: "not found" } }, { status: 404 });
  },
});
console.log(`[mock-upstream] listening on :${PORT}`);
