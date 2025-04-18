// File: api/getScribdLink.js (Vercel)

const fetch = require('node-fetch');

// --- Helper Functions (with subdomain fix) ---
function extractScribdInfo(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('Invalid URL provided for extraction.');
  }

  const regex = /(?:[a-z]{2,3}\.)?scribd\.com\/(?:document|doc)\/(\d+)\/?([^?\/]+)?/;
  const match = url.match(regex);

  if (match && match[1]) {
    const docId = match[1];
    const titleSlug = match[2] ? match[2].replace(/\/$/, '') : `document-${docId}`;
    const title = titleSlug.replace(/-/g, ' ');
    console.log(`[Vercel Fn] Extracted via primary regex: ID=${docId}, Slug=${titleSlug}`);
    return { docId, title, titleSlug };
  }

  const genericRegex = /(?:[a-z]{2,3}\.)?scribd\.com\/.*\/(?:document|doc|presentation|book)\/(\d+)/;
  const genericMatch = url.match(genericRegex);
  if (genericMatch && genericMatch[1]) {
    const docId = genericMatch[1];
    const titleSlug = `document-${docId}`;
    const title = `Document ${docId}`;
    console.warn("[Vercel Fn] Used generic Scribd URL matching.");
    return { docId, title, titleSlug };
  }

  console.error(`[Vercel Fn] Failed to match Scribd URL format: ${url}`);
  throw new Error('Invalid or unrecognized Scribd URL format.');
}

function generateIlideLink(docId, titleSlug) {
  const fileUrl = encodeURIComponent(
    `https://scribd.vdownloaders.com/pdownload/${docId}%2F${titleSlug}`
  );
  const titleWithSpaces = titleSlug.replace(/-/g, ' ');
  const encodedTitle = encodeURIComponent(`<div><p>${titleWithSpaces}</p></div>`);

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
    // Extract document info and build ilide link
    const { docId, titleSlug } = extractScribdInfo(scribdUrl);
    const ilideLink = generateIlideLink(docId, titleSlug);
    console.log(`[Vercel Fn] Target ilide.info link: ${ilideLink}`);

    // Attempt a manual fetch to capture redirect
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer': ilideLink
    };

    let downloadLink = null;

    // 1) Try manual redirect capture
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

    // 2) Fallback: fetch HTML and regex parse
    if (!downloadLink) {
      const htmlRes = await fetch(ilideLink, { headers });
      const html = await htmlRes.text();
      const match = html.match(/\/viewer\/web\/viewer\.html\?file=([^"']+)/);
      if (!match) {
        throw new Error('Download link parameter not found in HTML.');
      }
      downloadLink = decodeURIComponent(decodeURIComponent(match[1]));
      console.log('[Vercel Fn] Captured via HTML parse:', downloadLink);
    }

    // Return the captured download link
    return res.status(200).json({ downloadLink });

  } catch (error) {
    console.error('[Vercel Fn] Error during processing:', error);
    const msg = error.message || 'Internal server error.';
    const status = msg.includes('Scribd URL format') ? 400 : 500;
    return res.status(status).json({ error: msg });
  }
};
