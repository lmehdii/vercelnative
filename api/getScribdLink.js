// File: api/getScribdLink.js (Vercel)

const fetch = require('node-fetch');

// --- Helper Functions (with subdomain fix) ---
function extractScribdInfo(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('Invalid URL provided for extraction.');
  }

  const regex = /(?:[a-z]{2,3}\.)?scribd\.com\/(?:document|doc)\/(\d+)\/?([^?\/]+)?/i;
  const match = url.match(regex);

  if (match && match[1]) {
    const docId = match[1];
    const titleSlug = match[2] ? match[2].replace(/\/$/, '') : `document-${docId}`;
    console.log(`[Vercel Fn] Extracted via primary regex: ID=${docId}, Slug=${titleSlug}`);
    return { docId, titleSlug };
  }

  const genericRegex = /(?:[a-z]{2,3}\.)?scribd\.com\/.*\/(?:document|doc|presentation|book)\/(\d+)/i;
  const genericMatch = url.match(genericRegex);
  if (genericMatch && genericMatch[1]) {
    const docId = genericMatch[1];
    const titleSlug = `document-${docId}`;
    console.warn("[Vercel Fn] Used generic Scribd URL matching.");
    return { docId, titleSlug };
  }

  console.error(`[Vercel Fn] Failed to match Scribd URL format: ${url}`);
  throw new Error('Invalid or unrecognized Scribd URL format.');
}

function generateIlideLink(docId, titleSlug) {
  const fileUrl = encodeURIComponent(
    `https://scribd.vdownloaders.com/pdownload/${docId}%2F${titleSlug}`
  );
  const encodedTitle = encodeURIComponent(`<div><p>${titleSlug.replace(/-/g, ' ')}</p></div>`);

  return `https://ilide.info/docgeneratev2` +
         `?fileurl=${fileUrl}` +
         `&title=${encodedTitle}` +
         `&utm_source=scrfree&utm_medium=queue&utm_campaign=dl`;
}

// --- Vercel Serverless Function Handler ---
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  const { scribdUrl } = req.body;
  if (!scribdUrl || typeof scribdUrl !== 'string') {
    console.error('[Vercel Fn] Invalid request body:', req.body);
    return res.status(400).json({ error: 'Missing or invalid scribdUrl in request body.' });
  }

  console.log(`[Vercel Fn] Request for: ${scribdUrl}`);

  try {
    const { docId, titleSlug } = extractScribdInfo(scribdUrl);
    const ilideLink = generateIlideLink(docId, titleSlug);
    console.log(`[Vercel Fn] Target ilide.info link: ${ilideLink}`);

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer': ilideLink
    };

    let downloadLink = null;

    // 1) Attempt to capture redirect directly
    try {
      const redirectRes = await fetch(ilideLink, { redirect: 'manual', headers });
      if (redirectRes.status >= 300 && redirectRes.status < 400) {
        const location = redirectRes.headers.get('location');
        if (location && location.includes('/viewer/web/viewer.html')) {
          const urlObj = new URL(location, ilideLink);
          const fileParam = urlObj.searchParams.get('file');
          if (fileParam) {
            downloadLink = decodeURIComponent(decodeURIComponent(fileParam));
            console.log('[Vercel Fn] Captured via redirect:', downloadLink);
          }
        }
      }
    } catch (e) {
      console.warn('[Vercel Fn] Redirect capture failed, continuing to fallback.', e);
    }

    // 2) Fallback: fetch HTML, decode entities, and regex parse
    if (!downloadLink) {
      try {
        const htmlRes = await fetch(ilideLink, { headers });
        let html = await htmlRes.text();
        html = html.replace(/&amp;/g, '&');

        // Try to match iframe src first
        let match = html.match(/<iframe[^>]+src="([^"]*viewer\/web\/viewer\.html\?file=[^"\s]+)"/i);
        let viewerUrl = match ? match[1] : null;

        // If no iframe, try generic URL match
        if (!viewerUrl) {
          match = html.match(/\/viewer\/web\/viewer\.html\?file=([^"'&\s]+)/i);
          if (match) {
            viewerUrl = match[0];
          }
        }

        if (viewerUrl) {
          const urlObj = new URL(viewerUrl, ilideLink);
          const fileParam = urlObj.searchParams.get('file');
          downloadLink = decodeURIComponent(decodeURIComponent(fileParam));
          console.log('[Vercel Fn] Captured via HTML parse:', downloadLink);
        } else {
          throw new Error('Viewer URL not found in HTML.');
        }

      } catch (htmlError) {
        console.warn('[Vercel Fn] HTTP HTML parse failed, switching to Puppeteer fallback.', htmlError);

        // 3) Puppeteer fallback for dynamic content
        const chromium = require('@sparticuz/chromium');
        const puppeteer = require('puppeteer-core');
        const browser = await puppeteer.launch({
          args: chromium.args,
          defaultViewport: chromium.defaultViewport,
          executablePath: await chromium.executablePath(),
          headless: chromium.headless,
          ignoreHTTPSErrors: true
        });
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', req => {
          const rt = req.resourceType();
          if (['image','stylesheet','font','media'].includes(rt)) req.abort();
          else req.continue();
        });
        await page.goto(ilideLink, { waitUntil: 'networkidle2', timeout: 60000 });
        const frame = await page.waitForSelector('iframe[src*="viewer/web/viewer.html"]', { timeout: 60000 });
        const src = await frame.evaluate(el => el.src);
        const urlObj = new URL(src);
        const fileParam = urlObj.searchParams.get('file');
        if (!fileParam) throw new Error('Puppeteer: file param missing');
        downloadLink = decodeURIComponent(decodeURIComponent(fileParam));
        console.log('[Vercel Fn] Captured via Puppeteer:', downloadLink);
        await browser.close();
      }
    }

    if (!downloadLink) throw new Error('Failed to capture download link by any method.');

    return res.status(200).json({ downloadLink });

  } catch (error) {
    console.error('[Vercel Fn] Error during processing:', error);
    const msg = error.message || 'Internal server error.';
    const status = msg.includes('Scribd URL format') ? 400 : 500;
    return res.status(status).json({ error: msg });
  }
};
