import React, { useEffect, useMemo, useRef, useState } from "react";

type StreamEvt =
  | { type: "meta"; requestId: string; model: string }
  | { type: "delta"; text: string }
  | { type: "usage"; usage: any }
  | { type: "error"; message: string }
  | { type: "done"; usage?: any };

type ChatMsg = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
};

function uid() {
  return crypto.randomUUID();
}

function formatUsage(u: any) {
  if (!u) return "";
  const total = u.total_tokens ?? u.total ?? null;
  const inp = u.input_tokens ?? u.input ?? null;
  const out = u.output_tokens ?? u.output ?? null;
  if (total == null && inp == null && out == null) return "";
  return `tokens: ${total ?? "-"} (in ${inp ?? "-"} / out ${out ?? "-"})`;
}

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("Ready");
  const [meta, setMeta] = useState<{ requestId?: string; model?: string }>({});
  const [usage, setUsage] = useState<any>(null);
  const [error, setError] = useState<string>("");

  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      id: uid(),
      role: "assistant",
      content:
        "你好！我已经接通了：Pages → Workers → OpenAI（NDJSON 流）。你可以开始问我任何问题～",
    },
  ]);

  const listRef = useRef<HTMLDivElement | null>(null);

  const canSend = useMemo(
    () => !busy && prompt.trim().length > 0,
    [busy, prompt]
  );

  useEffect(() => {
    // 自动滚动到底部
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, busy]);

  async function pingGraphql() {
    setError("");
    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ ping }" }),
      });
      const json = await res.json();
      setStatus(`GraphQL: ${json?.data?.ping ?? "?"}`);
      setTimeout(() => setStatus("Ready"), 1500);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }

  async function send() {
    if (!canSend) return;

    setBusy(true);
    setError("");
    setUsage(null);
    setMeta({});
    setStatus("Starting…");

    const userText = prompt.trim();
    setPrompt("");

    const userMsgId = uid();
    const assistantMsgId = uid();

    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: "user", content: userText },
      { id: assistantMsgId, role: "assistant", content: "" },
    ]);

    try {
      // 1) 先走 GraphQL：拿 requestId
      const gqlRes = await fetch("/api/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "mutation ($p: String!) { startChat(prompt: $p) }",
          variables: { p: userText },
        }),
      });
      const gqlJson = await gqlRes.json();
      const requestId = gqlJson?.data?.startChat;

      if (!requestId) {
        throw new Error("GraphQL startChat failed: " + JSON.stringify(gqlJson));
      }

      setMeta((m) => ({ ...m, requestId }));
      setStatus("Streaming…");

      // 2) 再 stream：NDJSON
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, prompt: userText }),
      });

      const ct = res.headers.get("content-type") || "";
      if (!res.ok || !res.body) {
        const t = await res.text();
        throw new Error(`HTTP ${res.status}: ${t}`);
      }
      if (!ct.includes("application/x-ndjson")) {
        // 不强制，但提示一下便于排错
        setStatus(`Streaming… (ct: ${ct})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;

          let evt: StreamEvt;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }

          if (evt.type === "meta") {
            setMeta({ requestId: evt.requestId, model: evt.model });
          } else if (evt.type === "delta") {
            const text = evt.text ?? "";
            if (!text) continue;

            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId ? { ...m, content: m.content + text } : m
              )
            );
          } else if (evt.type === "usage") {
            setUsage(evt.usage);
          } else if (evt.type === "error") {
            setError(evt.message || "Unknown error");
          } else if (evt.type === "done") {
            if (evt.usage) setUsage(evt.usage);
            setStatus("Done");
          }
        }
      }
    } catch (e: any) {
      setError(e?.message || String(e));
      setStatus("Error");
      // 给 assistant 消息补一个错误提示
      setMessages((prev) =>
        prev.map((m) =>
          m.role === "assistant" && m.content === ""
            ? { ...m, content: "（请求失败了，打开控制台看一下错误信息）" }
            : m
        )
      );
    } finally {
      setBusy(false);
      setTimeout(() => setStatus("Ready"), 1200);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(1200px 700px at 20% 10%, rgba(99,102,241,.18), transparent 60%), radial-gradient(900px 600px at 80% 0%, rgba(16,185,129,.14), transparent 55%), #0b1020",
        color: "#e7eaf2",
      }}
    >
      <div style={{ maxWidth: 1040, margin: "0 auto", padding: 24 }}>
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 16,
            alignItems: "center",
            marginBottom: 18,
          }}
        >
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 0.2 }}>
              Edge Chat
            </div>
            <div style={{ opacity: 0.75, marginTop: 4, fontSize: 13 }}>
              Pages → Workers → GraphQL → Stream（NDJSON）
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 14,
              background: "rgba(255,255,255,.06)",
              border: "1px solid rgba(255,255,255,.10)",
              boxShadow: "0 10px 30px rgba(0,0,0,.25)",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                display: "inline-block",
                background:
                  status === "Error"
                    ? "#ef4444"
                    : busy
                    ? "#f59e0b"
                    : "#22c55e",
                boxShadow:
                  status === "Error"
                    ? "0 0 0 3px rgba(239,68,68,.18)"
                    : busy
                    ? "0 0 0 3px rgba(245,158,11,.18)"
                    : "0 0 0 3px rgba(34,197,94,.16)",
              }}
            />
            <div style={{ fontSize: 13, opacity: 0.9 }}>
              <div style={{ fontWeight: 600 }}>{status}</div>
              <div style={{ opacity: 0.75, fontSize: 12 }}>
                {meta.model ? `model: ${meta.model}` : "model: -"}
                {" • "}
                {meta.requestId ? `req: ${meta.requestId.slice(0, 8)}…` : "req: -"}
              </div>
            </div>

            <button
              onClick={pingGraphql}
              style={{
                marginLeft: 8,
                padding: "8px 10px",
                borderRadius: 12,
                background: "rgba(255,255,255,.08)",
                border: "1px solid rgba(255,255,255,.12)",
                color: "#e7eaf2",
                cursor: "pointer",
                fontSize: 12,
              }}
              title="Ping /api/graphql"
            >
              ping
            </button>
          </div>
        </div>

        {/* Main card */}
        <div
          style={{
            borderRadius: 22,
            background: "rgba(255,255,255,.06)",
            border: "1px solid rgba(255,255,255,.10)",
            boxShadow: "0 18px 60px rgba(0,0,0,.35)",
            overflow: "hidden",
          }}
        >
          {/* Chat body */}
          <div
            ref={listRef}
            style={{
              height: "min(68vh, 720px)",
              overflow: "auto",
              padding: 18,
            }}
          >
            {messages.map((m) => {
              const isUser = m.role === "user";
              return (
                <div
                  key={m.id}
                  style={{
                    display: "flex",
                    justifyContent: isUser ? "flex-end" : "flex-start",
                    margin: "10px 0",
                  }}
                >
                  <div
                    style={{
                      maxWidth: "82%",
                      padding: "12px 14px",
                      borderRadius: 18,
                      lineHeight: 1.45,
                      fontSize: 14,
                      whiteSpace: "pre-wrap",
                      background: isUser
                        ? "linear-gradient(135deg, rgba(99,102,241,.95), rgba(59,130,246,.80))"
                        : "rgba(255,255,255,.08)",
                      border: isUser
                        ? "1px solid rgba(255,255,255,.10)"
                        : "1px solid rgba(255,255,255,.12)",
                      boxShadow: isUser
                        ? "0 10px 30px rgba(59,130,246,.25)"
                        : "0 10px 28px rgba(0,0,0,.25)",
                    }}
                  >
                    {m.content || (m.role === "assistant" && busy ? "…" : "")}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div
            style={{
              padding: 16,
              borderTop: "1px solid rgba(255,255,255,.10)",
              background: "rgba(0,0,0,.16)",
            }}
          >
            {error ? (
              <div
                style={{
                  marginBottom: 10,
                  padding: "10px 12px",
                  borderRadius: 14,
                  background: "rgba(239,68,68,.14)",
                  border: "1px solid rgba(239,68,68,.25)",
                  color: "#fecaca",
                  fontSize: 13,
                  whiteSpace: "pre-wrap",
                }}
              >
                {error}
              </div>
            ) : null}

            {usage ? (
              <div style={{ marginBottom: 10, opacity: 0.8, fontSize: 12 }}>
                {formatUsage(usage)}
              </div>
            ) : (
              <div style={{ marginBottom: 10, opacity: 0.6, fontSize: 12 }}>
                Enter 发送 • Shift+Enter 换行（输入框内）
              </div>
            )}

            <div style={{ display: "flex", gap: 10 }}>
              <input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="输入消息，然后按 Enter 发送…"
                style={{
                  flex: 1,
                  padding: "12px 14px",
                  borderRadius: 16,
                  border: "1px solid rgba(255,255,255,.14)",
                  background: "rgba(255,255,255,.06)",
                  color: "#e7eaf2",
                  outline: "none",
                  fontSize: 14,
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,.06)",
                }}
              />

              <button
                onClick={send}
                disabled={!canSend}
                style={{
                  padding: "12px 14px",
                  borderRadius: 16,
                  border: "1px solid rgba(255,255,255,.14)",
                  background: canSend
                    ? "linear-gradient(135deg, rgba(16,185,129,.95), rgba(34,197,94,.85))"
                    : "rgba(255,255,255,.06)",
                  color: canSend ? "#04120c" : "rgba(231,234,242,.45)",
                  fontWeight: 700,
                  cursor: canSend ? "pointer" : "not-allowed",
                  minWidth: 110,
                  boxShadow: canSend ? "0 12px 34px rgba(34,197,94,.22)" : "none",
                }}
                title="Send"
              >
                {busy ? "生成中…" : "发送"}
              </button>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 14, opacity: 0.55, fontSize: 12 }}>
          小提示：如果你想做多会话/历史记录，就把 GraphQL 的 mutation 接到 D1（messages/conversations 表）。
        </div>
      </div>
    </div>
  );
}