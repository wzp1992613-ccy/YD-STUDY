import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLNonNull,
  graphql,
} from "graphql";

type Env = {
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
};

const QueryType = new GraphQLObjectType({
  name: "Query",
  fields: {
    ping: { type: new GraphQLNonNull(GraphQLString), resolve: () => "pong" },
  },
});

const MutationType = new GraphQLObjectType({
  name: "Mutation",
  fields: {
    startChat: {
      type: new GraphQLNonNull(GraphQLString),
      args: { prompt: { type: new GraphQLNonNull(GraphQLString) } },
      resolve: async () => crypto.randomUUID(),
    },
  },
});

const schema = new GraphQLSchema({ query: QueryType, mutation: MutationType });

function isGraphqlPath(p: string) {
  return p === "/api/graphql" || p === "/api/graphql/";
}
function isStreamPath(p: string) {
  return p === "/api/chat/stream" || p === "/api/chat/stream/";
}

async function readJsonBody(req: Request) {
  const ct = req.headers.get("content-type") || "";
  if (!ct.toLowerCase().includes("application/json")) {
    const text = await req.text().catch(() => "");
    throw new Error(`Expected application/json. Got "${ct}". Body: ${text.slice(0, 200)}`);
  }
  return await req.json();
}

async function handleGraphQL(req: Request) {
  const body = (await readJsonBody(req)) as any;
  const query = body?.query;
  if (typeof query !== "string" || !query.trim()) {
    return Response.json({ errors: [{ message: "Bad Request: missing GraphQL query" }] }, { status: 400 });
  }

  const result = await graphql({
    schema,
    source: query,
    variableValues: body?.variables,
    operationName: body?.operationName,
  });

  return Response.json(result, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

/* ---------- NDJSON stream helpers ---------- */
type StreamEvent =
  | { type: "meta"; requestId: string; model: string }
  | { type: "delta"; text: string }
  | { type: "usage"; usage: any }
  | { type: "error"; message: string }
  | { type: "done"; usage?: any };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function emit(controller: ReadableStreamDefaultController<Uint8Array>, evt: StreamEvent) {
  controller.enqueue(encoder.encode(JSON.stringify(evt) + "\n"));
}

function splitLines(chunk: string, carry: { buf: string }) {
  carry.buf += chunk;
  const parts = carry.buf.split("\n");
  carry.buf = parts.pop() ?? "";
  return parts;
}

function extractFinalTextFromCompleted(evt: any): string {
  const output = evt?.response?.output;
  const msg = Array.isArray(output) ? output.find((x: any) => x?.type === "message") : null;
  const content = msg?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "output_text" && typeof c?.text === "string")
    .map((c: any) => c.text)
    .join("");
}

/**
 * ✅ 关键：立刻 return Response(stream)
 * 在 stream.start 内部再 fetch OpenAI 并持续写入 stream，避免 “hang before response”
 */
async function handleChatStream(req: Request, env: Env) {
  if (!env.OPENAI_API_KEY) return new Response("Missing OPENAI_API_KEY", { status: 500 });

  const body = (await readJsonBody(req).catch(() => ({}))) as any;
  const prompt = (body?.prompt ?? "").toString();
  const requestId = (body?.requestId ?? "").toString() || crypto.randomUUID();
  const model = env.OPENAI_MODEL || "gpt-4.1-mini";

  if (!prompt.trim()) return new Response("Bad Request: missing prompt", { status: 400 });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // 立刻发 meta，保证请求“立刻产生响应”
      emit(controller, { type: "meta", requestId, model });

      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort("upstream_timeout"), 60_000);

      let sawAnyText = false;
      let finalUsage: any = undefined;
      const carry = { buf: "" };

      try {
        const upstream = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          signal: abort.signal,
          headers: {
            authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model, input: prompt, stream: true }),
        });

        if (!upstream.ok) {
          const t = await upstream.text();
          emit(controller, { type: "error", message: `OpenAI error: ${upstream.status} ${t}` });
          emit(controller, { type: "done" });
          controller.close();
          return;
        }

        if (!upstream.body) {
          emit(controller, { type: "error", message: "Upstream body is null" });
          emit(controller, { type: "done" });
          controller.close();
          return;
        }

        const reader = upstream.body.getReader();

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          const text = decoder.decode(value, { stream: true });
          const lines = splitLines(text, carry);

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;

            try {
              const evt = JSON.parse(data);

              if (evt?.type === "response.output_text.delta" && typeof evt.delta === "string") {
                if (evt.delta) {
                  sawAnyText = true;
                  emit(controller, { type: "delta", text: evt.delta });
                }
                continue;
              }

              if (evt?.type === "response.completed") {
                finalUsage = evt?.response?.usage;
                if (finalUsage) emit(controller, { type: "usage", usage: finalUsage });

                if (!sawAnyText) {
                  const finalText = extractFinalTextFromCompleted(evt);
                  if (finalText) {
                    sawAnyText = true;
                    emit(controller, { type: "delta", text: finalText });
                  }
                }
                continue;
              }
            } catch (e: any) {
              emit(controller, { type: "error", message: `Bad upstream JSON: ${String(e)}` });
            }
          }
        }

        // ✅ 处理最后残留（避免“尾巴没换行导致丢消息”）
        if (carry.buf.trim()) {
          try {
            const line = carry.buf.trim();
            if (line.startsWith("data:")) {
              const data = line.slice(5).trim();
              if (data && data !== "[DONE]") {
                const evt = JSON.parse(data);
                if (evt?.type === "response.completed") {
                  finalUsage = evt?.response?.usage;
                  if (finalUsage) emit(controller, { type: "usage", usage: finalUsage });
                  if (!sawAnyText) {
                    const finalText = extractFinalTextFromCompleted(evt);
                    if (finalText) emit(controller, { type: "delta", text: finalText });
                  }
                }
              }
            }
          } catch {}
        }

        emit(controller, { type: "done", usage: finalUsage });
        controller.close();
      } catch (e: any) {
        emit(controller, { type: "error", message: `Upstream exception: ${e?.message || String(e)}` });
        emit(controller, { type: "done" });
        controller.close();
      } finally {
        clearTimeout(timeout);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/* ---------- Router ---------- */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
        },
      });
    }

    if (req.method === "POST" && isGraphqlPath(url.pathname)) {
      try {
        return await handleGraphQL(req);
      } catch (err: any) {
        return Response.json({ errors: [{ message: err?.message || String(err) }] }, { status: 500 });
      }
    }

    if (req.method === "POST" && isStreamPath(url.pathname)) {
      return handleChatStream(req, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};