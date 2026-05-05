import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Parser from 'rss-parser';
import Stripe from 'stripe';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const app = express();
const PORT = Number(process.env.PORT || 8080);

const FRONTEND_URL = (process.env.FRONTEND_URL || '').trim();
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || FRONTEND_URL || '').trim();

const STRIPE_SECRET_KEY = (process.env.STRIPE_SECRET_KEY || '').trim();
const STRIPE_WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
const STRIPE_PRICE_MONTHLY = (process.env.STRIPE_PRICE_MONTHLY || '').trim();
const STRIPE_PRICE_ANNUAL = (process.env.STRIPE_PRICE_ANNUAL || '').trim();

const NEWS_CACHE_TTL_MS = 15 * 60 * 1000;
const parser = new Parser({ timeout: 10000 });
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const DEFAULT_FEEDS = [
  process.env.TWW_NEWS_FEED_1 || 'https://news.google.com/rss/search?q=OpenAI%20OR%20Anthropic%20OR%20%22Google%20DeepMind%22%20OR%20Mistral%20OR%20%22Meta%20AI%22%20when%3A7d&hl=en-US&gl=US&ceid=US:en',
  process.env.TWW_NEWS_FEED_2 || 'https://news.google.com/rss/search?q=%22artificial%20intelligence%22%20OR%20%22AI%20agents%22%20OR%20%22large%20language%20model%22%20when%3A7d&hl=en-US&gl=US&ceid=US:en'
].filter(Boolean);

let newsCache = {
  expiresAt: 0,
  payload: null
};

function isPlaceholder(value) {
  return !value || value.includes('YOUR_') || value.includes('example') || value.includes('sk_test_xxx');
}

function buildCorsOptions() {
  if (!ALLOWED_ORIGIN) {
    return { origin: true, credentials: false };
  }

  return {
    origin(origin, callback) {
      if (!origin || origin === ALLOWED_ORIGIN) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed.`));
    }
  };
}

app.use(cors(buildCorsOptions()));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    stripe: !!stripe,
    firebase: !!getDb(),
    feeds: DEFAULT_FEEDS.length
  });
});

app.get('/api/ai-news', async (req, res) => {
  try {
    const limit = clampNumber(req.query.limit, 1, 12, 6);
    const payload = await getCachedNews(limit);
    res.json(payload);
  } catch (error) {
    console.error('GET /api/ai-news failed:', error);
    res.status(500).json({ error: error.message || 'Could not load AI news.' });
  }
});

app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || isPlaceholder(STRIPE_WEBHOOK_SECRET)) {
    res.status(500).send('Stripe webhook is not configured.');
    return;
  }

  const signature = req.headers['stripe-signature'];

  if (!signature) {
    res.status(400).send('Missing Stripe signature header.');
    return;
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    console.error('Stripe webhook signature verification failed:', error.message);
    res.status(400).send(`Webhook Error: ${error.message}`);
    return;
  }

  try {
    await handleStripeEvent(event);
    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook handler failed:', error);
    res.status(500).json({ error: error.message || 'Webhook handling failed.' });
  }
});

app.use(express.json());

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    if (!stripe) {
      res.status(500).json({ error: 'Stripe is not configured on the backend.' });
      return;
    }

    const { plan, firebaseUid, email, name } = req.body || {};
    const normalizedPlan = plan === 'annual' ? 'annual' : 'monthly';
    const priceId = normalizedPlan === 'annual' ? STRIPE_PRICE_ANNUAL : STRIPE_PRICE_MONTHLY;

    if (!priceId || isPlaceholder(priceId)) {
      res.status(500).json({ error: `Missing Stripe price ID for ${normalizedPlan} plan.` });
      return;
    }

    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Billing email is required.' });
      return;
    }

    if (!FRONTEND_URL || isPlaceholder(FRONTEND_URL)) {
      res.status(500).json({ error: 'FRONTEND_URL is not configured on the backend.' });
      return;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      allow_promotion_codes: true,
      client_reference_id: firebaseUid || email,
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${FRONTEND_URL}?checkout=success#checkout`,
      cancel_url: `${FRONTEND_URL}?checkout=cancel#checkout`,
      metadata: {
        firebaseUid: firebaseUid || '',
        email,
        name: name || '',
        plan: normalizedPlan
      },
      subscription_data: {
        metadata: {
          firebaseUid: firebaseUid || '',
          email,
          name: name || '',
          plan: normalizedPlan
        }
      }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('POST /api/create-checkout-session failed:', error);
    res.status(500).json({ error: error.message || 'Could not create checkout session.' });
  }
});

