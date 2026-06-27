const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const { encrypt, decrypt } = require('./lib/crypto');

const MODEL = 'claude-haiku-4-5-20251001';

const TIER_CAPS = { trial: 25, basic: 200, pro: 600, unlimited: 1500 };

// Hard kill for Unlimited: past this, stop replying AND stop saving + alert.
const UNLIMITED_KILL = 2000;

// Trial resets to a fresh 25 once the trial bucket is this many days old.
const TRIAL_RESET_DAYS = 180;

const LINKS = {
  basic: process.env.STRIPE_LINK_BASIC || 'https://buy.stripe.com/cNi00cbUHf0ggHg6GV6Ri00',
  pro: process.env.STRIPE_LINK_PRO || 'https://buy.stripe.com/00w4gs5wjf0g4Yyd5j6Ri01',
  unlimited: process.env.STRIPE_LINK_UNLIMITED || 'https://buy.stripe.com/7sY28k7Er9FWfDc8P36Ri02',
};

const COMP_NUMBERS = new Set(
  (process.env.COMP_NUMBERS || '').split(',').map((s) => s.trim()).filter(Boolean)
);

// Links shown in the welcome. HOWTO is the /start page; PLANS is where to
// subscribe (defaults to the Basic checkout — point at a pricing page if you build one).
const HOWTO_URL = process.env.HOWTO_URL || 'https://textbreadcrumbs.com/start';
const PLANS_URL = process.env.PLANS_URL || LINKS.basic;

const WELCOME_GREETING =
  "Welcome to Breadcrumbs! Text me anything you're working on and I'll hold it — " +
  'say "where was i" anytime to get it back. You\'re on a free trial: 25 texts. ' +
  `Msg & data rates may apply. How it works: ${HOWTO_URL} · Plans: ${PLANS_URL}`;

const WELCOME_SAVED =
  "Saved — and welcome to Breadcrumbs! Text me anything on your mind and I'll hold " +
  'it; say "where was i" to get it back. Free trial: 25 texts. Msg & data rates may ' +
  `apply. How it works: ${HOWTO_URL} · Plans: ${PLANS_URL}`;

const RECALL_RE = /\b(where was i|where am i|what was i doing|what am i working on|what was i working on|recap|catch me up|bring me back|what did i have)\b/i;

const STOP_KEYWORDS = new Set(['STOP', 'CANCEL', 'UNSUBSCRIBE', 'QUIT', 'END']);

// Tokens that carry no recallable content. A message made up ENTIRELY of these
// (greetings, acknowledgments, politeness) is not a breadcrumb — we stay silent.
const FILLER_TOKENS = new Set([
  'hi', 'hii', 'hiii', 'hey', 'heya', 'hello', 'helo', 'yo', 'sup', 'hiya',
  'howdy', 'gm', 'morning', 'afternoon', 'evening', 'night', 'day', 'there',
  'ok', 'okay', 'okey', 'k', 'kk', 'kay', 'alright', 'aight',
  'thanks', 'thank', 'thx', 'ty', 'tysm', 'tx', 'you', 'u',
  'no', 'nope', 'nah', 'yes', 'yeah', 'yep', 'yup', 'ya',
  'sure', 'cool', 'nice', 'great', 'awesome', 'perfect', 'good', 'word', 'bet',
  'sounds', 'sound', 'will', 'do', 'done', 'got', 'it', 'np', 'please', 'pls',
  'lol', 'lmao', 'haha', 'hah', 'hehe', 'cheers', 'ditto',
]);

function normalize(s) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // strip punctuation + emoji
    .replace(/\s+/g, ' ')
    .trim();
}

// True when the whole message is filler. Capped at 5 tokens so a longer line
// that happens to be common words still saves.
function isContentless(body) {
  const n = normalize(body);
  if (!n) return true; // emoji-only / punctuation-only
  const tokens = n.split(' ');
  if (tokens.length > 5) return false;
  return tokens.every((t) => FILLER_TOKENS.has(t));
}

