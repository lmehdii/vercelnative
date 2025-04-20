// File: api/getScribdLink.js (Vercel - Scripts HARDCODED to ALLOWED)

const fetch = require('node-fetch');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// --- Helper Functions (with subdomain fix) ---
function extractScribdInfo(url) {
     if (!url || typeof url !== 'string') { throw new Error('Invalid URL provided for extraction.'); }
     const regex = /(?:[a-z]{2,3}\.)?scribd\.com\/(?:document|doc)\/(\d+)\/?([^?\/]+)?/;
     const match = url.match(regex);
     if (match && match[1]) { const docId = match[1]; const titleSlug = match[2] ? match[2].replace(/\/$/, '') : `document-${docId}`; const title = titleSlug.replace(/-/g, ' '); console.log(`[Vercel Fn] Extracted via primary regex: ID=${docId}, Slug=${titleSlug}`); return { docId, title, titleSlug }; } else { const genericMatch = /(?:[a-z]{2,3}\.)?scribd\.com\/.*\/(?:document|doc|presentation|book)\/(\d+)/; if (genericMatch && genericMatch[1]) { const docId = genericMatch[1]; const titleSlug = `document-${docId}`; const title = `Document ${docId}`; console.warn("[Vercel Fn] Used generic Scribd URL matching."); return { docId, title, titleSlug }; } else { console.error(`[Vercel Fn] Failed to match Scribd URL format: ${url}`); throw new Error('Invalid or unrecognized Scribd URL format.'); } }
}
function generateIlideLink(docId, titleSlug) {
    const fileUrl = encodeURIComponent(`https://scribd.vdownloaders.com/pdownload/${docId}%2F${titleSlug}`); const titleWithSpaces = titleSlug.replace(/-/g, ' '); const encodedTitle = encodeURIComponent(`<div><p>${titleWithSpaces}</p></div>`); return `https://ilide.info/docgeneratev2?fileurl=${fileUrl}&title=${encodedTitle}&utm_source=scrfree&utm_medium=queue&utm_campaign=dl`;
}

// --- Vercel Serverless Function Handler ---
module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    }

    // **** SETTING: Hardcode blockScripts to false ****
    const blockScripts = false;

    const { scribdUrl } = req.body;
    if (!scribdUrl || typeof scribdUrl !== 'string') {
        console.error("[Vercel Fn] Invalid request body:", req.body);
        return res.status(400).json({ error: 'Missing or invalid scribdUrl in request body.' });
    }

    console.log(`[Vercel Fn] Request for: ${scribdUrl}. Script Blocking: ${blockScripts}`); // Log will show false

    let browser = null, page = null, capturedLink = null, processingError = null;

    try {
        const { docId, title, titleSlug } = extractScribdInfo(scribdUrl);
        const ilideLink = generateIlideLink(docId, titleSlug);
        console.log(`[Vercel Fn] Target ilide.info link: ${ilideLink}`);

        // Launch Puppeteer
        console.log('[Vercel Fn] Launching browser via @sparticuz/chromium...');
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            ignoreHTTPSErrors: true
        });
        console.log('[Vercel Fn] Browser launched.');

        page = await browser.newPage();
        console.log('[Vercel Fn] New page created.');

        // --- Setup Listeners and Interception BEFORE navigation ---
        page.on('error', error => { console.error('Pptr: Page crashed:', error); processingError = processingError || error; });
        page.on('pageerror', error => { console.error('Pptr: Uncaught exception on page:', error); processingError = processingError || error; });

        // Response Listener - This runs in Node context and sets the outer 'capturedLink'
        page.on('response', async (response) => {
             const url = response.url();
             if (url.startsWith('https://ilide.info/') && url.includes('/viewer/web/viewer.html') && url.includes('file=')) {
                try {
                     const urlObj = new URL(url); const fileParam = urlObj.searchParams.get('file');
                     if (fileParam) {
                         let decodedLink = decodeURIComponent(fileParam);
                         try { decodedLink = decodeURIComponent(decodedLink); } catch(e){}
                         if (!capturedLink) { // Set only once
                            capturedLink = decodedLink;
                            console.log('Pptr: Captured target link:', capturedLink);
                         }
                     }
                } catch (err) { console.error('Pptr: Error parsing viewer URL:', err.message); }
             }
        });

        // Request Interception
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const resourceType = request.resourceType();
            const blockList = ['image', 'stylesheet', 'font', 'media']; // Block non-essential visual/media resources
            // **** Script Blocking is INACTIVE ****
            if (blockScripts && resourceType === 'script') { // This condition will always be false
                 request.abort();
            } else if (blockList.includes(resourceType)) {
                // console.log('Pptr: Blocking Resource:', resourceType, request.url().substring(0, 80));
                request.abort(); // Still block images, css, fonts etc.
            } else {
                request.continue(); // Allow scripts and other necessary resources
            }
        });
        // --- End Setup ---

        // Navigation
        console.log('Pptr: Navigating (using domcontentloaded)...');
        await Promise.race([
             page.goto(ilideLink, { waitUntil: 'domcontentloaded', timeout: 55000 }),
             // Add a promise that resolves if the link is captured early or rejects on page error
             new Promise((resolve, reject) => {
                 const checkInterval = setInterval(() => {
                     if (capturedLink) {
                         console.log('Pptr: Link captured during navigation wait.');
                         clearInterval(checkInterval);
                         resolve();
                     }
                     if (processingError) {
                         console.log('Pptr: Page error detected during navigation wait.');
                         clearInterval(checkInterval);
                         reject(processingError);
                     }
                 }, 100);
             })
        ]).catch(err => {
            if (err.message.includes('timeout')) {
                console.warn('Pptr: Navigation explicitly timed out.');
            } else { throw err; } // Re-throw other errors
        });
        console.log('Pptr: Navigation/Wait process completed.');


        // Check Results (variable 'capturedLink' was set by the 'response' listener)
        if (capturedLink) {
             console.log('[Vercel Fn] Link captured. Preparing response.');
             res.status(200).json({ downloadLink: capturedLink });
             browser.close().then(() => console.log('[Vercel Fn] Browser closed asynchronously.')).catch(e => console.error('[Vercel Fn] Async browser close error:', e));
             browser = null;
             return;
        } else {
             console.error('[Vercel Fn] Link not captured after navigation finished.');
             throw processingError || new Error('Download link response not detected on ilide.info.');
        }

    } catch (error) {
        // Handle Errors
        console.error("[Vercel Fn] Error during processing:", error);
        const statusCode = error.message.includes("Scribd URL format") ? 400
                         : error.message.includes("Navigation timeout") || error.message.toLowerCase().includes("timeout") ? 504
                         : 500;
        return res.status(statusCode).json({ error: error.message || 'An internal server error occurred.' });
    } finally {
        // Ensure browser is closed
        if (browser !== null) {
            console.log('[Vercel Fn] Closing browser in finally block (error or missed link)...');
            try { await browser.close(); } catch (closeErr) { console.error("[Vercel Fn] Error closing browser in finally block:", closeErr); }
        }
    }
};
