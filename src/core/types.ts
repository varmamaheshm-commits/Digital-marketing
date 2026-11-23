export type VideoFormat = 'reel' | 'square' | 'wide';
export type VideoStyle = 'bold' | 'clean' | 'luxe';
export type Lang = 'en' | 'hi' | 'te' | 'ta';
export const LANG_NAMES: Record<Lang, string> = { en: 'English', hi: 'हिन्दी (Hindi)', te: 'తెలుగు (Telugu)', ta: 'தமிழ் (Tamil)' };
export type Presenter = 'none' | 'host-a' | 'host-b';
export const PRESENTER_NAMES: Record<Presenter, string> = { none: 'No presenter', 'host-a': 'Animated host - Asha', 'host-b': 'Animated host - Ravi' };
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

/** What the app measured in a reference video: its length, cut rhythm, colours and energy. */
export interface ReferenceLook {
  name: string;
  /** Length of the reference video in seconds. */
  seconds: number;
  format: VideoFormat;
  /** Length of each shot between cuts, in seconds. */
  shots: number[];
  /** Most common colours, most common first, as #rrggbb. */
  palette: string[];
  /** 0 (dark) to 1 (bright). */
  brightness: number;
  /** 0 (grey) to 1 (vivid). */
  saturation: number;
  /** 0 (still) to 1 (lots of movement). */
  motion: number;
}

