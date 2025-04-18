// File: api/getScribdLink.js (Vercel - Scripts HARDCODED to BLOCKED)

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

    // **** SETTING: Hardcode blockScripts to true ****
    const blockScripts = true;

    const { scribdUrl } = req.body;
    if (!scribdUrl || typeof scribdUrl !== 'string') {
        console.error("[Vercel Fn] Invalid request body:", req.body);
        return res.status(400).json({ error: 'Missing or invalid scribdUrl in request body.' });
    }

    console.log(`[Vercel Fn] Request for: ${scribdUrl}. Script Blocking: ${blockScripts}`); // Log will show true

    let browser = null, page = null, capturedLink = null, processingError = null;

    try {
        const { docId, title, titleSlug } = extractScribdInfo(scribdUrl);
        const ilideLink = generateIlideLink(docId, titleSlug);
        console.log(`[Vercel Fn] Target ilide.info link: ${ilideLink}`);

        // Define Puppeteer Script String
        const puppeteerScript = `
            async function runPuppeteer({ page, context }) {
                const { ilideLink, blockScripts } = context; // blockScripts will be true here
                let capturedLink = null;
                let navigationError = null;
                console.log('Pptr: Script started. blockScripts=${blockScripts}. URL:', ilideLink);

                // Request Interception
                await page.setRequestInterception(true);
                page.on('request', (request) => {
                    const resourceType = request.resourceType();
                    const blockList = ['image', 'stylesheet', 'font', 'media'];
                    // **** Script Blocking is ACTIVE ****
                    if (blockScripts && resourceType === 'script') {
                         console.log('Pptr: Blocking Script:', request.url().substring(0, 80));
                         request.abort();
                    } else if (blockList.includes(resourceType)) {
                        request.abort();
                    } else {
                        request.continue();
                    }
                });

                // Response Listener
                page.on('response', async (response) => {
                     const url = response.url();
                     if (url.includes('viewer/web/viewer.html') && url.includes('file=')) {
                        try {
                             const urlObj = new URL(url); const fileParam = urlObj.searchParams.get('file');
                             if (fileParam) { let decodedLink = decodeURIComponent(fileParam); try { decodedLink = decodeURIComponent(decodedLink); } catch(e){} capturedLink = decodedLink; console.log('Pptr: Captured target link:', capturedLink); }
                        } catch (err) { console.error('Pptr: Error parsing viewer URL:', err.message); }
                     }
                });

                // Page error listeners
                page.on('error', error => { console.error('Pptr: Page crashed:', error); processingError = processingError || error; });
                page.on('pageerror', error => { console.error('Pptr: Uncaught exception on page:', error); processingError = processingError || error; });

                // Navigation
                try {
                    console.log('Pptr: Navigating (using domcontentloaded)...');
                    await page.goto(ilideLink, { waitUntil: 'domcontentloaded', timeout: 55000 });
                    console.log('Pptr: DOMContentLoaded fired.');
                    // **** Using shorter wait because scripts are blocked ****
                    const postNavWait = 500;
                    console.log(\`Pptr: Waiting \${postNavWait}ms post-DOM load...\`);
                    await new Promise(resolve => setTimeout(resolve, postNavWait));
                    console.log('Pptr: Post-DOM wait finished.');
                } catch (error) {
                    console.error('Pptr: Navigation/processing error:', error);
                    navigationError = error;
                }

                // Check results
                if (capturedLink) {
                    console.log('Pptr: Link captured, returning it.');
                    return capturedLink;
                } else if (navigationError) {
                    console.error('Pptr: No link captured & navigation failed.');
                    throw navigationError;
                } else {
                    console.error('Pptr: Navigation seemingly succeeded but target link response not detected.');
                    throw new Error('Download link response not detected on ilide.info.');
                }
            } // End of runPuppeteer function definition
        `; // End of puppeteerScript template literal

        // Launch Puppeteer
        console.log('[Vercel Fn] Launching browser via @sparticuz/chromium...');
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            ignoreHTTPSErrors: true
        });
        page = await browser.newPage();

        // Execute Script
        capturedLink = await page.evaluate(`(${puppeteerScript})(arguments[0])`, { page, context: { ilideLink, blockScripts } });

        // Handle Success
        if (capturedLink) {
             console.log('[Vercel Fn] Script execution successful, link obtained.');
             res.status(200).json({ downloadLink: capturedLink });
             // Close browser async after response
             browser.close().then(() => console.log('[Vercel Fn] Browser closed asynchronously.')).catch(e => console.error('[Vercel Fn] Async browser close error:', e));
             browser = null; // Mark as handled
             return; // Exit handler
        } else {
             // Should be caught by errors inside evaluate, but as fallback
             throw new Error('Processing completed without finding a download link.');
        }

    } catch (error) {
        // Handle Errors
        console.error("[Vercel Fn] Error during processing:", error);
        processingError = error;
        const statusCode = error.message.includes("Scribd URL format") ? 400
                         : error.message.includes("Navigation timeout") || error.message.toLowerCase().includes("timeout") ? 504
                         : 500;
        return res.status(statusCode).json({ error: error.message || 'An internal server error occurred.' });
    } finally {
        // Ensure browser is closed
        if (browser !== null) {
            console.log('[Vercel Fn] Closing browser in finally block...');
            try { await browser.close(); } catch (closeErr) { console.error("[Vercel Fn] Error closing browser in finally block:", closeErr); }
        }
    }
};
