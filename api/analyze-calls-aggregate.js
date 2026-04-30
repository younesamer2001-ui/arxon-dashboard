// ═══════════════════════════════════════════════════════════════════
// /api/analyze-calls-aggregate.js — Vercel serverless function
// Aggregert AI-analyse over flere samtaler — finner mønstre, gjentatte feil,
// og gir prioriterte anbefalinger.
//
// Inn: POST { tenantId?: string, days?: number (default 7), maxCalls?: number (default 30) }
// Ut: { analysis: {...} } lagret i public.call_analyses (analysis_type='aggregate')
// ═══════════════════════════════════════════════════════════════════

export const config = { runtime: 'nodejs' };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jifxdjctyhkywwldrrmj.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ANALYSIS_MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT = `Du er en senior samtale-analytiker for Arxon. Du analyserer flere telefonsamtaler samtidig og finner MØNSTRE.

Fokus:
1. Hvilke gjentatte feil gjorde AI-en på tvers av samtaler?
2. Hvilke spørsmål/intent forsto den IKKE?
3. Hvilke ord/uttrykk/dialekter slet den med?
4. Hva fungerte konsistent godt?
5. Hva er de 3 viktigste tingene teamet bør fikse NÅ?

Svar ALLTID som strict JSON:
{
  "overall_health": "<én setning om hvor godt AI-en presterer totalt>",
  "patterns": [
    {"category": "<intent_recognition|language|booking|escalation|tone|other>", "frequency": "<høy|middels|lav>", "description": "<kort>", "example": "<sitat fra en samtale>"}
  ],
  "top_questions_failed": [
    {"question": "<typisk spørsmål AI-en ikke håndterte>", "occurrences": <int>, "fix": "<hvordan trene den>"}
  ],
  "what_worked_consistently": ["<bullet 1>", "<bullet 2>", ...],
  "recommendations": [
    {"priority": <1|2|3>, "action": "<konkret handling>", "expected_impact": "<hva dette løser>"}
  ],
  "metric_summary": {
    "calls_analyzed": <int>,
    "successful_calls": <int>,
    "failed_calls": <int>,
    "common_failure_modes": ["<bullet 1>", "<bullet 2>"]
  }
}

VIKTIG:
- Snakk norsk
- "patterns" skal ha 3-7 elementer
- "recommendations" skal ha 3-5 elementer, sortert etter priority (1 = mest viktig)
- "top_questions_failed" skal være ekte gjentatte mønstre, ikke engangs-tilfeller
- Ikke pynt — om AI-en sliter, si det rett ut`;

// ── Helpers ─────────────────────────────────────────────────────────────

async function fetchRecentCalls(authHeader, days, maxCalls, tenantId) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  let url = `${SUPABASE_URL}/rest/v1/calls?created_at=gte.${cutoff}&order=created_at.desc&limit=${maxCalls}&select=id,direction,duration_seconds,outcome,sentiment,summary,transcript,caller_phone,meeting_booked_at,created_at,tenant_id`;
  if (tenantId) url += `&tenant_id=eq.${tenantId}`;

  const res = await fetch(url, {
    headers: {
      Authorization: authHeader,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Supabase fetch calls: ${res.status} ${await res.text()}`);
  return res.json();
}

function transcriptToText(transcript, maxLen = 600) {
  let text;
  if (Array.isArray(transcript)) {
    text = transcript
      .map(t => {
        const isAI = /agent|ai|assistant/i.test(t?.role || '');
        return `${isAI ? 'AI' : 'Kunde'}: ${t?.content || ''}`;
      })
      .join('\n');
  } else if (typeof transcript === 'string') {
    text = transcript;
  } else {
    text = '';
  }
  if (text.length > maxLen) text = text.slice(0, maxLen) + '... [trunkert]';
  return text;
}

function compactCallForLLM(call, idx) {
  return `=== Samtale ${idx + 1} (${call.id.slice(0, 8)}) ===
Tid: ${call.created_at}
Retning: ${call.direction || '?'}
Varighet: ${call.duration_seconds || 0}s
Resultat: ${call.outcome || '?'}
Booket: ${call.meeting_booked_at ? 'Ja' : 'Nei'}
Sentiment: ${call.sentiment ?? '?'}
Sammendrag: ${call.summary || '(mangler)'}

Transkript (trunkert):
${transcriptToText(call.transcript, 600)}
`;
}

async function analyzeAggregate(calls) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY mangler');
  if (!calls.length) throw new Error('Ingen samtaler å analysere');

  const callsBlock = calls.map((c, i) => compactCallForLLM(c, i)).join('\n\n');

  const userPrompt = `Du har ${calls.length} samtaler fra siste periode. Finn mønstrene.

${callsBlock}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ANALYSIS_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returnerte tomt svar');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Kunne ikke parse OpenAI JSON');
  }

  const inputTokens = data?.usage?.prompt_tokens || 0;
  const outputTokens = data?.usage?.completion_tokens || 0;
  const costUsd = (inputTokens * 0.15 + outputTokens * 0.60) / 1_000_000;

  return { parsed, raw: data, costUsd };
}

async function saveAggregate(tenantId, analysis, calls, days, raw, costUsd) {
  const url = `${SUPABASE_URL}/rest/v1/call_analyses`;
  const start = calls.length ? calls[calls.length - 1].created_at : new Date().toISOString();
  const end = calls.length ? calls[0].created_at : new Date().toISOString();

  const payload = {
    tenant_id: tenantId,
    analysis_type: 'aggregate',
    scope_label: `Siste ${days} dager`,
    date_range_start: start,
    date_range_end: end,
    call_count: calls.length,
    patterns: analysis.patterns || [],
    top_questions_failed: analysis.top_questions_failed || [],
    recommendations: analysis.recommendations || [],
    customer_intent: analysis.overall_health || null,
    raw_response: raw,
    model_used: ANALYSIS_MODEL,
    cost_usd: costUsd,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`Supabase insert aggregate: ${res.status} ${await res.text()}`);
  const arr = await res.json();
  return arr[0];
}

// ── Handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Mangler Authorization' });
    if (!SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY mangler' });

    const body = req.body || (await new Promise((resolve, reject) => {
      let buf = '';
      req.on('data', c => buf += c);
      req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); } });
      req.on('error', reject);
    }));

    const days = Math.max(1, Math.min(90, body?.days || 7));
    // Cap til 15 for å holde oss under Vercel 30s timeout
    const maxCalls = Math.max(1, Math.min(15, body?.maxCalls || 15));
    const tenantId = body?.tenantId || null;

    const calls = await fetchRecentCalls(authHeader, days, maxCalls, tenantId);
    if (!calls.length) {
      return res.status(200).json({ ok: true, analysis: null, message: 'Ingen samtaler i perioden' });
    }

    const { parsed, raw, costUsd } = await analyzeAggregate(calls);
    const tenantToSave = tenantId || calls[0]?.tenant_id;
    const saved = await saveAggregate(tenantToSave, parsed, calls, days, raw, costUsd);

    return res.status(200).json({
      ok: true,
      analysis: saved,
      calls_analyzed: calls.length,
    });
  } catch (e) {
    console.error('[aggregate] error', e);
    return res.status(500).json({ error: e.message || 'Ukjent feil' });
  }
}
