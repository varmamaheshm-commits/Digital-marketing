/**
 * Built-in copywriter. Template + seeded-variation based so it runs fully
 * offline with no outside AI service, and the same seed always gives the same text.
 */
import type { Lang, Lead, Message, Platform, Product, ScriptScene, Settings } from './types';

export function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, list: T[]): T => list[Math.floor(r() * list.length) % list.length];
const fill = (tpl: string, vars: Record<string, string>) =>
  tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '').replace(/\s+/g, ' ').trim();
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…');

type Tone = Settings['tone'];
const HOOKS: Record<Tone, string[]> = {
  friendly: ['Meet {name}', 'You are going to love this', 'Say hello to {name}', 'Looking for the perfect {category}?', 'This one is for you'],
  professional: ['Introducing {name}', 'The smarter choice in {category}', '{name}. Built to perform.', 'Raise your standard'],
  energetic: ['Stop scrolling!', 'This changes everything', '{name} is here!', 'Wait till you see this', 'You need this. Now.'],
  luxury: ['Discover {name}', 'Elegance, redefined', 'Crafted for those who know', 'The art of {category}'],
};
const CTAS: Record<Tone, string[]> = {
  friendly: ['Order yours today', 'Get yours now', 'Message us to order'],
  professional: ['Enquire today', 'Get a quote now', 'Contact us today'],
  energetic: ['Grab yours now!', 'Order now!', "Don't miss out!"],
  luxury: ['Reserve yours', 'Experience it today', 'Enquire privately'],
};
const GENERIC_FEATURES = ['Quality you can trust', 'Made to last', 'Loved by our customers', 'Great value for money'];
const OPENERS: Record<Tone, string[]> = {
  friendly: ['We made something special for you.', 'Here is something you will love.', 'Your new favourite just arrived.'],
  professional: ['A better way to get results.', 'Designed with care, delivered with confidence.', 'Performance you can rely on.'],
  energetic: ['Big news!', 'It is finally here!', 'Ready for an upgrade?'],
  luxury: ['Some things are simply made better.', 'For those who appreciate the finer details.', 'Refined. Timeless. Yours.'],
};

/** Fixed video phrases for other languages. The product's own text is used exactly as the owner typed it. */
const PHRASES: Record<Exclude<Lang, 'en'>, { hooks: string[]; ctas: string[]; forWhom: string; bestPrice: string; limited: string; generic: string[] }> = {
  hi: {
    hooks: ['पेश है {name}', 'यह आपको ज़रूर पसंद आएगा', '{name} अब उपलब्ध है'],
    ctas: ['आज ही ऑर्डर करें', 'अभी खरीदें', 'ऑर्डर के लिए मैसेज करें'],
    forWhom: '{audience} के लिए', bestPrice: 'आज की सबसे अच्छी कीमत', limited: 'सीमित समय के लिए',
    generic: ['भरोसेमंद गुणवत्ता', 'लंबे समय तक चलने वाला', 'ग्राहकों की पसंद', 'पैसे की पूरी कीमत'],
  },
  te: {
    hooks: ['{name} ను పరిచయం చేస్తున్నాం', 'ఇది మీకు తప్పకుండా నచ్చుతుంది', '{name} ఇప్పుడు అందుబాటులో ఉంది'],
    ctas: ['ఈరోజే ఆర్డర్ చేయండి', 'ఇప్పుడే కొనండి', 'ఆర్డర్ కోసం మెసేజ్ చేయండి'],
    forWhom: '{audience} కోసం', bestPrice: 'ఈరోజు ఉత్తమ ధర', limited: 'పరిమిత కాలం మాత్రమే',
    generic: ['నమ్మకమైన నాణ్యత', 'ఎక్కువ కాలం మన్నిక', 'కస్టమర్ల అభిమానం', 'డబ్బుకు తగిన విలువ'],
  },
  ta: {
    hooks: ['{name} அறிமுகம்', 'இது உங்களுக்கு நிச்சயம் பிடிக்கும்', '{name} இப்போது கிடைக்கிறது'],
    ctas: ['இன்றே ஆர்டர் செய்யுங்கள்', 'இப்போதே வாங்குங்கள்', 'ஆர்டருக்கு மெசேஜ் செய்யுங்கள்'],
    forWhom: '{audience} அனைவருக்கும்', bestPrice: 'இன்றைய சிறந்த விலை', limited: 'குறுகிய காலம் மட்டுமே',
    generic: ['நம்பகமான தரம்', 'நீண்ட காலம் உழைக்கும்', 'வாடிக்கையாளர்களின் விருப்பம்', 'பணத்திற்கு ஏற்ற மதிப்பு'],
  },
};

