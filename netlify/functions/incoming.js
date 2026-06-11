const { createClient } = require('@supabase/supabase-js');
const { Anthropic } = require('@anthropic-ai/sdk');

exports.handler = async (event, context) => {
  const params = new URLSearchParams(event.body);
  const incomingNumber = params.get('From');
  const messageText = params.get('Body').trim();
  const lowerMessage = messageText.toLowerCase();

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // 1. Get or Create User
  const { data: user } = await supabase
    .from('users')
    .upsert({ phone_number: incomingNumber }, { onConflict: 'phone_number' })
    .select()
    .single();

  // 2. COMMANDS (Upgrade / List / Help)
  if (lowerMessage === 'upgrade') {
    return { statusCode: 200, headers: { 'Content-Type': 'text/xml' }, body: `<Response><Message>Go here to go Pro ($19): https://buy.stripe.com/00w4gs5wjf0g4Yyd5j6Ri01</Message></Response>` };
  }

  if (lowerMessage === 'list') {
    if (user.status !== 'pro') return { statusCode: 200, headers: { 'Content-Type': 'text/xml' }, body: `<Response><Message>You are on a trial. Text "upgrade" to get full access.</Message></Response>` };
    const { data: tasks } = await supabase.from('breadcrumbs').select('message').eq('phone_number', incomingNumber).eq('status', 'pending');
    const taskList = tasks.length > 0 ? tasks.map((t, i) => `${i + 1}. ${t.message}`).join('\n') : "No pending tasks.";
    return { statusCode: 200, headers: { 'Content-Type': 'text/xml' }, body: `<Response><Message>${taskList}</Message></Response>` };
  }

  if (['help', 'start', 'menu'].includes(lowerMessage)) {
    return {
      statusCode: 200, 
      headers: { 'Content-Type': 'text/xml' }, 
      body: `<Response><Message>Welcome to Breadcrumbs! Text me any task to save it. Commands: "list" (view tasks), "upgrade" (Pro access).</Message></Response>` 
    };
  }

  // 3. AI PROCESSING (The "Brain")
  const aiResponse = await anthropic.messages.create({
    model: "claude-3-haiku-20240307",
    max_tokens: 100,
    messages: [{ role: "user", content: `Format this task for a to-do list, keep it concise: "${messageText}"` }]
  });
  const processedTask = aiResponse.content[0].text.trim();

  // 4. DEFAULT: Save AI-processed task
  await supabase.from('breadcrumbs').insert({
    phone_number: incomingNumber,
    message: processedTask
  });

  return { statusCode: 200, headers: { 'Content-Type': 'text/xml' }, body: `<Response><Message>Breadcrumb saved: "${processedTask}"</Message></Response>` };
};