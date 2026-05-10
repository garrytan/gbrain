/**
 * Lightweight demo server — proxies GBrain MCP calls and serves the UI.
 * Keeps GBRAIN_TOKEN and ANTHROPIC_API_KEY server-side (never exposed to browser).
 */

import Anthropic from '@anthropic-ai/sdk';

const GBRAIN_URL = process.env.GBRAIN_URL ?? 'http://localhost:3131';
const GBRAIN_TOKEN = process.env.GBRAIN_TOKEN ?? '';
const PORT = Number(process.env.PORT ?? 8080);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── GBrain MCP helper ─────────────────────────────────────────────────────────

async function gbrain(tool: string, args: Record<string, unknown>) {
  const res = await fetch(`${GBRAIN_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(GBRAIN_TOKEN ? { Authorization: `Bearer ${GBRAIN_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  const json = await res.json() as { result?: { content?: Array<{ text: string }> }, error?: unknown };
  if (json.error) throw new Error(JSON.stringify(json.error));
  const text = json.result?.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return text; }
}

// ── Learning memory helpers ───────────────────────────────────────────────────

async function loadChildMemory(childId: string): Promise<string> {
  try {
    const results = await gbrain('query', {
      query: `What topics has ${childId} been curious about? What did they learn? What excited them?`,
      limit: 5,
    }) as Array<{ title?: string; slug?: string; content?: string }>;

    if (!Array.isArray(results) || results.length === 0) return '';

    return results
      .map((r) => `- ${r.title ?? r.slug}: ${(r.content ?? '').slice(0, 200)}`)
      .join('\n');
  } catch {
    return '';
  }
}

async function saveSessionToMemory(childId: string, sessionSummary: {
  topics: string[];
  engagement: string;
  breakthrough?: string;
  struggled_with?: string;
  raw_summary: string;
}) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = `children/${childId}/sessions/${date}-${Date.now()}`;
  await gbrain('put_page', {
    slug,
    title: `${childId} — Learning Session ${date}`,
    content: sessionSummary.raw_summary,
    frontmatter: {
      child_id: childId,
      date,
      topics: sessionSummary.topics,
      engagement: sessionSummary.engagement,
      ...(sessionSummary.breakthrough ? { breakthrough: sessionSummary.breakthrough } : {}),
      ...(sessionSummary.struggled_with ? { struggled_with: sessionSummary.struggled_with } : {}),
      session_type: 'learning',
    },
  });
  return slug;
}

// ── Claude agent with GBrain memory ──────────────────────────────────────────

async function chatWithMemory(
  childId: string,
  userMessage: string,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
  isFirstMessage: boolean,
): Promise<{ reply: string; sessionSummary?: string }> {
  let memoryContext = '';

  if (isFirstMessage) {
    memoryContext = await loadChildMemory(childId);
  }

  const systemPrompt = memoryContext
    ? `You are Flute, a friendly AI tutor for young children (ages 4-10). You speak simply, warmly, and with lots of curiosity and excitement.

${memoryContext ? `IMPORTANT: Here is what you already know about this child from past sessions:\n${memoryContext}\n\nUse this to personalize your greeting and continue their learning journey.` : ''}

Keep responses short (2-4 sentences max). Ask one follow-up question. Use simple words. Be encouraging.`
    : `You are Flute, a friendly AI tutor for young children (ages 4-10). You speak simply, warmly, and with lots of curiosity and excitement.

This is the first time you're meeting this child. Start with a warm greeting and ask what they want to explore today.

Keep responses short (2-4 sentences max). Ask one follow-up question. Use simple words. Be encouraging.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: systemPrompt,
    messages: [
      ...conversationHistory,
      { role: 'user', content: userMessage },
    ],
  });

  const reply = response.content[0].type === 'text' ? response.content[0].text : '';
  return { reply };
}

async function summarizeSession(
  conversationHistory: Array<{ role: string; content: string }>,
): Promise<{
  topics: string[];
  engagement: string;
  breakthrough?: string;
  struggled_with?: string;
  raw_summary: string;
}> {
  const transcript = conversationHistory
    .map((m) => `${m.role === 'user' ? 'Child' : 'Flute'}: ${m.content}`)
    .join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: 'You extract structured learning data from a child tutoring session transcript. Respond with valid JSON only.',
    messages: [{
      role: 'user',
      content: `Extract learning data from this session transcript and return JSON:
{
  "topics": ["list", "of", "topics", "discussed"],
  "engagement": "low|medium|high",
  "breakthrough": "one sentence about what the child understood well (or null)",
  "struggled_with": "one sentence about what was hard (or null)",
  "raw_summary": "2-3 sentence plain English summary of the session"
}

Transcript:
${transcript}`,
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
  try {
    return JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());
  } catch {
    return {
      topics: [],
      engagement: 'medium',
      raw_summary: transcript.slice(0, 500),
    };
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Serve static UI
    if (path === '/' || path === '/index.html') {
      const html = await Bun.file(`${import.meta.dir}/index.html`).text();
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    }

    // API: chat
    if (path === '/api/chat' && req.method === 'POST') {
      const body = await req.json() as {
        childId: string;
        message: string;
        history: Array<{ role: 'user' | 'assistant'; content: string }>;
      };

      const isFirstMessage = body.history.length === 0;
      const { reply } = await chatWithMemory(
        body.childId,
        body.message,
        body.history,
        isFirstMessage,
      );

      return Response.json({ reply });
    }

    // API: save session to GBrain memory
    if (path === '/api/save-session' && req.method === 'POST') {
      const body = await req.json() as {
        childId: string;
        history: Array<{ role: string; content: string }>;
      };

      if (body.history.length < 2) {
        return Response.json({ ok: false, reason: 'Session too short to save' });
      }

      const summary = await summarizeSession(body.history);
      const slug = await saveSessionToMemory(body.childId, summary);

      return Response.json({ ok: true, slug, summary });
    }

    // API: get child's learning history (for parent view)
    if (path === '/api/child-memory' && req.method === 'GET') {
      const childId = url.searchParams.get('childId') ?? 'zoe';
      const memory = await loadChildMemory(childId);
      return Response.json({ memory, childId });
    }

    return new Response('Not found', { status: 404 });
  },
});

console.log(`\nGBrain Demo Server running at http://localhost:${server.port}`);
console.log(`GBrain backend: ${GBRAIN_URL}`);
console.log(`Auth: ${GBRAIN_TOKEN ? 'token set' : 'no token (local mode)'}\n`);
