/* Render institution-accessible article pages with an ordinary Chrome session.
 * Input/output are JSON lines. Source text goes only to the parent worker.
 */
const readline = require('node:readline');
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch { ({ chromium } = require('../frontend/node_modules/playwright-core')); }

const publisherHosts = ['doi.org', 'dx.doi.org', 'linkinghub.elsevier.com', 'www.sciencedirect.com',
  'sciencedirect.com', 'link.springer.com', 'www.nature.com', 'nature.com',
  'onlinelibrary.wiley.com', 'jamanetwork.com', 'www.bmj.com'];
const allowedHost = (host) => publisherHosts.includes(host) || host.endsWith('.onlinelibrary.wiley.com');
const selectorsFor = (host) => host.includes('sciencedirect.com') ? ['#body']
  : host.includes('springer.com') || host.includes('nature.com') ? ['.c-article-body']
  : host.includes('wiley.com') ? ['.article-section__full', '.article__body', '#article__content']
  : host === 'jamanetwork.com' ? ['.article-full-text', '#article-full-text', '.articleFullText']
  : host === 'www.bmj.com' ? ['.article.full', '#content-block'] : [];

async function readArticle(context, job) {
  const doi = String(job.doi || '').trim();
  if (!/^10\.\d{4,9}\/[^\s<>"#?]+$/i.test(doi)) return {status:'unsupported', reason:'invalid_doi'};
  const page = await context.newPage();
  try {
    await page.route('**/*', route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() &&
          !allowedHost(new URL(request.url()).hostname)) return route.abort();
      return route.continue();
    });
    const response = await page.goto('https://doi.org/' + encodeURIComponent(doi),
      {waitUntil:'domcontentloaded', timeout:45000});
    if (response && [401,403,429].includes(response.status()))
      return {status: response.status() === 429 ? 'retryable_error' : 'access_required', reason:'http_'+response.status()};
    if (response && response.status() >= 500) return {status:'retryable_error',reason:'publisher_unavailable'};
    // DOI/Elsevier linking pages can redirect after their own DOM has loaded.
    try { await page.waitForURL(url => selectorsFor(url.hostname).length > 0, {timeout:20000}); } catch {}
    await page.waitForLoadState('domcontentloaded');
    const host = new URL(page.url()).hostname;
    const selectors = selectorsFor(host);
    if (!selectors.length) return {status:'unsupported', reason:'unsupported_publisher',url:page.url()};
    // A visible placeholder is not a loaded article body.
    try {
      await page.waitForFunction(sels => sels.some(sel => {
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
        challenge: /verify you are human|access denied|checking your browser|enable javascript and cookies|verify your access/i.test(start),
        license: document.querySelector('a[href*="creativecommons.org/licenses/"]')?.href || null,
        doi: document.querySelector('meta[name="citation_doi"]')?.content || null,
        tables: [...(original?.querySelectorAll('a[href*="/tables/"]') || [])].map(a=>a.href),
        loading: /loading/i.test(original?.innerText || ''),
      };
    }, selectors);
    if (result.challenge) return {status:'challenge',reason:'publisher_check'};
    if (result.characters < 2000 || result.headings.length < 2)
      return {status:result.loading ? 'retryable_error' : 'access_required',reason:'no_complete_body',url:page.url()};
    // Springer keeps table values on separate article pages. Read the actual
    // linked tables through the same ordinary browser session before parsing.
    let tableHtml='';
    for (const url of [...new Set(result.tables)].slice(0,10)) {
      if (new URL(url).origin !== new URL(page.url()).origin) continue;
      const tablePage=await context.newPage();
      try {
        const response=await tablePage.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
        if (!response || response.status() !== 200) throw new Error('table_unavailable');
        await tablePage.waitForSelector('table',{timeout:15000});
        tableHtml+=await tablePage.evaluate(()=>[...document.querySelectorAll('table')].map(t=>'<h2>'+document.title.replace(/[<>]/g,'')+'</h2>'+t.outerHTML).join(''));
      } catch {
        return {status:'retryable_error',reason:'article_table_unavailable',url:page.url()};
      } finally { await tablePage.close(); }
    }
    if (tableHtml) result.html=result.html.replace(/<\/[^>]+>\s*$/,end=>tableHtml+end);
    delete result.tables;
    delete result.loading;
    return {status:'downloaded', url:page.url(), ...result};
  } catch (error) {
    return {status:'retryable_error', reason:error.name === 'TimeoutError' ? 'timeout' : 'navigation_error'};
  } finally { await page.close(); }
}

async function main() {
  const context = await chromium.launchPersistentContext(process.env.URO_BROWSER_PROFILE || '', {
    channel:'chrome', headless:false, args:['--start-minimized'], viewport:{width:1280,height:900},
  });
  try {
    for await (const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})) {
      let job;
      try { job=JSON.parse(line); }
      catch { process.stdout.write(JSON.stringify({status:'parse_failed',reason:'invalid_job'})+'\n'); continue; }
      const result=await readArticle(context,job);
      process.stdout.write(JSON.stringify({pmid:job.pmid,...result})+'\n');
    }
  } finally { await context.close(); }
}
if (require.main === module) main().catch(() => { console.error('Browser worker failed'); process.exitCode=1; });
module.exports={allowedHost,selectorsFor};
