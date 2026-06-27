const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { Twilio } = require('twilio');

// Stripe product id -> Breadcrumbs tier. These are your three live products.
const PRODUCT_TO_TIER = {
  prod_UgEJlXJEMhu31O: 'basic',
  prod_UgEJrmrA5vDXns: 'pro',
  prod_Ukz1jbQewgvsX5: 'unlimited',
};

// Collapse Stripe's many subscription statuses into the three we store.
function mapStatus(s) {
  if (s === 'active' || s === 'trialing') return 'active';
  if (s === 'past_due' || s === 'unpaid') return 'past_due';
  return 'canceled'; // canceled, incomplete_expired, paused, etc.
}

function tierFromSubscription(sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  const product = item && item.price && item.price.product;
  return PRODUCT_TO_TIER[product] || null;
}

// current_period_start/end live on the subscription in most API versions, and
// on the subscription item in newer ones — handle both so this doesn't break
// on a Stripe version bump.
function periodFromSub(sub) {
  let start = sub.current_period_start;
  let end = sub.current_period_end;
  const item = sub.items && sub.items.data && sub.items.data[0];
  if (item) {
    if (start == null) start = item.current_period_start;
    if (end == null) end = item.current_period_end;
  }
  return {
    start: start ? new Date(start * 1000).toISOString() : null,
    end: end ? new Date(end * 1000).toISOString() : null,
  };
}

exports.handler = async (event) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  // Signature verification needs the RAW body, exactly as Stripe sent it.
  const sig = event.headers['stripe-signature'];
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('STRIPE SIGNATURE VERIFICATION FAILED:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    switch (stripeEvent.type) {
      // The money event — and the only one that knows the phone number, because
      // phone collection happens at checkout. Do the heavy lifting here so the
      // row is complete from this single event and doesn't depend on ordering.
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        if (session.mode !== 'subscription') break;

        const customerId = session.customer;
        const subscriptionId = session.subscription;

        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const tier = tierFromSubscription(sub);
        const period = periodFromSub(sub);

        // Phone is the join key. Prefer the phone collected on the session;
        // fall back to the customer record.
        let phone = session.customer_details && session.customer_details.phone;
        if (!phone && customerId) {
          const customer = await stripe.customers.retrieve(customerId);
          phone = customer && customer.phone;
        }

        if (!phone) {
          console.error(
            `checkout.session.completed ${session.id}: no phone (likely a wallet checkout). ` +
            `Cannot link to a Breadcrumbs number — no row created, no welcome text.`
          );
          break;
        }
        if (!tier) {
          console.error(`checkout.session.completed ${session.id}: unknown product on sub ${subscriptionId}.`);
          break;
        }

        const { error } = await supabase.from('users').upsert(
          {
            phone_number: phone,
            tier,
            status: mapStatus(sub.status),
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            current_period_start: period.start,
            current_period_end: period.end,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'phone_number' }
        );
        if (error) {
          console.error('subscriber upsert failed:', error);
          break;
        }

        // Welcome text = link confirmation + textability check in one. If this
        // silently fails to deliver, that's your signal the number didn't link
        // (e.g. a wallet checkout handed Stripe a number they don't text from).
        try {
          const twilioClient = new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          await twilioClient.messages.create({
            body: `You're on ${tier.charAt(0).toUpperCase() + tier.slice(1)} now — Breadcrumbs is unlocked. Text me whatever's on your mind and I'll hold it.`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: phone,
          });
        } catch (err) {
          console.error(`WELCOME TEXT FAILED for ${phone} — link may be unconfirmed:`, err.message);
        }
        break;
      }

      // Keep tier / status / billing period current on renewals, upgrades,
      // downgrades, and reactivations. Located by customer id.
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = stripeEvent.data.object;
        const tier = tierFromSubscription(sub);
        const period = periodFromSub(sub);

        const patch = {
          status: mapStatus(sub.status),
          current_period_start: period.start,
          current_period_end: period.end,
          updated_at: new Date().toISOString(),
        };
        if (tier) patch.tier = tier;

        const { data, error } = await supabase
          .from('users')
          .update(patch)
          .eq('stripe_customer_id', sub.customer)
          .select('phone_number');
        if (error) {
          console.error('subscription update failed:', error);
          break;
        }
        if (!data || data.length === 0) {
          // Normal if this lands before checkout.session.completed; that event
          // creates the row with the phone. Logged, not fatal.
          console.error(`subscription ${sub.id}: no row yet for customer ${sub.customer}.`);
        }
        break;
      }

      // Cancellation. Keep the row (history + period) but flip status; incoming.js
      // treats any non-active subscriber as trial.
      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;
        const { error } = await supabase
          .from('users')
          .update({ status: 'canceled', updated_at: new Date().toISOString() })
          .eq('stripe_customer_id', sub.customer);
        if (error) console.error('subscription cancel update failed:', error);
        break;
      }

      default:
        break; // Unhandled types are fine — just ack.
    }
  } catch (err) {
    console.error(`WEBHOOK HANDLER ERROR on ${stripeEvent.type}:`, err.message);
    // 500 so Stripe retries transient failures (network, brief DB blip).
    return { statusCode: 500, body: 'handler error' };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
