const { createClient } = require('@supabase/supabase-js');
const { Twilio } = require('twilio');

exports.handler = async (event, context) => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const twilio = new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

  // Find tasks where due_date is in the past, reminder hasn't been sent yet
  const { data: dueTasks } = await supabase
    .from('breadcrumbs')
    .select('*')
    .eq('is_reminder', true)
    .lt('due_date', new Date().toISOString())
    .eq('reminder_sent', false);

  for (const task of dueTasks) {
    // Send the text
    await twilio.messages.create({
      body: `REMINDER: ${task.message}`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: task.phone_number
    });

    // Mark as sent
    await supabase.from('breadcrumbs').update({ reminder_sent: true }).eq('id', task.id);
  }

  return { statusCode: 200 };
};