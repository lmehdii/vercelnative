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

    // 1) Try following redirects automatically and inspect final URL
    try {
      const followRes = await fetch(ilideLink, { headers });
      const finalUrl = followRes.url;
      if (finalUrl.includes('/viewer/web/viewer.html')) {
        const urlObj = new URL(finalUrl);
        const fileParam = urlObj.searchParams.get('file');
        if (fileParam) {
          downloadLink = decodeURIComponent(decodeURIComponent(fileParam));
          console.log('[Vercel Fn] Captured via redirect follow:', downloadLink);
        }
      }
    } catch (e) {
      console.warn('[Vercel Fn] Redirect-follow capture failed:', e);
    }

    // 2) Fallback: fetch HTML and static parse
    if (!downloadLink) {
      const htmlRes = await fetch(ilideLink, { headers });
      let html = await htmlRes.text();
      html = html.replace(/&amp;/g, '&');

      // Patterns to search for viewer URL
      const patterns = [
        /<meta[^>]+content="([^"]*viewer\/web\/viewer\.html\?file=[^"]+)"/i,
        /<iframe[^>]+src="([^"]*viewer\/web\/viewer\.html\?file=[^"]+)"/i,
        /(https?:\/\/[^"]*viewer\/web\/viewer\.html\?file=[^"'\s]+)/i,
        /\/viewer\/web\/viewer\.html\?file=([^"'&\s]+)/i
      ];

      let fileParam = null;
      for (const regex of patterns) {
        const m = html.match(regex);
        if (m && m[1]) {
          const urlStr = m[1].startsWith('http') ? m[1] : `${ilideLink}${m[0]}`;
          const urlObj = new URL(urlStr, ilideLink);
          fileParam = urlObj.searchParams.get('file');
          if (fileParam) {
            downloadLink = decodeURIComponent(decodeURIComponent(fileParam));
            console.log('[Vercel Fn] Captured via HTML pattern:', downloadLink);
            break;
          }
        }
      }

      if (!downloadLink) {
        console.error('[Vercel Fn] All static parse patterns failed.');
        throw new Error('Download link parameter not found in HTML.');
      }
    }

    return res.status(200).json({ downloadLink });

  } catch (error) {
    console.error('[Vercel Fn] Error during processing:', error);
    const msg = error.message || 'Internal server error.';
    const status = msg.includes('Scribd URL format') ? 400 : 500;
    return res.status(status).json({ error: msg });
  }
};