export interface Video {
  id: string;
  productId: string;
  format: VideoFormat;
  lang?: Lang;
  /** `upload`: the owner's own recording, posted as it is. Absent / `generated`: created by the app. */
  source?: 'generated' | 'upload';
  /** True once the script-writer agent has rewritten the script. */
  aiScript?: boolean;
  /** Wanted length in seconds (10-30). The script's scene timings are stretched to it. */
  targetSeconds?: number;
  /** Animated on-screen host drawn by the app, and whether it speaks the script aloud. */
  presenter?: Presenter;
  voice?: boolean;
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
  /** Made in the style of a reference video the owner uploaded (only the measurements are kept, never its footage). */
  reference?: ReferenceLook;
  /** Colours taken from the reference video instead of the brand colours. */
  colors?: { primary: string; accent: string };
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
/** A still image for social posts and ads, drawn by the app from the product's photos. */
export type PosterFormat = 'square' | 'portrait' | 'story' | 'wide';
export type PosterTemplate = 'spotlight' | 'split' | 'offer';
export const POSTER_INFO: Record<PosterFormat, { label: string; w: number; h: number; use: string }> = {
  square: { label: 'Square 1:1', w: 1080, h: 1080, use: 'Instagram / Facebook feed, WhatsApp' },
  portrait: { label: 'Portrait 4:5', w: 1080, h: 1350, use: 'Instagram feed (largest on phones)' },
  story: { label: 'Story 9:16', w: 1080, h: 1920, use: 'Stories, WhatsApp status' },
  wide: { label: 'Link / ad 1.91:1', w: 1200, h: 628, use: 'Facebook & LinkedIn link posts, Google display ads' },
};
export interface Creative {
  id: string;
  productId: string;
  format: PosterFormat;
  template: PosterTemplate;
  headline: string;
  sub: string;
  badge: string;
  cta: string;
  seed: number;
  caption: string;
  hashtags: string[];
  /** queued -> pending / approved (approved directly unless the owner approves everything); failed on error */
  status: 'queued' | 'failed' | ApprovalStatus;
  error?: string;
  blobId?: string;
  createdAt: number;
  decidedAt?: number;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  text: string;
  createdAt: number;
}

export type SocialProvider = 'google' | 'meta' | 'linkedin' | 'x' | 'pinterest' | 'tiktok' | 'threads' | 'telegram';
export type SocialTarget = 'youtube' | 'instagram' | 'facebook' | 'linkedin' | 'x' | 'pinterest' | 'tiktok' | 'threads' | 'telegram';
/** What a destination accepts: videos (in these shapes), image posts (in these shapes) and text-only posts. */
export const TARGET_INFO: Record<SocialTarget, { label: string; provider: SocialProvider; formats: VideoFormat[]; images: PosterFormat[]; text: boolean }> = {
  youtube: { label: 'YouTube', provider: 'google', formats: ['wide', 'reel'], images: [], text: false },
  instagram: { label: 'Instagram', provider: 'meta', formats: ['reel'], images: ['square', 'portrait', 'wide'], text: false },
  facebook: { label: 'Facebook', provider: 'meta', formats: ['reel', 'wide', 'square'], images: ['square', 'portrait', 'wide', 'story'], text: true },
  linkedin: { label: 'LinkedIn', provider: 'linkedin', formats: ['wide', 'square', 'reel'], images: ['square', 'portrait', 'wide'], text: true },
  x: { label: 'X', provider: 'x', formats: ['wide', 'square', 'reel'], images: ['square', 'portrait', 'wide'], text: true },
  pinterest: { label: 'Pinterest', provider: 'pinterest', formats: [], images: ['portrait', 'story', 'square'], text: false },
  tiktok: { label: 'TikTok', provider: 'tiktok', formats: ['reel'], images: [], text: false },
  threads: { label: 'Threads', provider: 'threads', formats: [], images: [], text: true },
  telegram: { label: 'Telegram channel', provider: 'telegram', formats: ['reel', 'wide', 'square'], images: ['square', 'portrait', 'wide', 'story'], text: true },
};
/** A connected platform account. Stored only inside the encrypted vault. */
export interface SocialAccount {
  id: SocialProvider;
  clientId: string;
  clientSecret: string;
  organizationId?: string;
  /** Optional https:// relay page address, for platforms that refuse a plain localhost address. */
  redirectUri?: string;
  /** Meta only: ID of a Facebook Login for Business configuration that lists the permissions. */
  configId?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  name: string;
  extra: Record<string, any>;
  connectedAt: number;
  /** Per destination: post approved videos automatically, for which shapes, and only those approved after `since`. */
  targets: Partial<Record<SocialTarget, { auto: boolean; formats: VideoFormat[]; since: number; images?: boolean; posts?: boolean }>>;
}
export interface Publication {
  id: string;
  /** What is posted: an approved video (default), image post or text post. */
  kind?: 'video' | 'image' | 'post';
  /** The video id; for images and posts this is '' and `itemId` names the item. */
  videoId: string;
  itemId?: string;
  note?: string;
  target: SocialTarget;
  status: 'queued' | 'posting' | 'posted' | 'failed';
  url?: string;
  error?: string;
  retryable?: boolean;
  attempts: number;
  createdAt: number;
  triedAt?: number;
  postedAt?: number;
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
    videoSeconds: number;
    presenter: Presenter;
    voice: boolean;
    postsPerWeek: number;
    followUpDays: number;
  };
  security: { autoLockMinutes: number; keepWorking: boolean };
  /** AI agents, powered by a language model running on the owner's own PC. */
  ai: { enabled: boolean; model: string; agents: { scripts: boolean; posts: boolean; leads: boolean; answers: boolean } };
  /** Phone link and automation API served by the desktop app on the local network. */
  link: { enabled: boolean; code: string; port: number; webhookUrl: string };
  /** Lead capture pages: where their form sends enquiries (an n8n webhook), and the WhatsApp number shown on them. */
  capture: { formUrl: string; whatsapp: string };
  /** Website used for SEO texts and tracked links. */
  seo: { siteUrl: string; city: string };
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
  accounts: SocialAccount;
  publications: Publication;
  images: Creative;
  settings: Settings;
}
export type Col = keyof Collections;
export const COLS: Col[] = ['products', 'videos', 'posts', 'leads', 'messages', 'campaigns', 'activity', 'knowledge', 'accounts', 'publications', 'images', 'settings'];

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
    videoSeconds: 20,
    presenter: 'host-a',
    voice: true,
    postsPerWeek: 4,
    followUpDays: 3,
  },
  security: { autoLockMinutes: 10, keepWorking: false },
  ai: { enabled: false, model: '', agents: { scripts: true, posts: true, leads: true, answers: true } },
  link: { enabled: false, code: '', port: 53683, webhookUrl: '' },
  capture: { formUrl: '', whatsapp: '' },
  seo: { siteUrl: '', city: '' },
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