export function formatPrice(p: Product, s: Settings): string {
  const price = p.price.trim();
  if (!price) return '';
  return /^[\d.,\s]+$/.test(price) ? `${s.currency}${price}` : price;
}

export function productFeatures(p: Product, lang: Lang = 'en'): string[] {
  const own = p.features.map((f) => f.trim()).filter(Boolean);
  if (own.length) return own;
  const fromDesc = p.description
    .split(/[.!?\n]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 8 && x.length < 60);
  if (lang !== 'en') return PHRASES[lang].generic;
  return fromDesc.length ? fromDesc : GENERIC_FEATURES;
}

const firstSentence = (text: string) => (text.split(/[.!?\n]/)[0] ?? '').trim();

export function buildScript(p: Product, s: Settings, seed: number, lang: Lang = 'en'): ScriptScene[] {
  const r = rng(seed);
  const ph = lang === 'en' ? null : PHRASES[lang];
  const vars = { name: p.name, category: p.category || 'product', business: s.business.name };
  const scenes: ScriptScene[] = [];
  scenes.push({
    kind: 'hook',
    text: fill(pick(r, ph ? ph.hooks : HOOKS[s.tone]), vars),
    sub: p.audience ? (ph ? fill(ph.forWhom, { audience: p.audience }) : `For ${p.audience}`) : undefined,
    seconds: 2.6,
  });
  scenes.push({
    kind: 'reveal',
    text: p.name,
    sub: clip(firstSentence(p.description) || s.business.tagline || cap(vars.category), 70),
    seconds: 3,
  });
  const feats = productFeatures(p, lang);
  const start = Math.floor(r() * feats.length);
  for (let i = 0; i < Math.min(3, feats.length); i++) {
    scenes.push({ kind: 'feature', text: clip(cap(feats[(start + i) % feats.length]), 60), seconds: 2.6 });
  }
  const price = formatPrice(p, s);
  if (price || p.offer) {
    scenes.push({
      kind: 'offer',
      text: price || p.offer,
      sub: price ? p.offer || (ph ? ph.bestPrice : 'Best price today') : ph ? ph.limited : 'Limited time',
      seconds: 2.8,
    });
  }
  scenes.push({
    kind: 'cta',
    text: pick(r, ph ? ph.ctas : CTAS[s.tone]),
    sub: [s.business.name, s.business.phone || s.business.website].filter(Boolean).join('  ·  ') || undefined,
    seconds: 3.2,
  });
  return scenes;
}

export function buildHashtags(p: Product, s: Settings): string[] {
  const words = [p.name, p.category, ...p.keywords, s.business.name, s.business.city]
    .filter(Boolean)
    .map((w) => w.replace(/[^\p{L}\p{N} ]/gu, '').trim())
    .filter(Boolean);
  const tags = new Set<string>();
  for (const w of words) {
    const joined = w.split(/\s+/).map(cap).join('');
    if (joined.length > 1 && joined.length <= 30) tags.add('#' + joined);
  }
  if (p.category) tags.add('#' + p.category.replace(/[^\p{L}\p{N}]/gu, '') + 'Lovers');
  for (const g of ['#NewArrival', '#ShopNow', '#SmallBusiness', '#MustHave']) tags.add(g);
  return [...tags].filter((t) => t.length > 2).slice(0, 12);
}

export interface Copy {
  title: string;
  body: string;
  hashtags: string[];
}