app.post('/api/create-billing-portal-session', async (req, res) => {
  try {
    if (!stripe) {
      res.status(500).json({ error: 'Stripe is not configured on the backend.' });
      return;
    }

    const { firebaseUid, email } = req.body || {};
    const profile = await findProfile({ firebaseUid, email });
    const stripeCustomerId = profile?.stripeCustomerId;

    if (!stripeCustomerId) {
      res.status(404).json({ error: 'No Stripe customer was found for this member yet.' });
      return;
    }

    if (!FRONTEND_URL || isPlaceholder(FRONTEND_URL)) {
      res.status(500).json({ error: 'FRONTEND_URL is not configured on the backend.' });
      return;
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${FRONTEND_URL}#checkout`
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('POST /api/create-billing-portal-session failed:', error);
    res.status(500).json({ error: error.message || 'Could not create billing portal session.' });
  }
});

app.listen(PORT, () => {
  console.log(`TWW backend running on http://localhost:${PORT}`);
});

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (Number.isNaN(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function getDb() {
  const projectId = (process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = (process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();

  if (!projectId || !clientEmail || !privateKey || isPlaceholder(projectId)) {
    return null;
  }

  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey
      })
    });
  }

  return getFirestore();
}

async function getCachedNews(limit) {
  const now = Date.now();

  if (newsCache.payload && newsCache.expiresAt > now) {
    return {
      ...newsCache.payload,
      items: newsCache.payload.items.slice(0, limit)
    };
  }

  const items = await fetchAndRankNews();

  newsCache = {
    expiresAt: now + NEWS_CACHE_TTL_MS,
    payload: {
      fetchedAt: new Date().toISOString(),
      items
    }
  };

  return {
    ...newsCache.payload,
    items: newsCache.payload.items.slice(0, limit)
  };
}

async function fetchAndRankNews() {
  const feeds = await Promise.all(DEFAULT_FEEDS.map(loadFeedSafely));
  const deduped = new Map();

  for (const feed of feeds) {
    for (const item of feed.items) {
      const link = normalizeLink(item.link);
      const key = link || `${item.title || ''}::${item.publishedAt || ''}`;
      if (!key) continue;
      if (!deduped.has(key)) deduped.set(key, item);
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime();
    })
    .slice(0, 12);
}

async function loadFeedSafely(feedUrl) {
  try {
    const feed = await parser.parseURL(feedUrl);

    return {
      source: feed.title || 'AI Feed',
      items: (feed.items || []).map((item) => normalizeFeedItem(feed.title || 'AI Feed', item))
    };
  } catch (error) {
    console.error(`Feed failed: ${feedUrl}`, error.message);
    return { source: feedUrl, items: [] };
  }
}

function normalizeFeedItem(feedTitle, item) {
  const title = cleanText(item.title || 'Untitled');
  const description = cleanText(item.contentSnippet || item.content || item.summary || '');
  const source = inferSource(item, feedTitle);
  const publishedAt = item.isoDate || item.pubDate || new Date().toISOString();
  const score = scoreNewsItem(title, description, source, publishedAt);

  return {
    title,
    link: normalizeLink(item.link),
    summary: description || 'Recent AI story.',
    source,
    publishedAt,
    tag: inferTag(title, source),
    score
  };
}

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLink(value) {
  return String(value || '').trim();
}

function inferSource(item, fallback) {
  if (item.creator) return cleanText(item.creator);
  if (item.source && typeof item.source === 'object' && item.source.name) return cleanText(item.source.name);
  if (item.source && typeof item.source === 'string') return cleanText(item.source);
  return cleanText(fallback || 'AI Feed');
}

function inferTag(title, source) {
  const haystack = `${title} ${source}`.toLowerCase();

  if (haystack.includes('openai')) return 'OpenAI';
  if (haystack.includes('anthropic')) return 'Anthropic';
  if (haystack.includes('deepmind') || haystack.includes('gemini') || haystack.includes('google')) return 'Google AI';
  if (haystack.includes('meta') || haystack.includes('llama')) return 'Meta AI';
  if (haystack.includes('mistral')) return 'Mistral';
  if (haystack.includes('agent')) return 'AI Agents';

  return 'AI';
}

function scoreNewsItem(title, description, source, publishedAt) {
  const haystack = `${title} ${description} ${source}`.toLowerCase();

  const signals = [
    ['openai', 12],
    ['anthropic', 12],
    ['deepmind', 10],
    ['google ai', 10],
    ['gemini', 8],
    ['meta ai', 8],
    ['llama', 7],
    ['mistral', 7],
    ['artificial intelligence', 6],
    ['large language model', 6],
    ['reasoning model', 6],
    ['ai agent', 6],
    ['model', 4],
    ['release', 3],
    ['launch', 3],
    ['research', 3]
  ];

  let total = 0;

  for (const [needle, points] of signals) {
    if (haystack.includes(needle)) total += points;
  }

  const publishedTime = new Date().getTime() - new Date(publishedAt || 0).getTime();

  if (!Number.isNaN(publishedTime) && publishedTime < 3 * 24 * 60 * 60 * 1000) {
    total += 5;
  }

  return total;
}

