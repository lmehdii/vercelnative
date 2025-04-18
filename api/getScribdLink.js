// File: your-vercel-project/api/getScribdLink.js

const fetch = require('node-fetch'); // Still potentially useful for ilide link check maybe? Small dep.
const chromium = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');

// --- Helper Functions (with subdomain fix) ---

function extractScribdInfo(url) {
     if (!url || typeof url !== 'string') { throw new Error('Invalid URL provided for extraction.'); }
     const regex = /(?:[a-z]{2,3}\.)?scribd\.com\/(?:document|doc)\/(\d+)\/?([^?\/]+)?/;
     const match = url.match(regex);
     if (match && match[1]) { const docId = match[1]; const titleSlug = match[2] ? match[2].replace(/\/$/, '') : `document-${docId}`; const title = titleSlug.replace(/-/g, ' '); console.log(`[Vercel Fn] Extracted via primary regex: ID=${docId}, Slug=${titleSlug}`); return { docId, title, titleSlug }; } else { const genericMatch = /(?:[a-z]{2,3}\.)?scribd\.com\/.*\/(?:document|doc|presentation|book)\/(\d+)/; if (genericMatch && genericMatch[1]) { const docId = genericMatch[1]; const titleSlug = `document-${docId}`; const title = `Document ${docId}`; console.warn("[Vercel Fn] Used generic Scribd URL matching."); return { docId, title, titleSlug }; } else { console.error(`[Vercel Fn] Failed to match Scribd URL format: ${url}`); throw new Error('Invalid or unrecognized Scribd URL format.'); } }
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
    let capturedLink = null; // Variable to hold the found link
    let processingError = null; // Variable to hold processing errors

    try {
        // 1. Generate Links
        console.log("[Vercel Fn] Extracting Scribd info...");
        const { docId, title, titleSlug } = extractScribdInfo(scribdUrl);
        const ilideLink = generateIlideLink(docId, titleSlug);
        console.log(`[Vercel Fn] Target ilide.info link: ${ilideLink}`);

        // 2. Launch Puppeteer using chrome-aws-lambda
        console.log('[Vercel Fn] Launching browser...');
        const executablePath = await chromium.executablePath;
        // Ensure executablePath is valid, otherwise Puppeteer might fail silently or throw error
        if (!executablePath) {
             throw new Error("Chromium executable not found. Check chrome-aws-lambda installation.");
        }

        browser = await puppeteer.launch({
            args: [...chromium.args, '--disable-web-security'], // Disable same-origin policy checks if needed for some interactions, use carefully
            defaultViewport: chromium.defaultViewport,
            executablePath: executablePath,
            headless: chromium.headless, // Use headless mode from chrome-aws-lambda
            ignoreHTTPSErrors: true
        });
        console.log('[Vercel Fn] Browser launched.');

        const page = await browser.newPage();
        console.log('[Vercel Fn] New page created.');

        // 3. Set up page listeners and optimizations (directly on the page object)
        console.log('[Vercel Fn] Setting up request interception...');
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const resourceType = request.resourceType();
            const blockList = ['image', 'stylesheet', 'font', 'media'];
            if (blockScripts && resourceType === 'script') {
                 // console.log('Pptr: Blocking Script:', request.url()); // Use simpler prefix
                 request.abort();
            } else if (blockList.includes(resourceType)) {
                // console.log('Pptr: Blocking Resource:', resourceType, request.url());
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

        page.on('error', error => { console.error('Pptr: Page crashed:', error); processingError = error; }); // Catch page crashes
        page.on('pageerror', error => { console.error('Pptr: Uncaught exception on page:', error); processingError = error; }); // Catch JS errors on page

        // 4. Navigate and wait
        console.log('Pptr: Navigating (using domcontentloaded)...');
        await page.goto(ilideLink, { waitUntil: 'domcontentloaded', timeout: 55000 }); // Timeout slightly less than Vercel limit
        console.log('Pptr: DOMContentLoaded fired.');

        // Optional minimal wait after DOM load
        const postNavWait = blockScripts ? 500 : 1500;
        console.log(`Pptr: Waiting ${postNavWait}ms post-DOM load...`);
        await new Promise(resolve => setTimeout(resolve, postNavWait));
        console.log('Pptr: Post-DOM wait finished.');

        // 5. Close Browser EARLY if link found
        if (capturedLink) {
             console.log('[Vercel Fn] Link captured, closing browser...');
             await browser.close();
             browser = null; // Mark as closed
             console.log('[Vercel Fn] Browser closed.');
             return res.status(200).json({ downloadLink: capturedLink });
        } else {
             // If link wasn't captured after wait
             console.error('[Vercel Fn] Link not captured after navigation and wait.');
             // Throw an error to be caught by the outer catch block
             throw processingError || new Error('Download link response not detected on ilide.info.');
        }

    } catch (error) {
        // Catch errors from URL parsing, Puppeteer launch, navigation, or thrown errors
        console.error("[Vercel Fn] Error during processing:", error);
        processingError = error; // Store error
        // Ensure browser is closed in case of error before finally block
        if (browser !== null) {
            console.log('[Vercel Fn] Closing browser due to error...');
            try { await browser.close(); } catch (closeErr) { console.error("[Vercel Fn] Error closing browser after error:", closeErr); }
            browser = null;
        }
        // Determine status code based on error type
        const statusCode = error.message.includes("Scribd URL format") ? 400
                         : error.message.includes("Navigation timeout") ? 504 // Gateway Timeout
                         : 500; // Internal Server Error for others
        return res.status(statusCode).json({ error: error.message || 'An internal server error occurred.' });
    } finally {
        // Final check to ensure browser is closed if somehow still open
        if (browser !== null) {
            console.warn('[Vercel Fn] Closing browser in finally block (should have been closed earlier).');
            try { await browser.close(); } catch (closeErr) { console.error("[Vercel Fn] Error closing browser in finally block:", closeErr); }
        }
    }
};