/* Render institution-accessible article pages with an ordinary Chrome session.
 * Input/output are JSON lines. Source text goes only to the parent worker.
 */
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch { ({ chromium } = require('../frontend/node_modules/playwright-core')); }

// ScienceDirect website automation is disabled. Use authorized OA/API documents.
const disabledWebHost = host => ['sciencedirect.com', 'elsevier.com', 'els-cdn.com']
  .some(domain => host === domain || host.endsWith('.' + domain));
const publisherHosts = ['doi.org', 'dx.doi.org', 'link.springer.com', 'www.nature.com', 'nature.com',
  'onlinelibrary.wiley.com', 'jamanetwork.com', 'www.bmj.com'];
const allowedHost = (host) => publisherHosts.includes(host) || host.endsWith('.onlinelibrary.wiley.com');
const publisherGroup = host => ['link.springer.com','nature.com','media.springernature.com','static-content.springer-cdn.com'].includes(host)
    || host.endsWith('.nature.com') ? 'springer-nature'
  : host.endsWith('wiley.com') ? 'wiley' : host.endsWith('doi.org') ? 'doi'
  : ['www.ebi.ac.uk','europepmc.org'].includes(host) ? 'europe-pmc'
  : host === 'ncbi.nlm.nih.gov' || host.endsWith('.ncbi.nlm.nih.gov') ? 'ncbi'
  : host === 'jamanetwork.com' ? 'jama' : host === 'www.bmj.com' ? 'bmj' : null;

// A denied/rate-limited source stays paused across hourly runs. No session reset
// or alternate address is used to retry a publisher block.
class PublisherPolicy {
  constructor(directory = null) { this.directory = directory; this.pauses = new Map(); this.lastStart = new Map(); }
  pauseFor(host) {
    const group = publisherGroup(host);
    if (!group) return null;
    if (this.directory) {
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(this.directory, group + '.json'), 'utf8'));
        if (Number.isFinite(saved.until) && saved.until > (this.pauses.get(group)?.until || 0)) this.pauses.set(group, saved);
      } catch (error) { if (error.code !== 'ENOENT') return {until: Infinity, reason: 'publisher_pause_unreadable'}; }
    }
    const paused = this.pauses.get(group);
    return paused?.until > Date.now() ? paused : null;
  }
  async before(host, deadline) {
    if (disabledWebHost(host)) throw Object.assign(new Error('Publisher website disabled'), {reason:'publisher_web_disabled'});
    if (this.pauseFor(host)) throw Object.assign(new Error('Publisher paused'), {reason:'publisher_paused'});
    const group = publisherGroup(host);
    if (!group) return;
    const delay = Math.max(0, (this.lastStart.get(group) || 0) + 1000 - Date.now());
    if (Date.now() + delay >= deadline) throw Object.assign(new Error('Article budget'), {reason:'article_time_budget'});
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (Date.now() >= deadline) throw Object.assign(new Error('Article budget'), {reason:'article_time_budget'});
    if (this.pauseFor(host)) throw Object.assign(new Error('Publisher paused'), {reason:'publisher_paused'});
    this.lastStart.set(group, Date.now());
  }
  observe(host, status, challenge = false) {
    const group = publisherGroup(host);
    if (group) this.lastStart.set(group, Date.now());
    if (!group || (!challenge && ![401,403,429].includes(status))) return;
    const value = {until: Date.now() + (status === 429 ? 3600 : 86400) * 1000,
      reason: challenge ? 'publisher_check' : 'http_' + status};
    this.pauses.set(group, value);
    if (this.directory) {
      fs.mkdirSync(this.directory, {recursive:true});
      const destination = path.join(this.directory, group + '.json');
      const temporary = destination + '.' + process.pid + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(value));
      fs.renameSync(temporary, destination);
    }
  }
}