function mapStripeStatus(status) {
  switch (status) {
    case 'trialing':
    case 'active':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'unpaid':
      return 'unpaid';
    case 'canceled':
      return 'canceled';
    case 'incomplete':
      return 'pending';
    case 'incomplete_expired':
      return 'inactive';
    default:
      return status || 'inactive';
  }
}

async function handleStripeEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const subscriptionId = typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription?.id;

      let subscription = null;

      if (subscriptionId) {
        subscription = await stripe.subscriptions.retrieve(subscriptionId);
      }

      await upsertProfileFromStripe({
        session,
        subscription,
        fallbackStatus: 'active'
      });

      return;
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;

      await upsertProfileFromStripe({
        subscription,
        fallbackStatus: subscription.status || 'inactive'
      });

      return;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const subscriptionId = typeof invoice.subscription === 'string'
        ? invoice.subscription
        : invoice.subscription?.id;

      if (!subscriptionId) return;

      const subscription = await stripe.subscriptions.retrieve(subscriptionId);

      await upsertProfileFromStripe({
        subscription,
        fallbackStatus: 'past_due'
      });

      return;
    }

    default:
      return;
  }
}

async function upsertProfileFromStripe({ session = null, subscription = null, fallbackStatus = 'inactive' }) {
  const db = getDb();

  if (!db) {
    throw new Error('Firebase Admin is not configured. Add FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY.');
  }

  const sessionMetadata = session?.metadata || {};
  const subscriptionMetadata = subscription?.metadata || {};
  const metadata = { ...sessionMetadata, ...subscriptionMetadata };

  const stripeCustomerId = subscription?.customer || session?.customer || '';
  const stripeSubscriptionId = subscription?.id || (
    typeof session?.subscription === 'string'
      ? session.subscription
      : session?.subscription?.id
  ) || '';

  const stripePriceId = subscription?.items?.data?.[0]?.price?.id || '';
  const billingPeriod = metadata.plan || inferBillingPeriodFromPriceId(stripePriceId);
  const membershipStatus = mapStripeStatus(subscription?.status || fallbackStatus);

  const firebaseUid = (
    metadata.firebaseUid ||
    session?.client_reference_id ||
    subscriptionMetadata?.firebaseUid ||
    ''
  ).toString().trim();

  const email = (
    metadata.email ||
    session?.customer_details?.email ||
    session?.customer_email ||
    subscription?.customer_email ||
    ''
  ).toString().trim().toLowerCase();

  const fullName = (
    metadata.name ||
    session?.customer_details?.name ||
    ''
  ).toString().trim();

  let docRef = null;

  if (firebaseUid) {
    const direct = await db.collection('profiles').doc(firebaseUid).get();
    if (direct.exists) {
      docRef = direct.ref;
    }
  }

  if (!docRef && email) {
    const snap = await db.collection('profiles')
      .where('email', '==', email)
      .limit(1)
      .get();

    if (!snap.empty) {
      docRef = snap.docs[0].ref;
    }
  }

  if (!docRef && stripeCustomerId) {
    const snap = await db.collection('profiles')
      .where('stripeCustomerId', '==', stripeCustomerId)
      .limit(1)
      .get();

    if (!snap.empty) {
      docRef = snap.docs[0].ref;
    }
  }

  if (!docRef) {
    throw new Error(
      `Could not resolve a Firebase profile for the paid member. uid=${firebaseUid || 'none'} email=${email || 'none'} stripeCustomerId=${stripeCustomerId || 'none'}`
    );
  }

  await docRef.set({
    email,
    fullName,
    membershipStatus,
    accessLevel: membershipStatus === 'active' ? 'member' : 'free',
    billingProvider: 'stripe',
    stripeCustomerId,
    stripeSubscriptionId,
    stripePriceId,
    billingPeriod,
    updatedAt: new Date().toISOString(),
    paymentSyncedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

function inferBillingPeriodFromPriceId(priceId) {
  if (!priceId) return 'monthly';
  if (priceId === STRIPE_PRICE_ANNUAL) return 'annual';
  if (priceId === STRIPE_PRICE_MONTHLY) return 'monthly';
  return 'monthly';
}

async function findProfile({ firebaseUid, email }) {
  const db = getDb();

  if (!db) {
    throw new Error('Firebase Admin is not configured on the backend.');
  }

  if (firebaseUid) {
    const snap = await db.collection('profiles').doc(firebaseUid).get();
    if (snap.exists) return { id: snap.id, ...snap.data() };
  }

  if (email) {
    const snap = await db.collection('profiles')
      .where('email', '==', email)
      .limit(1)
      .get();

    if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
  }

  return null;
}
