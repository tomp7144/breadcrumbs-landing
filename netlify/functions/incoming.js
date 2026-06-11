const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const params = new URLSearchParams(event.body);
  const incomingNumber = params.get('From');
  const messageText = params.get('Body').trim();
  const lowerMessage = messageText.toLowerCase();

  const supabase = createClient(
    process.env.SUPABASE_URL, 
    process.env.SUPABASE_ANON_KEY
  );

  // 1. Get or Create User
  const { data: user } = await supabase
    .from('users')
    .upsert({ phone_number: incomingNumber }, { onConflict: 'phone_number' })
    .select()
    .single();

  // 2. COMMAND: Upgrade
  if (lowerMessage === 'upgrade') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/xml' },
      body: `<Response><Message>Go here to go Pro ($19): https://buy.stripe.com/00w4gs5wjf0g4Yyd5j6Ri01</Message></Response>`
    };
  }

  // 3. COMMAND: List
  if (lowerMessage === 'list') {
    if (user.status !== 'pro') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/xml' },
        body: `<Response><Message>You are on a trial. Text "upgrade" to get full access to your tasks.</Message></Response>`
      };
    }
    
    const { data: tasks } = await supabase
      .from('breadcrumbs')
      .select('message')
      .eq('phone_number', incomingNumber)
      .eq('status', 'pending');

    const taskList = tasks.length > 0 
      ? tasks.map((t, i) => `${i + 1}. ${t.message}`).join('\n')
      : "No pending tasks.";

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/xml' },
      body: `<Response><Message>${taskList}</Message></Response>`
    };
  }

  // 4. DEFAULT: Save task
  await supabase.from('breadcrumbs').insert({
    phone_number: incomingNumber,
    message: messageText
  });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml' },
    body: `<Response><Message>Breadcrumb saved: "${messageText}"</Message></Response>`
  };
};