// File: api/getScribdLink.js (Vercel - Corrected Puppeteer Version)

const fetch = require('node-fetch'); // Keep for potential future use or different strategies
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// --- Helper Functions (Unchanged - Keep subdomain fix and robust regex) ---
function extractScribdInfo(url) {
    if (!url || typeof url !== 'string') { throw new Error('Invalid URL provided for extraction.'); }
    // Using a slightly more robust regex from previous attempt
    const regex = /(?:[a-z]{2,3}\.)?scribd\.com\/(?:document|doc|presentation|book|audiobook|embeds)\/(\d+)(?:\/([^?\/]+))?/;
    const match = url.match(regex);
    if (match && match[1]) {
        const docId = match[1];
        const titleSlug = match[2] ? match[2].replace(/\/$/, '') : `document-${docId}`;
        const title = titleSlug.replace(/-/g, ' ');
        console.log(`[Vercel Fn] Extracted: ID=${docId}, Slug=${titleSlug}`);
        return { docId, title, titleSlug };
    } else {
        console.error(`[Vercel Fn] Failed to match Scribd URL format: ${url}`);
        throw new Error('Invalid or unrecognized Scribd URL format.');
    }
}

function generateIlideLink(docId, titleSlug) {
    // Keep original generation logic
    const fileUrl = encodeURIComponent(`https://scribd.vdownloaders.com/pdownload/${docId}%2F${titleSlug}`);
    const titleWithSpaces = titleSlug.replace(/-/g, ' ');
    // Use the original complex title encoding if it worked before, otherwise test simpler one
    const encodedTitle = encodeURIComponent(`<div><p>${titleWithSpaces}</p></div>`);
    // const encodedTitle = encodeURIComponent(titleWithSpaces); // Alternative simpler title
    return `https://ilide.info/docgeneratev2?fileurl=${fileUrl}&title=${encodedTitle}&utm_source=scrfree&utm_medium=queue&utm_campaign=dl`;
}


