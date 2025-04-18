// File: api/getScribdLink.js (Vercel)

const fetch = require('node-fetch');

// --- Helper Functions ---
function extractScribdInfo(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('Invalid URL provided for extraction.');
  }
  const regex = /(?:[a-z]{2,3}\.)?scribd\.com\/(?:document|doc)\/(\d+)\/?([^?\/]*)/;
  const match = url.match(regex);
  if (match && match[1]) {
    const docId = match[1];
    const slug = match[2] ? match[2].replace(/\/$/, '') : `document-${docId}`;
    return { docId, titleSlug: slug };
  }
  throw new Error('Unrecognized Scribd URL format.');
}

function generateIlideLink(docId, titleSlug) {
  const fileUrl = encodeURIComponent(
    `https://scribd.vdownloaders.com/pdownload/${docId}%2F${titleSlug}`
  );
  const titleHtml = encodeURIComponent(`<div><p>${titleSlug.replace(/-/g, ' ')}</p></div>`);
  return `https://ilide.info/docgeneratev2?fileurl=${fileUrl}&title=${titleHtml}`;
}

// --- Follows redirects until the final download URL is found ---
async function fetchDownloadLink(ilideLink) {
  let current = ilideLink;
  while (true) {
    const res = await fetch(current, { redirect: 'manual' });
    const loc = res.headers.get('location');
    if (!loc) {
      throw new Error('No redirect found; cannot locate download link.');
    }
    const next = new URL(loc, current).toString();
    // Check for the docdownload pattern
    if (next.includes('/docdownloadv2-') && next.includes('data_code=')) {
      return next;
    }
    current = next;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  const { scribdUrl } = req.body;
  if (!scribdUrl || typeof scribdUrl !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid scribdUrl in request body.' });
  }

  try {
    const { docId, titleSlug } = extractScribdInfo(scribdUrl);
    const ilideLink = generateIlideLink(docId, titleSlug);
    const downloadLink = await fetchDownloadLink(ilideLink);
    return res.status(200).json({ downloadLink });
  } catch (err) {
    console.error('Error processing request:', err);
    const code = err.message.includes('Invalid') ? 400 : 500;
    return res.status(code).json({ error: err.message });
  }
};
