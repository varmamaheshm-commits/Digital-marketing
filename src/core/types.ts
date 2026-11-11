export type VideoFormat = 'reel' | 'square' | 'wide';
export type VideoStyle = 'bold' | 'clean' | 'luxe';
export type Lang = 'en' | 'hi' | 'te' | 'ta';
export const LANG_NAMES: Record<Lang, string> = { en: 'English', hi: 'हिन्दी (Hindi)', te: 'తెలుగు (Telugu)', ta: 'தமிழ் (Tamil)' };
export type MusicMood = 'upbeat' | 'chill' | 'cinematic' | 'none';
/** Everything the app creates automatically waits in `pending` until the owner decides. */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Product {
  id: string;
  name: string;
  category: string;
  description: string;
  price: string;
  offer: string;
  features: string[];
  audience: string;
  keywords: string[];
  imageIds: string[];
  active: boolean;
  createdAt: number;
}

export type SceneKind = 'hook' | 'reveal' | 'feature' | 'offer' | 'cta';
export interface ScriptScene {
  kind: SceneKind;
  text: string;
  sub?: string;
  seconds: number;
}

export interface Video {
  id: string;
  productId: string;
  format: VideoFormat;
  lang?: Lang;
  style: VideoStyle;
  mood: MusicMood;
  seed: number;
  script: ScriptScene[];
  caption: string;
  hashtags: string[];
  title: string;
  /** queued -> rendering -> pending (awaiting owner) -> approved / rejected; failed on error */
  status: 'queued' | 'rendering' | 'failed' | ApprovalStatus;
  progress?: number;
  error?: string;
  blobId?: string;
  thumbId?: string;
  mime?: string;
  sizeBytes?: number;
  seconds?: number;
  codec?: string;
  note?: string;
  createdAt: number;
  decidedAt?: number;
}

export type Platform = 'instagram' | 'youtube' | 'facebook' | 'whatsapp' | 'email' | 'ad';
export interface Post {
  id: string;
  productId: string;
  platform: Platform;
  title: string;
  body: string;
  hashtags: string[];
  scheduledFor: number;
  status: ApprovalStatus | 'published';
  videoId?: string;
  note?: string;
  createdAt: number;
  decidedAt?: number;
}

export type LeadStage = 'new' | 'contacted' | 'qualified' | 'won' | 'lost';
export interface Lead {
  id: string;
  name: string;
  phone: string;
  email: string;
  source: string;
  productId?: string;
  stage: LeadStage;
  score: number;
  notes: string;
  consent: boolean;
  value: number;
  createdAt: number;
  lastContactAt?: number;
}

export interface Message {
  id: string;
  leadId: string;
  channel: 'whatsapp' | 'email' | 'sms';
  reason: 'welcome' | 'follow-up' | 'offer';
  subject: string;
  body: string;
  status: ApprovalStatus | 'sent';
  createdAt: number;
  decidedAt?: number;
}

export interface Campaign {
  id: string;
  name: string;
  productId?: string;
  goal: string;
  channels: Platform[];
  budget: number;
  start: number;
  end: number;
  status: 'draft' | 'active' | 'paused' | 'done';
  metrics: { impressions: number; clicks: number; leads: number; sales: number; spend: number; revenue: number };
  createdAt: number;
}

/** A document in the owner's private knowledge base (price lists, FAQs, policies …). */
export interface KnowledgeDoc {
  id: string;
  title: string;
  text: string;
  createdAt: number;
}

export interface Activity {
  id: string;
  at: number;
  kind: 'security' | 'auto' | 'owner' | 'system';
  text: string;
}

export interface Settings {
  id: 'main';
  business: { name: string; tagline: string; phone: string; website: string; city: string };
  brand: { primary: string; accent: string; logoId?: string };
  tone: 'friendly' | 'professional' | 'energetic' | 'luxury';
  currency: string;
  /** `videos`: only videos wait for the owner; posts and lead messages are approved automatically. */
  approvals: 'videos' | 'all';
  autopilot: {
    languages: Lang[];
    enabled: boolean;
    videoFormats: VideoFormat[];
    videoStyle: VideoStyle | 'auto';
    mood: MusicMood | 'auto';
    videoRefreshDays: number;
    postsPerWeek: number;
    followUpDays: number;
  };
  security: { autoLockMinutes: number };
}

export interface Collections {
  products: Product;
  videos: Video;
  posts: Post;
  leads: Lead;
  messages: Message;
  campaigns: Campaign;
  activity: Activity;
  knowledge: KnowledgeDoc;
  settings: Settings;
}
export type Col = keyof Collections;
export const COLS: Col[] = ['products', 'videos', 'posts', 'leads', 'messages', 'campaigns', 'activity', 'knowledge', 'settings'];

export const DEFAULT_SETTINGS: Settings = {
  id: 'main',
  business: { name: '', tagline: '', phone: '', website: '', city: '' },
  brand: { primary: '#6d28d9', accent: '#f59e0b' },
  tone: 'friendly',
  currency: '₹',
  approvals: 'videos',
  autopilot: {
    languages: ['en'],
    enabled: true,
    videoFormats: ['reel', 'wide'],
    videoStyle: 'auto',
    mood: 'auto',
    videoRefreshDays: 14,
    postsPerWeek: 4,
    followUpDays: 3,
  },
  security: { autoLockMinutes: 10 },
};

export const FORMAT_INFO: Record<VideoFormat, { label: string; w: number; h: number; use: string }> = {
  reel: { label: 'Vertical 9:16', w: 1080, h: 1920, use: 'Instagram Reels · YouTube Shorts · Stories' },
  square: { label: 'Square 1:1', w: 1080, h: 1080, use: 'Instagram / Facebook feed' },
  wide: { label: 'Widescreen 16:9', w: 1920, h: 1080, use: 'YouTube · website' },
};

export const uid = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};
