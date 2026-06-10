exports.handler = async (event, context) => {
  // Twilio sends data as a URL-encoded string. This decodes it.
  const params = new URLSearchParams(event.body);
  const incomingText = params.get('Body');
  const senderNumber = params.get('From');

  // Log it to your Netlify dashboard so you can see it working
  console.log(`Received: ${incomingText} from ${senderNumber}`);

  // The XML response that Twilio requires to send a text back
  const twiml = `
    <Response>
      <Message>system connected. you said: ${incomingText}</Message>
    </Response>
  `;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/xml',
    },
    body: twiml.trim(),
  };
};