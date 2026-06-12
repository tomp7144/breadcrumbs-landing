const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

exports.handler = async (event, context) => {
  const params = new URLSearchParams(event.body);
  const incomingPhoneNumber = params.get('From');
  const incomingMessage = params.get('Body');

  if (!incomingMessage) {
    return { statusCode: 200, body: 'No message received' };
  }

  // Live Stripe Pro Link
  const PRO_UPGRADE_LINK = "https://buy.stripe.com/00w4gs5wjf0g4Yyd5j6Ri01"; 

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const currentLocalTime = new Date().toLocaleString("en-US", { timeZone: "America/Detroit" });

  const systemPrompt = `
  You are an intelligent data parser.
  The current date and local time is: ${currentLocalTime} (Eastern Time).

  Analyze the user's message. Determine if they are asking to be reminded. 
  Respond ONLY with a pure JSON object containing exactly these four keys:
  1. "message": The core task, note, or reminder text.
  2. "is_reminder": boolean true if they are asking for a reminder, false if it is just a note.
  3. "due_date": If is_reminder is true, calculate the exact requested time and output it as a valid UTC ISO-8601 string. If false, return null.
  4. "upgrade_needed": boolean true if they are requesting a Pro feature (like complex recurring reminders) that requires a premium tier, otherwise false.

  Do not include markdown formatting, backticks, or conversational text. Output pure JSON only.
  `;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-3-haiku-20240307", 
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: incomingMessage }]
    });

    const claudeText = msg.content[0].text;
    const parsedData = JSON.parse(claudeText);

    if (parsedData.upgrade_needed) {
      const upgradeMessage = `That feature requires Breadcrumbs Pro. Upgrade here to unlock it: ${PRO_UPGRADE_LINK}`;
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/xml' },
        body: `<Response><Message>${upgradeMessage}</Message></Response>`
      };
    }

    const { error } = await supabase
      .from('breadcrumbs')
      .insert([{
        phone_number: incomingPhoneNumber,
        message: parsedData.message,
        is_reminder: parsedData.is_reminder,
        due_date: parsedData.due_date,
        reminder_sent: false
      }]);

    if (error) {
      console.error("Supabase Error:", error);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/xml' },
      body: '<Response></Response>'
    };

  } catch (error) {
    console.error("Function Error:", error);
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};