async function blockPublisherRequests(context, page, policy, navigation) {
  const domains = ['sciencedirect.com', 'elsevier.com', 'els-cdn.com'];
  const urls = domains.flatMap(domain => ['*://' + domain + '/*', '*://*.' + domain + '/*']);
  for (const host of [...publisherHosts, ...imageHosts]) {
    if (policy.pauseFor(host)) urls.push('*://' + host + '/*');
  }
  if (policy.pauseFor('onlinelibrary.wiley.com')) urls.push('*://*.onlinelibrary.wiley.com/*');
  // Route callbacks do not cover every HTTP redirect hop. Chromium's network
  // block applies before transport, including automatic redirect destinations.
  const session = await context.newCDPSession(page);
  session.on('Fetch.requestPaused', event => {
    const host = new URL(event.request.url).hostname;
    navigation.reason = disabledWebHost(host) ? 'publisher_web_disabled' : 'publisher_paused';
    void session.send('Fetch.failRequest', {requestId:event.requestId, errorReason:'BlockedByClient'})
      .catch(() => page.close().catch(() => {}));
  });
  await session.send('Fetch.enable', {patterns:urls.map(urlPattern => ({urlPattern,requestStage:'Request'}))});
  page.on('requestfailed', request => {
    const host = new URL(request.url()).hostname;
    if (disabledWebHost(host)) navigation.reason = 'publisher_web_disabled';
    else if (policy.pauseFor(host)) navigation.reason = 'publisher_paused';
  });
  page.on('response', response => {
    try {
      const request = response.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        policy.observe(new URL(response.url()).hostname, response.status());
        if ([401,403,429].includes(response.status())) navigation.httpStatus = response.status();
      }
    } catch { navigation.reason = 'publisher_paused'; }
  });
}

async function guardPage(page, policy, deadline, state) {
  await page.route('**/*', async route => {
    const request = route.request();
    const host = new URL(request.url()).hostname;
    if (disabledWebHost(host)) {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) state.reason = 'publisher_web_disabled';
      return route.abort();
    }
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      if (!allowedHost(host)) { state.reason = 'unsupported_publisher'; return route.abort(); }
      try { await policy.before(host, deadline); }
      catch (error) { state.reason = error.reason || 'publisher_paused'; return route.abort(); }
    }
    return route.continue();
  });
}
const imageHosts = ['media.springernature.com','static-content.springer-cdn.com',
  'pmc.ncbi.nlm.nih.gov','cdn.ncbi.nlm.nih.gov','www.ncbi.nlm.nih.gov','www.ebi.ac.uk','europepmc.org'];
const allowedImage = value => {
  try { const url=new URL(value); return !disabledWebHost(url.hostname) && url.protocol==='https:' && !url.username && !url.password &&
    (!url.port || url.port==='443') && (allowedHost(url.hostname)||imageHosts.includes(url.hostname)); }
  catch { return false; }
};

async function readImage(context, job, policy = new PublisherPolicy()) {
  if (!allowedImage(job.url)) return {status:'unsupported'};
  const page=await context.newPage();
  const budget = Number.isFinite(job.budget_ms) ? Math.max(1,Math.min(30000,job.budget_ms)) : 20000;
  const deadline = Date.now() + budget;
  const timer=setTimeout(()=>void page.close().catch(()=>{}),budget);
  const navigation = {};
  try {
    await blockPublisherRequests(context, page, policy, navigation);
    await page.route('**/*', async route => {
      const request = route.request();
      if (!allowedImage(request.url())) return route.abort();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        try { await policy.before(new URL(request.url()).hostname,deadline); }
        catch { return route.abort(); }
      }
      return route.continue();
    });
    const response=await page.goto(job.url,{waitUntil:'load',timeout:20000});
    if (response) policy.observe(new URL(page.url()).hostname,response.status());
    if (!response || response.status()!==200) return {status:'unavailable'};
    const type=response.headers()['content-type']||'';
    if (!/^image\/(png|jpeg|gif|webp|tiff|bmp)(?:;|$)/i.test(type)) return {status:'unsupported'};
    if (Number(response.headers()['content-length']||0)>20*1024*1024) return {status:'unsupported'};
    const bytes=await response.body();
    if (bytes.length>20*1024*1024) return {status:'unsupported'};
    return {status:'downloaded',data:bytes.toString('base64')};
  } catch { return {status:'unavailable'}; }
  finally { clearTimeout(timer);await page.close().catch(()=>{}); }
}
const selectorsFor = (host) => disabledWebHost(host) ? []
  : host.includes('springer.com') || host.includes('nature.com') ? ['.c-article-body']
  : host.includes('wiley.com') ? ['.article-section__full', '.article__body', '#article__content']
  : host === 'jamanetwork.com' ? ['.article-full-text', '#article-full-text', '.articleFullText']
  : host === 'www.bmj.com' ? ['.article.full', '#content-block'] : [];

