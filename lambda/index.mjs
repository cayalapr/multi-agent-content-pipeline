// Content Pipeline API — single Lambda, Function URL, DynamoDB, Anthropic API
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.TABLE_NAME || "content-pipeline";
const MODEL = process.env.MODEL || "claude-sonnet-4-5";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const DEFAULT_AGENTS = [
  {
    id: "research",
    name: "Research Agent",
    stage: 1,
    role: "Topic discovery and list generation",
    enabled: true,
    inputLabel: "Optional: recent posts / topics to avoid (one per line)",
    config: {
      vertical: "professional",
      topic_domain: "AI product strategy, CI methodology applied to tech, agentic product design, senior PM career insights",
      target_platform: "LinkedIn (primary), personal portfolio blog (secondary)",
      audience: "Hiring managers, recruiters, senior PMs, AI strategy practitioners",
      avoid_list: "",
    },
    promptTemplate:
`You are the Research Agent in a multi-agent content pipeline.
Role: topic discovery for the "{vertical}" vertical.
Topic domain: {topic_domain}
Target platform: {target_platform}
Audience: {audience}
Topics already covered (avoid): {avoid_list}

Generate a bullet list of 10-20 topic ideas. Tag each with:
- estimated resonance (high/medium/low)
- content type (opinion / how-to / case study / story)
- suggested format (short-form / long-form)

{input}`,
  },
  {
    id: "outline",
    name: "Talking Points Agent",
    stage: 2,
    role: "Turn a selected topic into a bullet outline to hit during the voice recording",
    enabled: true,
    inputLabel: "Paste the topic you picked (or load the Research output and delete all but your chosen topic)",
    config: {
      vertical: "professional",
      num_points: "5-8",
      audience: "Hiring managers, recruiters, senior PMs, AI strategy practitioners",
      include_prompts: "true",
    },
    promptTemplate:
`You are the Talking Points Agent in a multi-agent content pipeline ("{vertical}" vertical).
Carlos has selected a topic from the Research Agent's list. He will record a 3-10 minute
unscripted voice note about it. Prepare a conversation outline he can glance at while talking.

Produce:
- A one-line framing of the angle to take for this audience: {audience}
- {num_points} bullet talking points to hit, ordered so the conversation flows naturally
  (hook/why now → core argument → concrete example from real experience → takeaway)
- For each bullet, a short sub-prompt or question to trigger unscripted thinking (include: {include_prompts})
- 1-2 things NOT to get lost in (scope traps for this topic)

Keep it scannable — this is a glance-sheet, not a script.

SELECTED TOPIC:
{input}`,
  },
  {
    id: "drafting",
    name: "Drafting Agent",
    stage: 4,
    role: "Transform raw transcript into a structured first draft",
    enabled: true,
    inputLabel: "Paste raw transcript (required) — optionally prepend 'TOPIC: ...' line",
    config: {
      vertical: "professional",
      format_template: "LinkedIn: 150-300 words, hook in line 1, 3-5 insight bullets, one-line CTA. Blog: 500-900 words, Problem → Approach → Insight structure.",
      target_length: "150-300 words (LinkedIn)",
      structure_guide: "Problem → Insight → Takeaway",
    },
    promptTemplate:
`You are the Drafting Agent in a multi-agent content pipeline ("{vertical}" vertical).
Transform the raw voice-note transcript below into a structured first draft.
Format template: {format_template}
Target length: {target_length}
Structure guide: {structure_guide}

Produce:
- Working title
- Hook / opening
- Core body (per format template)
- Closing / CTA appropriate to platform
- Rough tags/topics

TRANSCRIPT:
{input}`,
  },
  {
    id: "enrichment",
    name: "Research Enrichment Agent",
    stage: 5,
    role: "Deepen the draft with adjacent context, data points, and examples",
    enabled: true,
    inputLabel: "Paste draft to enrich (or load from a previous Drafting run)",
    config: {
      vertical: "professional",
      include_counterarguments: "true",
    },
    promptTemplate:
`You are the Research Enrichment Agent ("{vertical}" vertical).
Deepen the draft below:
- Suggest relevant stats, studies, or recent news that support the core argument (mark clearly as SUGGESTED — to be verified before publish).
- Add 1-2 examples or analogies to illustrate abstract points.
- Surface counterarguments worth addressing: {include_counterarguments}

Return the draft annotated inline with enrichment suggestions flagged as [ENRICH: ...] so a human can approve or reject each.

DRAFT:
{input}`,
  },
  {
    id: "qa",
    name: "QA / Tone Agent",
    stage: 6,
    role: "Final review pass — applies voice, enforces quality bar",
    enabled: true,
    inputLabel: "Paste enriched draft (or load from a previous Enrichment run)",
    config: {
      vertical: "professional",
      tone_profile: "Direct, first-person, grounded in real delivery experience. No buzzwords. Insights backed by specific examples.",
      hard_rules: "No corporate jargon. No em-dash overuse. First person.",
      human_review_required: "true",
    },
    promptTemplate:
`You are the QA / Tone Agent ("{vertical}" vertical).
Final review pass on the enriched draft below:
- Rewrite for tone consistency. Tone profile: {tone_profile}
- Hard rules: {hard_rules}
- Remove filler language from transcript artifacts
- Check structure against the format template
- End with a "FLAGS FOR HUMAN REVIEW" section listing anything needing a decision before publishing (human_review_required={human_review_required})

DRAFT:
{input}`,
  },
];

