/**
 * Lead capture: a one-page offer site with an enquiry form, built from a product.
 * The page is a single self-contained HTML file (photo included) that the owner can put on
 * any web host, GitHub Pages, or share directly. Its form sends name, phone, email and the
 * person's consent to the owner's own n8n webhook, which adds the lead to Marketing Studio.
 * Without a form address the page still works: the button opens WhatsApp to the owner.
 */
import { formatPrice, productFeatures } from './copy';
import type { Product, Settings } from './types';

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Digits only, with India's country code added to 10-digit mobile numbers. */
export function waNumber(phone: string): string {
  const d = phone.replace(/\D/g, '').replace(/^00/, '');
  return d.length === 10 ? '91' + d : d;
}
export const whatsappLink = (phone: string, text: string) => `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(text)}`;

/** Adds standard campaign tags so visits from each post or poster can be told apart in web analytics. */
export function trackedLink(url: string, tags: { source: string; medium: string; campaign: string; content?: string }): string {
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url); } catch { return ''; }
  const set = (k: string, v?: string) => { const x = (v ?? '').trim().toLowerCase().replace(/\s+/g, '-'); if (x) u.searchParams.set(k, x); };
  set('utm_source', tags.source);
  set('utm_medium', tags.medium);
  set('utm_campaign', tags.campaign);
  set('utm_content', tags.content);
  return u.toString();
}

/** Only real web addresses may receive the form. */
export function validFormUrl(url: string): boolean {
  try { const u = new URL(url); return u.protocol === 'https:' || (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname)); } catch { return false; }
}

