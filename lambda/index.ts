import Anthropic from '@anthropic-ai/sdk'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { createHmac, timingSafeEqual } from 'crypto'
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'

const ssm = new SSMClient({})
const ANTHROPIC_API_KEY_PARAM = process.env.ANTHROPIC_API_KEY_PARAM!
const TOKEN_SECRET_PARAM = process.env.TOKEN_SECRET_PARAM!
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? 'https://magalygutierrez.com'

// Cached across warm invocations
let adminClient: Anthropic | undefined
let tokenSecretPromise: Promise<string> | undefined

async function getParam(name: string): Promise<string> {
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
  return res.Parameter?.Value ?? ''
}

function getTokenSecret(): Promise<string> {
  tokenSecretPromise ??= getParam(TOKEN_SECRET_PARAM)
  return tokenSecretPromise
}

async function getAdminClient(): Promise<Anthropic> {
  if (adminClient) return adminClient
  const apiKey = await getParam(ANTHROPIC_API_KEY_PARAM)
  adminClient = new Anthropic({ apiKey })
  return adminClient
}

async function verifyToken(token: string): Promise<boolean> {
  try {
    const secret = await getTokenSecret()
    const decoded = Buffer.from(token, 'base64url').toString('utf8')
    const lastColon = decoded.lastIndexOf(':')
    const payload = decoded.slice(0, lastColon)
    const sig = decoded.slice(lastColon + 1)
    const [role, ts] = payload.split(':')
    if (role !== 'admin') return false
    if (Date.now() - parseInt(ts, 10) > 86_400_000) return false
    const expected = createHmac('sha256', secret).update(payload).digest('hex')
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  } catch {
    return false
  }
}

function extractToken(event: APIGatewayProxyEventV2): string {
  const auth = event.headers?.authorization ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : ''
}

function corsHeaders(origin: string) {
  const allowed = [ALLOWED_ORIGIN, 'http://localhost:5173', 'http://localhost:5174']
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-anthropic-key',
  }
}

function ok(body: object, origin: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    body: JSON.stringify(body),
  }
}

function err(status: number, message: string, origin: string): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    body: JSON.stringify({ message }),
  }
}

// ── Job description fetcher ───────────────────────────────────────────────────
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function fetchJobPage(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResumeTailor/1.0)' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    const text = stripHtml(html)
    return text.slice(0, 30_000)
  } finally {
    clearTimeout(timer)
  }
}

// ── Stable system prompt — cached across requests ─────────────────────────────
const SYSTEM_PROMPT = `You are an expert resume coach and technical recruiter with 15+ years of experience across software engineering, product, and data roles.

Your job is to analyze a candidate's resume against a specific job listing and produce specific, actionable tailoring suggestions.

Structure your response with these sections using markdown:

## Key Matches
Skills, experience, and achievements from the resume that already align well with this role. Be specific — reference actual resume content.

## Suggested Edits
For each suggestion, quote the original resume text and provide an improved version. Focus on:
- Reframing accomplishments to match the job's language and priorities
- Quantifying impact where possible
- Surfacing relevant experience that is buried or understated

## Missing Keywords & Skills
Important terms, technologies, or qualifications from the job description that are absent from the resume. For each, note whether it is a requirement or a nice-to-have, and suggest how to address the gap (add it if the candidate has the experience, or acknowledge the gap honestly).

## Summary / Objective (optional)
If the resume has a summary or objective section, suggest a tailored version for this specific role. If there is none, suggest whether adding one would help.

Be concrete and surgical. Quote specific resume text when suggesting edits. Do not give generic advice.`

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  const origin = event.headers?.origin ?? ''
  const method = event.requestContext.http.method

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' }
  }

  if (method !== 'POST') return err(405, 'Method not allowed', origin)

  // ── POST /fetch-job — public, no auth ─────────────────────────────────────
  if (path === '/fetch-job') {
    let reqBody: { url?: string }
    try { reqBody = JSON.parse(event.body ?? '{}') } catch { return err(400, 'Invalid JSON', origin) }
    const url = String(reqBody.url ?? '').trim()
    if (!url) return err(400, 'url is required', origin)
    if (!/^https?:\/\//i.test(url)) return err(400, 'url must start with http:// or https://', origin)
    try {
      const text = await fetchJobPage(url)
      if (!text) return err(422, 'Could not extract text from that page', origin)
      return ok({ text }, origin)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to fetch URL'
      return err(502, msg, origin)
    }
  }

  let body: { pdf?: string; jobListing?: string }
  try {
    body = JSON.parse(event.body ?? '{}')
  } catch {
    return err(400, 'Invalid JSON body', origin)
  }

  const { pdf, jobListing } = body
  if (!pdf) return err(400, 'pdf (base64-encoded) is required', origin)
  if (!jobListing?.trim()) return err(400, 'jobListing is required', origin)
  if (jobListing.length > 20_000) return err(400, 'jobListing is too long (max 20,000 chars)', origin)

  // Resolve which Anthropic client to use
  let client: Anthropic
  const token = extractToken(event)
  if (token && await verifyToken(token)) {
    client = await getAdminClient()
  } else {
    const userKey = event.headers?.['x-anthropic-key'] ?? ''
    if (!userKey) return err(401, 'Provide your Anthropic API key via the x-anthropic-key header', origin)
    client = new Anthropic({ apiKey: userKey })
  }

  try {

    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 16000,
      // Cache the system prompt — it is identical for every request
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdf,
              },
              title: 'Resume',
            },
            {
              type: 'text',
              text: `Here is the job listing I am applying to:\n\n${jobListing}\n\nPlease analyze my resume and provide specific suggestions to tailor it for this role.`,
            },
          ],
        },
      ],
    })

    const suggestions = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')

    return ok(
      {
        suggestions,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
      },
      origin
    )
  } catch (e) {
    if (e instanceof Anthropic.APIError) {
      console.error('Anthropic API error:', e.status, e.message)
      return err(502, `Claude API error: ${e.message}`, origin)
    }
    console.error('Unexpected error:', e)
    return err(500, 'Internal server error', origin)
  }
}
