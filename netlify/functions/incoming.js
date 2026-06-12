const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

exports.handler = async (event, context) => {
  // 1. Parse the incoming Twilio Webhook data
  const params = new URLSearchParams(event.body);
  const incomingPhoneNumber = params.get('From');
  const incomingMessage = params.get('Body');

  if (!incomingMessage) {
    return { statusCode: 200, body: 'No message received' };
  }

  // 2. Initialize your database and AI clients
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // 3. Set up the timezone and the strict JSON parser prompt
  const currentLocalTime = new Date().toLocaleString("en-US", { timeZone: "America/Detroit" });
  const systemPrompt = `
  You are an intelligent data parser.
  The current date and local time is: ${currentLocalTime} (Eastern Time).

  Analyze the user's message. Determine if they are asking to be reminded. 
  Respond ONLY with a pure JSON object containing exactly these three keys:
  1. "message": The core task, note, or reminder text.
  2. "is_reminder": boolean true if they are asking for a reminder, false if it is just a note.
  3. "due_date": If is_reminder is true, calculate the exact requested time and output it as a valid UTC ISO-8601 string. If false, return null.

  Do not include markdown formatting, backticks, or conversational text. Output pure JSON only.
  `;

  try {
    // 4. Send the text to Claude to process
    const msg = await anthropic.messages.create({
      model: "claude-3-haiku-20240307", 
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: incomingMessage }]
    });

    // 5. Parse the JSON that Claude sends back
    const claudeText = msg.content[0].text;
    const parsedData = JSON.parse(claudeText);

    // 6. Save the perfectly formatted data into Supabase
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

    // 7. Tell Twilio the message was received successfully so it doesn't error out
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