const res = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json" }, // CORS handled by Function URL config
  body: JSON.stringify(body),
});

async function seedIfEmpty() {
  // Upsert any default agent that doesn't exist yet (existing agents are never overwritten)
  for (const a of DEFAULT_AGENTS) {
    const cur = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: `AGENT#${a.id}`, sk: "META" } }));
    if (cur.Item) continue;
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: { pk: `AGENT#${a.id}`, sk: "META", ...a, updatedAt: new Date().toISOString() },
    }));
  }
}

async function getAgents() {
  const scan = await ddb.send(new ScanCommand({ TableName: TABLE }));
  return (scan.Items || []).filter(i => i.sk === "META" && i.pk.startsWith("AGENT#")).sort((a, b) => a.stage - b.stage);
}

const TOPIC_STATUSES = ["idea", "queued", "discussed", "published"];

async function addTopicLog(topicId, entry) {
  const now = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: `TOPICLOG#${topicId}`,
      sk: `LOG#${now}#${Math.random().toString(36).slice(2, 6)}`,
      topicId, createdAt: now, ...entry,
    },
  }));
}

async function getTopic(id) {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: `TOPIC#${id}`, sk: "META" } }));
  return r.Item;
}

async function callAnthropic(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${JSON.stringify(data)}`);
  return data.content.map(c => c.text || "").join("\n");
}

function buildPrompt(agent, input) {
  let p = agent.promptTemplate;
  for (const [k, v] of Object.entries(agent.config || {})) {
    p = p.split(`{${k}}`).join(v ?? "");
  }
  return p.split("{input}").join(input || "(none provided)");
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  if (method === "OPTIONS") return res(200, {});
  const path = event.rawPath || "/";
  const body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body) : {};

  try {
    await seedIfEmpty();

    // GET /agents
    if (method === "GET" && path === "/agents") return res(200, await getAgents());

    // PUT /agents/{id}  — update config / enabled / name
    let m = path.match(/^\/agents\/([\w-]+)$/);
    if (m && method === "PUT") {
      const id = m[1];
      const cur = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: `AGENT#${id}`, sk: "META" } }));
      if (!cur.Item) return res(404, { error: "agent not found" });
      const updated = {
        ...cur.Item,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.promptTemplate !== undefined ? { promptTemplate: body.promptTemplate } : {}),
        config: { ...cur.Item.config, ...(body.config || {}) },
        updatedAt: new Date().toISOString(),
      };
      await ddb.send(new PutCommand({ TableName: TABLE, Item: updated }));
      return res(200, updated);
    }

    // POST /agents/{id}/run
    m = path.match(/^\/agents\/([\w-]+)\/run$/);
    if (m && method === "POST") {
      const id = m[1];
      const cur = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: `AGENT#${id}`, sk: "META" } }));
      if (!cur.Item) return res(404, { error: "agent not found" });
      if (!cur.Item.enabled) return res(400, { error: "agent is disabled" });
      const prompt = buildPrompt(cur.Item, body.input);
      const started = Date.now();
      const output = await callAnthropic(prompt);
      const run = {
        pk: `RUNS#${id}`, sk: `RUN#${new Date().toISOString()}`,
        agentId: id, agentName: cur.Item.name,
        input: (body.input || "").slice(0, 20000),
        output, model: MODEL, durationMs: Date.now() - started,
        createdAt: new Date().toISOString(),
      };
      await ddb.send(new PutCommand({ TableName: TABLE, Item: run }));
      return res(200, run);
    }

    // GET /agents/{id}/runs
    m = path.match(/^\/agents\/([\w-]+)\/runs$/);
    if (m && method === "GET") {
      const q = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :p",
        ExpressionAttributeValues: { ":p": `RUNS#${m[1]}` },
        ScanIndexForward: false, Limit: 25,
      }));
      return res(200, q.Items || []);
    }

    // ---- Topics ----

    // GET /topics
    if (method === "GET" && path === "/topics") {
      const scan = await ddb.send(new ScanCommand({ TableName: TABLE }));
      const topics = (scan.Items || [])
        .filter(i => i.sk === "META" && i.pk.startsWith("TOPIC#"))
        .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
      return res(200, topics);
    }

    // POST /topics  { title, description? }
    if (method === "POST" && path === "/topics") {
      if (!body.title) return res(400, { error: "title required" });
      const id = crypto.randomUUID().slice(0, 8);
      const now = new Date().toISOString();
      const topic = {
        pk: `TOPIC#${id}`, sk: "META", id,
        title: body.title, description: body.description || "",
        status: "idea", talkingPoints: "",
        createdAt: now, updatedAt: now,
      };
      await ddb.send(new PutCommand({ TableName: TABLE, Item: topic }));
      await addTopicLog(id, { type: "created", detail: `Topic created (status: idea)` });
      return res(200, topic);
    }

    // PUT /topics/{id}  { status?, note?, title?, description? }
    m = path.match(/^\/topics\/([\w-]+)$/);
    if (m && method === "PUT") {
      const cur = await getTopic(m[1]);
      if (!cur) return res(404, { error: "topic not found" });
      const updated = { ...cur, updatedAt: new Date().toISOString() };
      if (body.title !== undefined) updated.title = body.title;
      if (body.description !== undefined) updated.description = body.description;
      if (body.status !== undefined && body.status !== cur.status) {
        if (!TOPIC_STATUSES.includes(body.status)) return res(400, { error: `status must be one of ${TOPIC_STATUSES.join(", ")}` });
        updated.status = body.status;
        await addTopicLog(cur.id, { type: "status_change", from: cur.status, to: body.status, detail: `Status: ${cur.status} → ${body.status}` });
      }
      if (body.note) {
        await addTopicLog(cur.id, { type: "note", detail: body.note });
      }
      await ddb.send(new PutCommand({ TableName: TABLE, Item: updated }));
      return res(200, updated);
    }

    // POST /topics/{id}/talking-points — run the outline agent on this topic
    m = path.match(/^\/topics\/([\w-]+)\/talking-points$/);
    if (m && method === "POST") {
      const topic = await getTopic(m[1]);
      if (!topic) return res(404, { error: "topic not found" });
      const agent = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: "AGENT#outline", sk: "META" } }));
      if (!agent.Item) return res(500, { error: "outline agent not found" });
      const input = topic.title + (topic.description ? `\n\n${topic.description}` : "");
      const prompt = buildPrompt(agent.Item, input);
      const started = Date.now();
      const output = await callAnthropic(prompt);
      const now = new Date().toISOString();
      // store as an outline-agent run too, so it shows in the agent's work history
      await ddb.send(new PutCommand({ TableName: TABLE, Item: {
        pk: "RUNS#outline", sk: `RUN#${now}`,
        agentId: "outline", agentName: agent.Item.name,
        input, output, model: MODEL, durationMs: Date.now() - started,
        topicId: topic.id, createdAt: now,
      }}));
      const updated = { ...topic, talkingPoints: output, updatedAt: now };
      await ddb.send(new PutCommand({ TableName: TABLE, Item: updated }));
      await addTopicLog(topic.id, { type: "talking_points", detail: "Talking points generated" });
      return res(200, updated);
    }

    // GET /topics/{id}/log
    m = path.match(/^\/topics\/([\w-]+)\/log$/);
    if (m && method === "GET") {
      const q = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :p",
        ExpressionAttributeValues: { ":p": `TOPICLOG#${m[1]}` },
        ScanIndexForward: false, Limit: 100,
      }));
      return res(200, q.Items || []);
    }

    return res(404, { error: `no route: ${method} ${path}` });
  } catch (e) {
    return res(500, { error: String(e.message || e) });
  }
};
