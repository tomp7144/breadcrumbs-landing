const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  // 1. Only accept POST requests from Twilio
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // 2. Parse the incoming text message data
    const params = new URLSearchParams(event.body);
    const incomingNumber = params.get('From');
    const messageText = params.get('Body');

    // 3. Connect to the Supabase Brain
    const supabase = createClient(
      process.env.SUPABASE_URL, 
      process.env.SUPABASE_ANON_KEY
    );

    // 4. Ensure the user exists in the system (Ignore if they already do)
    await supabase
      .from('users')
      .upsert({ phone_number: incomingNumber }, { ignoreDuplicates: true });

    // 5. Save the actual task into the Breadcrumbs table
    await supabase
      .from('breadcrumbs')
      .insert({
        phone_number: incomingNumber,
        message: messageText
      });

    // 6. Build the XML reply for Twilio to send back to your phone
    const xmlResponse = `
      <?xml version="1.0" encoding="UTF-8"?>
      <Response>
          <Message>Breadcrumb saved: "${messageText}"</Message>
      </Response>
    `.trim();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/xml' },
      body: xmlResponse
    };

  } catch (error) {
    console.error('Error saving breadcrumb:', error);
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};