// --- Vercel Serverless Function Handler ---
module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    }

    // **** IMPORTANT: Scripts MUST be allowed for ilide.info to trigger the download link request ****
    const blockScripts = false; // DO NOT CHANGE TO TRUE

    const { scribdUrl } = req.body;
    if (!scribdUrl || typeof scribdUrl !== 'string') {
        console.error("[Vercel Fn] Invalid request body:", req.body);
        return res.status(400).json({ error: 'Missing or invalid scribdUrl in request body.' });
    }

    console.log(`[Vercel Fn] Request for: ${scribdUrl}. Script Blocking: ${blockScripts}`); // Log will show false

    let browser = null;
    let page = null;
    let capturedLink = null; // Variable to store the found link
    let processingError = null; // Variable to store any critical page errors

    try {
        const { docId, title, titleSlug } = extractScribdInfo(scribdUrl);
        const ilideLink = generateIlideLink(docId, titleSlug);
        console.log(`[Vercel Fn] Target ilide.info link: ${ilideLink}`);

        // --- Launch Puppeteer (Necessary for JS execution) ---
        console.log('[Vercel Fn] Launching browser via @sparticuz/chromium...');
        browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                '--disable-features=IsolateOrigins', // Potential flags to try if issues persist
                '--disable-site-isolation-trials',
                '--disable-web-security' // Use with caution, only if absolutely necessary for cross-origin interactions
             ],
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless, // Keep headless true for serverless
            ignoreHTTPSErrors: true,
        });
        console.log('[Vercel Fn] Browser launched.');

        page = await browser.newPage();
        console.log('[Vercel Fn] New page created.');

        // --- Setup Listeners and Interception BEFORE navigation ---

        // Page Error Listeners
        page.on('error', error => { console.error('Pptr: Page crashed:', error); processingError = processingError || error; });
        page.on('pageerror', error => { console.error('Pptr: Uncaught exception on page:', error); processingError = processingError || error; });

        // *** CORRECTED Response Listener ***
        // Look for the specific download link pattern identified by the user
        page.on('response', async (response) => {
            const url = response.url();
            // Check if it's the direct download link from ilide.info
            if (url.startsWith('https://ilide.info/docdownloadv2-') && url.includes('?data_code=')) {
                if (!capturedLink) { // Capture only the first match
                    capturedLink = url; // No decoding needed for this URL format
                    console.log('Pptr: Captured TARGET download link:', capturedLink);
                    // Potential optimization: Once link is found, we could try to abort further processing/navigation?
                    // However, the Promise.race below handles exiting gracefully.
                }
            }
            // Optional: Log other potentially interesting responses for debugging
            // else if (url.includes('ilide.info')) {
            //    console.log('Pptr: Saw other ilide response:', url.substring(0, 100));
            // }
        });

        // Request Interception (Block visuals/media, ALLOW scripts)
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const resourceType = request.resourceType();
            const blockList = ['image', 'stylesheet', 'font', 'media', 'other']; // Aggressively block non-essentials

            if (resourceType === 'script') {
                request.continue(); // *** MUST ALLOW SCRIPTS ***
            } else if (blockList.includes(resourceType)) {
                // console.log('Pptr: Blocking Resource:', resourceType, request.url().substring(0, 80));
                request.abort();
            } else {
                 // Allow 'document', 'xhr', 'fetch', etc.
                request.continue();
            }
        });
        // --- End Setup ---

        // Navigation with Race Condition for Early Exit
        console.log('Pptr: Navigating to ilide.info (using domcontentloaded, relying on listener)...');
        const navigationTimeout = 55000; // Keep a generous timeout
        try {
            await Promise.race([
                page.goto(ilideLink, { waitUntil: 'domcontentloaded', timeout: navigationTimeout }),
                // Check frequently if the link has been captured by the listener or if an error occurred
                new Promise((resolve, reject) => {
                    const checkInterval = setInterval(() => {
                        if (capturedLink) {
                            console.log('Pptr: Link captured during navigation wait.');
                            clearInterval(checkInterval);
                            resolve(); // Link found, resolve the race
                        }
                        if (processingError) {
                            console.log('Pptr: Page error detected during navigation wait.');
                            clearInterval(checkInterval);
                            reject(processingError); // Page error, reject the race
                        }
                        // Optional: Add logic to reject if page load state indicates failure somehow?
                    }, 200); // Check every 200ms

                    // Safety timeout for the checker itself (slightly longer than navigation timeout)
                    setTimeout(() => {
                        if (!capturedLink && !processingError) {
                             clearInterval(checkInterval);
                             // Don't reject here, let the page.goto timeout handle it for clearer error message
                             console.log("Pptr: Checker timeout reached without link/error.");
                        }
                    }, navigationTimeout + 1000);
                })
            ]);
            console.log('Pptr: Navigation/Wait process completed.');
        } catch (err) {
            // Handle navigation-specific errors (like timeouts)
            if (err.message.toLowerCase().includes('timeout')) {
                console.warn(`Pptr: Navigation explicitly timed out after ${navigationTimeout}ms.`);
                // If timeout occurs BUT we captured the link just before, prioritize the link
                if (capturedLink) {
                     console.log("Pptr: Link was captured just before/during timeout - proceeding.");
                } else {
                     throw processingError || new Error(`Navigation timed out waiting for ilide.info response (${navigationTimeout}ms).`); // Re-throw timeout error
                }
            } else if (processingError) {
                 console.error("Pptr: Failing due to page error caught during navigation:", processingError.message);
                 throw processingError; // Throw the specific page error
            }
             else {
                throw err; // Re-throw other navigation errors
            }
        }

        // --- Check Results ---
        if (capturedLink) {
            console.log('[Vercel Fn] Link captured successfully. Preparing response.');
            res.status(200).json({ downloadLink: capturedLink });
            // Asynchronous close
            browser.close().then(() => console.log('[Vercel Fn] Browser closed asynchronously.')).catch(e => console.error('[Vercel Fn] Async browser close error:', e));
            browser = null; // Prevent closing in finally block
            return;
        } else {
            // This case should ideally be caught by timeout or processingError
            console.error('[Vercel Fn] Link not captured after navigation finished. This might indicate a logic issue or ilide change.');
            throw processingError || new Error('Download link response not detected from ilide.info after waiting.');
        }

    } catch (error) {
        // --- Handle Errors ---
        console.error("[Vercel Fn] Error during processing:", error);
        const errorMessage = error.message || 'An unknown error occurred.';
        let statusCode = 500; // Default internal server error

        if (errorMessage.includes("Scribd URL format")) {
            statusCode = 400; // Bad Request
        } else if (errorMessage.toLowerCase().includes("timeout")) {
            statusCode = 504; // Gateway Timeout
        } else if (errorMessage.includes("ilide.info")) {
             statusCode = 502; // Bad Gateway (upstream service issue)
        } else if (error.name && error.name.includes('Puppeteer')) {
             statusCode = 503; // Service Unavailable (Puppeteer issue)
        }

        // Sanitize error message for the client
        let clientErrorMessage = 'An internal server error occurred while processing the request.';
        if (statusCode === 400) clientErrorMessage = errorMessage;
        if (statusCode === 504) clientErrorMessage = 'The request timed out while waiting for the download link.';
        if (statusCode === 502) clientErrorMessage = 'Failed to retrieve the download link from the processing service.';
        if (statusCode === 503) clientErrorMessage = 'There was an issue with the page processing service.';


        return res.status(statusCode).json({ error: clientErrorMessage });

    } finally {
        // --- Ensure browser is closed ---
        if (browser !== null) {
            console.log('[Vercel Fn] Closing browser in finally block (likely due to error or unexpected exit)...');
            try {
                await browser.close();
            } catch (closeErr) {
                console.error("[Vercel Fn] Error closing browser in finally block:", closeErr);
            }
        }
    }
};
