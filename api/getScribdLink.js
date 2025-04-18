// File: api/getScribdLink.js (Using @sparticuz/chromium)

const fetch = require('node-fetch');
const chromium = require('@sparticuz/chromium'); // USE @sparticuz/chromium
const puppeteer = require('puppeteer-core');

// --- Helper Functions (with subdomain fix) ---

function extractScribdInfo(url) {
     if (!url || typeof url !== 'string') {
        throw new Error('Invalid URL provided for extraction.');
    }
    // Regex with optional subdomain support
    const regex = /(?:[a-z]{2,3}\.)?scribd\.com\/(?:document|doc)\/(\d+)\/?([^?\/]+)?/;
    const match = url.match(regex);
    if (match && match[1]) {
        const docId = match[1];
        const titleSlug = match[2] ? match[2].replace(/\/$/, '') : `document-${docId}`;
        const title = titleSlug.replace(/-/g, ' ');
        console.log(`[Vercel Fn] Extracted via primary regex: ID=${docId}, Slug=${titleSlug}`);
        return { docId, title, titleSlug };
    } else {
        // Generic regex with optional subdomain support
        const genericMatch = /(?:[a-z]{2,3}\.)?scribd\.com\/.*\/(?:document|doc|presentation|book)\/(\d+)/;
         if (genericMatch && genericMatch[1]) {
             const docId = genericMatch[1];
             const titleSlug = `document-${docId}`;
             const title = `Document ${docId}`;
             console.warn("[Vercel Fn] Used generic Scribd URL matching.");
             return { docId, title, titleSlug };
         } else {
             console.error(`[Vercel Fn] Failed to match Scribd URL format: ${url}`);
            throw new Error('Invalid or unrecognized Scribd URL format.');
         }
    }
}

function generateIlideLink(docId, titleSlug) {
    const fileUrl = encodeURIComponent(`https://scribd.vdownloaders.com/pdownload/${docId}%2F${titleSlug}`);
    const titleWithSpaces = titleSlug.replace(/-/g, ' ');
    const encodedTitle = encodeURIComponent(`<div><p>${titleWithSpaces}</p></div>`);
    return `https://ilide.info/docgeneratev2?fileurl=${fileUrl}&title=${encodedTitle}&utm_source=scrfree&utm_medium=queue&utm_campaign=dl`;
}

// --- Vercel Serverless Function Handler ---
module.exports = async (req, res) => {
    // Only allow POST requests
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    }

    // Environment variable for optional script blocking
    const blockScripts = process.env.BLOCK_SCRIPTS === 'true';

    // Request Body Parsing
    const { scribdUrl } = req.body;
    if (!scribdUrl || typeof scribdUrl !== 'string') {
        console.error("[Vercel Fn] Invalid request body:", req.body);
        return res.status(400).json({ error: 'Missing or invalid scribdUrl in request body.' });
    }

    console.log(`[Vercel Fn] Request for: ${scribdUrl}. Script Blocking: ${blockScripts}`);

    let browser = null; // Declare browser outside try for finally block
    let page = null;
    let capturedLink = null;
    let processingError = null;

    try {
        // 1. Generate Links
        console.log("[Vercel Fn] Extracting Scribd info...");
        const { docId, title, titleSlug } = extractScribdInfo(scribdUrl);
        const ilideLink = generateIlideLink(docId, titleSlug);
        console.log(`[Vercel Fn] Target ilide.info link: ${ilideLink}`);

        // 2. Launch Puppeteer using @sparticuz/chromium
        console.log('[Vercel Fn] Launching browser via @sparticuz/chromium...');

        // **** USE @sparticuz/chromium properties ****
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(), // Call the function here
            headless: chromium.headless, // Use setting from the package
            ignoreHTTPSErrors: true
        });
        console.log('[Vercel Fn] Browser launched.');

        page = await browser.newPage();
        console.log('[Vercel Fn] New page created.');

        // 3. Setup Page & Interception
        console.log('[Vercel Fn] Setting up request interception...');
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const resourceType = request.resourceType();
            const blockList = ['image', 'stylesheet', 'font', 'media'];
            if (blockScripts && resourceType === 'script') {
                 request.abort();
            } else if (blockList.includes(resourceType)) {
                request.abort();
            } else {
                request.continue();
            }
        });

        page.on('response', async (response) => {
             const url = response.url();
             if (url.includes('viewer/web/viewer.html') && url.includes('file=')) {
                try {
                     const urlObj = new URL(url); const fileParam = urlObj.searchParams.get('file');
                     if (fileParam) { let decodedLink = decodeURIComponent(fileParam); try { decodedLink = decodeURIComponent(decodedLink); } catch(e){} capturedLink = decodedLink; console.log('Pptr: Captured target link:', capturedLink); }
                } catch (err) { console.error('Pptr: Error parsing viewer URL:', err.message); }
             }
        });

        page.on('error', error => { console.error('Pptr: Page crashed:', error); processingError = processingError || error; });
        page.on('pageerror', error => { console.error('Pptr: Uncaught exception on page:', error); processingError = processingError || error; });

        // 4. Navigate
        console.log('Pptr: Navigating (using domcontentloaded)...');
        await page.goto(ilideLink, { waitUntil: 'domcontentloaded', timeout: 55000 });
        console.log('Pptr: DOMContentLoaded fired.');

        // Optional minimal wait after DOM load
        const postNavWait = blockScripts ? 500 : 1500;
        console.log(`Pptr: Waiting ${postNavWait}ms post-DOM load...`);
        // Using Promise/setTimeout for better compatibility across potential minor puppeteer versions
        await new Promise(resolve => setTimeout(resolve, postNavWait));
        console.log('Pptr: Post-DOM wait finished.');

        // 5. Check Result & Close Browser
        if (capturedLink) {
             console.log('[Vercel Fn] Link captured.');
             res.status(200).json({ downloadLink: capturedLink });
             browser.close().then(() => console.log('[Vercel Fn] Browser closed asynchronously.')).catch(e => console.error('[Vercel Fn] Async browser close error:', e));
             browser = null;
             return; // Exit handler
        } else {
             console.error('[Vercel Fn] Link not captured after navigation/wait.');
             throw processingError || new Error('Download link response not detected on ilide.info.');
        }

    } catch (error) {
        // Catch errors from any step above
        console.error("[Vercel Fn] Error during processing:", error);
        processingError = error;
        const statusCode = error.message.includes("Scribd URL format") ? 400
                         : error.message.includes("Navigation timeout") || error.message.toLowerCase().includes("timeout") ? 504 // Gateway Timeout
                         : 500;
        return res.status(statusCode).json({ error: error.message || 'An internal server error occurred.' });
    } finally {
        // Ensure browser is closed if something went wrong before return/throw
        if (browser !== null) {
            console.log('[Vercel Fn] Closing browser in finally block...');
            try { await browser.close(); } catch (closeErr) { console.error("[Vercel Fn] Error closing browser in finally block:", closeErr); }
        }
    }
};
