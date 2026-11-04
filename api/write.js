// Serverless function: turns rough notes into a bilingual Slack update via free LLMs (Groq → OpenRouter → Gemini).
const hits = new Map(); // simple per-instance rate limit
const LIMIT = 10, WINDOW_MS = 60_000;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || "anon";
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) return res.status(429).json({ error: "Too many requests" });
  recent.push(now); hits.set(ip, recent);

  const { notes = "", tone = "casual", emoji = "some" } = req.body || {};
  const text = String(notes).trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: "Notes are empty" });

  const providers = buildProviders();
  if (!providers.length) return res.status(500).json({ error: "Server has no AI provider key" });

  const toneTxt = {
    casual: "casual and friendly, like a colleague you like",
    funny: "light and witty with one small joke, still professional",
    neutral: "clear and neutral, professional",
  }[tone] || "casual and friendly";
  const emojiTxt = emoji === "none" ? "Use no emoji." : "Use 1-3 fitting emoji.";

  const prompt = `You turn a software developer's rough notes into a short Slack message for their German-speaking team.
Tone: ${toneTxt}. ${emojiTxt}
Rules: keep every fact from the notes (PR numbers, times, names) and invent nothing. Use Slack formatting: *bold* sparingly, "• " bullets when there are 3+ items. Max ~90 words per language. German must be natural, idiomatic, informal "ihr/euch" (not a literal translation). English must be natural too.
Return ONLY JSON: {"de":"German message","en":"English message"}

Notes:
"""${text}"""`;

  try {
    const { out, rateLimited } = await callWithFallback(providers, prompt);
    if (!out) return res.status(rateLimited ? 429 : 502).json({ error: rateLimited ? "Model rate limit" : "Model request failed" });
    return res.status(200).json({ de: String(out.de || ""), en: String(out.en || "") });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Could not write the update" });
  }
}

// Providers in order: Groq (fast) → OpenRouter free → Gemini (last resort).
// Each attempt: 429 = quota used → next provider; 5xx / network / bad JSON → retry once, then next.
const RETRIES = 1, DEADLINE_MS = 20_000, CALL_MS = 9_000, RETRY_STATUS = new Set([500, 502, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function openAI(name, url, key, model, extraHeaders = {}) {
  return {
    name: `${name}:${model}`,
    request: prompt => [url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...extraHeaders },
      body: JSON.stringify({
        model, temperature: 0.7, response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
    }],
    text: d => d?.choices?.[0]?.message?.content || "",
  };
}

function buildProviders() {
  const e = process.env, list = [];
  if (e.GROQ_API_KEY) {
    for (const m of (e.GROQ_MODELS || "openai/gpt-oss-120b,openai/gpt-oss-20b").split(","))
      list.push(openAI("groq", "https://api.groq.com/openai/v1/chat/completions", e.GROQ_API_KEY, m.trim()));
  }
  if (e.OPENROUTER_API_KEY) {
    for (const m of (e.OPENROUTER_MODELS || "openrouter/free").split(","))
      list.push(openAI("openrouter", "https://openrouter.ai/api/v1/chat/completions", e.OPENROUTER_API_KEY, m.trim(),
        { "HTTP-Referer": "https://zweisprachig.vercel.app", "X-Title": "Zweisprachig" }));
  }
  if (e.GEMINI_API_KEY) {
    const m = e.GEMINI_MODEL || "gemini-flash-latest";
    list.push({
      name: `gemini:${m}`,
      request: prompt => [`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": e.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json", temperature: 0.7,
            responseSchema: { type: "OBJECT", properties: { de: { type: "STRING" }, en: { type: "STRING" } }, required: ["de", "en"] },
          },
        }),
      }],
      text: d => d?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "",
    });
  }
  return list;
}

function parse(raw) {
  const m = String(raw).replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
  const out = JSON.parse(m ? m[0] : raw);
  if (!out.de && !out.en) throw new Error("empty output");
  return out;
}

async function callWithFallback(providers, prompt) {
  const end = Date.now() + DEADLINE_MS;
  let rateLimited = false;
  for (const p of providers) {
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      const left = end - Date.now();
      if (left < 1500) return { out: null, rateLimited };
      try {
        const [url, init] = p.request(prompt);
        const r = await fetch(url, { ...init, signal: AbortSignal.timeout(Math.min(CALL_MS, left)) });
        if (r.ok) {
          try { const out = parse(p.text(await r.json())); console.log("served by", p.name); return { out }; }
          catch (e) { console.error("Bad model output", p.name, e.message); }
        } else {
          console.error("Model error", p.name, r.status, (await r.text()).slice(0, 200));
          if (r.status === 429) { rateLimited = true; break; }
          if (!RETRY_STATUS.has(r.status)) break;
        }
      } catch (e) {
        console.error("Model fetch failed", p.name, e.name);
      }
      if (attempt < RETRIES) await sleep(300 + Math.random() * 300);
    }
  }
  return { out: null, rateLimited };
}