function titleTier(t) {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

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

function captureAck(gist) {
  if (gist) {
    return pick([
      `Got it — ${gist}. Saved.`,
      `Saved: ${gist}.`,
      `${gist} — got it down.`,
      `${gist} — saved. Pick it up whenever.`,
      `Saved ${gist}. It'll be here.`,
    ]);
  }
  return pick([
    'Got it. Saved.',
    "Saved — it'll be here.",
    'Noted — saved.',
    'Saved. Come back whenever.',
    'Got it down.',
  ]);
}

function recallFallback(labels) {
  if (labels.length === 1) {
    return `You left off on ${labels[0]}. Anything else to hold onto?`;
  }
  const shown = labels.slice(0, 5);
  const overflow = labels.length > 5 ? ` (5 of ${labels.length})` : '';
  return `A few going${overflow}, most recent first: ${shown.join(', ')}. Want me to add anything?`;
}

const RECALL_SYSTEM = `You are the voice of Breadcrumbs, an SMS tool that holds someone's place while they switch tasks. They just texted asking where they left off. You're given their saved notes, most recent first. Reply with ONE short SMS that reorients them.

Voice: warm, relaxed, and unhurried, but composed — not overly casual. Use proper sentence case: capitalize "I" and the first letter of each sentence. Contractions and fragments are fine. No emoji. No hype, no "let's go", no exclamation-point energy.

Rules:
- lead with the actual substance of what they were doing
- if there are several notes, weave them into one line, most recent first
- end with an open, optional offer — never tell them what to do, never imply they should get back to work. Think "Anything else to hold onto?" or "Want me to add anything?", and vary it every time
- 1-2 lines max, always SMS-length
- never write "You were working on:" and never echo a bulleted list
- never use directive or back-to-work closers like "back to it?", "pick it up", "that's the thread", "go", or "you're good"
- never invent anything that isn't in the notes`;

// Has this number ever been seen before? (Any users row.)
async function isFirstTimer(supabase, from) {
  const { data } = await supabase
    .from('users')
    .select('phone_number')
    .eq('phone_number', from)
    .limit(1);
  return !data || data.length === 0;
}

// Create the users row on first contact (status 'trial', recap defaults from the
// column defaults). Idempotent — never clobbers an existing row.
async function markSeen(supabase, from) {
  await supabase
    .from('users')
    .upsert(
      { phone_number: from, status: 'trial' },
      { onConflict: 'phone_number', ignoreDuplicates: true }
    );
}

async function resolveAccess(supabase, from) {
  if (COMP_NUMBERS.has(from)) {
    return { tier: 'comp', cap: Infinity, periodKey: null, isComp: true };
  }

  const { data: sub } = await supabase
    .from('users')
    .select('tier, status, current_period_start')
    .eq('phone_number', from)
    .maybeSingle();

  if (sub && sub.status === 'active' && TIER_CAPS[sub.tier]) {
    const periodKey = sub.current_period_start
      ? String(sub.current_period_start)
      : new Date().toISOString().slice(0, 7);
    return { tier: sub.tier, cap: TIER_CAPS[sub.tier], periodKey, isComp: false };
  }

  return { tier: 'trial', cap: TIER_CAPS.trial, periodKey: 'trial', isComp: false };
}

async function applyUsageGate(supabase, from, access) {
  if (access.isComp) {
    return { block: false, suppressReply: false, warningSuffix: '' };
  }

  const { data, error } = await supabase.rpc('increment_usage', {
    p_phone: from,
    p_period: access.periodKey,
    p_reset_after_days: access.tier === 'trial' ? TRIAL_RESET_DAYS : null,
  });
  if (error) {
    console.error('USAGE INCREMENT FAILED — failing open:', error.message);
    return { block: false, suppressReply: false, warningSuffix: '' };
  }

  const row = Array.isArray(data) ? data[0] : data;
  const count = row ? row.new_count : 1;
  const warned90 = row ? row.was_warned_90 : false;
  const warnedOver = row ? row.was_warned_over : false;

  const { tier, cap, periodKey } = access;

  if (tier === 'unlimited') {
    if (count > UNLIMITED_KILL) {
      console.error(`UNLIMITED HARD KILL for ${from}: count=${count} (>${UNLIMITED_KILL}). Dropping — no save, no reply. FLAGGED for review.`);
      return { drop: true };
    }
    if (count > cap) {
      console.error(`UNLIMITED BACKSTOP HIT for ${from}: count=${count} (>${cap}). Suppressing reply, still saving.`);
      return { block: false, suppressReply: true, warningSuffix: '' };
    }
    return { block: false, suppressReply: false, warningSuffix: '' };
  }

  const remaining = cap - count;
  const threshold90 = Math.floor(cap * 0.9);

  if (count > cap) {
    if (tier === 'trial') {
      return {
        block: true,
        blockReply: `That's your 25 free texts — and Breadcrumbs is clearly your thing. Grab Basic to keep going (200/mo): ${LINKS.basic}`,
      };
    }
    if (!warnedOver) {
      await supabase.from('usage').update({ warned_over: true })
        .eq('phone_number', from).eq('period_key', periodKey);
      const nextLink = tier === 'basic' ? LINKS.pro : LINKS.unlimited;
      const nextName = tier === 'basic' ? 'Pro' : 'Unlimited';
      return {
        block: false,
        suppressReply: false,
        warningSuffix: ` Heads up — you're past ${titleTier(tier)} for the month. Still holding everything. ${nextName} has way more room if you want it: ${nextLink}`,
      };
    }
    return { block: false, suppressReply: false, warningSuffix: '' };
  }

  if (count >= threshold90 && !warned90) {
    await supabase.from('usage').update({ warned_90: true })
      .eq('phone_number', from).eq('period_key', periodKey);
    const where = tier === 'trial' ? 'on your free trial' : `on ${titleTier(tier)} this month`;
    return {
      block: false,
      suppressReply: false,
      warningSuffix: ` (Heads up: ~${remaining} left ${where}.)`,
    };
  }

  return { block: false, suppressReply: false, warningSuffix: '' };
}

exports.handler = async (event) => {
  const signature = event.headers['x-twilio-signature'] || '';
  const url = event.rawUrl || `https://${event.headers.host}${event.path}`;
  const params = Object.fromEntries(new URLSearchParams(event.body));

  if (!twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, params)) {
    return { statusCode: 403, body: 'Forbidden' };
  }

  const from = params.From;
  const body = (params.Body || '').trim();

  if (!body || !from) return emptyTwiml();

  if (STOP_KEYWORDS.has(body.toUpperCase())) {
    return emptyTwiml();
  }

  if (body.toUpperCase() === 'HELP') {
    return twimlReply(
      "Breadcrumbs holds what you're working on so you can pick it back up. " +
      'Text anything to save it. Text "where was i" to get it back. Text STOP to quit.'
    );
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const isRecall = RECALL_RE.test(body);
  let welcomeOnSave = false;

  // First-timer welcome + filler silence (capture path only — recall is its own thing).
  if (!isRecall) {
    const first = await isFirstTimer(supabase, from);
    if (first) {
      await markSeen(supabase, from); // create their users row either way
      if (isContentless(body)) {
        // Just a "hi" — welcome them, don't save.
        return twimlReply(WELCOME_GREETING);
      }
      // A real first breadcrumb — welcome AND save it.
      welcomeOnSave = true;
    } else if (isContentless(body)) {
      // Existing user being polite ("ok thanks", "no", "k") — stay silent.
      return emptyTwiml();
    }
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const access = await resolveAccess(supabase, from);
  const gate = await applyUsageGate(supabase, from, access);

  if (gate.block) {
    return twimlReply(gate.blockReply);
  }
  if (gate.drop) {
    return emptyTwiml();
  }

  // --- Recall branch ---
  if (isRecall) {
    if (gate.suppressReply) return emptyTwiml();

    const { data: rows } = await supabase
      .from('breadcrumbs')
      .select('encrypted_message, last_updated_at')
      .eq('phone_number', from)
      .eq('status', 'active')
      .order('last_updated_at', { ascending: false });

    if (!rows || rows.length === 0) {
      return twimlReply(
        "Nothing saved right now. Text me what you're working on and I'll hold it for you."
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
        "I have things saved for you but couldn't read them. Text me what you're working on to start fresh."
      );
    }

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
      console.error('RECALL CLAUDE FAILED — using template fallback:', err.message);
      recap = recallFallback(labels);
    }

    return twimlReply(recap + gate.warningSuffix);
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
    console.error('PARSE CLAUDE FAILED — storing raw fallback:', err.message);
    parsedData.what_working_on = body;
  }

  const encryptedMessage = encrypt(parsedData);

  const { error } = await supabase
    .from('breadcrumbs')
    .insert({ phone_number: from, encrypted_message: encryptedMessage });
  if (error) console.error('Supabase insert error:', error);

  if (gate.suppressReply) return emptyTwiml();

  // First real breadcrumb gets the welcome; everything after gets the normal ack.
  if (welcomeOnSave) {
    return twimlReply(WELCOME_SAVED);
  }

  const gist = parseOk && parsedData.gist ? String(parsedData.gist).toLowerCase() : null;
  return twimlReply(captureAck(gist) + gate.warningSuffix);
};