async function readArticle(context, job, policy = new PublisherPolicy()) {
  const doi = String(job.doi || '').trim();
  if (!/^10\.\d{4,9}\/[^\s<>"#?]+$/i.test(doi)) return {status:'unsupported', reason:'invalid_doi'};
  // Known Elsevier DOI routing can be rejected without contacting a resolver.
  // Chromium's network block also covers other DOI redirect destinations.
  if (/^10\.1016\//i.test(doi)) return {status:'unsupported',reason:'publisher_web_disabled'};
  const page = await context.newPage();
  const pages = new Set([page]);
  let timedOut = false;
  const navigation = {};
  const budget = Number.isFinite(job.budget_ms) ? Math.max(1000, Math.min(240000, job.budget_ms)) : 240000;
  const deadline = Date.now() + budget;
  const timer = setTimeout(() => {
    timedOut = true;
    for (const active of pages) void active.close().catch(() => {});
  }, budget);
  try {
    await blockPublisherRequests(context, page, policy, navigation);
    await guardPage(page, policy, deadline, navigation);
    const response = await page.goto('https://doi.org/' + encodeURIComponent(doi),
      {waitUntil:'domcontentloaded', timeout:45000});
    if (navigation.reason) throw Object.assign(new Error('Navigation stopped'), {reason:navigation.reason});
    if (response) policy.observe(new URL(page.url()).hostname, response.status());
    if (response && [401,403,429].includes(response.status()))
      return {status: response.status() === 429 ? 'retryable_error' : 'access_required', reason:'http_'+response.status()};
    if (response && response.status() >= 500) return {status:'retryable_error',reason:'publisher_unavailable'};
    // DOI linking pages can redirect after their own DOM has loaded.
    try { await page.waitForURL(url => selectorsFor(url.hostname).length > 0, {timeout:20000}); } catch {}
    if (navigation.reason) throw Object.assign(new Error('Navigation stopped'), {reason:navigation.reason});
    await page.waitForLoadState('domcontentloaded');
    if (navigation.httpStatus) return {status: navigation.httpStatus === 429 ? 'retryable_error' : 'access_required',
      reason:'http_' + navigation.httpStatus, url:page.url()};
    const host = new URL(page.url()).hostname;
    const selectors = selectorsFor(host);
    if (!selectors.length) return {status:'unsupported', reason:'unsupported_publisher',url:page.url()};
    // A visible placeholder is not a loaded article body.
    try {
      await page.waitForFunction(sels => /verify you are human|access denied|checking your browser|enable javascript and cookies|verify your access|CPE00001/i.test(document.body?.innerText.slice(0,2500) || '') || sels.some(sel => {
        const node = document.querySelector(sel);
        return node && node.innerText.length >= 2000 && node.querySelectorAll('h2,h3').length >= 2;
      }), selectors, {timeout:90000});
    } catch {}
    const result = await page.evaluate(sels => {
      const candidates = sels.map(sel => document.querySelector(sel)).filter(Boolean);
      const original = candidates.find(node=>node.innerText.length>=2000 && node.querySelectorAll('h2,h3').length>=2) || candidates[0];
      const body = original?.cloneNode(true);
      if (body) {
        for (const heading of body.querySelectorAll('h2')) {
          if (/^(abstract|references|explore related subjects|author information|funding|ethics declarations|additional information|rights and permissions|about this article|keywords|supplementary information)$/i.test(heading.textContent.trim())) {
            const section=heading.closest('section');
            if (section && section !== body) section.remove();
          }
        }
        body.querySelectorAll('script,style,nav,form,aside').forEach(n=>n.remove());
      }
      const start = document.body.innerText.slice(0,2500);
      return {
        title: document.querySelector('h1')?.innerText || document.title,
        html: body?.outerHTML || '', characters: body?.textContent.length || 0,
        headings: [...(body?.querySelectorAll('h2,h3') || [])].map(n => n.textContent.trim()),
        institution: document.querySelector('#gh-inst-icon-btn')?.innerText || null,
        challenge: /verify you are human|access denied|checking your browser|enable javascript and cookies|verify your access|CPE00001/i.test(start),
        license: document.querySelector('a[href*="creativecommons.org/licenses/"]')?.href || null,
        doi: document.querySelector('meta[name="citation_doi"]')?.content || null,
        tables: [...(original?.querySelectorAll('a[href*="/tables/"]') || [])].map(a=>a.href),
        loading: /loading/i.test(original?.innerText || ''),
      };
    }, selectors);
    if (result.challenge) { policy.observe(host, 200, true); return {status:'challenge',reason:'publisher_check'}; }
    if (result.characters < 2000 || result.headings.length < 2)
      return {status:result.loading ? 'retryable_error' : 'access_required',reason:'no_complete_body',url:page.url()};
    // Springer keeps table values on separate article pages. Read the actual
    // linked tables through the same ordinary browser session before parsing.
    let tableHtml='';
    for (const url of [...new Set(result.tables)].slice(0,10)) {
      if (timedOut) return {status:'retryable_error',reason:'article_time_budget'};
      if (new URL(url).origin !== new URL(page.url()).origin) continue;
      const tablePage=await context.newPage();
      pages.add(tablePage);
      try {
        if (timedOut) throw new Error('article_time_budget');
        await blockPublisherRequests(context, tablePage, policy, navigation);
        await guardPage(tablePage, policy, deadline, navigation);
        const response=await tablePage.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
        if (response) policy.observe(new URL(tablePage.url()).hostname, response.status());
        if (!response || response.status() !== 200) throw new Error('table_unavailable');
        await tablePage.waitForSelector('table',{timeout:15000});
        tableHtml+=await tablePage.evaluate(()=>[...document.querySelectorAll('table')].map(t=>'<h2>'+document.title.replace(/[<>]/g,'')+'</h2>'+t.outerHTML).join(''));
      } catch {
        if (navigation.reason) return {status:'access_required',reason:navigation.reason};
        return {status:'retryable_error',reason:'article_table_unavailable',url:page.url()};
      } finally { pages.delete(tablePage); await tablePage.close().catch(() => {}); }
    }
    if (tableHtml) result.html=result.html.replace(/<\/[^>]+>\s*$/,end=>tableHtml+end);
    delete result.tables;
    delete result.loading;
    if (timedOut) return {status:'retryable_error',reason:'article_time_budget'};
    return {status:'downloaded', url:page.url(), ...result};
  } catch (error) {
    const reason = navigation.reason || error.reason;
    if (reason) return {status: reason === 'publisher_web_disabled' || reason === 'unsupported_publisher' ? 'unsupported'
      : reason === 'article_time_budget' ? 'retryable_error' : 'access_required', reason};
    return {status:'retryable_error', reason:error.name === 'TimeoutError' ? 'timeout' : 'navigation_error'};
  } finally { clearTimeout(timer); await page.close().catch(() => {}); }
}

async function main() {
  const policy = new PublisherPolicy(process.env.URO_PUBLISHER_STATE || null);
  const context = await chromium.launchPersistentContext(process.env.URO_BROWSER_PROFILE || '', {
    channel:'chrome', headless:false, args:['--start-minimized'], viewport:{width:1280,height:900}, serviceWorkers:'block',
  });
  try {
    for await (const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})) {
      let job;
      try { job=JSON.parse(line); }
      catch { process.stdout.write(JSON.stringify({status:'parse_failed',reason:'invalid_job'})+'\n'); continue; }
      const result=job.operation==='image' ? await readImage(context,job,policy) : await readArticle(context,job,policy);
      process.stdout.write(JSON.stringify({pmid:job.pmid,...result})+'\n');
    }
  } finally { await context.close(); }
}
if (require.main === module) main().catch(() => { console.error('Browser worker failed'); process.exitCode=1; });
module.exports={allowedHost,disabledWebHost,selectorsFor,readArticle,allowedImage,readImage,PublisherPolicy,guardPage,blockPublisherRequests};
