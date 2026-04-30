// ═══════════════════════════════════════════════════════════════════
// /api/analyze-call.js — Vercel serverless function
// Analyserer en enkelt Vapi-samtale og lagrer strukturert tilbakemelding
// til public.call_analyses i Supabase.
//
// Inn: POST { callId: string }
// Auth: Bearer-token (samme Supabase-session-token som dashboardet)
// ═══════════════════════════════════════════════════════════════════

export const config = { runtime: 'nodejs' };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jifxdjctyhkywwldrrmj.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ANALYSIS_MODEL = 'gpt-4o-mini'; // fast + cheap, god nok for samtale-analyse

const SYSTEM_PROMPT = `Du er en senior samtale-analytiker for Arxon, en norsk AI-resepsjonist for SMB-er. Du skal analysere én telefonsamtale (transkript) mellom AI-en og en kunde.

Mål:
1. Vurder om AI-en faktisk hjalp kunden eller om noe gikk galt
2. Identifiser KONKRETE forbedringspunkter — ord, fraser, intent-feil
3. Gi handlingsrettede instruksjoner som teamet kan implementere

Sjekkliste når du analyserer:
- Forsto AI-en hva kunden ville? (intent recognition)
- Svarte AI-en på norsk uten rare uttrykk?
- Ble booking gjennomført der det var målet?
- Eskalerte AI-en når den burde?
- Var det noe AI-en sa som høres robotaktig eller "AI-aktig" ut?
- Var det "stappa kalender" / dialekt-uttrykk / lokale fraser den ikke forsto?
- Hang samtalen seg opp et sted? Tok det for lang tid?

Svar ALLTID som strict JSON som matcher dette skjemaet:
{
  "overall_score": <int 1-10>,
  "customer_intent": "<hva kunden ønsket, én setning>",
  "outcome_assessment": "<hva som faktisk skjedde, én setning>",
  "what_worked": ["<konkret bullet 1>", "<konkret bullet 2>", ...],
  "what_failed": ["<konkret bullet 1>", "<konkret bullet 2>", ...],
  "suggested_fixes": ["<handlingsrettet instruks 1>", "<handlingsrettet instruks 2>", ...],
  "detected_problems": [
    {"category": "intent_recognition|language|booking|escalation|tone|other", "description": "<kort>"}
  ]
}

VIKTIG:
- Hvert array MÅ ha 1-5 elementer (ikke null hvis det ikke er noe — skriv "Ingen synlige problemer" eller lignende)
- "suggested_fixes" skal være KONKRETE instruksjoner ("Tren AI-en på at 'stappa' = 'fullt'") ikke vage tips
- Ikke pynt på score — om samtalen var elendig, gi 3/10
- Snakk norsk i alle felt`;

// ── Helpers ─────────────────────────────────────────────────────────────

async function fetchCall(callId, authHeader) {
  const url = `${SUPABASE_URL}/rest/v1/calls?id=eq.${callId}&select=*`;
  const res = await fetch(url, {
    headers: {
      Authorization: authHeader,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Supabase fetch call: ${res.status} ${await res.text()}`);
  const arr = await res.json();
  if (!arr || !arr.length) throw new Error('Samtale ikke funnet');
  return arr[0];
}

function transcriptToText(transcript) {
  if (Array.isArray(transcript)) {
    return transcript
      .map(t => {
        const role = (t && t.role) || '';
        const isAI = /agent|ai|assistant/i.test(role);
        const label = isAI ? 'AI' : 'Kunde';
        return `${label}: ${(t && t.content) || ''}`;
      })
      .join('\n');
  }
  if (typeof transcript === 'string') return transcript;
  return '';
}

async function analyzeWithOpenAI(call) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY mangler i Vercel env vars');

  const transcriptText = transcriptToText(call.transcript);
  if (!transcriptText.trim()) {
    throw new Error('Samtalen mangler transkript');
  }

  const userPrompt = `Samtaledata:
- Retning: ${call.direction || 'ukjent'}
- Varighet: ${call.duration_seconds || 0} sek
- Fra/til: ${call.caller_phone || 'ukjent'}
- Samtale-resultat: ${call.outcome || 'ikke satt'}
- Møte booket: ${call.meeting_booked_at ? 'Ja (' + call.meeting_booked_at + ')' : 'Nei'}
- Sentiment: ${call.sentiment ?? 'ukjent'}
- Eksisterende sammendrag: ${call.summary || '(ikke generert)'}

Transkript:
${transcriptText}`;

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
  } catch (e) {
    throw new Error('Kunne ikke parse OpenAI JSON-svar: ' + content.slice(0, 200));
  }

  // Cost calc (gpt-4o-mini: $0.15/1M input, $0.60/1M output, april 2026)
  const inputTokens = data?.usage?.prompt_tokens || 0;
  const outputTokens = data?.usage?.completion_tokens || 0;
  const costUsd = (inputTokens * 0.15 + outputTokens * 0.60) / 1_000_000;

  return { parsed, raw: data, costUsd };
}

async function saveAnalysis(callId, tenantId, analysis, raw, costUsd) {
  const url = `${SUPABASE_URL}/rest/v1/call_analyses`;
  const payload = {
    tenant_id: tenantId,
    call_id: callId,
    analysis_type: 'single_call',
    scope_label: 'Single call',
    overall_score: analysis.overall_score,
    customer_intent: analysis.customer_intent,
    outcome_assessment: analysis.outcome_assessment,
    what_worked: analysis.what_worked,
    what_failed: analysis.what_failed,
    suggested_fixes: analysis.suggested_fixes,
    detected_problems: analysis.detected_problems,
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

  if (!res.ok) {
    throw new Error(`Supabase insert: ${res.status} ${await res.text()}`);
  }
  const arr = await res.json();
  return arr[0];
}

// ── Handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Mangler Authorization-header' });
    }
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY mangler i Vercel env' });
    }

    const body = req.body || (await new Promise((resolve, reject) => {
      let buf = '';
      req.on('data', c => buf += c);
      req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); } });
      req.on('error', reject);
    }));

    const callId = body?.callId;
    if (!callId) return res.status(400).json({ error: 'callId mangler' });

    const call = await fetchCall(callId, authHeader);
    const tenantId = call.tenant_id;

    const { parsed, raw, costUsd } = await analyzeWithOpenAI(call);
    const saved = await saveAnalysis(callId, tenantId, parsed, raw, costUsd);

    return res.status(200).json({
      ok: true,
      analysis: saved,
    });
  } catch (e) {
    console.error('[analyze-call] error', e);
    return res.status(500).json({ error: e.message || 'Ukjent feil' });
  }
}
