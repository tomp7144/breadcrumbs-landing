const { createClient } = require('@supabase/supabase-js');
const { Twilio } = require('twilio');
const { decrypt } = require('./lib/crypto');

exports.handler = async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const twilioClient = new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  // Step 1: Warn and archive active rows that have gone quiet for 14 days.
  const { data: staleActive } = await supabase
    .from('breadcrumbs')
    .select('*')
    .eq('status', 'active')
    .lt('last_updated_at', fourteenDaysAgo)
    .is('warned_at', null);

  for (const row of staleActive || []) {
    let summary = 'something you were working on';
    try {
      const parsed = decrypt(row.encrypted_message);
      // Prefer the short gist (set on capture); fall back for older rows that
      // predate the gist field.
      summary = parsed.gist || parsed.what_working_on || parsed.current_thought || summary;
    } catch (err) {
      console.error(`decrypt failed for row ${row.id}:`, err.message);
    }

    try {
      await twilioClient.messages.create({
        body: `clearing my desk — you left this here: "${summary}". i'll hang onto it a bit longer in case you need it.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: row.phone_number,
      });
    } catch (err) {
      console.error(`Twilio send failed for row ${row.id}:`, err.message);
    }

    const { error } = await supabase
      .from('breadcrumbs')
      .update({ status: 'archived', warned_at: now, archived_at: now })
      .eq('id', row.id);
    if (error) console.error(`archive update failed for row ${row.id}:`, error);
  }

  // Step 2: Hard-delete archived rows that have sat for another 14 days.
  // No message sent — the user already got their warning.
  const { data: staleArchived } = await supabase
    .from('breadcrumbs')
    .select('id')
    .eq('status', 'archived')
    .lt('archived_at', fourteenDaysAgo);

  for (const row of staleArchived || []) {
    const { error } = await supabase
      .from('breadcrumbs')
      .delete()
      .eq('id', row.id);
    if (error) console.error(`delete failed for row ${row.id}:`, error);
  }

  return { statusCode: 200 };
};
