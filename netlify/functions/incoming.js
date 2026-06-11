const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const params = new URLSearchParams(event.body);
  const incomingNumber = params.get('From');
  const messageText = params.get('Body').trim();

  const supabase = createClient(
    process.env.SUPABASE_URL, 
    process.env.SUPABASE_ANON_KEY
  );

  // Ensure user exists
  await supabase.from('users').upsert({ phone_number: incomingNumber }, { ignoreDuplicates: true });

  // COMMAND: List tasks
  if (messageText.toLowerCase() === 'list') {
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

  // DEFAULT: Save task
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