export function buildLandingPage(p: Product, s: Settings, opts: { photo?: string; source?: string } = {}): string {
  const brand = s.business.name || p.name;
  const primary = /^#[0-9a-f]{6}$/i.test(s.brand.primary) ? s.brand.primary : '#6d28d9';
  const accent = /^#[0-9a-f]{6}$/i.test(s.brand.accent) ? s.brand.accent : '#f59e0b';
  const features = productFeatures(p).slice(0, 5);
  const price = p.price ? formatPrice(p, s) : '';
  const formUrl = validFormUrl(s.capture.formUrl) ? s.capture.formUrl : '';
  const wa = waNumber(s.capture.whatsapp || s.business.phone);
  const source = (opts.source || 'lead page').slice(0, 60);
  const photo = opts.photo && /^data:image\/(jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(opts.photo) ? opts.photo : '';
  const cfg = JSON.stringify({ formUrl, wa, product: p.name, source, waText: `Hi ${brand}, I am interested in ${p.name}.` }).replace(/</g, '\\u003c');
  const connect = formUrl ? new URL(formUrl).origin : "'none'";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ${connect}; form-action 'none'; base-uri 'none'">
<title>${esc(p.name)} | ${esc(brand)}</title>
<meta name="description" content="${esc((p.description || features.join(', ')).slice(0, 155))}">
<meta property="og:title" content="${esc(p.name)}">
<style>
:root{--p:${primary};--a:${accent};font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1f2433}
*{box-sizing:border-box}body{margin:0;background:#f6f7fb}
.hero{background:linear-gradient(135deg,var(--p),#111827);color:#fff;padding:28px 18px 40px}
.wrap{max-width:980px;margin:auto}.brand{font-weight:800;opacity:.9;margin-bottom:18px}
.grid{display:grid;gap:24px;align-items:center}@media(min-width:760px){.grid{grid-template-columns:1.1fr 1fr}}
h1{font-size:clamp(1.8rem,5vw,2.8rem);line-height:1.1;margin:0 0 12px}.lead{font-size:1.1rem;opacity:.92;margin:0 0 16px}
.price{display:inline-block;background:var(--a);color:#111;font-weight:800;border-radius:999px;padding:8px 16px;margin-right:8px}
.offer{display:inline-block;margin-top:8px;font-weight:700}
img{width:100%;border-radius:18px;box-shadow:0 20px 50px rgba(0,0,0,.35);background:#fff}
ul{padding-left:20px;margin:14px 0}li{margin:6px 0}
.card{background:#fff;border-radius:18px;padding:22px;box-shadow:0 10px 30px rgba(17,24,39,.08);margin:-26px auto 26px;max-width:560px;position:relative}
label{display:block;font-weight:600;margin:12px 0 6px}input,textarea{width:100%;font:inherit;padding:12px 14px;border:1px solid #d5d9e4;border-radius:12px}
textarea{min-height:80px}.consent{display:flex;gap:10px;align-items:flex-start;font-weight:400;font-size:.92rem}.consent input{width:auto;margin-top:3px}
button,.wa{display:block;width:100%;text-align:center;font:inherit;font-weight:800;border:0;border-radius:12px;padding:14px;margin-top:16px;cursor:pointer;text-decoration:none}
button{background:var(--p);color:#fff}.wa{background:#1fa855;color:#fff}.hp{position:absolute;left:-9999px}
.msg{margin-top:12px;padding:12px;border-radius:12px;display:none}.ok{display:block;background:#e7f7ee;color:#166534}.bad{display:block;background:#fdecec;color:#991b1b}
footer{text-align:center;color:#6b7280;font-size:.85rem;padding:0 16px 30px}
</style></head><body>
<section class="hero"><div class="wrap">
<div class="brand">${esc(brand)}</div>
<div class="grid"><div>
<h1>${esc(p.name)}</h1>
<p class="lead">${esc(p.description || (features[0] ?? ''))}</p>
${price ? `<span class="price">${esc(price)}</span>` : ''}${p.offer ? `<span class="offer">${esc(p.offer)}</span>` : ''}
${features.length ? `<ul>${features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
</div>${photo ? `<div><img src="${photo}" alt="${esc(p.name)}"></div>` : ''}</div>
</div></section>
<form class="card" id="f" novalidate>
<h2 style="margin:0 0 4px">Get the best price</h2><p style="margin:0;color:#6b7280">Leave your details and we will get back to you quickly.</p>
<label for="n">Your name</label><input id="n" name="name" autocomplete="name" maxlength="120" required>
<label for="ph">Phone / WhatsApp</label><input id="ph" name="phone" type="tel" autocomplete="tel" maxlength="40" inputmode="tel">
<label for="em">Email</label><input id="em" name="email" type="email" autocomplete="email" maxlength="160">
<label for="m">Message (optional)</label><textarea id="m" name="message" maxlength="1000"></textarea>
<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<label class="consent"><input type="checkbox" id="c" name="consent" value="true"> I agree that ${esc(brand)} may contact me about this enquiry by phone, WhatsApp or email.</label>
<button type="submit">Send my enquiry</button>
${wa ? `<a class="wa" id="wa" href="#" rel="noopener">Chat on WhatsApp</a>` : ''}
<div class="msg" id="msg" role="status"></div>
</form>
<footer>${esc(brand)}${s.business.city ? ' · ' + esc(s.business.city) : ''}${s.business.phone ? ' · ' + esc(s.business.phone) : ''}<br>Your details are used only to answer your enquiry.</footer>
<script>
(function(){var C=${cfg},f=document.getElementById('f'),msg=document.getElementById('msg'),wa=document.getElementById('wa');
function say(t,ok){msg.textContent=t;msg.className='msg '+(ok?'ok':'bad')}
function waUrl(extra){return 'https://wa.me/'+C.wa+'?text='+encodeURIComponent(C.waText+(extra?'\\n'+extra:''))}
if(wa)wa.href=waUrl('');
f.addEventListener('submit',function(e){e.preventDefault();
var v=function(n){return (f.elements[n].value||'').trim()};
if(v('website'))return say('Thank you!',true);
if(!v('name')||(!v('phone')&&!v('email')))return say('Please add your name and a phone number or email.');
if(v('email')&&!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v('email')))return say('Please check the email address.');
var consent=f.elements.consent.checked;
if(!C.formUrl){if(!C.wa)return say('Please call us to enquire.');location.href=waUrl('Name: '+v('name')+(v('phone')?'\\nPhone: '+v('phone'):'')+(v('message')?'\\n'+v('message'):''));return}
var b=new URLSearchParams({name:v('name'),phone:v('phone'),email:v('email'),message:v('message'),product:C.product,source:C.source,consent:consent?'true':'false'});
f.querySelector('button').disabled=true;
fetch(C.formUrl,{method:'POST',mode:'no-cors',body:b}).then(function(){f.reset();say('Thank you! We will contact you soon.',true)}).catch(function(){say('Could not send. Please try WhatsApp or call us.')}).then(function(){f.querySelector('button').disabled=false})
})})();
</script></body></html>`;
}