export function buildCopy(p: Product, s: Settings, platform: Platform, seed: number): Copy {
  const r = rng(seed);
  const tags = buildHashtags(p, s);
  const feats = productFeatures(p).slice(0, 3);
  const price = formatPrice(p, s);
  const opener = pick(r, OPENERS[s.tone]);
  const cta = pick(r, CTAS[s.tone]);
  const contact = [s.business.phone && `Call / WhatsApp: ${s.business.phone}`, s.business.website].filter(Boolean).join('\n');
  const bullets = feats.map((f) => `✔ ${cap(f)}`).join('\n');
  const offer = [price && `Price: ${price}`, p.offer].filter(Boolean).join(' — ');
  const desc = p.description.trim();
  const biz = s.business.name || 'us';

  switch (platform) {
    case 'instagram':
      return {
        title: `${p.name} — Instagram post`,
        body: [`${opener} ${p.name} ✨`, desc && clip(desc, 180), bullets, offer, `${cta} 👉 ${s.business.phone || 'DM us'}`].filter(Boolean).join('\n\n'),
        hashtags: tags,
      };
    case 'facebook':
      return {
        title: `${p.name} — Facebook post`,
        body: [`${opener}`, `${p.name}${desc ? ' — ' + clip(desc, 240) : ''}`, bullets, offer, `${cta}.`, contact].filter(Boolean).join('\n\n'),
        hashtags: tags.slice(0, 5),
      };
    case 'youtube':
      return {
        title: clip(`${p.name} | ${cap(p.category || 'Product')} ${price ? '| ' + price : ''} | ${s.business.name}`.replace(/\|\s*$/, '').trim(), 95),
        body: [`${p.name} from ${biz}.`, desc, 'Highlights:\n' + bullets, offer, `${cta}:\n${contact || biz}`].filter(Boolean).join('\n\n'),
        hashtags: tags.slice(0, 8),
      };
    case 'whatsapp':
      return {
        title: `${p.name} — WhatsApp broadcast`,
        body: [`Hello! 👋 ${opener}`, `*${p.name}*`, bullets, offer, `Reply to this message to order. — ${biz}`].filter(Boolean).join('\n\n'),
        hashtags: [],
      };
    case 'email':
      return {
        title: clip(`${pick(r, ['Introducing', 'Now available:', 'Just for you:'])} ${p.name}${p.offer ? ' — ' + p.offer : ''}`, 80),
        body: [`Hello,`, `${opener} ${p.name}${desc ? ' — ' + desc : '.'}`, bullets, offer, `${cta}.`, contact, `Warm regards,\n${biz}`, 'You are receiving this because you asked to hear from us. Reply STOP to opt out.'].filter(Boolean).join('\n\n'),
        hashtags: [],
      };
    case 'ad':
      return {
        title: clip(`${p.name}${price ? ' — ' + price : ''}`, 40),
        body: [`Headline: ${clip(fill(pick(r, HOOKS[s.tone]), { name: p.name, category: p.category || 'product' }), 40)}`, `Primary text: ${clip(`${opener} ${feats.map(cap).join('. ')}.`, 125)}`, `Description: ${clip(offer || desc || p.name, 90)}`, `Button: ${cta}`, p.audience && `Suggested audience: ${p.audience}`].filter(Boolean).join('\n'),
        hashtags: [],
      };
  }
}

export function buildLeadMessage(
  lead: Lead,
  p: Product | undefined,
  s: Settings,
  reason: Message['reason'],
  seed: number,
): { subject: string; body: string } {
  const r = rng(seed);
  const first = lead.name.trim().split(/\s+/)[0] || 'there';
  const biz = s.business.name || 'our team';
  const about = p ? p.name : 'our products';
  const price = p ? formatPrice(p, s) : '';
  const sign = `\n\n— ${biz}${s.business.phone ? ', ' + s.business.phone : ''}`;
  if (reason === 'welcome') {
    return {
      subject: `Thank you for your interest in ${about}`,
      body:
        `Hi ${first}, thank you for your interest in ${about}! ` +
        pick(r, ['Happy to help with any questions.', 'I would love to help you choose the right option.', 'Tell me what you are looking for and I will sort it out.']) +
        (price ? ` It is available at ${price}${p?.offer ? ' (' + p.offer + ')' : ''}.` : '') +
        ' When is a good time to talk?' + sign,
    };
  }
  if (reason === 'offer') {
    return {
      subject: `A special offer on ${about}`,
      body: `Hi ${first}, good news — ${p?.offer || 'we have a special offer'} on ${about}${price ? ' at ' + price : ''}. Shall I reserve one for you?` + sign,
    };
  }
  return {
    subject: `Following up on ${about}`,
    body:
      `Hi ${first}, ` +
      pick(r, ['just checking in', 'a quick follow-up', 'hope you are doing well — following up']) +
      ` about ${about}. ` +
      pick(r, ['Do you have any questions I can answer?', 'Would you like me to share more details or photos?', 'Is it still something you are considering?']) +
      sign,
  };
}
