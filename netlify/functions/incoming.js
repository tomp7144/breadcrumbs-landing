const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const { encrypt, decrypt } = require('./lib/crypto');

const MODEL = 'claude-haiku-4-5-20251001';

// Patterns that indicate the user wants to recall their breadcrumb.
const RECALL_RE = /\b(where was i|where am i|what was i doing|what am i working on|what was i working on|recap|catch me up|bring me back|what did i have)\b/i;

// Simple compliance keywords Twilio handles at carrier level for A2P; we still
// need to not process them as normal messages.
const STOP_KEYWORDS = new Set(['STOP', 'CANCEL', 'UNSUBSCRIBE', 'QUIT', 'END']);

function twimlReply(message) {
  const safe = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml' },
    body: `<Response><Message>${safe}</Message></Response>`,
  };
}

function emptyTwiml() {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml' },
    body: '<Response></Response>',
  };
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Capture acks. Local, instant, no API dependency — these stay human even when
// the Anthropic call fails. With a short gist we weave it in; without one we
// keep it clean and never echo the whole message back.
function captureAck(gist) {
  if (gist) {
    return pick([
      `got it — ${gist}. saved.`,
      `saved: ${gist}. go do your thing.`,
      `down. ${gist} is in the buffer.`,
      `${gist} — saved. pick it up whenever.`,
      `locked in: ${gist}. come back when you're ready.`,
    ]);
  }
  return pick([
    'got it. saved.',
    "saved — it'll be here.",
    'noted. go do your thing.',
    'in the buffer. come back whenever.',
    'saved that one. picks back up when you do.',
  ]);
}

// Recall fallback, used only if the Claude synthesis call fails. Kept plain on
// purpose — and logged loudly so a silent drop here never masquerades as fine.
function recallFallback(labels) {
  if (labels.length === 1) {
    return `you left off on ${labels[0]}. anything else to hold onto?`;
  }
  const shown = labels.slice(0, 5);
  const overflow = labels.length > 5 ? ` (5 of ${labels.length})` : '';
  return `a few going${overflow}, most recent first: ${shown.join(', ')}. want me to add anything?`;
}

const RECALL_SYSTEM = `You are the voice of Breadcrumbs, an SMS tool that holds someone's place while they switch tasks. They just texted asking where they left off. You're given their saved notes, most recent first. Reply with ONE short SMS that reorients them.

Voice: casual, lowercase, dry, like a sharp friend texting back. Contractions and fragments are fine. No emoji. No "yo", "dude", "let's go", or any hype.

Rules:
- lead with the actual substance of what they were doing
- if there are several notes, weave them into one line, most recent first
- end with an open, optional offer — never tell them what to do, never imply they should get back to work. think "anything else to hold onto?" or "want me to add anything?", and vary it every time
- 1-2 lines max, always SMS-length
- never write "you were working on:" and never echo a bulleted list
- never use directive or back-to-work closers like "back to it?", "pick it up", "that's the thread", "go", or "you're good"
- never invent anything that isn't in the notes`;

exports.handler = async (event) => {
  // Twilio signature validation — reject anything that isn't a legitimate Twilio request.
  const signature = event.headers['x-twilio-signature'] || '';
  const url = event.rawUrl || `https://${event.headers.host}${event.path}`;
  const params = Object.fromEntries(new URLSearchParams(event.body));

  if (!twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, params)) {
    return { statusCode: 403, body: 'Forbidden' };
  }

  const from = params.From;
  const body = (params.Body || '').trim();

  if (!body || !from) return emptyTwiml();

  // SMS compliance: STOP variants are handled at the carrier level once A2P is
  // registered, but we silently absorb them here too.
  if (STOP_KEYWORDS.has(body.toUpperCase())) {
    return emptyTwiml();
  }

  if (body.toUpperCase() === 'HELP') {
    return twimlReply(
      "breadcrumbs holds what you're working on so you can pick it back up. " +
      'text anything to save it. text "where was i" to get it back. text STOP to quit.'
    );
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // --- Recall branch ---
  if (RECALL_RE.test(body)) {
    const { data: rows } = await supabase
      .from('breadcrumbs')
      .select('encrypted_message, last_updated_at')
      .eq('phone_number', from)
      .eq('status', 'active')
      .order('last_updated_at', { ascending: false });

    if (!rows || rows.length === 0) {
      return twimlReply(
        "nothing saved right now. text me what you're working on and i'll hold it for you."
      );
    }

    const labels = [];
    for (const row of rows) {
      try {
        const parsed = decrypt(row.encrypted_message);
        const label =
          parsed.gist ||
          parsed.what_working_on ||
          parsed.current_thought ||
          parsed.next_step ||
          parsed.open_question;
        if (label) labels.push(String(label).toLowerCase());
      } catch (err) {
        console.error('decrypt failed on recall:', err.message);
      }
    }

    if (labels.length === 0) {
      return twimlReply(
        "i have things saved for you but couldn't read them. text me what you're working on to start fresh."
      );
    }

    // Cap what we hand the model; most-recent-first is already guaranteed by the query order.
    const forModel = labels.slice(0, 8);

    let recap;
    try {
      const msg = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 80,
        system: RECALL_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Saved notes (most recent first):\n${forModel.map((l) => `- ${l}`).join('\n')}`,
          },
        ],
      });
      recap = (msg.content[0].text || '').trim();
      if (!recap) throw new Error('empty model response');
    } catch (err) {
      // LOUD — a silent fall to the template is exactly the failure mode we don't want hidden.
      console.error('RECALL CLAUDE FAILED — using template fallback:', err.message);
      recap = recallFallback(labels);
    }

    return twimlReply(recap);
  }

  // --- Parse and store branch ---
  const systemPrompt = `You extract core context from a user's raw, stream-of-consciousness message.
Return ONLY a valid JSON object with these five fields:
- gist: a 2-5 word, lowercase summary of what they're on (e.g. "breadcrumbs + f1 delta"). null if unclear.
- what_working_on: the main task or project they are in the middle of
- current_thought: the specific thing on their mind right now
- next_step: what they were about to do next (if mentioned)
- open_question: anything they are unsure about or need to figure out

Set any field to null if it isn't in the message. Output pure JSON only — no markdown, no explanation.`;

  let parsedData = {
    gist: null,
    what_working_on: null,
    current_thought: null,
    next_step: null,
    open_question: null,
  };
  let parseOk = false;

  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: body }],
    });
    const out = JSON.parse(msg.content[0].text);
    parsedData = { ...parsedData, ...out };
    parseOk = true;
  } catch (err) {
    // If Claude fails or returns non-JSON, fall back: store the raw message in
    // what_working_on so nothing is lost. No gist, so the ack stays clean.
    console.error('PARSE CLAUDE FAILED — storing raw fallback:', err.message);
    parsedData.what_working_on = body;
  }

  const encryptedMessage = encrypt(parsedData);

  // Every inbound message becomes its own new row — no unique constraint on
  // phone_number in the new schema, so a straight insert is correct.
  const { error } = await supabase
    .from('breadcrumbs')
    .insert({ phone_number: from, encrypted_message: encryptedMessage });
  if (error) console.error('Supabase insert error:', error);

  // Only feed a gist into the ack if the parse actually succeeded and produced a
  // short one — never the full raw body, which is what made it sound robotic.
  const gist = parseOk && parsedData.gist ? String(parsedData.gist).toLowerCase() : null;

  return twimlReply(captureAck(gist));
};
