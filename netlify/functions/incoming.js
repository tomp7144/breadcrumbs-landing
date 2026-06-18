const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const { encrypt, decrypt } = require('./lib/crypto');

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

  // --- Recall branch ---
  if (RECALL_RE.test(body)) {
    const { data: row } = await supabase
      .from('breadcrumbs')
      .select('encrypted_message, last_updated_at')
      .eq('phone_number', from)
      .eq('status', 'active')
      .maybeSingle();

    if (!row) {
      return twimlReply(
        "nothing saved right now. text me what you're working on and i'll hold it for you."
      );
    }

    let parsed;
    try {
      parsed = decrypt(row.encrypted_message);
    } catch (err) {
      console.error('decrypt failed on recall:', err.message);
      return twimlReply("i have something saved for you but couldn't read it. text me what you're working on to reset.");
    }

    const parts = [
      parsed.what_working_on && `you were working on: ${parsed.what_working_on}`,
      parsed.current_thought && `your thought: ${parsed.current_thought}`,
      parsed.next_step && `next up: ${parsed.next_step}`,
      parsed.open_question && `still open: ${parsed.open_question}`,
    ].filter(Boolean);

    const recap = parts.length > 0
      ? parts.join('. ') + '. you\'re good — go.'
      : "you left something here but i couldn't make out the details. text me what you're working on to reset.";

    return twimlReply(recap);
  }

  // --- Parse and store branch ---
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = `You extract core context from a user's raw, stream-of-consciousness message.
Return ONLY a valid JSON object with these four nullable string fields:
- what_working_on: the main task or project they are in the middle of
- current_thought: the specific thing on their mind right now
- next_step: what they were about to do next (if mentioned)
- open_question: anything they are unsure about or need to figure out

Set any field to null if it isn't in the message. Output pure JSON only — no markdown, no explanation.`;

  let parsedData = { what_working_on: null, current_thought: null, next_step: null, open_question: null };

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: body }],
    });
    parsedData = JSON.parse(msg.content[0].text);
  } catch (err) {
    // If Claude fails or returns non-JSON, fall back: store the raw message in
    // what_working_on so nothing is lost, rather than crashing.
    console.error('Claude parse failed, storing raw fallback:', err.message);
    parsedData.what_working_on = body;
  }

  const encryptedMessage = encrypt(parsedData);

  // Upsert: check for an existing active row, then update or insert.
  // Manual select-then-write because Supabase's .upsert() doesn't cleanly
  // target partial unique indexes in all versions of the JS client.
  const { data: existing } = await supabase
    .from('breadcrumbs')
    .select('id')
    .eq('phone_number', from)
    .eq('status', 'active')
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from('breadcrumbs')
      .update({ encrypted_message: encryptedMessage, last_updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (error) console.error('Supabase update error:', error);
  } else {
    const { error } = await supabase
      .from('breadcrumbs')
      .insert({ phone_number: from, encrypted_message: encryptedMessage });
    if (error) console.error('Supabase insert error:', error);
  }

  // Reply in Breadcrumbs' voice: lowercase, brief, references what they said.
  const ref = parsedData.what_working_on
    ? parsedData.what_working_on.toLowerCase()
    : null;

  const reply = ref
    ? `saved. ${ref} will be here when you get back.`
    : "saved. text me when you're ready to pick back up.";

  return twimlReply(reply);
};
